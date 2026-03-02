/**
 * AudioCompare — Side-by-side audio track metering.
 *
 * Split-mode view: Track A (playing) on the left, Track B (comparison) on the right,
 * with a shared dB scale in the center. LUFS bars per side, delta indicators,
 * overlaid sparkline, and summary deltas.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChannelLevel } from "../hooks/useAudioAnalyser";
import type { LoudnessData } from "../hooks/useLoudnessMeter";
import type { Ec3TrackInfo } from "../utils/dashAudioParser";
import { useAudioCompareMeter } from "../hooks/useAudioCompareMeter";
import {
  drawDbfsMeters,
  drawDbScale,
  drawSparkline,
  drawSparklineBackground,
  formatLufs,
  TICK_LABEL_WIDTH,
  BAR_MIN_WIDTH,
  METER_GAP,
  SPARKLINE_HEIGHT,
  PADDING_TOP,
  DB_READOUT_HEIGHT,
  LABEL_HEIGHT,
  PADDING_BOTTOM,
} from "../utils/audioMeterDraw";

interface AudioCompareProps {
  videoEl: HTMLVideoElement;
  containerEl: HTMLDivElement;
  allAudioTracks: Ec3TrackInfo[];
  trackAReadLevels: () => { levels: ChannelLevel[]; error: string | null };
  trackAReadLoudness: () => LoudnessData | null;
  trackAResetIntegrated: () => void;
  trackALabel: string;
  loudnessTarget: number;
  onLoudnessTargetChange: (target: number) => void;
  onClose: () => void;
}

const TARGET_PRESETS = [
  { value: -14, label: "-14 LUFS", desc: "Spotify / YouTube" },
  { value: -16, label: "-16 LUFS", desc: "Apple Music" },
  { value: -23, label: "-23 LUFS", desc: "EBU R128" },
  { value: -24, label: "-24 LKFS", desc: "ATSC A/85" },
  { value: -27, label: "-27 LUFS", desc: "Cinema" },
];

const SPARKLINE_SECONDS = 60;
const SPARKLINE_SAMPLES_PER_SEC = 10;
const SPARKLINE_BUFFER_SIZE = SPARKLINE_SECONDS * SPARKLINE_SAMPLES_PER_SEC;
const CENTER_WIDTH = 36;

/** Color for delta based on magnitude in LU */
function deltaColor(delta: number): string {
  const abs = Math.abs(delta);
  if (abs <= 1) return "#00cc88";   // Green — close
  if (abs <= 3) return "#ccaa00";   // Yellow — noticeable
  return "#cc3300";                  // Red — significant
}

