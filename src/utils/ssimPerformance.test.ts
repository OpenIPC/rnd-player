/**
 * SSIM Performance Investigation — Phase 1 (Baseline) & Phase 2 (Pure JS Optimizations)
 *
 * Establishes correctness baseline using ssim.js bezkrovny as oracle, then benchmarks
 * 5 optimized pure-JS SSIM variants against it.
 *
 * Run: npx vitest run src/utils/ssimPerformance.test.ts
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

interface SsimMapResult {
  meanSsim: number;
  mapData: number[];
  mapWidth: number;
  mapHeight: number;
}


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIDTH = 160;
const HEIGHT = 90;
const WINDOW_SIZE = 11;
const SEVERITIES = [0.02, 0.05, 0.1, 0.2, 0.4];

// SSIM constants: k1=0.01, k2=0.03, bitDepth=8, L=255
const L = 255;
const C1 = (0.01 * L) * (0.01 * L); // 6.5025
const C2 = (0.03 * L) * (0.03 * L); // 58.5225

// ---------------------------------------------------------------------------
// Seeded PRNG (LCG) for reproducible noise — matches ssimBenchmark.test.ts
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
// Synthetic image generators — identical to ssimBenchmark.test.ts
// ---------------------------------------------------------------------------

function createFlatImage(
  value: number,
  w: number = WIDTH,
  h: number = HEIGHT,
): SyntheticImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const v = Math.round(Math.max(0, Math.min(255, value)));
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

function createGradientImage(
  w: number = WIDTH,
  h: number = HEIGHT,
): SyntheticImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      const idx = (y * w + x) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function createEdgeImage(
  w: number = WIDTH,
  h: number = HEIGHT,
): SyntheticImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const bandWidth = 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const band = Math.floor(x / bandWidth);
      const v = band % 2 === 0 ? 0 : 255;
      const idx = (y * w + x) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

// ---------------------------------------------------------------------------
// Distortion functions — identical to ssimBenchmark.test.ts
// ---------------------------------------------------------------------------

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

function applyGaussianNoise(
  img: SyntheticImage,
  severity: number,
): SyntheticImage {
  const sigma = severity * 80;
  const rng = createRNG(42);
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = Math.max(
      0,
      Math.min(255, Math.round(img.data[i] + gaussianNoise(rng) * sigma)),
    );
    out[i + 1] = Math.max(
      0,
      Math.min(
        255,
        Math.round(img.data[i + 1] + gaussianNoise(rng) * sigma),
      ),
    );
    out[i + 2] = Math.max(
      0,
      Math.min(
        255,
        Math.round(img.data[i + 2] + gaussianNoise(rng) * sigma),
      ),
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
    out[i] = Math.round(
      (Math.round((img.data[i] / 255) * levels) / levels) * 255,
    );
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
// ssim.js reference wrapper — returns both mssim and full map
// ---------------------------------------------------------------------------

function runSsimJsReference(
  imgA: SyntheticImage,
  imgB: SyntheticImage,
): SsimMapResult {
  const a = {
    data: imgA.data,
    width: imgA.width,
    height: imgA.height,
  } as unknown as ImageData;
  const b = {
    data: imgB.data,
    width: imgB.width,
    height: imgB.height,
  } as unknown as ImageData;
  const result = ssim(a, b, { ssim: "bezkrovny", downsample: false });
  return {
    meanSsim: result.mssim,
    mapData: result.ssim_map.data,
    mapWidth: result.ssim_map.width,
    mapHeight: result.ssim_map.height,
  };
}

// ---------------------------------------------------------------------------
// Grayscale conversion matching ssim.js rgb2grayInteger
// ---------------------------------------------------------------------------

function rgb2grayArray(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): number[] {
  const gray = new Array(width * height);
  for (let i = 0; i < rgba.length; i += 4) {
    gray[i >> 2] =
      (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2] + 128) >> 8;
  }
  return gray;
}

function rgb2grayFloat32(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < rgba.length; i += 4) {
    gray[i >> 2] =
      (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2] + 128) >> 8;
  }
  return gray;
}

// ===========================================================================
// Variant A: "typedArrays"
// Same algorithm as bezkrovny but using Float32Array for all buffers
// ===========================================================================

function ssimVariantA(
  imgA: SyntheticImage,
  imgB: SyntheticImage,
): SsimMapResult {
  const { width, height } = imgA;
  // Grayscale conversion to Float32Array
  const gray1 = rgb2grayFloat32(imgA.data, width, height);
  const gray2 = rgb2grayFloat32(imgB.data, width, height);

  const mapW = Math.ceil(width / WINDOW_SIZE);
  const mapH = Math.ceil(height / WINDOW_SIZE);
  const mapData = new Float32Array(mapW * mapH);

  let counter = 0;
  for (let by = 0; by < height; by += WINDOW_SIZE) {
    for (let bx = 0; bx < width; bx += WINDOW_SIZE) {
      const ww = Math.min(WINDOW_SIZE, width - bx);
      const wh = Math.min(WINDOW_SIZE, height - by);

      // Extract sub-windows into Float32Array (same as ssim.js sub())
      const n = ww * wh;
      const win1 = new Float32Array(n);
      const win2 = new Float32Array(n);
      for (let i = 0; i < wh; i++) {
        for (let j = 0; j < ww; j++) {
          const srcIdx = (by + i) * width + (bx + j);
          const dstIdx = i * ww + j;
          win1[dstIdx] = gray1[srcIdx];
          win2[dstIdx] = gray2[srcIdx];
        }
      }

      // Compute stats (same formulas as ssim.js math.js)
      let sum1 = 0,
        sum2 = 0;
      for (let k = 0; k < n; k++) {
        sum1 += win1[k];
        sum2 += win2[k];
      }
      const avg1 = sum1 / n;
      const avg2 = sum2 / n;

      let var1 = 0,
        var2 = 0,
        cov = 0;
      for (let k = 0; k < n; k++) {
        const d1 = win1[k] - avg1;
        const d2 = win2[k] - avg2;
        var1 += d1 * d1;
        var2 += d2 * d2;
        cov += d1 * d2;
      }
      var1 /= n;
      var2 /= n;
      cov /= n;

      const numerator = (2 * avg1 * avg2 + C1) * (2 * cov + C2);
      const denom =
        (avg1 * avg1 + avg2 * avg2 + C1) * (var1 + var2 + C2);
      mapData[counter++] = numerator / denom;
    }
  }

  let totalSsim = 0;
  for (let i = 0; i < mapData.length; i++) totalSsim += mapData[i];

  return {
    meanSsim: totalSsim / mapData.length,
    mapData: Array.from(mapData),
    mapWidth: mapW,
    mapHeight: mapH,
  };
}

// ===========================================================================
// Variant B: "inPlace"
// No sub-window extraction — stride directly over grayscale buffer
// ===========================================================================

function ssimVariantB(
  imgA: SyntheticImage,
  imgB: SyntheticImage,
): SsimMapResult {
  const { width, height } = imgA;
  const gray1 = rgb2grayArray(imgA.data, width, height);
  const gray2 = rgb2grayArray(imgB.data, width, height);

  const mapW = Math.ceil(width / WINDOW_SIZE);
  const mapH = Math.ceil(height / WINDOW_SIZE);
  const mapData: number[] = new Array(mapW * mapH);

  let counter = 0;
  for (let by = 0; by < height; by += WINDOW_SIZE) {
    for (let bx = 0; bx < width; bx += WINDOW_SIZE) {
      const ww = Math.min(WINDOW_SIZE, width - bx);
      const wh = Math.min(WINDOW_SIZE, height - by);
      const n = ww * wh;

      let sum1 = 0,
        sum2 = 0,
        sumSq1 = 0,
        sumSq2 = 0,
        sumCross = 0;

      for (let dy = 0; dy < wh; dy++) {
        const rowBase = (by + dy) * width + bx;
        for (let dx = 0; dx < ww; dx++) {
          const v1 = gray1[rowBase + dx];
          const v2 = gray2[rowBase + dx];
          sum1 += v1;
          sum2 += v2;
          sumSq1 += v1 * v1;
          sumSq2 += v2 * v2;
          sumCross += v1 * v2;
        }
      }

      const avg1 = sum1 / n;
      const avg2 = sum2 / n;
      const var1 = sumSq1 / n - avg1 * avg1;
      const var2 = sumSq2 / n - avg2 * avg2;
      const cov = sumCross / n - avg1 * avg2;

      const numerator = (2 * avg1 * avg2 + C1) * (2 * cov + C2);
      const denom =
        (avg1 * avg1 + avg2 * avg2 + C1) * (var1 + var2 + C2);
      mapData[counter++] = numerator / denom;
    }
  }

  let totalSsim = 0;
  for (let i = 0; i < mapData.length; i++) totalSsim += mapData[i];

  return {
    meanSsim: totalSsim / mapData.length,
    mapData,
    mapWidth: mapW,
    mapHeight: mapH,
  };
}

// ===========================================================================
// Variant C: "fusedGray"
// In-place stats + inline grayscale from RGBA. Zero intermediate buffers.
// ===========================================================================

function ssimVariantC(
  imgA: SyntheticImage,
  imgB: SyntheticImage,
): SsimMapResult {
  const { width, height } = imgA;
  const rgbaA = imgA.data;
  const rgbaB = imgB.data;

  const mapW = Math.ceil(width / WINDOW_SIZE);
  const mapH = Math.ceil(height / WINDOW_SIZE);
  const mapData: number[] = new Array(mapW * mapH);

  let counter = 0;
  for (let by = 0; by < height; by += WINDOW_SIZE) {
    for (let bx = 0; bx < width; bx += WINDOW_SIZE) {
      const ww = Math.min(WINDOW_SIZE, width - bx);
      const wh = Math.min(WINDOW_SIZE, height - by);
      const n = ww * wh;

      let sum1 = 0,
        sum2 = 0,
        sumSq1 = 0,
        sumSq2 = 0,
        sumCross = 0;

      for (let dy = 0; dy < wh; dy++) {
        const rowStart = ((by + dy) * width + bx) * 4;
        for (let dx = 0; dx < ww; dx++) {
          const px = rowStart + dx * 4;
          const v1 =
            (77 * rgbaA[px] +
              150 * rgbaA[px + 1] +
              29 * rgbaA[px + 2] +
              128) >>
            8;
          const v2 =
            (77 * rgbaB[px] +
              150 * rgbaB[px + 1] +
              29 * rgbaB[px + 2] +
              128) >>
            8;
          sum1 += v1;
          sum2 += v2;
          sumSq1 += v1 * v1;
          sumSq2 += v2 * v2;
          sumCross += v1 * v2;
        }
      }

      const avg1 = sum1 / n;
      const avg2 = sum2 / n;
      const var1 = sumSq1 / n - avg1 * avg1;
      const var2 = sumSq2 / n - avg2 * avg2;
      const cov = sumCross / n - avg1 * avg2;

      const numerator = (2 * avg1 * avg2 + C1) * (2 * cov + C2);
      const denom =
        (avg1 * avg1 + avg2 * avg2 + C1) * (var1 + var2 + C2);
      mapData[counter++] = numerator / denom;
    }
  }

  let totalSsim = 0;
  for (let i = 0; i < mapData.length; i++) totalSsim += mapData[i];

  return {
    meanSsim: totalSsim / mapData.length,
    mapData,
    mapWidth: mapW,
    mapHeight: mapH,
  };
}

// ===========================================================================
// Variant D: "fusedGrayTyped"
// Pre-convert RGBA to Float32Array grayscale, then in-place block stats
// ===========================================================================

function ssimVariantD(
  imgA: SyntheticImage,
  imgB: SyntheticImage,
): SsimMapResult {
  const { width, height } = imgA;
  const gray1 = rgb2grayFloat32(imgA.data, width, height);
  const gray2 = rgb2grayFloat32(imgB.data, width, height);

  const mapW = Math.ceil(width / WINDOW_SIZE);
  const mapH = Math.ceil(height / WINDOW_SIZE);
  const mapData: number[] = new Array(mapW * mapH);

  let counter = 0;
  for (let by = 0; by < height; by += WINDOW_SIZE) {
    for (let bx = 0; bx < width; bx += WINDOW_SIZE) {
      const ww = Math.min(WINDOW_SIZE, width - bx);
      const wh = Math.min(WINDOW_SIZE, height - by);
      const n = ww * wh;

      let sum1 = 0,
        sum2 = 0,
        sumSq1 = 0,
        sumSq2 = 0,
        sumCross = 0;

      for (let dy = 0; dy < wh; dy++) {
        const rowBase = (by + dy) * width + bx;
        for (let dx = 0; dx < ww; dx++) {
          const v1 = gray1[rowBase + dx];
          const v2 = gray2[rowBase + dx];
          sum1 += v1;
          sum2 += v2;
          sumSq1 += v1 * v1;
          sumSq2 += v2 * v2;
          sumCross += v1 * v2;
        }
      }

      const avg1 = sum1 / n;
      const avg2 = sum2 / n;
      const var1 = sumSq1 / n - avg1 * avg1;
      const var2 = sumSq2 / n - avg2 * avg2;
      const cov = sumCross / n - avg1 * avg2;

      const numerator = (2 * avg1 * avg2 + C1) * (2 * cov + C2);
      const denom =
        (avg1 * avg1 + avg2 * avg2 + C1) * (var1 + var2 + C2);
      mapData[counter++] = numerator / denom;
    }
  }

  let totalSsim = 0;
  for (let i = 0; i < mapData.length; i++) totalSsim += mapData[i];

  return {
    meanSsim: totalSsim / mapData.length,
    mapData,
    mapWidth: mapW,
    mapHeight: mapH,
  };
}

// ===========================================================================
// Variant E: "optimizedFull" — Production candidate
// Best combination: pre-computed constants, typed grayscale buffer,
// in-place stats, direct RGBA input, output to Uint8Array
// ===========================================================================

interface OptimizedSsimResult {
  meanSsim: number;
  mapBytes: Uint8Array;
  mapWidth: number;
  mapHeight: number;
}

function computeSsimOptimized(
  rgbaA: Uint8ClampedArray,
  rgbaB: Uint8ClampedArray,
  width: number,
  height: number,
): OptimizedSsimResult & { mapFloat: Float32Array } {
  // Pre-convert to typed grayscale (one allocation)
  const pixelCount = width * height;
  const gray1 = new Float32Array(pixelCount);
  const gray2 = new Float32Array(pixelCount);
  for (let i = 0, j = 0; i < pixelCount; i++, j += 4) {
    gray1[i] = (77 * rgbaA[j] + 150 * rgbaA[j + 1] + 29 * rgbaA[j + 2] + 128) >> 8;
    gray2[i] = (77 * rgbaB[j] + 150 * rgbaB[j + 1] + 29 * rgbaB[j + 2] + 128) >> 8;
  }

  const mapW = Math.ceil(width / WINDOW_SIZE);
  const mapH = Math.ceil(height / WINDOW_SIZE);
  const mapSize = mapW * mapH;
  const mapBytes = new Uint8Array(mapSize);
  const mapFloat = new Float32Array(mapSize);

  let totalSsim = 0;
  let counter = 0;

  for (let by = 0; by < height; by += WINDOW_SIZE) {
    for (let bx = 0; bx < width; bx += WINDOW_SIZE) {
      const ww = Math.min(WINDOW_SIZE, width - bx);
      const wh = Math.min(WINDOW_SIZE, height - by);
      const n = ww * wh;

      let s1 = 0,
        s2 = 0,
        sq1 = 0,
        sq2 = 0,
        cross = 0;

      for (let dy = 0; dy < wh; dy++) {
        const rowBase = (by + dy) * width + bx;
        for (let dx = 0; dx < ww; dx++) {
          const v1 = gray1[rowBase + dx];
          const v2 = gray2[rowBase + dx];
          s1 += v1;
          s2 += v2;
          sq1 += v1 * v1;
          sq2 += v2 * v2;
          cross += v1 * v2;
        }
      }

      const avg1 = s1 / n;
      const avg2 = s2 / n;
      const var1 = sq1 / n - avg1 * avg1;
      const var2 = sq2 / n - avg2 * avg2;
      const cov = cross / n - avg1 * avg2;

      const numerator = (2 * avg1 * avg2 + C1) * (2 * cov + C2);
      const denom = (avg1 * avg1 + avg2 * avg2 + C1) * (var1 + var2 + C2);
      const ssimVal = numerator / denom;

      totalSsim += ssimVal;
      mapFloat[counter] = ssimVal;
      // Quantize to 0-255 for Uint8Array output (clamps negative SSIM to 0)
      mapBytes[counter] = Math.max(
        0,
        Math.min(255, Math.round(ssimVal * 255)),
      );
      counter++;
    }
  }

  return {
    meanSsim: totalSsim / mapSize,
    mapBytes,
    mapFloat,
    mapWidth: mapW,
    mapHeight: mapH,
  };
}

// Wrapper to return standard SsimMapResult for correctness comparison.
// Uses the float map (not the quantized Uint8Array) for precision comparison.
function ssimVariantE(
  imgA: SyntheticImage,
  imgB: SyntheticImage,
): SsimMapResult {
  const result = computeSsimOptimized(
    imgA.data,
    imgB.data,
    imgA.width,
    imgA.height,
  );
  return {
    meanSsim: result.meanSsim,
    mapData: Array.from(result.mapFloat),
    mapWidth: result.mapWidth,
    mapHeight: result.mapHeight,
  };
}

// ---------------------------------------------------------------------------
// Benchmark helpers
// ---------------------------------------------------------------------------

type SsimVariantFn = (a: SyntheticImage, b: SyntheticImage) => SsimMapResult;

function benchmarkVariant(
  fn: SsimVariantFn,
  imgA: SyntheticImage,
  imgB: SyntheticImage,
  warmup: number,
  runs: number,
): { medianMs: number; p95Ms: number; p99Ms: number } {
  // Warmup
  for (let i = 0; i < warmup; i++) fn(imgA, imgB);

  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn(imgA, imgB);
    times.push(performance.now() - t0);
  }

  times.sort((a, b) => a - b);
  return {
    medianMs: times[Math.floor(times.length / 2)],
    p95Ms: times[Math.floor(times.length * 0.95)],
    p99Ms: times[Math.floor(times.length * 0.99)],
  };
}

function benchmarkSsimJs(
  imgA: SyntheticImage,
  imgB: SyntheticImage,
  warmup: number,
  runs: number,
): { medianMs: number; p95Ms: number; p99Ms: number } {
  const a = {
    data: imgA.data,
    width: imgA.width,
    height: imgA.height,
  } as unknown as ImageData;
  const b = {
    data: imgB.data,
    width: imgB.width,
    height: imgB.height,
  } as unknown as ImageData;

  for (let i = 0; i < warmup; i++) ssim(a, b, { ssim: "bezkrovny", downsample: false });

  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    ssim(a, b, { ssim: "bezkrovny", downsample: false });
    times.push(performance.now() - t0);
  }

  times.sort((a, b) => a - b);
  return {
    medianMs: times[Math.floor(times.length / 2)],
    p95Ms: times[Math.floor(times.length * 0.95)],
    p99Ms: times[Math.floor(times.length * 0.99)],
  };
}

// ---------------------------------------------------------------------------
// Test data setup
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

// Precompute all 75 test cases and reference results
interface TestCase {
  base: string;
  distortion: string;
  severity: number;
  imgA: SyntheticImage;
  imgB: SyntheticImage;
  reference: SsimMapResult;
}

const testCases: TestCase[] = [];

for (const [baseName, baseImg] of Object.entries(BASES)) {
  for (const [distName, distFn] of Object.entries(DISTORTIONS)) {
    for (const severity of SEVERITIES) {
      const distorted = distFn(baseImg, severity);
      const reference = runSsimJsReference(baseImg, distorted);
      testCases.push({
        base: baseName,
        distortion: distName,
        severity,
        imgA: baseImg,
        imgB: distorted,
        reference,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Variant definitions
// ---------------------------------------------------------------------------

interface VariantDef {
  name: string;
  fn: SsimVariantFn;
}

const VARIANTS: VariantDef[] = [
  { name: "A: typedArrays", fn: ssimVariantA },
  { name: "B: inPlace", fn: ssimVariantB },
  { name: "C: fusedGray", fn: ssimVariantC },
  { name: "D: fusedGrayTyped", fn: ssimVariantD },
  { name: "E: optimizedFull", fn: ssimVariantE },
];

// ===========================================================================
// Tests
// ===========================================================================

describe("SSIM Performance Investigation", () => {
  // -----------------------------------------------------------------------
  // Phase 1: Correctness baseline
  // -----------------------------------------------------------------------
  describe("Phase 1: Reference correctness baseline", () => {
    it("generates 75 test cases with valid ssim.js reference values", () => {
      expect(testCases.length).toBe(75);

      for (const tc of testCases) {
        // SSIM can be negative for very different images (e.g. large brightness shifts)
        // Valid range is [-1, 1] theoretically
        expect(tc.reference.meanSsim).toBeGreaterThanOrEqual(-1.0);
        expect(tc.reference.meanSsim).toBeLessThanOrEqual(1.001);

        // Map dimensions should match ceil(W/11) x ceil(H/11)
        expect(tc.reference.mapWidth).toBe(Math.ceil(WIDTH / WINDOW_SIZE));
        expect(tc.reference.mapHeight).toBe(Math.ceil(HEIGHT / WINDOW_SIZE));
        expect(tc.reference.mapData.length).toBe(
          tc.reference.mapWidth * tc.reference.mapHeight,
        );
      }
    });

    it("ssim.js returns mssim=1.0 for identical images", () => {
      for (const [name, img] of Object.entries(BASES)) {
        const result = runSsimJsReference(img, img);
        expect(result.meanSsim).toBeCloseTo(1.0, 3);
        // Every map cell should be 1.0
        for (const v of result.mapData) {
          expect(v).toBeCloseTo(1.0, 3);
        }
        console.log(`  ${name}: identical mssim=${result.meanSsim.toFixed(6)}`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2: Correctness tests for each variant
  // -----------------------------------------------------------------------
  describe("Phase 2: Variant correctness vs ssim.js reference", () => {
    for (const variant of VARIANTS) {
      describe(`${variant.name}`, () => {
        it("identical images produce mssim ~= 1.0", () => {
          for (const [, img] of Object.entries(BASES)) {
            const result = variant.fn(img, img);
            expect(result.meanSsim).toBeCloseTo(1.0, 2);
          }
        });

        it("output dimensions match reference", () => {
          for (const tc of testCases) {
            const result = variant.fn(tc.imgA, tc.imgB);
            expect(result.mapWidth).toBe(tc.reference.mapWidth);
            expect(result.mapHeight).toBe(tc.reference.mapHeight);
            expect(result.mapData.length).toBe(tc.reference.mapData.length);
          }
        });

        it("mssim max absolute error <= 0.001 across all 75 cases", () => {
          let maxError = 0;
          let worstCase = "";

          for (const tc of testCases) {
            const result = variant.fn(tc.imgA, tc.imgB);
            const err = Math.abs(result.meanSsim - tc.reference.meanSsim);
            if (err > maxError) {
              maxError = err;
              worstCase = `${tc.base}/${tc.distortion}@${tc.severity}`;
            }
          }

          console.log(
            `  ${variant.name}: mssim max error = ${maxError.toFixed(8)} (worst: ${worstCase})`,
          );
          expect(maxError).toBeLessThanOrEqual(0.001);
        });

        it("per-window SSIM map max absolute error <= 0.005 across all 75 cases", () => {
          let maxMapError = 0;
          let worstCase = "";

          for (const tc of testCases) {
            const result = variant.fn(tc.imgA, tc.imgB);
            for (let i = 0; i < result.mapData.length; i++) {
              const err = Math.abs(
                result.mapData[i] - tc.reference.mapData[i],
              );
              if (err > maxMapError) {
                maxMapError = err;
                worstCase = `${tc.base}/${tc.distortion}@${tc.severity} cell[${i}]`;
              }
            }
          }

          console.log(
            `  ${variant.name}: map max error = ${maxMapError.toFixed(8)} (worst: ${worstCase})`,
          );
          expect(maxMapError).toBeLessThanOrEqual(0.005);
        });
      });
    }
  });

  // -----------------------------------------------------------------------
  // Performance benchmarks
  // -----------------------------------------------------------------------
  describe("Performance benchmarks", () => {
    const WARMUP = 10;
    const RUNS = 100;

    // Resolution test pairs
    const resolutions: Array<{
      label: string;
      w: number;
      h: number;
    }> = [
      { label: "160x90", w: 160, h: 90 },
      { label: "320x180", w: 320, h: 180 },
      { label: "640x360", w: 640, h: 360 },
    ];

    it("benchmark at all resolutions", { timeout: 15_000 }, () => {
      const table: Array<{
        variant: string;
        resolution: string;
        medianMs: number;
        p95Ms: number;
      }> = [];

      for (const res of resolutions) {
        const imgA = createGradientImage(res.w, res.h);
        const imgB = applyGaussianNoise(
          createGradientImage(res.w, res.h),
          0.1,
        );

        // ssim.js baseline
        const baselineStats = benchmarkSsimJs(imgA, imgB, WARMUP, RUNS);
        table.push({
          variant: "ssim.js (bezkrovny)",
          resolution: res.label,
          medianMs: baselineStats.medianMs,
          p95Ms: baselineStats.p95Ms,
        });

        // Each variant
        for (const v of VARIANTS) {
          const stats = benchmarkVariant(v.fn, imgA, imgB, WARMUP, RUNS);
          table.push({
            variant: v.name,
            resolution: res.label,
            medianMs: stats.medianMs,
            p95Ms: stats.p95Ms,
          });
        }
      }

      // Print comparison table
      console.log(
        "\n" + "=".repeat(100),
      );
      console.log(
        "SSIM PERFORMANCE BENCHMARK — median of 100 runs (10 warmup discarded)",
      );
      console.log("=".repeat(100));

      console.log(
        [
          "Variant".padEnd(25),
          "Resolution".padEnd(12),
          "Median (ms)".padEnd(14),
          "p95 (ms)".padEnd(14),
          "Speedup vs ssim.js",
        ].join(" | "),
      );
      console.log("-".repeat(100));

      // Group by resolution for speedup calc
      for (const res of resolutions) {
        const rows = table.filter((r) => r.resolution === res.label);
        const baselineMedian =
          rows.find((r) => r.variant === "ssim.js (bezkrovny)")!.medianMs;

        for (const row of rows) {
          const speedup = baselineMedian / Math.max(row.medianMs, 0.001);
          console.log(
            [
              row.variant.padEnd(25),
              row.resolution.padEnd(12),
              row.medianMs.toFixed(3).padStart(10).padEnd(14),
              row.p95Ms.toFixed(3).padStart(10).padEnd(14),
              row.variant === "ssim.js (bezkrovny)"
                ? "baseline"
                : `${speedup.toFixed(1)}x`,
            ].join(" | "),
          );
        }
        console.log("-".repeat(100));
      }

      console.log("=".repeat(100));

      // All timings should be finite
      for (const row of table) {
        expect(row.medianMs).toBeGreaterThan(0);
        expect(row.medianMs).toBeLessThan(5000);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  it("SUMMARY — correctness + performance overview", () => {
    console.log("\n" + "=".repeat(110));
    console.log("SSIM OPTIMIZATION INVESTIGATION SUMMARY");
    console.log("=".repeat(110));

    // Correctness summary
    console.log("\n--- Correctness (vs ssim.js bezkrovny reference, 75 test cases) ---");
    console.log(
      [
        "Variant".padEnd(25),
        "mssim max err".padEnd(16),
        "map max err".padEnd(16),
        "Status",
      ].join(" | "),
    );
    console.log("-".repeat(80));

    for (const variant of VARIANTS) {
      let maxMssimErr = 0;
      let maxMapErr = 0;

      for (const tc of testCases) {
        const result = variant.fn(tc.imgA, tc.imgB);
        maxMssimErr = Math.max(
          maxMssimErr,
          Math.abs(result.meanSsim - tc.reference.meanSsim),
        );
        for (let i = 0; i < result.mapData.length; i++) {
          maxMapErr = Math.max(
            maxMapErr,
            Math.abs(result.mapData[i] - tc.reference.mapData[i]),
          );
        }
      }

      const mssimOk = maxMssimErr <= 0.001;
      const mapOk = maxMapErr <= 0.005;
      console.log(
        [
          variant.name.padEnd(25),
          maxMssimErr.toFixed(8).padEnd(16),
          maxMapErr.toFixed(8).padEnd(16),
          mssimOk && mapOk ? "PASS" : "FAIL",
        ].join(" | "),
      );
    }

    // Performance summary at 160x90
    console.log("\n--- Performance at 160x90 (median of 100 runs) ---");
    const benchA = createGradientImage(160, 90);
    const benchB = applyGaussianNoise(createGradientImage(160, 90), 0.1);
    const baseline = benchmarkSsimJs(benchA, benchB, 10, 100);

    console.log(
      [
        "Variant".padEnd(25),
        "Median (ms)".padEnd(14),
        "Speedup",
      ].join(" | "),
    );
    console.log("-".repeat(50));
    console.log(
      [
        "ssim.js (bezkrovny)".padEnd(25),
        baseline.medianMs.toFixed(3).padStart(10).padEnd(14),
        "baseline",
      ].join(" | "),
    );

    for (const variant of VARIANTS) {
      const stats = benchmarkVariant(variant.fn, benchA, benchB, 10, 100);
      const speedup = baseline.medianMs / Math.max(stats.medianMs, 0.001);
      console.log(
        [
          variant.name.padEnd(25),
          stats.medianMs.toFixed(3).padStart(10).padEnd(14),
          `${speedup.toFixed(1)}x`,
        ].join(" | "),
      );
    }

    console.log("=".repeat(110));

    // This is a diagnostic test — just assert we ran
    expect(testCases.length).toBe(75);
  });
});
