import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useAudioAnalyser } from "../hooks/useAudioAnalyser";
import type { ChannelLevel } from "../hooks/useAudioAnalyser";

interface AudioLevelsProps {
  videoEl: HTMLVideoElement;
  containerEl: HTMLDivElement;
  onClose: () => void;
}

/** dB scale tick marks to draw */
const DB_TICKS = [-6, -12, -24, -48];
const DB_MIN = -60;
const DB_MAX = 0;
const PEAK_DECAY_DB_PER_SEC = 10;
const METER_GAP = 6;
const LABEL_HEIGHT = 18;
const DB_READOUT_HEIGHT = 18;
const TICK_LABEL_WIDTH = 28;
const BAR_MIN_WIDTH = 16;
const BAR_MAX_WIDTH = 28;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 8;

function dbToY(dB: number, meterTop: number, meterHeight: number): number {
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, dB));
  const ratio = (clamped - DB_MIN) / (DB_MAX - DB_MIN); // 0 at bottom, 1 at top
  return meterTop + meterHeight * (1 - ratio);
}

export default function AudioLevels({ videoEl, containerEl, onClose }: AudioLevelsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const peaksRef = useRef<number[]>([]);
  const lastTimeRef = useRef(0);
  const { readLevels } = useAudioAnalyser(videoEl, true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const parent = canvas.parentElement!;
    const ctx = canvas.getContext("2d")!;

    // ResizeObserver for responsive sizing
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = parent.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    observer.observe(parent);

    function paint(timestamp: number) {
      const dt = lastTimeRef.current > 0 ? (timestamp - lastTimeRef.current) / 1000 : 0;
      lastTimeRef.current = timestamp;

      const { levels, error } = readLevels();
      const rect = parent.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);

      if (error) {
        drawError(ctx, w, h, error);
        rafRef.current = requestAnimationFrame(paint);
        return;
      }

      if (levels.length === 0) {
        rafRef.current = requestAnimationFrame(paint);
        return;
      }

      drawMeters(ctx, w, h, levels, dt);
      rafRef.current = requestAnimationFrame(paint);
    }

    function drawError(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Word-wrap the error message
      const words = msg.split(" ");
      const lines: string[] = [];
      let line = "";
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > w - 8) {
          if (line) lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
      const lineHeight = 14;
      const startY = h / 2 - ((lines.length - 1) * lineHeight) / 2;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], w / 2, startY + i * lineHeight);
      }
    }

    function drawMeters(
      ctx: CanvasRenderingContext2D,
      w: number,
      h: number,
      levels: ChannelLevel[],
      dt: number,
    ) {
      const chCount = levels.length;
      const meterTop = PADDING_TOP + DB_READOUT_HEIGHT;
      const meterHeight = h - meterTop - LABEL_HEIGHT - PADDING_BOTTOM;
      if (meterHeight <= 0) return;

      // Calculate bar width — fit bars + gaps + tick label area
      const availableWidth = w - TICK_LABEL_WIDTH - 4;
      const barWidth = Math.max(
        BAR_MIN_WIDTH,
        Math.min(BAR_MAX_WIDTH, (availableWidth - (chCount - 1) * METER_GAP) / chCount),
      );
      const totalBarsWidth = chCount * barWidth + (chCount - 1) * METER_GAP;
      const barsStartX = Math.round(TICK_LABEL_WIDTH + (availableWidth - totalBarsWidth) / 2);

      // Initialize peaks array if needed
      if (peaksRef.current.length !== chCount) {
        peaksRef.current = levels.map((l) => l.dB);
      }

      // Create gradient for meter fill
      const grad = ctx.createLinearGradient(0, meterTop + meterHeight, 0, meterTop);
      grad.addColorStop(0, "#006666"); // dark cyan at bottom
      grad.addColorStop(0.5, "#00cccc"); // cyan
      grad.addColorStop(0.8, "#ccaa00"); // amber
      grad.addColorStop(0.95, "#cc3300"); // red (clipping zone, above -3dB)
      grad.addColorStop(1, "#ff2200");

      // Draw dB scale ticks
      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "9px monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const tick of DB_TICKS) {
        const y = dbToY(tick, meterTop, meterHeight);
        ctx.fillText(`${tick}`, TICK_LABEL_WIDTH - 4, y);
        // Tick line across all bars
        ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(TICK_LABEL_WIDTH, y);
        ctx.lineTo(TICK_LABEL_WIDTH + totalBarsWidth + 4, y);
        ctx.stroke();
      }

      // Draw each channel meter
      for (let i = 0; i < chCount; i++) {
        const level = levels[i];
        const x = Math.round(barsStartX + i * (barWidth + METER_GAP));

        // Dark background track
        ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
        ctx.fillRect(x, meterTop, barWidth, meterHeight);

        // Gradient fill bar
        const fillY = dbToY(level.dB, meterTop, meterHeight);
        const fillHeight = meterTop + meterHeight - fillY;
        if (fillHeight > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, fillY, barWidth, fillHeight);
          ctx.clip();
          ctx.fillStyle = grad;
          ctx.fillRect(x, meterTop, barWidth, meterHeight);
          ctx.restore();
        }

        // Peak hold indicator
        const peakDb = level.dB > peaksRef.current[i]
          ? level.dB
          : peaksRef.current[i] - PEAK_DECAY_DB_PER_SEC * dt;
        peaksRef.current[i] = Math.max(level.dB, peakDb);

        if (peaksRef.current[i] > DB_MIN + 1) {
          const peakY = dbToY(peaksRef.current[i], meterTop, meterHeight);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, peakY);
          ctx.lineTo(x + barWidth, peakY);
          ctx.stroke();
        }

        // dB readout at top, centered on bar
        if (level.dB > DB_MIN) {
          ctx.fillStyle = level.dB > -3 ? "#ff4444" : "rgba(255, 255, 255, 0.8)";
          ctx.font = "9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(Math.round(level.dB).toString(), x + barWidth / 2, PADDING_TOP);
        }

        // Channel label at bottom
        ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
        ctx.font = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(level.label, x + barWidth / 2, meterTop + meterHeight + 4);
      }
    }

    rafRef.current = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      lastTimeRef.current = 0;
    };
  }, [readLevels]);

  return createPortal(
    <div
      className="vp-audio-levels"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <button className="vp-audio-levels-close" onClick={onClose}>
        ×
      </button>
      <canvas ref={canvasRef} />
    </div>,
    containerEl,
  );
}
