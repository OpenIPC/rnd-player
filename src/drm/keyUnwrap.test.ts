import { describe, it, expect } from "vitest";
import { generateEphemeralKeyPair, unwrapCEKs } from "./keyUnwrap";

const HKDF_SALT = new Uint8Array(32);
const HKDF_INFO = new TextEncoder().encode("drm-key-wrap");

/** Simulate server-side: wrap CEKs using ECDH-ES+A256KW (mirrors free-drm WrapCEKs). */
async function serverWrapCEKs(
  clientPublicJwk: JsonWebKey,
  ceks: Uint8Array[],
): Promise<{ wrappedB64: string[]; serverEpk: JsonWebKey }> {
  // Server generates its own ephemeral key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );

  // Import client's public key
  const clientPub = await crypto.subtle.importKey(
    "jwk",
    clientPublicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // ECDH shared secret
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientPub },
    serverKeyPair.privateKey,
    256,
  );

  // HKDF → AES-256 wrapping key
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

  // Wrap each CEK
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
    const b64 = btoa(String.fromCharCode(...new Uint8Array(wrapped)));
    wrappedB64.push(b64);
  }

  const serverEpk = await crypto.subtle.exportKey("jwk", serverKeyPair.publicKey);
  return { wrappedB64, serverEpk };
}

describe("keyUnwrap", () => {
  describe("generateEphemeralKeyPair", () => {
    it("generates a P-256 key pair with extractable public key", async () => {
      const keyPair = await generateEphemeralKeyPair();

      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKey.algorithm).toMatchObject({
        name: "ECDH",
        namedCurve: "P-256",
      });

      // Public key should be exportable to JWK
      const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      expect(jwk.kty).toBe("EC");
      expect(jwk.crv).toBe("P-256");
      expect(jwk.x).toBeDefined();
      expect(jwk.y).toBeDefined();
    });

    it("generates unique key pairs each time", async () => {
      const kp1 = await generateEphemeralKeyPair();
      const kp2 = await generateEphemeralKeyPair();

      const jwk1 = await crypto.subtle.exportKey("jwk", kp1.publicKey);
      const jwk2 = await crypto.subtle.exportKey("jwk", kp2.publicKey);

      expect(jwk1.x).not.toBe(jwk2.x);
    });
  });

  describe("unwrapCEKs", () => {
    it("round-trips a single 16-byte CEK", async () => {
      const clientKeyPair = await generateEphemeralKeyPair();
      const clientPubJwk = await crypto.subtle.exportKey(
        "jwk",
        clientKeyPair.publicKey,
      );

      const originalCEK = new Uint8Array([
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
        0x0c, 0x0d, 0x0e, 0x0f, 0x10,
      ]);

      const { wrappedB64, serverEpk } = await serverWrapCEKs(clientPubJwk, [
        originalCEK,
      ]);

      const unwrapped = await unwrapCEKs(
        clientKeyPair.privateKey,
        serverEpk,
        wrappedB64,
      );

      expect(unwrapped).toHaveLength(1);
      expect(unwrapped[0]).toEqual(originalCEK);
    });

    it("round-trips multiple CEKs (multi-key DRM)", async () => {
      const clientKeyPair = await generateEphemeralKeyPair();
      const clientPubJwk = await crypto.subtle.exportKey(
        "jwk",
        clientKeyPair.publicKey,
      );

      const cekAudio = crypto.getRandomValues(new Uint8Array(16));
      const cekSD = crypto.getRandomValues(new Uint8Array(16));
      const cekHD = crypto.getRandomValues(new Uint8Array(16));
      const cekUHD = crypto.getRandomValues(new Uint8Array(16));

      const { wrappedB64, serverEpk } = await serverWrapCEKs(clientPubJwk, [
        cekAudio,
        cekSD,
        cekHD,
        cekUHD,
      ]);

      const unwrapped = await unwrapCEKs(
        clientKeyPair.privateKey,
        serverEpk,
        wrappedB64,
      );

      expect(unwrapped).toHaveLength(4);
      expect(unwrapped[0]).toEqual(cekAudio);
      expect(unwrapped[1]).toEqual(cekSD);
      expect(unwrapped[2]).toEqual(cekHD);
      expect(unwrapped[3]).toEqual(cekUHD);
    });

    it("wrapped key is 24 bytes (16-byte CEK + 8-byte AES-KW overhead)", async () => {
      const clientKeyPair = await generateEphemeralKeyPair();
      const clientPubJwk = await crypto.subtle.exportKey(
        "jwk",
        clientKeyPair.publicKey,
      );

      const cek = crypto.getRandomValues(new Uint8Array(16));
      const { wrappedB64 } = await serverWrapCEKs(clientPubJwk, [cek]);

      const wrappedBytes = Uint8Array.from(atob(wrappedB64[0]), (c) =>
        c.charCodeAt(0),
      );
      expect(wrappedBytes.length).toBe(24);
    });

    it("fails with wrong client private key", async () => {
      const clientKeyPair = await generateEphemeralKeyPair();
      const wrongKeyPair = await generateEphemeralKeyPair();
      const clientPubJwk = await crypto.subtle.exportKey(
        "jwk",
        clientKeyPair.publicKey,
      );

      const cek = crypto.getRandomValues(new Uint8Array(16));
      const { wrappedB64, serverEpk } = await serverWrapCEKs(clientPubJwk, [
        cek,
      ]);

      // Using the wrong private key should fail AES-KW integrity check
      await expect(
        unwrapCEKs(wrongKeyPair.privateKey, serverEpk, wrappedB64),
      ).rejects.toThrow();
    });

    it("fails with corrupted wrapped key data", async () => {
      const clientKeyPair = await generateEphemeralKeyPair();
      const clientPubJwk = await crypto.subtle.exportKey(
        "jwk",
        clientKeyPair.publicKey,
      );

      const cek = crypto.getRandomValues(new Uint8Array(16));
      const { serverEpk } = await serverWrapCEKs(clientPubJwk, [cek]);

      // Corrupted base64 data (wrong length for AES-KW)
      const corruptedB64 = btoa("corrupted-data-here!");

      await expect(
        unwrapCEKs(clientKeyPair.privateKey, serverEpk, [corruptedB64]),
      ).rejects.toThrow();
    });
  });
});
