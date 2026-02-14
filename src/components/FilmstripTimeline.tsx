import { useEffect, useRef, useCallback, useState } from "react";
import type shaka from "shaka-player";
import { useThumbnailGenerator } from "../hooks/useThumbnailGenerator";
import { formatTime } from "../utils/formatTime";

interface FilmstripTimelineProps {
  videoEl: HTMLVideoElement;
  player: shaka.Player;
  onClose: () => void;
  clearKey?: string;
}

const RULER_HEIGHT = 22;
const THUMB_ROW_TOP = RULER_HEIGHT;
const MIN_PX_PER_SEC = 4;
const MAX_PX_PER_SEC = 100;
const DEFAULT_PX_PER_SEC = 16;
const PLAYHEAD_COLOR = "rgb(71, 13, 179)";
const FONT = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export default function FilmstripTimeline({
  videoEl,
  player,
  onClose,
  clearKey,
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
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; time: number } | null>(null);
  const ctxMenuTimeRef = useRef(0);

  const containerWidthRef = useRef(0);
  const durationRef = useRef(0);
  const currentTimeRef = useRef(0);
  const videoAspectRef = useRef(16 / 9);

  const duration = videoEl.duration || 0;

  const { thumbnails, segmentTimes, supported, requestRange, saveFrame: workerSaveFrame } =
    useThumbnailGenerator(player, videoEl, true, clearKey);

  // Keep latest values in refs so the rAF paint loop can read them
  // without the useEffect needing to restart on every thumbnail update.
  const thumbnailsRef = useRef(thumbnails);
  const segmentTimesRef = useRef(segmentTimes);
  const requestRangeRef = useRef(requestRange);
  thumbnailsRef.current = thumbnails;
  segmentTimesRef.current = segmentTimes;
  requestRangeRef.current = requestRange;

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

    // If the right-clicked time is close to the current playback position,
    // try direct canvas capture first (fast path, works for non-DRM).
    const isCurrentFrame = Math.abs(videoEl.currentTime - targetTime) < 0.5;

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
      const bitmap = await workerSaveFrame(secs);
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
      const pxPerSec = pxPerSecRef.current;
      const dur = durationRef.current;
      const time = currentTimeRef.current;
      const scrollLeft = scrollLeftRef.current;

      ctx.clearRect(0, 0, w, h);

      if (dur <= 0) {
        rafRef.current = requestAnimationFrame(paint);
        return;
      }

      // Auto-follow playhead
      if (followModeRef.current && !isDraggingRef.current) {
        const playheadX = time * pxPerSec - scrollLeft;
        const margin = w * 0.15;
        if (playheadX < margin || playheadX > w - margin) {
          scrollLeftRef.current = clampScroll(time * pxPerSec - w / 2, w);
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
      const niceIntervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
      let tickInterval = niceIntervals[niceIntervals.length - 1];
      for (const ni of niceIntervals) {
        if (ni >= rawInterval) {
          tickInterval = ni;
          break;
        }
      }

      const startTick = Math.floor(sl / pxPerSec / tickInterval) * tickInterval;
      const endTick = Math.ceil((sl + w) / pxPerSec / tickInterval) * tickInterval;

      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.font = FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";

      for (let t = startTick; t <= endTick; t += tickInterval) {
        if (t < 0) continue;
        const x = t * pxPerSec - sl;
        if (x < -50 || x > w + 50) continue;

        // Major tick
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, RULER_HEIGHT - 6);
        ctx.lineTo(x, RULER_HEIGHT);
        ctx.stroke();

        ctx.fillText(formatTime(t), x, RULER_HEIGHT - 7);

        // Minor ticks (subdivide into 4)
        const subInterval = tickInterval / 4;
        for (let s = 1; s < 4; s++) {
          const sx = (t + s * subInterval) * pxPerSec - sl;
          if (sx < 0 || sx > w) continue;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
          ctx.beginPath();
          ctx.moveTo(sx, RULER_HEIGHT - 3);
          ctx.lineTo(sx, RULER_HEIGHT);
          ctx.stroke();
        }
      }

      // ── Thumbnail row ──
      const thumbH = h - RULER_HEIGHT;
      const thumbW = thumbH * videoAspectRef.current;
      const times = segmentTimesRef.current;

      // Only draw thumbnails visible in the current viewport
      for (let i = 0; i < times.length; i++) {
        const ts = times[i];
        const x = ts * pxPerSec - sl;

        // Skip if completely outside viewport
        if (x + thumbW / 2 < 0 || x - thumbW / 2 > w) continue;

        // Center thumbnail on its timestamp
        const drawX = x - thumbW / 2;
        const drawY = THUMB_ROW_TOP;

        const bmp = thumbnailsRef.current.get(ts);
        if (bmp) {
          ctx.drawImage(bmp, drawX, drawY, thumbW, thumbH);
          // Border
          ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
          ctx.lineWidth = 1;
          ctx.strokeRect(drawX, drawY, thumbW, thumbH);
        } else {
          // Placeholder
          ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
          ctx.fillRect(drawX, drawY, thumbW, thumbH);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
          ctx.lineWidth = 1;
          ctx.strokeRect(drawX, drawY, thumbW, thumbH);
        }
      }

      // ── Playhead ──
      const playheadX = time * pxPerSec - sl;
      if (playheadX >= -2 && playheadX <= w + 2) {
        ctx.strokeStyle = PLAYHEAD_COLOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, h);
        ctx.stroke();

        // Playhead cap (triangle)
        ctx.fillStyle = PLAYHEAD_COLOR;
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
      const time = (x + scrollLeftRef.current) / pxPerSecRef.current;
      const dur = durationRef.current;
      videoEl.currentTime = Math.max(0, Math.min(dur, time));
    },
    [videoEl],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerDown = (e: PointerEvent) => {
      // Ignore right-click
      if (e.button !== 0) return;
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

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
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

        pxPerSecRef.current = Math.max(
          MIN_PX_PER_SEC,
          Math.min(MAX_PX_PER_SEC, pxPerSecRef.current * zoomFactor),
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
      const clampedTime = Math.max(0, Math.min(dur, clickTime));
      ctxMenuTimeRef.current = clampedTime;
      setCtxMenu({ x: localX, y: e.clientY - rect.top, time: clampedTime });
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
      className="vp-filmstrip-panel"
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
          style={{ left: ctxMenu.x, top: ctxMenu.y, transform: "translateY(-100%)" }}
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
          <div className="vp-context-menu-separator" />
          <div
            className="vp-context-menu-item"
            onClick={saveFrame}
          >
            Save frame
          </div>
        </div>
      )}
    </div>
  );
}
