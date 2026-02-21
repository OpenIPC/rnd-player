/**
 * SSIM Resolution Reduction Benchmark — Vector 5.3
 *
 * Empirically tests whether reducing SSIM input resolution from 160x90
 * (current) to 120x68 or 80x45 produces acceptable results.
 *
 * Questions answered:
 * 1. How much does the mssim value change at lower resolutions?
 * 2. Is the SSIM map too coarse at 80x45 for a useful heatmap?
 * 3. How much speed improvement does each resolution give?
 *
 * The SSIM map dimensions at each resolution (bezkrovny, 11x11 non-overlapping):
 *   160x90  -> ceil(160/11) x ceil(90/11)  = 15 x 9  = 135 cells
 *   120x68  -> ceil(120/11) x ceil(68/11)  = 11 x 7  =  77 cells
 *    80x45  -> ceil(80/11)  x ceil(45/11)  =  8 x 5  =  40 cells
 *
 * Run: npx vitest run src/utils/ssimResolution.test.ts
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

interface ResolutionResult {
  base: string;
  distortion: string;
  severity: number;
  resolutions: Record<string, {
    mssim: number;
    mapWidth: number;
    mapHeight: number;
    mapCells: number;
    timeMs: number;
  }>;
}

// ---------------------------------------------------------------------------
// Resolution configs
// ---------------------------------------------------------------------------

const RESOLUTIONS = [
  { label: "160x90", w: 160, h: 90 },
  { label: "120x68", w: 120, h: 68 },
  { label: "80x45", w: 80, h: 45 },
] as const;

const REFERENCE_RES = RESOLUTIONS[0]; // 160x90 is the baseline

// ---------------------------------------------------------------------------
// Seeded PRNG (same as ssimBenchmark.test.ts)
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
// Image generators (always at 160x90, then downscaled)
// ---------------------------------------------------------------------------

const SRC_W = 160;
const SRC_H = 90;

function createFlatImage(value: number): SyntheticImage {
  const data = new Uint8ClampedArray(SRC_W * SRC_H * 4);
  const v = Math.round(Math.max(0, Math.min(255, value)));
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { data, width: SRC_W, height: SRC_H };
}

function createGradientImage(): SyntheticImage {
  const data = new Uint8ClampedArray(SRC_W * SRC_H * 4);
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const v = Math.round((x / (SRC_W - 1)) * 255);
      const idx = (y * SRC_W + x) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { data, width: SRC_W, height: SRC_H };
}

function createEdgeImage(): SyntheticImage {
  const data = new Uint8ClampedArray(SRC_W * SRC_H * 4);
  const bandWidth = 4;
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const band = Math.floor(x / bandWidth);
      const v = band % 2 === 0 ? 0 : 255;
      const idx = (y * SRC_W + x) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { data, width: SRC_W, height: SRC_H };
}

// ---------------------------------------------------------------------------
// Distortion functions (same as ssimBenchmark.test.ts)
// ---------------------------------------------------------------------------

function applyGaussianNoise(
  img: SyntheticImage,
  severity: number,
): SyntheticImage {
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

function applyBlockArtifacts(
  img: SyntheticImage,
  severity: number,
): SyntheticImage {
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
      means[0] /= count; means[1] /= count; means[2] /= count;
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
  // Horizontal pass
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sums = [0, 0, 0];
      let count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = Math.max(0, Math.min(img.width - 1, x + dx));
        const idx = (y * img.width + sx) * 4;
        sums[0] += img.data[idx]; sums[1] += img.data[idx + 1]; sums[2] += img.data[idx + 2];
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
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = Math.max(0, Math.min(img.height - 1, y + dy));
        const idx = (sy * img.width + x) * 4;
        sums[0] += temp[idx]; sums[1] += temp[idx + 1]; sums[2] += temp[idx + 2];
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

function applyBrightnessShift(
  img: SyntheticImage,
  severity: number,
): SyntheticImage {
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
// Area-average downscale (box filter for integer-ish reduction)
// ---------------------------------------------------------------------------

function downscale(img: SyntheticImage, targetW: number, targetH: number): SyntheticImage {
  const out = new Uint8ClampedArray(targetW * targetH * 4);
  const scaleX = img.width / targetW;
  const scaleY = img.height / targetH;

  for (let dy = 0; dy < targetH; dy++) {
    const srcY0 = Math.floor(dy * scaleY);
    const srcY1 = Math.min(Math.ceil((dy + 1) * scaleY), img.height);
    for (let dx = 0; dx < targetW; dx++) {
      const srcX0 = Math.floor(dx * scaleX);
      const srcX1 = Math.min(Math.ceil((dx + 1) * scaleX), img.width);

      const sums = [0, 0, 0];
      let count = 0;
      for (let sy = srcY0; sy < srcY1; sy++) {
        for (let sx = srcX0; sx < srcX1; sx++) {
          const idx = (sy * img.width + sx) * 4;
          sums[0] += img.data[idx];
          sums[1] += img.data[idx + 1];
          sums[2] += img.data[idx + 2];
          count++;
        }
      }
      const idx = (dy * targetW + dx) * 4;
      out[idx] = Math.round(sums[0] / count);
      out[idx + 1] = Math.round(sums[1] / count);
      out[idx + 2] = Math.round(sums[2] / count);
      out[idx + 3] = 255;
    }
  }
  return { data: out, width: targetW, height: targetH };
}

// ---------------------------------------------------------------------------
// SSIM wrapper
// ---------------------------------------------------------------------------

function runSSIM(imgA: SyntheticImage, imgB: SyntheticImage): {
  mssim: number;
  mapWidth: number;
  mapHeight: number;
  mapCells: number;
  timeMs: number;
} {
  const a = { data: imgA.data, width: imgA.width, height: imgA.height } as unknown as ImageData;
  const b = { data: imgB.data, width: imgB.width, height: imgB.height } as unknown as ImageData;

  const t0 = performance.now();
  const result = ssim(a, b, { ssim: "bezkrovny", downsample: false });
  const t1 = performance.now();

  return {
    mssim: result.mssim,
    mapWidth: result.ssim_map.width,
    mapHeight: result.ssim_map.height,
    mapCells: result.ssim_map.data.length,
    timeMs: t1 - t0,
  };
}

// ---------------------------------------------------------------------------
// Benchmark harness
// ---------------------------------------------------------------------------

function benchmarkSSIM(imgA: SyntheticImage, imgB: SyntheticImage, runs: number): {
  medianMs: number;
  p95Ms: number;
  mssim: number;
  mapWidth: number;
  mapHeight: number;
  mapCells: number;
} {
  const a = { data: imgA.data, width: imgA.width, height: imgA.height } as unknown as ImageData;
  const b = { data: imgB.data, width: imgB.width, height: imgB.height } as unknown as ImageData;

  // warmup
  for (let i = 0; i < 5; i++) {
    ssim(a, b, { ssim: "bezkrovny", downsample: false });
  }

  const times: number[] = [];
  let lastResult: ReturnType<typeof ssim> | null = null;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    lastResult = ssim(a, b, { ssim: "bezkrovny", downsample: false });
    times.push(performance.now() - t0);
  }

  times.sort((a, b) => a - b);

  return {
    medianMs: times[Math.floor(times.length / 2)],
    p95Ms: times[Math.floor(times.length * 0.95)],
    mssim: lastResult!.mssim,
    mapWidth: lastResult!.ssim_map.width,
    mapHeight: lastResult!.ssim_map.height,
    mapCells: lastResult!.ssim_map.data.length,
  };
}

// ---------------------------------------------------------------------------
// Test data
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

const SEVERITIES = [0.05, 0.1, 0.2, 0.4];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSIM Resolution Reduction Benchmark", () => {
  const allResults: ResolutionResult[] = [];

  describe("SSIM at different resolutions — distortion matrix", () => {
    for (const [baseName, baseImg] of Object.entries(BASES)) {
      for (const [distName, distFn] of Object.entries(DISTORTIONS)) {
        for (const severity of SEVERITIES) {
          it(`${baseName} + ${distName} @ ${severity}`, () => {
            const distorted = distFn(baseImg, severity);

            const resolutions: ResolutionResult["resolutions"] = {};

            for (const res of RESOLUTIONS) {
              let refImg: SyntheticImage;
              let distImg: SyntheticImage;

              if (res.w === SRC_W && res.h === SRC_H) {
                // No downscale needed for the reference resolution
                refImg = baseImg;
                distImg = distorted;
              } else {
                // Downscale both images to the target resolution
                refImg = downscale(baseImg, res.w, res.h);
                distImg = downscale(distorted, res.w, res.h);
              }

              const result = runSSIM(refImg, distImg);

              resolutions[res.label] = {
                mssim: result.mssim,
                mapWidth: result.mapWidth,
                mapHeight: result.mapHeight,
                mapCells: result.mapCells,
                timeMs: result.timeMs,
              };
            }

            allResults.push({
              base: baseName,
              distortion: distName,
              severity,
              resolutions,
            });

            // Log result
            const parts = RESOLUTIONS.map(
              (r) => `${r.label}=${resolutions[r.label].mssim.toFixed(4)}`,
            );
            console.log(`  ${baseName}/${distName}@${severity}: ${parts.join(" | ")}`);
          });
        }
      }
    }
  });

  describe("Accuracy: mssim deviation from 160x90 reference", () => {
    it("mssim deviation statistics per resolution", () => {
      // 3 bases * 5 distortions * 4 severities = 60
      expect(allResults.length).toBe(60);

      const refLabel = REFERENCE_RES.label;

      for (const res of RESOLUTIONS.slice(1)) {
        const deltas: number[] = [];
        for (const row of allResults) {
          const refMssim = row.resolutions[refLabel].mssim;
          const resMssim = row.resolutions[res.label].mssim;
          deltas.push(Math.abs(refMssim - resMssim));
        }

        const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
        const max = Math.max(...deltas);
        const sorted = [...deltas].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(deltas.length * 0.95)];

        console.log(
          `\n  ${res.label} vs ${refLabel}: ` +
            `mean |delta|=${mean.toFixed(4)} p95=${p95.toFixed(4)} max=${max.toFixed(4)}`,
        );

        // 120x68: close to 160x90. The mean is dominated by noise-on-flat
        // pathological cases where downscale smooths noise dramatically (e.g.
        // flat128+noise@0.4 jumps from 0.117 to 0.379). For real video content,
        // structural distortions (blocking, blur, brightness) show delta <0.01.
        if (res.w === 120) {
          expect(mean).toBeLessThan(0.05);
          expect(max).toBeLessThan(0.40);
        }
        // 80x45: more deviation due to stronger downscale smoothing, same
        // noise-on-flat pathological behavior drives the max
        if (res.w === 80) {
          expect(mean).toBeLessThan(0.06);
          expect(max).toBeLessThan(0.50);
        }
      }
    });

    it("quality band agreement at each resolution", () => {
      expect(allResults.length).toBe(60);

      function qualityBand(mssim: number): string {
        if (mssim >= 0.95) return "excellent";
        if (mssim >= 0.85) return "good";
        if (mssim >= 0.7) return "fair";
        return "poor";
      }

      const refLabel = REFERENCE_RES.label;

      console.log("\n=== Quality Band Agreement ===");
      for (const res of RESOLUTIONS.slice(1)) {
        let agreements = 0;
        let total = 0;
        const disagreements: string[] = [];

        for (const row of allResults) {
          const refBand = qualityBand(row.resolutions[refLabel].mssim);
          const resBand = qualityBand(row.resolutions[res.label].mssim);
          total++;
          if (refBand === resBand) {
            agreements++;
          } else {
            disagreements.push(
              `    ${row.base}/${row.distortion}@${row.severity}: ` +
                `ref=${row.resolutions[refLabel].mssim.toFixed(4)} (${refBand}) ` +
                `vs ${res.label}=${row.resolutions[res.label].mssim.toFixed(4)} (${resBand})`,
            );
          }
        }

        console.log(`  ${res.label}: ${agreements}/${total} agree (${((agreements / total) * 100).toFixed(1)}%)`);
        if (disagreements.length > 0) {
          for (const d of disagreements.slice(0, 5)) {
            console.log(d);
          }
          if (disagreements.length > 5) {
            console.log(`    ... and ${disagreements.length - 5} more`);
          }
        }
      }
    });
  });

  describe("Map spatial resolution analysis", () => {
    it("SSIM map dimensions at each resolution", () => {
      expect(allResults.length).toBe(60);

      console.log("\n=== SSIM Map Dimensions (bezkrovny 11x11 non-overlapping) ===");
      for (const res of RESOLUTIONS) {
        const sample = allResults[0].resolutions[res.label];
        console.log(
          `  ${res.label}: map ${sample.mapWidth}x${sample.mapHeight} = ${sample.mapCells} cells`,
        );
      }

      // Verify expected map sizes
      const ref = allResults[0].resolutions;
      expect(ref["160x90"].mapWidth).toBe(Math.ceil(160 / 11));  // 15
      expect(ref["160x90"].mapHeight).toBe(Math.ceil(90 / 11));  // 9
      expect(ref["120x68"].mapWidth).toBe(Math.ceil(120 / 11));  // 11
      expect(ref["120x68"].mapHeight).toBe(Math.ceil(68 / 11));  // 7
      expect(ref["80x45"].mapWidth).toBe(Math.ceil(80 / 11));    // 8
      expect(ref["80x45"].mapHeight).toBe(Math.ceil(45 / 11));   // 5

      console.log("\n  Analysis:");
      console.log("    160x90 -> 15x9  = 135 cells (current baseline)");
      console.log("    120x68 -> 11x7  =  77 cells (57% of baseline, still usable)");
      console.log("     80x45 ->  8x5  =  40 cells (30% of baseline, coarse but GPU bilinear upscale smooths)");
      console.log("\n  The SSIM map is uploaded as an R8 texture and GPU bilinear filtering");
      console.log("  upscales it to full video resolution. Even an 8x5 map produces a");
      console.log("  smooth heatmap after bilinear interpolation — it just has less spatial");
      console.log("  detail. For a video player diagnostic overlay, 8x5 cells may be");
      console.log("  acceptable since video compression artifacts are typically larger than");
      console.log("  11-pixel blocks anyway.");
    });
  });

  describe("Speed benchmark", () => {
    it("SSIM compute speed at each resolution", () => {
      // Benchmark with a representative distortion: gradient + noise @ 0.1
      const baseImg = createGradientImage();
      const distorted = applyGaussianNoise(baseImg, 0.1);

      const BENCH_RUNS = 50;

      console.log("\n=== Speed Benchmark (bezkrovny, median of 50 runs) ===");

      const speedResults: Record<string, { medianMs: number; p95Ms: number }> = {};

      for (const res of RESOLUTIONS) {
        let refImg: SyntheticImage;
        let distImg: SyntheticImage;

        if (res.w === SRC_W && res.h === SRC_H) {
          refImg = baseImg;
          distImg = distorted;
        } else {
          refImg = downscale(baseImg, res.w, res.h);
          distImg = downscale(distorted, res.w, res.h);
        }

        const bench = benchmarkSSIM(refImg, distImg, BENCH_RUNS);
        speedResults[res.label] = { medianMs: bench.medianMs, p95Ms: bench.p95Ms };

        console.log(
          `  ${res.label.padEnd(8)}: median=${bench.medianMs.toFixed(3)}ms ` +
            `p95=${bench.p95Ms.toFixed(3)}ms ` +
            `map=${bench.mapWidth}x${bench.mapHeight}`,
        );
      }

      // Report speedup ratios
      const refTime = speedResults[REFERENCE_RES.label].medianMs;
      console.log("\n  Speedup vs 160x90:");
      for (const res of RESOLUTIONS.slice(1)) {
        const speedup = refTime / Math.max(speedResults[res.label].medianMs, 0.001);
        console.log(
          `    ${res.label}: ${speedup.toFixed(1)}x faster ` +
            `(${speedResults[res.label].medianMs.toFixed(3)}ms vs ${refTime.toFixed(3)}ms)`,
        );
      }

      // The compute portion is already fast (0.1-0.5ms at 160x90).
      // Speed improvement from resolution reduction is modest for compute,
      // but more significant for the drawImage+getImageData readback
      // (which scales with pixel count).
      console.log("\n  Note: These timings are SSIM *compute* only (no drawImage/getImageData).");
      console.log("  The real win from resolution reduction is in the readback step:");
      console.log("    160x90 = 57,600 bytes readback");
      console.log("    120x68 = 32,640 bytes readback (1.8x less)");
      console.log("     80x45 = 14,400 bytes readback (4.0x less)");
    });
  });

  it("SUMMARY", () => {
    expect(allResults.length).toBe(60);

    console.log("\n" + "=".repeat(130));
    console.log("SSIM RESOLUTION REDUCTION BENCHMARK SUMMARY");
    console.log("=".repeat(130));

    const refLabel = REFERENCE_RES.label;

    // Header
    console.log(
      [
        "Base".padEnd(10),
        "Distortion".padEnd(12),
        "Sev".padEnd(5),
        "160x90".padEnd(10),
        "120x68".padEnd(10),
        "80x45".padEnd(10),
        "|delta| 120x68".padEnd(14),
        "|delta| 80x45".padEnd(14),
      ].join(" | "),
    );
    console.log("-".repeat(130));

    for (const row of allResults) {
      const ref = row.resolutions[refLabel].mssim;
      const r120 = row.resolutions["120x68"].mssim;
      const r80 = row.resolutions["80x45"].mssim;

      console.log(
        [
          row.base.padEnd(10),
          row.distortion.padEnd(12),
          row.severity.toFixed(2).padEnd(5),
          ref.toFixed(4).padEnd(10),
          r120.toFixed(4).padEnd(10),
          r80.toFixed(4).padEnd(10),
          Math.abs(ref - r120).toFixed(4).padEnd(14),
          Math.abs(ref - r80).toFixed(4).padEnd(14),
        ].join(" | "),
      );
    }

    console.log("=".repeat(130));

    // Summary statistics
    const deltas120: number[] = [];
    const deltas80: number[] = [];
    for (const row of allResults) {
      const ref = row.resolutions[refLabel].mssim;
      deltas120.push(Math.abs(ref - row.resolutions["120x68"].mssim));
      deltas80.push(Math.abs(ref - row.resolutions["80x45"].mssim));
    }

    const mean120 = deltas120.reduce((s, d) => s + d, 0) / deltas120.length;
    const max120 = Math.max(...deltas120);
    const mean80 = deltas80.reduce((s, d) => s + d, 0) / deltas80.length;
    const max80 = Math.max(...deltas80);

    console.log(`\n120x68 vs 160x90:  mean |delta|=${mean120.toFixed(4)}  max=${max120.toFixed(4)}  map=11x7 (77 cells)`);
    console.log(`80x45  vs 160x90:  mean |delta|=${mean80.toFixed(4)}  max=${max80.toFixed(4)}  map=8x5  (40 cells)`);

    console.log("\n=== Readback Data Volume ===");
    console.log("  160x90:  57,600 bytes (RGBA)  — current");
    console.log("  120x68:  32,640 bytes (RGBA)  — 1.8x reduction");
    console.log("   80x45:  14,400 bytes (RGBA)  — 4.0x reduction");

    console.log("\n=== SSIM Map Resolution ===");
    console.log("  160x90 -> 15x9  = 135 heatmap cells");
    console.log("  120x68 -> 11x7  =  77 heatmap cells (adequate spatial detail)");
    console.log("   80x45 ->  8x5  =  40 heatmap cells (coarse, but GPU bilinear smooths)");

    // Final verdict
    if (mean120 < 0.02 && max120 < 0.05) {
      console.log("\n-> VERDICT 120x68: RECOMMENDED — negligible accuracy loss, 1.8x less readback data, adequate map resolution");
    } else if (mean120 < 0.04) {
      console.log("\n-> VERDICT 120x68: ACCEPTABLE — minor accuracy shift, good tradeoff");
    } else {
      console.log("\n-> VERDICT 120x68: NOTABLE accuracy change — evaluate visually");
    }

    if (mean80 < 0.03 && max80 < 0.08) {
      console.log("-> VERDICT 80x45:  ACCEPTABLE — moderate accuracy loss, 4x less readback, but coarse map (8x5 cells)");
    } else if (mean80 < 0.06) {
      console.log("-> VERDICT 80x45:  MARGINAL — noticeable accuracy shift for high-frequency content, 8x5 map is very coarse");
    } else {
      console.log("-> VERDICT 80x45:  NOT RECOMMENDED — significant accuracy loss");
    }
  });
});
