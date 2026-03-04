/**
 * ECDH ephemeral key agreement + AES-256 Key Wrap (RFC 3394) for DRM key transport.
 * Matches server implementation in free-drm/internal/crypto/ecdh.go.
 */

const HKDF_SALT = new Uint8Array(32); // nil salt = 32 zero bytes per RFC 5869
const HKDF_INFO = new TextEncoder().encode("drm-key-wrap");

/** Generate an ephemeral P-256 key pair for one license request. */
export async function generateEphemeralKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true, // extractable — need to export public key to JWK
    ["deriveBits"],
  );
}

/** Unwrap CEKs received from a Phase 3 license server using ECDH-ES+A256KW. */
export async function unwrapCEKs(
  clientPrivateKey: CryptoKey,
  serverEpk: JsonWebKey,
  wrappedKeysB64: string[],
): Promise<Uint8Array[]> {
  // 1. Import server's ephemeral public key
  const serverPub = await crypto.subtle.importKey(
    "jwk",
    serverEpk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // 2. ECDH shared secret (32 bytes for P-256)
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverPub },
    clientPrivateKey,
    256,
  );

  // 3. HKDF-SHA256 → AES-256 wrapping key
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
    hkdfKey,
    { name: "AES-KW", length: 256 },
    false,
    ["unwrapKey"],
  );

  // 4. Unwrap each CEK
  const results: Uint8Array[] = [];
  for (const b64 of wrappedKeysB64) {
    const wrapped = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    // unwrapKey requires a target algorithm — use AES-CBC as a formality,
    // we immediately export to raw bytes
    const unwrapped = await crypto.subtle.unwrapKey(
      "raw",
      wrapped,
      wrappingKey,
      "AES-KW",
      { name: "AES-CBC", length: 128 },
      true, // extractable
      ["encrypt", "decrypt"],
    );
    const raw = await crypto.subtle.exportKey("raw", unwrapped);
    results.push(new Uint8Array(raw));
  }

  return results;
}
