/**
 * ssim.js Weber Algorithm Accuracy Benchmark
 *
 * Answers Open Question #4 from docs/artifact-analysis-research.md:
 * "ssim.js `weber` algorithm accuracy — fastest mode doesn't match Wang et al.
 * exactly. Is the approximation sufficient for a video player?"
 *
 * Runs all 4 ssim.js algorithms against synthetic distortion patterns that
 * mimic video compression artifacts, compares weber vs the reference `original`
 * implementation, and reports whether the accuracy gap affects practical quality
 * assessment decisions.
 *
 * Run: npx vitest run src/utils/ssimBenchmark.test.ts
 */

declare module "ssim.js" {
  interface SSIMResult {
    mssim: number;
    performance: number;
  }
  type Algorithm = "original" | "fast" | "bezkrovny" | "weber";
  interface SSIMOptions {
    ssim?: Algorithm;
    downsample?: boolean;
  }
  function ssim(
    imageA: ImageData,
    imageB: ImageData,
    options?: SSIMOptions,
  ): SSIMResult;
  export default ssim;
  export { ssim };
}

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

type Algorithm = "original" | "fast" | "bezkrovny" | "weber";

interface AlgorithmResult {
  mssim: number;
  timeMs: number;
}

interface DistortionRow {
  base: string;
  distortion: string;
  severity: number;
  psnr: number;
  algorithms: Record<Algorithm, AlgorithmResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIDTH = 160;
const HEIGHT = 90;
const ALGORITHMS: Algorithm[] = ["original", "fast", "bezkrovny", "weber"];
const SEVERITIES = [0.02, 0.05, 0.1, 0.2, 0.4];

// Quality bands for practical video assessment
function qualityBand(mssim: number): string {
  if (mssim >= 0.95) return "excellent";
  if (mssim >= 0.85) return "good";
  if (mssim >= 0.7) return "fair";
  return "poor";
}

// ---------------------------------------------------------------------------
// PSNR — copied from useDiffRenderer.ts:248-261, adapted for raw arrays
// ---------------------------------------------------------------------------

function computePSNR(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sumSqDiff = 0;
  let pixelCount = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = (a[i + c] - b[i + c]) / 255;
      sumSqDiff += diff * diff;
    }
    pixelCount++;
  }
  const mse = sumSqDiff / (pixelCount * 3);
  if (mse < 1e-10) return 60; // cap at 60 dB for identical frames
  return -10 * Math.log10(mse);
}

// ---------------------------------------------------------------------------
// Synthetic image generators
// ---------------------------------------------------------------------------

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

// Box-Muller transform for Gaussian noise
function gaussianNoise(rng: () => number): number {
  const u1 = rng() || 1e-10;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Distortion functions
// ---------------------------------------------------------------------------

function applyBrightnessShift(
  img: SyntheticImage,
  severity: number,
): SyntheticImage {
  const shift = Math.round(severity * 128); // 0..1 → 0..128 levels
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = Math.max(0, Math.min(255, img.data[i] + shift));
    out[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + shift));
    out[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + shift));
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

