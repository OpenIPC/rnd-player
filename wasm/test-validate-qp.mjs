#!/usr/bin/env node
/**
 * Comprehensive QP validation test for the JM H.264 WASM decoder.
 *
 * Tests:
 *   1. Fixed-QP streams: verifies all MBs have the expected QP value
 *   2. fMP4 pipeline: extracts NALUs from fragmented MP4 (same as the browser worker),
 *      feeds to WASM, verifies QP extraction
 *   3. Comparison with FFmpeg: parses FFmpeg's -debug qp output and compares
 *      per-MB absolute QP values
 *
 * Prerequisites:
 *   - JM264 WASM binary built: public/jm264-qp.wasm
 *   - FFmpeg available on PATH
 *   - mp4box.js available: npm install
 *
 * Usage: node wasm/test-validate-qp.mjs
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from "fs";
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

// ── WASM loader (same as test-jm264.mjs) ──

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
        // Must report actual byte count; returning 0 causes C runtime write-retry loop
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

function decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, annexBData) {
  if (annexBData.length > MAX_BUF) throw new Error("Buffer too large");

  const mem = new Uint8Array(exp.memory.buffer);
  mem.set(annexBData, annexBPtr);

  const ready = exp.jm264_qp_decode(ctx, annexBPtr, annexBData.length);
  if (!ready) {
    // Try flush
    const flushed = exp.jm264_qp_flush(ctx);
    if (!flushed) return null;
  }

  const count = exp.jm264_qp_copy_qps(ctx, qpOutPtr, MAX_MBS);
  const w = exp.jm264_qp_get_width_mbs(ctx);
  const h = exp.jm264_qp_get_height_mbs(ctx);
  const qps = new Uint8Array(new Uint8Array(exp.memory.buffer, qpOutPtr, count).slice(0));
  return { qps, widthMbs: w, heightMbs: h, count };
}

function generateTestStream(qp, size = "320x240", frames = 3) {
  const outPath = join(BUILD_DIR, `_test_qp${qp}.264`);
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

function generateCrfStream(crf, size = "320x240", frames = 3) {
  const outPath = join(BUILD_DIR, `_test_crf${crf}.264`);
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

/**
 * Parse FFmpeg -debug qp output to extract per-MB QP values.
 * FFmpeg outputs absolute QP values in a grid format after each "New frame" line.
 *
 * Returns array of frames, each frame is { type, qps: number[], width, height }.
 */
function extractFfmpegQps(inputPath) {
  let output;
  try {
    output = execSync(
      `ffmpeg -loglevel debug -debug qp -i "${inputPath}" -f null - 2>&1`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 },
    );
  } catch (e) {
    output = e.stdout || e.stderr || "";
  }

  const lines = output.split("\n");
  const frames = [];
  let currentFrame = null;
  let widthMbs = 0;

  for (const line of lines) {
    // "New frame, type: I" or "New frame, type: P" etc.
    const frameMatch = line.match(/New frame, type: ([IBPPS])/);
    if (frameMatch) {
      if (currentFrame && currentFrame.qps.length > 0) {
        frames.push(currentFrame);
      }
      currentFrame = { type: frameMatch[1], qps: [], rows: 0 };
      continue;
    }

    // Header line with column indices (skip)
    if (currentFrame && line.match(/\]\s+0\s+\d+\s+\d+/)) {
      // Parse width from the column header: "    0       64      128     192     256     "
      // Each column represents 16px, and spacing is ~8 chars per column
      // Width MBs = video_width / 16
      continue;
    }

    // QP row: "[h264 @ addr]  Y  QPQPQP..." where Y is pixel row
    if (currentFrame) {
      const rowMatch = line.match(/\]\s+(\d+)\s+([ \d]+)$/);
      if (rowMatch) {
        const rowQpStr = rowMatch[2].trim();
        // Parse QP values — they are space-separated or packed 2-digit
        // Try space-separated first
        const spaceSeparated = rowQpStr.split(/\s+/).map(Number);
        if (spaceSeparated.length > 1 && spaceSeparated.every(n => !isNaN(n))) {
          currentFrame.qps.push(...spaceSeparated);
          currentFrame.rows++;
          if (widthMbs === 0) widthMbs = spaceSeparated.length;
        }
      }
    }
  }

  if (currentFrame && currentFrame.qps.length > 0) {
    frames.push(currentFrame);
  }

  // Set dimensions
  for (const f of frames) {
    if (widthMbs > 0) {
      f.widthMbs = widthMbs;
      f.heightMbs = f.rows;
    }
  }

  return frames;
}

