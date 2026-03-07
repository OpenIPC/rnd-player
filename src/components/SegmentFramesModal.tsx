import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import type { FrameType } from "../types/thumbnailWorker.types";
import type { DecodeSegmentFramesFn, CancelDecodeSegmentFn, SegmentFrame } from "../hooks/useThumbnailGenerator";
import { formatTime } from "../utils/formatTime";

interface SegmentFramesModalProps {
  segmentStartTime: number;
  segmentEndTime: number;
  decodeSegmentFrames: DecodeSegmentFramesFn;
  cancelDecodeSegment: CancelDecodeSegmentFn;
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

/* ── Frame thumbnail canvas ── */

function FrameCanvas({ bitmap, frameType, onClick }: { bitmap: ImageBitmap; frameType: FrameType; onClick: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(bitmap, 0, 0);
  }, [bitmap]);

  return (
    <div
      className="vp-segment-frame-ratio"
      style={{
        paddingBottom: `${(bitmap.height / bitmap.width) * 100}%`,
        borderColor: FRAME_BORDER_COLORS[frameType],
      }}
      onClick={onClick}
    >
      <canvas ref={canvasRef} className="vp-segment-frame-canvas" />
    </div>
  );
}

/* ── Full-size frame preview ── */

function FramePreview({
  frame,
  frames,
  frameWidth,
  frameHeight,
  onClose,
  onNavigate,
}: {
  frame: FrameEntry;
  frames: FrameEntry[];
  frameWidth: number;
  frameHeight: number;
  onClose: () => void;
  onNavigate: (frameIndex: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = frame.bitmap.width;
    canvas.height = frame.bitmap.height;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(frame.bitmap, 0, 0);
  }, [frame]);

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
          <canvas ref={canvasRef} className="vp-frame-preview-canvas" />
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

/* ── Main modal ── */

export default function SegmentFramesModal({
  segmentStartTime,
  segmentEndTime,
  decodeSegmentFrames,
  cancelDecodeSegment,
  onClose,
}: SegmentFramesModalProps) {
  const [frames, setFrames] = useState<FrameEntry[]>([]);
  const [totalFrames, setTotalFrames] = useState(0);
  const [loading, setLoading] = useState(true);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const framesRef = useRef<FrameEntry[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);

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
          <button className="vp-segment-frames-close" onClick={onClose}>
            &times;
          </button>
        </div>
        {!loading && frames.length > 0 && (
          <SegmentStats frames={frames} segDuration={segDuration} width={frameWidth} height={frameHeight} />
        )}
        <SizeBarChart frames={frames} onBarClick={scrollToFrame} />
        <div className="vp-segment-frames-grid" ref={gridRef}>
          {frames.map((f) => {
            const showDts = Math.abs(f.cts - f.dts) > 0.0005;
            return (
              <div key={f.frameIndex} className="vp-segment-frame-card" data-frame-index={f.frameIndex}>
                <FrameCanvas bitmap={f.bitmap} frameType={f.frameType} onClick={() => setPreviewIndex(f.frameIndex)} />
                <div className="vp-segment-frame-meta">
                  <span className={`vp-segment-frame-type vp-segment-frame-type-${f.frameType}`}>
                    {f.frameType}
                  </span>
                  <span className="vp-segment-frame-index">#{f.frameIndex}</span>
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
        return (
          <FramePreview
            frame={pf}
            frames={frames}
            frameWidth={frameWidth}
            frameHeight={frameHeight}
            onClose={() => setPreviewIndex(null)}
            onNavigate={setPreviewIndex}
          />
        );
      })()}
    </div>,
    document.body,
  );
}
