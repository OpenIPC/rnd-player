import { describe, it, expect, vi, beforeEach } from "vitest";
import { convertKey, fetchLicense } from "./drmClient";
import type { LicenseResponse } from "./types";

// Mock deviceFingerprint
vi.mock("./deviceFingerprint", () => ({
  computeDeviceFingerprint: vi.fn().mockResolvedValue("mock-fingerprint"),
}));

describe("convertKey", () => {
  it("normalizes UUID KID and decodes base64 key", () => {
    const { kidHex, keyHex } = convertKey({
      kid: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      key: btoa(
        String.fromCharCode(
          0x01,
          0x02,
          0x03,
          0x04,
          0x05,
          0x06,
          0x07,
          0x08,
          0x09,
          0x0a,
          0x0b,
          0x0c,
          0x0d,
          0x0e,
          0x0f,
          0x10,
        ),
      ),
      type: "hd",
    });
    expect(kidHex).toBe("a1b2c3d4e5f67890abcdef1234567890");
    expect(keyHex).toBe("0102030405060708090a0b0c0d0e0f10");
  });
});

/** Simulate server-side wrapping (same as keyUnwrap.test.ts helper). */
async function serverWrapCEKs(
  clientPublicJwk: JsonWebKey,
  ceks: Uint8Array[],
): Promise<{ wrappedB64: string[]; serverEpk: JsonWebKey }> {
  const HKDF_SALT = new Uint8Array(32);
  const HKDF_INFO = new TextEncoder().encode("drm-key-wrap");

  const serverKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const clientPub = await crypto.subtle.importKey(
    "jwk",
    clientPublicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientPub },
    serverKeyPair.privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
    hkdfKey,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey"],
  );

  const wrappedB64: string[] = [];
  for (const cek of ceks) {
    const cekKey = await crypto.subtle.importKey(
      "raw",
      cek,
      { name: "AES-CBC", length: 128 },
      true,
      ["encrypt", "decrypt"],
    );
    const wrapped = await crypto.subtle.wrapKey("raw", cekKey, wrappingKey, "AES-KW");
    wrappedB64.push(btoa(String.fromCharCode(...new Uint8Array(wrapped))));
  }

  const serverEpk = await crypto.subtle.exportKey("jwk", serverKeyPair.publicKey);
  return { wrappedB64, serverEpk };
}

describe("fetchLicense", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("handles Phase 1/2 plaintext response (no transport_key_params)", async () => {
    const plainResponse: LicenseResponse = {
      session_id: "sess-123",
      keys: [
        {
          kid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          key: btoa(String.fromCharCode(0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c)),
          type: "sd",
        },
      ],
      policy: {
        expiry: "2099-01-01T00:00:00Z",
        renewal_interval_s: 30,
        max_resolution: 1080,
        allow_offline: false,
      },
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(plainResponse), { status: 200 }),
    );

    const result = await fetchLicense({
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-123",
      assetId: "asset-1",
    });

    expect(result.license.session_id).toBe("sess-123");
    expect(result.clearKeys["aaaaaaaabbbbccccddddeeeeeeeeeeee"]).toBe(
      "deadbeef0102030405060708090a0b0c",
    );
    expect(result.clearKeyHex).toBe("deadbeef0102030405060708090a0b0c");
  });

  it("handles Phase 3 wrapped response (with transport_key_params)", async () => {
    const originalCEK = new Uint8Array([
      0xca, 0xfe, 0xba, 0xbe, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b, 0x0c,
    ]);

    // We need to intercept the fetch to grab the client_public_key from the request body,
    // then perform server-side wrapping with it.
    let capturedClientPubKey: JsonWebKey | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      capturedClientPubKey = body.client_public_key;

      const { wrappedB64, serverEpk } = await serverWrapCEKs(
        capturedClientPubKey!,
        [originalCEK],
      );

      const response: LicenseResponse = {
        session_id: "sess-456",
        keys: [
          {
            kid: "11111111-2222-3333-4444-555555555555",
            key: wrappedB64[0],
            type: "hd",
          },
        ],
        policy: {
          expiry: "2099-01-01T00:00:00Z",
          renewal_interval_s: 30,
          max_resolution: 1080,
          allow_offline: false,
        },
        transport_key_params: {
          algorithm: "ECDH-ES+A256KW",
          epk: serverEpk,
        },
      };

      return new Response(JSON.stringify(response), { status: 200 });
    });

    const result = await fetchLicense({
      licenseUrl: "https://drm.example.com/license",
      sessionToken: "tok-456",
      assetId: "asset-2",
    });

    // Verify the request included a client_public_key
    expect(capturedClientPubKey).toBeDefined();
    expect(capturedClientPubKey!.kty).toBe("EC");
    expect(capturedClientPubKey!.crv).toBe("P-256");

    // Verify unwrapped key matches the original
    expect(result.clearKeys["11111111222233334444555555555555"]).toBe(
      "cafebabe0102030405060708090a0b0c",
    );
    expect(result.clearKeyHex).toBe("cafebabe0102030405060708090a0b0c");
  });

  it("sends client_public_key in request body", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.client_public_key).toBeDefined();
      expect(body.client_public_key.kty).toBe("EC");
      expect(body.session_token).toBe("tok");
      expect(body.asset_id).toBe("asset");
      expect(body.device_fingerprint).toBe("mock-fingerprint");

      return new Response(
        JSON.stringify({
          session_id: "s",
          keys: [{ kid: "aaaa", key: btoa("\x00".repeat(16)), type: "sd" }],
          policy: { expiry: "x", renewal_interval_s: 30, max_resolution: 0, allow_offline: false },
        }),
        { status: 200 },
      );
    });

    await fetchLicense({
      licenseUrl: "https://example.com/license",
      sessionToken: "tok",
      assetId: "asset",
    });
  });

  it("throws on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Forbidden", { status: 403 }),
    );

    await expect(
      fetchLicense({
        licenseUrl: "https://example.com/license",
        sessionToken: "tok",
        assetId: "asset",
      }),
    ).rejects.toThrow("License server returned HTTP 403");
  });

  it("throws on empty keys array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          session_id: "s",
          keys: [],
          policy: { expiry: "x", renewal_interval_s: 30, max_resolution: 0, allow_offline: false },
        }),
        { status: 200 },
      ),
    );

    await expect(
      fetchLicense({
        licenseUrl: "https://example.com/license",
        sessionToken: "tok",
        assetId: "asset",
      }),
    ).rejects.toThrow("License server returned no keys");
  });
});
