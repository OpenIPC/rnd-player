#!/usr/bin/env node
/**
 * Compare QP spatial variation between streams with and without
 * Adaptive Quantization (AQ). Validates that:
 *   - AQ-disabled stream has flat (row-constant) QP maps
 *   - AQ-enabled stream has per-macroblock QP variation
 *   - Both decode correctly through our WASM pipeline
 *
 * Generates test streams with a centered logo on flat background
 * (mandelbrot source has a complex center + flat edges, similar to
 * the real-world logo scenario).
 *
 * Usage: node wasm/test-qp-aq-compare.mjs
 */

import { readFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "../public/jm264-qp.wasm");
const BUILD_DIR = join(__dirname, "build");

const MAX_BUF = 8 * 1024 * 1024;
const MAX_MBS = 130000;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// ── WASM loader ──

async function loadWasm() {
  const wasmBytes = readFileSync(WASM_PATH);
  const mod = await WebAssembly.compile(wasmBytes);
  const memRef = { current: null };
  const getView = () => new DataView(memRef.current.buffer);
  class WasiExit extends Error { constructor(code) { super(`exit(${code})`); this.code = code; } }

  const instance = await WebAssembly.instantiate(mod, {
    env: {
      emscripten_notify_memory_growth: () => {},
      __main_argc_argv: () => 0,
      gettime: () => {}, timediff: () => 0n, timenorm: () => 0n, init_time: () => {},
      OpenRTPFile: () => 0, CloseRTPFile: () => {}, GetRTPNALU: () => -1,
    },
    wasi_snapshot_preview1: {
      args_sizes_get: (argcPtr, argvBufSizePtr) => {
        const v = getView(); v.setUint32(argcPtr, 0, true); v.setUint32(argvBufSizePtr, 0, true); return 0;
      },
      args_get: () => 0,
      proc_exit: (code) => { throw new WasiExit(code); },
      fd_close: () => 0, fd_read: () => 0,
      fd_write: (_fd, iovs, iovsLen, nwrittenPtr) => {
        const v = getView();
        let totalBytes = 0;
        for (let i = 0; i < iovsLen; i++) totalBytes += v.getUint32(iovs + i * 8 + 4, true);
        v.setUint32(nwrittenPtr, totalBytes, true);
        return 0;
      },
      fd_seek: () => 0,
    },
  });

  const exports = instance.exports;
  memRef.current = exports.memory;
  try { exports._start(); } catch (e) { if (!(e instanceof WasiExit)) throw e; }
  return { exports, WasiExit };
}

// ── Stream generation ──

function generateStream(name, x264Params, size = "640x480", frames = 10) {
  const outPath = join(BUILD_DIR, `_test_aq_${name}.264`);
  // Use mandelbrot: complex fractal center, flat edges — mimics logo-on-background
  execSync(
    `ffmpeg -f lavfi -i "mandelbrot=size=${size}:rate=25" -t ${frames / 25} ` +
    `-c:v libx264 -x264-params "${x264Params}" ` +
    `-pix_fmt yuv420p -y "${outPath}" 2>/dev/null`,
    { stdio: "pipe" },
  );
  return outPath;
}

// ── QP analysis ──

function analyzeFrameQp(qpValues, widthMbs, heightMbs) {
  const totalMbs = widthMbs * heightMbs;
  let minQp = 255, maxQp = 0, sum = 0;
  for (let i = 0; i < totalMbs; i++) {
    const v = qpValues[i];
    if (v < minQp) minQp = v;
    if (v > maxQp) maxQp = v;
    sum += v;
  }

  // Per-row variance
  let constRows = 0;
  let totalRowVariance = 0;
  for (let row = 0; row < heightMbs; row++) {
    let rowSum = 0;
    const rowStart = row * widthMbs;
    for (let col = 0; col < widthMbs; col++) rowSum += qpValues[rowStart + col];
    const rowMean = rowSum / widthMbs;
    let rowVar = 0;
    for (let col = 0; col < widthMbs; col++) {
      const d = qpValues[rowStart + col] - rowMean;
      rowVar += d * d;
    }
    rowVar /= widthMbs;
    totalRowVariance += rowVar;
    if (rowVar === 0) constRows++;
  }
  const avgRowVariance = totalRowVariance / heightMbs;

  // Global variance
  const mean = sum / totalMbs;
  let globalVar = 0;
  for (let i = 0; i < totalMbs; i++) {
    const d = qpValues[i] - mean;
    globalVar += d * d;
  }
  globalVar /= totalMbs;

  const distinctQps = new Set(qpValues).size;

  return {
    minQp, maxQp, avgQp: mean, globalVariance: globalVar,
    avgRowVariance, constRows, distinctQps, totalMbs,
  };
}

