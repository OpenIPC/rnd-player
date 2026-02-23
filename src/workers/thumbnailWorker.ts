import { createFile, DataStream, MP4BoxBuffer, Endianness } from "mp4box";
import type { ISOFile, Sample } from "mp4box";
import type { WorkerRequest, WorkerResponse, FrameType, GopFrame } from "../types/thumbnailWorker.types";
import {
  importClearKey,
  extractScheme,
  extractTenc,
  parseSencFromSegment,
  decryptSample,
  type TencInfo,
} from "./cencDecrypt";

function post(msg: WorkerResponse, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer: transfer ?? [] });
}

// ── CORS proxy state ──
let proxyUrl = "";
let proxyHmacKey = "";
const corsBlockedOrigins = new Set<string>();
const corsSessionId = Math.random().toString(36).slice(2, 10);

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return true;
  }
}

function addCacheBuster(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("_cbust", corsSessionId);
    return u.toString();
  } catch {
    return url;
  }
}

async function computeHmac(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildProxyUrl(targetUrl: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const w = Math.floor(t / 300);
  const sig = await computeHmac(`${w}:${targetUrl}`, proxyHmacKey);
  return `${proxyUrl}/proxy?url=${encodeURIComponent(targetUrl)}&t=${t}&sig=${sig}`;
}

// ── Module-level state ──
let aborted = false;
let segments: { url: string; startTime: number; endTime: number }[] = [];
let initData: ArrayBuffer | null = null;
let decoder: VideoDecoder | null = null;
let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;
let currentSegStartTime = 0;
let currentQueue: number[] = [];
let processing = false;
let cryptoKey: CryptoKey | null = null;
let tencInfo: TencInfo | null = null;
let decoderConfig: VideoDecoderConfig | null = null;
let currentIntraQueue: { segmentIndex: number; count: number }[] = [];
let intraProcessing = false;
let activeInitData: ArrayBuffer | null = null;
let activeSegments: { url: string; startTime: number; endTime: number }[] = [];
/** Cache of frame types per active-stream segment URL to avoid re-fetching */
const activeFrameTypeCache = new Map<string, GopFrame[]>();
/** Active decode-segment request IDs for cancellation */
const cancelledDecodeRequests = new Set<string>();

function extractDescription(mp4: ISOFile, trackId: number): Uint8Array | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trak = mp4.getTrackById(trackId) as any;
  if (!trak) return undefined;

  const entries = trak.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries || entries.length === 0) return undefined;

  const entry = entries[0];
  const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
  if (!box) return undefined;

  try {
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    const pos = stream.getPosition();
    return new Uint8Array(stream.buffer, 8, pos - 8);
  } catch {
    return undefined;
  }
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  // Same-origin or no proxy configured → direct fetch
  if (!proxyUrl || !proxyHmacKey || isSameOrigin(url)) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${url}`);
    return resp.arrayBuffer();
  }

  // Known blocked origin → proxy directly
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${url}`);
    return resp.arrayBuffer();
  }

  if (corsBlockedOrigins.has(origin)) {
    const resp = await fetch(await buildProxyUrl(url));
    if (!resp.ok) throw new Error(`Fetch failed via proxy: ${resp.status} ${url}`);
    return resp.arrayBuffer();
  }

  // Try direct first, fall back through workaround then proxy
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${url}`);
    return resp.arrayBuffer();
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;

    try {
      const resp = await fetch(addCacheBuster(url), {
        credentials: "omit",
        cache: "no-store",
      });
      if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${url}`);
      return resp.arrayBuffer();
    } catch {
      corsBlockedOrigins.add(origin);
      const resp = await fetch(await buildProxyUrl(url));
      if (!resp.ok) throw new Error(`Fetch failed via proxy: ${resp.status} ${url}`);
      return resp.arrayBuffer();
    }
  }
}

/**
 * Extract sync samples from a media segment using the cached init segment.
 */
