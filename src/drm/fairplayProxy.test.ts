import { describe, it, expect, vi } from "vitest";
import {
  hasFairPlayKey,
  deriveFairPlayUrl,
  deriveFairPlayCertUrl,
  configureFairPlayProxy,
} from "./fairplayProxy";
import { uint8ToBase64 } from "./widevineProxy";
import type { ManifestDrmInfo, HlsKeyInfo } from "./diagnostics/types";

describe("hasFairPlayKey", () => {
  it("returns true when FairPlay key format is present", () => {
    const info: ManifestDrmInfo = {
      type: "hls",
      contentProtections: [],
      hlsKeys: [
        {
          method: "SAMPLE-AES",
          uri: "skd://content-id-123",
          keyformat: "com.apple.streamingkeydelivery",
          keyformatVersions: "1",
        } as HlsKeyInfo,
      ],
    };
    expect(hasFairPlayKey(info)).toBe(true);
  });

  it("returns true with mixed-case keyformat", () => {
    const info: ManifestDrmInfo = {
      type: "hls",
      contentProtections: [],
      hlsKeys: [
        {
          method: "SAMPLE-AES",
          uri: "skd://content-id-123",
          keyformat: "COM.APPLE.STREAMINGKEYDELIVERY",
        } as HlsKeyInfo,
      ],
    };
    expect(hasFairPlayKey(info)).toBe(true);
  });

  it("returns false when no FairPlay key entry", () => {
    const info: ManifestDrmInfo = {
      type: "hls",
      contentProtections: [],
      hlsKeys: [
        {
          method: "AES-128",
          uri: "https://example.com/key",
        } as HlsKeyInfo,
      ],
    };
    expect(hasFairPlayKey(info)).toBe(false);
  });

  it("returns false with empty hlsKeys", () => {
    const info: ManifestDrmInfo = {
      type: "hls",
      contentProtections: [],
      hlsKeys: [],
    };
    expect(hasFairPlayKey(info)).toBe(false);
  });
});

describe("deriveFairPlayUrl", () => {
  it("appends /fairplay to license URL", () => {
    expect(deriveFairPlayUrl("https://drm.example.com/license")).toBe(
      "https://drm.example.com/license/fairplay",
    );
  });

  it("strips trailing slash before appending", () => {
    expect(deriveFairPlayUrl("https://drm.example.com/license/")).toBe(
      "https://drm.example.com/license/fairplay",
    );
  });

  it("strips multiple trailing slashes", () => {
    expect(deriveFairPlayUrl("https://drm.example.com/license///")).toBe(
      "https://drm.example.com/license/fairplay",
    );
  });
});

describe("deriveFairPlayCertUrl", () => {
  it("appends /fairplay/cert to license URL", () => {
    expect(deriveFairPlayCertUrl("https://drm.example.com/license")).toBe(
      "https://drm.example.com/license/fairplay/cert",
    );
  });

  it("strips trailing slash before appending", () => {
    expect(deriveFairPlayCertUrl("https://drm.example.com/license/")).toBe(
      "https://drm.example.com/license/fairplay/cert",
    );
  });
});

