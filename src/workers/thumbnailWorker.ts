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
 * For each target timestamp, find the segment that covers it.
 * Returns deduplicated segment indices sorted by proximity to priorityTime.
 */
function computeNeededSegments(
  targets: number[],
  segments: { startTime: number; endTime: number }[],
  priorityTime: number,
): number[] {
  const needed = new Set<number>();
  for (const t of targets) {
    const idx = segments.findIndex((s) => t >= s.startTime && t < s.endTime);
    if (idx >= 0) needed.add(idx);
  }
  if (targets.length > 0) {
    const last = targets[targets.length - 1];
    const lastSeg = segments[segments.length - 1];
    if (lastSeg && last >= lastSeg.startTime && last <= lastSeg.endTime) {
      needed.add(segments.length - 1);
    }
  }

  return [...needed].sort((a, b) => {
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
    interval,
    duration,
    priorityTime,
  } = req;

  console.log(DBG, "generate()", { codec, width, height, interval, duration, priorityTime, totalSegments: segments.length });

  // Compute target timestamps
  const targets: number[] = [];
  for (let t = 0; t <= duration; t += interval) {
    targets.push(t);
  }
  const total = targets.length;
  let completed = 0;
  const fulfilled = new Set<number>();

  const neededSegmentIndices = computeNeededSegments(targets, segments, priorityTime);
  console.log(DBG, `need ${neededSegmentIndices.length} segments (of ${segments.length}) for ${total} targets`);

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

  const decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      const ts = frame.timestamp / 1_000_000;
      offCtx.drawImage(frame, 0, 0, thumbnailWidth, thumbHeight);
      frame.close();

      let bestTarget = -1;
      let bestDist = Infinity;
      for (const t of targets) {
        if (fulfilled.has(t)) continue;
        const dist = Math.abs(ts - t);
        if (dist < bestDist) {
          bestDist = dist;
          bestTarget = t;
        }
      }

      if (bestTarget >= 0 && bestDist < interval) {
        fulfilled.add(bestTarget);
        createImageBitmap(offscreen).then((bitmap) => {
          if (aborted) {
            bitmap.close();
            return;
          }
          post({ type: "thumbnail", timestamp: bestTarget, bitmap }, [bitmap]);
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

  // 3. Process each needed segment independently
  try {
    for (let i = 0; i < neededSegmentIndices.length; i++) {
      if (aborted) break;
      const segIdx = neededSegmentIndices[i];
      const seg = segments[segIdx];

      const mediaData = await fetchBuffer(seg.url);
      if (aborted) break;

      // Extract sync samples using a fresh mp4box per segment
      const syncSamples = await extractSamplesFromSegment(initData, mediaData);

      // Decode keyframes near unfulfilled targets
      for (const sample of syncSamples) {
        if (aborted) break;
        const sampleTimeSec = sample.cts / sample.timescale;

        let nearTarget = false;
        for (const t of targets) {
          if (fulfilled.has(t)) continue;
          if (Math.abs(sampleTimeSec - t) < interval) {
            nearTarget = true;
            break;
          }
        }
        if (!nearTarget) continue;

        decoder.decode(
          new EncodedVideoChunk({
            type: "key",
            timestamp: sampleTimeSec * 1_000_000,
            data: sample.data!,
          }),
        );
      }

      // Flush decoder after each segment to get thumbnails ASAP
      await decoder.flush();

      if (i < 5 || i === neededSegmentIndices.length - 1) {
        console.log(DBG, `segment ${i + 1}/${neededSegmentIndices.length} (t=${seg.startTime.toFixed(1)}-${seg.endTime.toFixed(1)}) fulfilled=${fulfilled.size}/${total}`);
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
