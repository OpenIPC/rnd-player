/**
 * Generate deterministic 120×68 Y4M test images for VMAF validation against libvmaf.
 *
 * Each test case produces a ref.y4m and dis.y4m file pair. The pixel generation
 * uses simple deterministic formulas (no PRNG) so that the same pixels can be
 * exactly reproduced in the TypeScript validation test.
 *
 * Usage:
 *   npx tsx scripts/vmaf-generate-y4m.ts --output-dir /tmp/vmaf-fixtures
 */

import * as fs from "fs";
import * as path from "path";

const W = 120;
const H = 68;

// ============================================================================
// Image generators — must match vmafLibvmafValidation.test.ts exactly
// ============================================================================

function createHorizontalGradient(): Uint8Array {
  const buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      buf[y * W + x] = Math.round((x / (W - 1)) * 255);
    }
  }
  return buf;
}

function applyBrightnessShift(src: Uint8Array, shift: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(src[i] + shift)));
  }
  return out;
}

function applyBoxBlur(src: Uint8Array, radius: number): Uint8Array {
  const temp = new Float64Array(src.length);
  const out = new Uint8Array(src.length);
  // Horizontal pass
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = Math.max(0, Math.min(W - 1, x + dx));
        sum += src[y * W + sx];
        count++;
      }
      temp[y * W + x] = sum / count;
    }
  }
  // Vertical pass
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = Math.max(0, Math.min(H - 1, y + dy));
        sum += temp[sy * W + x];
        count++;
      }
      out[y * W + x] = Math.max(0, Math.min(255, Math.round(sum / count)));
    }
  }
  return out;
}

function applyPosterize(src: Uint8Array, levels: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const normalized = src[i] / 255;
    const quantized = Math.round(normalized * (levels - 1)) / (levels - 1);
    out[i] = Math.max(0, Math.min(255, Math.round(quantized * 255)));
  }
  return out;
}

function createCheckerboard(blockSize: number): Uint8Array {
  const buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bx = Math.floor(x / blockSize);
      const by = Math.floor(y / blockSize);
      buf[y * W + x] = (bx + by) % 2 === 0 ? 0 : 255;
    }
  }
  return buf;
}

function shiftRight(src: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const srcX = Math.max(0, Math.min(W - 1, x - pixels));
      out[y * W + x] = src[y * W + srcX];
    }
  }
  return out;
}

function createContrastImage(leftVal: number, rightVal: number): Uint8Array {
  const buf = new Uint8Array(W * H);
  const mid = Math.floor(W / 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      buf[y * W + x] = x < mid ? leftVal : rightVal;
    }
  }
  return buf;
}

function createVerticalBars(barWidth: number): Uint8Array {
  const buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bar = Math.floor(x / barWidth);
      buf[y * W + x] = bar % 2 === 0 ? 0 : 255;
    }
  }
  return buf;
}

function shiftHorizontal(src: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const srcX = ((x - pixels) % W + W) % W;
      out[y * W + x] = src[y * W + srcX];
    }
  }
  return out;
}

// ============================================================================
// Y4M writer
// ============================================================================

function writeY4M(filepath: string, frames: Uint8Array[]): void {
  const chromaSize = Math.floor(W / 2) * Math.floor(H / 2);
  const cbCr = new Uint8Array(chromaSize);
  cbCr.fill(128); // Neutral chroma for grayscale

  const header = `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420\n`;
  const fd = fs.openSync(filepath, "w");
  fs.writeSync(fd, header);

  for (const luma of frames) {
    fs.writeSync(fd, "FRAME\n");
    fs.writeSync(fd, luma);
    fs.writeSync(fd, cbCr); // Cb
    fs.writeSync(fd, cbCr); // Cr
  }

  fs.closeSync(fd);
}

// ============================================================================
// Test cases
// ============================================================================

interface TestCase {
  name: string;
  ref: Uint8Array[];
  dis: Uint8Array[];
  description: string;
}

function generateTestCases(): TestCase[] {
  const gradient = createHorizontalGradient();

  const cases: TestCase[] = [];

  // 1. Identity — same image
  cases.push({
    name: "identity",
    ref: [gradient],
    dis: [gradient],
    description: "Identical horizontal gradient; VIF=1, ADM=1, VMAF≈100",
  });

  // 2. Brightness shift
  cases.push({
    name: "brightness",
    ref: [gradient],
    dis: [applyBrightnessShift(gradient, 30)],
    description: "Gradient + 30 brightness (clamped to 255)",
  });

  // 3. Box blur
  cases.push({
    name: "blur_box",
    ref: [gradient],
    dis: [applyBoxBlur(gradient, 3)],
    description: "Gradient with box blur radius=3",
  });

  // 4. Posterize (4 levels)
  cases.push({
    name: "posterize",
    ref: [gradient],
    dis: [applyPosterize(gradient, 4)],
    description: "Gradient quantized to 4 luminance levels",
  });

  // 5. Checkerboard shifted 1px
  const checkerRef = createCheckerboard(8);
  cases.push({
    name: "checkerboard",
    ref: [checkerRef],
    dis: [shiftRight(checkerRef, 1)],
    description: "8x8 checkerboard shifted 1px right",
  });

  // 6. Contrast reduction
  cases.push({
    name: "contrast",
    ref: [createContrastImage(0, 255)],
    dis: [createContrastImage(0, 200)],
    description: "Left=0 Right=255 vs Left=0 Right=200",
  });

  // 7. Edge blur
  const bars = createVerticalBars(4);
  cases.push({
    name: "edges_blur",
    ref: [bars],
    dis: [applyBoxBlur(bars, 3)],
    description: "Vertical bars (width=4) blurred with radius=3",
  });

  // 8. Motion sequence (3 frames)
  cases.push({
    name: "motion",
    ref: [gradient, gradient, gradient],
    dis: [gradient, shiftHorizontal(gradient, 10), shiftHorizontal(gradient, 20)],
    description: "3-frame: static ref vs horizontally shifting dis (+10px, +20px)",
  });

  return cases;
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const args = process.argv.slice(2);
  const outDirIdx = args.indexOf("--output-dir");
  if (outDirIdx === -1 || outDirIdx + 1 >= args.length) {
    console.error("Usage: npx tsx scripts/vmaf-generate-y4m.ts --output-dir <dir>");
    process.exit(1);
  }
  const outDir = args[outDirIdx + 1];

  const cases = generateTestCases();

  for (const tc of cases) {
    const caseDir = path.join(outDir, tc.name);
    fs.mkdirSync(caseDir, { recursive: true });

    const refPath = path.join(caseDir, "ref.y4m");
    const disPath = path.join(caseDir, "dis.y4m");

    writeY4M(refPath, tc.ref);
    writeY4M(disPath, tc.dis);

    console.log(`  ${tc.name}: ${tc.ref.length} frame(s) — ${tc.description}`);
  }

  console.log(`\nGenerated ${cases.length} test cases in ${outDir}`);
}

main();
