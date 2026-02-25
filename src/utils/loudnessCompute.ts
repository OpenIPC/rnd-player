/**
 * Pure functions for EBU R128 / ITU-R BS.1770 loudness computation.
 *
 * All functions are stateless and operate on pre-computed data so they
 * can be unit-tested without Web Audio mocks.
 */

/** Channel weight factors per ITU-R BS.1770.
 *  Index follows SMPTE channel ordering: FL, FR, C, LFE, SL, SR.
 *  LFE is excluded (weight 0). SL/SR get +1.5 dB (×1.41). */
const CHANNEL_WEIGHTS_6CH = [1.0, 1.0, 1.0, 0.0, 1.41, 1.41];

/** Get channel weight for a given channel index and total channel count. */
export function channelWeight(chIndex: number, chCount: number): number {
  if (chCount <= 2) return 1.0; // Mono/stereo: all channels weight 1.0
  if (chCount === 6) return CHANNEL_WEIGHTS_6CH[chIndex] ?? 1.0;
  return 1.0; // Fallback for other layouts
}

/**
 * Compute the mean square power of a block of K-weighted samples.
 */
export function blockMeanSquare(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return sum / samples.length;
}

/**
 * Compute LUFS from per-channel mean square values.
 *
 * L = -0.691 + 10 × log10(Σ G_i × z_i)
 *
 * where G_i is the channel weight and z_i is the mean square for channel i.
 */
export function lufsFromMeanSquares(meanSquares: number[], chCount: number): number {
  let sum = 0;
  for (let i = 0; i < meanSquares.length; i++) {
    sum += channelWeight(i, chCount) * meanSquares[i];
  }
  if (sum <= 0) return -Infinity;
  return -0.691 + 10 * Math.log10(sum);
}

/**
 * Compute momentary/short-term loudness from a ring buffer of per-channel
 * mean-square values.
 *
 * @param ringBuffer Array of blocks, each block is number[] of per-channel mean squares.
 * @param blockCount How many blocks are valid in the ring buffer.
 * @param chCount Channel count.
 */
export function windowedLufs(
  ringBuffer: number[][],
  blockCount: number,
  chCount: number,
): number {
  if (blockCount === 0) return -Infinity;

  const avgPerCh = new Array<number>(chCount).fill(0);
  for (let b = 0; b < blockCount; b++) {
    const block = ringBuffer[b];
    for (let ch = 0; ch < chCount; ch++) {
      avgPerCh[ch] += block[ch];
    }
  }
  for (let ch = 0; ch < chCount; ch++) {
    avgPerCh[ch] /= blockCount;
  }

  return lufsFromMeanSquares(avgPerCh, chCount);
}

/** State for BS.1770 integrated loudness gating. */
export interface GatingState {
  /** Per-block loudness values (LUFS). */
  blockLoudnesses: number[];
  /** Per-block per-channel mean squares for recomputation through relative gate. */
  blockMeanSquares: number[][];
  /** Channel count (needed for weight computation). */
  chCount: number;
}

export function createGatingState(chCount: number): GatingState {
  return { blockLoudnesses: [], blockMeanSquares: [], chCount };
}

/** Add a 400ms block to the gating state. */
export function addGatingBlock(
  state: GatingState,
  perChannelMeanSq: number[],
): void {
  const lufs = lufsFromMeanSquares(perChannelMeanSq, state.chCount);
  state.blockLoudnesses.push(lufs);
  state.blockMeanSquares.push([...perChannelMeanSq]);
}

/**
 * Compute BS.1770 gated integrated loudness.
 *
 * 1. Absolute gate: discard blocks below -70 LUFS
 * 2. Compute Γ_a (mean of blocks above absolute gate)
 * 3. Relative gate: Γ_a − 10 LU
 * 4. Integrated = mean of blocks above relative gate
 */
export function computeIntegratedLoudness(state: GatingState): number {
  const { blockLoudnesses, blockMeanSquares, chCount } = state;
  if (blockLoudnesses.length === 0) return -Infinity;

  // Step 1: Absolute gate at -70 LUFS
  const absGateIndices: number[] = [];
  for (let i = 0; i < blockLoudnesses.length; i++) {
    if (blockLoudnesses[i] > -70) {
      absGateIndices.push(i);
    }
  }
  if (absGateIndices.length === 0) return -Infinity;

  // Step 2: Compute Γ_a (mean loudness of blocks above absolute gate)
  const gammaA = meanLoudnessFromBlocks(absGateIndices, blockMeanSquares, chCount);

  // Step 3: Relative gate = Γ_a − 10 LU
  const relGate = gammaA - 10;

  // Step 4: Filter blocks above relative gate
  const relGateIndices: number[] = [];
  for (const i of absGateIndices) {
    if (blockLoudnesses[i] > relGate) {
      relGateIndices.push(i);
    }
  }
  if (relGateIndices.length === 0) return -Infinity;

  return meanLoudnessFromBlocks(relGateIndices, blockMeanSquares, chCount);
}

