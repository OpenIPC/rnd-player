import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type shaka from "shaka-player";
import type { WorkerRequest, WorkerResponse } from "../types/thumbnailWorker.types";

const THUMBNAIL_WIDTH = 160;
const THROTTLE_MS = 200;

export type RequestRangeFn = (startTime: number, endTime: number, priorityTime: number) => void;

export type SaveFrameFn = (time: number) => Promise<ImageBitmap | null>;

export interface ThumbnailGeneratorResult {
  thumbnails: Map<number, ImageBitmap>;
  segmentTimes: number[];
  supported: boolean;
  requestRange: RequestRangeFn;
  saveFrame: SaveFrameFn;
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

/**
 * Probe a Shaka SegmentReference's init segment sub-object to find the
 * init segment URL. Works with mangled Closure-compiled Shaka builds.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractInitSegmentUrl(firstRef: any): string | null {
  for (const key of Object.keys(firstRef)) {
    const val = firstRef[key];
    if (!val || typeof val !== "object" || Array.isArray(val) || val === firstRef) continue;

    const fnNames = new Set<string>();
    for (const k of Object.keys(val)) {
      if (typeof val[k] === "function") fnNames.add(k);
    }
    let proto = Object.getPrototypeOf(val);
    while (proto && proto !== Object.prototype) {
      for (const m of Object.getOwnPropertyNames(proto)) {
        if (m !== "constructor" && typeof val[m] === "function") fnNames.add(m);
      }
      proto = Object.getPrototypeOf(proto);
    }

    if (fnNames.size === 0) continue;

    for (const fn of fnNames) {
      try {
        const result = val[fn]();
        if (
          Array.isArray(result) &&
          result.length > 0 &&
          typeof result[0] === "string" &&
          (result[0].startsWith("http") || result[0].startsWith("/"))
        ) {
          return result[0];
        }
      } catch {
        // method needs args or threw — skip
      }
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

  const workerRef = useRef<Worker | null>(null);
  const thumbnailsRef = useRef<Map<number, ImageBitmap>>(new Map());
  const segmentsRef = useRef<{ url: string; startTime: number; endTime: number }[]>([]);
  const workerReadyRef = useRef(false);
  const supported = isWebCodecsSupported();

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
    setThumbnails(new Map());
    setSegmentTimes([]);
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

  // saveFrame: sends a one-shot decode request to the worker for the active stream
  const saveFrame = useCallback<SaveFrameFn>(
    async (time: number) => {
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
        } satisfies WorkerRequest);
      });
    },
    [player],
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

        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const msg = e.data;
          switch (msg.type) {
            case "thumbnail": {
              thumbnailsRef.current.set(msg.timestamp, msg.bitmap);

              // Evict bitmaps far from the current visible range
              const { start: visStart, end: visEnd } = visibleRangeRef.current;
              const span = visEnd - visStart;
              if (span > 0) {
                const evictLow = visStart - 3 * span;
                const evictHigh = visEnd + 3 * span;
                for (const [ts, bmp] of thumbnailsRef.current) {
                  if (ts < evictLow || ts > evictHigh) {
                    bmp.close();
                    thumbnailsRef.current.delete(ts);
                  }
                }
              }

              setThumbnails(new Map(thumbnailsRef.current));
              break;
            }
            case "ready":
              workerReadyRef.current = true;
              break;
          }
        };

        const payload = {
          type: "generate" as const,
          initSegmentUrl,
          segments,
          codec,
          width,
          height,
          thumbnailWidth: THUMBNAIL_WIDTH,
          clearKeyHex: streamEncrypted ? clearKey : undefined,
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

  return { thumbnails, segmentTimes, supported, requestRange, saveFrame };
}