function extractSamplesFromSegment(
  initBuf: ArrayBuffer,
  mediaData: ArrayBuffer,
): Promise<Sample[]> {
  return new Promise((resolve, reject) => {
    const syncSamples: Sample[] = [];
    const mp4 = createFile();

    mp4.onReady = (info) => {
      const vt = info.videoTracks[0];
      if (!vt) {
        resolve([]);
        return;
      }
      mp4.setExtractionOptions(vt.id, null, { nbSamples: 500 });
      mp4.start();
    };

    mp4.onSamples = (_id: number, _ref: unknown, samples: Sample[]) => {
      for (const s of samples) {
        if (s.is_sync && s.data) syncSamples.push(s);
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
      resolve(syncSamples);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Extract ALL samples (sync and non-sync) from a media segment.
 */
function extractAllSamplesFromSegment(
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

/**
 * Classify an array of samples (in decode order) into I/P/B frame types,
 * returning GopFrame[] in display (CTS) order with byte sizes.
 */
function classifyFrameTypes(samples: { cts: number; is_sync: boolean; data?: { byteLength: number } | null }[]): GopFrame[] {
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
 * Extract just the frame types (no sizes) from GopFrame[].
 */
function gopTypes(gop: GopFrame[]): FrameType[] {
  return gop.map((f) => f.type);
}

/**
 * Get frame types for a segment from the active (watched) stream.
 * Falls back to classifying from the provided thumbnail-stream samples.
 */
async function getActiveFrameTypes(
  thumbSegStartTime: number,
  fallbackSamples: { cts: number; is_sync: boolean; data?: { byteLength: number } | null }[],
): Promise<GopFrame[]> {
  if (!activeInitData || activeSegments.length === 0) {
    return classifyFrameTypes(fallbackSamples);
  }

  // Find the active segment covering the same time
  const activeSeg = activeSegments.find(
    (as) => thumbSegStartTime >= as.startTime - 0.5 && thumbSegStartTime < as.endTime + 0.5,
  );
  if (!activeSeg) {
    return classifyFrameTypes(fallbackSamples);
  }

  // Check cache
  const cached = activeFrameTypeCache.get(activeSeg.url);
  if (cached) return cached;

  try {
    const mediaData = await fetchBuffer(activeSeg.url);
    if (aborted) return classifyFrameTypes(fallbackSamples);

    const activeSamples = await extractAllSamplesFromSegment(activeInitData, mediaData);
    const types = classifyFrameTypes(activeSamples);
    activeFrameTypeCache.set(activeSeg.url, types);
    return types;
  } catch {
    return classifyFrameTypes(fallbackSamples);
  }
}

/**
 * Decode all frames in a segment and capture N evenly-spaced ones as thumbnails.
 */
async function handleGenerateIntra(segIdx: number, count: number) {
  if (!initData || !offscreen || !decoderConfig) return;
  if (segIdx < 0 || segIdx >= segments.length) return;

  const seg = segments[segIdx];
  const thumbW = offscreen.width;
  const thumbH = offscreen.height;

  try {
    const mediaData = await fetchBuffer(seg.url);
    if (aborted) return;

    const allSamples = await extractAllSamplesFromSegment(initData, mediaData);
    if (aborted || allSamples.length <= 1) return;

    // Parse SENC data once if CENC is configured
    let sencSamples: Awaited<ReturnType<typeof parseSencFromSegment>> | null = null;
    if (cryptoKey && tencInfo) {
      try {
        sencSamples = parseSencFromSegment(mediaData, tencInfo.defaultPerSampleIVSize);
      } catch {
        return;
      }
    }

    // Classify frame types from the active (watched) stream, which may have
    // a different GOP structure than the lowest-quality thumbnail stream.
    const activeDisplayTypes = await getActiveFrameTypes(seg.startTime, allSamples);
    if (aborted) return;

    // Also classify from the thumbnail stream for VideoDecoder output mapping
    const thumbDisplayTypes = classifyFrameTypes(allSamples);

    // Determine which output frames to capture — evenly spaced across all
    // frames in display order. VideoDecoder outputs in CTS (display) order,
    // so index 0 is the first frame in presentation order (a B-frame when
    // B-frames are present), NOT the I-frame.
    const totalFrames = allSamples.length;
    const captureIndices = new Set<number>();
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i / (count - 1 || 1)) * (totalFrames - 1));
      if (idx >= 0 && idx < totalFrames) captureIndices.add(idx);
    }

    // Reuse a single canvas for all captures in this segment
    const captureCanvas = new OffscreenCanvas(thumbW, thumbH);
    const captureCtx = captureCanvas.getContext("2d")!;

    const bitmapPromises: { outputIdx: number; promise: Promise<ImageBitmap>; frameType: FrameType }[] = [];
    let outputCount = 0;

    const intraDecoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        const currentOutputIdx = outputCount++;
        if (captureIndices.has(currentOutputIdx)) {
          captureCtx.drawImage(frame, 0, 0, thumbW, thumbH);
          frame.close();
          bitmapPromises.push({
            outputIdx: currentOutputIdx,
            promise: createImageBitmap(captureCanvas),
            frameType: thumbDisplayTypes[currentOutputIdx]?.type ?? "P",
          });
        } else {
          frame.close();
        }
      },
      error: () => { /* best-effort */ },
    });

    intraDecoder.configure(decoderConfig);

    // Feed all samples to the decoder
    for (let i = 0; i < allSamples.length; i++) {
      if (aborted) break;

      const sample = allSamples[i];
      let sampleBytes: Uint8Array = new Uint8Array(sample.data!);

      // Decrypt if CENC is configured
      if (cryptoKey && tencInfo && sencSamples && sencSamples.length > 0) {
        try {
          const sencIdx = sample.number_in_traf ?? sample.number;
          const sencEntry = sencSamples[sencIdx];
          if (sencEntry) {
            const iv = sencEntry.iv.length > 0 ? sencEntry.iv : tencInfo.defaultConstantIV;
            if (iv && iv.length > 0) {
              sampleBytes = await decryptSample(cryptoKey, iv, sampleBytes, sencEntry.subsamples);
            }
          }
        } catch {
          continue;
        }
      }

      intraDecoder.decode(
        new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: (sample.cts / sample.timescale) * 1_000_000,
          data: sampleBytes,
        }),
      );
    }

    if (aborted) {
      try { intraDecoder.close(); } catch { /* */ }
      return;
    }

    await intraDecoder.flush();
    try { intraDecoder.close(); } catch { /* */ }

    // Collect all captured bitmaps in order
    bitmapPromises.sort((a, b) => a.outputIdx - b.outputIdx);
    const bitmaps = await Promise.all(bitmapPromises.map((p) => p.promise));

    // Build CTS timestamps (in seconds) for each captured bitmap.
    // Sort samples by CTS to get display order, then map each captured
    // output index to its CTS. This gives the exact presentation time
    // of each bitmap, accounting for composition time offsets.
    const displayOrderSamples = [...allSamples]
      .map((s) => ({ cts: s.cts, timescale: s.timescale }))
      .sort((a, b) => a.cts - b.cts);
    const timestamps = bitmapPromises.map((p) => {
      const s = displayOrderSamples[p.outputIdx];
      return s ? s.cts / s.timescale : 0;
    });

    // Map frame types from the active stream to captured bitmap positions.
    // The active stream may have a different frame count, so we sample
    // evenly from its display-order types.
    const activeTypesList = gopTypes(activeDisplayTypes);
    const frameTypes = bitmapPromises.map((_p, i) => {
      if (activeTypesList.length === 0) return _p.frameType;
      const idx = Math.round((i / (bitmapPromises.length - 1 || 1)) * (activeTypesList.length - 1));
      return activeTypesList[idx] ?? _p.frameType;
    });

    if (aborted) {
      bitmaps.forEach((b) => b.close());
      return;
    }

    post({ type: "intraFrames", segmentIndex: segIdx, bitmaps, frameTypes, gopStructure: activeDisplayTypes, timestamps }, bitmaps);
  } catch (e) {
    if (!aborted) {
      post({ type: "error", message: `Intra-frame error: ${e}` });
    }
  }
}