// ── Test suites ──

async function testFixedQp(exp) {
  console.log("\n=== Test 1: Fixed QP validation ===");

  for (const qp of [20, 26, 30, 35, 40]) {
    const path = generateTestStream(qp);
    if (!path) {
      console.log(`  (skipping QP ${qp} — FFmpeg failed)`);
      continue;
    }

    const rawData = new Uint8Array(readFileSync(path));
    const ctx = exp.jm264_qp_create();
    const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

    const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, rawData);

    if (result) {
      const allMatch = result.qps.every(v => v === qp);
      const minQp = Math.min(...result.qps);
      const maxQp = Math.max(...result.qps);
      assert(allMatch, `QP=${qp}: all ${result.count} MBs have QP=${qp} (range: [${minQp}, ${maxQp}])`);
    } else {
      assert(false, `QP=${qp}: failed to decode`);
    }

    exp.jm264_qp_free(annexBPtr);
    exp.jm264_qp_free(qpOutPtr);
    exp.jm264_qp_destroy(ctx);

    try { unlinkSync(path); } catch {}
  }
}

async function testDimensions(exp) {
  console.log("\n=== Test 2: Dimension validation ===");

  const sizes = [
    { size: "160x120", wMbs: 10, hMbs: 8 },    // QQVGA
    { size: "320x240", wMbs: 20, hMbs: 15 },   // QVGA
    { size: "640x480", wMbs: 40, hMbs: 30 },   // VGA
    { size: "1280x720", wMbs: 80, hMbs: 45 },  // 720p
  ];

  for (const { size, wMbs, hMbs } of sizes) {
    const path = generateTestStream(26, size, 3);
    if (!path) {
      console.log(`  (skipping ${size} — FFmpeg failed)`);
      continue;
    }

    const rawData = new Uint8Array(readFileSync(path));
    const ctx = exp.jm264_qp_create();
    const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

    const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, rawData);

    if (result) {
      assert(result.widthMbs === wMbs,
        `${size}: width=${result.widthMbs} MBs (expected ${wMbs})`);
      assert(result.heightMbs === hMbs,
        `${size}: height=${result.heightMbs} MBs (expected ${hMbs})`);
      assert(result.count === wMbs * hMbs,
        `${size}: count=${result.count} (expected ${wMbs * hMbs})`);
    } else {
      assert(false, `${size}: failed to decode`);
    }

    exp.jm264_qp_free(annexBPtr);
    exp.jm264_qp_free(qpOutPtr);
    exp.jm264_qp_destroy(ctx);

    try { unlinkSync(path); } catch {}
  }
}

async function testVariableQp(exp) {
  console.log("\n=== Test 3: Variable QP (CRF) validation ===");

  // Generate complex content that should produce varying QPs
  const path = generateCrfStream(23, "320x240", 5);
  if (!path) {
    console.log("  (skipping — FFmpeg failed)");
    return;
  }

  const rawData = new Uint8Array(readFileSync(path));
  const ctx = exp.jm264_qp_create();
  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

  const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, rawData);

  if (result) {
    const minQp = Math.min(...result.qps);
    const maxQp = Math.max(...result.qps);
    assert(result.count === 300, `CRF=23: got ${result.count} MBs (expected 300)`);
    assert(minQp >= 0 && minQp <= 51, `CRF=23: minQp=${minQp} is valid (0-51)`);
    assert(maxQp >= 0 && maxQp <= 51, `CRF=23: maxQp=${maxQp} is valid (0-51)`);
    assert(maxQp >= minQp, `CRF=23: maxQp (${maxQp}) >= minQp (${minQp})`);
    console.log(`    QP range: [${minQp}, ${maxQp}]`);
  } else {
    assert(false, "CRF=23: failed to decode");
  }

  exp.jm264_qp_free(annexBPtr);
  exp.jm264_qp_free(qpOutPtr);
  exp.jm264_qp_destroy(ctx);

  try { unlinkSync(path); } catch {}
}

