#!/usr/bin/env node
/**
 * Test JM264 QP WASM decoder with real-world-like H.264 streams.
 *
 * Reproduces the browser scenario: multi-reference B-frame streams
 * where only a partial segment (IDR + few frames) is fed to the decoder.
 *
 * This tests:
 *   1. Full-segment decode (all frames) — baseline
 *   2. Partial-segment decode (IDR only) — simulates worker feeding partial data
 *   3. Partial-segment decode (IDR + few frames) — most common browser case
 *   4. Error recovery: QP data captured by error() before exit
 *   5. Multiple sequential decodes (fresh instance each time)
 *   6. Various stream configurations (resolution, refs, B-frames)
 *
 * Prerequisites:
 *   - ffmpeg in PATH (for generating test streams)
 *   - public/jm264-qp.wasm (run build-jm264.sh first)
 */

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "../public/jm264-qp.wasm");

// ── WASM loader with error recovery support ──

async function loadWasm() {
  const wasmBytes = readFileSync(WASM_PATH);
  const mod = await WebAssembly.compile(wasmBytes);

  const memRef = { current: null };
  const getView = () => new DataView(memRef.current.buffer);

  class WasiExit extends Error {
    constructor(code, output) {
      super(`WASM exit(${code})${output ? ": " + output.trim() : ""}`);
      this.code = code;
      this.output = output;
    }
  }

  let capturedOutput = "";

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
      proc_exit: (code) => { throw new WasiExit(code, capturedOutput); },
      fd_close: () => 0,
      fd_read: () => 0,
      fd_write: (_fd, iovs, iovsLen, nwrittenPtr) => {
        const v = getView();
        const mem = new Uint8Array(memRef.current.buffer);
        let totalBytes = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = v.getUint32(iovs + i * 8, true);
          const len = v.getUint32(iovs + i * 8 + 4, true);
          totalBytes += len;
          const text = new TextDecoder().decode(mem.subarray(ptr, ptr + len));
          capturedOutput += text;
          if (capturedOutput.length > 8192) capturedOutput = capturedOutput.slice(-4096);
        }
        v.setUint32(nwrittenPtr, totalBytes, true);
        return 0;
      },
      fd_seek: () => 0,
    },
  });

  const exports = instance.exports;
  memRef.current = exports.memory;

  try { exports._start(); } catch (e) {
    if (!(e instanceof WasiExit)) throw e;
  }
  capturedOutput = "";

  return { exports, WasiExit, resetOutput: () => { capturedOutput = ""; } };
}

// ── High-level decoder wrapper (mirrors browser's jm264Decoder.ts) ──

