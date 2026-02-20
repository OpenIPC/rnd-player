import { createFile, MP4BoxBuffer } from "mp4box";
import type { Sample } from "mp4box";
import shaka from "shaka-player";
import { extractInitSegmentUrl } from "./extractInitSegmentUrl";
import { addCacheBuster } from "./corsProxy";
import type { FrameType } from "../types/thumbnailWorker.types";

export interface FrameInfo {
  type: FrameType;
  size: number;
}

export interface FrameTypeResult {
  type: FrameType;
  size: number;
  gopFrames: FrameInfo[];
  frameIdx: number;
}

/**
 * Classify an array of samples (in decode order) into I/P/B frame types,
 * returning type + byte size in display (CTS) order.
 * Same algorithm as classifyFrameTypes in thumbnailWorker.ts.
 */
function classifyFrameTypes(
  samples: { cts: number; is_sync: boolean; data?: { byteLength: number } | null }[],
): FrameInfo[] {
  const decodeTypes: FrameType[] = [];
  let maxCts = -Infinity;
  for (const s of samples) {
    if (s.is_sync) {
      decodeTypes.push("I");
    } else if (s.cts >= maxCts) {
      decodeTypes.push("P");
    } else {
      decodeTypes.push("B");
    }
    if (s.cts > maxCts) maxCts = s.cts;
  }
  return samples
    .map((s, i) => ({ cts: s.cts, type: decodeTypes[i], size: s.data?.byteLength ?? 0 }))
    .sort((a, b) => a.cts - b.cts)
    .map((x) => ({ type: x.type, size: x.size }));
}

/**
 * Extract ALL samples (sync and non-sync) from a media segment using mp4box.
 */
function extractAllSamples(
  initBuf: ArrayBuffer,
  mediaData: ArrayBuffer,
): Promise<Sample[]> {
  return new Promise((resolve, reject) => {
    const allSamples: Sample[] = [];
    const mp4 = createFile();

    mp4.onReady = (info) => {
      const vt = info.videoTracks[0];
      if (!vt) {
        resolve([]);
        return;
      }
      mp4.setExtractionOptions(vt.id, null, { nbSamples: 5000 });
      mp4.start();
    };

    mp4.onSamples = (_id: number, _ref: unknown, samples: Sample[]) => {
      for (const s of samples) {
        if (s.data) allSamples.push(s);
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

interface SegmentCacheEntry {
  frames: FrameInfo[];
}

// Cache: segment URL → classified frame types in display order
const segmentCache = new Map<string, SegmentCacheEntry>();
const initCache = new Map<string, ArrayBuffer>();

function getActiveVideoStream(player: shaka.Player) {
  const tracks = player.getVariantTracks();
  const active = tracks.find((t) => t.active);
  if (!active) return null;
  const manifest = player.getManifest();
  if (!manifest?.variants?.length) return null;
  for (const v of manifest.variants) {
    if (
      v.video &&
      v.video.width === active.width &&
      v.video.height === active.height &&
      v.video.codecs === active.videoCodec
    ) {
      return v.video;
    }
  }
  return null;
}

/**
 * Fetch with CORS retry + cache busting (same strategy as corsProxy.ts).
 * Cross-origin requests get a per-session _cbust param to avoid stale
 * browser-cached ACAO headers. On TypeError (CORS), retries with
 * credentials omitted and cache bypassed.
 */
async function fetchSegment(url: string): Promise<ArrayBuffer | null> {
  const fetchUrl = isCrossOrigin(url) ? addCacheBuster(url) : url;
  try {
    const resp = await fetch(fetchUrl);
    if (!resp.ok) return null;
    return resp.arrayBuffer();
  } catch (e) {
    if (!(e instanceof TypeError)) return null;
    try {
      const resp = await fetch(fetchUrl, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!resp.ok) return null;
      return resp.arrayBuffer();
    } catch {
      return null;
    }
  }
}

function isCrossOrigin(url: string): boolean {
  try {
    return new URL(url).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Determine the frame type (I/P/B) being displayed at `time` (seconds) in
 * the given Shaka player's active video stream. Fetches the containing
 * segment, parses sample metadata with mp4box, and classifies frames.
 *
 * Time-to-frame mapping uses relative position within the segment (same
 * principle as the filmstrip save-frame pipeline) rather than absolute CTS
 * matching, which avoids issues with composition time offsets and timeline
 * differences between manifests.
 *
 * Results are cached per segment URL. Returns null if detection fails.
 */
export async function getFrameTypeAtTime(
  player: shaka.Player,
  time: number,
): Promise<FrameTypeResult | null> {
  try {
    const stream = getActiveVideoStream(player);
    if (!stream) return null;

    await stream.createSegmentIndex();
    const segmentIndex = stream.segmentIndex;
    if (!segmentIndex) return null;

    const iter = segmentIndex[Symbol.iterator]();
    const firstResult = iter.next();
    if (firstResult.done) return null;
    const firstRef = firstResult.value;
    if (!firstRef) return null;

    const initSegmentUrl = extractInitSegmentUrl(firstRef);
    if (!initSegmentUrl) return null;

    // Find the segment covering `time`
    let targetUrl: string | null = null;
    let segStart = 0;
    let segEnd = 0;
    for (const ref of segmentIndex) {
      if (!ref) continue;
      const start = ref.getStartTime();
      const end = ref.getEndTime();
      if (time >= start - 0.01 && time < end + 0.01) {
        const uris = ref.getUris();
        if (uris.length > 0) {
          targetUrl = uris[0];
          segStart = start;
          segEnd = end;
        }
        break;
      }
    }

    if (!targetUrl) return null;

    let entry = segmentCache.get(targetUrl);
    if (!entry) {
      // Fetch init segment (cached across calls for same stream)
      let initBuf: ArrayBuffer | undefined = initCache.get(initSegmentUrl);
      if (!initBuf) {
        const fetched = await fetchSegment(initSegmentUrl);
        if (!fetched) return null;
        initBuf = fetched;
        initCache.set(initSegmentUrl, initBuf);
      }

      const mediaBuf = await fetchSegment(targetUrl);
      if (!mediaBuf) return null;

      const samples = await extractAllSamples(initBuf, mediaBuf);
      if (samples.length === 0) return null;

      const frames = classifyFrameTypes(samples);
      entry = { frames };
      segmentCache.set(targetUrl, entry);
    }

    // Map time to frame index using relative position within the segment.
    // This avoids CTS-matching pitfalls (composition time offsets, cross-
    // stream timeline differences) — display-order frame indices are
    // consistent within a segment regardless of CTS base.
    const { frames } = entry;
    const count = frames.length;
    if (count === 0) return null;

    const segDur = segEnd - segStart;
    if (segDur <= 0) return frames[0] ?? null;

    const frac = Math.max(0, Math.min(1, (time - segStart) / segDur));
    const frameIdx = Math.min(Math.round(frac * (count - 1)), count - 1);

    const frame = frames[frameIdx];
    if (!frame) return null;
    return { type: frame.type, size: frame.size, gopFrames: frames, frameIdx };
  } catch {
    return null;
  }
}

/** Clear caches (call on cleanup). */
export function clearFrameTypeCache() {
  segmentCache.clear();
  initCache.clear();
}
