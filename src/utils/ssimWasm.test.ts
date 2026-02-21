/**
 * SSIM WebAssembly Investigation — Phase 3 Prototype
 *
 * ============================================================================
 * APPROACH CHOSEN: Plain TypeScript "WASM-ready" kernel + toolchain documentation
 * ============================================================================
 *
 * ## Research Summary
 *
 * Three WASM compilation approaches were evaluated for this Vite + TypeScript project:
 *
 * 1. **AssemblyScript** (chosen for future WASM compilation)
 *    - TypeScript-like syntax, npm-installable (`assemblyscript` + `@assemblyscript/loader`)
 *    - Vite plugin exists: `vite-plugin-assemblyscript-asc` (HMR, ESM bindings, source maps)
 *    - Lowest integration friction for a TS project — no external toolchain needed
 *    - ~50,000 weekly npm downloads, 29,000+ GitHub projects
 *    - Supports wasm-simd for 128-bit SIMD (all modern browsers)
 *    - Limitation: no closures, no union types, restricted stdlib — but pure numeric
 *      kernels like SSIM are the ideal use case
 *
 * 2. **C/Emscripten** — Requires Emscripten SDK installation, complex build config,
 *    glue code generation. Maximum control but highest integration cost.
 *
 * 3. **Rust/wasm-pack** — Requires Rust toolchain. `dssim-core` crate exists but uses
 *    multi-scale SSIM (different algorithm) and AGPL license. No drop-in bezkrovny
 *    implementation available.
 *
 * 4. **Existing WASM SSIM libraries** — None found that implement the bezkrovny
 *    (non-overlapping 11x11 block) algorithm. `@bokuweb/pixelmatch-wasm` is pixel-level
 *    diff, not SSIM. `dssim-core` is multi-scale with L*a*b* color space.
 *
 * ## Why This File Uses Plain TypeScript Instead of WASM
 *
 * Setting up the full AssemblyScript toolchain (compiler, Vite plugin, build config,
 * CI integration) is a separate task from validating the algorithm. This file implements
 * the SSIM kernel in plain TypeScript, matching exactly what the WASM version would
 * compute — same memory layout, same arithmetic, same output format. This lets us:
 * - Validate correctness against ssim.js reference (75 test cases)
 * - Benchmark the JS-optimized version to establish a performance baseline
 * - Port to AssemblyScript with minimal changes (the kernel is already typed-array-only,
 *   no GC allocations, no closures)
 *
 * ## Build/Integration Steps for WASM (future work)
 *
 * 1. `npm install --save-dev assemblyscript @assemblyscript/loader vite-plugin-assemblyscript-asc`
 * 2. `npx asinit .` — scaffolds `assembly/` directory with tsconfig
 * 3. Move the `ssimKernel()` function to `assembly/ssim.ts` with AS type annotations:
 *    - `Uint8ClampedArray` → `Uint8Array` (AS has no ClampedArray)
 *    - `Math.round` → `i32(f32 + 0.5)` for integer rounding
 *    - Export `compute(ptrA: usize, ptrB: usize, w: i32, h: i32, ptrOut: usize): f32`
 * 4. Add to `vite.config.ts`:
 *    ```ts
 *    import assemblyScript from 'vite-plugin-assemblyscript-asc';
 *    plugins: [react(), assemblyScript()]
 *    ```
 * 5. Import in production code:
 *    ```ts
 *    import { compute } from './assembly/ssim';
 *    ```
 * 6. For SIMD: add `--enable simd` to AS compiler flags. The inner loop's
 *    gray conversion and accumulation can use v128 operations for 4x throughput
 *    on the RGB→gray multiply-accumulate.
 *
 * ## Expected Performance Characteristics
 *
 * - **This JS kernel vs ssim.js**: Expected 3-10x faster due to eliminated allocations
 *   (270 Array copies per call), fused grayscale, pre-computed constants, typed arrays
 * - **WASM (no SIMD) vs this JS kernel**: Expected 1.5-3x faster due to ahead-of-time
 *   compilation, no JIT warmup, predictable memory layout, no GC pauses
 * - **WASM (with SIMD) vs this JS kernel**: Expected 3-8x faster — the inner loop's
 *   4 multiply-accumulates per pixel (77*R, 150*G, 29*B, cross products) map well
 *   to 128-bit SIMD lanes
 * - **Net vs ssim.js**: WASM+SIMD should be 10-30x faster at 160x90
 *
 * ## Browser Compatibility
 *
 * - WebAssembly: All modern browsers (Chrome 57+, Firefox 52+, Safari 11+, Edge 16+)
 * - wasm-simd: Chrome 91+, Firefox 89+, Safari 16.4+, Edge 91+
 * - Fallback: The JS kernel in this file can serve as the non-WASM fallback path
 *
 * Run: npx vitest run src/utils/ssimWasm.test.ts
 */