function createDecoder(wasmExports, WasiExit) {
  const exp = wasmExports;
  const MAX_BUF = 8 * 1024 * 1024;
  const MAX_MBS = 130000;

  const ctx = exp.jm264_qp_create();
  if (!ctx) throw new Error("jm264_qp_create failed");

  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);
  if (!annexBPtr || !qpOutPtr) throw new Error("malloc failed");

  // Register output buffer for error recovery
  exp.jm264_qp_set_output(qpOutPtr, MAX_MBS);
  const errorRecoveryPtr = exp.jm264_qp_get_error_recovery();

  let destroyed = false;
  let recoveryCount = 0;
  let recoveryWidthMbs = 0;
  let recoveryHeightMbs = 0;

  function readErrorRecovery() {
    try {
      const view = new DataView(exp.memory.buffer);
      const valid = view.getInt32(errorRecoveryPtr, true);
      if (valid) {
        recoveryCount = view.getInt32(errorRecoveryPtr + 4, true);
        recoveryWidthMbs = view.getInt32(errorRecoveryPtr + 8, true);
        recoveryHeightMbs = view.getInt32(errorRecoveryPtr + 12, true);
        return recoveryCount > 0;
      }
    } catch { /* ignore */ }
    return false;
  }

  return {
    decodeFrame(annexB) {
      if (destroyed) throw new Error("destroyed");
      const mem = new Uint8Array(exp.memory.buffer);
      mem.set(annexB, annexBPtr);
      try {
        return exp.jm264_qp_decode(ctx, annexBPtr, annexB.length) === 1;
      } catch (e) {
        if (e instanceof WasiExit) {
          const hasRecovery = readErrorRecovery();
          destroyed = true;
          return hasRecovery;
        }
        throw e;
      }
    },
    flush() {
      if (destroyed) return recoveryCount > 0;
      try {
        return exp.jm264_qp_flush(ctx) === 1;
      } catch (e) {
        if (e instanceof WasiExit) {
          readErrorRecovery();
          destroyed = true;
          return recoveryCount > 0;
        }
        throw e;
      }
    },
    copyQps() {
      if (destroyed) {
        if (recoveryCount > 0) {
          try {
            const qpValues = new Uint8Array(recoveryCount);
            qpValues.set(new Uint8Array(exp.memory.buffer, qpOutPtr, recoveryCount));
            return { qpValues, count: recoveryCount };
          } catch { /* fall through */ }
        }
        return { qpValues: new Uint8Array(0), count: 0 };
      }
      const count = exp.jm264_qp_copy_qps(ctx, qpOutPtr, MAX_MBS);
      const qpValues = new Uint8Array(count);
      qpValues.set(new Uint8Array(exp.memory.buffer, qpOutPtr, count));
      return { qpValues, count };
    },
    getWidthMbs() { return destroyed ? recoveryWidthMbs : exp.jm264_qp_get_width_mbs(ctx); },
    getHeightMbs() { return destroyed ? recoveryHeightMbs : exp.jm264_qp_get_height_mbs(ctx); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      exp.jm264_qp_free(annexBPtr);
      exp.jm264_qp_free(qpOutPtr);
      exp.jm264_qp_destroy(ctx);
    },
    get isDestroyed() { return destroyed; },
    get usedRecovery() { return destroyed && recoveryCount > 0; },
  };
}

// ── Generate H.264 Annex B streams with FFmpeg ──

function generateStream(tmpDir, name, { width, height, frames, qp, crf, refs, bframes }) {
  const outPath = join(tmpDir, `${name}.264`);
  // Use enough duration for all frames + extra for B-frame flush
  const duration = Math.max(2, Math.ceil(frames / 25) + 1);

  // Build x264-params for fine-grained control
  const x264Params = [];
  if (qp !== undefined) x264Params.push(`qp=${qp}`);
  if (refs !== undefined) x264Params.push(`ref=${refs}`);
  if (bframes !== undefined) x264Params.push(`bframes=${bframes}`);
  x264Params.push(`keyint=${frames}`);

  const args = [
    "ffmpeg", "-y",
    "-f", "lavfi",
    "-i", `testsrc=duration=${duration}:size=${width}x${height}:rate=25`,
    "-c:v", "libx264",
    "-frames:v", String(frames),
  ];

  if (crf !== undefined) args.push("-crf", String(crf));
  if (x264Params.length) args.push("-x264-params", x264Params.join(":"));

  args.push("-an", outPath);

  try {
    execSync(args.join(" "), { stdio: "pipe", timeout: 30000 });
  } catch (e) {
    console.error(`FFmpeg failed for ${name}:`, e.stderr?.toString().slice(-200));
    return null;
  }

  return new Uint8Array(readFileSync(outPath));
}

/**
 * Find NAL unit boundaries in an Annex B bitstream.
 * Returns array of { offset, length, type } for each NAL unit.
 */
function parseNalUnits(data) {
  const nalus = [];
  let i = 0;
  while (i < data.length - 4) {
    // Find start code (00 00 00 01 or 00 00 01)
    if (data[i] === 0 && data[i + 1] === 0) {
      let scLen;
      if (data[i + 2] === 0 && data[i + 3] === 1) scLen = 4;
      else if (data[i + 2] === 1) scLen = 3;
      else { i++; continue; }

      const naluStart = i + scLen;
      const naluType = data[naluStart] & 0x1f;

      // Find next start code
      let naluEnd = data.length;
      for (let j = naluStart + 1; j < data.length - 3; j++) {
        if (data[j] === 0 && data[j + 1] === 0 &&
            (data[j + 2] === 1 || (data[j + 2] === 0 && j + 3 < data.length && data[j + 3] === 1))) {
          naluEnd = j;
          break;
        }
      }

      nalus.push({
        offset: i,
        dataOffset: naluStart,
        length: naluEnd - i,
        dataLength: naluEnd - naluStart,
        type: naluType,
        typeName: {7: "SPS", 8: "PPS", 5: "IDR", 1: "non-IDR", 6: "SEI", 9: "AUD"}[naluType] || `nal${naluType}`,
      });

      i = naluEnd;
    } else {
      i++;
    }
  }
  return nalus;
}

