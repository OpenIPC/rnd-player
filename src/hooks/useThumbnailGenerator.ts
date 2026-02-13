import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type shaka from "shaka-player";
import type { WorkerRequest, WorkerResponse } from "../types/thumbnailWorker.types";

const THUMBNAIL_WIDTH = 160;
const DBG = "[FilmstripHook]";

export interface ThumbnailGeneratorResult {
  thumbnails: Map<number, ImageBitmap>;
  segmentTimes: number[];
  progress: { completed: number; total: number };
  supported: boolean;
  encrypted: boolean;
  generating: boolean;
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
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [generating, setGenerating] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const thumbnailsRef = useRef<Map<number, ImageBitmap>>(new Map());
  const supported = isWebCodecsSupported();

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
    for (const bmp of thumbnailsRef.current.values()) {
      bmp.close();
    }
    thumbnailsRef.current = new Map();
    setThumbnails(new Map());
    setSegmentTimes([]);
    setProgress({ completed: 0, total: 0 });
    setGenerating(false);
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
        setGenerating(true);

        worker.onerror = (ev) => {
          console.error(DBG, "worker onerror:", ev.message, ev);
        };

        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const msg = e.data;
          switch (msg.type) {
            case "thumbnail": {
              console.log(DBG, "received thumbnail for t=", msg.timestamp);
              thumbnailsRef.current.set(msg.timestamp, msg.bitmap);
              setThumbnails(new Map(thumbnailsRef.current));
              break;
            }
            case "progress":
              console.log(DBG, `progress: ${msg.completed}/${msg.total}`);
              setProgress({ completed: msg.completed, total: msg.total });
              break;
            case "error":
              console.warn(DBG, "worker error:", msg.message);
              break;
            case "done":
              console.log(DBG, "worker done");
              setGenerating(false);
              break;
          }
        };

        const priorityTime = videoEl.currentTime || 0;
        const payload = {
          type: "generate" as const,
          initSegmentUrl,
          segments,
          codec,
          width,
          height,
          thumbnailWidth: THUMBNAIL_WIDTH,
          duration,
          priorityTime,
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

  return { thumbnails, segmentTimes, progress, supported, encrypted, generating };
}