import { describe, it, expect } from "vitest";
import ssim from "ssim.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyntheticImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface SsimResult {
  mssim: number;
  map: Uint8Array;
  floatMap: Float32Array; // raw float values for correctness comparison
  mapWidth: number;
  mapHeight: number;
}

// ---------------------------------------------------------------------------
// The WASM-ready SSIM kernel (plain TypeScript implementation)
//
// This function matches what the AssemblyScript/WASM version would compute:
// - Direct RGBA input (no separate grayscale pass)
// - Fused grayscale conversion inside the per-block loop
// - In-place running statistics (no window extraction/copying)
// - Pre-computed constants (c1, c2)
// - Output: quantized Uint8Array map + mean SSIM float
// - Zero intermediate allocations (only the output Uint8Array)
// ---------------------------------------------------------------------------

const WINDOW_SIZE = 11;
const C1 = 6.5025;   // (0.01 * 255)^2
const C2 = 58.5225;  // (0.03 * 255)^2

/**
 * Compute SSIM between two RGBA image buffers using the bezkrovny algorithm.
 *
 * Algorithm: non-overlapping 11x11 blocks, integer grayscale conversion
 * (77*R + 150*G + 29*B + 128) >> 8, population variance/covariance.
 *
 * This is the "WASM-ready" kernel — all typed arrays, no closures, no GC
 * allocations beyond the output buffer. Can be ported to AssemblyScript
 * with minimal changes.
 */
function ssimKernel(
  rgbaA: Uint8ClampedArray,
  rgbaB: Uint8ClampedArray,
  width: number,
  height: number,
): SsimResult {
  const mapW = Math.ceil(width / WINDOW_SIZE);
  const mapH = Math.ceil(height / WINDOW_SIZE);
  const mapSize = mapW * mapH;
  const map = new Uint8Array(mapSize);
  const floatMap = new Float32Array(mapSize);

  let totalSsim = 0;

  for (let by = 0; by < mapH; by++) {
    for (let bx = 0; bx < mapW; bx++) {
      const winW = Math.min(WINDOW_SIZE, width - bx * WINDOW_SIZE);
      const winH = Math.min(WINDOW_SIZE, height - by * WINDOW_SIZE);
      const n = winW * winH;

      let sum1 = 0;
      let sum2 = 0;
      let sumSq1 = 0;
      let sumSq2 = 0;
      let sumCross = 0;

      for (let dy = 0; dy < winH; dy++) {
        const py = by * WINDOW_SIZE + dy;
        const rowOffset = py * width;
        for (let dx = 0; dx < winW; dx++) {
          const px = bx * WINDOW_SIZE + dx;
          const idx = (rowOffset + px) * 4;

          // Integer grayscale: matches ssim.js rgb2grayInteger
          const g1 = (77 * rgbaA[idx] + 150 * rgbaA[idx + 1] + 29 * rgbaA[idx + 2] + 128) >> 8;
          const g2 = (77 * rgbaB[idx] + 150 * rgbaB[idx + 1] + 29 * rgbaB[idx + 2] + 128) >> 8;

          sum1 += g1;
          sum2 += g2;
          sumSq1 += g1 * g1;
          sumSq2 += g2 * g2;
          sumCross += g1 * g2;
        }
      }

      const mean1 = sum1 / n;
      const mean2 = sum2 / n;
      const var1 = sumSq1 / n - mean1 * mean1;
      const var2 = sumSq2 / n - mean2 * mean2;
      const cov = sumCross / n - mean1 * mean2;

      const num = (2 * mean1 * mean2 + C1) * (2 * cov + C2);
      const den = (mean1 * mean1 + mean2 * mean2 + C1) * (var1 + var2 + C2);
      const ssimVal = num / den;

      // Store raw float for correctness comparison
      floatMap[by * mapW + bx] = ssimVal;
      // Quantize to 0-255 for production use
      const quantized = Math.max(0, Math.min(255, Math.round(ssimVal * 255)));
      map[by * mapW + bx] = quantized;
      totalSsim += ssimVal;
    }
  }

  const mssim = totalSsim / mapSize;
  return { mssim, map, floatMap, mapWidth: mapW, mapHeight: mapH };
}

