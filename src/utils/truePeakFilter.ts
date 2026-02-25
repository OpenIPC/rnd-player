/**
 * True Peak measurement per ITU-R BS.1770 Annex 2.
 *
 * 4× oversampling via polyphase FIR decomposition:
 * 48-tap Kaiser-windowed sinc (beta=7.0, fc=0.25) decomposed into
 * 4 phases of 12 taps each.
 *
 * For each input sample, compute 4 interpolated values, track max absolute
 * across all. Convert to dBTP: 20 × log10(maxVal).
 */

const OVERSAMPLING = 4;
const TAPS_PER_PHASE = 12;

/** Pre-computed polyphase FIR coefficients (4 phases × 12 taps).
 *  Generated from a 48-tap Kaiser-windowed sinc, beta=7.0, fc=0.25.
 *  Phase p uses taps at indices p, p+4, p+8, ..., p+44 of the prototype. */
function computePolyphaseCoeffs(): Float64Array[] {
  const totalTaps = OVERSAMPLING * TAPS_PER_PHASE; // 48
  const beta = 7.0;

  // Kaiser window: I0(beta * sqrt(1 - ((n - M) / M)^2)) / I0(beta)
  // where M = (totalTaps - 1) / 2
  const M = (totalTaps - 1) / 2;

  const prototype = new Float64Array(totalTaps);
  for (let n = 0; n < totalTaps; n++) {
    // Sinc normalized to input-rate samples: sinc((n-M)/L)
    // Zeros at every L-th prototype tap → proper interpolation
    const x = (n - M) / OVERSAMPLING;
    const sincVal = Math.abs(x) < 1e-10 ? 1.0 : Math.sin(Math.PI * x) / (Math.PI * x);
    // Kaiser window
    const arg = beta * Math.sqrt(1 - ((n - M) / M) ** 2);
    const window = bessel0(arg) / bessel0(beta);
    prototype[n] = sincVal * window;
  }

  // Normalize so that the sum of prototype taps = oversampling factor
  let sum = 0;
  for (let n = 0; n < totalTaps; n++) sum += prototype[n];
  const scale = OVERSAMPLING / sum;
  for (let n = 0; n < totalTaps; n++) prototype[n] *= scale;

  // Decompose into polyphase components, normalize each phase for unity DC gain
  const phases: Float64Array[] = [];
  for (let p = 0; p < OVERSAMPLING; p++) {
    const phase = new Float64Array(TAPS_PER_PHASE);
    let phaseSum = 0;
    for (let k = 0; k < TAPS_PER_PHASE; k++) {
      phase[k] = prototype[p + k * OVERSAMPLING];
      phaseSum += phase[k];
    }
    // Normalize each phase independently so DC input maps to DC output (gain = 1.0)
    if (Math.abs(phaseSum) > 1e-10) {
      const phaseScale = 1.0 / phaseSum;
      for (let k = 0; k < TAPS_PER_PHASE; k++) {
        phase[k] *= phaseScale;
      }
    }
    phases.push(phase);
  }

  return phases;
}

/** Modified Bessel function of the first kind, order 0. */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  const xHalfSq = (x / 2) ** 2;
  for (let k = 1; k <= 20; k++) {
    term *= xHalfSq / (k * k);
    sum += term;
    if (term < 1e-15 * sum) break;
  }
  return sum;
}

const POLYPHASE = computePolyphaseCoeffs();

/** Per-channel true peak state. */
export interface TruePeakState {
  history: Float64Array; // TAPS_PER_PHASE samples
  maxAbs: number;        // Running maximum absolute value
}

export function createTruePeakState(): TruePeakState {
  return {
    history: new Float64Array(TAPS_PER_PHASE),
    maxAbs: 0,
  };
}

/**
 * Process a block of samples, updating the running true peak.
 * Returns the current max true peak in dBTP.
 */
export function processTruePeak(state: TruePeakState, samples: Float32Array): number {
  const { history } = state;
  const histLen = TAPS_PER_PHASE;

  for (let i = 0; i < samples.length; i++) {
    // Shift history left, push new sample
    for (let h = 0; h < histLen - 1; h++) {
      history[h] = history[h + 1];
    }
    history[histLen - 1] = samples[i];

    // Compute 4 interpolated values from polyphase decomposition
    for (let p = 0; p < OVERSAMPLING; p++) {
      const coeffs = POLYPHASE[p];
      let sum = 0;
      for (let k = 0; k < histLen; k++) {
        sum += coeffs[k] * history[k];
      }
      const abs = Math.abs(sum);
      if (abs > state.maxAbs) state.maxAbs = abs;
    }
  }

  return truePeakToDbtp(state.maxAbs);
}

/** Convert a linear true peak value to dBTP. */
export function truePeakToDbtp(val: number): number {
  if (val <= 0) return -Infinity;
  return 20 * Math.log10(val);
}

/** Reset the running maximum. */
export function resetTruePeak(state: TruePeakState): void {
  state.maxAbs = 0;
  state.history.fill(0);
}
