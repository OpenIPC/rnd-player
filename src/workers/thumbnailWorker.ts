import { createFile, DataStream, MP4BoxBuffer, Endianness } from "mp4box";
import type { ISOFile, Sample } from "mp4box";
import type { WorkerRequest, WorkerResponse } from "../types/thumbnailWorker.types";

const DBG = "[FilmstripWorker]";

function post(msg: WorkerResponse, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer: transfer ?? [] });
}

let aborted = false;

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
 * Returns all segment indices sorted by proximity to priorityTime.
 */
function sortSegmentsByPriority(
  segments: { startTime: number; endTime: number }[],
  priorityTime: number,
): number[] {
  return segments
    .map((_, i) => i)
    .sort((a, b) => {
      const aMid = (segments[a].startTime + segments[a].endTime) / 2;
      const bMid = (segments[b].startTime + segments[b].endTime) / 2;
      return Math.abs(aMid - priorityTime) - Math.abs(bMid - priorityTime);
    });
}

/**
 * Process a single media segment: create a fresh mp4box instance, feed the
 * cached init segment + the media segment, and return extracted sync samples.
 */
function extractSamplesFromSegment(
  initData: ArrayBuffer,
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
      // Feed init segment at offset 0
      const initBuf = MP4BoxBuffer.fromArrayBuffer(initData.slice(0), 0);
      const offset1 = mp4.appendBuffer(initBuf);

      // Feed media segment right after
      const mediaBuf = MP4BoxBuffer.fromArrayBuffer(mediaData.slice(0), offset1);
      mp4.appendBuffer(mediaBuf);
      mp4.flush();
      mp4.stop();

      // onSamples is synchronous during appendBuffer/flush, so samples are ready
      resolve(syncSamples);
    } catch (e) {
      reject(e);
    }
  });
}

async function generate(req: Extract<WorkerRequest, { type: "generate" }>) {
  const {
    initSegmentUrl,
    segments,
    codec,
    width,
    height,
    thumbnailWidth,
    duration,
    priorityTime,
  } = req;

  console.log(DBG, "generate()", { codec, width, height, duration, priorityTime, totalSegments: segments.length });

  // One thumbnail per segment, keyed by segment startTime
  const total = segments.length;
  let completed = 0;
  const fulfilled = new Set<number>();

  const orderedIndices = sortSegmentsByPriority(segments, priorityTime);
  console.log(DBG, `processing ${total} segments (priority-sorted)`);

  // Set up thumbnail rendering
  const thumbHeight = Math.round((thumbnailWidth / width) * height);
  const offscreen = new OffscreenCanvas(thumbnailWidth, thumbHeight);
  const offCtx = offscreen.getContext("2d")!;

  // 1. Fetch init segment and extract codec description
  const initData = await fetchBuffer(initSegmentUrl);
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

  // Track which segment's first keyframe we're currently decoding
  let currentSegStartTime = 0;

  const decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      const targetTime = currentSegStartTime;
      offCtx.drawImage(frame, 0, 0, thumbnailWidth, thumbHeight);
      frame.close();

      if (!fulfilled.has(targetTime)) {
        fulfilled.add(targetTime);
        createImageBitmap(offscreen).then((bitmap) => {
          if (aborted) {
            bitmap.close();
            return;
          }
          post({ type: "thumbnail", timestamp: targetTime, bitmap }, [bitmap]);
          completed++;
          post({ type: "progress", completed, total });
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
    console.log(DBG, "VideoDecoder configured");
  } catch (e) {
    post({ type: "error", message: `Failed to configure decoder: ${e}` });
    return;
  }

  // 3. Process each segment — decode only the first keyframe
  try {
    for (let i = 0; i < orderedIndices.length; i++) {
      if (aborted) break;
      const segIdx = orderedIndices[i];
      const seg = segments[segIdx];

      if (fulfilled.has(seg.startTime)) continue;

      const mediaData = await fetchBuffer(seg.url);
      if (aborted) break;

      // Extract sync samples using a fresh mp4box per segment
      const syncSamples = await extractSamplesFromSegment(initData, mediaData);

      // Decode only the first keyframe (segment boundary I-frame)
      if (syncSamples.length > 0) {
        const sample = syncSamples[0];
        currentSegStartTime = seg.startTime;

        decoder.decode(
          new EncodedVideoChunk({
            type: "key",
            timestamp: sample.cts / sample.timescale * 1_000_000,
            data: sample.data!,
          }),
        );

        // Flush to get the thumbnail immediately
        await decoder.flush();
      }

      if (i < 5 || i === orderedIndices.length - 1) {
        console.log(DBG, `segment ${i + 1}/${orderedIndices.length} (t=${seg.startTime.toFixed(1)}-${seg.endTime.toFixed(1)}) fulfilled=${fulfilled.size}/${total}`);
      }
    }
  } catch (e) {
    if (!aborted) {
      console.error(DBG, "error:", e);
      post({ type: "error", message: `${e}` });
    }
  } finally {
    try { decoder.close(); } catch { /* */ }
  }

  if (!aborted) {
    console.log(DBG, `DONE. ${fulfilled.size}/${total} thumbnails`);
    post({ type: "done" });
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "abort") {
    aborted = true;
    return;
  }
  if (msg.type === "generate") {
    aborted = false;
    generate(msg).catch((err) => {
      console.error(DBG, "uncaught:", err);
      post({ type: "error", message: `${err}` });
    });
  }
};
