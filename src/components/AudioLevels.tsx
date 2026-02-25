import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAudioAnalyser } from "../hooks/useAudioAnalyser";
import type { ChannelLevel } from "../hooks/useAudioAnalyser";
import { useLoudnessMeter } from "../hooks/useLoudnessMeter";
import type { LoudnessData } from "../hooks/useLoudnessMeter";

interface AudioLevelsProps {
  videoEl: HTMLVideoElement;
  containerEl: HTMLDivElement;
  onClose: () => void;
  loudnessTarget: number;
  onLoudnessTargetChange: (target: number) => void;
}

/** dB scale tick marks to draw */
const DB_TICKS = [-6, -12, -24, -48];
const DB_MIN = -60;
const DB_MAX = 0;
const PEAK_DECAY_DB_PER_SEC = 10;
const METER_GAP = 4;
const LABEL_HEIGHT = 16;
const DB_READOUT_HEIGHT = 16;
const TICK_LABEL_WIDTH = 24;
const BAR_MIN_WIDTH = 14;
const BAR_MAX_WIDTH = 24;
const PADDING_TOP = 6;
const PADDING_BOTTOM = 6;

// LUFS scale constants (EBU +9 scale relative to target)
const LUFS_RANGE_BELOW = 18; // Show from target - 18
const LUFS_RANGE_ABOVE = 9;  // Show to target + 9

// Sparkline constants
const SPARKLINE_HEIGHT = 32;
const SPARKLINE_SECONDS = 60;
const SPARKLINE_SAMPLES_PER_SEC = 10; // 10 Hz sampling for sparkline
const SPARKLINE_BUFFER_SIZE = SPARKLINE_SECONDS * SPARKLINE_SAMPLES_PER_SEC;

const TARGET_PRESETS = [
  { value: -14, label: "-14 LUFS", desc: "Spotify / YouTube" },
  { value: -16, label: "-16 LUFS", desc: "Apple Music" },
  { value: -23, label: "-23 LUFS", desc: "EBU R128" },
  { value: -24, label: "-24 LKFS", desc: "ATSC A/85" },
  { value: -27, label: "-27 LUFS", desc: "Cinema" },
];

function dbToY(dB: number, meterTop: number, meterHeight: number): number {
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, dB));
  const ratio = (clamped - DB_MIN) / (DB_MAX - DB_MIN);
  return meterTop + meterHeight * (1 - ratio);
}

function lufsToY(lufs: number, target: number, meterTop: number, meterHeight: number): number {
  const min = target - LUFS_RANGE_BELOW;
  const max = target + LUFS_RANGE_ABOVE;
  const clamped = Math.max(min, Math.min(max, lufs));
  const ratio = (clamped - min) / (max - min);
  return meterTop + meterHeight * (1 - ratio);
}

/** Color for LUFS bar based on distance from target. */
function lufsColor(lufs: number, target: number): string {
  const diff = lufs - target;
  if (diff > 2) return "#cc3300";      // Red — too loud
  if (diff > -2) return "#ccaa00";     // Yellow — near target
  return "#00cc88";                     // Green — below target
}

function formatLufs(val: number): string {
  if (!isFinite(val)) return "---";
  return val.toFixed(1);
}

