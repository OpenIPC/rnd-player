import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import shaka from "shaka-player";
import { extractInitSegmentUrl } from "../utils/extractInitSegmentUrl";
import type { QpMapWorkerRequest, QpMapWorkerResponse, QpMapSegmentResult } from "../types/qpMapWorker.types";

export interface QpHeatmapData {
  qpValues: Uint8Array;
  widthMbs: number;
  heightMbs: number;
  minQp: number;
  maxQp: number;
}

interface UseQpHeatmapResult {
  /** Whether the active codec is H.264 (for showing/hiding the menu item). */
  isH264: boolean;
  /** Whether the active codec is H.265/HEVC (for showing/hiding the menu item). */
  isH265: boolean;
  /** Whether the active codec is AV1 (for showing/hiding the menu item). */
  isAv1: boolean;
  /** Whether the current codec supports QP extraction (H.264, H.265, or AV1). */
  available: boolean;
  /** Whether a QP decode is in progress. */
  loading: boolean;
  /** QP map data for the current paused frame, or null. */
  data: QpHeatmapData | null;
}

/** Cached segment QP result keyed by media segment URL. */
interface SegmentQpCache {
  mediaUrl: string;
  segmentStart: number;
  segmentEnd: number;
  result: QpMapSegmentResult;
}

