import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChannelLevel } from "../hooks/useAudioAnalyser";
import type { LoudnessData } from "../hooks/useLoudnessMeter";
import {
  drawDbfsMeters,
  drawLufsMeters,
  drawSparkline,
  drawSparklineBackground,
  formatLufs,
  TICK_LABEL_WIDTH,
  BAR_MIN_WIDTH,
  METER_GAP,
  SPARKLINE_HEIGHT,
} from "../utils/audioMeterDraw";

interface AudioLevelsProps {
  containerEl: HTMLDivElement;
  readLevels: () => { levels: ChannelLevel[]; error: string | null };
  readLoudness: () => LoudnessData | null;
  resetIntegrated: () => void;
  onClose: () => void;
  loudnessTarget: number;
  onLoudnessTargetChange: (target: number) => void;
}

const SPARKLINE_SECONDS = 60;
const SPARKLINE_SAMPLES_PER_SEC = 10;
const SPARKLINE_BUFFER_SIZE = SPARKLINE_SECONDS * SPARKLINE_SAMPLES_PER_SEC;

const TARGET_PRESETS = [
  { value: -14, label: "-14 LUFS", desc: "Spotify / YouTube" },
  { value: -16, label: "-16 LUFS", desc: "Apple Music" },
  { value: -23, label: "-23 LUFS", desc: "EBU R128" },
  { value: -24, label: "-24 LKFS", desc: "ATSC A/85" },
  { value: -27, label: "-27 LUFS", desc: "Cinema" },
];

export default function AudioLevels({
  containerEl,
  readLevels,
  readLoudness,
  resetIntegrated,
  onClose,
  loudnessTarget,
  onLoudnessTargetChange,
}: AudioLevelsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const peaksRef = useRef<number[]>([]);
  const lastTimeRef = useRef(0);

  // Track channel count to compute dynamic panel width
  const [channelCount, setChannelCount] = useState(2);

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
      // Track channel count for dynamic panel width
      if (levels.length > 0 && levels.length !== channelCount) {
        setChannelCount(levels.length);
      }
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

      const rect = canvas!.getBoundingClientRect();
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
      // Give dBFS side exactly what it needs, LUFS gets the rest (min 70px)
      const chCount = levels.length;
      const dbfsNeeded = TICK_LABEL_WIDTH + 4 + chCount * (BAR_MIN_WIDTH + METER_GAP) + 4;
      const splitX = Math.min(dbfsNeeded, w - 70);

      // Draw separator line
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(splitX, 0);
      ctx.lineTo(splitX, h - SPARKLINE_HEIGHT);
      ctx.stroke();

      // Left: dBFS meters
      drawDbfsMeters(ctx, 0, splitX, h - SPARKLINE_HEIGHT, levels, dt, peaksRef.current);

      // Right: LUFS meters
      if (loudness) {
        drawLufsMeters(ctx, splitX, w - splitX, h - SPARKLINE_HEIGHT, loudness, target);
      }

      // Sparkline
      drawSparklineBackground(ctx, 0, w, h - SPARKLINE_HEIGHT, SPARKLINE_HEIGHT, target);
      drawSparkline(
        ctx, 0, w, h - SPARKLINE_HEIGHT, SPARKLINE_HEIGHT, target,
        sparklineRef.current, sparklineCountRef.current, sparklineIdxRef.current,
        SPARKLINE_BUFFER_SIZE, "#00cccc",
      );

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

    rafRef.current = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      lastTimeRef.current = 0;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readLevels, readLoudness]);

  const ld = loudnessDisplay;

  // Dynamic width: dBFS side scales with channel count, LUFS side is fixed ~80px
  const dbfsSideWidth = TICK_LABEL_WIDTH + 4 + channelCount * (BAR_MIN_WIDTH + METER_GAP) + 8;
  const lufsSideWidth = 80;
  const panelWidth = Math.max(160, dbfsSideWidth + lufsSideWidth);

  // Set CSS variable on container so stats panel offset can follow
  useEffect(() => {
    containerEl.style.setProperty("--audio-levels-width", `${panelWidth}px`);
    return () => { containerEl.style.removeProperty("--audio-levels-width"); };
  }, [panelWidth, containerEl]);

  return createPortal(
    <div
      className="vp-audio-levels"
      style={{ width: panelWidth }}
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
