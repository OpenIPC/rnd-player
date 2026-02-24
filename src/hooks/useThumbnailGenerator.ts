import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type shaka from "shaka-player";
import type { WorkerRequest, WorkerResponse, FrameType, GopFrame } from "../types/thumbnailWorker.types";
import { extractInitSegmentUrl } from "../utils/extractInitSegmentUrl";

const CORS_PROXY_URL: string =
  (typeof __CORS_PROXY_URL__ !== "undefined" && __CORS_PROXY_URL__) ||
  import.meta.env.VITE_CORS_PROXY_URL || "";
const CORS_PROXY_HMAC_KEY: string =
  (typeof __CORS_PROXY_HMAC_KEY__ !== "undefined" && __CORS_PROXY_HMAC_KEY__) ||
  import.meta.env.VITE_CORS_PROXY_HMAC_KEY || "";

const THUMBNAIL_WIDTH = 160;
const THROTTLE_MS = 200;

export type RequestRangeFn = (startTime: number, endTime: number, priorityTime: number) => void;

export type SaveFrameFn = (time: number, framePosition?: number) => Promise<ImageBitmap | null>;

export interface SegmentFrame {
  frameIndex: number;
  totalFrames: number;
  bitmap: ImageBitmap;
  frameType: FrameType;
  sizeBytes: number;
}

export type DecodeSegmentFramesFn = (
  time: number,
  onFrame: (frame: SegmentFrame) => void,
  onDone: (totalFrames: number) => void,
) => string | null;

export type CancelDecodeSegmentFn = (requestId: string) => void;

export type RequestIntraBatchFn = (
  items: { segmentIndex: number; count: number }[],
  priorityTime: number,
) => void;

export interface BoundaryPreview {
  before: ImageBitmap | null;
  after: ImageBitmap | null;
}

export type RequestBoundaryPreviewFn = (boundaryTime: number, frameNumber: number) => void;

export interface ThumbnailGeneratorResult {
  thumbnails: Map<number, ImageBitmap>;
  segmentTimes: number[];
  supported: boolean;
  requestRange: RequestRangeFn;
  saveFrame: SaveFrameFn;
  intraFrames: Map<number, ImageBitmap[]>;
  intraFrameTypes: Map<number, FrameType[]>;
  /** Exact CTS timestamps (seconds) for each intra-frame bitmap */
  intraTimestamps: Map<number, number[]>;
  gopStructures: Map<number, GopFrame[]>;
  requestGop: (segmentIndex: number) => void;
  requestIntraBatch: RequestIntraBatchFn;
  decodeSegmentFrames: DecodeSegmentFramesFn;
  cancelDecodeSegment: CancelDecodeSegmentFn;
  boundaryPreviews: Map<number, BoundaryPreview>;
  requestBoundaryPreview: RequestBoundaryPreviewFn;
  clearBoundaryPreviews: () => void;
}

function isWebCodecsSupported(): boolean {
  return typeof VideoDecoder !== "undefined";
}

function getLowestVideoStream(player: shaka.Player | null) {
  if (!player) return null;
  const manifest = player.getManifest();
  if (!manifest?.variants?.length) return null;
  const variants = [...manifest.variants].sort((a, b) => {
    const aH = a.video?.height ?? 0;
    const bH = b.video?.height ?? 0;
    return aH - bH;
  });
  return variants[0]?.video ?? null;
}

