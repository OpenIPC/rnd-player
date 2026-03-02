/**
 * Software IIR biquad filter for use in Web Workers where Web Audio
 * IIRFilterNode is unavailable. Implements the same Direct Form I
 * transfer function used by the browser's IIRFilterNode:
 *
 *   y[n] = (b0·x[n] + b1·x[n-1] + b2·x[n-2] - a1·y[n-1] - a2·y[n-2]) / a0
 *
 * State persists across blocks within a segment for filter continuity.
 */

import type { BiquadCoeffs, KWeightCoeffs } from "./kWeighting";

export interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export function createBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

/**
 * Apply a biquad IIR filter to a block of samples in-place.
 * Returns a new Float32Array with filtered output.
 */
export function applyBiquad(
  samples: Float32Array,
  coeffs: BiquadCoeffs,
  state: BiquadState,
): Float32Array {
  const [b0, b1, b2] = coeffs.b;
  const [a0, a1, a2] = coeffs.a;
  const out = new Float32Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = (b0 * x + b1 * state.x1 + b2 * state.x2 - a1 * state.y1 - a2 * state.y2) / a0;
    state.x2 = state.x1;
    state.x1 = x;
    state.y2 = state.y1;
    state.y1 = y;
    out[i] = y;
  }

  return out;
}

/**
 * Apply K-weighting (shelf + HPF cascade) to a block of samples.
 * Returns K-weighted output as Float32Array.
 */
export function applyKWeighting(
  samples: Float32Array,
  kCoeffs: KWeightCoeffs,
  shelfState: BiquadState,
  hpfState: BiquadState,
): Float32Array {
  const shelved = applyBiquad(samples, kCoeffs.shelf, shelfState);
  return applyBiquad(shelved, kCoeffs.highpass, hpfState);
}