/**
 * Process the intra-frame queue one segment at a time.
 * New updateIntraQueue messages replace pending items while this runs.
 */
async function processIntraQueue() {
  intraProcessing = true;
  try {
    while (currentIntraQueue.length > 0) {
      if (aborted) break;
      const item = currentIntraQueue.shift()!;
      await handleGenerateIntra(item.segmentIndex, item.count);
    }
  } catch (e) {
    if (!aborted) {
      post({ type: "error", message: `${e}` });
    }
  }
  intraProcessing = false;
}

/**
 * Initialize: fetch init segment, extract codec description, configure decoder.
 * Does NOT process any media segments.
 */
async function initialize(req: Extract<WorkerRequest, { type: "generate" }>) {
  const { initSegmentUrl, codec, width, height, thumbnailWidth } = req;
  segments = req.segments;

  // Store CORS proxy config
  proxyUrl = req.corsProxyUrl ?? "";
  proxyHmacKey = req.corsProxyHmacKey ?? "";

  // Reset state
  currentQueue = [];
  processing = false;

  // Set up thumbnail rendering
  const thumbHeight = Math.round((thumbnailWidth / width) * height);
  offscreen = new OffscreenCanvas(thumbnailWidth, thumbHeight);
  offCtx = offscreen.getContext("2d")!;

  // 1. Fetch init segment and extract codec description
  initData = await fetchBuffer(initSegmentUrl);
  if (aborted) return;

  let description: Uint8Array | undefined;
  {
    const mp4 = createFile();
    const buf = MP4BoxBuffer.fromArrayBuffer(initData.slice(0), 0);
    mp4.onReady = (info) => {
      const vt = info.videoTracks[0];
      if (!vt) return;
      description = extractDescription(mp4, vt.id);

      // CENC decryption setup (if key provided)
      if (req.clearKeyHex) {
        const scheme = extractScheme(mp4, vt.id);
        if (scheme && scheme !== "cenc") {
          post({ type: "error", message: `Unsupported encryption scheme: ${scheme}` });
        } else {
          const ti = extractTenc(mp4, vt.id);
          if (ti) {
            tencInfo = ti;
          }
        }
      }
    };
    mp4.appendBuffer(buf);
    mp4.flush();
    mp4.stop();
  }

  // Import CryptoKey if tenc was found
  if (req.clearKeyHex && tencInfo) {
    try {
      cryptoKey = await importClearKey(req.clearKeyHex);
    } catch (e) {
      post({ type: "error", message: `Failed to import decryption key: ${e}` });
      cryptoKey = null;
      tencInfo = null;
    }
  }

  // Fetch active stream init segment for frame type classification
  activeSegments = req.activeSegments ?? [];
  activeInitData = null;
  activeFrameTypeCache.clear();
  if (req.activeInitSegmentUrl) {
    try {
      activeInitData = await fetchBuffer(req.activeInitSegmentUrl);
    } catch {
      // Non-critical: will fall back to thumbnail stream for classification
    }
    if (aborted) return;
  }

  // 2. Configure VideoDecoder
  const config: VideoDecoderConfig = {
    codec,
    codedWidth: width,
    codedHeight: height,
    ...(description ? { description } : {}),
  };
  decoderConfig = config;

  decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      const targetTime = currentSegStartTime;
      offCtx!.drawImage(frame, 0, 0, offscreen!.width, offscreen!.height);
      frame.close();

      createImageBitmap(offscreen!).then((bitmap) => {
        if (aborted) {
          bitmap.close();
          return;
        }
        post({ type: "thumbnail", timestamp: targetTime, bitmap }, [bitmap]);
      });
    },
    error: (e: DOMException) => {
      post({ type: "error", message: `VideoDecoder error: ${e.message}` });
    },
  });

  try {
    decoder.configure(config);
    post({ type: "ready" });
  } catch (e) {
    post({ type: "error", message: `Failed to configure decoder: ${e}` });
  }
}

/**
 * Process the current queue. New updateQueue messages replace currentQueue
 * contents while this loop runs — the loop always finishes the current
 * segment before checking for new items, so it makes steady progress.
 */