function getActiveVideoStream(player: shaka.Player | null) {
  if (!player) return null;
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

export function useThumbnailGenerator(
  player: shaka.Player | null,
  videoEl: HTMLVideoElement | null,
  enabled: boolean,
  clearKey?: string,
): ThumbnailGeneratorResult {
  const [thumbnails, setThumbnails] = useState<Map<number, ImageBitmap>>(new Map());
  const [segmentTimes, setSegmentTimes] = useState<number[]>([]);
  const [intraFrames, setIntraFrames] = useState<Map<number, ImageBitmap[]>>(new Map());
  const [intraFrameTypes, setIntraFrameTypes] = useState<Map<number, FrameType[]>>(new Map());
  const [intraTimestamps, setIntraTimestamps] = useState<Map<number, number[]>>(new Map());
  const [gopStructures, setGopStructures] = useState<Map<number, GopFrame[]>>(new Map());
  const [boundaryPreviews, setBoundaryPreviews] = useState<Map<number, BoundaryPreview>>(new Map());

  const workerRef = useRef<Worker | null>(null);
  const thumbnailsRef = useRef<Map<number, ImageBitmap>>(new Map());
  const segmentsRef = useRef<{ url: string; startTime: number; endTime: number }[]>([]);
  const workerReadyRef = useRef(false);
  const supported = isWebCodecsSupported();
  const intraFramesRef = useRef<Map<number, ImageBitmap[]>>(new Map());
  const intraFrameTypesRef = useRef<Map<number, FrameType[]>>(new Map());
  const intraTimestampsRef = useRef<Map<number, number[]>>(new Map());
  const gopStructuresRef = useRef<Map<number, GopFrame[]>>(new Map());
  const lastSentIntraRef = useRef<string>("");
  const decodeCallbacksRef = useRef<Map<string, { onFrame: (frame: SegmentFrame) => void; onDone: (totalFrames: number) => void }>>(new Map());
  const boundaryPreviewsRef = useRef<Map<number, BoundaryPreview>>(new Map());
  const pendingBoundaryRef = useRef<Set<number>>(new Set());

  // Track visible range for eviction
  const visibleRangeRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  // Track last sent indices to avoid redundant updateQueue messages
  const lastSentIndicesRef = useRef<string>("");
  // Throttle state
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSendTimeRef = useRef(0);

  const streamEncrypted = useMemo(() => {
    const stream = getLowestVideoStream(player);
    if (!stream) return false;
    return !!(stream.encrypted || (stream.drmInfos && stream.drmInfos.length > 0));
  }, [player]);

  // Only show "encrypted" fallback when encrypted AND we can't self-decrypt
  const encrypted = useMemo(() => {
    return streamEncrypted && !clearKey;
  }, [streamEncrypted, clearKey]);

  const cleanup = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "abort" } satisfies WorkerRequest);
      workerRef.current.terminate();
      workerRef.current = null;
    }
    workerReadyRef.current = false;
    for (const bmp of thumbnailsRef.current.values()) {
      bmp.close();
    }
    thumbnailsRef.current = new Map();
    segmentsRef.current = [];
    lastSentIndicesRef.current = "";
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
    for (const arr of intraFramesRef.current.values()) {
      arr.forEach((b) => b.close());
    }
    intraFramesRef.current = new Map();
    intraFrameTypesRef.current = new Map();
    intraTimestampsRef.current = new Map();
    gopStructuresRef.current = new Map();
    lastSentIntraRef.current = "";
    for (const bp of boundaryPreviewsRef.current.values()) {
      if (bp.before) bp.before.close();
      if (bp.after) bp.after.close();
    }
    boundaryPreviewsRef.current = new Map();
    pendingBoundaryRef.current = new Set();
    setThumbnails(new Map());
    setSegmentTimes([]);
    setIntraFrames(new Map());
    setIntraFrameTypes(new Map());
    setGopStructures(new Map());
    setBoundaryPreviews(new Map());
  }, []);

  // requestRange: called from paint loop, throttled to avoid flooding worker
  const requestRange = useCallback<RequestRangeFn>((startTime, endTime, priorityTime) => {
    visibleRangeRef.current = { start: startTime, end: endTime };

    const sendUpdate = () => {
      lastSendTimeRef.current = Date.now();
      const worker = workerRef.current;
      const segs = segmentsRef.current;
      if (!worker || !workerReadyRef.current || segs.length === 0) return;

      // Find segment indices overlapping the requested range
      const { start: rangeStart, end: rangeEnd } = visibleRangeRef.current;
      const indices: number[] = [];
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (seg.endTime >= rangeStart && seg.startTime <= rangeEnd) {
          // Skip already-loaded thumbnails
          if (!thumbnailsRef.current.has(seg.startTime)) {
            indices.push(i);
          }
        }
      }

      if (indices.length === 0) return;

      // Sort by proximity to priorityTime
      indices.sort((a, b) => {
        const aMid = (segs[a].startTime + segs[a].endTime) / 2;
        const bMid = (segs[b].startTime + segs[b].endTime) / 2;
        return Math.abs(aMid - priorityTime) - Math.abs(bMid - priorityTime);
      });

      // Skip if same set of indices as last request
      const key = indices.join(",");
      if (key === lastSentIndicesRef.current) return;
      lastSentIndicesRef.current = key;

      worker.postMessage({
        type: "updateQueue",
        segmentIndices: indices,
      } satisfies WorkerRequest);
    };

    // Throttle: fire immediately if enough time has passed, otherwise schedule trailing edge
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }

    const elapsed = Date.now() - lastSendTimeRef.current;
    if (elapsed >= THROTTLE_MS) {
      sendUpdate();
    } else {
      throttleTimerRef.current = setTimeout(sendUpdate, THROTTLE_MS - elapsed);
    }
  }, []);

  // requestIntraBatch: send a prioritized batch of intra-frame requests to the worker
  const requestIntraBatch = useCallback<RequestIntraBatchFn>((items, priorityTime) => {
    const worker = workerRef.current;
    const segs = segmentsRef.current;
    if (!worker || !workerReadyRef.current || segs.length === 0) return;

    // Filter out segments that already have enough intra-frames
    const needed = items.filter((item) => {
      const existing = intraFramesRef.current.get(item.segmentIndex);
      return !existing || existing.length < item.count;
    });

    if (needed.length === 0) return;

    // Sort by proximity to priorityTime (closest first)
    needed.sort((a, b) => {
      const aMid = (segs[a.segmentIndex].startTime + segs[a.segmentIndex].endTime) / 2;
      const bMid = (segs[b.segmentIndex].startTime + segs[b.segmentIndex].endTime) / 2;
      return Math.abs(aMid - priorityTime) - Math.abs(bMid - priorityTime);
    });

    // Fingerprint to avoid redundant sends
    const key = needed.map((n) => `${n.segmentIndex}:${n.count}`).join(",");
    if (key === lastSentIntraRef.current) return;
    lastSentIntraRef.current = key;

    worker.postMessage({
      type: "updateIntraQueue",
      items: needed,
    } satisfies WorkerRequest);
  }, []);

  // requestGop: ask the worker to classify frame types for a segment (no decode)
  const requestGop = useCallback((segmentIndex: number) => {
    const worker = workerRef.current;
    if (!worker || !workerReadyRef.current) return;
    // Already have it cached
    if (gopStructuresRef.current.has(segmentIndex)) return;
    worker.postMessage({ type: "requestGop", segmentIndex } satisfies WorkerRequest);
  }, []);

  // requestBoundaryPreview: decode frames on either side of a scene boundary
  const requestBoundaryPreview = useCallback<RequestBoundaryPreviewFn>((boundaryTime: number, frameNumber: number) => {
    const worker = workerRef.current;
    if (!worker || !workerReadyRef.current) return;
    // Already cached or in-flight
    if (boundaryPreviewsRef.current.has(boundaryTime)) return;
    if (pendingBoundaryRef.current.has(boundaryTime)) return;
    pendingBoundaryRef.current.add(boundaryTime);
    worker.postMessage({ type: "boundaryPreview", boundaryTime, frameNumber } satisfies WorkerRequest);
  }, []);

  // clearBoundaryPreviews: invalidate cache when scene data changes (FPS correction)
  const clearBoundaryPreviews = useCallback(() => {
    for (const bp of boundaryPreviewsRef.current.values()) {
      if (bp.before) bp.before.close();
      if (bp.after) bp.after.close();
    }
    boundaryPreviewsRef.current = new Map();
    pendingBoundaryRef.current = new Set();
    setBoundaryPreviews(new Map());
  }, []);

  // saveFrame: sends a one-shot decode request to the worker for the active stream
  const saveFrame = useCallback<SaveFrameFn>(
    async (time: number, framePosition?: number) => {
      const worker = workerRef.current;
      if (!worker || !player) return null;

      const stream = getActiveVideoStream(player);
      if (!stream) return null;

      const codec = stream.codecs;
      const width = stream.width ?? 0;
      const height = stream.height ?? 0;
      if (!codec || !width || !height) return null;

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

      const segs: { url: string; startTime: number; endTime: number }[] = [];
      for (const ref of segmentIndex) {
        if (!ref) continue;
        const uris = ref.getUris();
        if (uris.length === 0) continue;
        segs.push({
          url: uris[0],
          startTime: ref.getStartTime(),
          endTime: ref.getEndTime(),
        });
      }
      if (segs.length === 0) return null;

      return new Promise<ImageBitmap | null>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(null);
        }, 15_000);

        const prev = worker.onmessage;
        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const msg = e.data;
          if (msg.type === "saveFrameResult") {
            clearTimeout(timeout);
            worker.onmessage = prev;
            resolve(msg.bitmap);
          } else if (prev) {
            prev.call(worker, e);
          }
        };

        worker.postMessage({
          type: "saveFrame",
          time,
          initSegmentUrl,
          segments: segs,
          codec,
          width,
          height,
          framePosition,
        } satisfies WorkerRequest);
      });
    },
    [player],
  );

  const decodeSegmentFrames = useCallback<DecodeSegmentFramesFn>(
    (time, onFrame, onDone) => {
      const worker = workerRef.current;
      if (!worker || !player) return null;

      const stream = getActiveVideoStream(player);
      if (!stream) return null;

      const codec = stream.codecs;
      const width = stream.width ?? 0;
      const height = stream.height ?? 0;
      if (!codec || !width || !height) return null;

      const segmentIndex = stream.segmentIndex;
      if (!segmentIndex) return null;

      const iter = segmentIndex[Symbol.iterator]();
      const firstResult = iter.next();
      if (firstResult.done) return null;
      const firstRef = firstResult.value;
      if (!firstRef) return null;

      const initSegmentUrl = extractInitSegmentUrl(firstRef);
      if (!initSegmentUrl) return null;

      const segs: { url: string; startTime: number; endTime: number }[] = [];
      for (const ref of segmentIndex) {
        if (!ref) continue;
        const uris = ref.getUris();
        if (uris.length === 0) continue;
        segs.push({
          url: uris[0],
          startTime: ref.getStartTime(),
          endTime: ref.getEndTime(),
        });
      }
      if (segs.length === 0) return null;

      const requestId = crypto.randomUUID();
      decodeCallbacksRef.current.set(requestId, { onFrame, onDone });

      worker.postMessage({
        type: "decodeSegmentFrames",
        requestId,
        time,
        initSegmentUrl,
        segments: segs,
        codec,
        width,
        height,
      } satisfies WorkerRequest);

      return requestId;
    },
    [player],
  );

  const cancelDecodeSegment = useCallback<CancelDecodeSegmentFn>(
    (requestId) => {
      const worker = workerRef.current;
      if (worker) {
        worker.postMessage({ type: "cancelDecodeSegment", requestId } satisfies WorkerRequest);
      }
      decodeCallbacksRef.current.delete(requestId);
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !player || !videoEl || !supported || encrypted) {
      return cleanup;
    }

    const stream = getLowestVideoStream(player);
    if (!stream) return;

    const codec = stream.codecs;
    const width = stream.width ?? 0;
    const height = stream.height ?? 0;

    if (!codec || !width || !height) return;

    let cancelled = false;

    (async () => {
      try {
        await stream.createSegmentIndex();
        if (cancelled) return;

        const segmentIndex = stream.segmentIndex;
        if (!segmentIndex) return;

        const iter = segmentIndex[Symbol.iterator]();
        const firstResult = iter.next();
        if (firstResult.done) return;
        const firstRef = firstResult.value;
        if (!firstRef) return;

        const initSegmentUrl = extractInitSegmentUrl(firstRef);
        if (!initSegmentUrl) return;

        const segments: { url: string; startTime: number; endTime: number }[] = [];
        for (const ref of segmentIndex) {
          if (!ref) continue;
          const uris = ref.getUris();
          if (uris.length === 0) continue;
          segments.push({
            url: uris[0],
            startTime: ref.getStartTime(),
            endTime: ref.getEndTime(),
          });
        }

        if (cancelled || segments.length === 0) return;

        segmentsRef.current = segments;
        setSegmentTimes(segments.map((s) => s.startTime));

        const duration = videoEl.duration || 0;
        if (duration <= 0) return;

        const worker = new Worker(
          new URL("../workers/thumbnailWorker.ts", import.meta.url),
          { type: "module" },
        );
        workerRef.current = worker;

        // Evict bitmaps far from the current visible range.
        // Returns true if any intra-frame bitmaps were evicted.
        const evictOutOfRange = (): boolean => {
          const { start: visStart, end: visEnd } = visibleRangeRef.current;
          const span = visEnd - visStart;
          if (span <= 0) return false;

          const evictLow = visStart - 3 * span;
          const evictHigh = visEnd + 3 * span;

          for (const [ts, bmp] of thumbnailsRef.current) {
            if (ts < evictLow || ts > evictHigh) {
              bmp.close();
              thumbnailsRef.current.delete(ts);
            }
          }

          const segs = segmentsRef.current;
          let intraEvicted = false;
          for (const [segIdx, arr] of intraFramesRef.current) {
            const seg = segs[segIdx];
            if (seg && (seg.endTime < evictLow || seg.startTime > evictHigh)) {
              arr.forEach((b) => b.close());
              intraFramesRef.current.delete(segIdx);
              intraFrameTypesRef.current.delete(segIdx);
              intraTimestampsRef.current.delete(segIdx);
              gopStructuresRef.current.delete(segIdx);
              intraEvicted = true;
            }
          }
          return intraEvicted;
        };

        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const msg = e.data;
          switch (msg.type) {
            case "thumbnail": {
              thumbnailsRef.current.set(msg.timestamp, msg.bitmap);
              const intraEvicted = evictOutOfRange();
              setThumbnails(new Map(thumbnailsRef.current));
              if (intraEvicted) {
                setIntraFrames(new Map(intraFramesRef.current));
              }
              break;
            }
            case "intraFrames": {
              // Close old bitmaps if replacing
              const old = intraFramesRef.current.get(msg.segmentIndex);
              if (old) old.forEach((b) => b.close());
              intraFramesRef.current.set(msg.segmentIndex, msg.bitmaps);
              intraFrameTypesRef.current.set(msg.segmentIndex, msg.frameTypes);
              intraTimestampsRef.current.set(msg.segmentIndex, msg.timestamps);
              if (msg.gopStructure.length > 0) {
                gopStructuresRef.current.set(msg.segmentIndex, msg.gopStructure);
              }
              evictOutOfRange();
              setIntraFrames(new Map(intraFramesRef.current));
              setIntraFrameTypes(new Map(intraFrameTypesRef.current));
              setIntraTimestamps(new Map(intraTimestampsRef.current));
              setGopStructures(new Map(gopStructuresRef.current));
              break;
            }
            case "gopStructure": {
              gopStructuresRef.current.set(msg.segmentIndex, msg.gopStructure);
              setGopStructures(new Map(gopStructuresRef.current));
              break;
            }
            case "segmentFrame": {
              const cb = decodeCallbacksRef.current.get(msg.requestId);
              if (cb) {
                cb.onFrame({
                  frameIndex: msg.frameIndex,
                  totalFrames: msg.totalFrames,
                  bitmap: msg.bitmap,
                  frameType: msg.frameType,
                  sizeBytes: msg.sizeBytes,
                });
              }
              break;
            }
            case "segmentFramesDone": {
              const cb = decodeCallbacksRef.current.get(msg.requestId);
              if (cb) {
                cb.onDone(msg.totalFrames);
                decodeCallbacksRef.current.delete(msg.requestId);
              }
              break;
            }
            case "boundaryPreview": {
              pendingBoundaryRef.current.delete(msg.boundaryTime);
              boundaryPreviewsRef.current.set(msg.boundaryTime, {
                before: msg.beforeBitmap,
                after: msg.afterBitmap,
              });
              setBoundaryPreviews(new Map(boundaryPreviewsRef.current));
              break;
            }
            case "ready":
              workerReadyRef.current = true;
              break;
          }
        };

        // Extract active (watched) stream segment info for frame type classification.
        // The active stream may have a different GOP structure than the lowest-quality
        // thumbnail stream (e.g. 1080p uses B-frames while 240p does not).
        let activeInitSegmentUrl: string | undefined;
        let activeStreamSegments: typeof segments | undefined;
        const activeStream = getActiveVideoStream(player);
        if (activeStream && activeStream !== stream) {
          try {
            await activeStream.createSegmentIndex();
            if (cancelled) return;
            const activeSegIdx = activeStream.segmentIndex;
            if (activeSegIdx) {
              const activeIter = activeSegIdx[Symbol.iterator]();
              const activeFirst = activeIter.next();
              if (!activeFirst.done && activeFirst.value) {
                activeInitSegmentUrl = extractInitSegmentUrl(activeFirst.value) ?? undefined;
                activeStreamSegments = [];
                for (const ref of activeSegIdx) {
                  if (!ref) continue;
                  const uris = ref.getUris();
                  if (uris.length === 0) continue;
                  activeStreamSegments.push({
                    url: uris[0],
                    startTime: ref.getStartTime(),
                    endTime: ref.getEndTime(),
                  });
                }
              }
            }
          } catch {
            // Non-critical: will fall back to thumbnail stream for classification
          }
        }

        const payload = {
          type: "generate" as const,
          initSegmentUrl,
          segments,
          codec,
          width,
          height,
          thumbnailWidth: THUMBNAIL_WIDTH,
          clearKeyHex: streamEncrypted ? clearKey : undefined,
          activeInitSegmentUrl,
          activeSegments: activeStreamSegments,
          corsProxyUrl: CORS_PROXY_URL || undefined,
          corsProxyHmacKey: CORS_PROXY_HMAC_KEY || undefined,
        };
        worker.postMessage(payload satisfies WorkerRequest);
      } catch {
        // Thumbnail generation is best-effort; failures are silent
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [player, videoEl, enabled, supported, encrypted, clearKey, streamEncrypted, cleanup]);

  return { thumbnails, segmentTimes, supported, requestRange, saveFrame, intraFrames, intraFrameTypes, intraTimestamps, gopStructures, requestGop, requestIntraBatch, decodeSegmentFrames, cancelDecodeSegment, boundaryPreviews, requestBoundaryPreview, clearBoundaryPreviews };
}