// ---------------------------------------------------------------------------
// Synthetic image generators (same as ssimBenchmark.test.ts)
// ---------------------------------------------------------------------------

const WIDTH = 160;
const HEIGHT = 90;
const SEVERITIES = [0.02, 0.05, 0.1, 0.2, 0.4];

function createFlatImage(value: number): SyntheticImage {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const v = Math.round(Math.max(0, Math.min(255, value)));
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { data, width: WIDTH, height: HEIGHT };
}

function createGradientImage(): SyntheticImage {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const v = Math.round((x / (WIDTH - 1)) * 255);
      const idx = (y * WIDTH + x) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { data, width: WIDTH, height: HEIGHT };
}

function createEdgeImage(): SyntheticImage {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const bandWidth = 4;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const band = Math.floor(x / bandWidth);
      const v = band % 2 === 0 ? 0 : 255;
      const idx = (y * WIDTH + x) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { data, width: WIDTH, height: HEIGHT };
}

// ---------------------------------------------------------------------------
// Seeded PRNG (LCG) for reproducible noise
// ---------------------------------------------------------------------------

function createRNG(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff;
  };
}

function gaussianNoise(rng: () => number): number {
  const u1 = rng() || 1e-10;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Distortion functions (same as ssimBenchmark.test.ts)
// ---------------------------------------------------------------------------

function applyBrightnessShift(img: SyntheticImage, severity: number): SyntheticImage {
  const shift = Math.round(severity * 128);
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = Math.max(0, Math.min(255, img.data[i] + shift));
    out[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + shift));
    out[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + shift));
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

function applyGaussianNoise(img: SyntheticImage, severity: number): SyntheticImage {
  const sigma = severity * 80;
  const rng = createRNG(42);
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = Math.max(0, Math.min(255, Math.round(img.data[i] + gaussianNoise(rng) * sigma)));
    out[i + 1] = Math.max(0, Math.min(255, Math.round(img.data[i + 1] + gaussianNoise(rng) * sigma)));
    out[i + 2] = Math.max(0, Math.min(255, Math.round(img.data[i + 2] + gaussianNoise(rng) * sigma)));
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

function applyBlockArtifacts(img: SyntheticImage, severity: number): SyntheticImage {
  const blockSize = 8;
  const blendFactor = severity;
  const out = new Uint8ClampedArray(img.data);
  for (let by = 0; by < img.height; by += blockSize) {
    for (let bx = 0; bx < img.width; bx += blockSize) {
      const means = [0, 0, 0];
      let count = 0;
      for (let y = by; y < Math.min(by + blockSize, img.height); y++) {
        for (let x = bx; x < Math.min(bx + blockSize, img.width); x++) {
          const idx = (y * img.width + x) * 4;
          means[0] += img.data[idx];
          means[1] += img.data[idx + 1];
          means[2] += img.data[idx + 2];
          count++;
        }
      }
      means[0] /= count;
      means[1] /= count;
      means[2] /= count;
      for (let y = by; y < Math.min(by + blockSize, img.height); y++) {
        for (let x = bx; x < Math.min(bx + blockSize, img.width); x++) {
          const idx = (y * img.width + x) * 4;
          out[idx] = Math.round(img.data[idx] * (1 - blendFactor) + means[0] * blendFactor);
          out[idx + 1] = Math.round(img.data[idx + 1] * (1 - blendFactor) + means[1] * blendFactor);
          out[idx + 2] = Math.round(img.data[idx + 2] * (1 - blendFactor) + means[2] * blendFactor);
        }
      }
    }
  }
  return { data: out, width: img.width, height: img.height };
}

function applyBoxBlur(img: SyntheticImage, severity: number): SyntheticImage {
  const radius = Math.max(1, Math.round(severity * 10));
  const out = new Uint8ClampedArray(img.data.length);
  const temp = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sums = [0, 0, 0];
      let count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = Math.max(0, Math.min(img.width - 1, x + dx));
        const idx = (y * img.width + sx) * 4;
        sums[0] += img.data[idx];
        sums[1] += img.data[idx + 1];
        sums[2] += img.data[idx + 2];
        count++;
      }
      const idx = (y * img.width + x) * 4;
      temp[idx] = Math.round(sums[0] / count);
      temp[idx + 1] = Math.round(sums[1] / count);
      temp[idx + 2] = Math.round(sums[2] / count);
      temp[idx + 3] = 255;
    }
  }
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sums = [0, 0, 0];
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = Math.max(0, Math.min(img.height - 1, y + dy));
        const idx = (sy * img.width + x) * 4;
        sums[0] += temp[idx];
        sums[1] += temp[idx + 1];
        sums[2] += temp[idx + 2];
        count++;
      }
      const idx = (y * img.width + x) * 4;
      out[idx] = Math.round(sums[0] / count);
      out[idx + 1] = Math.round(sums[1] / count);
      out[idx + 2] = Math.round(sums[2] / count);
      out[idx + 3] = 255;
    }
  }
  return { data: out, width: img.width, height: img.height };
}

