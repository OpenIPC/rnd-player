/**
 * Pure functions that model the filmstrip save-frame mapping pipeline.
 *
 * The pipeline has three stages that must agree on which frame to use:
 *   1. Paint loop: given a slot index j, which captured bitmap (and thus
 *      which output frame) is drawn on screen?
 *   2. Context-menu snap: given a click pixel → raw time, what "snapped"
 *      time should be sent to the worker?
 *   3. Worker CTS match: given the snapped time and the segment's actual
 *      CTS values, which frame does the worker decode and return?
 *
 * If (1) and (3) disagree, the user sees one frame but saves another.
 */

// ── Stage 1: Worker capture simulation ──────────────────────────────

/**
 * Compute which display-order output indices the worker captures when
 * asked for `requestedCount` frames from a segment with `totalFrames`.
 * Returns a sorted array of unique indices (may be shorter than
 * requestedCount due to rounding collisions).
 */
export function computeCaptureIndices(
  requestedCount: number,
  totalFrames: number,
): number[] {
  const set = new Set<number>();
  for (let i = 0; i < requestedCount; i++) {
    const idx = Math.round(
      (i / (requestedCount - 1 || 1)) * (totalFrames - 1),
    );
    if (idx >= 0 && idx < totalFrames) set.add(idx);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// ── Stage 1b: Paint loop frame assignment ───────────────────────────

/**
 * Given slot index j in the filmstrip gap mode, return the index into
 * the intra-frame bitmap array that the paint loop displays.
 */
export function slotToArrIdx(
  j: number,
  slotCount: number,
  intraCount: number,
): number {
  if (intraCount <= 0) return 0;
  return slotCount > 1
    ? Math.round((j / (slotCount - 1)) * (intraCount - 1))
    : 0;
}

/**
 * Full paint-loop mapping: slot j → display-order frame index.
 */
export function getDisplayedFrameIndex(
  j: number,
  slotCount: number,
  capturedIndices: number[],
): number {
  const arrIdx = slotToArrIdx(j, slotCount, capturedIndices.length);
  return capturedIndices[Math.min(arrIdx, capturedIndices.length - 1)] ?? 0;
}

// ── Stage 2: Context-menu snap ──────────────────────────────────────

export interface SnapParams {
  clickTime: number;
  segStart: number;
  segEnd: number;
  pxPerSec: number;
  thumbW: number;
  fps: number;
  /** Number of intra-frame bitmaps currently stored for this segment */
  intraCount: number;
  /** If available, exact CTS times (seconds) for each intra-frame bitmap */
  intraCtsSeconds?: number[];
}

/**
 * Current snapping logic (the code in the component right now).
 * Returns the time that will be sent to the worker.
 */
export function snapClickTimeCurrent(params: SnapParams): number {
  const {
    clickTime,
    segStart,
    segEnd,
    pxPerSec,
    thumbW,
    fps,
    intraCount,
  } = params;
  const segDuration = segEnd - segStart;
  const segWidth = segDuration * pxPerSec;

  if (segWidth <= thumbW) {
    return segStart; // packed mode → I-frame
  }

  const count = Math.max(2, Math.ceil(segWidth / thumbW));
  const slotW = segWidth / count;
  const relPx = (clickTime - segStart) * pxPerSec;
  const j = Math.min(count - 1, Math.max(0, Math.floor(relPx / slotW)));

  if (intraCount > 1) {
    const arrIdx = Math.round((j / (count - 1)) * (intraCount - 1));
    const totalFrames = Math.round(segDuration * fps);
    const outputIdx = Math.round(
      (arrIdx / (intraCount - 1)) * Math.max(0, totalFrames - 1),
    );
    return segStart + outputIdx / fps;
  }

  return segStart;
}

/**
 * Improved snapping that uses exact CTS values from the worker
 * (if available) instead of approximating from fps.
 */
export function snapClickTimeWithCts(params: SnapParams): number {
  const {
    clickTime,
    segStart,
    segEnd,
    pxPerSec,
    thumbW,
    intraCtsSeconds,
  } = params;
  const segDuration = segEnd - segStart;
  const segWidth = segDuration * pxPerSec;

  if (segWidth <= thumbW) {
    return segStart; // packed mode → I-frame
  }

  const count = Math.max(2, Math.ceil(segWidth / thumbW));
  const slotW = segWidth / count;
  const relPx = (clickTime - segStart) * pxPerSec;
  const j = Math.min(count - 1, Math.max(0, Math.floor(relPx / slotW)));

  if (intraCtsSeconds && intraCtsSeconds.length > 1) {
    const arrIdx = Math.round(
      (j / (count - 1)) * (intraCtsSeconds.length - 1),
    );
    const clampedIdx = Math.min(arrIdx, intraCtsSeconds.length - 1);
    return intraCtsSeconds[clampedIdx];
  }

  return segStart;
}

// ── Stage 3: Worker CTS match ───────────────────────────────────────

/**
 * Simulate the worker's closest-CTS matching.
 * Returns the index of the frame whose CTS is closest to `time`.
 */
export function findClosestFrameIndex(
  time: number,
  frameCtsSeconds: number[],
): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < frameCtsSeconds.length; i++) {
    const dist = Math.abs(frameCtsSeconds[i] - time);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ── No-snap baseline (old behavior) ────────────────────────────────

/**
 * Raw click time without any snapping — the old behavior.
 */
export function noSnap(clickTime: number): number {
  return clickTime;
}

// ── Frame position (stream-independent save) ────────────────────────

/**
 * Compute the normalized frame position (0..1) for the bitmap at arrIdx.
 * This is what the component sends to the worker for saving, so the
 * worker can map it to a display-order frame index in ANY stream.
 */
export function arrIdxToPosition(
  arrIdx: number,
  intraCount: number,
): number {
  if (intraCount <= 1) return 0;
  return arrIdx / (intraCount - 1);
}

/**
 * Map a normalized frame position (0..1) to a display-order frame index
 * in a stream with `totalFrames` frames. This is what the worker does.
 */
export function positionToFrameIndex(
  position: number,
  totalFrames: number,
): number {
  return Math.round(position * (totalFrames - 1));
}

// ── Full pipeline check ─────────────────────────────────────────────

export interface PipelineParams {
  segStart: number;
  segEnd: number;
  fps: number;
  totalFrames: number;
  pxPerSec: number;
  thumbW: number;
  /**
   * Composition time offset in frames. With CTTS v0 (unsigned offsets)
   * and B-frame reordering, the first frame's CTS is shifted by this
   * many frame durations past segStart. Typical values: 0 (no B-frames),
   * 1 (one B-frame per mini-GOP), 2 (two B-frames per mini-GOP).
   */
  ctsOffsetFrames?: number;
}

export interface SlotResult {
  slotJ: number;
  displayedFrame: number;
  clickTime: number;
  snappedTime: number;
  savedFrame: number;
  match: boolean;
  rawSavedFrame: number; // what old no-snap code would save
}

/**
 * Run the full pipeline for every slot at a given zoom level.
 * Returns per-slot results.
 */
export function checkAllSlots(
  params: PipelineParams,
  snapFn: (p: SnapParams) => number = snapClickTimeCurrent,
): SlotResult[] {
  const { segStart, segEnd, fps, totalFrames, pxPerSec, thumbW, ctsOffsetFrames = 0 } = params;
  const segDuration = segEnd - segStart;
  const segWidth = segDuration * pxPerSec;

  // CTS values for each frame in display order.
  // With CTTS v0 and B-frame reordering, the first frame's CTS is shifted
  // by ctsOffsetFrames * frameDuration past segStart.
  const frameCts = Array.from(
    { length: totalFrames },
    (_, i) => segStart + (i + ctsOffsetFrames) / fps,
  );

  if (segWidth <= thumbW) {
    // Packed mode: one slot, should save I-frame
    const clickTime = (segStart + segEnd) / 2;
    const snapped = snapFn({
      clickTime,
      segStart,
      segEnd,
      pxPerSec,
      thumbW,
      fps,
      intraCount: 0,
    });
    const savedFrame = findClosestFrameIndex(snapped, frameCts);
    const rawSaved = findClosestFrameIndex(clickTime, frameCts);
    return [
      {
        slotJ: 0,
        displayedFrame: 0,
        clickTime,
        snappedTime: snapped,
        savedFrame,
        match: savedFrame === 0,
        rawSavedFrame: rawSaved,
      },
    ];
  }

  // Gap mode
  const count = Math.max(2, Math.ceil(segWidth / thumbW));
  const capturedIndices = computeCaptureIndices(count, totalFrames);
  const intraCount = capturedIndices.length;

  // Compute exact CTS for each captured frame (for the improved snap)
  const intraCtsSeconds = capturedIndices.map((idx) => frameCts[idx]);

  const results: SlotResult[] = [];
  for (let j = 0; j < count; j++) {
    const displayedFrame = getDisplayedFrameIndex(j, count, capturedIndices);

    // Click at slot center
    const slotW = segWidth / count;
    const clickTime = segStart + (j + 0.5) * slotW / pxPerSec;

    const snapped = snapFn({
      clickTime,
      segStart,
      segEnd,
      pxPerSec,
      thumbW,
      fps,
      intraCount,
      intraCtsSeconds,
    });

    const savedFrame = findClosestFrameIndex(snapped, frameCts);
    const rawSaved = findClosestFrameIndex(clickTime, frameCts);

    results.push({
      slotJ: j,
      displayedFrame,
      clickTime,
      snappedTime: snapped,
      savedFrame,
      match: savedFrame === displayedFrame,
      rawSavedFrame: rawSaved,
    });
  }

  return results;
}

// ── Cross-stream pipeline check ─────────────────────────────────────

export interface CrossStreamParams extends PipelineParams {
  /**
   * CTS offset for the thumbnail stream (used for display + snap).
   * Default: same as ctsOffsetFrames.
   */
  thumbCtsOffset?: number;
  /**
   * CTS offset for the active stream (used for save).
   * Default: same as ctsOffsetFrames.
   */
  activeCtsOffset?: number;
}

export interface CrossStreamSlotResult extends SlotResult {
  /** Frame index the position-based save would capture in the active stream */
  positionSavedFrame: number;
  /** Whether position-based save matches the displayed frame */
  positionMatch: boolean;
}

/**
 * Run the full pipeline modeling a cross-stream mismatch:
 * - The thumbnail stream (used for intra-frame capture and CTS snap)
 *   has `thumbCtsOffset` composition time offset
 * - The active stream (used by handleSaveFrame) has `activeCtsOffset`
 *
 * This catches the bug where the component snaps to a CTS from the
 * thumbnail stream but the worker searches for that CTS in the active
 * stream, which has different CTS values due to different B-frame
 * reordering.
 */
export function checkAllSlotsCrossStream(
  params: CrossStreamParams,
  snapFn: (p: SnapParams) => number = snapClickTimeWithCts,
): CrossStreamSlotResult[] {
  const {
    segStart, segEnd, fps, totalFrames, pxPerSec, thumbW,
    thumbCtsOffset = params.ctsOffsetFrames ?? 0,
    activeCtsOffset = params.ctsOffsetFrames ?? 0,
  } = params;
  const segDuration = segEnd - segStart;
  const segWidth = segDuration * pxPerSec;

  // CTS for the thumbnail stream (snap source)
  const thumbCts = Array.from(
    { length: totalFrames },
    (_, i) => segStart + (i + thumbCtsOffset) / fps,
  );

  // CTS for the active stream (save target)
  const activeCts = Array.from(
    { length: totalFrames },
    (_, i) => segStart + (i + activeCtsOffset) / fps,
  );

  if (segWidth <= thumbW) {
    // Packed mode
    const clickTime = (segStart + segEnd) / 2;
    const snapped = snapFn({
      clickTime, segStart, segEnd, pxPerSec, thumbW, fps, intraCount: 0,
    });
    // CTS-based save: match snapped time against active stream CTS
    const savedFrame = findClosestFrameIndex(snapped, activeCts);
    const rawSaved = findClosestFrameIndex(clickTime, activeCts);
    // Position-based save: frame 0 (I-frame) regardless of stream
    const positionSavedFrame = 0;
    return [{
      slotJ: 0,
      displayedFrame: 0,
      clickTime,
      snappedTime: snapped,
      savedFrame,
      match: savedFrame === 0,
      rawSavedFrame: rawSaved,
      positionSavedFrame,
      positionMatch: positionSavedFrame === 0,
    }];
  }

  // Gap mode
  const count = Math.max(2, Math.ceil(segWidth / thumbW));
  const capturedIndices = computeCaptureIndices(count, totalFrames);
  const intraCount = capturedIndices.length;

  // Snap uses thumbnail stream CTS
  const intraCtsSeconds = capturedIndices.map((idx) => thumbCts[idx]);

  const results: CrossStreamSlotResult[] = [];
  for (let j = 0; j < count; j++) {
    const displayedFrame = getDisplayedFrameIndex(j, count, capturedIndices);
    const arrIdx = slotToArrIdx(j, count, intraCount);

    const slotW = segWidth / count;
    const clickTime = segStart + (j + 0.5) * slotW / pxPerSec;

    const snapped = snapFn({
      clickTime, segStart, segEnd, pxPerSec, thumbW, fps,
      intraCount, intraCtsSeconds,
    });

    // CTS-based save: match snapped time against ACTIVE stream CTS
    const savedFrame = findClosestFrameIndex(snapped, activeCts);
    const rawSaved = findClosestFrameIndex(clickTime, activeCts);

    // Position-based save: compute normalized position from arrIdx,
    // then map to frame index in the active stream
    const position = arrIdxToPosition(arrIdx, intraCount);
    const positionSavedFrame = positionToFrameIndex(position, totalFrames);

    results.push({
      slotJ: j,
      displayedFrame,
      clickTime,
      snappedTime: snapped,
      savedFrame,
      match: savedFrame === displayedFrame,
      rawSavedFrame: rawSaved,
      positionSavedFrame,
      positionMatch: positionSavedFrame === displayedFrame,
    });
  }

  return results;
}
