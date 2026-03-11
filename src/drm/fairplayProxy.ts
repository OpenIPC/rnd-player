import type { ManifestDrmInfo } from "./diagnostics/types";
import type { LicensePolicy, WatermarkToken } from "./types";
import { uint8ToBase64, base64ToUint8Array } from "./widevineProxy";
import type { EmeEventCallback } from "./diagnostics/emeCapture";

/** FairPlay key format as it appears in HLS EXT-X-KEY tags. */
const FAIRPLAY_KEYFORMAT = "com.apple.streamingkeydelivery";

/** Check whether the manifest contains a FairPlay HLS key entry. */
export function hasFairPlayKey(info: ManifestDrmInfo): boolean {
  return info.hlsKeys.some(
    (k) => k.keyformat?.toLowerCase() === FAIRPLAY_KEYFORMAT,
  );
}

/** Derive the FairPlay proxy URL from the base license URL (e.g. /license → /license/fairplay). */
export function deriveFairPlayUrl(licenseUrl: string): string {
  return licenseUrl.replace(/\/+$/, "") + "/fairplay";
}

/** Derive the FairPlay certificate URL from the base license URL (e.g. /license → /license/fairplay/cert). */
export function deriveFairPlayCertUrl(licenseUrl: string): string {
  return licenseUrl.replace(/\/+$/, "") + "/fairplay/cert";
}

/** Response shape from POST /license/fairplay. */
export interface FairPlayLicenseResponse {
  session_id: string;
  ckc: string; // base64-encoded CKC
  policy: LicensePolicy;
  evicted_sessions?: string[];
  watermark?: WatermarkToken;
}

