/**
 * Shared canvas drawing functions for audio metering panels.
 * Used by both AudioLevels (single track) and AudioCompare (side-by-side).
 */

import type { ChannelLevel } from "../hooks/useAudioAnalyser";
import type { LoudnessData } from "../hooks/useLoudnessMeter";

// ── Constants ──

export const DB_TICKS = [-6, -12, -24, -48];
export const DB_MIN = -60;
export const DB_MAX = 0;
export const PEAK_DECAY_DB_PER_SEC = 10;
export const METER_GAP = 4;
export const LABEL_HEIGHT = 16;
export const DB_READOUT_HEIGHT = 16;
export const TICK_LABEL_WIDTH = 24;
export const BAR_MIN_WIDTH = 14;
export const BAR_MAX_WIDTH = 24;
export const PADDING_TOP = 6;
export const PADDING_BOTTOM = 6;
export const LUFS_RANGE_BELOW = 18;
export const LUFS_RANGE_ABOVE = 9;
export const SPARKLINE_HEIGHT = 32;

// ── Helpers ──

export function dbToY(dB: number, meterTop: number, meterHeight: number): number {
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, dB));
  const ratio = (clamped - DB_MIN) / (DB_MAX - DB_MIN);
  return meterTop + meterHeight * (1 - ratio);
}

export function lufsToY(lufs: number, target: number, meterTop: number, meterHeight: number): number {
  const min = target - LUFS_RANGE_BELOW;
  const max = target + LUFS_RANGE_ABOVE;
  const clamped = Math.max(min, Math.min(max, lufs));
  const ratio = (clamped - min) / (max - min);
  return meterTop + meterHeight * (1 - ratio);
}

export function lufsColor(lufs: number, target: number): string {
  const diff = lufs - target;
  if (diff > 2) return "#cc3300";
  if (diff > -2) return "#ccaa00";
  return "#00cc88";
}

export function formatLufs(val: number): string {
  if (!isFinite(val)) return "---";
  return val.toFixed(1);
}

// ── Drawing options ──

export interface DbfsMeterOpts {
  /** When true, bars grow right-to-left and tick labels are on the right. */
  mirrored?: boolean;
}

// ── Drawing functions ──

/**
 * Draw per-channel dBFS gradient bars with peak hold, dB readout, and channel labels.
 */
export function drawDbfsMeters(
  ctx: CanvasRenderingContext2D,
  x0: number,
  width: number,
  height: number,
  levels: ChannelLevel[],
  dt: number,
  peaks: number[],
  opts?: DbfsMeterOpts,
): void {
  const mirrored = opts?.mirrored ?? false;
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

  let barsStartX: number;
  if (mirrored) {
    // Bars on the left side, tick labels on the right
    const rightEdge = x0 + width - TICK_LABEL_WIDTH;
    barsStartX = Math.round(rightEdge - totalBarsWidth - Math.max(0, (availableWidth - totalBarsWidth) / 2));
  } else {
    barsStartX = Math.round(x0 + TICK_LABEL_WIDTH + Math.max(0, (availableWidth - totalBarsWidth) / 2));
  }

  // Ensure peaks array is correct size
  if (peaks.length !== chCount) {
    peaks.length = 0;
    for (const l of levels) peaks.push(l.dB);
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
  ctx.textBaseline = "middle";
  if (mirrored) {
    ctx.textAlign = "left";
    const tickLabelX = x0 + width - TICK_LABEL_WIDTH + 3;
    for (const tick of DB_TICKS) {
      const y = dbToY(tick, meterTop, meterHeight);
      ctx.fillText(`${tick}`, tickLabelX, y);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(barsStartX - 2, y);
      ctx.lineTo(barsStartX + totalBarsWidth, y);
      ctx.stroke();
    }
  } else {
    ctx.textAlign = "right";
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
  }

  for (let i = 0; i < chCount; i++) {
    const level = levels[i];
    const x = Math.round(barsStartX + i * (barWidth + METER_GAP));

    // Background
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fillRect(x, meterTop, barWidth, meterHeight);

    // Fill bar
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
    const peakDb = level.dB > peaks[i]
      ? level.dB
      : peaks[i] - PEAK_DECAY_DB_PER_SEC * dt;
    peaks[i] = Math.max(level.dB, peakDb);

    if (peaks[i] > DB_MIN + 1) {
      const peakY = dbToY(peaks[i], meterTop, meterHeight);
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

/**
 * Draw LUFS M/S bars with target reference and color coding.
 */
export function drawLufsMeters(
  ctx: CanvasRenderingContext2D,
  x0: number,
  width: number,
  height: number,
  loudness: LoudnessData,
  target: number,
): void {
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

/**
 * Draw a dB scale with tick marks in a center column (used in compare mode).
 */
export function drawDbScale(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  meterTop: number,
  meterHeight: number,
): void {
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.font = "8px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const tick of DB_TICKS) {
    const y = dbToY(tick, meterTop, meterHeight);
    ctx.fillText(`${tick}`, centerX, y);
    // Draw faint horizontal guides extending left and right
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX - 16, y);
    ctx.lineTo(centerX + 16, y);
    ctx.stroke();
  }
}

/**
 * Draw a time-series sparkline.
 * Accepts the ring buffer state externally so multiple traces can share the same canvas.
 */
export function drawSparkline(
  ctx: CanvasRenderingContext2D,
  x0: number,
  width: number,
  top: number,
  height: number,
  target: number,
  buffer: Float32Array,
  count: number,
  startIdx: number,
  size: number,
  color: string,
): void {
  if (count < 2) return;

  const padding = 4;
  const graphLeft = x0 + padding;
  const graphWidth = width - padding * 2;
  const graphTop = top + 2;
  const graphHeight = height - 4;

  const lufsMin = target - LUFS_RANGE_BELOW;
  const lufsMax = target + LUFS_RANGE_ABOVE;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();

  const total = Math.min(count, size);
  let first = true;

  for (let i = 0; i < total; i++) {
    const bufIdx = (startIdx - total + i + size) % size;
    const val = buffer[bufIdx];
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

/**
 * Draw sparkline background and target reference line.
 * Call once before drawing one or more sparkline traces.
 */
export function drawSparklineBackground(
  ctx: CanvasRenderingContext2D,
  x0: number,
  width: number,
  top: number,
  height: number,
  target: number,
): void {
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

  // Target line
  const lufsMin = target - LUFS_RANGE_BELOW;
  const lufsMax = target + LUFS_RANGE_ABOVE;
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
}
