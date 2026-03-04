import { describe, it, expect, vi } from "vitest";
import {
  hasWidevinePssh,
  deriveWidevineUrl,
  uint8ToBase64,
  base64ToUint8Array,
  configureWidevineProxy,
} from "./widevineProxy";
import type { ManifestDrmInfo, ContentProtectionInfo } from "./diagnostics/types";

describe("hasWidevinePssh", () => {
  it("returns true when Widevine ContentProtection is present", () => {
    const info: ManifestDrmInfo = {
      type: "dash",
      contentProtections: [
        {
          schemeIdUri: "urn:mpeg:dash:mp4protection:2011",
          systemName: "CENC (mp4protection)",
          defaultKid: "aabbccdd",
        } as ContentProtectionInfo,
        {
          schemeIdUri: "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",
          systemName: "Widevine",
        } as ContentProtectionInfo,
      ],
      hlsKeys: [],
    };
    expect(hasWidevinePssh(info)).toBe(true);
  });

  it("returns true with uppercase schemeIdUri", () => {
    const info: ManifestDrmInfo = {
      type: "dash",
      contentProtections: [
        {
          schemeIdUri: "urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED",
          systemName: "Widevine",
        } as ContentProtectionInfo,
      ],
      hlsKeys: [],
    };
    expect(hasWidevinePssh(info)).toBe(true);
  });

  it("returns false when no Widevine entry", () => {
    const info: ManifestDrmInfo = {
      type: "dash",
      contentProtections: [
        {
          schemeIdUri: "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95",
          systemName: "PlayReady",
        } as ContentProtectionInfo,
      ],
      hlsKeys: [],
    };
    expect(hasWidevinePssh(info)).toBe(false);
  });

  it("returns false with empty contentProtections", () => {
    const info: ManifestDrmInfo = {
      type: "dash",
      contentProtections: [],
      hlsKeys: [],
    };
    expect(hasWidevinePssh(info)).toBe(false);
  });
});

describe("deriveWidevineUrl", () => {
  it("appends /widevine to license URL", () => {
    expect(deriveWidevineUrl("https://drm.example.com/license")).toBe(
      "https://drm.example.com/license/widevine",
    );
  });

  it("strips trailing slash before appending", () => {
    expect(deriveWidevineUrl("https://drm.example.com/license/")).toBe(
      "https://drm.example.com/license/widevine",
    );
  });

  it("strips multiple trailing slashes", () => {
    expect(deriveWidevineUrl("https://drm.example.com/license///")).toBe(
      "https://drm.example.com/license/widevine",
    );
  });
});

describe("uint8ToBase64 / base64ToUint8Array", () => {
  it("round-trips small data", () => {
    const data = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const b64 = uint8ToBase64(data);
    const back = base64ToUint8Array(b64);
    expect(back).toEqual(data);
  });

  it("round-trips empty data", () => {
    const data = new Uint8Array(0);
    const b64 = uint8ToBase64(data);
    expect(b64).toBe("");
    const back = base64ToUint8Array(b64);
    expect(back.length).toBe(0);
  });

  it("round-trips large data (>32KB)", () => {
    const data = new Uint8Array(40000);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const b64 = uint8ToBase64(data);
    const back = base64ToUint8Array(b64);
    expect(back).toEqual(data);
  });
});

describe("configureWidevineProxy", () => {
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

  it("configures Widevine license server URL", () => {
    const { player } = createMockPlayer();
    configureWidevineProxy({
      player,
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-1",
      assetId: "asset-1",
      deviceFingerprint: "fp-1",
    });

    expect(player.configure).toHaveBeenCalledWith({
      drm: {
        servers: {
          "com.widevine.alpha": "https://drm.example.com/license/widevine",
        },
      },
    });
  });

  it("request filter wraps challenge in JSON envelope", () => {
    const { player, requestFilters } = createMockPlayer();
    configureWidevineProxy({
      player,
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-1",
      assetId: "asset-1",
      deviceFingerprint: "fp-1",
    });

    const challenge = new Uint8Array([0x08, 0x04, 0x10, 0x01]);
    const request: Record<string, unknown> = {
      body: challenge.buffer,
      headers: {} as Record<string, string>,
    };

    // Only the license request filter should run
    requestFilters[0](LICENSE_TYPE, request);

    const body = JSON.parse(new TextDecoder().decode(request.body as ArrayBuffer));
    expect(body.session_token).toBe("tok-1");
    expect(body.asset_id).toBe("asset-1");
    expect(body.device_fingerprint).toBe("fp-1");
    expect(body.challenge).toBe(uint8ToBase64(challenge));
    expect((request.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((request.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-1");
  });

  it("request filter ignores non-LICENSE requests", () => {
    const { player, requestFilters } = createMockPlayer();
    configureWidevineProxy({
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

  it("response filter extracts session_id, watermark, and passes raw license bytes", () => {
    const onSessionInfo = vi.fn();
    const onWatermark = vi.fn();
    const { player, responseFilters } = createMockPlayer();

    configureWidevineProxy({
      player,
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-1",
      assetId: "asset-1",
      deviceFingerprint: "fp-1",
      onSessionInfo,
      onWatermark,
    });

    const licenseBytes = new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]);
    const serverResponse = {
      session_id: "sess-abc",
      license: uint8ToBase64(licenseBytes),
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

    // response.data should now contain raw license bytes
    const resultBytes = new Uint8Array(response.data as ArrayBuffer);
    expect(resultBytes).toEqual(licenseBytes);
  });

  it("response filter ignores non-LICENSE responses", () => {
    const onSessionInfo = vi.fn();
    const { player, responseFilters } = createMockPlayer();

    configureWidevineProxy({
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

    configureWidevineProxy({
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
