import { useEffect, useRef, useCallback, useState } from "react";
import type shaka from "shaka-player";
import { useThumbnailGenerator } from "../hooks/useThumbnailGenerator";
import { useBitrateGraph } from "../hooks/useBitrateGraph";
import type { BitrateGraphData } from "../hooks/useBitrateGraph";
import { formatTime, formatTimecode } from "../utils/formatTime";
import type { TimecodeMode } from "../utils/formatTime";
import { formatBitrate } from "../utils/formatBitrate";
import { SaveSegmentIcon, SceneMarkersIcon } from "./icons";
import type { FrameType } from "../types/thumbnailWorker.types";
import type { SceneData } from "../types/sceneData";
import SegmentFramesModal from "./SegmentFramesModal";

interface FilmstripTimelineProps {
  videoEl: HTMLVideoElement;
  player: shaka.Player;
  onClose: () => void;
  clearKey?: string;
  timecodeMode?: TimecodeMode;
  fps?: number;
  inPoint?: number | null;
  outPoint?: number | null;
  startOffset?: number;
  psnrHistory?: React.RefObject<Map<number, number>>;
  ssimHistory?: React.RefObject<Map<number, number>>;
  msSsimHistory?: React.RefObject<Map<number, number>>;
  vmafHistory?: React.RefObject<Map<number, number>>;
  sceneData?: SceneData | null;
  onLoadSceneData?: () => void;
  onClearSceneData?: () => void;
}

const RULER_HEIGHT = 22;
const THUMB_ROW_TOP = RULER_HEIGHT;
const GRAPH_HEIGHT = 48;
const MIN_PX_PER_SEC_ABSOLUTE = 4;
const DEFAULT_PX_PER_SEC = 16;
const PLAYHEAD_COLOR_CANVAS = "rgb(71, 13, 179)";
const MARKER_COLOR = "#f5c518";
const FONT = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const FRAME_BORDER_I = "rgba(255, 50, 50, 0.8)";
const FRAME_BORDER_P = "rgba(60, 130, 255, 0.8)";
const FRAME_BORDER_B = "rgba(50, 200, 50, 0.8)";
const SCENE_LINE_COLOR = "rgba(255, 160, 40, 0.7)";
const SCENE_LABEL_COLOR = "rgba(255, 160, 40, 0.5)";
const GRAPH_MEASURED_COLOR = "rgba(74, 158, 237, 0.6)";
const GRAPH_ESTIMATED_COLOR = "rgba(74, 158, 237, 0.25)";
const GRAPH_AVG_COLOR = "rgba(74, 158, 237, 0.5)";
const PSNR_STRIP_HEIGHT = 8;
const SSIM_STRIP_HEIGHT = 8;
const MSSSIM_STRIP_HEIGHT = 8;
const VMAF_STRIP_HEIGHT = 8;

/** Map PSNR dB value to a color string using 5-stop gradient matching the shader */
function psnrColor(dB: number): string {
  if (dB >= 50) return "rgb(0, 102, 0)";
  if (dB >= 40) return `rgb(0, ${Math.round(204 - (dB - 40) / 10 * 102)}, 0)`;
  if (dB >= 30) { const t = (dB - 30) / 10; return `rgb(${Math.round(255 - t * 255)}, ${Math.round(255 * (1 - t) + 204 * t)}, 0)`; }
  if (dB >= 20) { const t = (dB - 20) / 10; return `rgb(255, ${Math.round(t * 255)}, 0)`; }
  { const t = Math.max(0, Math.min(1, (dB - 15) / 5)); return `rgb(255, 0, ${Math.round(255 - t * 255)})`; }
}

/** Map SSIM value (0-1) to a color string using 5-stop gradient matching the shader */
function ssimColor(s: number): string {
  if (s >= 0.99) return "rgb(0, 102, 0)";
  if (s >= 0.95) { const t = (s - 0.95) / 0.04; return `rgb(0, ${Math.round(204 - t * 102)}, 0)`; }
  if (s >= 0.85) { const t = (s - 0.85) / 0.10; return `rgb(${Math.round(255 - t * 255)}, ${Math.round(255 * (1 - t) + 204 * t)}, 0)`; }
  if (s >= 0.70) { const t = (s - 0.70) / 0.15; return `rgb(255, ${Math.round(t * 255)}, 0)`; }
  { const t = Math.max(0, Math.min(1, (s - 0.50) / 0.20)); return `rgb(255, 0, ${Math.round(255 - t * 255)})`; }
}

/** Map VMAF score (0-100) to a color string using 5-stop gradient */
function vmafColor(v: number): string {
  if (v >= 95) return "rgb(0, 102, 0)";
  if (v >= 80) { const t = (v - 80) / 15; return `rgb(0, ${Math.round(204 - t * 102)}, 0)`; }
  if (v >= 60) { const t = (v - 60) / 20; return `rgb(${Math.round(255 - t * 255)}, ${Math.round(255 * (1 - t) + 204 * t)}, 0)`; }
  if (v >= 40) { const t = (v - 40) / 20; return `rgb(255, ${Math.round(t * 255)}, 0)`; }
  { const t = Math.max(0, Math.min(1, (v - 20) / 20)); return `rgb(255, 0, ${Math.round(255 - t * 255)})`; }
}

