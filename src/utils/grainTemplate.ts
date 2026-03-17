/**
 * Film grain template generator using autoregressive (AR) process.
 *
 * Generates a 512x512 seamlessly-tileable grain texture using toroidal
 * boundary conditions. No blocks, no seams — GL_REPEAT handles tiling.
 */

import type { GrainSize } from "../types/filmGrain";

/** Texture dimensions — large enough that tiling isn't visible at 1080p */
export const GRAIN_TEXTURE_SIZE = 512;

/** AR lag for each grain size preset */
const AR_LAG: Record<GrainSize, number> = {
  fine: 0,
  medium: 1,
  coarse: 2,
};

/**
 * 16-bit LFSR PRNG matching AV1 spec: x^16 + x^15 + x^13 + x^4 + 1
 */
function lfsr16(seed: number): () => number {
  let state = seed & 0xFFFF;
  if (state === 0) state = 0xACE1;
  return () => {
    const bit = ((state >> 0) ^ (state >> 1) ^ (state >> 3) ^ (state >> 12)) & 1;
    state = ((state >> 1) | (bit << 15)) & 0xFFFF;
    return state;
  };
}

/**
 * Box-Muller transform: produce a standard normal random value from uniform LFSR.
 */
function gaussianFromLfsr(rng: () => number): number {
  const u1 = (rng() + 1) / 65537; // avoid log(0)
  const u2 = rng() / 65536;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** AR coefficients for each lag level */
const AR_COEFFS: Record<number, number[][]> = {
  // Lag 0: pure white noise
  0: [],
  // Lag 1: 3x3 kernel (4 causal neighbors), sum = 0.40
  1: [
    [0.0, 0.20, 0.0],
    [0.20, 0.0, 0.0],
  ],
  // Lag 2: 5x5 kernel (12 causal neighbors), sum ≈ 0.71
  2: [
    [0.00, 0.03, 0.06, 0.03, 0.00],
    [0.03, 0.09, 0.16, 0.09, 0.00],
    [0.06, 0.16, 0.00, 0.00, 0.00],
  ],
};

/**
 * Generate a seamlessly-tileable grain texture using toroidal AR process.
 * Returns a Float32Array of size GRAIN_TEXTURE_SIZE^2 with values in [-1, 1].
 */
export function generateGrainTemplate(
  size: GrainSize,
  seed: number = 7391,
): Float32Array {
  const N = GRAIN_TEXTURE_SIZE;
  const template = new Float32Array(N * N);
  const rng = lfsr16(seed);
  const lag = AR_LAG[size];

  if (lag === 0) {
    // Pure white noise — no spatial correlation
    for (let i = 0; i < N * N; i++) {
      template[i] = gaussianFromLfsr(rng);
    }
  } else {
    // Fill innovation noise
    const noise = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      noise[i] = gaussianFromLfsr(rng);
    }

    const coeffs = AR_COEFFS[lag];
    const kH = coeffs.length;
    const kW = coeffs[0].length;
    const kCenterX = Math.floor(kW / 2);
    const kCenterY = kH - 1;

    // 2 passes: pass 2 sees AR-filtered values from pass 1 when wrapping
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          let sum = 0;

          for (let ky = 0; ky < kH; ky++) {
            for (let kx = 0; kx < kW; kx++) {
              const coeff = coeffs[ky][kx];
              if (coeff === 0) continue;

              const dy = ky - kCenterY;
              const dx = kx - kCenterX;

              // Only causal pixels: above current row, or same row to the left
              if (dy > 0 || (dy === 0 && dx >= 0)) continue;

              // Toroidal wrapping
              const ny = ((y + dy) % N + N) % N;
              const nx = ((x + dx) % N + N) % N;

              sum += coeff * template[ny * N + nx];
            }
          }

          template[y * N + x] = sum + noise[y * N + x];
        }
      }
    }
  }

  // Sigma-clipping normalization: center, clip to ±3σ, scale to [-1, 1]
  const len = N * N;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += template[i];
  const mean = sum / len;
  for (let i = 0; i < len; i++) template[i] -= mean;

  let sumSq = 0;
  for (let i = 0; i < len; i++) sumSq += template[i] * template[i];
  const sigma = Math.sqrt(sumSq / len);

  if (sigma > 0) {
    const clip = 3 * sigma;
    const scale = 1 / clip;
    for (let i = 0; i < len; i++) {
      template[i] = Math.max(-1, Math.min(1, template[i] * scale));
    }
  }

  return template;
}