async function testFfmpegComparison(exp) {
  console.log("\n=== Test 4: FFmpeg QP comparison ===");

  // Use a fixed-QP stream where FFmpeg's output is unambiguous
  for (const qp of [22, 28, 34]) {
    const path = generateTestStream(qp, "160x120", 3);
    if (!path) continue;

    // Get FFmpeg's QP values
    const ffmpegFrames = extractFfmpegQps(path);

    // Get our WASM's QP values
    const rawData = new Uint8Array(readFileSync(path));
    const ctx = exp.jm264_qp_create();
    const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

    const wasmResult = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, rawData);

    if (wasmResult && ffmpegFrames.length > 0) {
      // Compare the I frame QPs (most reliable comparison)
      const iFrame = ffmpegFrames.find(f => f.type === "I");
      if (iFrame && iFrame.qps.length > 0) {
        const ffmpegAllMatch = iFrame.qps.every(v => v === qp);
        const wasmAllMatch = wasmResult.qps.every(v => v === qp);
        assert(ffmpegAllMatch && wasmAllMatch,
          `QP=${qp}: FFmpeg and WASM both report all MBs at QP=${qp}`);
        if (!ffmpegAllMatch) {
          const ffMin = Math.min(...iFrame.qps);
          const ffMax = Math.max(...iFrame.qps);
          console.log(`    FFmpeg I-frame QP range: [${ffMin}, ${ffMax}] (${iFrame.qps.length} MBs)`);
        }
        if (!wasmAllMatch) {
          const wMin = Math.min(...wasmResult.qps);
          const wMax = Math.max(...wasmResult.qps);
          console.log(`    WASM QP range: [${wMin}, ${wMax}] (${wasmResult.count} MBs)`);
        }
      } else {
        console.log(`    (FFmpeg didn't produce I-frame QP data for QP=${qp})`);
      }
    } else {
      if (!wasmResult) assert(false, `QP=${qp}: WASM decode failed`);
      if (ffmpegFrames.length === 0) console.log(`    (FFmpeg QP parsing yielded no frames for QP=${qp})`);
    }

    exp.jm264_qp_free(annexBPtr);
    exp.jm264_qp_free(qpOutPtr);
    exp.jm264_qp_destroy(ctx);

    try { unlinkSync(path); } catch {}
  }
}