export default function AudioCompare({
  videoEl,
  containerEl,
  allAudioTracks,
  trackAReadLevels,
  trackAReadLoudness,
  trackAResetIntegrated,
  trackALabel,
  loudnessTarget,
  onLoudnessTargetChange,
  onClose,
}: AudioCompareProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const peaksARef = useRef<number[]>([]);
  const peaksBRef = useRef<number[]>([]);
  const lastTimeRef = useRef(0);

  // Track B metering
  const trackB = useAudioCompareMeter(videoEl);
  const [selectedTrackId, setSelectedTrackId] = useState<string>("");

  // Track channel counts for layout
  const [trackACh, setTrackACh] = useState(2);
  const [trackBCh, setTrackBCh] = useState(2);

  // Loudness display data for bottom panel (updated at ~4 Hz)
  const [loudnessA, setLoudnessA] = useState<LoudnessData | null>(null);
  const [loudnessB, setLoudnessB] = useState<LoudnessData | null>(null);
  const lastDisplayUpdateRef = useRef(0);

  // Sparkline ring buffers
  const sparklineARef = useRef(new Float32Array(SPARKLINE_BUFFER_SIZE).fill(-Infinity));
  const sparklineAIdxRef = useRef(0);
  const sparklineACountRef = useRef(0);
  const sparklineBRef = useRef(new Float32Array(SPARKLINE_BUFFER_SIZE).fill(-Infinity));
  const sparklineBIdxRef = useRef(0);
  const sparklineBCountRef = useRef(0);
  const lastSparklineSampleRef = useRef(0);

  const targetRef = useRef(loudnessTarget);
  useEffect(() => { targetRef.current = loudnessTarget; }, [loudnessTarget]);

  // Handle Track B selection
  const handleTrackBChange = (trackId: string) => {
    setSelectedTrackId(trackId);
    if (!trackId) {
      trackB.deactivate();
      return;
    }
    const track = allAudioTracks.find((t) => t.id === trackId);
    if (track) {
      trackB.deactivate();
      // Reset sparkline B
      sparklineBRef.current.fill(-Infinity);
      sparklineBIdxRef.current = 0;
      sparklineBCountRef.current = 0;
      peaksBRef.current = [];
      trackB.activate(track);
    }
  };

  // Update track B channel count
  useEffect(() => {
    if (trackB.active) {
      setTrackBCh(trackB.channelCount);
    }
  }, [trackB.active, trackB.channelCount]);

  // Canvas paint loop
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

      // Read Track A
      const { levels: levelsA, error: errorA } = trackAReadLevels();
      const loudA = trackAReadLoudness();

      // Read Track B
      const { levels: levelsB } = trackB.readLevels();
      const loudB = trackB.readLoudness();

      // Track channel counts
      if (levelsA.length > 0 && levelsA.length !== trackACh) {
        setTrackACh(levelsA.length);
      }
      if (levelsB.length > 0 && levelsB.length !== trackBCh) {
        setTrackBCh(levelsB.length);
      }

      // Update DOM readouts at ~4 Hz
      if (timestamp - lastDisplayUpdateRef.current >= 250) {
        lastDisplayUpdateRef.current = timestamp;
        if (loudA) setLoudnessA({ ...loudA });
        if (loudB) setLoudnessB({ ...loudB });
      }

      // Sample sparklines at fixed rate
      if (timestamp - lastSparklineSampleRef.current >= 1000 / SPARKLINE_SAMPLES_PER_SEC) {
        lastSparklineSampleRef.current = timestamp;
        if (loudA) {
          sparklineARef.current[sparklineAIdxRef.current] = loudA.momentary;
          sparklineAIdxRef.current = (sparklineAIdxRef.current + 1) % SPARKLINE_BUFFER_SIZE;
          sparklineACountRef.current = Math.min(sparklineACountRef.current + 1, SPARKLINE_BUFFER_SIZE);
        }
        if (loudB) {
          sparklineBRef.current[sparklineBIdxRef.current] = loudB.momentary;
          sparklineBIdxRef.current = (sparklineBIdxRef.current + 1) % SPARKLINE_BUFFER_SIZE;
          sparklineBCountRef.current = Math.min(sparklineBCountRef.current + 1, SPARKLINE_BUFFER_SIZE);
        }
      }

      const rect = canvas!.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      if (errorA && levelsA.length === 0 && levelsB.length === 0) {
        drawError(ctx, w, h, errorA);
        rafRef.current = requestAnimationFrame(paint);
        return;
      }

      const target = targetRef.current;
      const sparklineTop = h - SPARKLINE_HEIGHT;
      const metersH = sparklineTop;

      // Layout: [Track A dBFS] [center dB scale] [Track B dBFS]
      const halfW = (w - CENTER_WIDTH) / 2;

      // Draw center dB scale
      const centerX = halfW + CENTER_WIDTH / 2;
      const meterTop = PADDING_TOP + DB_READOUT_HEIGHT;
      const meterHeight = metersH - meterTop - LABEL_HEIGHT - PADDING_BOTTOM;
      if (meterHeight > 0) {
        drawDbScale(ctx, centerX, meterTop, meterHeight);
      }

      // Draw center separator lines
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(halfW, 0);
      ctx.lineTo(halfW, sparklineTop);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(halfW + CENTER_WIDTH, 0);
      ctx.lineTo(halfW + CENTER_WIDTH, sparklineTop);
      ctx.stroke();

      // Track A dBFS (left, normal direction)
      if (levelsA.length > 0) {
        drawDbfsMeters(ctx, 0, halfW, metersH, levelsA, dt, peaksARef.current);
      }

      // Track B dBFS (right, mirrored)
      if (levelsB.length > 0) {
        drawDbfsMeters(ctx, halfW + CENTER_WIDTH, halfW, metersH, levelsB, dt, peaksBRef.current, { mirrored: true });
      }

      // Draw LUFS delta indicators in center
      if (loudA && loudB && meterHeight > 0) {
        const deltaM = loudA.momentary - loudB.momentary;
        const deltaS = loudA.shortTerm - loudB.shortTerm;

        ctx.font = "8px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Delta M
        if (isFinite(deltaM)) {
          ctx.fillStyle = deltaColor(deltaM);
          const sign = deltaM >= 0 ? "+" : "";
          ctx.fillText(`${sign}${deltaM.toFixed(1)}`, centerX, meterTop + meterHeight * 0.3);
          ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
          ctx.font = "7px monospace";
          ctx.fillText("ΔM", centerX, meterTop + meterHeight * 0.3 - 10);
        }

        // Delta S
        if (isFinite(deltaS)) {
          ctx.font = "8px monospace";
          ctx.fillStyle = deltaColor(deltaS);
          const sign = deltaS >= 0 ? "+" : "";
          ctx.fillText(`${sign}${deltaS.toFixed(1)}`, centerX, meterTop + meterHeight * 0.6);
          ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
          ctx.font = "7px monospace";
          ctx.fillText("ΔS", centerX, meterTop + meterHeight * 0.6 - 10);
        }
      }

      // Sparkline with two traces
      drawSparklineBackground(ctx, 0, w, sparklineTop, SPARKLINE_HEIGHT, target);
      drawSparkline(
        ctx, 0, w, sparklineTop, SPARKLINE_HEIGHT, target,
        sparklineARef.current, sparklineACountRef.current, sparklineAIdxRef.current,
        SPARKLINE_BUFFER_SIZE, "#00cccc",
      );
      drawSparkline(
        ctx, 0, w, sparklineTop, SPARKLINE_HEIGHT, target,
        sparklineBRef.current, sparklineBCountRef.current, sparklineBIdxRef.current,
        SPARKLINE_BUFFER_SIZE, "#ff9933",
      );

      rafRef.current = requestAnimationFrame(paint);
    }

    function drawError(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(msg, w / 2, h / 2);
    }

    rafRef.current = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      lastTimeRef.current = 0;
    };
  }, [trackAReadLevels, trackAReadLoudness, trackB.readLevels, trackB.readLoudness]);

  const ldA = loudnessA;
  const ldB = loudnessB;

  // Panel width: dynamic based on max channel count
  const maxCh = Math.max(trackACh, trackBCh);
  const sideW = TICK_LABEL_WIDTH + 4 + maxCh * (BAR_MIN_WIDTH + METER_GAP) + 8;
  const panelWidth = Math.max(280, sideW * 2 + CENTER_WIDTH);

  // Set CSS variable on container
  useEffect(() => {
    containerEl.style.setProperty("--audio-compare-width", `${panelWidth}px`);
    return () => { containerEl.style.removeProperty("--audio-compare-width"); };
  }, [panelWidth, containerEl]);

  // Compute delta values
  const deltaI = ldA && ldB && isFinite(ldA.integrated) && isFinite(ldB.integrated)
    ? ldA.integrated - ldB.integrated : null;
  const deltaTP = ldA && ldB && isFinite(ldA.truePeak) && isFinite(ldB.truePeak)
    ? ldA.truePeak - ldB.truePeak : null;
  const deltaLRA = ldA && ldB && isFinite(ldA.loudnessRange) && isFinite(ldB.loudnessRange)
    ? ldA.loudnessRange - ldB.loudnessRange : null;

  return createPortal(
    <div
      className="vp-audio-compare"
      style={{ width: panelWidth }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* Toolbar */}
      <div className="vp-audio-compare-toolbar">
        <span className="vp-audio-compare-label" title={trackALabel}>
          <span className="vp-audio-compare-dot vp-audio-compare-dot-a" />
          A
        </span>
        <select
          className="vp-audio-compare-target"
          value={loudnessTarget}
          onChange={(e) => onLoudnessTargetChange(Number(e.target.value))}
        >
          {TARGET_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <select
          className="vp-audio-compare-track-select"
          value={selectedTrackId}
          onChange={(e) => handleTrackBChange(e.target.value)}
        >
          <option value="">Track B...</option>
          {allAudioTracks.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <button className="vp-audio-compare-close" onClick={onClose}>×</button>
      </div>

      {/* Canvas */}
      <canvas ref={canvasRef} className="vp-audio-compare-canvas" />

      {/* Summary deltas */}
      <div className="vp-audio-compare-summary">
        <div className="vp-audio-compare-row">
          <span className="vp-audio-compare-side">
            A: I <strong>{ldA ? formatLufs(ldA.integrated) : "---"}</strong>
            {" "}TP <strong>{ldA ? formatLufs(ldA.truePeak) : "---"}</strong>
            {" "}LRA <strong>{ldA ? (isFinite(ldA.loudnessRange) ? ldA.loudnessRange.toFixed(1) : "---") : "---"}</strong>
          </span>
        </div>
        <div className="vp-audio-compare-row">
          <span className="vp-audio-compare-side">
            B: I <strong>{ldB ? formatLufs(ldB.integrated) : "---"}</strong>
            {" "}TP <strong>{ldB ? formatLufs(ldB.truePeak) : "---"}</strong>
            {" "}LRA <strong>{ldB ? (isFinite(ldB.loudnessRange) ? ldB.loudnessRange.toFixed(1) : "---") : "---"}</strong>
          </span>
        </div>
        <div className="vp-audio-compare-row vp-audio-compare-delta-row">
          <span className="vp-audio-compare-side">
            Δ:{" "}
            <strong style={{ color: deltaI != null ? deltaColor(deltaI) : undefined }}>
              {deltaI != null ? `${deltaI >= 0 ? "+" : ""}${deltaI.toFixed(1)}` : "---"}
            </strong>
            {"  "}
            <strong style={{ color: deltaTP != null ? deltaColor(deltaTP) : undefined }}>
              {deltaTP != null ? `${deltaTP >= 0 ? "+" : ""}${deltaTP.toFixed(1)}` : "---"}
            </strong>
            {"  "}
            <strong style={{ color: deltaLRA != null ? deltaColor(deltaLRA) : undefined }}>
              {deltaLRA != null ? `${deltaLRA >= 0 ? "+" : ""}${deltaLRA.toFixed(1)}` : "---"}
            </strong>
          </span>
        </div>
        <div className="vp-audio-compare-actions">
          <button
            className="vp-loudness-reset"
            onClick={() => {
              trackAResetIntegrated();
              sparklineARef.current.fill(-Infinity);
              sparklineAIdxRef.current = 0;
              sparklineACountRef.current = 0;
              setLoudnessA(null);
            }}
          >Reset A</button>
          <button
            className="vp-loudness-reset"
            onClick={() => {
              trackAResetIntegrated();
              trackB.resetIntegrated();
              sparklineARef.current.fill(-Infinity);
              sparklineAIdxRef.current = 0;
              sparklineACountRef.current = 0;
              sparklineBRef.current.fill(-Infinity);
              sparklineBIdxRef.current = 0;
              sparklineBCountRef.current = 0;
              setLoudnessA(null);
              setLoudnessB(null);
            }}
          >Reset All</button>
          <button
            className="vp-loudness-reset"
            onClick={() => {
              trackB.resetIntegrated();
              sparklineBRef.current.fill(-Infinity);
              sparklineBIdxRef.current = 0;
              sparklineBCountRef.current = 0;
              setLoudnessB(null);
            }}
          >Reset B</button>
        </div>
      </div>
    </div>,
    containerEl,
  );
}
