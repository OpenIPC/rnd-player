import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import shaka from "shaka-player";
import type { FrameType } from "../types/thumbnailWorker.types";
import type { DecodeSegmentFramesFn, CancelDecodeSegmentFn, SegmentFrame } from "../hooks/useThumbnailGenerator";
import type { QpMapWorkerRequest, QpMapWorkerResponse, PerFrameQp, QpMapSegmentResult } from "../types/qpMapWorker.types";
import { extractInitSegmentUrl } from "../utils/extractInitSegmentUrl";
import { formatTime } from "../utils/formatTime";

interface SegmentFramesModalProps {
  segmentStartTime: number;
  segmentEndTime: number;
  decodeSegmentFrames: DecodeSegmentFramesFn;
  cancelDecodeSegment: CancelDecodeSegmentFn;
  player: shaka.Player;
  clearKey?: string;
  onClose: () => void;
}

interface FrameEntry {
  frameIndex: number;
  bitmap: ImageBitmap;
  frameType: FrameType;
  sizeBytes: number;
  cts: number;
  dts: number;
  duration: number;
}

const FRAME_BORDER_COLORS: Record<FrameType, string> = {
  I: "rgb(255, 50, 50)",
  P: "rgb(60, 130, 255)",
  B: "rgb(50, 200, 50)",
};

const FRAME_BAR_COLORS: Record<FrameType, string> = {
  I: "rgba(255, 50, 50, 0.85)",
  P: "rgba(60, 130, 255, 0.85)",
  B: "rgba(50, 200, 50, 0.85)",
};