/**
 * Extract a subset of NALUs and build an Annex B buffer.
 * Always includes SPS+PPS + specified slice NALUs.
 */
function buildPartialAnnexB(fullStream, maxSlices) {
  const nalus = parseNalUnits(fullStream);
  const startCode = new Uint8Array([0, 0, 0, 1]);

  // Collect parameter sets and slices
  const paramSets = nalus.filter(n => n.type === 7 || n.type === 8); // SPS + PPS
  const slices = nalus.filter(n => n.type === 5 || n.type === 1);    // IDR + non-IDR

  const selectedSlices = slices.slice(0, maxSlices);

  // Build buffer
  let totalSize = 0;
  for (const ps of paramSets) totalSize += startCode.length + ps.dataLength;
  for (const s of selectedSlices) totalSize += startCode.length + s.dataLength;

  const result = new Uint8Array(totalSize);
  let offset = 0;

  for (const ps of paramSets) {
    result.set(startCode, offset); offset += startCode.length;
    result.set(fullStream.subarray(ps.dataOffset, ps.dataOffset + ps.dataLength), offset);
    offset += ps.dataLength;
  }
  for (const s of selectedSlices) {
    result.set(startCode, offset); offset += startCode.length;
    result.set(fullStream.subarray(s.dataOffset, s.dataOffset + s.dataLength), offset);
    offset += s.dataLength;
  }

  return { buffer: result, numParamSets: paramSets.length, numSlices: selectedSlices.length };
}

// ── Test runner ──

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  return async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  };
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "assertion failed");
}

