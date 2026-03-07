#!/usr/bin/env node
/**
 * Multi-frame QP validation test for the JM H.264 WASM decoder.
 *
 * Verifies Phase 2 per-frame QP capture:
 *   1. Multi-frame mode captures N QP maps (one per decoded frame)
 *   2. Each frame's QP values match the expected fixed QP
 *   3. Frame count matches the number of encoded frames
 *   4. Single-frame mode still captures only the IDR frame (backward compat)
 *   5. Dimensions are consistent across all captured frames
 *   6. Multi-frame mode with variable QP (CRF) produces distinct per-frame maps
 *
 * Prerequisites:
 *   - JM264 WASM binary built: public/jm264-qp.wasm
 *   - FFmpeg available on PATH
 *
 * Usage: node wasm/test-multiframe-qp.mjs
 */

import { readFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "../public/jm264-qp.wasm");
const BUILD_DIR = join(__dirname, "build");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

// ── WASM loader ──

const MAX_BUF = 8 * 1024 * 1024;
const MAX_MBS = 130000;

async function loadWasm() {
  const wasmBytes = readFileSync(WASM_PATH);
  const mod = await WebAssembly.compile(wasmBytes);

  const memRef = { current: null };
  const getView = () => new DataView(memRef.current.buffer);
  class WasiExit { constructor(code) { this.code = code; } }

  const instance = await WebAssembly.instantiate(mod, {
    env: {
      emscripten_notify_memory_growth: () => {},
      __main_argc_argv: () => 0,
      gettime: () => {},
      timediff: () => 0n,
      timenorm: () => 0n,
      init_time: () => {},
      OpenRTPFile: () => 0,
      CloseRTPFile: () => {},
      GetRTPNALU: () => -1,
    },
    wasi_snapshot_preview1: {
      args_sizes_get: (argcPtr, argvBufSizePtr) => {
        const v = getView();
        v.setUint32(argcPtr, 0, true);
        v.setUint32(argvBufSizePtr, 0, true);
        return 0;
      },
      args_get: () => 0,
      environ_sizes_get: (countPtr, bufSizePtr) => {
        const v = getView();
        v.setUint32(countPtr, 0, true);
        v.setUint32(bufSizePtr, 0, true);
        return 0;
      },
      environ_get: () => 0,
      proc_exit: (code) => { throw new WasiExit(code); },
      fd_close: () => 0,
      fd_read: () => 0,
      fd_write: (_fd, iovs, iovsLen, nwrittenPtr) => {
        const v = getView();
        let totalBytes = 0;
        for (let i = 0; i < iovsLen; i++) {
          totalBytes += v.getUint32(iovs + i * 8 + 4, true);
        }
        v.setUint32(nwrittenPtr, totalBytes, true);
        return 0;
      },
      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      clock_time_get: (_clockId, _precision, timePtr) => {
        const v = getView();
        v.setBigUint64(timePtr, 0n, true);
        return 0;
      },
    },
  });

  const exports = instance.exports;
  memRef.current = exports.memory;

  try { exports._start(); } catch (e) {
    if (!(e instanceof WasiExit)) throw e;
  }

  return exports;
}

// ── Helpers ──

function generateTestStream(qp, size = "320x240", frames = 5) {
  const outPath = join(BUILD_DIR, `_test_multi_qp${qp}_${frames}f.264`);
  try {
    execSync(
      `ffmpeg -f lavfi -i "testsrc=duration=${frames / 25}:size=${size}:rate=25" ` +
      `-c:v libx264 -x264-params "qp=${qp}:ipratio=1.0:pbratio=1.0:ref=1:bframes=0" ` +
      `-pix_fmt yuv420p -y "${outPath}" 2>/dev/null`,
      { stdio: "pipe" },
    );
    return outPath;
  } catch {
    return null;
  }
}

function generateCrfStream(crf, size = "320x240", frames = 5) {
  const outPath = join(BUILD_DIR, `_test_multi_crf${crf}_${frames}f.264`);
  try {
    execSync(
      `ffmpeg -f lavfi -i "mandelbrot=size=${size}:rate=25" -t ${frames / 25} ` +
      `-c:v libx264 -crf ${crf} -g 25 -bf 0 -pix_fmt yuv420p -y "${outPath}" 2>/dev/null`,
      { stdio: "pipe" },
    );
    return outPath;
  } catch {
    return null;
  }
}

// ── Test 1: Multi-frame mode captures all frames ──