function formatBytes(b: number): string {
  if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function formatBitsPerPixel(sizeBytes: number, width: number, height: number): string {
  const bpp = (sizeBytes * 8) / (width * height);
  return bpp.toFixed(3);
}

/* ── QP heatmap color (same 5-stop gradient as QpHeatmapOverlay) ── */

function qpToColor(qp: number, minQp: number, maxQp: number): [number, number, number] {
  const range = maxQp - minQp;
  const t = range > 0 ? (qp - minQp) / range : 0.5;

  let r: number, g: number, b: number;
  if (t < 0.25) {
    const s = t / 0.25;
    r = 0; g = Math.round(255 * s); b = 255;
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    r = 0; g = 255; b = Math.round(255 * (1 - s));
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    r = Math.round(255 * s); g = 255; b = 0;
  } else {
    const s = (t - 0.75) / 0.25;
    r = 255; g = Math.round(255 * (1 - s)); b = 0;
  }

  return [r, g, b];
}

/* ── Frame size bar chart ── */

function SizeBarChart({
  frames,
  onBarClick,
}: {
  frames: FrameEntry[];
  onBarClick: (index: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; text: string } | null>(null);

  const maxSize = useMemo(() => {
    let m = 0;
    for (const f of frames) if (f.sizeBytes > m) m = f.sizeBytes;
    return m;
  }, [frames]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0 || maxSize === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const barGap = 1;
    const barWidth = Math.max(2, (w - barGap * (frames.length - 1)) / frames.length);
    const totalBarWidth = barWidth + barGap;

    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const barH = Math.max(1, (f.sizeBytes / maxSize) * (h - 2));
      const x = i * totalBarWidth;
      ctx.fillStyle = FRAME_BAR_COLORS[f.frameType];
      ctx.fillRect(x, h - barH, barWidth, barH);
    }
  }, [frames, maxSize]);

  const handleMouse = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || frames.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const barGap = 1;
      const barWidth = Math.max(2, (rect.width - barGap * (frames.length - 1)) / frames.length);
      const idx = Math.floor(x / (barWidth + barGap));
      if (idx >= 0 && idx < frames.length) {
        const f = frames[idx];
        setTooltip({
          x: e.clientX - rect.left,
          text: `#${f.frameIndex}  ${f.frameType}  ${formatBytes(f.sizeBytes)}`,
        });
      } else {
        setTooltip(null);
      }
    },
    [frames],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || frames.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const barGap = 1;
      const barWidth = Math.max(2, (rect.width - barGap * (frames.length - 1)) / frames.length);
      const idx = Math.floor(x / (barWidth + barGap));
      if (idx >= 0 && idx < frames.length) {
        onBarClick(frames[idx].frameIndex);
      }
    },
    [frames, onBarClick],
  );

  if (frames.length === 0) return null;

  return (
    <div className="vp-segment-sizechart">
      <canvas
        ref={canvasRef}
        className="vp-segment-sizechart-canvas"
        onMouseMove={handleMouse}
        onMouseLeave={() => setTooltip(null)}
        onClick={handleClick}
      />
      {tooltip && (
        <div
          className="vp-segment-sizechart-tooltip"
          style={{ left: tooltip.x }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

/* ── Segment summary stats ── */

function SegmentStats({
  frames,
  segDuration,
  width,
  height,
}: {
  frames: FrameEntry[];
  segDuration: number;
  width: number;
  height: number;
}) {
  const stats = useMemo(() => {
    if (frames.length === 0) return null;

    const counts: Record<FrameType, number> = { I: 0, P: 0, B: 0 };
    const sizes: Record<FrameType, number> = { I: 0, P: 0, B: 0 };
    let totalSize = 0;
    for (const f of frames) {
      counts[f.frameType]++;
      sizes[f.frameType] += f.sizeBytes;
      totalSize += f.sizeBytes;
    }

    // GOP pattern string
    const gopPattern = frames.map((f) => f.frameType).join(" ");

    // Average bitrate
    const avgBitrate = segDuration > 0 ? (totalSize * 8) / segDuration : 0;

    // Size ratio (normalize to smallest non-zero average)
    const avgSizes: Partial<Record<FrameType, number>> = {};
    for (const t of ["I", "P", "B"] as FrameType[]) {
      if (counts[t] > 0) avgSizes[t] = sizes[t] / counts[t];
    }
    const minAvg = Math.min(...Object.values(avgSizes).filter((v) => v > 0));

    let ratioStr = "";
    if (minAvg > 0) {
      const parts: string[] = [];
      for (const t of ["I", "P", "B"] as FrameType[]) {
        if (avgSizes[t] != null) parts.push(`${t}:${(avgSizes[t]! / minAvg).toFixed(1)}`);
      }
      ratioStr = parts.join(" ");
    }

    // Bits per pixel (segment average)
    const avgBpp = width > 0 && height > 0 ? (totalSize * 8) / (width * height * frames.length) : 0;

    return { counts, totalSize, avgBitrate, gopPattern, ratioStr, avgBpp };
  }, [frames, segDuration, width, height]);

  if (!stats) return null;

  const formatBitrate = (bps: number) => {
    if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`;
    if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kbps`;
    return `${bps.toFixed(0)} bps`;
  };

  return (
    <div className="vp-segment-stats">
      <span className="vp-segment-stats-gop" title={stats.gopPattern}>
        {stats.counts.I > 0 && <span className="vp-segment-frame-type-I">{stats.counts.I}I</span>}
        {stats.counts.P > 0 && <span className="vp-segment-frame-type-P"> {stats.counts.P}P</span>}
        {stats.counts.B > 0 && <span className="vp-segment-frame-type-B"> {stats.counts.B}B</span>}
      </span>
      <span className="vp-segment-stats-sep" />
      <span>{formatBytes(stats.totalSize)}</span>
      <span className="vp-segment-stats-sep" />
      <span>{formatBitrate(stats.avgBitrate)}</span>
      <span className="vp-segment-stats-sep" />
      <span title="Average bits per pixel">{stats.avgBpp.toFixed(3)} bpp</span>
      {stats.ratioStr && (
        <>
          <span className="vp-segment-stats-sep" />
          <span title="Avg size ratio (I:P:B)">{stats.ratioStr}</span>
        </>
      )}
    </div>
  );
}

/* ── QP heatmap overlay on a frame thumbnail ── */

function QpOverlayCanvas({
  qpData,
  globalMinQp,
  globalMaxQp,
  widthMbs,
  heightMbs,
  bitmapWidth,
  bitmapHeight,
}: {
  qpData: PerFrameQp;
  globalMinQp: number;
  globalMaxQp: number;
  widthMbs: number;
  heightMbs: number;
  bitmapWidth: number;
  bitmapHeight: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = bitmapWidth;
    canvas.height = bitmapHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mbW = bitmapWidth / widthMbs;
    const mbH = bitmapHeight / heightMbs;

    ctx.globalAlpha = 0.5;
    for (let row = 0; row < heightMbs; row++) {
      for (let col = 0; col < widthMbs; col++) {
        const idx = row * widthMbs + col;
        if (idx >= qpData.qpValues.length) continue;
        const [r, g, b] = qpToColor(qpData.qpValues[idx], globalMinQp, globalMaxQp);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(col * mbW, row * mbH, Math.ceil(mbW), Math.ceil(mbH));
      }
    }
  }, [qpData, globalMinQp, globalMaxQp, widthMbs, heightMbs, bitmapWidth, bitmapHeight]);

  return <canvas ref={canvasRef} className="vp-segment-frame-qp-canvas" />;
}

/* ── Frame thumbnail canvas ── */

function FrameCanvasInner({ bitmap }: { bitmap: ImageBitmap }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(bitmap, 0, 0);
  }, [bitmap]);

  return <canvas ref={canvasRef} className="vp-segment-frame-canvas" />;
}

/* ── Full-size frame preview ── */

function FramePreview({
  frame,
  frames,
  frameWidth,
  frameHeight,
  qpData,
  qpSegment,
  onClose,
  onNavigate,
}: {
  frame: FrameEntry;
  frames: FrameEntry[];
  frameWidth: number;
  frameHeight: number;
  qpData: PerFrameQp | null;
  qpSegment: QpMapSegmentResult | null;
  onClose: () => void;
  onNavigate: (frameIndex: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qpCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = frame.bitmap.width;
    canvas.height = frame.bitmap.height;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(frame.bitmap, 0, 0);
  }, [frame]);

  useEffect(() => {
    const canvas = qpCanvasRef.current;
    if (!canvas || !qpData || !qpSegment) return;

    canvas.width = frame.bitmap.width;
    canvas.height = frame.bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { widthMbs, heightMbs, globalMinQp, globalMaxQp } = qpSegment;
    const mbW = frame.bitmap.width / widthMbs;
    const mbH = frame.bitmap.height / heightMbs;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 0.5;
    for (let row = 0; row < heightMbs; row++) {
      for (let col = 0; col < widthMbs; col++) {
        const idx = row * widthMbs + col;
        if (idx >= qpData.qpValues.length) continue;
        const [r, g, b] = qpToColor(qpData.qpValues[idx], globalMinQp, globalMaxQp);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(col * mbW, row * mbH, Math.ceil(mbW), Math.ceil(mbH));
      }
    }
  }, [frame, qpData, qpSegment]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = frames.findIndex((f) => f.frameIndex === frame.frameIndex);
        if (idx > 0) onNavigate(frames[idx - 1].frameIndex);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const idx = frames.findIndex((f) => f.frameIndex === frame.frameIndex);
        if (idx < frames.length - 1) onNavigate(frames[idx + 1].frameIndex);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [frame, frames, onClose, onNavigate]);

  const posInSegment = frames.findIndex((f) => f.frameIndex === frame.frameIndex);
  const hasPrev = posInSegment > 0;
  const hasNext = posInSegment < frames.length - 1;
  const showDts = Math.abs(frame.cts - frame.dts) > 0.0005;

  return (
    <div className="vp-frame-preview-overlay" onClick={onClose}>
      <div className="vp-frame-preview-container" onClick={(e) => e.stopPropagation()}>
        {hasPrev && (
          <button
            className="vp-frame-preview-nav vp-frame-preview-prev"
            onClick={() => onNavigate(frames[posInSegment - 1].frameIndex)}
            title="Previous frame"
          >
            &#8249;
          </button>
        )}
        <div className="vp-frame-preview-content">
          <div className="vp-frame-preview-canvas-wrap">
            <canvas ref={canvasRef} className="vp-frame-preview-canvas" />
            {qpData && qpSegment && (
              <canvas ref={qpCanvasRef} className="vp-frame-preview-qp-canvas" />
            )}
          </div>
          <div className="vp-frame-preview-info">
            <span className={`vp-segment-frame-type vp-segment-frame-type-${frame.frameType}`}>
              {frame.frameType}
            </span>
            <span>#{frame.frameIndex}</span>
            <span>{formatBytes(frame.sizeBytes)}</span>
            <span>PTS {frame.cts.toFixed(3)}</span>
            {showDts && <span>DTS {frame.dts.toFixed(3)}</span>}
            <span>{(frame.duration * 1000).toFixed(1)}ms</span>
            {frameWidth > 0 && (
              <span>{formatBitsPerPixel(frame.sizeBytes, frameWidth, frameHeight)} bpp</span>
            )}
            {qpData && <span title="Average QP">QP {qpData.avgQp.toFixed(1)}</span>}
            <span className="vp-frame-preview-dim">{frame.bitmap.width}&times;{frame.bitmap.height}</span>
          </div>
        </div>
        {hasNext && (
          <button
            className="vp-frame-preview-nav vp-frame-preview-next"
            onClick={() => onNavigate(frames[posInSegment + 1].frameIndex)}
            title="Next frame"
          >
            &#8250;
          </button>
        )}
        <button className="vp-frame-preview-close" onClick={onClose} title="Close (Esc)">
          &times;
        </button>
      </div>
    </div>
  );
}

/* ── QP segment decode hook ── */

function useSegmentQp(
  player: shaka.Player,
  segmentStartTime: number,
  enabled: boolean,
  clearKey?: string,
) {
  const [qpSegment, setQpSegment] = useState<QpMapSegmentResult | null>(null);
  const [qpLoading, setQpLoading] = useState(false);
  const [qpError, setQpError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  // Detect codec support
  const codecInfo = useMemo(() => {
    const tracks = player.getVariantTracks();
    const active = tracks.find((t) => t.active);
    const codec = active?.videoCodec ?? "";
    return {
      isH264: codec.startsWith("avc1"),
      isH265: codec.startsWith("hvc1") || codec.startsWith("hev1"),
      isAv1: codec.startsWith("av01"),
    };
  }, [player]);

  const qpAvailable = codecInfo.isH264 || codecInfo.isH265 || codecInfo.isAv1;

  useEffect(() => {
    if (!enabled || !qpAvailable) return;

    setQpLoading(true);
    setQpError(null);
    setQpSegment(null);

    const worker = new Worker(
      new URL("../workers/qpMapWorker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    (async () => {
      try {
        const manifest = player.getManifest();
        if (!manifest?.variants?.length) throw new Error("No manifest");

        const tracks = player.getVariantTracks();
        const active = tracks.find((t) => t.active);
        if (!active) throw new Error("No active track");

        let videoStream: shaka.extern.Stream | null = null;
        for (const v of manifest.variants) {
          if (v.video && v.video.height === active.height && v.video.width === active.width) {
            videoStream = v.video;
            break;
          }
        }
        if (!videoStream) throw new Error("No video stream");

        await videoStream.createSegmentIndex();
        const segmentIndex = videoStream.segmentIndex;
        if (!segmentIndex) throw new Error("No segment index");

        // Get init segment URL
        const iter = segmentIndex[Symbol.iterator]();
        const firstResult = iter.next();
        if (firstResult.done || !firstResult.value) throw new Error("No segments");
        const initSegmentUrl = extractInitSegmentUrl(firstResult.value);
        if (!initSegmentUrl) throw new Error("No init segment URL");

        // Find the media segment
        let targetRef: shaka.media.SegmentReference | null = null;
        for (const ref of segmentIndex) {
          if (!ref) continue;
          if (Math.abs(ref.getStartTime() - segmentStartTime) < 0.01) {
            targetRef = ref;
            break;
          }
        }
        if (!targetRef) throw new Error("Segment not found");

        const uris = targetRef.getUris();
        if (uris.length === 0) throw new Error("No segment URI");

        const [initResp, mediaResp] = await Promise.all([
          fetch(initSegmentUrl),
          fetch(uris[0]),
        ]);
        if (!initResp.ok || !mediaResp.ok) throw new Error("Fetch failed");

        const [initSegment, mediaSegment] = await Promise.all([
          initResp.arrayBuffer(),
          mediaResp.arrayBuffer(),
        ]);

        const codecType = codecInfo.isAv1 ? "av1" : codecInfo.isH265 ? "h265" : "h264";

        const msg: QpMapWorkerRequest = {
          type: "decodeSegmentQp",
          initSegment,
          mediaSegment,
          codec: codecType,
          clearKeyHex: clearKey,
        };

        worker.onmessage = (e: MessageEvent<QpMapWorkerResponse>) => {
          setQpLoading(false);
          if (e.data.type === "qpSegment") {
            setQpSegment(e.data);
          } else if (e.data.type === "error") {
            setQpError(e.data.message);
          }
        };

        worker.postMessage(msg, [initSegment, mediaSegment]);
      } catch (err) {
        setQpLoading(false);
        setQpError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [enabled, qpAvailable, player, segmentStartTime, clearKey, codecInfo]);

  return { qpSegment, qpLoading, qpError, qpAvailable };
}

/* ── Main modal ── */

export default function SegmentFramesModal({
  segmentStartTime,
  segmentEndTime,
  decodeSegmentFrames,
  cancelDecodeSegment,
  player,
  clearKey,
  onClose,
}: SegmentFramesModalProps) {
  const [frames, setFrames] = useState<FrameEntry[]>([]);
  const [totalFrames, setTotalFrames] = useState(0);
  const [loading, setLoading] = useState(true);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [showQp, setShowQp] = useState(false);
  const requestIdRef = useRef<string | null>(null);
  const framesRef = useRef<FrameEntry[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);

  const { qpSegment, qpLoading, qpAvailable } = useSegmentQp(
    player, segmentStartTime, showQp, clearKey,
  );

  useEffect(() => {
    const onFrame = (frame: SegmentFrame) => {
      const entry: FrameEntry = {
        frameIndex: frame.frameIndex,
        bitmap: frame.bitmap,
        frameType: frame.frameType,
        sizeBytes: frame.sizeBytes,
        cts: frame.cts,
        dts: frame.dts,
        duration: frame.duration,
      };
      framesRef.current = [...framesRef.current, entry].sort((a, b) => a.frameIndex - b.frameIndex);
      setFrames(framesRef.current);
      setTotalFrames(frame.totalFrames);
    };

    const onDone = (total: number) => {
      setTotalFrames(total);
      setLoading(false);
    };

    const id = decodeSegmentFrames(segmentStartTime, onFrame, onDone);
    requestIdRef.current = id;

    if (!id) {
      queueMicrotask(() => setLoading(false));
    }

    return () => {
      if (requestIdRef.current) {
        cancelDecodeSegment(requestIdRef.current);
      }
      for (const f of framesRef.current) {
        f.bitmap.close();
      }
      framesRef.current = [];
    };
  }, [segmentStartTime, decodeSegmentFrames, cancelDecodeSegment]);

  // ESC key to close (preview handles its own ESC via capture phase)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && previewIndex == null) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, previewIndex]);

  const onBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const scrollToFrame = useCallback((frameIndex: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const card = grid.querySelector(`[data-frame-index="${frameIndex}"]`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const segDuration = segmentEndTime - segmentStartTime;

  // Use first frame's bitmap dimensions for bits/px
  const frameWidth = frames[0]?.bitmap.width ?? 0;
  const frameHeight = frames[0]?.bitmap.height ?? 0;

  return createPortal(
    <div className="vp-segment-frames-overlay" onClick={onBackdropClick}>
      <div className="vp-segment-frames-modal" onClick={(e) => e.stopPropagation()}>
        <div className="vp-segment-frames-header">
          <div className="vp-segment-frames-title">
            Segment {formatTime(segmentStartTime)} &ndash; {formatTime(segmentEndTime)}
            <span className="vp-segment-frames-duration">{segDuration.toFixed(2)}s</span>
          </div>
          <div className="vp-segment-frames-status">
            {loading
              ? `Decoding ${frames.length}/${totalFrames || "?"} frames...`
              : `${frames.length} frames`}
          </div>
          {qpAvailable && (
            <button
              className={`vp-segment-qp-toggle ${showQp ? "vp-segment-qp-toggle-active" : ""}`}
              onClick={() => setShowQp((v) => !v)}
              title={showQp ? "Hide QP heatmap" : "Show per-frame QP heatmap"}
            >
              QP
              {qpLoading && <span className="vp-segment-qp-spinner" />}
            </button>
          )}
          <button className="vp-segment-frames-close" onClick={onClose}>
            &times;
          </button>
        </div>
        {!loading && frames.length > 0 && (
          <SegmentStats frames={frames} segDuration={segDuration} width={frameWidth} height={frameHeight} />
        )}
        <SizeBarChart frames={frames} onBarClick={scrollToFrame} />
        {showQp && qpSegment && (
          <div className="vp-segment-qp-legend">
            <span className="vp-segment-qp-legend-label">QP</span>
            <div className="vp-segment-qp-legend-bar" />
            <span className="vp-segment-qp-legend-range">{qpSegment.globalMinQp} &ndash; {qpSegment.globalMaxQp}</span>
          </div>
        )}
        <div className="vp-segment-frames-grid" ref={gridRef}>
          {frames.map((f, arrIdx) => {
            const showDts = Math.abs(f.cts - f.dts) > 0.0005;
            const frameQp = showQp && qpSegment && arrIdx < qpSegment.frames.length
              ? qpSegment.frames[arrIdx]
              : null;
            return (
              <div key={f.frameIndex} className="vp-segment-frame-card" data-frame-index={f.frameIndex}>
                <div
                  className="vp-segment-frame-ratio"
                  style={{
                    paddingBottom: `${(f.bitmap.height / f.bitmap.width) * 100}%`,
                    borderColor: FRAME_BORDER_COLORS[f.frameType],
                  }}
                  onClick={() => setPreviewIndex(f.frameIndex)}
                >
                  <FrameCanvasInner bitmap={f.bitmap} />
                  {frameQp && qpSegment && (
                    <QpOverlayCanvas
                      qpData={frameQp}
                      globalMinQp={qpSegment.globalMinQp}
                      globalMaxQp={qpSegment.globalMaxQp}
                      widthMbs={qpSegment.widthMbs}
                      heightMbs={qpSegment.heightMbs}
                      bitmapWidth={f.bitmap.width}
                      bitmapHeight={f.bitmap.height}
                    />
                  )}
                </div>
                <div className="vp-segment-frame-meta">
                  <span className={`vp-segment-frame-type vp-segment-frame-type-${f.frameType}`}>
                    {f.frameType}
                  </span>
                  <span className="vp-segment-frame-index">#{f.frameIndex}</span>
                  {frameQp && (
                    <span className="vp-segment-frame-qp" title={`QP ${frameQp.minQp}–${frameQp.maxQp}`}>
                      QP {frameQp.avgQp.toFixed(1)}
                    </span>
                  )}
                  <span className="vp-segment-frame-size">{formatBytes(f.sizeBytes)}</span>
                </div>
                <div className="vp-segment-frame-meta2">
                  <span title="Presentation time">PTS {f.cts.toFixed(3)}</span>
                  {showDts && <span title="Decode time">DTS {f.dts.toFixed(3)}</span>}
                  <span title="Frame duration">{(f.duration * 1000).toFixed(1)}ms</span>
                  {frameWidth > 0 && (
                    <span title="Bits per pixel">{formatBitsPerPixel(f.sizeBytes, frameWidth, frameHeight)} bpp</span>
                  )}
                </div>
              </div>
            );
          })}
          {loading &&
            totalFrames > 0 &&
            Array.from({ length: totalFrames - frames.length }, (_, i) => (
              <div key={`ph-${i}`} className="vp-segment-frame-card">
                <div className="vp-segment-frame-placeholder" />
              </div>
            ))}
        </div>
      </div>
      {previewIndex != null && (() => {
        const pf = frames.find((f) => f.frameIndex === previewIndex);
        if (!pf) return null;
        const pfIdx = frames.findIndex((f) => f.frameIndex === previewIndex);
        const pfQp = showQp && qpSegment && pfIdx >= 0 && pfIdx < qpSegment.frames.length
          ? qpSegment.frames[pfIdx]
          : null;
        return (
          <FramePreview
            frame={pf}
            frames={frames}
            frameWidth={frameWidth}
            frameHeight={frameHeight}
            qpData={pfQp}
            qpSegment={qpSegment}
            onClose={() => setPreviewIndex(null)}
            onNavigate={setPreviewIndex}
          />
        );
      })()}
    </div>,
    document.body,
  );
}