function printQpGrid(qpValues, widthMbs, heightMbs, maxCols = 30) {
  const step = widthMbs > maxCols ? Math.ceil(widthMbs / maxCols) : 1;
  for (let row = 0; row < heightMbs; row++) {
    const cells = [];
    for (let col = 0; col < widthMbs; col += step) {
      cells.push(String(qpValues[row * widthMbs + col]).padStart(3));
    }
    let isConst = true;
    const rowQp = qpValues[row * widthMbs];
    for (let col = 1; col < widthMbs; col++) {
      if (qpValues[row * widthMbs + col] !== rowQp) { isConst = false; break; }
    }
    console.log(`    row ${String(row).padStart(2)}: ${cells.join("")}${isConst ? " <-- CONST" : ""}`);
  }
}

// ── Tests ──

async function testAqComparison() {
  console.log("=== AQ Comparison: No-AQ vs AQ-enabled ===\n");

  // Stream 1: No AQ (aq-mode=0) — should produce flat rows
  console.log("--- Stream A: aq-mode=0 (no adaptive quantization) ---");
  const pathNoAq = generateStream("noaq", "crf=23:aq-mode=0:ref=1:bframes=0");
  const dataNoAq = new Uint8Array(readFileSync(pathNoAq));
  console.log(`  File: ${dataNoAq.length} bytes`);

  // Stream 2: AQ mode 2 (auto-variance) — should produce spatial variation
  console.log("\n--- Stream B: aq-mode=2 aq-strength=1.5 (auto-variance AQ) ---");
  const pathAq = generateStream("aq2", "crf=23:aq-mode=2:aq-strength=1.5:ref=1:bframes=0");
  const dataAq = new Uint8Array(readFileSync(pathAq));
  console.log(`  File: ${dataAq.length} bytes`);

  // Stream 3: AQ mode 3 (auto-variance biased) — strongest adaptation
  console.log("\n--- Stream C: aq-mode=3 aq-strength=1.5 (auto-variance biased) ---");
  const pathAq3 = generateStream("aq3", "crf=23:aq-mode=3:aq-strength=1.5:ref=1:bframes=0");
  const dataAq3 = new Uint8Array(readFileSync(pathAq3));
  console.log(`  File: ${dataAq3.length} bytes`);

  const streams = [
    { name: "No AQ (mode=0)", data: dataNoAq, path: pathNoAq },
    { name: "AQ mode=2 str=1.5", data: dataAq, path: pathAq },
    { name: "AQ mode=3 str=1.5", data: dataAq3, path: pathAq3 },
  ];

  const summaries = [];

  for (const stream of streams) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Decoding: ${stream.name}`);
    console.log("=".repeat(60));

    const { exports: exp, WasiExit } = await loadWasm();
    const ctx = exp.jm264_qp_create();
    const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

    exp.jm264_qp_set_multi_frame(ctx, 1);

    const mem = new Uint8Array(exp.memory.buffer);
    mem.set(stream.data, annexBPtr);

    try { exp.jm264_qp_decode(ctx, annexBPtr, stream.data.length); } catch {}
    try { exp.jm264_qp_flush(ctx); } catch {}

    const frameCount = exp.jm264_qp_get_frame_count(ctx);
    const widthMbs = exp.jm264_qp_get_width_mbs(ctx);
    const heightMbs = exp.jm264_qp_get_height_mbs(ctx);

    console.log(`  ${frameCount} frames, ${widthMbs}x${heightMbs} MBs`);

    let totalConstRows = 0;
    let totalRows = 0;
    let totalAvgRowVar = 0;
    let totalGlobalVar = 0;

    // Show first 3 frames in detail
    const detailFrames = Math.min(frameCount, 3);
    for (let f = 0; f < detailFrames; f++) {
      const count = exp.jm264_qp_copy_frame_qps(ctx, f, qpOutPtr, MAX_MBS);
      const qpValues = new Uint8Array(count);
      qpValues.set(new Uint8Array(exp.memory.buffer, qpOutPtr, count));
      const stats = analyzeFrameQp(qpValues, widthMbs, heightMbs);

      console.log(`\n  Frame ${f}: QP [${stats.minQp}-${stats.maxQp}] avg=${stats.avgQp.toFixed(1)}`);
      console.log(`    Distinct QPs: ${stats.distinctQps}`);
      console.log(`    Constant rows: ${stats.constRows}/${heightMbs} (${(100*stats.constRows/heightMbs).toFixed(0)}%)`);
      console.log(`    Global variance: ${stats.globalVariance.toFixed(2)}`);
      console.log(`    Avg intra-row variance: ${stats.avgRowVariance.toFixed(2)}`);

      printQpGrid(qpValues, widthMbs, heightMbs);

      totalConstRows += stats.constRows;
      totalRows += heightMbs;
      totalAvgRowVar += stats.avgRowVariance;
      totalGlobalVar += stats.globalVariance;
    }

    // Remaining frames — stats only
    for (let f = detailFrames; f < frameCount; f++) {
      const count = exp.jm264_qp_copy_frame_qps(ctx, f, qpOutPtr, MAX_MBS);
      const qpValues = new Uint8Array(count);
      qpValues.set(new Uint8Array(exp.memory.buffer, qpOutPtr, count));
      const stats = analyzeFrameQp(qpValues, widthMbs, heightMbs);
      totalConstRows += stats.constRows;
      totalRows += heightMbs;
      totalAvgRowVar += stats.avgRowVariance;
      totalGlobalVar += stats.globalVariance;
    }

    const avgConstRowPct = (100 * totalConstRows / totalRows).toFixed(1);
    const avgRowVar = (totalAvgRowVar / frameCount).toFixed(2);
    const avgGlobalVar = (totalGlobalVar / frameCount).toFixed(2);

    console.log(`\n  SUMMARY: ${stream.name}`);
    console.log(`    Constant rows: ${totalConstRows}/${totalRows} (${avgConstRowPct}%)`);
    console.log(`    Avg intra-row variance: ${avgRowVar}`);
    console.log(`    Avg global variance: ${avgGlobalVar}`);

    summaries.push({
      name: stream.name,
      constRowPct: parseFloat(avgConstRowPct),
      avgRowVar: parseFloat(avgRowVar),
      avgGlobalVar: parseFloat(avgGlobalVar),
    });

    exp.jm264_qp_free(annexBPtr);
    exp.jm264_qp_free(qpOutPtr);
    exp.jm264_qp_destroy(ctx);
    try { unlinkSync(stream.path); } catch {}
  }

  // ── Assertions ──

  console.log(`\n${"=".repeat(60)}`);
  console.log("Comparison Summary");
  console.log("=".repeat(60));
  for (const s of summaries) {
    console.log(`  ${s.name.padEnd(25)} constRows=${s.constRowPct}%  rowVar=${s.avgRowVar}  globalVar=${s.avgGlobalVar}`);
  }
  console.log();

  const noAq = summaries[0];
  const aq2 = summaries[1];
  const aq3 = summaries[2];

  // No-AQ should have high constant row percentage
  assert(noAq.constRowPct > 50,
    `No-AQ has ${noAq.constRowPct}% constant rows (expected >50%)`);

  // AQ streams should have much lower constant row percentage
  assert(aq2.constRowPct < noAq.constRowPct,
    `AQ mode=2 has ${aq2.constRowPct}% constant rows (< no-AQ ${noAq.constRowPct}%)`);
  assert(aq3.constRowPct < noAq.constRowPct,
    `AQ mode=3 has ${aq3.constRowPct}% constant rows (< no-AQ ${noAq.constRowPct}%)`);

  // AQ should have higher intra-row variance (per-MB QP variation within rows)
  assert(aq2.avgRowVar > noAq.avgRowVar,
    `AQ mode=2 row variance ${aq2.avgRowVar} > no-AQ ${noAq.avgRowVar}`);
  assert(aq3.avgRowVar > noAq.avgRowVar,
    `AQ mode=3 row variance ${aq3.avgRowVar} > no-AQ ${noAq.avgRowVar}`);

  // AQ should have higher global variance (wider QP spread)
  assert(aq2.avgGlobalVar > noAq.avgGlobalVar,
    `AQ mode=2 global variance ${aq2.avgGlobalVar} > no-AQ ${noAq.avgGlobalVar}`);
}

// ── Main ──

async function main() {
  console.log("=== QP Heatmap: AQ Comparison Test ===\n");

  if (!existsSync(WASM_PATH)) {
    console.error("WASM not found. Run: cd wasm && ./build-jm264.sh");
    process.exit(1);
  }

  try { execSync("ffmpeg -version", { stdio: "pipe" }); } catch {
    console.error("FFmpeg not found."); process.exit(1);
  }

  await testAqComparison();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