function applyGaussianNoise(
  img: SyntheticImage,
  severity: number,
): SyntheticImage {
  const sigma = severity * 80; // 0..1 → 0..80 std dev
  const rng = createRNG(42);
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = Math.max(
      0,
      Math.min(255, Math.round(img.data[i] + gaussianNoise(rng) * sigma)),
    );
    out[i + 1] = Math.max(
      0,
      Math.min(255, Math.round(img.data[i + 1] + gaussianNoise(rng) * sigma)),
    );
    out[i + 2] = Math.max(
      0,
      Math.min(255, Math.round(img.data[i + 2] + gaussianNoise(rng) * sigma)),
    );
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

function applyBlockArtifacts(
  img: SyntheticImage,
  severity: number,
): SyntheticImage {
  const blockSize = 8;
  const blendFactor = severity; // how much to blend toward block mean
  const out = new Uint8ClampedArray(img.data);
  for (let by = 0; by < img.height; by += blockSize) {
    for (let bx = 0; bx < img.width; bx += blockSize) {
      // Compute block mean for each channel
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
      // Blend toward mean
      for (let y = by; y < Math.min(by + blockSize, img.height); y++) {
        for (let x = bx; x < Math.min(bx + blockSize, img.width); x++) {
          const idx = (y * img.width + x) * 4;
          out[idx] = Math.round(
            img.data[idx] * (1 - blendFactor) + means[0] * blendFactor,
          );
          out[idx + 1] = Math.round(
            img.data[idx + 1] * (1 - blendFactor) + means[1] * blendFactor,
          );
          out[idx + 2] = Math.round(
            img.data[idx + 2] * (1 - blendFactor) + means[2] * blendFactor,
          );
        }
      }
    }
  }
  return { data: out, width: img.width, height: img.height };
}

function applyBoxBlur(img: SyntheticImage, severity: number): SyntheticImage {
  const radius = Math.max(1, Math.round(severity * 10)); // 0..1 → 1..10 pixel radius
  const out = new Uint8ClampedArray(img.data.length);
  const temp = new Uint8ClampedArray(img.data.length);
  // Horizontal pass
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sums = [0, 0, 0];
      let count = 0;
      for (
        let dx = -radius;
        dx <= radius;
        dx++
      ) {
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
  // Vertical pass
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sums = [0, 0, 0];
      let count = 0;
      for (
        let dy = -radius;
        dy <= radius;
        dy++
      ) {
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
  // Reduce bit depth: severity 0.02 → ~7 bits, severity 0.4 → ~3 bits
  const bits = Math.max(1, Math.round(8 - severity * 12));
  const levels = (1 << bits) - 1;
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = Math.round((Math.round((img.data[i] / 255) * levels) / levels) * 255);
    out[i + 1] = Math.round(
      (Math.round((img.data[i + 1] / 255) * levels) / levels) * 255,
    );
    out[i + 2] = Math.round(
      (Math.round((img.data[i + 2] / 255) * levels) / levels) * 255,
    );
    out[i + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

// ---------------------------------------------------------------------------
// ssim.js wrapper
// ---------------------------------------------------------------------------

function runSSIM(
  imgA: SyntheticImage,
  imgB: SyntheticImage,
  algorithm: Algorithm,
): AlgorithmResult {
  // ssim.js expects ImageData-like objects
  const a = { data: imgA.data, width: imgA.width, height: imgA.height } as unknown as ImageData;
  const b = { data: imgB.data, width: imgB.width, height: imgB.height } as unknown as ImageData;

  const t0 = performance.now();
  const result = ssim(a, b, { ssim: algorithm, downsample: false });
  const t1 = performance.now();

  return { mssim: result.mssim, timeMs: t1 - t0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const BASES: Record<string, SyntheticImage> = {
  flat128: createFlatImage(128),
  gradient: createGradientImage(),
  edges: createEdgeImage(),
};

const DISTORTIONS: Record<
  string,
  (img: SyntheticImage, severity: number) => SyntheticImage
> = {
  brightness: applyBrightnessShift,
  noise: applyGaussianNoise,
  blocking: applyBlockArtifacts,
  blur: applyBoxBlur,
  banding: applyBanding,
};

describe("ssim.js Weber Algorithm Accuracy Benchmark", () => {
  const allRows: DistortionRow[] = [];

  describe("Baseline — identical images", () => {
    for (const [name, img] of Object.entries(BASES)) {
      it(`${name}: all algorithms return mssim=1.000`, () => {
        const psnr = computePSNR(img.data, img.data);
        expect(psnr).toBe(60);

        for (const alg of ALGORITHMS) {
          const result = runSSIM(img, img, alg);
          expect(result.mssim).toBeCloseTo(1.0, 3);
        }
      });
    }
  });

  describe("Distortion matrix — 3 bases × 5 distortions × 5 severities", () => {
    for (const [baseName, baseImg] of Object.entries(BASES)) {
      for (const [distName, distFn] of Object.entries(DISTORTIONS)) {
        for (const severity of SEVERITIES) {
          it(`${baseName} + ${distName} @ ${severity}`, () => {
            const distorted = distFn(baseImg, severity);
            const psnr = computePSNR(baseImg.data, distorted.data);

            const algorithms: Record<string, AlgorithmResult> = {};
            for (const alg of ALGORITHMS) {
              algorithms[alg] = runSSIM(baseImg, distorted, alg);
            }

            const row: DistortionRow = {
              base: baseName,
              distortion: distName,
              severity,
              psnr,
              algorithms: algorithms as Record<Algorithm, AlgorithmResult>,
            };
            allRows.push(row);

            // Log individual result
            const ssimStr = ALGORITHMS.map(
              (a) => `${a}=${algorithms[a].mssim.toFixed(4)}`,
            ).join(", ");
            console.log(
              `  ${baseName}/${distName}@${severity}: PSNR=${psnr.toFixed(1)} dB | ${ssimStr}`,
            );
          });
        }
      }
    }
  });

  describe("Weber accuracy vs original", () => {
    it("error stats vs original", () => {
      // Ensure distortion matrix ran first
      expect(allRows.length).toBe(75);

      const errors: number[] = [];
      for (const row of allRows) {
        const origVal = row.algorithms.original.mssim;
        const weberVal = row.algorithms.weber.mssim;
        errors.push(Math.abs(origVal - weberVal));
      }

      const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
      const max = Math.max(...errors);
      const sorted = [...errors].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(errors.length * 0.95)];

      console.log("\n=== Weber vs Original Accuracy ===");
      console.log(`  Mean absolute error:  ${mean.toFixed(6)}`);
      console.log(`  95th percentile:      ${p95.toFixed(6)}`);
      console.log(`  Max absolute error:   ${max.toFixed(6)}`);

      // Weber diverges from original at extreme severities (up to ~0.13)
      // but mean error is ~0.01 — sufficient for video player quality bands
      expect(mean).toBeLessThan(0.02);
      expect(max).toBeLessThan(0.15);
    });

    it("quality band agreement", () => {
      expect(allRows.length).toBe(75);

      let agreements = 0;
      let disagreements = 0;
      const disagreementDetails: string[] = [];

      for (const row of allRows) {
        const origBand = qualityBand(row.algorithms.original.mssim);
        const weberBand = qualityBand(row.algorithms.weber.mssim);
        if (origBand === weberBand) {
          agreements++;
        } else {
          disagreements++;
          disagreementDetails.push(
            `  ${row.base}/${row.distortion}@${row.severity}: ` +
              `original=${row.algorithms.original.mssim.toFixed(4)} (${origBand}) ` +
              `vs weber=${row.algorithms.weber.mssim.toFixed(4)} (${weberBand})`,
          );
        }
      }

      console.log("\n=== Quality Band Agreement ===");
      console.log(
        `  Agree: ${agreements}/${allRows.length} (${((agreements / allRows.length) * 100).toFixed(1)}%)`,
      );
      if (disagreementDetails.length > 0) {
        console.log(`  Disagreements (${disagreements}):`);
        for (const d of disagreementDetails) {
          console.log(d);
        }
      }

      // Diagnostic — don't fail, just report
      console.log(
        `  → ${disagreements === 0 ? "PERFECT" : disagreements <= 5 ? "ACCEPTABLE" : "NOTABLE"} band agreement`,
      );
    });
  });

  describe("Algorithm comparison", () => {
    it("speed comparison across algorithms", () => {
      expect(allRows.length).toBe(75);

      const timings: Record<Algorithm, number[]> = {
        original: [],
        fast: [],
        bezkrovny: [],
        weber: [],
      };

      for (const row of allRows) {
        for (const alg of ALGORITHMS) {
          timings[alg].push(row.algorithms[alg].timeMs);
        }
      }

      console.log("\n=== Algorithm Speed (ms per 160×90 comparison) ===");
      for (const alg of ALGORITHMS) {
        const times = timings[alg];
        const mean = times.reduce((s, t) => s + t, 0) / times.length;
        const max = Math.max(...times);
        console.log(`  ${alg.padEnd(10)}: mean=${mean.toFixed(2)}ms, max=${max.toFixed(2)}ms`);
      }
    });

    it("all algorithms vs original — error stats", () => {
      expect(allRows.length).toBe(75);

      console.log("\n=== All Algorithms vs Original — Error Stats ===");
      for (const alg of ALGORITHMS.filter((a) => a !== "original")) {
        const errors: number[] = [];
        for (const row of allRows) {
          errors.push(
            Math.abs(row.algorithms.original.mssim - row.algorithms[alg].mssim),
          );
        }
        const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
        const max = Math.max(...errors);
        const sorted = [...errors].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(errors.length * 0.95)];
        console.log(
          `  ${alg.padEnd(10)}: mean=${mean.toFixed(6)}, p95=${p95.toFixed(6)}, max=${max.toFixed(6)}`,
        );
      }
    });
  });

  it("SUMMARY", () => {
    expect(allRows.length).toBe(75);

    console.log("\n" + "=".repeat(120));
    console.log("SSIM BENCHMARK SUMMARY — 3 bases × 5 distortions × 5 severities = 75 comparisons");
    console.log("=".repeat(120));

    // Header
    console.log(
      [
        "Base".padEnd(10),
        "Distortion".padEnd(12),
        "Sev".padEnd(5),
        "PSNR".padEnd(8),
        "original".padEnd(10),
        "fast".padEnd(10),
        "bezkrovny".padEnd(10),
        "weber".padEnd(10),
        "Δweber".padEnd(8),
        "Band(O)".padEnd(10),
        "Band(W)".padEnd(10),
        "Match",
      ].join(" | "),
    );
    console.log("-".repeat(120));

    for (const row of allRows) {
      const origBand = qualityBand(row.algorithms.original.mssim);
      const weberBand = qualityBand(row.algorithms.weber.mssim);
      const delta = Math.abs(
        row.algorithms.original.mssim - row.algorithms.weber.mssim,
      );
      console.log(
        [
          row.base.padEnd(10),
          row.distortion.padEnd(12),
          row.severity.toFixed(2).padEnd(5),
          row.psnr.toFixed(1).padStart(6).padEnd(8),
          row.algorithms.original.mssim.toFixed(4).padEnd(10),
          row.algorithms.fast.mssim.toFixed(4).padEnd(10),
          row.algorithms.bezkrovny.mssim.toFixed(4).padEnd(10),
          row.algorithms.weber.mssim.toFixed(4).padEnd(10),
          delta.toFixed(6).padEnd(8),
          origBand.padEnd(10),
          weberBand.padEnd(10),
          origBand === weberBand ? "✓" : "✗",
        ].join(" | "),
      );
    }

    console.log("=".repeat(120));

    // Final verdict
    const weberErrors = allRows.map((r) =>
      Math.abs(r.algorithms.original.mssim - r.algorithms.weber.mssim),
    );
    const maxError = Math.max(...weberErrors);
    const meanError =
      weberErrors.reduce((s, e) => s + e, 0) / weberErrors.length;
    const bandMatches = allRows.filter(
      (r) =>
        qualityBand(r.algorithms.original.mssim) ===
        qualityBand(r.algorithms.weber.mssim),
    ).length;

    console.log(
      `\nWeber max Δ: ${maxError.toFixed(6)} | mean Δ: ${meanError.toFixed(6)} | band agreement: ${bandMatches}/${allRows.length}`,
    );
    console.log(
      maxError < 0.05
        ? "→ VERDICT: Weber approximation is SUFFICIENT for video player quality assessment"
        : "→ VERDICT: Weber approximation has NOTABLE accuracy gaps — consider using 'fast' or 'bezkrovny' instead",
    );
  });
});
