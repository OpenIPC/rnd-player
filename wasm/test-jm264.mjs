#!/usr/bin/env node
/**
 * Standalone Node.js test for the JM H.264 reference decoder QP WASM binary.
 * Tests the WASM binary in isolation — no browser, no bundler.
 *
 * Usage: node wasm/test-jm264.mjs [path-to-annexb.264]
 *
 * If no file is provided, uses a built-in minimal test bitstream.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "../public/jm264-qp.wasm");

// ── Load and instantiate WASM ──
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
      // JM timing stubs — gettime writes to a TIME_T* (struct timeval = 2x i32)
      // timediff and timenorm return int64 (BigInt in WASM)
      gettime: () => {},
      timediff: () => 0n,
      timenorm: () => 0n,
      init_time: () => {},
      // JM RTP stubs (not used — we use Annex B)
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
      fd_write: (fd, iovs, iovsLen, nwrittenPtr) => {
        const v = getView();
        const mem = new Uint8Array(memRef.current.buffer);
        let totalWritten = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = v.getUint32(iovs + i * 8, true);
          const len = v.getUint32(iovs + i * 8 + 4, true);
          const bytes = mem.slice(ptr, ptr + len);
          const text = new TextDecoder().decode(bytes);
          if (fd === 1) process.stdout.write(text);
          else if (fd === 2) process.stderr.write(text);
          totalWritten += len;
        }
        v.setUint32(nwrittenPtr, totalWritten, true);
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

  // Initialize WASM runtime
  try {
    exports._start();
  } catch (e) {
    if (!(e instanceof WasiExit)) throw e;
    console.log("  _start() exited with code", e.code);
  }

  return exports;
}

// ── Main test ──
async function main() {
  console.log("=== JM H.264 WASM QP decoder test ===\n");

  // Load WASM
  console.log("Loading WASM from:", WASM_PATH);
  if (!existsSync(WASM_PATH)) {
    console.error("WASM binary not found. Build it first: cd wasm && ./build-jm264.sh");
    process.exit(1);
  }
  const exp = await loadWasm();
  console.log("WASM loaded. Exports:",
    Object.keys(exp).filter(k => k.startsWith("jm264")).join(", "));

  // Create decoder context
  const ctx = exp.jm264_qp_create();
  console.log("jm264_qp_create() →", ctx, ctx ? "OK" : "FAILED");
  if (!ctx) process.exit(1);

  // Allocate buffers
  const MAX_BUF = 8 * 1024 * 1024;
  const MAX_MBS = 130000;
  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);
  console.log("Buffers: annexBPtr=%d, qpOutPtr=%d\n", annexBPtr, qpOutPtr);

  // Load test bitstream — either from CLI arg or built-in
  let rawData;
  const testFile = process.argv[2];
  if (testFile) {
    console.log("Loading test bitstream:", testFile);
    rawData = new Uint8Array(readFileSync(testFile));
  } else {
    // Try to find a test file in the JM build directory
    const jmTestDir = join(__dirname, "build/JM/test");
    const possibleFiles = [
      join(jmTestDir, "test_dec.264"),
      join(__dirname, "build/JM/bin/test_dec.264"),
    ];
    let found = false;
    for (const f of possibleFiles) {
      if (existsSync(f)) {
        console.log("Loading test bitstream:", f);
        rawData = new Uint8Array(readFileSync(f));
        found = true;
        break;
      }
    }
    if (!found) {
      console.log("No test bitstream provided. Usage: node wasm/test-jm264.mjs <file.264>");
      console.log("  Generate one with: ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=25 -c:v libx264 -g 25 test.264");
      exp.jm264_qp_free(annexBPtr);
      exp.jm264_qp_free(qpOutPtr);
      exp.jm264_qp_destroy(ctx);
      process.exit(0);
    }
  }

  console.log("Bitstream size: %d bytes\n", rawData.length);

  // Copy Annex B data to WASM memory
  if (rawData.length > MAX_BUF) {
    console.error("Bitstream too large: %d > %d", rawData.length, MAX_BUF);
    process.exit(1);
  }

  const mem = new Uint8Array(exp.memory.buffer);
  mem.set(rawData, annexBPtr);

  // Decode entire buffer at once (bulk Annex B)
  console.log("Decoding...");
  const ready = exp.jm264_qp_decode(ctx, annexBPtr, rawData.length);
  console.log("jm264_qp_decode() → %d (%s)", ready, ready ? "frame ready" : "no frame");

  let framesDecoded = 0;

  if (ready) {
    framesDecoded++;
    const count = exp.jm264_qp_copy_qps(ctx, qpOutPtr, MAX_MBS);
    const w = exp.jm264_qp_get_width_mbs(ctx);
    const h = exp.jm264_qp_get_height_mbs(ctx);
    console.log("  Frame: %dx%d MBs (%dx%d px), %d QP values", w, h, w * 16, h * 16, count);

    if (count > 0) {
      const qps = new Uint8Array(exp.memory.buffer, qpOutPtr, count);
      const min = Math.min(...qps);
      const max = Math.max(...qps);
      console.log("  QP range: [%d, %d]", min, max);
      if (count <= 100) {
        console.log("  QP values:", Array.from(qps));
      } else {
        console.log("  First 20 QP values:", Array.from(qps.slice(0, 20)));
      }
    }
  }

  // Flush
  console.log("\nFlushing...");
  const flushed = exp.jm264_qp_flush(ctx);
  console.log("jm264_qp_flush() → %d", flushed);
  if (flushed) {
    framesDecoded++;
    const count = exp.jm264_qp_copy_qps(ctx, qpOutPtr, MAX_MBS);
    console.log("  After flush: %d QP values", count);
    if (count > 0) {
      const qps = new Uint8Array(exp.memory.buffer, qpOutPtr, count);
      const min = Math.min(...qps);
      const max = Math.max(...qps);
      console.log("  QP range: [%d, %d]", min, max);
    }
  }

  // Summary
  const finalW = exp.jm264_qp_get_width_mbs(ctx);
  const finalH = exp.jm264_qp_get_height_mbs(ctx);
  console.log("\n=== Summary ===");
  console.log("Frames decoded: %d", framesDecoded);
  console.log("Final dimensions: %dx%d macroblocks (%dx%d pixels)",
    finalW, finalH, finalW * 16, finalH * 16);

  // Cleanup
  exp.jm264_qp_free(annexBPtr);
  exp.jm264_qp_free(qpOutPtr);
  exp.jm264_qp_destroy(ctx);
  console.log("\nCleanup done.");

  if (framesDecoded === 0) {
    console.error("\n*** WARNING: No frames decoded! ***");
    console.error("This may be normal if the bitstream doesn't contain a complete frame.");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