async function testFmp4Pipeline(exp) {
  console.log("\n=== Test 5: fMP4 pipeline (simulating browser worker) ===");

  // Generate a fragmented MP4 with fixed QP
  const fmp4Path = join(BUILD_DIR, "_test_fmp4.mp4");
  try {
    execSync(
      `ffmpeg -f lavfi -i "testsrc=duration=0.12:size=320x240:rate=25" ` +
      `-c:v libx264 -x264-params "qp=27:ipratio=1.0:pbratio=1.0:ref=1:bframes=0" -pix_fmt yuv420p ` +
      `-movflags +frag_keyframe+default_base_moof -y "${fmp4Path}" 2>/dev/null`,
      { stdio: "pipe" },
    );
  } catch {
    console.log("  (skipping — FFmpeg failed to generate fMP4)");
    return;
  }

  const fmp4Data = readFileSync(fmp4Path);

  // Parse the fMP4 to find moov (init) and moof+mdat (media) boxes
  const data = new Uint8Array(fmp4Data);
  const boxes = parseBoxes(data, 0, data.length);

  // Find init segment: ftyp + moov
  const ftypBox = boxes.find(b => b.type === "ftyp");
  const moovBox = boxes.find(b => b.type === "moov");

  if (!ftypBox || !moovBox) {
    assert(false, "fMP4 pipeline: failed to find ftyp/moov boxes");
    try { unlinkSync(fmp4Path); } catch {}
    return;
  }

  // Init segment = ftyp + moov
  const initEnd = moovBox.offset + moovBox.size;
  const initSegment = data.slice(0, initEnd);

  // Media segment = everything after moov (moof + mdat pairs)
  const mediaSegment = data.slice(initEnd);

  console.log("  Init segment: %d bytes, Media segment: %d bytes", initSegment.length, mediaSegment.length);

  // Extract avcC from init segment
  const paramSets = extractParameterSets(initSegment.buffer);
  assert(paramSets.length >= 2, `fMP4: found ${paramSets.length} param sets (SPS+PPS) in init segment`);

  // Extract NALUs from media segment using raw parsing
  const sampleNalus = extractNalusFromMediaSegment(initSegment, mediaSegment);
  assert(sampleNalus.length > 0, `fMP4: extracted ${sampleNalus.length} NALUs from media segment`);

  if (paramSets.length >= 2 && sampleNalus.length > 0) {
    // Build Annex B buffer (same as worker does)
    const START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
    let totalSize = 0;
    for (const ps of paramSets) totalSize += 4 + ps.length;
    for (const nalu of sampleNalus) totalSize += 4 + nalu.length;

    const annexB = new Uint8Array(totalSize);
    let offset = 0;
    for (const ps of paramSets) {
      annexB.set(START_CODE, offset); offset += 4;
      annexB.set(ps, offset); offset += ps.length;
    }
    for (const nalu of sampleNalus) {
      annexB.set(START_CODE, offset); offset += 4;
      annexB.set(nalu, offset); offset += nalu.length;
    }

    console.log("  Annex B buffer: %d bytes (%d param sets + %d sample NALUs)",
      annexB.length, paramSets.length, sampleNalus.length);

    // Decode with WASM
    const ctx = exp.jm264_qp_create();
    const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

    const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, annexB);

    if (result) {
      assert(result.widthMbs === 20, `fMP4: widthMbs=${result.widthMbs} (expected 20)`);
      assert(result.heightMbs === 15, `fMP4: heightMbs=${result.heightMbs} (expected 15)`);
      const allMatch = result.qps.every(v => v === 27);
      const minQp = Math.min(...result.qps);
      const maxQp = Math.max(...result.qps);
      assert(allMatch, `fMP4: all ${result.count} MBs have QP=27 (range: [${minQp}, ${maxQp}])`);
    } else {
      assert(false, "fMP4: WASM decode failed");
    }

    exp.jm264_qp_free(annexBPtr);
    exp.jm264_qp_free(qpOutPtr);
    exp.jm264_qp_destroy(ctx);
  }

  try { unlinkSync(fmp4Path); } catch {}
}

async function testMultipleDecodes(exp) {
  console.log("\n=== Test 6: Multiple sequential decodes (decoder reuse) ===");

  // Test that we can create and destroy multiple decoder instances
  const results = [];
  for (const qp of [20, 30, 40]) {
    const path = generateTestStream(qp, "160x120", 2);
    if (!path) continue;

    const rawData = new Uint8Array(readFileSync(path));
    const ctx = exp.jm264_qp_create();
    assert(ctx !== 0, `QP=${qp}: decoder created`);

    const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);

    const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, rawData);
    if (result) {
      const minQp = Math.min(...result.qps);
      const maxQp = Math.max(...result.qps);
      assert(minQp === qp && maxQp === qp,
        `QP=${qp}: sequential decode correct (range: [${minQp}, ${maxQp}])`);
    }

    exp.jm264_qp_free(annexBPtr);
    exp.jm264_qp_free(qpOutPtr);
    exp.jm264_qp_destroy(ctx);

    try { unlinkSync(path); } catch {}
  }
}

