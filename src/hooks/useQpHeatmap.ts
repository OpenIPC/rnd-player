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
  /** Whether the current codec supports QP extraction (H.264 only). */
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
): UseQpHeatmapResult {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<QpHeatmapData | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const prevPausedRef = useRef(paused);

  // Derive codec availability from player state (no effect needed)
  // Codec check — always computed so the menu item can be hidden for non-H.264
  const isH264 = useMemo(() => {
    const tracks = player.getVariantTracks();
    const active = tracks.find((t) => t.active);
    const codec = active?.videoCodec ?? "";
    return codec.startsWith("avc1");
    // Re-check when paused changes (track may have switched via ABR)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, paused]);

  const available = enabled && isH264;

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
        console.error("[QP heatmap] worker error:", e.message ?? e);
      };
      workerRef.current = w;
    }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [enabled]);

  const requestQpMap = useCallback(async () => {
    if (!enabled || !paused || !available) {
      console.debug("[QP heatmap] skip: enabled=%s paused=%s available=%s", enabled, paused, available);
      return;
    }
    const worker = workerRef.current;
    if (!worker) {
      console.debug("[QP heatmap] skip: worker not ready");
      return;
    }

    const manifest = player.getManifest();
    if (!manifest?.variants?.length) {
      console.debug("[QP heatmap] skip: no manifest/variants");
      return;
    }

    // Find active video stream
    const tracks = player.getVariantTracks();
    const active = tracks.find((t) => t.active);
    if (!active) {
      console.debug("[QP heatmap] skip: no active track");
      return;
    }

    let videoStream: shaka.extern.Stream | null = null;
    for (const v of manifest.variants) {
      if (v.video && v.video.height === active.height && v.video.width === active.width) {
        videoStream = v.video;
        break;
      }
    }
    if (!videoStream) {
      console.debug("[QP heatmap] skip: no matching video stream for %dx%d", active.width, active.height);
      return;
    }

    await videoStream.createSegmentIndex();
    const segmentIndex = videoStream.segmentIndex;
    if (!segmentIndex) {
      console.debug("[QP heatmap] skip: no segment index");
      return;
    }

    // Find the segment containing the current time
    const currentTime = videoEl.currentTime;
    let targetRef: shaka.media.SegmentReference | null = null;
    const iter = segmentIndex[Symbol.iterator]();
    const firstResult = iter.next();
    if (firstResult.done) {
      console.debug("[QP heatmap] skip: empty segment index");
      return;
    }
    const firstRef = firstResult.value;
    if (!firstRef) {
      console.debug("[QP heatmap] skip: null first segment ref");
      return;
    }

    const initSegmentUrl = extractInitSegmentUrl(firstRef);
    if (!initSegmentUrl) {
      console.debug("[QP heatmap] skip: no init segment URL");
      return;
    }

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
    if (!targetRef) {
      console.debug("[QP heatmap] skip: no segment for time %f", currentTime);
      return;
    }

    const uris = targetRef.getUris();
    if (uris.length === 0) {
      console.debug("[QP heatmap] skip: segment has no URIs");
      return;
    }

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
      };

      worker.onmessage = (e: MessageEvent<QpMapWorkerResponse>) => {
        if (requestIdRef.current !== requestId) {
          console.debug("[QP heatmap] dropping stale response (id %d, current %d): %s",
            requestId, requestIdRef.current, e.data.type === "error" ? e.data.message : e.data.type);
          return;
        }
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
          console.warn("[QP heatmap]", e.data.message);
          setData(null);
        }
      };

      console.debug("[QP heatmap] posting to worker: time=%f, init=%d bytes, media=%d bytes",
        currentTime, initSegment.byteLength, mediaSegment.byteLength);
      worker.postMessage(msg, [initSegment, mediaSegment]);
    } catch (err) {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        console.warn("[QP heatmap] fetch error:", err);
      }
    }
  }, [player, videoEl, enabled, paused, available]);

  // Trigger on seeked (when paused) and on activation while paused
  useEffect(() => {
    console.debug("[QP heatmap] trigger effect: enabled=%s paused=%s available=%s", enabled, paused, available);
    if (!enabled || !paused || !available) return;

    // Trigger immediately for current frame
    requestQpMap();

    const onSeeked = () => {
      if (videoEl.paused) requestQpMap();
    };
    videoEl.addEventListener("seeked", onSeeked);
    return () => videoEl.removeEventListener("seeked", onSeeked);
  }, [enabled, paused, available, requestQpMap, videoEl]);

  return { isH264, available, loading, data };
}
