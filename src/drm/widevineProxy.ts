import shaka from "shaka-player";
import type { ManifestDrmInfo } from "./diagnostics/types";
import type { LicensePolicy, WatermarkToken } from "./types";
import type { EmeEventCallback } from "./diagnostics/emeCapture";

/** Widevine system ID as it appears in ContentProtection schemeIdUri. */
const WIDEVINE_UUID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
const WIDEVINE_URN = `urn:uuid:${WIDEVINE_UUID}`;

/** Shaka RequestType.LICENSE numeric value (avoids runtime dependency on shaka global in tests). */
const REQUEST_TYPE_LICENSE = 2;

/** Check whether the manifest contains a Widevine ContentProtection entry. */
export function hasWidevinePssh(info: ManifestDrmInfo): boolean {
  return info.contentProtections.some(
    (cp) => cp.schemeIdUri.toLowerCase() === WIDEVINE_URN,
  );
}

/** Derive the Widevine proxy URL from the base license URL (e.g. /license → /license/widevine). */
export function deriveWidevineUrl(licenseUrl: string): string {
  // Strip trailing slash, append /widevine
  return licenseUrl.replace(/\/+$/, "") + "/widevine";
}

/** Convert Uint8Array to base64 string (chunked to avoid stack overflow on large buffers). */
export function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

/** Convert base64 string to Uint8Array. */
export function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/** Response shape from POST /license/widevine. */
export interface WidevineLicenseResponse {
  session_id: string;
  license: string; // base64-encoded Widevine license bytes
  policy: LicensePolicy;
  evicted_sessions?: string[];
  watermark?: WatermarkToken;
}

export interface ConfigureWidevineProxyOpts {
  player: shaka.Player;
  licenseUrl: string;
  sessionToken: string;
  assetId: string;
  deviceFingerprint: string;
  onSessionInfo?: (sessionId: string, renewalS: number) => void;
  onWatermark?: (watermark: WatermarkToken) => void;
  onEmeEvent?: EmeEventCallback;
}

/**
 * Configure Shaka Player for Widevine DRM via our proxy server.
 *
 * 1. Sets the Widevine license server URL
 * 2. Registers a request filter that wraps the binary CDM challenge in a JSON envelope
 * 3. Registers a response filter that parses the JSON response, extracts metadata,
 *    and replaces response.data with raw license bytes for the CDM
 */
export function configureWidevineProxy(opts: ConfigureWidevineProxyOpts): void {
  const { player, licenseUrl, sessionToken, assetId, deviceFingerprint, onSessionInfo, onWatermark, onEmeEvent } = opts;

  const widevineUrl = deriveWidevineUrl(licenseUrl);

  player.configure({
    drm: {
      servers: {
        "com.widevine.alpha": widevineUrl,
      },
    },
  });

  onEmeEvent?.("keys-set", "Widevine DRM configured", { data: { keySystem: "com.widevine.alpha" } });

  const net = player.getNetworkingEngine();
  if (!net) return;

  // Request filter: wrap binary CDM challenge in JSON envelope
  net.registerRequestFilter((
    type: shaka.net.NetworkingEngine.RequestType,
    request: shaka.extern.Request,
  ) => {
    if (type !== REQUEST_TYPE_LICENSE) return;

    const challenge = new Uint8Array(request.body as ArrayBuffer);
    const envelope = {
      session_token: sessionToken,
      asset_id: assetId,
      challenge: uint8ToBase64(challenge),
      device_fingerprint: deviceFingerprint,
    };

    request.body = new TextEncoder().encode(JSON.stringify(envelope)).buffer as ArrayBuffer;
    request.headers["Content-Type"] = "application/json";
    request.headers["Authorization"] = `Bearer ${sessionToken}`;

    onEmeEvent?.("message", "License challenge", { data: { bytes: challenge.byteLength } });
  });

  // Response filter: parse JSON, extract session/watermark, pass raw license bytes to CDM
  net.registerResponseFilter((
    type: shaka.net.NetworkingEngine.RequestType,
    response: shaka.extern.Response,
  ) => {
    if (type !== REQUEST_TYPE_LICENSE) return;

    const text = new TextDecoder().decode(response.data as ArrayBuffer);
    let parsed: WidevineLicenseResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON — assume raw license bytes (passthrough)
      onEmeEvent?.("error", "Failed to parse license response", { success: false });
      return;
    }

    if (parsed.session_id && parsed.policy) {
      onSessionInfo?.(parsed.session_id, parsed.policy.renewal_interval_s);
    }

    if (parsed.watermark) {
      onWatermark?.(parsed.watermark);
    }

    onEmeEvent?.("update", "License response received", { success: true, data: { sessionId: parsed.session_id } });

    // Replace response data with raw license bytes for the CDM
    const licenseBytes = base64ToUint8Array(parsed.license);
    response.data = licenseBytes.buffer as ArrayBuffer;
  });
}