async function processQueue() {
  processing = true;

  try {
    while (currentQueue.length > 0) {
      if (aborted) break;

      const segIdx = currentQueue.shift()!;
      if (segIdx < 0 || segIdx >= segments.length) continue;

      const seg = segments[segIdx];

      const mediaData = await fetchBuffer(seg.url);
      if (aborted) break;

      const syncSamples = await extractSamplesFromSegment(initData!, mediaData);
      if (aborted) break;

      if (syncSamples.length > 0 && decoder) {
        const sample = syncSamples[0];
        currentSegStartTime = seg.startTime;

        let sampleBytes: Uint8Array = new Uint8Array(sample.data!);

        // Decrypt if CENC is configured
        if (cryptoKey && tencInfo) {
          try {
            const ivSize = tencInfo.defaultPerSampleIVSize;
            const sencSamples = parseSencFromSegment(mediaData, ivSize);

            if (sencSamples.length > 0) {
              // Look up senc entry for this sample
              const sencIdx = sample.number_in_traf ?? sample.number;
              const sencEntry = sencSamples[sencIdx];

              if (sencEntry) {
                // Use per-sample IV, falling back to constant IV when IV size is 0
                const iv = sencEntry.iv.length > 0 ? sencEntry.iv : tencInfo.defaultConstantIV;
                if (iv && iv.length > 0) {
                  sampleBytes = await decryptSample(cryptoKey, iv, sampleBytes, sencEntry.subsamples);
                }
              }
            }
          } catch {
            continue;
          }
        }

        decoder.decode(
          new EncodedVideoChunk({
            type: "key",
            timestamp: (sample.cts / sample.timescale) * 1_000_000,
            data: sampleBytes,
          }),
        );

        await decoder.flush();
      }
    }
  } catch (e) {
    if (!aborted) {
      post({ type: "error", message: `${e}` });
    }
  }

  processing = false;
}

/**
 * Decode ALL frames from the active stream at full resolution for a given
 * segment, posting each frame progressively as a `segmentFrame` message.
 */
async function handleDecodeSegmentFrames(msg: Extract<WorkerRequest, { type: "decodeSegmentFrames" }>) {
  const { requestId, time, initSegmentUrl, segments: segs, codec, width, height } = msg;

  try {
    // 1. Find segment containing the requested time
    let targetSeg = segs[0];
    for (const seg of segs) {
      if (time >= seg.startTime && time < seg.endTime) {
        targetSeg = seg;
        break;
      }
      if (Math.abs(seg.startTime - time) < Math.abs(targetSeg.startTime - time)) {
        targetSeg = seg;
      }
    }

    // 2. Fetch init segment and extract codec description
    const initBuf = await fetchBuffer(initSegmentUrl);
    if (cancelledDecodeRequests.has(requestId)) { cancelledDecodeRequests.delete(requestId); return; }

    let description: Uint8Array | undefined;
    {
      const mp4 = createFile();
      const buf = MP4BoxBuffer.fromArrayBuffer(initBuf.slice(0), 0);
      mp4.onReady = (info) => {
        const vt = info.videoTracks[0];
        if (vt) description = extractDescription(mp4, vt.id);
      };
      mp4.appendBuffer(buf);
      mp4.flush();
      mp4.stop();
    }

    // 3. Fetch media segment, extract ALL samples
    const mediaData = await fetchBuffer(targetSeg.url);
    if (cancelledDecodeRequests.has(requestId)) { cancelledDecodeRequests.delete(requestId); return; }

    const allSamples = await extractAllSamplesFromSegment(initBuf, mediaData);
    if (allSamples.length === 0) {
      post({ type: "segmentFramesDone", requestId, totalFrames: 0 });
      return;
    }

    // 4. Classify frame types (display order)
    const gopStructure = classifyFrameTypes(allSamples);
    const totalFrames = allSamples.length;

    // 5. Parse SENC if encrypted
    let sencSamples: Awaited<ReturnType<typeof parseSencFromSegment>> | null = null;
    if (cryptoKey && tencInfo) {
      try {
        sencSamples = parseSencFromSegment(mediaData, tencInfo.defaultPerSampleIVSize);
      } catch {
        post({ type: "segmentFramesDone", requestId, totalFrames: 0 });
        return;
      }
    }

    // 6. One-shot VideoDecoder at full resolution — capture every output
    const canvas = new OffscreenCanvas(width, height);
    const ctx2d = canvas.getContext("2d")!;
    let outputCount = 0;

    const bitmapQueue: Promise<void>[] = [];

    const dec = new VideoDecoder({
      output: (frame: VideoFrame) => {
        const currentIdx = outputCount++;
        ctx2d.drawImage(frame, 0, 0, width, height);
        frame.close();

        if (cancelledDecodeRequests.has(requestId)) return;

        const frameType = gopStructure[currentIdx]?.type ?? "P";
        const sizeBytes = gopStructure[currentIdx]?.size ?? 0;
        const idx = currentIdx;

        const p = createImageBitmap(canvas).then((bitmap) => {
          if (cancelledDecodeRequests.has(requestId)) {
            bitmap.close();
            return;
          }
          post(
            { type: "segmentFrame", requestId, frameIndex: idx, totalFrames, bitmap, frameType, sizeBytes },
            [bitmap],
          );
        });
        bitmapQueue.push(p);
      },
      error: () => { /* best-effort */ },
    });

    const config: VideoDecoderConfig = {
      codec,
      codedWidth: width,
      codedHeight: height,
      ...(description ? { description } : {}),
    };

    dec.configure(config);

    // Feed all samples
    for (let i = 0; i < allSamples.length; i++) {
      if (cancelledDecodeRequests.has(requestId)) break;

      const sample = allSamples[i];
      let sampleBytes: Uint8Array = new Uint8Array(sample.data!);

      if (cryptoKey && tencInfo && sencSamples && sencSamples.length > 0) {
        try {
          const sencIdx = sample.number_in_traf ?? sample.number;
          const sencEntry = sencSamples[sencIdx];
          if (sencEntry) {
            const iv = sencEntry.iv.length > 0 ? sencEntry.iv : tencInfo.defaultConstantIV;
            if (iv && iv.length > 0) {
              sampleBytes = await decryptSample(cryptoKey, iv, sampleBytes, sencEntry.subsamples);
            }
          }
        } catch {
          continue;
        }
      }

      dec.decode(
        new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: (sample.cts / sample.timescale) * 1_000_000,
          data: sampleBytes,
        }),
      );
    }

    if (!cancelledDecodeRequests.has(requestId)) {
      await dec.flush();
    }
    try { dec.close(); } catch { /* */ }

    // Wait for all bitmap posts to complete
    await Promise.all(bitmapQueue);

    if (!cancelledDecodeRequests.has(requestId)) {
      post({ type: "segmentFramesDone", requestId, totalFrames });
    }
    cancelledDecodeRequests.delete(requestId);
  } catch {
    cancelledDecodeRequests.delete(requestId);
    post({ type: "segmentFramesDone", requestId, totalFrames: 0 });
  }
}