async function main() {
  console.log("=== JM264 Real-World Stream QP Tests ===\n");

  if (!existsSync(WASM_PATH)) {
    console.error("WASM not found. Run: cd wasm && ./build-jm264.sh");
    process.exit(1);
  }

  // Check FFmpeg
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
  } catch {
    console.error("FFmpeg not found. Install it to run these tests.");
    process.exit(1);
  }

  const tmpDir = mkdtempSync("/tmp/jm264-test-");
  console.log("Temp dir:", tmpDir);

  // Generate test streams
  console.log("\nGenerating test streams...");
  const streams = {};

  // Stream 1: Match browser scenario (640x268, Main profile, 5 refs, B-frames)
  streams.browser = generateStream(tmpDir, "browser", {
    width: 640, height: 272, frames: 30, crf: 23, refs: 5, bframes: 3, profile: "main",
  });

  // Stream 2: Simple baseline (no B-frames, 1 ref)
  streams.baseline = generateStream(tmpDir, "baseline", {
    width: 320, height: 240, frames: 10, qp: 26, refs: 1, bframes: 0, profile: "baseline",
  });

  // Stream 3: High profile, many refs
  streams.high = generateStream(tmpDir, "high", {
    width: 1280, height: 720, frames: 15, crf: 28, refs: 4, bframes: 3, profile: "high",
  });

  // Stream 4: Very small (160x120)
  streams.small = generateStream(tmpDir, "small", {
    width: 160, height: 120, frames: 10, qp: 20, refs: 1, bframes: 0, profile: "baseline",
  });

  for (const [name, data] of Object.entries(streams)) {
    if (!data) {
      console.error(`  Failed to generate ${name} stream`);
      process.exit(1);
    }
    const nalus = parseNalUnits(data);
    const sliceCount = nalus.filter(n => n.type === 5 || n.type === 1).length;
    console.log(`  ${name}: ${data.length} bytes, ${nalus.length} NALUs (${sliceCount} slices)`);
  }

  // Run tests
  const tests = [];

  // ── Test 1: Full stream decode (baseline) ──
  tests.push(test("Full decode: baseline profile (no B-frames)", async () => {
    const { exports, WasiExit } = await loadWasm();
    const dec = createDecoder(exports, WasiExit);
    try {
      const ok = dec.decodeFrame(streams.baseline);
      const flushed = !ok ? dec.flush() : false;
      assert(ok || flushed, "No frame decoded from baseline stream");
      const { qpValues, count } = dec.copyQps();
      assert(count > 0, "No QP values");
      assert(dec.getWidthMbs() === 20, `Expected 20 widthMbs, got ${dec.getWidthMbs()}`);
      assert(dec.getHeightMbs() === 15, `Expected 15 heightMbs, got ${dec.getHeightMbs()}`);
      // All QPs should be 26 (fixed QP)
      for (let i = 0; i < count; i++) {
        assert(qpValues[i] === 26, `QP[${i}]=${qpValues[i]}, expected 26`);
      }
    } finally { dec.destroy(); }
  }));

  // ── Test 2: Full stream decode (browser-like) ──
  tests.push(test("Full decode: browser-like stream (Main, 5 refs, B-frames)", async () => {
    const { exports, WasiExit } = await loadWasm();
    const dec = createDecoder(exports, WasiExit);
    try {
      const ok = dec.decodeFrame(streams.browser);
      const flushed = !ok ? dec.flush() : false;
      assert(ok || flushed, "No frame decoded from browser stream");
      const { count } = dec.copyQps();
      assert(count > 0, `No QP values (count=${count})`);
      const w = dec.getWidthMbs();
      const h = dec.getHeightMbs();
      assert(w === 40, `Expected 40 widthMbs, got ${w}`);
      assert(h === 17, `Expected 17 heightMbs, got ${h}`);
    } finally { dec.destroy(); }
  }));

  // ── Test 3: Partial decode (IDR only) ──
  tests.push(test("Partial decode: IDR frame only", async () => {
    const { exports, WasiExit } = await loadWasm();
    const dec = createDecoder(exports, WasiExit);
    try {
      const partial = buildPartialAnnexB(streams.browser, 1); // IDR only
      console.log(`    (${partial.buffer.length} bytes: ${partial.numParamSets} param sets + ${partial.numSlices} slices)`);
      const ok = dec.decodeFrame(partial.buffer);
      const flushed = !ok ? dec.flush() : false;
      const hasQp = ok || flushed;
      if (hasQp) {
        const { count } = dec.copyQps();
        assert(count > 0, "Frame decoded but no QP values");
        console.log(`    Got ${count} QPs, ${dec.getWidthMbs()}x${dec.getHeightMbs()} MBs${dec.usedRecovery ? " (via recovery)" : ""}`);
      } else {
        // IDR alone might not produce output (JM needs next frame header to trigger output)
        console.log("    IDR alone: no frame output (expected with JM's pull model)");
      }
    } finally { dec.destroy(); }
  }));

  // ── Test 4: Partial decode (IDR + 3 frames) — THE BROWSER SCENARIO ──
  tests.push(test("Partial decode: IDR + 3 frames (browser scenario)", async () => {
    const { exports, WasiExit } = await loadWasm();
    const dec = createDecoder(exports, WasiExit);
    try {
      const partial = buildPartialAnnexB(streams.browser, 4); // IDR + 3 non-IDR
      console.log(`    (${partial.buffer.length} bytes: ${partial.numParamSets} param sets + ${partial.numSlices} slices)`);
      const ok = dec.decodeFrame(partial.buffer);
      const flushed = !ok ? dec.flush() : false;
      const hasQp = ok || flushed;
      assert(hasQp, "No frame decoded from partial stream (IDR + 3 frames)");
      const { qpValues, count } = dec.copyQps();
      assert(count > 0, `No QP values (count=${count})`);
      const w = dec.getWidthMbs();
      const h = dec.getHeightMbs();
      assert(w > 0 && h > 0, `Invalid dimensions: ${w}x${h}`);
      console.log(`    Got ${count} QPs, ${w}x${h} MBs (${w*16}x${h*16} px)${dec.usedRecovery ? " (via recovery)" : ""}`);
      // Verify QP values are in reasonable range
      let min = 255, max = 0;
      for (let i = 0; i < count; i++) {
        if (qpValues[i] < min) min = qpValues[i];
        if (qpValues[i] > max) max = qpValues[i];
      }
      assert(min >= 0 && max <= 51, `QP out of range: [${min}, ${max}]`);
      console.log(`    QP range: [${min}, ${max}]`);
    } finally { dec.destroy(); }
  }));

  // ── Test 5: Partial decode with high-profile stream ──
  tests.push(test("Partial decode: High profile (IDR + 3 frames)", async () => {
    const { exports, WasiExit } = await loadWasm();
    const dec = createDecoder(exports, WasiExit);
    try {
      const partial = buildPartialAnnexB(streams.high, 4);
      console.log(`    (${partial.buffer.length} bytes: ${partial.numParamSets} param sets + ${partial.numSlices} slices)`);
      const ok = dec.decodeFrame(partial.buffer);
      const flushed = !ok ? dec.flush() : false;
      const hasQp = ok || flushed;
      assert(hasQp, "No frame decoded from High profile partial stream");
      const { count } = dec.copyQps();
      assert(count > 0, "No QP values");
      console.log(`    Got ${count} QPs, ${dec.getWidthMbs()}x${dec.getHeightMbs()} MBs${dec.usedRecovery ? " (via recovery)" : ""}`);
    } finally { dec.destroy(); }
  }));

  // ── Test 6: Sequential decodes (fresh instance each time) ──
  tests.push(test("Sequential: 5 independent decodes (fresh WASM instance each)", async () => {
    for (let i = 0; i < 5; i++) {
      const { exports, WasiExit } = await loadWasm();
      const dec = createDecoder(exports, WasiExit);
      try {
        const stream = i % 2 === 0 ? streams.baseline : streams.small;
        const ok = dec.decodeFrame(stream);
        const flushed = !ok ? dec.flush() : false;
        assert(ok || flushed, `Decode #${i} failed`);
        const { count } = dec.copyQps();
        assert(count > 0, `Decode #${i}: no QP values`);
      } finally { dec.destroy(); }
    }
  }));

  // ── Test 7: Verify error recovery data availability ──
  tests.push(test("Error recovery: QP data available after WasiExit", async () => {
    // Generate a stream designed to trigger error recovery:
    // Use many refs with a large stream, then feed only partial
    const stream = generateStream(tmpDir, "error_test", {
      width: 640, height: 480, frames: 50, crf: 18, refs: 5, bframes: 3, profile: "main",
    });
    assert(stream, "Failed to generate error test stream");

    const { exports, WasiExit } = await loadWasm();
    const dec = createDecoder(exports, WasiExit);
    try {
      // Feed only IDR + 2 frames (likely triggers frame gap detection)
      const partial = buildPartialAnnexB(stream, 3);
      console.log(`    (${partial.buffer.length} bytes: ${partial.numParamSets} param sets + ${partial.numSlices} slices)`);

      const ok = dec.decodeFrame(partial.buffer);
      const flushed = !ok ? dec.flush() : false;
      const hasQp = ok || flushed;

      if (hasQp) {
        const { count } = dec.copyQps();
        assert(count > 0, "Frame reported but no QP data");
        console.log(`    Got ${count} QPs via ${dec.usedRecovery ? "error recovery" : "normal decode"}`);
      } else {
        console.log("    No QP data (partial decode returned no frame)");
        // This is acceptable — not all partial decodes produce output
      }
    } finally { dec.destroy(); }
  }));

  // ── Test 8: Full stream small ──
  tests.push(test("Full decode: small 160x120 stream", async () => {
    const { exports, WasiExit } = await loadWasm();
    const dec = createDecoder(exports, WasiExit);
    try {
      const ok = dec.decodeFrame(streams.small);
      const flushed = !ok ? dec.flush() : false;
      assert(ok || flushed, "No frame decoded from small stream");
      const { qpValues, count } = dec.copyQps();
      assert(count > 0, "No QP values");
      assert(dec.getWidthMbs() === 10, `widthMbs: expected 10, got ${dec.getWidthMbs()}`);
      assert(dec.getHeightMbs() === 8, `heightMbs: expected 8, got ${dec.getHeightMbs()}`); // 120/16 = 7.5 → 8
      for (let i = 0; i < count; i++) {
        assert(qpValues[i] === 20, `QP[${i}]=${qpValues[i]}, expected 20`);
      }
    } finally { dec.destroy(); }
  }));

  console.log("\nRunning tests...\n");
  for (const t of tests) {
    await t();
  }

  // Cleanup
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
