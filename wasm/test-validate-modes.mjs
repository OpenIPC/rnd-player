#!/usr/bin/env node
/**
 * Prediction mode validation test for the JM H.264 WASM decoder.
 *
 * Tests:
 *   1. All-intra stream (-g 1): every MB → mode=0 (intra)
 *   2. P-only stream (-bf 0): IDR frame = all intra, P-frames = mostly inter+skip
 *   3. Static content: P-frames → high skip ratio
 *   4. Mode array length = QP array length
 *
 * Prerequisites:
 *   - JM264 WASM binary built: public/jm264-qp.wasm
 *   - FFmpeg available on PATH
 *
 * Usage: node wasm/test-validate-modes.mjs
 */

import { readFileSync, existsSync } from "fs";
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

const MAX_BUF = 8 * 1024 * 1024;
const MAX_MBS = 130000;

function decodeMultiFrame(exp, annexBData) {
  const ctx = exp.jm264_qp_create();
  if (ctx === 0) throw new Error("Failed to create decoder");

  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);
  const modeOutPtr = exp.jm264_qp_malloc(MAX_MBS);
  exp.jm264_qp_set_output(qpOutPtr, MAX_MBS);

  exp.jm264_qp_set_multi_frame(ctx, 1);

  const mem = new Uint8Array(exp.memory.buffer);
  mem.set(annexBData, annexBPtr);

  try { exp.jm264_qp_decode(ctx, annexBPtr, annexBData.length); } catch {}
  try { exp.jm264_qp_flush(ctx); } catch {}

  const frameCount = exp.jm264_qp_get_frame_count(ctx);
  const w = exp.jm264_qp_get_width_mbs(ctx);
  const h = exp.jm264_qp_get_height_mbs(ctx);

  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const qpCount = exp.jm264_qp_copy_frame_qps(ctx, i, qpOutPtr, MAX_MBS);
    const qps = new Uint8Array(new Uint8Array(exp.memory.buffer, qpOutPtr, qpCount).slice(0));

    const modeCount = exp.jm264_qp_copy_frame_modes(ctx, i, modeOutPtr, MAX_MBS);
    const modes = new Uint8Array(new Uint8Array(exp.memory.buffer, modeOutPtr, modeCount).slice(0));

    frames.push({ qps, modes, qpCount, modeCount });
  }

  exp.jm264_qp_free(annexBPtr);
  exp.jm264_qp_free(qpOutPtr);
  exp.jm264_qp_free(modeOutPtr);
  exp.jm264_qp_destroy(ctx);

  return { frames, widthMbs: w, heightMbs: h };
}

function generateStream(opts) {
  const { name, x264Params, size = "320x240", frames = 5, input = "testsrc" } = opts;
  const outPath = join(BUILD_DIR, `_test_modes_${name}.264`);
  try {
    const inputCmd = input === "color"
      ? `-f lavfi -i "color=c=black:s=${size}:d=${frames / 25}:r=25"`
      : `-f lavfi -i "testsrc=duration=${frames / 25}:size=${size}:rate=25"`;
    execSync(
      `ffmpeg ${inputCmd} ` +
      `-c:v libx264 -x264-params "${x264Params}" ` +
      `-pix_fmt yuv420p -y "${outPath}" 2>/dev/null`,
      { stdio: "pipe" },
    );
    return outPath;
  } catch {
    return null;
  }
}

// ── Tests ──

