import { createFile, DataStream, MP4BoxBuffer, Endianness } from "mp4box";
import type { ISOFile, Sample } from "mp4box";
import type { WorkerRequest, WorkerResponse, FrameType } from "../types/thumbnailWorker.types";
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
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${url}`);
  return resp.arrayBuffer();
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

    // Classify frame types in decode order using max-CTS heuristic:
    // Reference frames (I/P) advance the max CTS; B-frames fall below it.
    const decodeTypes: FrameType[] = [];
    let maxCts = -Infinity;
    for (const s of allSamples) {
      if (s.is_sync) {
        decodeTypes.push("I");
      } else if (s.cts >= maxCts) {
        decodeTypes.push("P");
      } else {
        decodeTypes.push("B");
      }
      if (s.cts > maxCts) maxCts = s.cts;
    }

    // VideoDecoder outputs in display (CTS) order, so map decode→display
    const displayOrder = allSamples
      .map((s, i) => ({ cts: s.cts, type: decodeTypes[i] }))
      .sort((a, b) => a.cts - b.cts);

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
            frameType: displayOrder[currentOutputIdx]?.type ?? "P",
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
    const frameTypes = bitmapPromises.map((p) => p.frameType);

    if (aborted) {
      bitmaps.forEach((b) => b.close());
      return;
    }

    post({ type: "intraFrames", segmentIndex: segIdx, bitmaps, frameTypes }, bitmaps);
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
 * One-shot frame capture at the requested time using the active stream's
 * segments. Reuses module-level cryptoKey/tencInfo for DRM decryption.
 */
async function handleSaveFrame(msg: Extract<WorkerRequest, { type: "saveFrame" }>) {
  try {
    const { time, initSegmentUrl, segments: segs, codec, width, height } = msg;

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

    // 3. Fetch the media segment and extract sync samples
    const mediaData = await fetchBuffer(targetSeg.url);
    const syncSamples = await extractSamplesFromSegment(initBuf, mediaData);
    if (syncSamples.length === 0) {
      post({ type: "saveFrameResult", bitmap: null });
      return;
    }

    // 4. Pick the sync sample closest to the requested time
    let bestSample = syncSamples[0];
    let bestDist = Infinity;
    for (const s of syncSamples) {
      const sampleTime = s.cts / s.timescale;
      const dist = Math.abs(sampleTime - time);
      if (dist < bestDist) {
        bestDist = dist;
        bestSample = s;
      }
    }

    // 5. Decrypt if CENC is configured
    let sampleBytes: Uint8Array = new Uint8Array(bestSample.data!);
    if (cryptoKey && tencInfo) {
      try {
        const ivSize = tencInfo.defaultPerSampleIVSize;
        const sencSamples = parseSencFromSegment(mediaData, ivSize);
        if (sencSamples.length > 0) {
          const sencIdx = bestSample.number_in_traf ?? bestSample.number;
          const sencEntry = sencSamples[sencIdx];
          if (sencEntry) {
            const iv = sencEntry.iv.length > 0 ? sencEntry.iv : tencInfo.defaultConstantIV;
            if (iv && iv.length > 0) {
              sampleBytes = await decryptSample(cryptoKey, iv, sampleBytes, sencEntry.subsamples);
            }
          }
        }
      } catch {
        post({ type: "saveFrameResult", bitmap: null });
        return;
      }
    }

    // 6. One-shot VideoDecoder at full resolution
    const bitmap = await new Promise<ImageBitmap | null>((resolve) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx2d = canvas.getContext("2d")!;

      const dec = new VideoDecoder({
        output: (frame: VideoFrame) => {
          ctx2d.drawImage(frame, 0, 0, width, height);
          frame.close();
          createImageBitmap(canvas).then(resolve).catch(() => resolve(null));
        },
        error: () => resolve(null),
      });

      const config: VideoDecoderConfig = {
        codec,
        codedWidth: width,
        codedHeight: height,
        ...(description ? { description } : {}),
      };

      try {
        dec.configure(config);
        dec.decode(
          new EncodedVideoChunk({
            type: "key",
            timestamp: (bestSample.cts / bestSample.timescale) * 1_000_000,
            data: sampleBytes,
          }),
        );
        dec.flush().then(() => {
          try { dec.close(); } catch { /* */ }
        }).catch(() => resolve(null));
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
