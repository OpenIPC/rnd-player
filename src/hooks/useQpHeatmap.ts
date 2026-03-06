import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import shaka from "shaka-player";
import { extractInitSegmentUrl } from "../utils/extractInitSegmentUrl";
import type { QpMapWorkerRequest, QpMapWorkerResponse } from "../types/qpMapWorker.types";

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

  // Derive codec availability from player state (no effect needed)
  // Codec check — always computed so the menu item can be hidden for unsupported codecs
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

  // Clear data when playback resumes (transition from paused→playing)
  if (prevPausedRef.current && !paused) {
    setData(null);
  }
  prevPausedRef.current = paused;

  // Spawn / destroy worker
  useEffect(() => {
    if (!enabled) {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
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
    };
  }, [enabled]);

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

    const requestId = ++requestIdRef.current;
    setLoading(true);

    try {
      const [initResp, mediaResp] = await Promise.all([
        fetch(initSegmentUrl),
        fetch(uris[0]),
      ]);
      if (!initResp.ok || !mediaResp.ok) {
        setLoading(false);
        return;
      }

      // Check if this request is still current
      if (requestIdRef.current !== requestId) return;

      const [initSegment, mediaSegment] = await Promise.all([
        initResp.arrayBuffer(),
        mediaResp.arrayBuffer(),
      ]);

      if (requestIdRef.current !== requestId) return;

      const msg: QpMapWorkerRequest = {
        type: "decode",
        initSegment,
        mediaSegment,
        targetTime: currentTime,
        width: active.width ?? 0,
        height: active.height ?? 0,
        codec: isAv1 ? "av1" : isH265 ? "h265" : "h264",
        clearKeyHex: clearKey,
      };

      worker.onmessage = (e: MessageEvent<QpMapWorkerResponse>) => {
        if (requestIdRef.current !== requestId) return;
        setLoading(false);

        if (e.data.type === "qpMap") {
          setData({
            qpValues: e.data.qpValues,
            widthMbs: e.data.widthMbs,
            heightMbs: e.data.heightMbs,
            minQp: e.data.minQp,
            maxQp: e.data.maxQp,
          });
        } else if (e.data.type === "error") {
          setData(null);
        }
      };

      worker.postMessage(msg, [initSegment, mediaSegment]);
    } catch (err) {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [player, videoEl, enabled, paused, available, isH265, isAv1, clearKey]);

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