/**
 * One-shot frame capture at the requested time using the active stream's
 * segments. Reuses module-level cryptoKey/tencInfo for DRM decryption.
 */
async function handleSaveFrame(msg: Extract<WorkerRequest, { type: "saveFrame" }>) {
  try {
    const { time, initSegmentUrl, segments: segs, codec, width, height, framePosition } = msg;

    // 1. Find the segment containing the requested time (or nearest)
    let targetSeg = segs[0];
    for (const seg of segs) {
      if (time >= seg.startTime && time < seg.endTime) {
        targetSeg = seg;
        break;
      }
      if (
        Math.abs(seg.startTime - time) <
        Math.abs(targetSeg.startTime - time)
      ) {
        targetSeg = seg;
      }
    }

    // 2. Fetch the active stream's init segment and extract codec description
    const initBuf = await fetchBuffer(initSegmentUrl);
    let description: Uint8Array | undefined;
    {
      const mp4 = createFile();
      const buf = MP4BoxBuffer.fromArrayBuffer(initBuf.slice(0), 0);
      mp4.onReady = (info) => {
        const vt = info.videoTracks[0];
        if (vt) description = extractDescription(mp4, vt.id);
      };
      mp4.appendBuffer(buf);
      mp4.flush();
      mp4.stop();
    }

    // 3. Fetch the media segment and extract ALL samples (not just sync)
    const mediaData = await fetchBuffer(targetSeg.url);
    const allSamples = await extractAllSamplesFromSegment(initBuf, mediaData);
    if (allSamples.length === 0) {
      post({ type: "saveFrameResult", bitmap: null });
      return;
    }

    // 4. Determine which output frame to capture.
    //    VideoDecoder outputs in CTS (display) order.
    //
    //    When framePosition is provided (0.0 = first, 1.0 = last), use it
    //    to compute the display-order index directly. This avoids cross-stream
    //    CTS mismatches: the thumbnail stream (which determines what the user
    //    sees) may have a different CTTS offset than the active stream (which
    //    we decode here for saving).
    //
    //    When framePosition is not provided, fall back to CTS matching.
    const totalFrames = allSamples.length;
    let targetDisplayIdx: number;

    if (framePosition != null) {
      // Position-based: map normalized position to display-order frame index
      targetDisplayIdx = Math.round(framePosition * (totalFrames - 1));
      targetDisplayIdx = Math.max(0, Math.min(totalFrames - 1, targetDisplayIdx));
    } else {
      // CTS-based fallback
      const displayOrder = allSamples
        .map((s, i) => ({ decodeIdx: i, cts: s.cts, timescale: s.timescale }))
        .sort((a, b) => a.cts - b.cts);

      targetDisplayIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < displayOrder.length; i++) {
        const sampleTime = displayOrder[i].cts / displayOrder[i].timescale;
        const dist = Math.abs(sampleTime - time);
        if (dist < bestDist) {
          bestDist = dist;
          targetDisplayIdx = i;
        }
      }
    }

    // 5. Parse SENC data once if CENC is configured
    let sencSamples: Awaited<ReturnType<typeof parseSencFromSegment>> | null = null;
    if (cryptoKey && tencInfo) {
      try {
        sencSamples = parseSencFromSegment(mediaData, tencInfo.defaultPerSampleIVSize);
      } catch {
        post({ type: "saveFrameResult", bitmap: null });
        return;
      }
    }

    // 6. One-shot VideoDecoder at full resolution — feed ALL samples,
    //    capture the Nth output frame (display-order index).
    const bitmap = await new Promise<ImageBitmap | null>((resolve) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx2d = canvas.getContext("2d")!;
      let resolved = false;
      let outputCount = 0;

      const dec = new VideoDecoder({
        output: (frame: VideoFrame) => {
          const currentIdx = outputCount++;
          if (!resolved && currentIdx === targetDisplayIdx) {
            ctx2d.drawImage(frame, 0, 0, width, height);
            frame.close();
            resolved = true;
            createImageBitmap(canvas).then(resolve).catch(() => resolve(null));
          } else {
            frame.close();
          }
        },
        error: () => { if (!resolved) resolve(null); },
      });

      const config: VideoDecoderConfig = {
        codec,
        codedWidth: width,
        codedHeight: height,
        ...(description ? { description } : {}),
      };

      try {
        dec.configure(config);

        // Feed all samples in decode order (as stored)
        (async () => {
          for (let i = 0; i < allSamples.length; i++) {
            const sample = allSamples[i];
            let sampleBytes: Uint8Array = new Uint8Array(sample.data!);

            // Decrypt if CENC is configured
            if (cryptoKey && tencInfo && sencSamples && sencSamples.length > 0) {
              try {
                const sencIdx = sample.number_in_traf ?? sample.number;
                const sencEntry = sencSamples[sencIdx];
                if (sencEntry) {
                  const iv = sencEntry.iv.length > 0 ? sencEntry.iv : tencInfo.defaultConstantIV;
                  if (iv && iv.length > 0) {
                    sampleBytes = await decryptSample(cryptoKey, iv, sampleBytes, sencEntry.subsamples);
                  }
                }
              } catch {
                continue;
              }
            }

            dec.decode(
              new EncodedVideoChunk({
                type: sample.is_sync ? "key" : "delta",
                timestamp: (sample.cts / sample.timescale) * 1_000_000,
                data: sampleBytes,
              }),
            );
          }

          await dec.flush();
          try { dec.close(); } catch { /* */ }
          if (!resolved) resolve(null);
        })().catch(() => { if (!resolved) resolve(null); });
      } catch {
        resolve(null);
      }
    });

    if (bitmap) {
      post({ type: "saveFrameResult", bitmap }, [bitmap]);
    } else {
      post({ type: "saveFrameResult", bitmap: null });
    }
  } catch {
    post({ type: "saveFrameResult", bitmap: null });
  }
}