// --- Legacy WebKit EME types (Safari-specific, not in standard lib) ---
/* eslint-disable @typescript-eslint/no-explicit-any */
interface WebKitMediaKeys {
  createSession(type: string, initData: Uint8Array): any;
}
interface WebKitMediaKeysConstructor {
  new (keySystem: string): WebKitMediaKeys;
  isTypeSupported(keySystem: string, type: string): boolean;
}
declare global {
  interface Window { WebKitMediaKeys?: WebKitMediaKeysConstructor }
  interface HTMLVideoElement {
    webkitSetMediaKeys?(keys: WebKitMediaKeys): void;
    webkitKeys?: WebKitMediaKeys;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SetupFairPlayOpts {
  video: HTMLVideoElement;
  licenseUrl: string;
  sessionToken: string;
  assetId: string;
  deviceFingerprint: string;
  onSessionInfo?: (sessionId: string, renewalS: number) => void;
  onWatermark?: (watermark: WatermarkToken) => void;
  onEmeEvent?: EmeEventCallback;
}

/** Extract content-id from initData (UTF-16LE encoded skd:// URI). */
function extractContentId(initData: ArrayBuffer): string {
  const u16 = new Uint16Array(initData);
  let str = "";
  for (let i = 0; i < u16.length; i++) str += String.fromCharCode(u16[i]);
  const match = str.match(/skd:\/\/(.*)/);
  return match ? match[1] : str;
}

/** Encode string as UTF-16LE Uint16Array. */
function stringToUTF16LE(str: string): Uint16Array {
  const buf = new ArrayBuffer(str.length * 2);
  const arr = new Uint16Array(buf);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i);
  return arr;
}

/**
 * Build FairPlay session initData:
 * [rawInitData][4B LE: idByteLength][id UTF-16LE][4B LE: certByteLength][cert]
 */
function buildSessionInitData(initData: Uint8Array, contentId: string, cert: Uint8Array): Uint8Array {
  const id = stringToUTF16LE(contentId);
  const buffer = new ArrayBuffer(initData.byteLength + 4 + id.byteLength + 4 + cert.byteLength);
  const view = new DataView(buffer);
  let offset = 0;

  new Uint8Array(buffer, offset, initData.byteLength).set(initData);
  offset += initData.byteLength;

  view.setUint32(offset, id.byteLength, true);
  offset += 4;
  new Uint8Array(buffer, offset, id.byteLength).set(new Uint8Array(id.buffer));
  offset += id.byteLength;

  view.setUint32(offset, cert.byteLength, true);
  offset += 4;
  new Uint8Array(buffer, offset, cert.byteLength).set(cert);

  return new Uint8Array(buffer);
}

/**
 * Set up FairPlay DRM using Safari's legacy WebKit EME API.
 *
 * Safari's standard EME (MediaKeys) hangs on generateRequest for FairPlay.
 * The legacy WebKitMediaKeys API (com.apple.fps.1_0) is what actually works
 * for FairPlay with native HLS in Safari.
 *
 * Call BEFORE setting video.src. Returns a cleanup function.
 */
export async function setupFairPlay(opts: SetupFairPlayOpts): Promise<() => void> {
  const { video, licenseUrl, sessionToken, assetId, deviceFingerprint, onSessionInfo, onWatermark, onEmeEvent } = opts;
  const fairplayUrl = deriveFairPlayUrl(licenseUrl);
  const certUrl = deriveFairPlayCertUrl(licenseUrl);

  console.log("[FP] setupFairPlay: fairplayUrl=%s certUrl=%s", fairplayUrl, certUrl);

  // Check legacy API availability
  onEmeEvent?.("access-request", "FairPlay EME probe");
  if (!window.WebKitMediaKeys?.isTypeSupported?.("com.apple.fps.1_0", "video/mp4")) {
    onEmeEvent?.("access-denied", "FairPlay not supported", { success: false });
    throw new Error("FairPlay not supported (need Safari with WebKitMediaKeys)");
  }
  onEmeEvent?.("access-granted", "FairPlay EME supported", { success: true });

  // 1. Fetch server certificate
  console.log("[FP] Fetching certificate...");
  const certResp = await fetch(certUrl);
  if (!certResp.ok) throw new Error(`Failed to fetch FP cert: ${certResp.status}`);
  const certBytes = new Uint8Array(await certResp.arrayBuffer());
  console.log("[FP] Certificate: %d bytes", certBytes.byteLength);

  // 2. Set up legacy WebKitMediaKeys
  const keys = new window.WebKitMediaKeys("com.apple.fps.1_0");
  video.webkitSetMediaKeys!(keys);
  console.log("[FP] WebKitMediaKeys configured");
  onEmeEvent?.("keys-set", "FairPlay WebKitMediaKeys configured");

  let destroyed = false;

  // 3. Handle webkitneedkey — fires when Safari's HLS parser encounters EXT-X-KEY
  const onNeedKey = (event: Event) => {
    if (destroyed) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const initData = new Uint8Array((event as any).initData);
    console.log("[FP] webkitneedkey: %d bytes", initData.byteLength);
    onEmeEvent?.("generate-request", "webkitneedkey", { data: { initDataBytes: initData.byteLength } });

    const contentId = extractContentId(initData.buffer as ArrayBuffer);
    console.log("[FP] contentId: %s", contentId);

    const sessionInitData = buildSessionInitData(initData, contentId, certBytes);
    console.log("[FP] sessionInitData: %d bytes", sessionInitData.byteLength);

    if (!video.webkitKeys) {
      console.error("[FP] webkitKeys not set");
      return;
    }

    const session = video.webkitKeys.createSession("video/mp4", sessionInitData);
    if (!session) {
      console.error("[FP] createSession returned null");
      return;
    }
    console.log("[FP] Key session created");

    // SPC generated by CDM
    session.addEventListener("webkitkeymessage", async (msgEvent: Event) => {
      if (destroyed) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spc = new Uint8Array((msgEvent as any).message);
      console.log("[FP] SPC generated: %d bytes", spc.byteLength);
      onEmeEvent?.("message", "SPC generated", { data: { spcBytes: spc.byteLength } });

      // Send SPC to our license server (JSON envelope)
      const envelope = {
        session_token: sessionToken,
        asset_id: assetId,
        spc: uint8ToBase64(spc),
        device_fingerprint: deviceFingerprint,
      };

      try {
        const resp = await fetch(fairplayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify(envelope),
        });

        if (!resp.ok) {
          const text = await resp.text();
          console.error("[FP] License request failed: %d %s", resp.status, text);
          onEmeEvent?.("error", "License exchange failed", { success: false, data: { status: resp.status } });
          return;
        }

        const data: FairPlayLicenseResponse = await resp.json();
        console.log("[FP] License response: session_id=%s", data.session_id);

        if (data.session_id && data.policy) {
          onSessionInfo?.(data.session_id, data.policy.renewal_interval_s);
        }
        if (data.watermark) {
          onWatermark?.(data.watermark);
        }

        // Pass CKC to CDM
        const ckc = base64ToUint8Array(data.ckc);
        console.log("[FP] Updating session with CKC: %d bytes", ckc.byteLength);
        session.update(ckc);
        console.log("[FP] CKC applied");
        onEmeEvent?.("update", "CKC applied", { success: true, data: { ckcBytes: ckc.byteLength } });
      } catch (err) {
        console.error("[FP] License exchange failed:", err);
        onEmeEvent?.("error", "License exchange failed", { success: false });
      }
    });

    session.addEventListener("webkitkeyadded", () => {
      console.log("[FP] Key added — decryption active");
      onEmeEvent?.("key-status-change", "Key added — decryption active", { success: true });
    });

    session.addEventListener("webkitkeyerror", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = (session as any).error || {};
      console.error("[FP] Key error: code=%s systemCode=%s", err.code, err.systemCode);
      onEmeEvent?.("error", "Key error", { success: false, data: { code: err.code, systemCode: err.systemCode } });
    });
  };

  video.addEventListener("webkitneedkey", onNeedKey);

  return () => {
    destroyed = true;
    video.removeEventListener("webkitneedkey", onNeedKey);
  };
}