/** Mean loudness computed from selected block indices. */
function meanLoudnessFromBlocks(
  indices: number[],
  blockMeanSquares: number[][],
  chCount: number,
): number {
  const avgPerCh = new Array<number>(chCount).fill(0);
  for (const idx of indices) {
    const block = blockMeanSquares[idx];
    for (let ch = 0; ch < chCount; ch++) {
      avgPerCh[ch] += block[ch];
    }
  }
  for (let ch = 0; ch < chCount; ch++) {
    avgPerCh[ch] /= indices.length;
  }
  return lufsFromMeanSquares(avgPerCh, chCount);
}

/** Reset the gating state (e.g. when user presses Reset). */
export function resetGatingState(state: GatingState): void {
  state.blockLoudnesses.length = 0;
  state.blockMeanSquares.length = 0;
}

// ── Loudness Range (LRA) per EBU Tech 3342 ──

const LRA_BINS = 1000;
const LRA_MIN_LUFS = -70;
const LRA_MAX_LUFS = 10;
const LRA_BIN_WIDTH = (LRA_MAX_LUFS - LRA_MIN_LUFS) / LRA_BINS; // 0.08 LU

export interface LraState {
  /** Histogram bins for short-term loudness values. */
  histogram: Uint32Array;
  /** Total blocks added. */
  totalBlocks: number;
  chCount: number;
  /** Short-term block loudnesses for absolute/relative gating. */
  stLoudnesses: number[];
}

export function createLraState(chCount: number): LraState {
  return {
    histogram: new Uint32Array(LRA_BINS),
    totalBlocks: 0,
    chCount,
    stLoudnesses: [],
  };
}

/** Add a short-term loudness value (3s window) to the LRA histogram. */
export function addLraBlock(state: LraState, stLufs: number): void {
  state.stLoudnesses.push(stLufs);
  const bin = Math.floor((stLufs - LRA_MIN_LUFS) / LRA_BIN_WIDTH);
  if (bin >= 0 && bin < LRA_BINS) {
    state.histogram[bin]++;
    state.totalBlocks++;
  }
}

/**
 * Compute Loudness Range (LRA) per EBU Tech 3342.
 *
 * 1. Absolute gate: -70 LUFS
 * 2. Relative gate: mean − 20 LU
 * 3. LRA = 95th percentile − 10th percentile
 */
export function computeLra(state: LraState): number {
  if (state.totalBlocks < 2) return 0;

  // Step 1: Absolute gate — count blocks above -70 LUFS
  const absGateBin = Math.floor((-70 - LRA_MIN_LUFS) / LRA_BIN_WIDTH);
  let countAboveAbs = 0;
  let sumForMean = 0;
  for (let i = Math.max(0, absGateBin + 1); i < LRA_BINS; i++) {
    if (state.histogram[i] > 0) {
      countAboveAbs += state.histogram[i];
      const binCenter = LRA_MIN_LUFS + (i + 0.5) * LRA_BIN_WIDTH;
      // Convert LUFS back to linear for proper averaging
      sumForMean += state.histogram[i] * Math.pow(10, binCenter / 10);
    }
  }
  if (countAboveAbs === 0) return 0;

  // Step 2: Relative gate = mean − 20 LU
  const meanLinear = sumForMean / countAboveAbs;
  const meanLufs = 10 * Math.log10(meanLinear);
  const relGateLufs = meanLufs - 20;
  const relGateBin = Math.floor((relGateLufs - LRA_MIN_LUFS) / LRA_BIN_WIDTH);

  // Count blocks above relative gate
  let countAboveRel = 0;
  for (let i = Math.max(0, relGateBin + 1); i < LRA_BINS; i++) {
    countAboveRel += state.histogram[i];
  }
  if (countAboveRel < 2) return 0;

  // Step 3: Find 10th and 95th percentiles
  const p10Target = Math.ceil(countAboveRel * 0.10);
  const p95Target = Math.ceil(countAboveRel * 0.95);

  let cumulative = 0;
  let p10Lufs = LRA_MIN_LUFS;
  let p95Lufs = LRA_MAX_LUFS;

  for (let i = Math.max(0, relGateBin + 1); i < LRA_BINS; i++) {
    if (state.histogram[i] === 0) continue;
    cumulative += state.histogram[i];
    const binCenter = LRA_MIN_LUFS + (i + 0.5) * LRA_BIN_WIDTH;
    if (cumulative >= p10Target && p10Lufs === LRA_MIN_LUFS) {
      p10Lufs = binCenter;
    }
    if (cumulative >= p95Target) {
      p95Lufs = binCenter;
      break;
    }
  }

  return Math.max(0, p95Lufs - p10Lufs);
}

export function resetLraState(state: LraState): void {
  state.histogram.fill(0);
  state.totalBlocks = 0;
  state.stLoudnesses.length = 0;
}