describe("configureFairPlayProxy", () => {
  function createMockPlayer() {
    const requestFilters: Array<(type: number, request: Record<string, unknown>) => void> = [];
    const responseFilters: Array<(type: number, response: Record<string, unknown>) => void> = [];

    const net = {
      registerRequestFilter: vi.fn((fn) => requestFilters.push(fn)),
      registerResponseFilter: vi.fn((fn) => responseFilters.push(fn)),
    };

    const player = {
      configure: vi.fn(),
      getNetworkingEngine: vi.fn(() => net),
    } as unknown as shaka.Player;

    return { player, net, requestFilters, responseFilters };
  }

  // Shaka LICENSE request type = 2
  const LICENSE_TYPE = 2;
  const MANIFEST_TYPE = 0;

  it("configures FairPlay license server URL and cert URI", () => {
    const { player } = createMockPlayer();
    configureFairPlayProxy({
      player,
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-1",
      assetId: "asset-1",
      deviceFingerprint: "fp-1",
    });

    expect(player.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        drm: expect.objectContaining({
          servers: {
            "com.apple.fps": "https://drm.example.com/license/fairplay",
          },
          advanced: {
            "com.apple.fps": {
              serverCertificateUri: "https://drm.example.com/license/fairplay/cert",
            },
          },
        }),
      }),
    );
  });

  it("request filter wraps SPC in JSON envelope", () => {
    const { player, requestFilters } = createMockPlayer();
    configureFairPlayProxy({
      player,
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-1",
      assetId: "asset-1",
      deviceFingerprint: "fp-1",
    });

    const spc = new Uint8Array([0x08, 0x04, 0x10, 0x01]);
    const request: Record<string, unknown> = {
      body: spc.buffer,
      headers: {} as Record<string, string>,
    };

    requestFilters[0](LICENSE_TYPE, request);

    const body = JSON.parse(new TextDecoder().decode(request.body as ArrayBuffer));
    expect(body.session_token).toBe("tok-1");
    expect(body.asset_id).toBe("asset-1");
    expect(body.device_fingerprint).toBe("fp-1");
    expect(body.spc).toBe(uint8ToBase64(spc));
    expect((request.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((request.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-1");
  });

  it("request filter ignores non-LICENSE requests", () => {
    const { player, requestFilters } = createMockPlayer();
    configureFairPlayProxy({
      player,
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-1",
      assetId: "asset-1",
      deviceFingerprint: "fp-1",
    });

    const original = new Uint8Array([0x01, 0x02]).buffer;
    const request: Record<string, unknown> = {
      body: original,
      headers: {} as Record<string, string>,
    };

    requestFilters[0](MANIFEST_TYPE, request);
    expect(request.body).toBe(original); // unchanged
  });

  it("response filter extracts session_id, watermark, and passes raw CKC bytes", () => {
    const onSessionInfo = vi.fn();
    const onWatermark = vi.fn();
    const { player, responseFilters } = createMockPlayer();

    configureFairPlayProxy({
      player,
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-1",
      assetId: "asset-1",
      deviceFingerprint: "fp-1",
      onSessionInfo,
      onWatermark,
    });

    const ckcBytes = new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]);
    const serverResponse = {
      session_id: "sess-abc",
      ckc: uint8ToBase64(ckcBytes),
      policy: {
        expiry: "2099-01-01T00:00:00Z",
        renewal_interval_s: 45,
        max_resolution: 1080,
        allow_offline: false,
      },
      watermark: {
        user_hash: "abcd1234",
        session_short: "X9K2",
        opacity: 0.03,
      },
    };

    const response: Record<string, unknown> = {
      data: new TextEncoder().encode(JSON.stringify(serverResponse)).buffer,
    };

    responseFilters[0](LICENSE_TYPE, response);

    expect(onSessionInfo).toHaveBeenCalledWith("sess-abc", 45);
    expect(onWatermark).toHaveBeenCalledWith(serverResponse.watermark);

    // response.data should now contain raw CKC bytes
    const resultBytes = new Uint8Array(response.data as ArrayBuffer);
    expect(resultBytes).toEqual(ckcBytes);
  });

  it("response filter ignores non-LICENSE responses", () => {
    const onSessionInfo = vi.fn();
    const { player, responseFilters } = createMockPlayer();

    configureFairPlayProxy({
      player,
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-1",
      assetId: "asset-1",
      deviceFingerprint: "fp-1",
      onSessionInfo,
    });

    const original = new Uint8Array([0x01]).buffer;
    const response: Record<string, unknown> = { data: original };

    responseFilters[0](MANIFEST_TYPE, response);
    expect(response.data).toBe(original); // unchanged
    expect(onSessionInfo).not.toHaveBeenCalled();
  });

  it("response filter passes through non-JSON response", () => {
    const { player, responseFilters } = createMockPlayer();

    configureFairPlayProxy({
      player,
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-1",
      assetId: "asset-1",
      deviceFingerprint: "fp-1",
    });

    const rawBytes = new Uint8Array([0x08, 0x04, 0x10, 0x01]);
    const response: Record<string, unknown> = {
      data: rawBytes.buffer,
    };

    // Should not throw on non-JSON data
    responseFilters[0](LICENSE_TYPE, response);
    expect(new Uint8Array(response.data as ArrayBuffer)).toEqual(rawBytes);
  });
});