export default function AudioLevels({
  videoEl,
  containerEl,
  onClose,
  loudnessTarget,
  onLoudnessTargetChange,
}: AudioLevelsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const peaksRef = useRef<number[]>([]);
  const lastTimeRef = useRef(0);
  const { readLevels } = useAudioAnalyser(videoEl, true);
  const { readLoudness, resetIntegrated } = useLoudnessMeter(videoEl, true);

  // Loudness display data — updated from RAF at ~4 Hz to avoid 60fps re-renders
  const [loudnessDisplay, setLoudnessDisplay] = useState<LoudnessData | null>(null);
  const lastDisplayUpdateRef = useRef(0);

  // Sparkline ring buffer
  const sparklineRef = useRef(new Float32Array(SPARKLINE_BUFFER_SIZE).fill(-Infinity));
  const sparklineIdxRef = useRef(0);
  const sparklineCountRef = useRef(0);
  const lastSparklineSampleRef = useRef(0);

  // Sync loudnessTarget prop into a ref for the paint loop
  const targetRef = useRef(loudnessTarget);
  useEffect(() => { targetRef.current = loudnessTarget; }, [loudnessTarget]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d")!;

    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    observer.observe(canvas);

    function paint(timestamp: number) {
      const dt = lastTimeRef.current > 0 ? (timestamp - lastTimeRef.current) / 1000 : 0;
      lastTimeRef.current = timestamp;

      const { levels, error } = readLevels();
      const loudness = readLoudness();
      // Update DOM readouts at ~4 Hz (avoid 60fps re-renders)
      if (loudness && timestamp - lastDisplayUpdateRef.current >= 250) {
        lastDisplayUpdateRef.current = timestamp;
        setLoudnessDisplay({ ...loudness });
      }

      // Sample sparkline at fixed rate
      if (loudness && timestamp - lastSparklineSampleRef.current >= 1000 / SPARKLINE_SAMPLES_PER_SEC) {
        lastSparklineSampleRef.current = timestamp;
        const buf = sparklineRef.current;
        buf[sparklineIdxRef.current] = loudness.momentary;
        sparklineIdxRef.current = (sparklineIdxRef.current + 1) % SPARKLINE_BUFFER_SIZE;
        sparklineCountRef.current = Math.min(sparklineCountRef.current + 1, SPARKLINE_BUFFER_SIZE);
      }

      const rect = canvas.getBoundingClientRect();
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

      const target = targetRef.current;
      const halfW = Math.floor(w / 2);

      // Draw separator line
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(halfW, 0);
      ctx.lineTo(halfW, h - SPARKLINE_HEIGHT);
      ctx.stroke();

      // Left half: dBFS meters
      drawDbfsMeters(ctx, 0, halfW, h - SPARKLINE_HEIGHT, levels, dt);

      // Right half: LUFS meters
      if (loudness) {
        drawLufsMeters(ctx, halfW, w - halfW, h - SPARKLINE_HEIGHT, loudness, target);
      }

      // Sparkline
      drawSparkline(ctx, 0, w, h - SPARKLINE_HEIGHT, SPARKLINE_HEIGHT, target);

      rafRef.current = requestAnimationFrame(paint);
    }

    function drawError(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
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

    function drawDbfsMeters(
      ctx: CanvasRenderingContext2D,
      x0: number,
      width: number,
      height: number,
      levels: ChannelLevel[],
      dt: number,
    ) {
      const chCount = levels.length;
      const meterTop = PADDING_TOP + DB_READOUT_HEIGHT;
      const meterHeight = height - meterTop - LABEL_HEIGHT - PADDING_BOTTOM;
      if (meterHeight <= 0) return;

      const availableWidth = width - TICK_LABEL_WIDTH - 4;
      const barWidth = Math.max(
        BAR_MIN_WIDTH,
        Math.min(BAR_MAX_WIDTH, (availableWidth - (chCount - 1) * METER_GAP) / chCount),
      );
      const totalBarsWidth = chCount * barWidth + (chCount - 1) * METER_GAP;
      const barsStartX = Math.round(x0 + TICK_LABEL_WIDTH + (availableWidth - totalBarsWidth) / 2);

      if (peaksRef.current.length !== chCount) {
        peaksRef.current = levels.map((l) => l.dB);
      }

      const grad = ctx.createLinearGradient(0, meterTop + meterHeight, 0, meterTop);
      grad.addColorStop(0, "#006666");
      grad.addColorStop(0.5, "#00cccc");
      grad.addColorStop(0.8, "#ccaa00");
      grad.addColorStop(0.95, "#cc3300");
      grad.addColorStop(1, "#ff2200");

      // Tick labels
      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "8px monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const tick of DB_TICKS) {
        const y = dbToY(tick, meterTop, meterHeight);
        ctx.fillText(`${tick}`, x0 + TICK_LABEL_WIDTH - 3, y);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0 + TICK_LABEL_WIDTH, y);
        ctx.lineTo(x0 + TICK_LABEL_WIDTH + totalBarsWidth + 2, y);
        ctx.stroke();
      }

      for (let i = 0; i < chCount; i++) {
        const level = levels[i];
        const x = Math.round(barsStartX + i * (barWidth + METER_GAP));

        ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
        ctx.fillRect(x, meterTop, barWidth, meterHeight);

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

        // Peak hold
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

        // dB readout at top
        if (level.dB > DB_MIN) {
          ctx.fillStyle = level.dB > -3 ? "#ff4444" : "rgba(255, 255, 255, 0.8)";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(Math.round(level.dB).toString(), x + barWidth / 2, PADDING_TOP);
        }

        // Channel label
        ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
        ctx.font = "8px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(level.label, x + barWidth / 2, meterTop + meterHeight + 2);
      }
    }

    function drawLufsMeters(
      ctx: CanvasRenderingContext2D,
      x0: number,
      width: number,
      height: number,
      loudness: LoudnessData,
      target: number,
    ) {
      const meterTop = PADDING_TOP + DB_READOUT_HEIGHT;
      const meterHeight = height - meterTop - LABEL_HEIGHT - PADDING_BOTTOM;
      if (meterHeight <= 0) return;

      const barWidth = 20;
      const gap = 6;
      const totalBarsWidth = 2 * barWidth + gap;
      const barsStartX = Math.round(x0 + (width - totalBarsWidth) / 2);

      const lufsMin = target - LUFS_RANGE_BELOW;
      const lufsMax = target + LUFS_RANGE_ABOVE;

      // Scale ticks on the right side
      const tickX = barsStartX + totalBarsWidth + 3;
      ctx.font = "7px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const tickValues = [target + 9, target, target - 9, target - 18];
      for (const tv of tickValues) {
        if (tv < lufsMin || tv > lufsMax) continue;
        const y = lufsToY(tv, target, meterTop, meterHeight);
        ctx.fillStyle = tv === target ? "rgba(255, 200, 60, 0.6)" : "rgba(255, 255, 255, 0.3)";
        ctx.fillText(`${tv}`, tickX, y);
        ctx.strokeStyle = tv === target ? "rgba(255, 200, 60, 0.3)" : "rgba(255, 255, 255, 0.06)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(barsStartX - 2, y);
        ctx.lineTo(barsStartX + totalBarsWidth + 2, y);
        ctx.stroke();
      }

      // Target line
      const targetY = lufsToY(target, target, meterTop, meterHeight);
      ctx.strokeStyle = "rgba(255, 200, 60, 0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(barsStartX - 2, targetY);
      ctx.lineTo(barsStartX + totalBarsWidth + 2, targetY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw M and S bars
      const bars = [
        { label: "M", value: loudness.momentary },
        { label: "S", value: loudness.shortTerm },
      ];

      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        const x = barsStartX + i * (barWidth + gap);

        // Background
        ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
        ctx.fillRect(x, meterTop, barWidth, meterHeight);

        // Fill bar
        if (isFinite(bar.value)) {
          const fillY = lufsToY(bar.value, target, meterTop, meterHeight);
          const fillHeight = meterTop + meterHeight - fillY;
          if (fillHeight > 0) {
            ctx.fillStyle = lufsColor(bar.value, target);
            ctx.globalAlpha = 0.85;
            ctx.fillRect(x, fillY, barWidth, fillHeight);
            ctx.globalAlpha = 1;
          }

          // Readout at top
          ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(formatLufs(bar.value), x + barWidth / 2, PADDING_TOP);
        }

        // Label
        ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
        ctx.font = "8px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(bar.label, x + barWidth / 2, meterTop + meterHeight + 2);
      }
    }

    function drawSparkline(
      ctx: CanvasRenderingContext2D,
      x0: number,
      width: number,
      top: number,
      height: number,
      target: number,
    ) {
      const buf = sparklineRef.current;
      const count = sparklineCountRef.current;
      if (count < 2) return;

      const padding = 4;
      const graphLeft = x0 + padding;
      const graphWidth = width - padding * 2;
      const graphTop = top + 2;
      const graphHeight = height - 4;

      // Background
      ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
      ctx.fillRect(x0, top, width, height);

      // Top separator
      ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, top);
      ctx.lineTo(x0 + width, top);
      ctx.stroke();

      // LUFS range for sparkline: target-18 to target+9
      const lufsMin = target - LUFS_RANGE_BELOW;
      const lufsMax = target + LUFS_RANGE_ABOVE;

      // Target line
      const targetRatio = (target - lufsMin) / (lufsMax - lufsMin);
      const targetLineY = graphTop + graphHeight * (1 - targetRatio);
      ctx.strokeStyle = "rgba(255, 200, 60, 0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(graphLeft, targetLineY);
      ctx.lineTo(graphLeft + graphWidth, targetLineY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw momentary loudness line
      ctx.strokeStyle = "#00cccc";
      ctx.lineWidth = 1;
      ctx.beginPath();

      const startIdx = sparklineIdxRef.current;
      const total = Math.min(count, SPARKLINE_BUFFER_SIZE);
      let first = true;

      for (let i = 0; i < total; i++) {
        const bufIdx = (startIdx - total + i + SPARKLINE_BUFFER_SIZE) % SPARKLINE_BUFFER_SIZE;
        const val = buf[bufIdx];
        if (!isFinite(val)) continue;

        const xPos = graphLeft + (i / (total - 1)) * graphWidth;
        const ratio = Math.max(0, Math.min(1, (val - lufsMin) / (lufsMax - lufsMin)));
        const yPos = graphTop + graphHeight * (1 - ratio);

        if (first) {
          ctx.moveTo(xPos, yPos);
          first = false;
        } else {
          ctx.lineTo(xPos, yPos);
        }
      }
      ctx.stroke();
    }

    rafRef.current = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      lastTimeRef.current = 0;
    };
  }, [readLevels, readLoudness]);

  const ld = loudnessDisplay;

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
      {/* Bottom controls — rendered as DOM overlay */}
      <div className="vp-loudness-controls">
        <div className="vp-loudness-readouts">
          <span className="vp-loudness-readout">
            I: <strong>{ld ? formatLufs(ld.integrated) : "---"}</strong> LUFS
          </span>
          <span className="vp-loudness-readout">
            TP: <strong>{ld ? formatLufs(ld.truePeak) : "---"}</strong> dBTP
          </span>
          <span className="vp-loudness-readout">
            LRA: <strong>{ld ? (isFinite(ld.loudnessRange) ? ld.loudnessRange.toFixed(1) : "---") : "---"}</strong> LU
          </span>
        </div>
        <div className="vp-loudness-actions">
          <select
            className="vp-loudness-target-select"
            value={loudnessTarget}
            onChange={(e) => {
              onLoudnessTargetChange(Number(e.target.value));
            }}
          >
            {TARGET_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label} ({p.desc})
              </option>
            ))}
          </select>
          <button
            className="vp-loudness-reset"
            onClick={() => {
              resetIntegrated();
              sparklineRef.current.fill(-Infinity);
              sparklineIdxRef.current = 0;
              sparklineCountRef.current = 0;
              setLoudnessDisplay(null);
            }}
            title="Reset integrated measurement"
          >
            Reset
          </button>
        </div>
      </div>
    </div>,
    containerEl,
  );
}
