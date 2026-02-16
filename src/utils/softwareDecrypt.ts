/**
 * Software ClearKey decryption fallback for browsers where ClearKey EME
 * is reported as supported but fails to actually decrypt content (e.g.
 * Playwright's WebKit engine).
 *
 * Detection strategy: after loading with EME, check if the video reaches
 * readyState >= 2 (HAVE_CURRENT_DATA). If it has buffered data but
 * readyState stays at 1 (HAVE_METADATA), EME decryption silently failed —
 * the CDM produced garbage that the decoder silently drops. In that case,
 * reload with software decryption.
 *
 * Three-stage response filter pipeline:
 * 1. MANIFEST — strips ContentProtection elements so Shaka skips EME setup
 * 2. INIT_SEGMENT — caches init bytes, parses tenc, imports CryptoKey,
 *    rewrites encv→avc1 and removes sinf/pssh
 * 3. MEDIA_SEGMENT — parses senc, extracts samples via mp4box, decrypts
 *    each sample in-place within mdat
 *
 * Only supports `cenc` scheme (AES-CTR); bails on `cbcs`/`cbc1`.
 */

import { createFile, MP4BoxBuffer } from "mp4box";
import type { Sample } from "mp4box";
import shaka from "shaka-player";
import {
  importClearKey,
  extractScheme,
  extractTenc,
  extractTrackIdFromTfhd,
  parseSencFromSegment,
  decryptSample,
  findBoxData,
  type TencInfo,
} from "../workers/cencDecrypt";
import { stripInitEncryption } from "./stripEncryptionBoxes";

/**
 * Probes whether the browser can set up ClearKey EME via
 * `requestMediaKeySystemAccess`. Result is cached for the session.
 *
 * Returns `true` on browsers where the EME API is present and the
 * ClearKey key system can be initialized (Chromium, Firefox, macOS WebKit).
 * Returns `false` on browsers where EME is absent or ClearKey is
 * explicitly rejected (Linux WebKitGTK).
 *
 * NOTE: `true` does NOT guarantee decryption actually works — macOS WebKit
 * resolves the probe but silently fails to decrypt. Use `waitForDecryption()`
 * as a secondary check after loading with EME.
 */
let clearKeySupportCached: boolean | null = null;

export async function hasClearKeySupport(): Promise<boolean> {
  if (clearKeySupportCached !== null) return clearKeySupportCached;
  try {
    await navigator.requestMediaKeySystemAccess("org.w3.clearkey", [
      {
        initDataTypes: ["cenc"],
        videoCapabilities: [
          { contentType: 'video/mp4; codecs="avc1.42E01E"' },
        ],
      },
    ]);
    clearKeySupportCached = true;
  } catch {
    clearKeySupportCached = false;
  }
  return clearKeySupportCached;
}

/**
 * Wait for the video to reach a decodable state after loading with EME.
 * Returns true if readyState reaches HAVE_CURRENT_DATA (2) or higher,
 * false on timeout — meaning EME decryption silently failed.
 *
 * On browsers where ClearKey EME works (Chromium, Firefox), readyState
 * reaches 2+ within ~100-200ms. On browsers where it silently fails
 * (Playwright's WebKit), readyState stays at 1 (HAVE_METADATA) because
 * the CDM produces garbage that the decoder silently drops.
 */
