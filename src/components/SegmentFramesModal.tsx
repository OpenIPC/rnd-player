import { useEffect, useRef, useState, useCallback } from "react";
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
}

const FRAME_BORDER_COLORS: Record<FrameType, string> = {
  I: "rgb(255, 50, 50)",
  P: "rgb(60, 130, 255)",
  B: "rgb(50, 200, 50)",
};

function formatBytes(b: number): string {
  if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function FrameCanvas({ bitmap, frameType }: { bitmap: ImageBitmap; frameType: FrameType }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(bitmap, 0, 0);
  }, [bitmap]);

  // Wrapper div uses padding-bottom percentage to set the correct aspect ratio.
  // Canvas elements don't auto-scale height like <img>, and CSS aspect-ratio
  // can fail inside flex containers when the only child is position:absolute.
  // Padding-bottom percentage is always relative to the containing block's
  // width, making this technique universally reliable.
  return (
    <div
      className="vp-segment-frame-ratio"
      style={{
        paddingBottom: `${(bitmap.height / bitmap.width) * 100}%`,
        borderColor: FRAME_BORDER_COLORS[frameType],
      }}
    >
      <canvas ref={canvasRef} className="vp-segment-frame-canvas" />
    </div>
  );
}

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
  const requestIdRef = useRef<string | null>(null);
  const framesRef = useRef<FrameEntry[]>([]);

  useEffect(() => {
    const onFrame = (frame: SegmentFrame) => {
      const entry: FrameEntry = {
        frameIndex: frame.frameIndex,
        bitmap: frame.bitmap,
        frameType: frame.frameType,
        sizeBytes: frame.sizeBytes,
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
      // Close all ImageBitmaps
      for (const f of framesRef.current) {
        f.bitmap.close();
      }
      framesRef.current = [];
    };
  }, [segmentStartTime, decodeSegmentFrames, cancelDecodeSegment]);

  // ESC key to close
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const onBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const segDuration = segmentEndTime - segmentStartTime;

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
        <div className="vp-segment-frames-grid">
          {frames.map((f) => (
            <div key={f.frameIndex} className="vp-segment-frame-card">
              <FrameCanvas bitmap={f.bitmap} frameType={f.frameType} />
              <div className="vp-segment-frame-meta">
                <span className={`vp-segment-frame-type vp-segment-frame-type-${f.frameType}`}>
                  {f.frameType}
                </span>
                <span className="vp-segment-frame-index">#{f.frameIndex}</span>
                <span className="vp-segment-frame-size">{formatBytes(f.sizeBytes)}</span>
              </div>
            </div>
          ))}
          {loading &&
            totalFrames > 0 &&
            Array.from({ length: totalFrames - frames.length }, (_, i) => (
              <div key={`ph-${i}`} className="vp-segment-frame-card">
                <div className="vp-segment-frame-placeholder" />
              </div>
            ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