/**
 * Decode the last frame before and the first frame after a scene boundary.
 * Uses frame-number-based index lookup to find the exact frames, immune to
 * CTS/CTO/FPS mapping inaccuracies.
 */
async function handleBoundaryPreview(boundaryTime: number, frameNumber: number) {
  if (!initData || !decoderConfig || segments.length === 0) {
    post({ type: "boundaryPreview", boundaryTime, beforeBitmap: null, afterBitmap: null });
    return;
  }

  const thumbW = offscreen?.width ?? 160;
  const thumbH = offscreen?.height ?? 90;

  try {
    // Step 1: Find the segment containing frame `frameNumber` by counting
    // frames across segments. Use the first segment's frame count as the
    // per-segment estimate (accurate for uniform-duration DASH segments).
    // We fetch the first segment we think contains the boundary to get
    // the actual frame count.

    // Approximate segment index from boundaryTime (works for segment lookup)
    let approxSegIdx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (boundaryTime >= segments[i].startTime - 0.5 && boundaryTime < segments[i].endTime + 0.5) {
        approxSegIdx = i;
        break;
      }
    }
    if (approxSegIdx < 0) {
      // Fallback: use proportional guess
      approxSegIdx = Math.min(
        segments.length - 1,
        Math.max(0, Math.floor((boundaryTime - segments[0].startTime) / (segments[0].endTime - segments[0].startTime))),
      );
    }

    // Fetch the approximate segment to get its frame count
    const approxMediaData = await fetchBuffer(segments[approxSegIdx].url);
    if (aborted) { post({ type: "boundaryPreview", boundaryTime, beforeBitmap: null, afterBitmap: null }); return; }
    const approxSamples = await extractAllSamplesFromSegment(initData, approxMediaData);
    if (aborted || approxSamples.length === 0) { post({ type: "boundaryPreview", boundaryTime, beforeBitmap: null, afterBitmap: null }); return; }

    const framesPerSeg = approxSamples.length;

    // Compute which segment the frameNumber falls in and the local index
    let targetSegIdx = Math.floor(frameNumber / framesPerSeg);
    let localIndex = frameNumber - targetSegIdx * framesPerSeg;

    // Clamp to valid range
    if (targetSegIdx >= segments.length) {
      targetSegIdx = segments.length - 1;
      localIndex = framesPerSeg; // will use last frame
    }

    // Step 2: Determine if both frames are in the same segment or straddling two
    let beforeBitmap: ImageBitmap | null = null;
    let afterBitmap: ImageBitmap | null = null;

    if (localIndex > 0 && localIndex < framesPerSeg) {
      // Both frames in the same segment (before = localIndex-1, after = localIndex)
      // Reuse already-fetched data if it's the right segment
      let mediaData: ArrayBuffer;
      let allSamples: Awaited<ReturnType<typeof extractAllSamplesFromSegment>>;
      if (targetSegIdx === approxSegIdx) {
        mediaData = approxMediaData;
        allSamples = approxSamples;
      } else {
        mediaData = await fetchBuffer(segments[targetSegIdx].url);
        if (aborted) { post({ type: "boundaryPreview", boundaryTime, beforeBitmap: null, afterBitmap: null }); return; }
        allSamples = await extractAllSamplesFromSegment(initData, mediaData);
        if (aborted || allSamples.length === 0) { post({ type: "boundaryPreview", boundaryTime, beforeBitmap: null, afterBitmap: null }); return; }
      }

      // Sort by CTS → display order, then look up exact CTS by index
      const displayOrder = [...allSamples]
        .map((s) => ({ cts: s.cts, timescale: s.timescale }))
        .sort((a, b) => a.cts - b.cts);

      const beforeIdx = Math.max(0, Math.min(localIndex - 1, displayOrder.length - 1));
      const afterIdx = Math.min(localIndex, displayOrder.length - 1);
      const beforeCtsUs = (displayOrder[beforeIdx].cts / displayOrder[beforeIdx].timescale) * 1_000_000;
      const afterCtsUs = (displayOrder[afterIdx].cts / displayOrder[afterIdx].timescale) * 1_000_000;

      // Decode with timestamp matching
      let sencSamples: Awaited<ReturnType<typeof parseSencFromSegment>> | null = null;
      if (cryptoKey && tencInfo) {
        try {
          sencSamples = parseSencFromSegment(mediaData, tencInfo.defaultPerSampleIVSize);
        } catch {
          post({ type: "boundaryPreview", boundaryTime, beforeBitmap: null, afterBitmap: null });
          return;
        }
      }

      const frameDurUs = displayOrder.length > 1
        ? Math.abs(displayOrder[1].cts - displayOrder[0].cts) / displayOrder[0].timescale * 1_000_000
        : 20_000;
      const toleranceUs = frameDurUs / 2;

      const beforeCanvas = new OffscreenCanvas(thumbW, thumbH);
      const beforeCtx = beforeCanvas.getContext("2d")!;
      const afterCanvas = new OffscreenCanvas(thumbW, thumbH);
      const afterCtx = afterCanvas.getContext("2d")!;
      let gotBefore = false;
      let gotAfter = false;

      const dec = new VideoDecoder({
        output: (frame: VideoFrame) => {
          const ts = frame.timestamp;
          if (!gotBefore && Math.abs(ts - beforeCtsUs) < toleranceUs) {
            beforeCtx.drawImage(frame, 0, 0, thumbW, thumbH);
            gotBefore = true;
          }
          if (!gotAfter && Math.abs(ts - afterCtsUs) < toleranceUs) {
            afterCtx.drawImage(frame, 0, 0, thumbW, thumbH);
            gotAfter = true;
          }
          frame.close();
        },
        error: () => {},
      });

      dec.configure(decoderConfig!);
      for (const sample of allSamples) {
        if (aborted) break;
        let sampleBytes: Uint8Array = new Uint8Array(sample.data!);
        if (cryptoKey && tencInfo && sencSamples && sencSamples.length > 0) {
          try {
            const sencIdx = sample.number_in_traf ?? sample.number;
            const sencEntry = sencSamples[sencIdx];
            if (sencEntry) {
              const iv = sencEntry.iv.length > 0 ? sencEntry.iv : tencInfo.defaultConstantIV;
              if (iv && iv.length > 0) {
                sampleBytes = await decryptSample(cryptoKey, iv, sampleBytes, sencEntry.subsamples);
              }
            }
          } catch { continue; }
        }
        dec.decode(new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: (sample.cts / sample.timescale) * 1_000_000,
          data: sampleBytes,
        }));
      }
      if (!aborted) await dec.flush();
      try { dec.close(); } catch { /* */ }

      beforeBitmap = gotBefore ? await createImageBitmap(beforeCanvas) : null;
      afterBitmap = gotAfter ? await createImageBitmap(afterCanvas) : null;

    } else if (localIndex === 0 && targetSegIdx > 0) {
      // Boundary at segment start — before frame is last in previous segment,
      // after frame is first in this segment.
      const [bResult, aResult] = await Promise.all([
        decodeSingleFrame(targetSegIdx - 1, "last"),
        decodeSingleFrame(targetSegIdx, "first"),
      ]);
      beforeBitmap = bResult;
      afterBitmap = aResult;
    } else {
      // localIndex >= framesPerSeg or other edge case — try last/first of adjacent segments
      const [bResult, aResult] = await Promise.all([
        decodeSingleFrame(targetSegIdx, "last"),
        decodeSingleFrame(targetSegIdx + 1 < segments.length ? targetSegIdx + 1 : targetSegIdx, "first"),
      ]);
      beforeBitmap = bResult;
      afterBitmap = aResult;
    }

    const transfer: Transferable[] = [];
    if (beforeBitmap) transfer.push(beforeBitmap);
    if (afterBitmap) transfer.push(afterBitmap);
    post({ type: "boundaryPreview", boundaryTime, beforeBitmap, afterBitmap }, transfer);
  } catch {
    post({ type: "boundaryPreview", boundaryTime, beforeBitmap: null, afterBitmap: null });
  }
}