// ── Simple MP4 box parser ──

function parseBoxes(data, offset, end) {
  const boxes = [];
  while (offset + 8 <= end) {
    const size = (data[offset] << 24) | (data[offset + 1] << 16) |
                 (data[offset + 2] << 8) | data[offset + 3];
    const type = String.fromCharCode(data[offset + 4], data[offset + 5],
                                     data[offset + 6], data[offset + 7]);
    if (size < 8) break;
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

/**
 * Extract parameter sets (SPS/PPS) from avcC box in init segment.
 * Same logic as the worker's extractParameterSets.
 */
function extractParameterSets(initBuf) {
  const nalus = [];
  const data = new Uint8Array(initBuf);

  for (let i = 0; i + 8 < data.length; i++) {
    if (data[i + 4] !== 0x61 || data[i + 5] !== 0x76 ||
        data[i + 6] !== 0x63 || data[i + 7] !== 0x43) continue;

    const boxSize = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    if (boxSize < 15 || i + boxSize > data.length) continue;

    let off = i + 8;
    off += 5; // skip config fields

    const numSPS = data[off] & 0x1f;
    off++;
    for (let s = 0; s < numSPS && off + 2 <= data.length; s++) {
      const spsLen = (data[off] << 8) | data[off + 1];
      off += 2;
      if (off + spsLen > data.length) break;
      nalus.push(data.slice(off, off + spsLen));
      off += spsLen;
    }

    if (off >= data.length) break;
    const numPPS = data[off];
    off++;
    for (let p = 0; p < numPPS && off + 2 <= data.length; p++) {
      const ppsLen = (data[off] << 8) | data[off + 1];
      off += 2;
      if (off + ppsLen > data.length) break;
      nalus.push(data.slice(off, off + ppsLen));
      off += ppsLen;
    }
    break;
  }

  return nalus;
}

/**
 * Extract NALUs from an fMP4 media segment (moof+mdat).
 * Simplified: finds mdat box and parses length-prefixed NALUs.
 */
function extractNalusFromMediaSegment(initSegment, mediaSegment) {
  const nalus = [];
  const data = mediaSegment;

  // Find mdat box
  let offset = 0;
  while (offset + 8 <= data.length) {
    const size = (data[offset] << 24) | (data[offset + 1] << 16) |
                 (data[offset + 2] << 8) | data[offset + 3];
    const type = String.fromCharCode(data[offset + 4], data[offset + 5],
                                     data[offset + 6], data[offset + 7]);
    if (type === "mdat") {
      // Parse length-prefixed NALUs from mdat payload
      let pos = offset + 8;
      const mdatEnd = offset + size;
      while (pos + 4 <= mdatEnd) {
        const naluLen = (data[pos] << 24) | (data[pos + 1] << 16) |
                        (data[pos + 2] << 8) | data[pos + 3];
        pos += 4;
        if (naluLen > 0 && pos + naluLen <= mdatEnd) {
          nalus.push(data.slice(pos, pos + naluLen));
        }
        pos += naluLen;
      }
      break;
    }
    if (size < 8) break;
    offset += size;
  }

  return nalus;
}

// ── Main ──

async function main() {
  console.log("=== JM H.264 WASM QP Validation Test Suite ===\n");

  if (!existsSync(WASM_PATH)) {
    console.error("WASM binary not found:", WASM_PATH);
    console.error("Build it first: cd wasm && ./build-jm264.sh");
    process.exit(1);
  }

  // Check FFmpeg
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
  } catch {
    console.error("FFmpeg not found on PATH. Install it first.");
    process.exit(1);
  }

  console.log("Loading WASM...");
  const exp = await loadWasm();
  console.log("WASM loaded.\n");

  await testFixedQp(exp);
  await testDimensions(exp);
  await testVariableQp(exp);
  await testFfmpegComparison(exp);
  await testFmp4Pipeline(exp);
  await testMultipleDecodes(exp);

  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
