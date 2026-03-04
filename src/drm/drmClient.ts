import type { DrmConfig, LicenseKey, LicenseResponse, WatermarkToken } from "./types";
import { computeDeviceFingerprint } from "./deviceFingerprint";
import { generateEphemeralKeyPair, unwrapCEKs } from "./keyUnwrap";

/** Convert a UUID-formatted KID to lowercase hex (strip dashes). */
function normalizeKid(kid: string): string {
  return kid.replaceAll("-", "").toLowerCase();
}

/** Decode a base64 key value to hex string. */
function base64ToHex(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert a single server key entry to { kidHex, keyHex }. Exported for testing. */
export function convertKey(lk: LicenseKey): { kidHex: string; keyHex: string } {
  return { kidHex: normalizeKid(lk.kid), keyHex: base64ToHex(lk.key) };
}

export interface FetchLicenseResult {
  clearKeys: Record<string, string>;
  clearKeyHex: string;
  license: LicenseResponse;
  watermark?: WatermarkToken;
}

/** Convert raw key bytes to hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Fetch a license from the DRM server. Returns ClearKey config for Shaka and the first key hex for software decrypt. */
export async function fetchLicense(config: DrmConfig): Promise<FetchLicenseResult> {
  const fingerprint = await computeDeviceFingerprint();

  // Phase 3: generate ephemeral ECDH key pair for key transport protection
  const keyPair = await generateEphemeralKeyPair();
  const clientPublicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  const res = await fetch(config.licenseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.sessionToken}`,
    },
    body: JSON.stringify({
      session_token: config.sessionToken,
      asset_id: config.assetId,
      device_fingerprint: fingerprint,
      client_public_key: clientPublicJwk,
    }),
  });

  if (!res.ok) {
    throw new Error(`License server returned HTTP ${res.status}`);
  }

  const license: LicenseResponse = await res.json();

  if (!license.keys || license.keys.length === 0) {
    throw new Error("License server returned no keys");
  }

  const clearKeys: Record<string, string> = {};

  if (license.transport_key_params?.epk) {
    // Phase 3 server: CEKs are wrapped with ECDH-ES+A256KW
    const wrappedB64 = license.keys.map((lk) => lk.key);
    const rawCEKs = await unwrapCEKs(
      keyPair.privateKey,
      license.transport_key_params.epk,
      wrappedB64,
    );
    for (let i = 0; i < license.keys.length; i++) {
      const kidHex = normalizeKid(license.keys[i].kid);
      clearKeys[kidHex] = bytesToHex(rawCEKs[i]);
    }
  } else {
    // Phase 1/2 fallback: plaintext base64 keys
    for (const lk of license.keys) {
      const { kidHex, keyHex } = convertKey(lk);
      clearKeys[kidHex] = keyHex;
    }
  }

  // First key hex for software decrypt fallback
  const firstKidHex = normalizeKid(license.keys[0].kid);
  const clearKeyHex = clearKeys[firstKidHex];

  return { clearKeys, clearKeyHex, license, watermark: license.watermark };
}
