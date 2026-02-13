import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type shaka from "shaka-player";
import type { WorkerRequest, WorkerResponse } from "../types/thumbnailWorker.types";

const THUMBNAIL_WIDTH = 160;
const DBG = "[FilmstripHook]";
const THROTTLE_MS = 200;

export type RequestRangeFn = (startTime: number, endTime: number, priorityTime: number) => void;

export interface ThumbnailGeneratorResult {
  thumbnails: Map<number, ImageBitmap>;
  segmentTimes: number[];
  supported: boolean;
  encrypted: boolean;
  requestRange: RequestRangeFn;
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

export function useThumbnailGenerator(
  player: shaka.Player | null,
  videoEl: HTMLVideoElement | null,
  enabled: boolean,
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

  const encrypted = useMemo(() => {
    const stream = getLowestVideoStream(player);
    if (!stream) return false;
    return !!(stream.encrypted || (stream.drmInfos && stream.drmInfos.length > 0));
  }, [player]);

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
        priorityTime,
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

  useEffect(() => {
    console.log(DBG, "effect run", { enabled, player: !!player, videoEl: !!videoEl, supported, encrypted });

    if (!enabled || !player || !videoEl || !supported || encrypted) {
      console.log(DBG, "early exit:", { enabled, player: !!player, videoEl: !!videoEl, supported, encrypted });
      return cleanup;
    }

    const stream = getLowestVideoStream(player);
    if (!stream) {
      console.log(DBG, "no video stream found in manifest");
      return;
    }

    const codec = stream.codecs;
    const width = stream.width ?? 0;
    const height = stream.height ?? 0;
    console.log(DBG, "stream info:", { codec, width, height, encrypted: stream.encrypted });

    if (!codec || !width || !height) {
      console.log(DBG, "missing codec/dimensions, abort");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        console.log(DBG, "creating segment index...");
        await stream.createSegmentIndex();
        if (cancelled) return;

        const segmentIndex = stream.segmentIndex;
        if (!segmentIndex) {
          console.log(DBG, "segmentIndex is null after createSegmentIndex()");
          return;
        }

        const iter = segmentIndex[Symbol.iterator]();
        const firstResult = iter.next();
        if (firstResult.done) {
          console.log(DBG, "segment iterator is empty");
          return;
        }
        const firstRef = firstResult.value;
        if (!firstRef) {
          console.log(DBG, "first segment ref is null");
          return;
        }

        // Find the init segment reference on the SegmentReference.
        // In compiled Shaka builds, both property names AND method names are
        // mangled by Closure Compiler. We find the InitSegmentReference by
        // probing every object-typed property, then trying every function
        // (own properties + prototype methods) to find one returning string[].
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refAny = firstRef as any;
        let initSegmentUrl: string | null = null;

        for (const key of Object.keys(refAny)) {
          const val = refAny[key];
          if (!val || typeof val !== "object" || Array.isArray(val) || val === firstRef) continue;

          // Collect ALL callable names: own + prototype chain
          const fnNames = new Set<string>();
          // Own properties that are functions
          for (const k of Object.keys(val)) {
            if (typeof val[k] === "function") fnNames.add(k);
          }
          // Prototype methods
          let proto = Object.getPrototypeOf(val);
          while (proto && proto !== Object.prototype) {
            for (const m of Object.getOwnPropertyNames(proto)) {
              if (m !== "constructor" && typeof val[m] === "function") fnNames.add(m);
            }
            proto = Object.getPrototypeOf(proto);
          }

          if (fnNames.size === 0) continue;
          console.log(DBG, `probing "${key}": ${fnNames.size} callables:`, [...fnNames]);

          for (const fn of fnNames) {
            try {
              const result = val[fn]();
              if (
                Array.isArray(result) &&
                result.length > 0 &&
                typeof result[0] === "string" &&
                (result[0].startsWith("http") || result[0].startsWith("/"))
              ) {
                initSegmentUrl = result[0];
                console.log(DBG, `found init segment URI via "${key}.${fn}()":`, initSegmentUrl);
                break;
              }
            } catch {
              // method needs args or threw — skip
            }
          }
          if (initSegmentUrl) break;
        }

        if (!initSegmentUrl) {
          console.log(DBG, "could not find init segment URL on segment ref");
          return;
        }

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

        console.log(DBG, `collected ${segments.length} media segments`);
        if (segments.length > 0) {
          console.log(DBG, "first segment:", segments[0]);
          console.log(DBG, "last segment:", segments[segments.length - 1]);
        }

        if (cancelled || segments.length === 0) return;

        segmentsRef.current = segments;
        setSegmentTimes(segments.map((s) => s.startTime));

        const duration = videoEl.duration || 0;
        console.log(DBG, "video duration:", duration);
        if (duration <= 0) {
          console.log(DBG, "duration <= 0, abort");
          return;
        }

        console.log(DBG, "spawning worker...");
        const worker = new Worker(
          new URL("../workers/thumbnailWorker.ts", import.meta.url),
          { type: "module" },
        );
        workerRef.current = worker;

        worker.onerror = (ev) => {
          console.error(DBG, "worker onerror:", ev.message, ev);
        };

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
            case "error":
              console.warn(DBG, "worker error:", msg.message);
              break;
            case "ready":
              console.log(DBG, "worker ready for queue updates");
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
        };
        console.log(DBG, "posting to worker:", { ...payload, segments: `[${segments.length} items]` });
        worker.postMessage(payload satisfies WorkerRequest);
      } catch (e) {
        console.error(DBG, "Failed to start thumbnail generation:", e);
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [player, videoEl, enabled, supported, encrypted, cleanup]);

  return { thumbnails, segmentTimes, supported, encrypted, requestRange };
}