export async function waitForDecryption(
  video: HTMLVideoElement,
  timeoutMs = 1500,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (video.readyState >= 2) return true;
    if (video.error) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Extract ALL samples from a media segment using a cached init segment.
 * Accepts an explicit trackId to extract from (video or audio).
 */
function extractAllSamples(
  initBuf: ArrayBuffer,
  mediaData: ArrayBuffer,
  trackId: number,
): Promise<Sample[]> {
  return new Promise((resolve, reject) => {
    const allSamples: Sample[] = [];
    const mp4 = createFile();

    mp4.onReady = () => {
      mp4.setExtractionOptions(trackId, null, { nbSamples: 100_000 });
      mp4.start();
    };

    mp4.onSamples = (_id: number, _ref: unknown, samples: Sample[]) => {
      for (const s of samples) {
        allSamples.push(s);
      }
    };

    mp4.onError = (_mod: string, msg: string) => reject(new Error(msg));

    try {
      const initSlice = MP4BoxBuffer.fromArrayBuffer(initBuf.slice(0), 0);
      const offset1 = mp4.appendBuffer(initSlice);
      const mediaBuf = MP4BoxBuffer.fromArrayBuffer(mediaData.slice(0), offset1);
      mp4.appendBuffer(mediaBuf);
      mp4.flush();
      mp4.stop();
      resolve(allSamples);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Parse the init segment with mp4box to extract tenc info for ALL tracks.
 * Returns a Map from track ID to TencInfo for each encrypted track.
 */
function parseInitAllTracks(initData: ArrayBuffer): Map<number, TencInfo> {
  const result = new Map<number, TencInfo>();
  const mp4 = createFile();
  const buf = MP4BoxBuffer.fromArrayBuffer(initData.slice(0), 0);
  mp4.onReady = (info) => {
    const allTracks = [
      ...info.videoTracks,
      ...info.audioTracks,
      ...info.otherTracks,
    ];
    for (const track of allTracks) {
      const scheme = extractScheme(mp4, track.id);
      if (scheme && scheme !== "cenc") {
        console.warn(`[softwareDecrypt] Unsupported encryption scheme for track ${track.id}: ${scheme}`);
        continue;
      }
      const tenc = extractTenc(mp4, track.id);
      if (tenc) {
        result.set(track.id, tenc);
      }
    }
  };
  mp4.appendBuffer(buf);
  mp4.flush();
  mp4.stop();
  return result;
}

/**
 * Register an async response filter on the Shaka Player instance that
 * decrypts CENC segments on-the-fly using the provided ClearKey hex string.
 */
export function configureSoftwareDecryption(
  player: shaka.Player,
  clearKeyHex: string,
): void {
  // Per-track state: each track (video, audio) has its own init data and tenc info
  const initDataByTrack = new Map<number, ArrayBuffer>();
  const tencInfoByTrack = new Map<number, TencInfo>();
  let cryptoKey: CryptoKey | null = null;

  const responseFilter: shaka.extern.ResponseFilter = async (
    type: shaka.net.NetworkingEngine.RequestType,
    response: shaka.extern.Response,
    _context?: shaka.extern.RequestContext,
  ) => {
    // ── MANIFEST: strip ContentProtection so Shaka skips EME ──
    if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
      const xml = new TextDecoder().decode(response.data as ArrayBuffer);
      const doc = new DOMParser().parseFromString(xml, "text/xml");

      // Remove all ContentProtection elements (any namespace)
      const cpElements = doc.getElementsByTagName("ContentProtection");
      while (cpElements.length > 0) {
        cpElements[0].parentNode?.removeChild(cpElements[0]);
      }

      response.data = new TextEncoder().encode(
        new XMLSerializer().serializeToString(doc),
      ).buffer as ArrayBuffer;
      return;
    }

    if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT) return;

    // Normalize response.data to ArrayBuffer (Shaka types it as ArrayBuffer | ArrayBufferView)
    const rawData: ArrayBuffer = ArrayBuffer.isView(response.data)
      ? response.data.buffer.slice(
          response.data.byteOffset,
          response.data.byteOffset + response.data.byteLength,
        ) as ArrayBuffer
      : response.data as ArrayBuffer;

    // Detect segment type by box presence rather than relying solely on
    // AdvancedRequestType. For SegmentBase streams, Shaka fetches the sidx
    // (index) range separately and may tag it as INIT_SEGMENT. Without the
    // moov check, the filter would overwrite cachedInitData with sidx bytes,
    // breaking all subsequent media segment decryption.
    const data = new Uint8Array(rawData);
    const hasMoov = findBoxData(data, "moov") !== null;
    const hasMoof = findBoxData(data, "moof") !== null;
    const isInit = hasMoov;
    const isMedia = hasMoof && !hasMoov;

    // ── INIT SEGMENT: cache per-track, parse tenc for all tracks, import key, strip encryption ──
    if (isInit) {
      const initCopy = rawData.slice(0);
      const trackTencs = parseInitAllTracks(initCopy);

      for (const [trackId, tenc] of trackTencs) {
        initDataByTrack.set(trackId, initCopy);
        tencInfoByTrack.set(trackId, tenc);
      }

      if (trackTencs.size > 0 && !cryptoKey) {
        cryptoKey = await importClearKey(clearKeyHex);
      }

      response.data = stripInitEncryption(rawData);
      return;
    }

    // ── MEDIA SEGMENT: decrypt samples in-place within mdat ──
    if (isMedia && cryptoKey) {
      // Identify which track this media segment belongs to via tfhd
      const trackId = extractTrackIdFromTfhd(data);
      if (trackId === null) return;

      const ti = tencInfoByTrack.get(trackId);
      const cachedInit = initDataByTrack.get(trackId);
      if (!ti || !cachedInit) return; // unencrypted track — pass through

      const ck = cryptoKey;

      const segBytes = new Uint8Array(rawData);
      const mdatContent = findBoxData(segBytes, "mdat");
      if (!mdatContent) return;

      const mdatDataStart = mdatContent.byteOffset - segBytes.byteOffset;
      const ivSize = ti.defaultPerSampleIVSize;
      const sencSamples = parseSencFromSegment(rawData, ivSize);

      const allSamples = await extractAllSamples(cachedInit, rawData, trackId);

      let cumulativeOffset = 0;
      for (let j = 0; j < allSamples.length; j++) {
        const sample = allSamples[j];
        const sencEntry = sencSamples[j];

        if (sencEntry) {
          const iv =
            sencEntry.iv.length > 0
              ? sencEntry.iv
              : ti.defaultConstantIV;
          if (iv && iv.length > 0) {
            const sampleData = segBytes.subarray(
              mdatDataStart + cumulativeOffset,
              mdatDataStart + cumulativeOffset + sample.size,
            );
            const decrypted = await decryptSample(
              ck,
              iv,
              sampleData,
              sencEntry.subsamples,
            );
            segBytes.set(decrypted, mdatDataStart + cumulativeOffset);
          }
        }
        cumulativeOffset += sample.size;
      }
      // response.data already points to rawData's buffer (modified in-place via segBytes)
      response.data = rawData;
    }
  };

  const net = player.getNetworkingEngine();
  if (net) {
    net.registerResponseFilter(responseFilter);
  }
}
