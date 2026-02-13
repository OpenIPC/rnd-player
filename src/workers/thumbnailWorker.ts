import { createFile, DataStream, MP4BoxBuffer, Endianness } from "mp4box";
import type { ISOFile, Sample } from "mp4box";
import type { WorkerRequest, WorkerResponse } from "../types/thumbnailWorker.types";

const DBG = "[FilmstripWorker]";

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
const fulfilled = new Set<number>(); // timestamps we've already sent back
let currentQueue: number[] = [];
let queueVersion = 0;
let processing = false;

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
  } catch (e) {
    console.error(DBG, "failed to serialize description box:", e);
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
 * Initialize: fetch init segment, extract codec description, configure decoder.
 * Does NOT process any media segments.
 */
async function initialize(req: Extract<WorkerRequest, { type: "generate" }>) {
  const { initSegmentUrl, codec, width, height, thumbnailWidth } = req;
  segments = req.segments;

  console.log(DBG, "initialize()", { codec, width, height, totalSegments: segments.length });

  // Reset state
  fulfilled.clear();
  currentQueue = [];
  queueVersion = 0;
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
      if (vt) description = extractDescription(mp4, vt.id);
    };
    mp4.appendBuffer(buf);
    mp4.flush();
    mp4.stop();
  }

  // 2. Configure VideoDecoder
  const config: VideoDecoderConfig = {
    codec,
    codedWidth: width,
    codedHeight: height,
    ...(description ? { description } : {}),
  };

  decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      const targetTime = currentSegStartTime;
      offCtx!.drawImage(frame, 0, 0, offscreen!.width, offscreen!.height);
      frame.close();

      if (!fulfilled.has(targetTime)) {
        fulfilled.add(targetTime);
        createImageBitmap(offscreen!).then((bitmap) => {
          if (aborted) {
            bitmap.close();
            return;
          }
          post({ type: "thumbnail", timestamp: targetTime, bitmap }, [bitmap]);
        });
      }
    },
    error: (e: DOMException) => {
      console.error(DBG, "VideoDecoder error:", e);
      post({ type: "error", message: `VideoDecoder error: ${e.message}` });
    },
  });

  try {
    decoder.configure(config);
    console.log(DBG, "VideoDecoder configured, ready for queue updates");
    post({ type: "ready" });
  } catch (e) {
    post({ type: "error", message: `Failed to configure decoder: ${e}` });
  }
}

/**
 * Process the current queue. Checks queueVersion after each async operation
 * to bail if a newer queue has been submitted.
 */
async function processQueue(version: number) {
  processing = true;

  try {
    while (currentQueue.length > 0) {
      if (aborted || version !== queueVersion) break;

      const segIdx = currentQueue.shift()!;
      if (segIdx < 0 || segIdx >= segments.length) continue;

      const seg = segments[segIdx];
      if (fulfilled.has(seg.startTime)) continue;

      const mediaData = await fetchBuffer(seg.url);
      if (aborted || version !== queueVersion) break;

      const syncSamples = await extractSamplesFromSegment(initData!, mediaData);
      if (aborted || version !== queueVersion) break;

      if (syncSamples.length > 0 && decoder) {
        const sample = syncSamples[0];
        currentSegStartTime = seg.startTime;

        decoder.decode(
          new EncodedVideoChunk({
            type: "key",
            timestamp: (sample.cts / sample.timescale) * 1_000_000,
            data: sample.data!,
          }),
        );

        await decoder.flush();
        if (aborted || version !== queueVersion) break;
      }
    }
  } catch (e) {
    if (!aborted) {
      console.error(DBG, "processQueue error:", e);
      post({ type: "error", message: `${e}` });
    }
  }

  if (version === queueVersion) {
    processing = false;
  } else if (!aborted) {
    // A newer queue was submitted while we were processing — restart with it
    const newVersion = queueVersion;
    processQueue(newVersion).catch((err) => {
      if (!aborted) {
        console.error(DBG, "processQueue uncaught:", err);
        post({ type: "error", message: `${err}` });
      }
    });
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
    return;
  }

  if (msg.type === "generate") {
    aborted = false;
    initialize(msg).catch((err) => {
      console.error(DBG, "uncaught:", err);
      post({ type: "error", message: `${err}` });
    });
    return;
  }

  if (msg.type === "updateQueue") {
    if (!initData || !decoder) {
      // Not yet initialized, ignore
      return;
    }

    currentQueue = [...msg.segmentIndices];
    queueVersion++;
    const version = queueVersion;

    console.log(DBG, `updateQueue v${version}: ${currentQueue.length} segments, priority=${msg.priorityTime.toFixed(1)}`);

    if (!processing) {
      processQueue(version).catch((err) => {
        if (!aborted) {
          console.error(DBG, "processQueue uncaught:", err);
          post({ type: "error", message: `${err}` });
        }
      });
    }
    // If already processing, the version check will cause it to pick up the new queue
  }
};