/** Decode a single frame (first or last in display order) from a segment. */
async function decodeSingleFrame(
  segIdx: number,
  which: "first" | "last",
): Promise<ImageBitmap | null> {
  if (segIdx < 0 || segIdx >= segments.length || !initData || !decoderConfig) return null;
  const thumbW = offscreen?.width ?? 160;
  const thumbH = offscreen?.height ?? 90;

  const mediaData = await fetchBuffer(segments[segIdx].url);
  if (aborted) return null;
  const allSamples = await extractAllSamplesFromSegment(initData, mediaData);
  if (aborted || allSamples.length === 0) return null;

  const displayOrder = [...allSamples]
    .map((s) => ({ cts: s.cts, timescale: s.timescale }))
    .sort((a, b) => a.cts - b.cts);

  const target = which === "first" ? displayOrder[0] : displayOrder[displayOrder.length - 1];
  const targetUs = (target.cts / target.timescale) * 1_000_000;

  const frameDurUs = displayOrder.length > 1
    ? Math.abs(displayOrder[1].cts - displayOrder[0].cts) / displayOrder[0].timescale * 1_000_000
    : 20_000;
  const toleranceUs = frameDurUs / 2;

  let sencSamples: Awaited<ReturnType<typeof parseSencFromSegment>> | null = null;
  if (cryptoKey && tencInfo) {
    try {
      sencSamples = parseSencFromSegment(mediaData, tencInfo.defaultPerSampleIVSize);
    } catch { return null; }
  }

  const canvas = new OffscreenCanvas(thumbW, thumbH);
  const ctx = canvas.getContext("2d")!;
  let captured = false;

  const dec = new VideoDecoder({
    output: (frame: VideoFrame) => {
      if (!captured && Math.abs(frame.timestamp - targetUs) < toleranceUs) {
        ctx.drawImage(frame, 0, 0, thumbW, thumbH);
        captured = true;
      }
      frame.close();
    },
    error: () => {},
  });
  dec.configure(decoderConfig);
  for (const sample of allSamples) {
    if (aborted) break;
    let sampleBytes: Uint8Array = new Uint8Array(sample.data!);
    if (cryptoKey && tencInfo && sencSamples && sencSamples.length > 0) {
      try {
        const sencIdx = sample.number_in_traf ?? sample.number;
        const sencEntry = sencSamples[sencIdx];
        if (sencEntry) {
          const iv = sencEntry.iv.length > 0 ? sencEntry.iv : tencInfo.defaultConstantIV;
          if (iv && iv.length > 0) {
            sampleBytes = await decryptSample(cryptoKey, iv, sampleBytes, sencEntry.subsamples);
          }
        }
      } catch { continue; }
    }
    dec.decode(new EncodedVideoChunk({
      type: sample.is_sync ? "key" : "delta",
      timestamp: (sample.cts / sample.timescale) * 1_000_000,
      data: sampleBytes,
    }));
  }
  if (!aborted) await dec.flush();
  try { dec.close(); } catch { /* */ }
  return captured ? await createImageBitmap(canvas) : null;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  if (msg.type === "abort") {
    aborted = true;
    if (decoder) {
      try { decoder.close(); } catch { /* */ }
      decoder = null;
    }
    cryptoKey = null;
    tencInfo = null;
    currentIntraQueue = [];
    return;
  }

  if (msg.type === "generate") {
    aborted = false;
    initialize(msg).catch((err) => {
      post({ type: "error", message: `${err}` });
    });
    return;
  }

  if (msg.type === "saveFrame") {
    handleSaveFrame(msg).catch(() => {
      post({ type: "saveFrameResult", bitmap: null });
    });
    return;
  }

  if (msg.type === "decodeSegmentFrames") {
    handleDecodeSegmentFrames(msg).catch(() => {
      post({ type: "segmentFramesDone", requestId: msg.requestId, totalFrames: 0 });
    });
    return;
  }

  if (msg.type === "cancelDecodeSegment") {
    cancelledDecodeRequests.add(msg.requestId);
    return;
  }

  if (msg.type === "boundaryPreview") {
    handleBoundaryPreview(msg.boundaryTime, msg.frameNumber).catch(() => {
      post({ type: "boundaryPreview", boundaryTime: msg.boundaryTime, beforeBitmap: null, afterBitmap: null });
    });
    return;
  }

  if (msg.type === "requestGop") {
    // Lightweight: classify frame types without decoding video frames.
    // Fetches the active stream segment (or thumbnail stream as fallback)
    // and parses sample metadata for I/P/B classification.
    const segIdx = msg.segmentIndex;
    if (segIdx >= 0 && segIdx < segments.length && initData) {
      const seg = segments[segIdx];
      (async () => {
        // Try active stream first
        let types = await getActiveFrameTypes(seg.startTime, []);
        // Fallback: classify from the thumbnail stream
        if (types.length === 0) {
          try {
            const mediaData = await fetchBuffer(seg.url);
            if (aborted) return;
            const samples = await extractAllSamplesFromSegment(initData!, mediaData);
            types = classifyFrameTypes(samples);
          } catch { /* best-effort */ }
        }
        if (!aborted && types.length > 0) {
          post({ type: "gopStructure", segmentIndex: segIdx, gopStructure: types });
        }
      })().catch(() => { /* best-effort */ });
    }
    return;
  }

  if (msg.type === "updateIntraQueue") {
    currentIntraQueue = [...msg.items];
    if (!intraProcessing && initData && decoderConfig) {
      processIntraQueue().catch((err) => {
        if (!aborted) {
          post({ type: "error", message: `${err}` });
        }
      });
    }
    return;
  }

  if (msg.type === "updateQueue") {
    if (!initData || !decoder) {
      return;
    }

    // Replace queue contents. If processQueue is mid-segment, it will
    // finish that segment then pick up these new items on the next iteration.
    currentQueue = [...msg.segmentIndices];

    if (!processing) {
      processQueue().catch((err) => {
        if (!aborted) {
          post({ type: "error", message: `${err}` });
        }
      });
    }
  }
};