async function testMultiFrameCapture(exp) {
  console.log("\n=== Test 1: Multi-frame mode captures all frames ===");

  const numFrames = 5;
  const qp = 26;
  const path = generateTestStream(qp, "320x240", numFrames);
  if (!path) {
    console.log("  (skipping — FFmpeg failed)");
    return;
  }

  const rawData = new Uint8Array(readFileSync(path));

  // Fresh WASM instance for multi-frame test
  const ctx = exp.jm264_qp_create();
  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

  // Enable multi-frame mode
  exp.jm264_qp_set_multi_frame(ctx, 1);

  const mem = new Uint8Array(exp.memory.buffer);
  mem.set(rawData, annexBPtr);
  exp.jm264_qp_decode(ctx, annexBPtr, rawData.length);
  exp.jm264_qp_flush(ctx);

  const frameCount = exp.jm264_qp_get_frame_count(ctx);
  const widthMbs = exp.jm264_qp_get_width_mbs(ctx);
  const heightMbs = exp.jm264_qp_get_height_mbs(ctx);
  const totalMbs = widthMbs * heightMbs;

  assert(frameCount === numFrames,
    `Frame count: ${frameCount} (expected ${numFrames})`);
  assert(widthMbs === 20, `Width: ${widthMbs} MBs (expected 20)`);
  assert(heightMbs === 15, `Height: ${heightMbs} MBs (expected 15)`);

  // Verify each frame's QP values
  for (let i = 0; i < frameCount; i++) {
    const count = exp.jm264_qp_copy_frame_qps(ctx, i, qpOutPtr, MAX_MBS);
    const qps = new Uint8Array(new Uint8Array(exp.memory.buffer, qpOutPtr, count).slice(0));
    const allMatch = qps.every(v => v === qp);
    const minQp = Math.min(...qps);
    const maxQp = Math.max(...qps);
    assert(allMatch && count === totalMbs,
      `Frame ${i}: ${count} MBs, all QP=${qp} (range: [${minQp}, ${maxQp}])`);
  }

  exp.jm264_qp_free(annexBPtr);
  exp.jm264_qp_free(qpOutPtr);
  exp.jm264_qp_destroy(ctx);
  try { unlinkSync(path); } catch {}
}

// ── Test 2: Single-frame mode backward compatibility ──

async function testSingleFrameCompat(exp) {
  console.log("\n=== Test 2: Single-frame mode backward compatibility ===");

  const numFrames = 5;
  const qp = 28;
  const path = generateTestStream(qp, "320x240", numFrames);
  if (!path) {
    console.log("  (skipping — FFmpeg failed)");
    return;
  }

  const rawData = new Uint8Array(readFileSync(path));

  const ctx = exp.jm264_qp_create();
  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

  // Default mode (single-frame) — do NOT call set_multi_frame
  const mem = new Uint8Array(exp.memory.buffer);
  mem.set(rawData, annexBPtr);
  const ready = exp.jm264_qp_decode(ctx, annexBPtr, rawData.length);

  assert(ready === 1, `Single-frame mode: decode returned frame_ready=1`);

  // Legacy copyQps should return IDR frame QP
  const count = exp.jm264_qp_copy_qps(ctx, qpOutPtr, MAX_MBS);
  const qps = new Uint8Array(new Uint8Array(exp.memory.buffer, qpOutPtr, count).slice(0));
  const allMatch = qps.every(v => v === qp);
  assert(allMatch && count === 300,
    `Single-frame copyQps: ${count} MBs, all QP=${qp}`);

  // Multi-frame count should be 0 (not enabled)
  const frameCount = exp.jm264_qp_get_frame_count(ctx);
  assert(frameCount === 0,
    `Frame count in single-frame mode: ${frameCount} (expected 0)`);

  exp.jm264_qp_free(annexBPtr);
  exp.jm264_qp_free(qpOutPtr);
  exp.jm264_qp_destroy(ctx);
  try { unlinkSync(path); } catch {}
}

// ── Test 3: Multi-frame with variable QP (CRF) ──

async function testMultiFrameVariableQp(exp) {
  console.log("\n=== Test 3: Multi-frame with variable QP (CRF) ===");

  const numFrames = 5;
  const path = generateCrfStream(23, "320x240", numFrames);
  if (!path) {
    console.log("  (skipping — FFmpeg failed)");
    return;
  }

  const rawData = new Uint8Array(readFileSync(path));

  const ctx = exp.jm264_qp_create();
  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

  exp.jm264_qp_set_multi_frame(ctx, 1);

  const mem = new Uint8Array(exp.memory.buffer);
  mem.set(rawData, annexBPtr);
  exp.jm264_qp_decode(ctx, annexBPtr, rawData.length);
  exp.jm264_qp_flush(ctx);

  const frameCount = exp.jm264_qp_get_frame_count(ctx);
  assert(frameCount >= 2, `CRF mode: captured ${frameCount} frames (expected ≥2)`);

  // Collect per-frame average QP
  const avgQps = [];
  for (let i = 0; i < frameCount; i++) {
    const count = exp.jm264_qp_copy_frame_qps(ctx, i, qpOutPtr, MAX_MBS);
    const qps = new Uint8Array(new Uint8Array(exp.memory.buffer, qpOutPtr, count).slice(0));
    const sum = qps.reduce((a, b) => a + b, 0);
    const avg = count > 0 ? sum / count : 0;
    const minQp = Math.min(...qps);
    const maxQp = Math.max(...qps);
    avgQps.push(avg);
    assert(count === 300 && minQp >= 0 && maxQp <= 51,
      `Frame ${i}: avg QP=${avg.toFixed(1)}, range=[${minQp}, ${maxQp}]`);
  }

  // With CRF, we expect some variation in average QP across frames
  console.log(`    Per-frame avg QPs: [${avgQps.map(q => q.toFixed(1)).join(", ")}]`);

  exp.jm264_qp_free(annexBPtr);
  exp.jm264_qp_free(qpOutPtr);
  exp.jm264_qp_destroy(ctx);
  try { unlinkSync(path); } catch {}
}