async function main() {
  if (!existsSync(WASM_PATH)) {
    console.error("WASM binary not found. Build with: cd wasm && ./build-jm264.sh");
    process.exit(1);
  }

  // Check FFmpeg
  try { execSync("ffmpeg -version", { stdio: "pipe" }); } catch {
    console.error("FFmpeg not found on PATH");
    process.exit(1);
  }

  console.log("\n=== Prediction Mode Validation Tests ===\n");

  // Test 1: All-intra stream — every frame should be all intra
  console.log("Test 1: All-intra stream (keyint=1)");
  {
    const path = generateStream({
      name: "allintra",
      x264Params: "qp=26:ref=1:bframes=0:keyint=1",
      frames: 5,
    });
    assert(path !== null, "Generated all-intra stream");
    if (path) {
      const exp = await loadWasm();
      const annexB = readFileSync(path);
      const result = decodeMultiFrame(exp, annexB);

      assert(result.frames.length >= 3, `Decoded ${result.frames.length} frames (≥3)`);

      for (let i = 0; i < result.frames.length; i++) {
        const { modes, modeCount } = result.frames[i];
        assert(modeCount > 0, `Frame ${i}: mode array has ${modeCount} entries`);

        let intraCount = 0;
        for (let j = 0; j < modeCount; j++) {
          if (modes[j] === 0) intraCount++;
        }
        assert(
          intraCount === modeCount,
          `Frame ${i}: all-intra (${intraCount}/${modeCount} = ${((intraCount / modeCount) * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  // Test 2: P-only stream — IDR = intra, P-frames = mostly inter+skip
  console.log("\nTest 2: P-only stream (IDR + P-frames)");
  {
    const path = generateStream({
      name: "ponly",
      x264Params: "qp=26:ref=1:bframes=0",
      frames: 5,
    });
    assert(path !== null, "Generated P-only stream");
    if (path) {
      const exp = await loadWasm();
      const annexB = readFileSync(path);
      const result = decodeMultiFrame(exp, annexB);

      assert(result.frames.length >= 3, `Decoded ${result.frames.length} frames`);

      if (result.frames.length > 0) {
        // First frame (IDR) should be all intra
        const idr = result.frames[0];
        let idrIntra = 0;
        for (let j = 0; j < idr.modeCount; j++) {
          if (idr.modes[j] === 0) idrIntra++;
        }
        assert(
          idrIntra === idr.modeCount,
          `IDR frame: all intra (${idrIntra}/${idr.modeCount})`,
        );

        // Later frames should have inter and/or skip blocks
        if (result.frames.length > 1) {
          const pFrame = result.frames[1];
          let interCount = 0, skipCount = 0;
          for (let j = 0; j < pFrame.modeCount; j++) {
            if (pFrame.modes[j] === 1) interCount++;
            if (pFrame.modes[j] === 2) skipCount++;
          }
          assert(
            interCount + skipCount > 0,
            `P-frame: has inter(${interCount}) + skip(${skipCount}) blocks`,
          );
        }
      }
    }
  }

  // Test 3: Static content — P-frames should have high skip ratio
  console.log("\nTest 3: Static content (high skip ratio)");
  {
    const path = generateStream({
      name: "static",
      x264Params: "qp=26:ref=1:bframes=0",
      frames: 5,
      input: "color",
    });
    assert(path !== null, "Generated static content stream");
    if (path) {
      const exp = await loadWasm();
      const annexB = readFileSync(path);
      const result = decodeMultiFrame(exp, annexB);

      assert(result.frames.length >= 3, `Decoded ${result.frames.length} frames`);

      if (result.frames.length > 2) {
        // A late P-frame on static content should have many skips
        const lastFrame = result.frames[result.frames.length - 1];
        let skipCount = 0;
        for (let j = 0; j < lastFrame.modeCount; j++) {
          if (lastFrame.modes[j] === 2) skipCount++;
        }
        const skipPct = (skipCount / lastFrame.modeCount) * 100;
        assert(
          skipPct > 50,
          `Static P-frame: ${skipPct.toFixed(0)}% skip (>50% expected)`,
        );
      }
    }
  }

  // Test 4: Mode array length matches QP array length
  console.log("\nTest 4: Mode array length = QP array length");
  {
    const path = generateStream({
      name: "lencheck",
      x264Params: "qp=30:ref=1:bframes=0",
      frames: 4,
    });
    assert(path !== null, "Generated test stream");
    if (path) {
      const exp = await loadWasm();
      const annexB = readFileSync(path);
      const result = decodeMultiFrame(exp, annexB);

      for (let i = 0; i < result.frames.length; i++) {
        const { qpCount, modeCount } = result.frames[i];
        assert(
          qpCount === modeCount,
          `Frame ${i}: QP count (${qpCount}) = mode count (${modeCount})`,
        );
      }
    }
  }

  // Test 5: Mode values are in valid range (0, 1, 2)
  console.log("\nTest 5: Mode values in valid range [0,1,2]");
  {
    const path = generateStream({
      name: "range",
      x264Params: "qp=26:ref=1:bframes=0",
      frames: 5,
    });
    assert(path !== null, "Generated test stream");
    if (path) {
      const exp = await loadWasm();
      const annexB = readFileSync(path);
      const result = decodeMultiFrame(exp, annexB);

      for (let i = 0; i < result.frames.length; i++) {
        const { modes, modeCount } = result.frames[i];
        let invalid = 0;
        for (let j = 0; j < modeCount; j++) {
          if (modes[j] > 2) invalid++;
        }
        assert(invalid === 0, `Frame ${i}: all modes in [0,1,2] (${modeCount} blocks)`);
      }
    }
  }

  // ── Summary ──
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