export default function FilmstripTimeline({
  videoEl,
  player,
  onClose,
  clearKey,
  timecodeMode,
  fps = 30,
  inPoint,
  outPoint,
  startOffset = 0,
  psnrHistory,
  ssimHistory,
  msSsimHistory,
  vmafHistory,
  sceneData,
  onLoadSceneData,
  onClearSceneData,
}: FilmstripTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const scrollLeftRef = useRef(0);
  const pxPerSecRef = useRef(DEFAULT_PX_PER_SEC);
  const isDraggingRef = useRef(false);
  const [followMode, setFollowMode] = useState(true);
  const followModeRef = useRef(followMode);
  followModeRef.current = followMode;
  const [showBitrateGraph, setShowBitrateGraph] = useState(true);
  const showBitrateGraphRef = useRef(showBitrateGraph);
  showBitrateGraphRef.current = showBitrateGraph;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; time: number } | null>(null);
  const ctxMenuTimeRef = useRef(0);
  /** Normalized frame position (0..1) for position-based save, or undefined for packed mode */
  const ctxMenuFramePositionRef = useRef<number | undefined>(undefined);
  const [gopTooltip, setGopTooltip] = useState<{ x: number; y: number; segIdx: number; segDuration: number } | null>(null);
  const gopTooltipRef = useRef<{ x: number; y: number; segIdx: number; segDuration: number } | null>(null);
  const [segmentModal, setSegmentModal] = useState<{ startTime: number; endTime: number } | null>(null);
  const [sceneTooltip, setSceneTooltip] = useState<{ x: number; y: number; sceneNum: number; time: number } | null>(null);
  const sceneTooltipRef = useRef<{ x: number; y: number; sceneNum: number; time: number } | null>(null);

  const containerWidthRef = useRef(0);
  const durationRef = useRef(0);
  const currentTimeRef = useRef(0);
  const videoAspectRef = useRef(16 / 9);
  const thumbWRef = useRef(0);

  const duration = videoEl.duration || 0;

  const { thumbnails, segmentTimes, supported, requestRange, saveFrame: workerSaveFrame, intraFrames, intraFrameTypes, intraTimestamps, gopStructures, requestGop, requestIntraBatch, decodeSegmentFrames, cancelDecodeSegment, boundaryPreviews, requestBoundaryPreview, clearBoundaryPreviews } =
    useThumbnailGenerator(player, videoEl, true, clearKey);

  // Keep latest values in refs so the rAF paint loop can read them
  // without the useEffect needing to restart on every thumbnail update.
  const thumbnailsRef = useRef(thumbnails);
  const segmentTimesRef = useRef(segmentTimes);
  const requestRangeRef = useRef(requestRange);
  thumbnailsRef.current = thumbnails;
  segmentTimesRef.current = segmentTimes;
  requestRangeRef.current = requestRange;

  const intraFramesMapRef = useRef(intraFrames);
  const intraFrameTypesRef = useRef(intraFrameTypes);
  const intraTimestampsRef = useRef(intraTimestamps);
  const gopStructuresRef = useRef(gopStructures);
  const requestGopRef = useRef(requestGop);
  const requestIntraBatchRef = useRef(requestIntraBatch);
  intraFramesMapRef.current = intraFrames;
  intraFrameTypesRef.current = intraFrameTypes;
  intraTimestampsRef.current = intraTimestamps;
  gopStructuresRef.current = gopStructures;
  requestGopRef.current = requestGop;
  requestIntraBatchRef.current = requestIntraBatch;

  const bitrateData = useBitrateGraph(player, showBitrateGraph);
  const bitrateDataRef = useRef<BitrateGraphData>(bitrateData);
  bitrateDataRef.current = bitrateData;

  const inPointRef = useRef(inPoint);
  const outPointRef = useRef(outPoint);
  const timecodeModeRef = useRef(timecodeMode);
  const fpsRef = useRef(fps);
  inPointRef.current = inPoint;
  outPointRef.current = outPoint;
  timecodeModeRef.current = timecodeMode;

  // Detect fps from the player's active variant track
  const detectedFps = (() => {
    const tracks = player.getVariantTracks();
    const active = tracks.find((t) => t.active);
    if (active?.frameRate != null && active.frameRate > 0) return active.frameRate;
    return null;
  })();
  fpsRef.current = detectedFps ?? fps;

  const sceneDataRef = useRef(sceneData);
  sceneDataRef.current = sceneData;

  // Clear boundary preview cache when scene data changes (e.g., FPS correction
  // recalculates boundary times, invalidating cached previews)
  const prevSceneDataRef = useRef(sceneData);
  useEffect(() => {
    if (prevSceneDataRef.current !== sceneData) {
      prevSceneDataRef.current = sceneData;
      clearBoundaryPreviews();
    }
  }, [sceneData, clearBoundaryPreviews]);

  const boundaryPreviewsRef = useRef(boundaryPreviews);
  boundaryPreviewsRef.current = boundaryPreviews;
  const requestBoundaryPreviewRef = useRef(requestBoundaryPreview);
  requestBoundaryPreviewRef.current = requestBoundaryPreview;

  const startOffsetRef = useRef(startOffset);
  startOffsetRef.current = startOffset;
  const psnrHistoryRef = useRef(psnrHistory);
  psnrHistoryRef.current = psnrHistory;
  const ssimHistoryRef = useRef(ssimHistory);
  ssimHistoryRef.current = ssimHistory;
  const msSsimHistoryRef = useRef(msSsimHistory);
  msSsimHistoryRef.current = msSsimHistory;
  const vmafHistoryRef = useRef(vmafHistory);
  vmafHistoryRef.current = vmafHistory;


  const saveFrame = useCallback(async () => {
    const targetTime = ctxMenuTimeRef.current;
    setCtxMenu(null);

    const w = videoEl.videoWidth;
    const h = videoEl.videoHeight;
    if (!w || !h) return;

    // Build filename: {title}_{MM-SS}_{height}p.png
    const secs = targetTime;
    const hh = Math.floor(secs / 3600);
    const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
    const ss = String(Math.floor(secs % 60)).padStart(2, "0");
    const time = hh > 0 ? `${hh}-${mm}-${ss}` : `${mm}-${ss}`;

    const uri = player.getAssetUri?.() ?? "";
    const slug = decodeURIComponent(uri.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const title = slug || "frame";

    const filename = `${title}_${time}_${h}p.png`;

    const download = (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    };

    // If the right-clicked time is very close to the current playback position,
    // try direct canvas capture first (fast path, works for non-DRM).
    // Use a tight threshold (1ms) to avoid capturing the wrong frame when
    // the click position differs from the video's current position.
    const isCurrentFrame = Math.abs(videoEl.currentTime - targetTime) < 0.001;

    if (isCurrentFrame) {
      let directOk = false;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(videoEl, 0, 0, w, h);

        // DRM-tainted canvases may not throw but render all-black pixels.
        // Sample a few pixels to detect this before accepting the result.
        let tainted = false;
        try {
          const sample = ctx.getImageData(0, 0, Math.min(w, 32), Math.min(h, 32));
          const d = sample.data;
          let nonZero = false;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 0) {
              nonZero = true;
              break;
            }
          }
          if (!nonZero) tainted = true;
        } catch {
          tainted = true;
        }

        if (!tainted) {
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/png"),
          );
          if (blob) {
            download(blob);
            directOk = true;
          }
        }
      } catch {
        // Canvas tainted by DRM — fall through to worker fallback
      }

      if (directOk) return;
    }

    // Worker-based decode: works for any time and handles DRM
    try {
      const bitmap = await workerSaveFrame(secs, ctxMenuFramePositionRef.current);
      if (!bitmap) return;
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (blob) download(blob);
    } catch {
      // Worker fallback also failed — silently ignore
    }
  }, [videoEl, player, workerSaveFrame]);

  // Track current time, duration, and video aspect ratio
  useEffect(() => {
    const updateAspect = () => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        videoAspectRef.current = videoEl.videoWidth / videoEl.videoHeight;
      }
    };
    const onTimeUpdate = () => {
      currentTimeRef.current = videoEl.currentTime;
    };
    const onDurationChange = () => {
      durationRef.current = videoEl.duration || 0;
    };
    durationRef.current = videoEl.duration || 0;
    updateAspect();

    videoEl.addEventListener("timeupdate", onTimeUpdate);
    videoEl.addEventListener("seeking", onTimeUpdate);
    videoEl.addEventListener("durationchange", onDurationChange);
    videoEl.addEventListener("loadedmetadata", updateAspect);
    return () => {
      videoEl.removeEventListener("timeupdate", onTimeUpdate);
      videoEl.removeEventListener("seeking", onTimeUpdate);
      videoEl.removeEventListener("durationchange", onDurationChange);
      videoEl.removeEventListener("loadedmetadata", updateAspect);
    };
  }, [videoEl]);

  // Clamp scroll to valid range
  const clampScroll = useCallback(
    (scroll: number, viewWidth: number) => {
      const totalWidth = durationRef.current * pxPerSecRef.current;
      const max = Math.max(0, totalWidth - viewWidth);
      return Math.max(0, Math.min(max, scroll));
    },
    [],
  );

  // Canvas rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;

    const ctx = canvas.getContext("2d")!;

    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = wrapper.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      containerWidthRef.current = rect.width;
    });
    observer.observe(wrapper);

    function paint() {
      const rect = wrapper!.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const dur = durationRef.current;
      const time = currentTimeRef.current;

      ctx.clearRect(0, 0, w, h);

      if (dur <= 0) {
        rafRef.current = requestAnimationFrame(paint);
        return;
      }

      // Clamp zoom so the video always fills the viewport at max zoom-out
      const minPxPerSec = w > 0 && dur > 0 ? Math.max(MIN_PX_PER_SEC_ABSOLUTE, w / dur) : MIN_PX_PER_SEC_ABSOLUTE;
      if (pxPerSecRef.current < minPxPerSec) {
        pxPerSecRef.current = minPxPerSec;
      }

      const pxPerSec = pxPerSecRef.current;
      const scrollLeft = scrollLeftRef.current;

      // B-frame CTO pixel offset: frame slots use segment-relative
      // positions (no CTO shift), so overlays, playhead, ruler, and
      // seek must subtract CTO to align with frame positions.
      const ctoPx = startOffsetRef.current * pxPerSec;

      // Auto-follow playhead
      if (followModeRef.current && !isDraggingRef.current) {
        const playheadX = time * pxPerSec - ctoPx - scrollLeft;
        const margin = w * 0.15;
        if (playheadX < margin || playheadX > w - margin) {
          scrollLeftRef.current = clampScroll(time * pxPerSec - ctoPx - w / 2, w);
        }
      }

      const sl = scrollLeftRef.current;

      // Request thumbnails for the visible range + buffer
      {
        const visStartTime = sl / pxPerSec;
        const visEndTime = (sl + w) / pxPerSec;
        const buffer = visEndTime - visStartTime; // 1 viewport width buffer each side
        requestRangeRef.current(
          Math.max(0, visStartTime - buffer),
          Math.min(dur, visEndTime + buffer),
          time,
        );
      }

      // Background
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, w, h);

      // ── Time ruler ──
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, 0, w, RULER_HEIGHT);

      // Compute tick interval based on zoom
      const minTickPx = 60;
      const rawInterval = minTickPx / pxPerSec;
      const curFps = fpsRef.current;
      const frameDur = 1 / curFps;
      // Frame-aligned sub-second intervals for high zoom levels
      const frameNice = [1, 2, 5, 10, Math.round(curFps / 2)]
        .map(n => n * frameDur)
        .filter(v => v > 0 && v < 1);
      frameNice.sort((a, b) => a - b);
      const niceIntervals = [...frameNice, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
      let tickInterval = niceIntervals[niceIntervals.length - 1];
      for (const ni of niceIntervals) {
        if (ni >= rawInterval) {
          tickInterval = ni;
          break;
        }
      }

      const sOff = startOffsetRef.current;
      let startTick: number;
      let endTick: number;
      // Anchor ALL ticks from startOffset so they align with frame
      // boundaries. For sub-second: frame-exact alignment. For
      // whole-second: ticks at sOff, sOff+1, sOff+2, ... so that
      // after the CTO pixel shift they land at round video-time seconds.
      startTick = sOff + Math.floor(((sl + ctoPx) / pxPerSec - sOff) / tickInterval) * tickInterval;
      endTick = sOff + Math.ceil(((sl + ctoPx + w) / pxPerSec - sOff) / tickInterval) * tickInterval;

      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.font = FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";

      // Minor tick subdivision: frame-aligned for sub-second, capped at 5
      const subCount = tickInterval < 1
        ? Math.min(Math.round(tickInterval / frameDur), 5)
        : 4;

      for (let t = startTick; t <= endTick; t += tickInterval) {
        if (t < 0) continue;
        const x = t * pxPerSec - sl - ctoPx;
        if (x < -50 || x > w + 50) continue;

        // Major tick
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, RULER_HEIGHT - 6);
        ctx.lineTo(x, RULER_HEIGHT);
        ctx.stroke();

        // Labels use video time (DASH time minus CTO)
        const videoTime = Math.max(0, t - sOff);
        let label: string;
        if (tickInterval < 1) {
          label = formatTimecode(videoTime, "milliseconds");
        } else if (pxPerSec > 30 && timecodeModeRef.current) {
          label = formatTimecode(videoTime, timecodeModeRef.current, curFps);
        } else {
          label = formatTime(videoTime);
        }
        ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
        ctx.fillText(label, x, RULER_HEIGHT - 7);

        // Minor ticks
        const subInterval = tickInterval / subCount;
        for (let s = 1; s < subCount; s++) {
          const sx = (t + s * subInterval) * pxPerSec - sl - ctoPx;
          if (sx < 0 || sx > w) continue;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
          ctx.beginPath();
          ctx.moveTo(sx, RULER_HEIGHT - 3);
          ctx.lineTo(sx, RULER_HEIGHT);
          ctx.stroke();
        }
      }

      // ── Thumbnail row ──
      const graphOn = showBitrateGraphRef.current;
      const graphH = graphOn ? GRAPH_HEIGHT : 0;
      const thumbH = h - RULER_HEIGHT - graphH - (graphOn ? 0 : 1);
      const thumbW = thumbH * videoAspectRef.current;
      thumbWRef.current = thumbW;
      const times = segmentTimesRef.current;

      // Determine if we're at max zoom (frame-level)
      const maxPxPerSec = thumbW > 0 ? fpsRef.current * thumbW : 5000;
      const atMaxZoom = pxPerSec >= maxPxPerSec * 0.95;

      // Draw thumbnails — single per segment when packed, multiple when zoomed in.
      // When the bitrate graph is visible, use the active stream's segment
      // boundaries for layout so thumbnails and bars align. The thumbnail
      // bitmaps come from the lowest-quality stream which may have different
      // segment boundaries, so we map each layout segment to its nearest
      // thumbnail segment for bitmap/intra-frame lookup.
      const bd = bitrateDataRef.current;
      const useBdLayout = graphOn && bd.segments.length > 0;
      const layoutLen = useBdLayout ? bd.segments.length : times.length;

      const neededIntra: { segmentIndex: number; count: number }[] = [];

      // Pointer for efficient nearest-thumbnail-segment lookup (both lists sorted)
      let thumbPtr = 0;

      for (let li = 0; li < layoutLen; li++) {
        // Layout segment boundaries
        let segStart: number, segEnd: number;
        if (useBdLayout) {
          segStart = bd.segments[li].startTime;
          segEnd = bd.segments[li].endTime;
        } else {
          segStart = times[li];
          segEnd = li < times.length - 1 ? times[li + 1] : dur;
        }

        // Find nearest thumbnail segment (sorted pointer scan)
        while (
          thumbPtr < times.length - 1 &&
          Math.abs(times[thumbPtr + 1] - segStart) <= Math.abs(times[thumbPtr] - segStart)
        ) {
          thumbPtr++;
        }
        const thumbSegIdx = thumbPtr;
        const thumbSegTime = times[thumbSegIdx] ?? segStart;

        const segDuration = segEnd - segStart;
        const segWidth = segDuration * pxPerSec;

        if (segWidth <= thumbW) {
          // Packed mode: crop thumbnail to segment boundaries
          const x1 = segStart * pxPerSec - sl;
          const x2 = segEnd * pxPerSec - sl;
          if (x2 < 0 || x1 > w) continue;

          const drawW = x2 - x1;
          const drawY = THUMB_ROW_TOP;
          const bmp = thumbnailsRef.current.get(thumbSegTime);
          if (bmp && bmp.width > 0) {
            const srcScale = Math.min(1, drawW / thumbW);
            const srcW = bmp.width * srcScale;
            const srcX = (bmp.width - srcW) / 2;
            ctx.drawImage(bmp, srcX, 0, srcW, bmp.height, x1, drawY, drawW, thumbH);
            ctx.strokeStyle = FRAME_BORDER_I;
            ctx.lineWidth = 1;
            ctx.strokeRect(x1, drawY, drawW, thumbH);
          } else {
            ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
            ctx.fillRect(x1, drawY, drawW, thumbH);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
            ctx.lineWidth = 1;
            ctx.strokeRect(x1, drawY, drawW, thumbH);
          }
        } else {
          // Gap mode: tile thumbnails edge-to-edge within equal-width slots.
          // Frame slots are positioned at segment-relative times (no CTO
          // offset). The playhead, ruler, and overlays are shifted by -CTO
          // to align with frame positions (see ctoPx below).
          const count = Math.max(2, Math.ceil(segWidth / thumbW));
          const slotW = segWidth / count;
          const intraArr = intraFramesMapRef.current.get(thumbSegIdx) ?? [];
          const intraTypes = intraFrameTypesRef.current.get(thumbSegIdx) ?? [];

          // Check if any part of the segment is visible on screen
          const segX1 = segStart * pxPerSec - sl;
          const segX2 = segEnd * pxPerSec - sl;
          const segVisible = segX2 >= 0 && segX1 <= w;

          for (let j = 0; j < count; j++) {
            const slotX = segX1 + j * slotW;

            // Skip if outside viewport
            if (slotX + slotW < 0 || slotX > w) continue;

            const drawY = THUMB_ROW_TOP;
            let bmp: ImageBitmap | undefined;
            let frameType: FrameType = "I";

            if (intraArr.length > 0) {
              // Intra-frames are in display (CTS) order — use them for all
              // slots so B-frames at the segment start are shown correctly.
              const arrIdx = count > 1
                ? Math.round((j / (count - 1)) * (intraArr.length - 1))
                : 0;
              if (arrIdx >= 0 && arrIdx < intraArr.length) {
                bmp = intraArr[arrIdx];
                frameType = intraTypes[arrIdx] ?? "P";
              }
            } else if (j === 0) {
              // Fallback: only have the I-frame thumbnail (intra not loaded yet)
              bmp = thumbnailsRef.current.get(thumbSegTime);
              frameType = "I";
            }

            if (bmp && bmp.width > 0) {
              if (slotW >= thumbW) {
                // Slot wider than thumbnail: center it in the slot
                const drawX = slotX + (slotW - thumbW) / 2;
                ctx.drawImage(bmp, drawX, drawY, thumbW, thumbH);
              } else {
                // Slot narrower: crop center of bitmap to fit
                const srcScale = slotW / thumbW;
                const srcW = bmp.width * srcScale;
                const srcX = (bmp.width - srcW) / 2;
                ctx.drawImage(bmp, srcX, 0, srcW, bmp.height, slotX, drawY, slotW, thumbH);
              }
              ctx.strokeStyle = frameType === "I" ? FRAME_BORDER_I
                : frameType === "B" ? FRAME_BORDER_B : FRAME_BORDER_P;
              ctx.lineWidth = 1;
              ctx.strokeRect(slotX, drawY, slotW, thumbH);
            } else {
              ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
              ctx.fillRect(slotX, drawY, slotW, thumbH);
              ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
              ctx.lineWidth = 1;
              ctx.strokeRect(slotX, drawY, slotW, thumbH);
            }

            // Frame number at max zoom
            if (atMaxZoom) {
              const frameNum = Math.round(segStart * fpsRef.current) + j;
              ctx.font = "9px monospace";
              ctx.textAlign = "left";
              ctx.textBaseline = "top";
              ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
              const label = String(frameNum);
              const textW = ctx.measureText(label).width;
              ctx.fillRect(slotX, drawY, textW + 6, 14);
              ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
              ctx.fillText(label, slotX + 3, drawY + 2);
              ctx.font = FONT;
              ctx.textAlign = "center";
            }
          }

          // Only request intra-frames for visible segments
          if (segVisible && intraArr.length < count) {
            neededIntra.push({ segmentIndex: thumbSegIdx, count });
          }
        }
      }

      // Send batched intra-frame request (deduplicated by fingerprint in hook)
      // Use viewport center as priority so visible segments are decoded first
      if (neededIntra.length > 0) {
        const viewportCenterTime = (sl + w / 2) / pxPerSec;
        requestIntraBatchRef.current(neededIntra, viewportCenterTime);
      }

      // ── Bitrate graph ──
      if (graphOn) {
        if (bd.segments.length > 0 && bd.maxBitrateBps > 0) {
          const graphTop = THUMB_ROW_TOP + thumbH;
          const graphBottom = graphTop + GRAPH_HEIGHT;
          const barMaxH = GRAPH_HEIGHT - 12; // leave space for labels

          // Separator line
          ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, graphTop);
          ctx.lineTo(w, graphTop);
          ctx.stroke();

          // Draw bars using the active stream's own segment boundaries
          for (const seg of bd.segments) {
            const x1 = seg.startTime * pxPerSec - sl;
            const x2 = seg.endTime * pxPerSec - sl;
            if (x2 < 0 || x1 > w) continue;

            const barW = Math.max(1, x2 - x1 - 1);
            const ratio = seg.bitrateBps / bd.maxBitrateBps;
            const barH = ratio * barMaxH;
            const barY = graphBottom - barH;

            ctx.fillStyle = seg.measured ? GRAPH_MEASURED_COLOR : GRAPH_ESTIMATED_COLOR;
            ctx.fillRect(x1, barY, barW, barH);
          }

          // Average bitrate dashed line
          const avgRatio = bd.avgBitrateBps / bd.maxBitrateBps;
          const avgY = graphBottom - avgRatio * barMaxH;
          ctx.strokeStyle = GRAPH_AVG_COLOR;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(0, avgY);
          ctx.lineTo(w, avgY);
          ctx.stroke();
          ctx.setLineDash([]);

          // Labels
          ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
          ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillText(formatBitrate(bd.maxBitrateBps), 4, graphTop + 2);
          ctx.textBaseline = "middle";
          ctx.fillText(`avg ${formatBitrate(bd.avgBitrateBps)}`, 4, avgY);

          // Rendition label at top-right
          if (bd.renditionLabel) {
            ctx.textAlign = "right";
            ctx.textBaseline = "top";
            ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
            ctx.fillText(bd.renditionLabel, w - 4, graphTop + 2);
          }

          // Reset text settings for subsequent drawing
          ctx.font = FONT;
          ctx.textAlign = "center";
        }
      }

      // ── PSNR strip ──
      const psnrMap = psnrHistoryRef.current?.current;
      if (psnrMap && psnrMap.size > 0) {
        // If bitrate graph is off, we still need a graph area for the strip
        const stripGraphTop = graphOn
          ? THUMB_ROW_TOP + thumbH
          : THUMB_ROW_TOP + thumbH;
        const stripY = graphOn
          ? stripGraphTop + GRAPH_HEIGHT - PSNR_STRIP_HEIGHT
          : stripGraphTop;

        for (const [t, dB] of psnrMap) {
          const x = t * pxPerSec - sl;
          if (x < -2 || x > w + 2) continue;
          ctx.fillStyle = psnrColor(dB);
          ctx.fillRect(x, stripY, 2, PSNR_STRIP_HEIGHT);
        }

        // "PSNR" label at top-right of strip area
        ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.fillText("PSNR", w - 4, stripY + PSNR_STRIP_HEIGHT - 1);
        ctx.font = FONT;
        ctx.textAlign = "center";
      }

      // ── SSIM strip ──
      const ssimMap = ssimHistoryRef.current?.current;
      if (ssimMap && ssimMap.size > 0) {
        const psnrMap = psnrHistoryRef.current?.current;
        const hasPsnr = psnrMap && psnrMap.size > 0;
        const stripGraphTop = THUMB_ROW_TOP + thumbH;
        // Position SSIM strip above PSNR strip when both are present
        const ssimStripY = graphOn
          ? stripGraphTop + GRAPH_HEIGHT - SSIM_STRIP_HEIGHT - (hasPsnr ? PSNR_STRIP_HEIGHT : 0)
          : stripGraphTop + (hasPsnr ? PSNR_STRIP_HEIGHT : 0);

        for (const [t, s] of ssimMap) {
          const x = t * pxPerSec - sl;
          if (x < -2 || x > w + 2) continue;
          ctx.fillStyle = ssimColor(s);
          ctx.fillRect(x, ssimStripY, 2, SSIM_STRIP_HEIGHT);
        }

        // "SSIM" label at top-right of strip area
        ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.fillText("SSIM", w - 4, ssimStripY + SSIM_STRIP_HEIGHT - 1);
        ctx.font = FONT;
        ctx.textAlign = "center";
      }

      // ── MS-SSIM strip ──
      const msSsimMap = msSsimHistoryRef.current?.current;
      if (msSsimMap && msSsimMap.size > 0) {
        const psnrMap = psnrHistoryRef.current?.current;
        const hasPsnr = psnrMap && psnrMap.size > 0;
        const ssimMap = ssimHistoryRef.current?.current;
        const hasSsim = ssimMap && ssimMap.size > 0;
        const stripGraphTop = THUMB_ROW_TOP + thumbH;
        // Position MS-SSIM strip above SSIM strip (and PSNR strip) when present
        const msSsimStripY = graphOn
          ? stripGraphTop + GRAPH_HEIGHT - MSSSIM_STRIP_HEIGHT - (hasPsnr ? PSNR_STRIP_HEIGHT : 0) - (hasSsim ? SSIM_STRIP_HEIGHT : 0)
          : stripGraphTop + (hasPsnr ? PSNR_STRIP_HEIGHT : 0) + (hasSsim ? SSIM_STRIP_HEIGHT : 0);

        for (const [t, s] of msSsimMap) {
          const x = t * pxPerSec - sl;
          if (x < -2 || x > w + 2) continue;
          ctx.fillStyle = ssimColor(s);
          ctx.fillRect(x, msSsimStripY, 2, MSSSIM_STRIP_HEIGHT);
        }

        // "MS-SSIM" label at top-right of strip area
        ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.fillText("MS-SSIM", w - 4, msSsimStripY + MSSSIM_STRIP_HEIGHT - 1);
        ctx.font = FONT;
        ctx.textAlign = "center";
      }

      // ── VMAF strip ──
      const vmafMap = vmafHistoryRef.current?.current;
      if (vmafMap && vmafMap.size > 0) {
        const psnrMap2 = psnrHistoryRef.current?.current;
        const hasPsnr2 = psnrMap2 && psnrMap2.size > 0;
        const ssimMap2 = ssimHistoryRef.current?.current;
        const hasSsim2 = ssimMap2 && ssimMap2.size > 0;
        const msSsimMap2 = msSsimHistoryRef.current?.current;
        const hasMsSsim = msSsimMap2 && msSsimMap2.size > 0;
        const stripGraphTop = THUMB_ROW_TOP + thumbH;
        const vmafStripY = graphOn
          ? stripGraphTop + GRAPH_HEIGHT - VMAF_STRIP_HEIGHT - (hasPsnr2 ? PSNR_STRIP_HEIGHT : 0) - (hasSsim2 ? SSIM_STRIP_HEIGHT : 0) - (hasMsSsim ? MSSSIM_STRIP_HEIGHT : 0)
          : stripGraphTop + (hasPsnr2 ? PSNR_STRIP_HEIGHT : 0) + (hasSsim2 ? SSIM_STRIP_HEIGHT : 0) + (hasMsSsim ? MSSSIM_STRIP_HEIGHT : 0);

        for (const [t, v] of vmafMap) {
          const x = t * pxPerSec - sl;
          if (x < -2 || x > w + 2) continue;
          ctx.fillStyle = vmafColor(v);
          ctx.fillRect(x, vmafStripY, 2, VMAF_STRIP_HEIGHT);
        }

        ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.fillText("VMAF", w - 4, vmafStripY + VMAF_STRIP_HEIGHT - 1);
        ctx.font = FONT;
        ctx.textAlign = "center";
      }

      // ── In/Out markers ──
      const inPt = inPointRef.current;
      const outPt = outPointRef.current;

      if (inPt != null && outPt != null) {
        const inX = inPt * pxPerSec - sl - ctoPx;
        const outX = outPt * pxPerSec - sl - ctoPx;
        ctx.fillStyle = "rgba(245, 197, 24, 0.1)";
        ctx.fillRect(inX, 0, outX - inX, h);
      }

      if (inPt != null) {
        const inX = inPt * pxPerSec - sl - ctoPx;
        if (inX >= -2 && inX <= w + 2) {
          ctx.strokeStyle = MARKER_COLOR;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(inX, 0);
          ctx.lineTo(inX, h);
          ctx.stroke();
          // Bracket shape
          ctx.beginPath();
          ctx.moveTo(inX + 6, 0);
          ctx.lineTo(inX, 0);
          ctx.lineTo(inX, 8);
          ctx.strokeStyle = MARKER_COLOR;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(inX + 6, h);
          ctx.lineTo(inX, h);
          ctx.lineTo(inX, h - 8);
          ctx.stroke();
        }
      }

      if (outPt != null) {
        const outX = outPt * pxPerSec - sl - ctoPx;
        if (outX >= -2 && outX <= w + 2) {
          ctx.strokeStyle = MARKER_COLOR;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(outX, 0);
          ctx.lineTo(outX, h);
          ctx.stroke();
          // Bracket shape (mirrored)
          ctx.beginPath();
          ctx.moveTo(outX - 6, 0);
          ctx.lineTo(outX, 0);
          ctx.lineTo(outX, 8);
          ctx.strokeStyle = MARKER_COLOR;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(outX - 6, h);
          ctx.lineTo(outX, h);
          ctx.lineTo(outX, h - 8);
          ctx.stroke();
        }
      }

      // ── Scene markers ──
      const sd = sceneDataRef.current;
      if (sd && sd.boundaries.length > 0) {
        ctx.strokeStyle = SCENE_LINE_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);

        for (const boundary of sd.boundaries) {
          const bx = boundary * pxPerSec - sl - ctoPx;
          if (bx < -2 || bx > w + 2) continue;
          ctx.beginPath();
          ctx.moveTo(bx, 0);
          ctx.lineTo(bx, h);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // Scene labels in ruler area
        ctx.font = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        ctx.fillStyle = SCENE_LABEL_COLOR;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";

        // S1 at position 0 (video start)
        const s1x = 0 * pxPerSec - sl - ctoPx;
        if (s1x >= -30 && s1x <= w + 2) {
          ctx.fillText("S1", s1x + 3, 2);
        }
        // S2, S3, ... at each boundary
        for (let i = 0; i < sd.boundaries.length; i++) {
          const bx = sd.boundaries[i] * pxPerSec - sl - ctoPx;
          if (bx < -30 || bx > w + 2) continue;
          ctx.fillText(`S${i + 2}`, bx + 3, 2);
        }

        // Reset text settings
        ctx.font = FONT;
        ctx.textAlign = "center";
      }

      // ── Playhead ──
      const playheadX = time * pxPerSec - sl - ctoPx;
      if (playheadX >= -2 && playheadX <= w + 2) {
        ctx.strokeStyle = PLAYHEAD_COLOR_CANVAS;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, h);
        ctx.stroke();

        // Playhead cap (triangle)
        ctx.fillStyle = PLAYHEAD_COLOR_CANVAS;
        ctx.beginPath();
        ctx.moveTo(playheadX - 5, 0);
        ctx.lineTo(playheadX + 5, 0);
        ctx.lineTo(playheadX, 6);
        ctx.closePath();
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(paint);
    }

    rafRef.current = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
    };
  }, [clampScroll]);

  // ── Pointer interactions for seeking ──
  const seekToX = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      // Canvas x-axis uses video time (DASH time - CTO). Convert back
      // to DASH time by adding startOffset for the seek target.
      const videoTime = (x + scrollLeftRef.current) / pxPerSecRef.current;
      const dashTime = videoTime + startOffset;
      const dur = durationRef.current;
      videoEl.currentTime = Math.max(startOffset, Math.min(dur, dashTime));
    },
    [videoEl, startOffset],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerDown = (e: PointerEvent) => {
      // Ignore right-click
      if (e.button !== 0) return;

      // Check if click is in bitrate graph region — open segment modal instead of seeking
      if (showBitrateGraphRef.current) {
        const rect = canvas.getBoundingClientRect();
        const localY = e.clientY - rect.top;
        const localX = e.clientX - rect.left;
        const h = rect.height;
        const thumbH = h - RULER_HEIGHT - GRAPH_HEIGHT;
        const graphTop = RULER_HEIGHT + thumbH;

        if (localY >= graphTop && localY <= h) {
          const time = (localX + scrollLeftRef.current) / pxPerSecRef.current;
          const bd = bitrateDataRef.current;
          const segs = bd.segments;
          for (let i = 0; i < segs.length; i++) {
            if (time >= segs[i].startTime && time < segs[i].endTime) {
              setSegmentModal({ startTime: segs[i].startTime, endTime: segs[i].endTime });
              return;
            }
          }
        }
      }

      isDraggingRef.current = true;
      setFollowMode(false);
      canvas.setPointerCapture(e.pointerId);
      seekToX(e.clientX);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDraggingRef.current) return;
      seekToX(e.clientX);
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current) return;

      // Check for scene boundary proximity
      const sd = sceneDataRef.current;
      if (sd && sd.boundaries.length > 0) {
        const rect2 = canvas.getBoundingClientRect();
        const localX2 = e.clientX - rect2.left;
        // Convert pixel to DASH time (canvas uses video time, add CTO)
        const hoverTime = (localX2 + scrollLeftRef.current) / pxPerSecRef.current + startOffsetRef.current;
        const proximityPx = 3;
        const proximityTime = proximityPx / pxPerSecRef.current;

        let hitBoundary: { sceneNum: number; time: number; boundaryIdx: number } | null = null;
        for (let i = 0; i < sd.boundaries.length; i++) {
          if (Math.abs(sd.boundaries[i] - hoverTime) <= proximityTime) {
            hitBoundary = { sceneNum: i + 2, time: sd.boundaries[i], boundaryIdx: i };
            break;
          }
        }

        if (hitBoundary) {
          sceneTooltipRef.current = { x: e.clientX, y: e.clientY, sceneNum: hitBoundary.sceneNum, time: hitBoundary.time };
          setSceneTooltip({ x: e.clientX, y: e.clientY, sceneNum: hitBoundary.sceneNum, time: hitBoundary.time });
          // Trigger boundary frame decode using original frame number (immune to CTS mismatches)
          const frameNum = sd.originalFrames?.[hitBoundary.boundaryIdx];
          if (frameNum != null) {
            requestBoundaryPreviewRef.current(hitBoundary.time, frameNum);
          }
        } else {
          if (sceneTooltipRef.current) {
            sceneTooltipRef.current = null;
            setSceneTooltip(null);
          }
        }
      } else {
        if (sceneTooltipRef.current) {
          sceneTooltipRef.current = null;
          setSceneTooltip(null);
        }
      }

      if (!showBitrateGraphRef.current) {
        if (gopTooltipRef.current) { gopTooltipRef.current = null; setGopTooltip(null); }
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const h = rect.height;
      const thumbH = h - RULER_HEIGHT - GRAPH_HEIGHT;
      const graphTop = RULER_HEIGHT + thumbH;

      // Only show tooltip when hovering over the bitrate graph region
      if (localY < graphTop || localY > h) {
        if (gopTooltipRef.current) { gopTooltipRef.current = null; setGopTooltip(null); }
        canvas.style.cursor = "crosshair";
        return;
      }

      const time = (localX + scrollLeftRef.current) / pxPerSecRef.current;
      const bd = bitrateDataRef.current;
      const segs = bd.segments;
      let hitIdx = -1;
      for (let i = 0; i < segs.length; i++) {
        if (time >= segs[i].startTime && time < segs[i].endTime) {
          hitIdx = i;
          break;
        }
      }

      if (hitIdx < 0) {
        if (gopTooltipRef.current) { gopTooltipRef.current = null; setGopTooltip(null); }
        canvas.style.cursor = "crosshair";
        return;
      }

      canvas.style.cursor = "pointer";

      // Map bitrate-graph segment index to nearest thumbnail segment index
      const times = segmentTimesRef.current;
      const segStart = segs[hitIdx].startTime;
      let thumbIdx = 0;
      for (let i = 1; i < times.length; i++) {
        if (Math.abs(times[i] - segStart) < Math.abs(times[thumbIdx] - segStart)) {
          thumbIdx = i;
        }
      }

      // Request GOP structure if not yet available
      if (!gopStructuresRef.current.has(thumbIdx)) {
        requestGopRef.current(thumbIdx);
      }

      const segDuration = segs[hitIdx].endTime - segs[hitIdx].startTime;
      const prev = gopTooltipRef.current;
      if (prev && prev.segIdx === thumbIdx) {
        // Same segment — just update position
        prev.x = e.clientX;
        prev.y = e.clientY;
        setGopTooltip({ ...prev });
      } else {
        gopTooltipRef.current = { x: e.clientX, y: e.clientY, segIdx: thumbIdx, segDuration };
        setGopTooltip({ x: e.clientX, y: e.clientY, segIdx: thumbIdx, segDuration });
      }
    };

    const onMouseLeave = () => {
      if (gopTooltipRef.current) { gopTooltipRef.current = null; setGopTooltip(null); }
      if (sceneTooltipRef.current) { sceneTooltipRef.current = null; setSceneTooltip(null); }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseleave", onMouseLeave);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [seekToX]);

  // ── Wheel for scroll and zoom ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const w = containerWidthRef.current;

      if (e.ctrlKey || e.metaKey) {
        // Zoom
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const timeBefore = (mouseX + scrollLeftRef.current) / pxPerSecRef.current;

        const dur = durationRef.current;
        const minPxPerSec = w > 0 && dur > 0 ? Math.max(MIN_PX_PER_SEC_ABSOLUTE, w / dur) : MIN_PX_PER_SEC_ABSOLUTE;
        const maxPxPerSec = thumbWRef.current > 0 ? fpsRef.current * thumbWRef.current : 5000;
        pxPerSecRef.current = Math.max(
          minPxPerSec,
          Math.min(maxPxPerSec, pxPerSecRef.current * zoomFactor),
        );

        // Keep the time under the cursor in the same screen position
        scrollLeftRef.current = clampScroll(
          timeBefore * pxPerSecRef.current - mouseX,
          w,
        );
        setFollowMode(false);
      } else {
        // Horizontal scroll
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        scrollLeftRef.current = clampScroll(scrollLeftRef.current + delta, w);
        setFollowMode(false);
      }
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [clampScroll]);

  // ── Keyboard zoom (+/-) ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const isZoomIn = e.key === "+" || e.key === "=";
      const isZoomOut = e.key === "-" || e.key === "_";
      if (!isZoomIn && !isZoomOut) return;

      e.preventDefault();
      const w = containerWidthRef.current;
      const zoomFactor = isZoomIn ? 1.15 : 1 / 1.15;

      // Anchor zoom on the playhead position (video time = DASH - CTO)
      const time = currentTimeRef.current;
      const cto = startOffsetRef.current;
      const playheadScreenX = time * pxPerSecRef.current - cto * pxPerSecRef.current - scrollLeftRef.current;
      const anchorX = Math.max(0, Math.min(w, playheadScreenX));

      const timeBefore = (anchorX + scrollLeftRef.current) / pxPerSecRef.current;

      const dur = durationRef.current;
      const minPxPerSec = w > 0 && dur > 0 ? Math.max(MIN_PX_PER_SEC_ABSOLUTE, w / dur) : MIN_PX_PER_SEC_ABSOLUTE;
      const maxPxPerSec = thumbWRef.current > 0 ? fpsRef.current * thumbWRef.current : 5000;
      pxPerSecRef.current = Math.max(
        minPxPerSec,
        Math.min(maxPxPerSec, pxPerSecRef.current * zoomFactor),
      );

      scrollLeftRef.current = clampScroll(
        timeBefore * pxPerSecRef.current - anchorX,
        w,
      );
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [clampScroll]);

  // ── Dismiss context menu on outside click ──
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => setCtxMenu(null);
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [ctxMenu]);

  // ── Context menu handler (native listener so stopPropagation fires
  //    before the VideoControls listener on the parent container) ──
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = wrapper.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const clickTime = (localX + scrollLeftRef.current) / pxPerSecRef.current;
      const dur = durationRef.current;
      let clampedTime = Math.max(0, Math.min(dur, clickTime));

      // Snap to the actual frame displayed at this pixel position.
      // We compute two things:
      // 1. clampedTime — snapped to the segment start for segment lookup
      // 2. framePosition — normalized position (0..1) within the segment's
      //    frames, so the worker can capture the correct frame by display-order
      //    index regardless of CTS offset differences between streams
      const times = segmentTimesRef.current;
      const pxPerSec = pxPerSecRef.current;
      const thumbW = thumbWRef.current;
      let framePosition: number | undefined;

      if (times.length > 0 && thumbW > 0) {
        // Find which segment the click falls in
        let segIdx = times.length - 1;
        for (let i = 0; i < times.length; i++) {
          const segEnd = i + 1 < times.length ? times[i + 1] : dur;
          if (clampedTime < segEnd) {
            segIdx = i;
            break;
          }
        }

        const segStart = times[segIdx];
        const segEnd = segIdx + 1 < times.length ? times[segIdx + 1] : dur;
        const segDuration = segEnd - segStart;
        const segWidth = segDuration * pxPerSec;

        if (segWidth <= thumbW) {
          // Packed mode: the displayed frame is the I-frame (first frame)
          clampedTime = segStart;
          framePosition = 0;
        } else {
          // Gap mode: find which slot the click falls in and compute
          // the normalized frame position for position-based save
          const count = Math.max(2, Math.ceil(segWidth / thumbW));
          const slotW = segWidth / count;
          const relPx = (clampedTime - segStart) * pxPerSec;
          const j = Math.min(count - 1, Math.max(0, Math.floor(relPx / slotW)));

          const intraArr = intraFramesMapRef.current.get(segIdx);
          const intraCount = intraArr?.length ?? 0;

          if (intraCount > 1) {
            // Compute arrIdx (same formula as paint loop)
            const arrIdx = Math.round((j / (count - 1)) * (intraCount - 1));
            // Normalized position: arrIdx / (intraCount - 1) → 0..1
            framePosition = arrIdx / (intraCount - 1);
          } else {
            framePosition = 0;
          }

          // Also snap clampedTime for segment lookup by the worker
          clampedTime = segStart + (segDuration * (j + 0.5)) / count;
        }
      }

      ctxMenuTimeRef.current = clampedTime;
      ctxMenuFramePositionRef.current = framePosition;
      setCtxMenu({ x: e.clientX, y: e.clientY, time: clampedTime });
    };
    wrapper.addEventListener("contextmenu", onContextMenu);
    return () => wrapper.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // ── Fallback states ──
  if (!supported) {
    return (
      <div
        className="vp-filmstrip-panel"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <button className="vp-filmstrip-close" onClick={onClose}>
          ×
        </button>
        <div className="vp-filmstrip-fallback">
          Filmstrip timeline requires a browser with WebCodecs support
        </div>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className={`vp-filmstrip-panel${showBitrateGraph ? " vp-filmstrip-graph" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      <button className="vp-filmstrip-close" onClick={onClose}>
        ×
      </button>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      {duration <= 0 && (
        <div className="vp-filmstrip-fallback">Waiting for video duration...</div>
      )}
      {ctxMenu && (
        <div
          className="vp-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <div
            className="vp-context-menu-item"
            onClick={() => {
              setFollowMode((v) => !v);
              setCtxMenu(null);
            }}
          >
            <span className="vp-context-menu-check">
              {followMode ? "✓" : ""}
            </span>
            Follow mode
          </div>
          <div
            className="vp-context-menu-item"
            onClick={() => {
              setShowBitrateGraph((v) => !v);
              setCtxMenu(null);
            }}
          >
            <span className="vp-context-menu-check">
              {showBitrateGraph ? "✓" : ""}
            </span>
            Bitrate graph
          </div>
          <div className="vp-context-menu-separator" />
          <div
            className="vp-context-menu-item"
            onClick={saveFrame}
          >
            <SaveSegmentIcon />
            Save frame...
          </div>
          {(onLoadSceneData || onClearSceneData) && (
            <>
              <div className="vp-context-menu-separator" />
              {sceneData && onClearSceneData ? (
                <div
                  className="vp-context-menu-item"
                  onClick={() => {
                    onClearSceneData();
                    setCtxMenu(null);
                  }}
                >
                  <SceneMarkersIcon />
                  Clear scene data
                </div>
              ) : onLoadSceneData ? (
                <div
                  className="vp-context-menu-item"
                  onClick={() => {
                    onLoadSceneData();
                    setCtxMenu(null);
                  }}
                >
                  <SceneMarkersIcon />
                  Load scene data...
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
      {gopTooltip && (() => {
        const gop = gopStructures.get(gopTooltip.segIdx);
        if (!gop || gop.length === 0) return null;
        const maxSize = Math.max(...gop.map((f) => f.size), 1);
        const BAR_HEIGHT = 32;
        const barWidth = gop.length <= 100 ? 2 : 1;
        const totalBytes = gop.reduce((s, f) => s + f.size, 0);
        const fmtBytes = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`;

        // Per-type min/max stats
        const typeStats = (type: FrameType) => {
          const sizes = gop.filter((f) => f.type === type).map((f) => f.size);
          if (sizes.length === 0) return null;
          return { count: sizes.length, min: Math.min(...sizes), max: Math.max(...sizes) };
        };
        const iStats = typeStats("I");
        const pStats = typeStats("P");
        const bStats = typeStats("B");

        return (
          <div
            className="vp-gop-tooltip"
            style={{ left: gopTooltip.x, top: gopTooltip.y }}
          >
            <div className="vp-gop-tooltip-size">{fmtBytes(totalBytes)} · {gopTooltip.segDuration.toFixed(2)}s</div>
            <div className="vp-gop-tooltip-label">GOP ({gop.length} frames)</div>
            <div className="vp-gop-tooltip-bars">
              {gop.map((f, i) => (
                <div
                  key={i}
                  className={`vp-gop-bar vp-gop-bar-${f.type}`}
                  style={{ width: barWidth, height: Math.max(2, (f.size / maxSize) * BAR_HEIGHT) }}
                />
              ))}
            </div>
            <div className="vp-gop-tooltip-stats">
              {iStats && <div><span className="vp-gop-stat-I">I</span> <span className="vp-gop-stat-dim">{iStats.count}x</span> {fmtBytes(iStats.min)}{iStats.count > 1 ? ` \u2013 ${fmtBytes(iStats.max)}` : ""}</div>}
              {pStats && <div><span className="vp-gop-stat-P">P</span> <span className="vp-gop-stat-dim">{pStats.count}x</span> {fmtBytes(pStats.min)}{pStats.count > 1 ? ` \u2013 ${fmtBytes(pStats.max)}` : ""}</div>}
              {bStats && <div><span className="vp-gop-stat-B">B</span> <span className="vp-gop-stat-dim">{bStats.count}x</span> {fmtBytes(bStats.min)}{bStats.count > 1 ? ` \u2013 ${fmtBytes(bStats.max)}` : ""}</div>}
            </div>
          </div>
        );
      })()}
      {sceneTooltip && (() => {
        const preview = boundaryPreviews.get(sceneTooltip.time);
        const hasBefore = preview?.before != null;
        const hasAfter = preview?.after != null;
        const hasFrames = hasBefore || hasAfter;
        // Use bitmap dimensions for canvas (worker produces thumbnails at correct aspect ratio)
        const bmpW = preview?.before?.width ?? preview?.after?.width ?? 160;
        const bmpH = preview?.before?.height ?? preview?.after?.height ?? 90;
        return (
          <div
            className="vp-gop-tooltip"
            style={{ left: sceneTooltip.x, top: sceneTooltip.y }}
          >
            <div className="vp-gop-tooltip-label" style={{ color: "rgba(255, 160, 40, 0.85)" }}>
              Scene {sceneTooltip.sceneNum} · {formatTime(sceneTooltip.time)}
            </div>
            {hasFrames && (
              <div className="vp-boundary-frames">
                <canvas
                  key={`${sceneTooltip.time}-before`}
                  className="vp-boundary-frame"
                  width={bmpW}
                  height={bmpH}
                  ref={(el) => {
                    if (el && preview?.before) {
                      const ctx = el.getContext("2d");
                      if (ctx) ctx.drawImage(preview.before, 0, 0, bmpW, bmpH);
                    }
                  }}
                />
                <div className="vp-boundary-divider" style={{ height: bmpH }} />
                <canvas
                  key={`${sceneTooltip.time}-after`}
                  className="vp-boundary-frame"
                  width={bmpW}
                  height={bmpH}
                  ref={(el) => {
                    if (el && preview?.after) {
                      const ctx = el.getContext("2d");
                      if (ctx) ctx.drawImage(preview.after, 0, 0, bmpW, bmpH);
                    }
                  }}
                />
              </div>
            )}
            {!hasFrames && preview === undefined && (
              <div className="vp-boundary-loading">Loading...</div>
            )}
          </div>
        );
      })()}
      {segmentModal && (
        <SegmentFramesModal
          segmentStartTime={segmentModal.startTime}
          segmentEndTime={segmentModal.endTime}
          decodeSegmentFrames={decodeSegmentFrames}
          cancelDecodeSegment={cancelDecodeSegment}
          onClose={() => setSegmentModal(null)}
        />
      )}
    </div>
  );
}
