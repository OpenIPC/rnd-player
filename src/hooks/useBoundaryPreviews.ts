import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type shaka from "shaka-player";
import type { WorkerRequest, WorkerResponse } from "../types/thumbnailWorker.types";
import { extractInitSegmentUrl } from "../utils/extractInitSegmentUrl";

const CORS_PROXY_URL: string =
  (typeof __CORS_PROXY_URL__ !== "undefined" && __CORS_PROXY_URL__) ||
  import.meta.env.VITE_CORS_PROXY_URL || "";
const CORS_PROXY_HMAC_KEY: string =
  (typeof __CORS_PROXY_HMAC_KEY__ !== "undefined" && __CORS_PROXY_HMAC_KEY__) ||
  import.meta.env.VITE_CORS_PROXY_HMAC_KEY || "";

const THUMBNAIL_WIDTH = 160;

export interface BoundaryPreview {
  before: ImageBitmap | null;
  after: ImageBitmap | null;
}

export type RequestBoundaryPreviewFn = (boundaryTime: number, frameNumber: number) => void;

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

/**
 * Lightweight hook that spawns a dedicated thumbnailWorker purely for
 * boundary preview decoding. Works independently of the filmstrip panel.
 * The worker receives a `generate` message (to set up segment info) but
 * no `updateQueue` messages, so it sits idle except when handling
 * `boundaryPreview` requests.
 */
export function useBoundaryPreviews(
  player: shaka.Player | null,
  videoEl: HTMLVideoElement | null,
  enabled: boolean,
  clearKey?: string,
): {
  boundaryPreviews: Map<number, BoundaryPreview>;
  requestBoundaryPreview: RequestBoundaryPreviewFn;
  clearBoundaryPreviews: () => void;
} {
  const [boundaryPreviews, setBoundaryPreviews] = useState<Map<number, BoundaryPreview>>(new Map());

  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const boundaryPreviewsRef = useRef<Map<number, BoundaryPreview>>(new Map());
  const pendingBoundaryRef = useRef<Set<number>>(new Set());

  const streamEncrypted = useMemo(() => {
    const stream = getLowestVideoStream(player);
    if (!stream) return false;
    return !!(stream.encrypted || (stream.drmInfos && stream.drmInfos.length > 0));
  }, [player]);

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
    for (const bp of boundaryPreviewsRef.current.values()) {
      if (bp.before) bp.before.close();
      if (bp.after) bp.after.close();
    }
    boundaryPreviewsRef.current = new Map();
    pendingBoundaryRef.current = new Set();
    setBoundaryPreviews(new Map());
  }, []);

  const requestBoundaryPreview = useCallback<RequestBoundaryPreviewFn>((boundaryTime: number, frameNumber: number) => {
    const worker = workerRef.current;
    if (!worker || !workerReadyRef.current) return;
    if (boundaryPreviewsRef.current.has(boundaryTime)) return;
    if (pendingBoundaryRef.current.has(boundaryTime)) return;
    pendingBoundaryRef.current.add(boundaryTime);
    worker.postMessage({ type: "boundaryPreview", boundaryTime, frameNumber } satisfies WorkerRequest);
  }, []);

  const clearBoundaryPreviews = useCallback(() => {
    for (const bp of boundaryPreviewsRef.current.values()) {
      if (bp.before) bp.before.close();
      if (bp.after) bp.after.close();
    }
    boundaryPreviewsRef.current = new Map();
    pendingBoundaryRef.current = new Set();
    setBoundaryPreviews(new Map());
  }, []);

  useEffect(() => {
    if (!enabled || !player || !videoEl || !isWebCodecsSupported() || encrypted) {
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
            case "ready":
              workerReadyRef.current = true;
              break;
            case "boundaryPreview": {
              pendingBoundaryRef.current.delete(msg.boundaryTime);
              boundaryPreviewsRef.current.set(msg.boundaryTime, {
                before: msg.beforeBitmap,
                after: msg.afterBitmap,
              });
              setBoundaryPreviews(new Map(boundaryPreviewsRef.current));
              break;
            }
          }
        };

        worker.postMessage({
          type: "generate",
          initSegmentUrl,
          segments,
          codec,
          width,
          height,
          thumbnailWidth: THUMBNAIL_WIDTH,
          clearKeyHex: streamEncrypted ? clearKey : undefined,
          corsProxyUrl: CORS_PROXY_URL || undefined,
          corsProxyHmacKey: CORS_PROXY_HMAC_KEY || undefined,
        } satisfies WorkerRequest);
      } catch {
        // Boundary preview is best-effort; failures are silent
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [player, videoEl, enabled, encrypted, clearKey, streamEncrypted, cleanup]);

  return { boundaryPreviews, requestBoundaryPreview, clearBoundaryPreviews };
}