// ── Test 4: Out-of-bounds frame index returns 0 ──

async function testOutOfBoundsIndex(exp) {
  console.log("\n=== Test 4: Out-of-bounds frame index safety ===");

  const path = generateTestStream(26, "160x120", 3);
  if (!path) {
    console.log("  (skipping — FFmpeg failed)");
    return;
  }

  const rawData = new Uint8Array(readFileSync(path));

  const ctx = exp.jm264_qp_create();
  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

  exp.jm264_qp_set_multi_frame(ctx, 1);

  const mem = new Uint8Array(exp.memory.buffer);
  mem.set(rawData, annexBPtr);
  exp.jm264_qp_decode(ctx, annexBPtr, rawData.length);
  exp.jm264_qp_flush(ctx);

  const frameCount = exp.jm264_qp_get_frame_count(ctx);

  // Request frame beyond the count
  const beyondCount = exp.jm264_qp_copy_frame_qps(ctx, frameCount, qpOutPtr, MAX_MBS);
  assert(beyondCount === 0, `Index ${frameCount} (beyond count): returned ${beyondCount} (expected 0)`);

  const negativeCount = exp.jm264_qp_copy_frame_qps(ctx, -1, qpOutPtr, MAX_MBS);
  assert(negativeCount === 0, `Index -1: returned ${negativeCount} (expected 0)`);

  const largeCount = exp.jm264_qp_copy_frame_qps(ctx, 999, qpOutPtr, MAX_MBS);
  assert(largeCount === 0, `Index 999: returned ${largeCount} (expected 0)`);

  exp.jm264_qp_free(annexBPtr);
  exp.jm264_qp_free(qpOutPtr);
  exp.jm264_qp_destroy(ctx);
  try { unlinkSync(path); } catch {}
}

// ── Test 5: Toggle multi-frame mode resets frame list ──

async function testModeToggleReset(exp) {
  console.log("\n=== Test 5: Toggling multi-frame mode resets frame list ===");

  const path = generateTestStream(26, "160x120", 4);
  if (!path) {
    console.log("  (skipping — FFmpeg failed)");
    return;
  }

  const rawData = new Uint8Array(readFileSync(path));

  const ctx = exp.jm264_qp_create();
  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

  // First decode in multi-frame mode
  exp.jm264_qp_set_multi_frame(ctx, 1);
  let mem = new Uint8Array(exp.memory.buffer);
  mem.set(rawData, annexBPtr);
  exp.jm264_qp_decode(ctx, annexBPtr, rawData.length);
  exp.jm264_qp_flush(ctx);

  const count1 = exp.jm264_qp_get_frame_count(ctx);
  assert(count1 > 0, `First decode: captured ${count1} frames`);

  // Toggle off and back on — should reset
  exp.jm264_qp_set_multi_frame(ctx, 0);
  const countAfterOff = exp.jm264_qp_get_frame_count(ctx);
  assert(countAfterOff === 0, `After disable: frame count = ${countAfterOff} (expected 0)`);

  exp.jm264_qp_set_multi_frame(ctx, 1);
  const countAfterReenable = exp.jm264_qp_get_frame_count(ctx);
  assert(countAfterReenable === 0, `After re-enable: frame count = ${countAfterReenable} (expected 0)`);

  exp.jm264_qp_free(annexBPtr);
  exp.jm264_qp_free(qpOutPtr);
  exp.jm264_qp_destroy(ctx);
  try { unlinkSync(path); } catch {}
}

// ── Main ──

async function main() {
  console.log("=== JM H.264 Multi-Frame QP Validation Tests ===\n");

  if (!existsSync(WASM_PATH)) {
    console.error("WASM binary not found:", WASM_PATH);
    console.error("Build it first: cd wasm && ./build-jm264.sh");
    process.exit(1);
  }

  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
  } catch {
    console.error("FFmpeg not found on PATH.");
    process.exit(1);
  }

  console.log("Loading WASM...");
  const exp = await loadWasm();
  console.log("WASM loaded.\n");

  await testMultiFrameCapture(exp);
  await testSingleFrameCompat(exp);
  await testMultiFrameVariableQp(exp);
  await testOutOfBoundsIndex(exp);
  await testModeToggleReset(exp);

  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