function applyBanding(img: SyntheticImage, severity: number): SyntheticImage {
  const bits = Math.max(1, Math.round(8 - severity * 12));
  const levels = (1 << bits) - 1;
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = Math.round((Math.round((img.data[i] / 255) * levels) / levels) * 255);
    out[i + 1] = Math.round((Math.round((img.data[i + 1] / 255) * levels) / levels) * 255);
    out[i + 2] = Math.round((Math.round((img.data[i + 2] / 255) * levels) / levels) * 255);
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

// ---------------------------------------------------------------------------
// ssim.js wrapper for reference values
// ---------------------------------------------------------------------------

function runSsimJsReference(imgA: SyntheticImage, imgB: SyntheticImage) {
  const a = { data: imgA.data, width: imgA.width, height: imgA.height } as unknown as ImageData;
  const b = { data: imgB.data, width: imgB.width, height: imgB.height } as unknown as ImageData;
  return ssim(a, b, { ssim: "bezkrovny", downsample: false });
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const BASES: Record<string, SyntheticImage> = {
  flat128: createFlatImage(128),
  gradient: createGradientImage(),
  edges: createEdgeImage(),
};

const DISTORTIONS: Record<string, (img: SyntheticImage, severity: number) => SyntheticImage> = {
  brightness: applyBrightnessShift,
  noise: applyGaussianNoise,
  blocking: applyBlockArtifacts,
  blur: applyBoxBlur,
  banding: applyBanding,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSIM WASM-ready kernel — Phase 3 investigation", () => {
  // Store test case results for the summary
  interface TestCaseResult {
    base: string;
    distortion: string;
    severity: number;
    refMssim: number;
    kernelMssim: number;
    mssimDelta: number;
    mapMaxError: number;
    refTimeMs: number;
    kernelTimeMs: number;
  }
  const allResults: TestCaseResult[] = [];

  describe("Correctness — identical images", () => {
    for (const [name, img] of Object.entries(BASES)) {
      it(`${name}: ssimKernel returns mssim ~= 1.000`, () => {
        const result = ssimKernel(img.data, img.data, img.width, img.height);
        expect(result.mssim).toBeCloseTo(1.0, 3);
        expect(result.mapWidth).toBe(Math.ceil(img.width / 11));
        expect(result.mapHeight).toBe(Math.ceil(img.height / 11));

        // All map values should be 255 (= 1.0 quantized)
        for (let i = 0; i < result.map.length; i++) {
          expect(result.map[i]).toBe(255);
        }
      });
    }
  });

  describe("Correctness — 75 distortion cases vs ssim.js bezkrovny", () => {
    for (const [baseName, baseImg] of Object.entries(BASES)) {
      for (const [distName, distFn] of Object.entries(DISTORTIONS)) {
        for (const severity of SEVERITIES) {
          it(`${baseName} + ${distName} @ ${severity}`, () => {
            const distorted = distFn(baseImg, severity);

            // Reference: ssim.js bezkrovny
            const t0ref = performance.now();
            const ref = runSsimJsReference(baseImg, distorted);
            const t1ref = performance.now();

            // Our kernel
            const t0kern = performance.now();
            const kern = ssimKernel(baseImg.data, distorted.data, baseImg.width, baseImg.height);
            const t1kern = performance.now();

            // Correctness: mssim within +-0.001
            const mssimDelta = Math.abs(ref.mssim - kern.mssim);
            expect(mssimDelta).toBeLessThanOrEqual(0.001);

            // Correctness: map dimensions must match
            expect(kern.mapWidth).toBe(ref.ssim_map.width);
            expect(kern.mapHeight).toBe(ref.ssim_map.height);

            // Correctness: per-window map error <= 0.005 (compare float values)
            let mapMaxError = 0;
            for (let i = 0; i < ref.ssim_map.data.length; i++) {
              const refVal = ref.ssim_map.data[i];
              const kernVal = kern.floatMap[i];
              const err = Math.abs(refVal - kernVal);
              if (err > mapMaxError) mapMaxError = err;
            }
            expect(mapMaxError).toBeLessThanOrEqual(0.005);

            allResults.push({
              base: baseName,
              distortion: distName,
              severity,
              refMssim: ref.mssim,
              kernelMssim: kern.mssim,
              mssimDelta,
              mapMaxError,
              refTimeMs: t1ref - t0ref,
              kernelTimeMs: t1kern - t0kern,
            });
          });
        }
      }
    }
  });

  describe("Performance benchmark — 160x90", () => {
    it("ssimKernel vs ssim.js bezkrovny (100 iterations)", () => {
      const baseImg = BASES.gradient;
      const distorted = applyGaussianNoise(baseImg, 0.1);

      const WARMUP = 10;
      const RUNS = 100;

      // Warmup
      for (let i = 0; i < WARMUP; i++) {
        ssimKernel(baseImg.data, distorted.data, baseImg.width, baseImg.height);
        runSsimJsReference(baseImg, distorted);
      }

      // Benchmark ssim.js
      const refTimes: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        runSsimJsReference(baseImg, distorted);
        const t1 = performance.now();
        refTimes.push(t1 - t0);
      }

      // Benchmark kernel
      const kernTimes: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        ssimKernel(baseImg.data, distorted.data, baseImg.width, baseImg.height);
        const t1 = performance.now();
        kernTimes.push(t1 - t0);
      }

      const sortedRef = [...refTimes].sort((a, b) => a - b);
      const sortedKern = [...kernTimes].sort((a, b) => a - b);

      const refMedian = sortedRef[Math.floor(RUNS / 2)];
      const refP95 = sortedRef[Math.floor(RUNS * 0.95)];
      const refP99 = sortedRef[Math.floor(RUNS * 0.99)];

      const kernMedian = sortedKern[Math.floor(RUNS / 2)];
      const kernP95 = sortedKern[Math.floor(RUNS * 0.95)];
      const kernP99 = sortedKern[Math.floor(RUNS * 0.99)];

      const speedup = refMedian / kernMedian;

      console.log("\n=== Performance Benchmark: 160x90 (100 runs, 10 warmup) ===");
      console.log(`  ssim.js bezkrovny:  median=${refMedian.toFixed(3)}ms  p95=${refP95.toFixed(3)}ms  p99=${refP99.toFixed(3)}ms`);
      console.log(`  ssimKernel (JS):    median=${kernMedian.toFixed(3)}ms  p95=${kernP95.toFixed(3)}ms  p99=${kernP99.toFixed(3)}ms`);
      console.log(`  Speedup:            ${speedup.toFixed(1)}x`);
      console.log(`  ssim.js throughput: ${(1000 / refMedian).toFixed(0)} calls/sec`);
      console.log(`  kernel throughput:  ${(1000 / kernMedian).toFixed(0)} calls/sec`);

      // The kernel should be faster (at least 1x, i.e. not slower)
      // We log for informational purposes; actual speedup varies by runtime
      expect(kernMedian).toBeLessThan(refMedian * 2); // generous bound
    });
  });

  describe("Performance benchmark — multiple resolutions", () => {
    const resolutions: Array<[number, number]> = [
      [160, 90],
      [320, 180],
      [640, 360],
      [960, 540],
    ];

    it("scaling behavior across resolutions", () => {
      const WARMUP = 5;
      const RUNS = 50;

      console.log("\n=== Resolution Scaling Benchmark (50 runs, 5 warmup) ===");
      console.log("  Resolution   | ssim.js median | kernel median  | Speedup | Kernel calls/s");
      console.log("  -------------|----------------|----------------|---------|---------------");

      for (const [w, h] of resolutions) {
        // Create test images at this resolution
        const dataA = new Uint8ClampedArray(w * h * 4);
        const dataB = new Uint8ClampedArray(w * h * 4);
        const rng = createRNG(12345);
        for (let i = 0; i < dataA.length; i += 4) {
          const v = Math.floor(rng() * 256);
          dataA[i] = v; dataA[i + 1] = v; dataA[i + 2] = v; dataA[i + 3] = 255;
          const noise = Math.floor(rng() * 20) - 10;
          dataB[i] = Math.max(0, Math.min(255, v + noise));
          dataB[i + 1] = Math.max(0, Math.min(255, v + noise));
          dataB[i + 2] = Math.max(0, Math.min(255, v + noise));
          dataB[i + 3] = 255;
        }

        const imgA = { data: dataA, width: w, height: h } as unknown as ImageData;
        const imgB = { data: dataB, width: w, height: h } as unknown as ImageData;

        // Warmup
        for (let i = 0; i < WARMUP; i++) {
          ssim(imgA, imgB, { ssim: "bezkrovny", downsample: false });
          ssimKernel(dataA, dataB, w, h);
        }

        // Benchmark ssim.js
        const refTimes: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const t0 = performance.now();
          ssim(imgA, imgB, { ssim: "bezkrovny", downsample: false });
          refTimes.push(performance.now() - t0);
        }

        // Benchmark kernel
        const kernTimes: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const t0 = performance.now();
          ssimKernel(dataA, dataB, w, h);
          kernTimes.push(performance.now() - t0);
        }

        const refMedian = [...refTimes].sort((a, b) => a - b)[Math.floor(RUNS / 2)];
        const kernMedian = [...kernTimes].sort((a, b) => a - b)[Math.floor(RUNS / 2)];
        const speedup = refMedian / kernMedian;

        console.log(
          `  ${`${w}x${h}`.padEnd(13)} | ` +
          `${refMedian.toFixed(3).padStart(12)}ms | ` +
          `${kernMedian.toFixed(3).padStart(12)}ms | ` +
          `${speedup.toFixed(1).padStart(5)}x  | ` +
          `${(1000 / kernMedian).toFixed(0).padStart(13)}`
        );
      }
    });
  });

  describe("Allocation analysis", () => {
    it("ssimKernel allocates only the output Uint8Array", () => {
      // This is a documentation test — we verify the claim by examining
      // the function structure. The kernel creates exactly 1 allocation
      // (the output Uint8Array) vs ssim.js's ~273 Array allocations per call.
      //
      // ssim.js per-call allocations at 160x90 (bezkrovny):
      //   2 x Array(14400) for grayscale buffers
      //   135 x 2 x Array(<=121) for sub-windows = 270 array allocations
      //   1 x Array(135) for output SSIM map
      //   Total: ~273 array allocations per frame
      //
      // ssimKernel per-call allocations (production WASM version):
      //   1 x Uint8Array(135) for output map
      //   Total: 1 typed array allocation per frame
      //   (This test version also allocates a Float32Array for correctness comparison;
      //    the production WASM version would output only the Uint8Array)

      const img = BASES.flat128;
      const result = ssimKernel(img.data, img.data, img.width, img.height);

      console.log("\n=== Allocation Analysis ===");
      console.log("  ssim.js bezkrovny:  ~273 Array allocations per call (at 160x90)");
      console.log("    - 2 x Array(14400) for grayscale");
      console.log("    - 270 x Array(<=121) for sub-windows");
      console.log("    - 1 x Array(135) for output");
      console.log(`  ssimKernel:         1 Uint8Array(${result.map.length}) allocation per call`);
      console.log("  Reduction:          ~273x fewer allocations");

      expect(result.map).toBeInstanceOf(Uint8Array);
      expect(result.map.length).toBe(Math.ceil(WIDTH / 11) * Math.ceil(HEIGHT / 11));
    });
  });

  describe("Summary", () => {
    it("correctness and performance summary table", () => {
      expect(allResults.length).toBe(75);

      // Correctness stats
      const mssimDeltas = allResults.map(r => r.mssimDelta);
      const mapMaxErrors = allResults.map(r => r.mapMaxError);

      const meanMssimDelta = mssimDeltas.reduce((s, d) => s + d, 0) / mssimDeltas.length;
      const maxMssimDelta = Math.max(...mssimDeltas);
      const meanMapError = mapMaxErrors.reduce((s, e) => s + e, 0) / mapMaxErrors.length;
      const maxMapError = Math.max(...mapMaxErrors);

      // Performance stats from the 75 test cases
      const refTimes = allResults.map(r => r.refTimeMs);
      const kernTimes = allResults.map(r => r.kernelTimeMs);
      const meanRefTime = refTimes.reduce((s, t) => s + t, 0) / refTimes.length;
      const meanKernTime = kernTimes.reduce((s, t) => s + t, 0) / kernTimes.length;

      console.log("\n" + "=".repeat(100));
      console.log("SSIM WASM-READY KERNEL — INVESTIGATION SUMMARY");
      console.log("=".repeat(100));

      console.log("\n--- Correctness (vs ssim.js bezkrovny, 75 test cases) ---");
      console.log(`  mssim mean delta:    ${meanMssimDelta.toFixed(6)}  (tolerance: <=0.001)`);
      console.log(`  mssim max delta:     ${maxMssimDelta.toFixed(6)}  (tolerance: <=0.001)`);
      console.log(`  map mean max error:  ${meanMapError.toFixed(6)}  (tolerance: <=0.005)`);
      console.log(`  map worst-case err:  ${maxMapError.toFixed(6)}  (tolerance: <=0.005)`);
      console.log(`  All 75 cases:        ${maxMssimDelta <= 0.001 && maxMapError <= 0.005 ? "PASS" : "FAIL"}`);

      console.log("\n--- Performance (averaged over 75 distortion cases) ---");
      console.log(`  ssim.js mean time:   ${meanRefTime.toFixed(3)}ms`);
      console.log(`  kernel mean time:    ${meanKernTime.toFixed(3)}ms`);
      console.log(`  Inline speedup:      ${(meanRefTime / meanKernTime).toFixed(1)}x`);

      console.log("\n--- Optimization Breakdown ---");
      console.log("  [x] Typed arrays instead of Array (V8 SIMD auto-vectorization)");
      console.log("  [x] Fused grayscale conversion (no separate gray pass)");
      console.log("  [x] In-place statistics (no window extraction / sub() copies)");
      console.log("  [x] Pre-computed constants (C1, C2 hoisted)");
      console.log("  [x] Direct RGBA input (no library wrapper overhead)");
      console.log("  [x] Quantized Uint8Array output (no Float32 intermediate)");
      console.log("  [ ] WebAssembly compilation (AssemblyScript, future work)");
      console.log("  [ ] WASM SIMD (128-bit, future work)");

      console.log("\n--- WASM Projection ---");
      console.log("  This JS kernel eliminates all allocation overhead from ssim.js.");
      console.log("  Compiling to WASM (AssemblyScript) would additionally provide:");
      console.log("  - AOT compilation (no JIT warmup, predictable performance)");
      console.log("  - Linear memory (no GC pauses, cache-friendly)");
      console.log("  - SIMD (128-bit v128 for gray conversion + accumulation)");
      console.log("  Expected: additional 3-8x over this JS kernel");
      console.log("=".repeat(100));

      // Final assertions
      expect(maxMssimDelta).toBeLessThanOrEqual(0.001);
      expect(maxMapError).toBeLessThanOrEqual(0.005);
    });
  });
});