export function useQpHeatmap(
  player: shaka.Player,
  videoEl: HTMLVideoElement,
  enabled: boolean,
  paused: boolean,
  clearKey?: string,
): UseQpHeatmapResult {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<QpHeatmapData | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const prevPausedRef = useRef(paused);
  const cacheRef = useRef<SegmentQpCache | null>(null);
  /** URL of the segment currently being decoded by the worker (in-flight guard). */
  const pendingUrlRef = useRef<string | null>(null);

  // Derive codec availability from player state (no effect needed)
  const codecInfo = useMemo(() => {
    const tracks = player.getVariantTracks();
    const active = tracks.find((t) => t.active);
    const codec = active?.videoCodec ?? "";
    return {
      isH264: codec.startsWith("avc1"),
      isH265: codec.startsWith("hvc1") || codec.startsWith("hev1"),
      isAv1: codec.startsWith("av01"),
    };
    // Re-check when paused changes (track may have switched via ABR)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, paused]);

  const { isH264, isH265, isAv1 } = codecInfo;
  const available = enabled && (isH264 || isH265 || isAv1);

  // Clear data and cache when playback resumes (transition from paused→playing)
  if (prevPausedRef.current && !paused) {
    setData(null);
    cacheRef.current = null;
  }
  prevPausedRef.current = paused;

  // Spawn / destroy worker
  useEffect(() => {
    if (!enabled) {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      cacheRef.current = null;
      pendingUrlRef.current = null;
      return;
    }
    if (!workerRef.current) {
      const w = new Worker(
        new URL("../workers/qpMapWorker.ts", import.meta.url),
        { type: "module" },
      );
      w.onerror = (e) => {
        console.warn("[QP heatmap] worker error:", e.message ?? e);
      };
      workerRef.current = w;
    }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      cacheRef.current = null;
      pendingUrlRef.current = null;
    };
  }, [enabled]);

  /**
   * Select the per-frame QP data from a cached segment result based on currentTime.
   * Maps time position within the segment to a frame index.
   */
  const selectFrameFromCache = useCallback((cache: SegmentQpCache, currentTime: number) => {
    const { result, segmentStart, segmentEnd } = cache;
    const frameCount = result.frames.length;
    if (frameCount === 0) return;

    const segDuration = segmentEnd - segmentStart;
    const timeInSegment = Math.max(0, currentTime - segmentStart);
    const frameIndex = Math.min(
      frameCount - 1,
      Math.max(0, Math.floor((timeInSegment / segDuration) * frameCount)),
    );

    const frame = result.frames[frameIndex];
    setData({
      qpValues: frame.qpValues,
      widthMbs: result.widthMbs,
      heightMbs: result.heightMbs,
      minQp: result.globalMinQp,
      maxQp: result.globalMaxQp,
    });
  }, []);

  const requestQpMap = useCallback(async () => {
    if (!enabled || !paused || !available) return;
    const worker = workerRef.current;
    if (!worker) return;

    const manifest = player.getManifest();
    if (!manifest?.variants?.length) return;

    // Find active video stream
    const tracks = player.getVariantTracks();
    const active = tracks.find((t) => t.active);
    if (!active) return;

    let videoStream: shaka.extern.Stream | null = null;
    for (const v of manifest.variants) {
      if (v.video && v.video.height === active.height && v.video.width === active.width) {
        videoStream = v.video;
        break;
      }
    }
    if (!videoStream) return;

    await videoStream.createSegmentIndex();
    const segmentIndex = videoStream.segmentIndex;
    if (!segmentIndex) return;

    // Find the segment containing the current time
    const currentTime = videoEl.currentTime;
    let targetRef: shaka.media.SegmentReference | null = null;
    const iter = segmentIndex[Symbol.iterator]();
    const firstResult = iter.next();
    if (firstResult.done) return;
    const firstRef = firstResult.value;
    if (!firstRef) return;

    const initSegmentUrl = extractInitSegmentUrl(firstRef);
    if (!initSegmentUrl) return;

    for (const ref of segmentIndex) {
      if (!ref) continue;
      if (ref.getStartTime() <= currentTime && ref.getEndTime() > currentTime) {
        targetRef = ref;
        break;
      }
    }
    // If exact match failed, use last segment before currentTime
    if (!targetRef) {
      for (const ref of segmentIndex) {
        if (!ref) continue;
        if (ref.getStartTime() <= currentTime) targetRef = ref;
      }
    }
    if (!targetRef) return;

    const uris = targetRef.getUris();
    if (uris.length === 0) return;
    const mediaUrl = uris[0];

    // Cache hit — same segment, just select the right frame
    const cache = cacheRef.current;
    if (cache && cache.mediaUrl === mediaUrl) {
      selectFrameFromCache(cache, currentTime);
      return;
    }

    // Already decoding this segment — skip duplicate request
    if (pendingUrlRef.current === mediaUrl) return;

    const requestId = ++requestIdRef.current;
    pendingUrlRef.current = mediaUrl;
    setLoading(true);

    try {
      const [initResp, mediaResp] = await Promise.all([
        fetch(initSegmentUrl),
        fetch(mediaUrl),
      ]);
      if (!initResp.ok || !mediaResp.ok) {
        pendingUrlRef.current = null;
        setLoading(false);
        return;
      }

      if (requestIdRef.current !== requestId) { pendingUrlRef.current = null; return; }

      const [initSegment, mediaSegment] = await Promise.all([
        initResp.arrayBuffer(),
        mediaResp.arrayBuffer(),
      ]);

      if (requestIdRef.current !== requestId) { pendingUrlRef.current = null; return; }

      const msg: QpMapWorkerRequest = {
        type: "decodeSegmentQp",
        initSegment,
        mediaSegment,
        codec: isAv1 ? "av1" : isH265 ? "h265" : "h264",
        clearKeyHex: clearKey,
      };

      const segmentStart = targetRef.getStartTime();
      const segmentEnd = targetRef.getEndTime();

      worker.onmessage = (e: MessageEvent<QpMapWorkerResponse>) => {
        if (requestIdRef.current !== requestId) return;
        setLoading(false);
        pendingUrlRef.current = null;

        if (e.data.type === "qpSegment") {
          const segResult = e.data as QpMapSegmentResult;

          // Cache the full segment result
          const newCache: SegmentQpCache = {
            mediaUrl,
            segmentStart,
            segmentEnd,
            result: segResult,
          };
          cacheRef.current = newCache;

          // Select the frame for the current time
          selectFrameFromCache(newCache, videoEl.currentTime);
        } else if (e.data.type === "error") {
          setData(null);
        }
      };

      worker.postMessage(msg, [initSegment, mediaSegment]);
    } catch {
      pendingUrlRef.current = null;
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [player, videoEl, enabled, paused, available, isH265, isAv1, clearKey, selectFrameFromCache]);

  // Trigger on seeked (when paused) and on activation while paused
  useEffect(() => {
    if (!enabled || !paused || !available) return;

    // Trigger immediately for current frame
    requestQpMap();

    const onSeeked = () => {
      if (videoEl.paused) requestQpMap();
    };
    videoEl.addEventListener("seeked", onSeeked);
    return () => videoEl.removeEventListener("seeked", onSeeked);
  }, [enabled, paused, available, requestQpMap, videoEl]);

  return { isH264, isH265, isAv1, available, loading, data };
}
