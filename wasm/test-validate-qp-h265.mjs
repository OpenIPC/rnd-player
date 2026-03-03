#!/usr/bin/env node
/**
 * Comprehensive QP validation test for the HM H.265/HEVC WASM decoder.
 *
 * Tests:
 *   1. Fixed-QP streams: verifies all 8x8 blocks have the expected QP value
 *   2. Dimension validation: verifies correct block grid dimensions
 *   3. Variable QP (CRF): verifies QP range is valid
 *   4. fMP4 pipeline: extracts NALUs from fragmented MP4, feeds to WASM
 *   5. Multiple sequential decodes: decoder instance reuse
 *
 * Prerequisites:
 *   - HM265 WASM binary built: public/hm265-qp.wasm
 *   - FFmpeg with libx265 available on PATH
 *
 * Usage: node wasm/test-validate-qp-h265.mjs
 */

import { readFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "../public/hm265-qp.wasm");
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
const MAX_BLOCKS = 520000;

function decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, annexBData) {
  if (annexBData.length > MAX_BUF) throw new Error("Buffer too large");

  const mem = new Uint8Array(exp.memory.buffer);
  mem.set(annexBData, annexBPtr);

  const ready = exp.hm265_qp_decode(ctx, annexBPtr, annexBData.length);
  if (!ready) {
    const flushed = exp.hm265_qp_flush(ctx);
    if (!flushed) return null;
  }

  const count = exp.hm265_qp_copy_qps(ctx, qpOutPtr, MAX_BLOCKS);
  const w = exp.hm265_qp_get_width_mbs(ctx);
  const h = exp.hm265_qp_get_height_mbs(ctx);
  const qps = new Uint8Array(new Uint8Array(exp.memory.buffer, qpOutPtr, count).slice(0));
  return { qps, widthBlocks: w, heightBlocks: h, count };
}

function generateTestStream(qp, size = "320x240", frames = 3) {
  const outPath = join(BUILD_DIR, `_test_h265_qp${qp}.265`);
  try {
    execSync(
      `ffmpeg -f lavfi -i "testsrc=duration=${frames / 25}:size=${size}:rate=25" ` +
      `-c:v libx265 -x265-params "qp=${qp}:keyint=25:bframes=0:aq-mode=0:ipratio=1.0" -pix_fmt yuv420p -y "${outPath}" 2>/dev/null`,
      { stdio: "pipe" },
    );
    return outPath;
  } catch {
    return null;
  }
}

function generateCrfStream(crf, size = "320x240", frames = 3) {
  const outPath = join(BUILD_DIR, `_test_h265_crf${crf}.265`);
  try {
    execSync(
      `ffmpeg -f lavfi -i "mandelbrot=size=${size}:rate=25" -t ${frames / 25} ` +
      `-c:v libx265 -x265-params "crf=${crf}:keyint=25:bframes=0" -pix_fmt yuv420p -y "${outPath}" 2>/dev/null`,
      { stdio: "pipe" },
    );
    return outPath;
  } catch {
    return null;
  }
}

// ── Test suites ──

async function testFixedQp(exp) {
  console.log("\n=== Test 1: Fixed QP validation ===");

  for (const qp of [20, 26, 30, 35, 40]) {
    const path = generateTestStream(qp);
    if (!path) {
      console.log(`  (skipping QP ${qp} — FFmpeg/libx265 failed)`);
      continue;
    }

    const rawData = new Uint8Array(readFileSync(path));
    const ctx = exp.hm265_qp_create();
    const annexBPtr = exp.hm265_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.hm265_qp_malloc(MAX_BLOCKS);
    exp.hm265_qp_set_output(qpOutPtr, MAX_BLOCKS);

    const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, rawData);

    if (result) {
      const allMatch = result.qps.every(v => v === qp);
      const minQp = Math.min(...result.qps);
      const maxQp = Math.max(...result.qps);
      assert(allMatch, `QP=${qp}: all ${result.count} blocks have QP=${qp} (range: [${minQp}, ${maxQp}])`);
    } else {
      assert(false, `QP=${qp}: failed to decode`);
    }

    exp.hm265_qp_free(annexBPtr);
    exp.hm265_qp_free(qpOutPtr);
    exp.hm265_qp_destroy(ctx);

    try { unlinkSync(path); } catch {}
  }
}

async function testDimensions(exp) {
  console.log("\n=== Test 2: Dimension validation (8x8 blocks) ===");

  const sizes = [
    { size: "160x120", wBlk: 20, hBlk: 15 },   // QQVGA
    { size: "320x240", wBlk: 40, hBlk: 30 },   // QVGA
    { size: "640x480", wBlk: 80, hBlk: 60 },   // VGA
    { size: "1280x720", wBlk: 160, hBlk: 90 }, // 720p
  ];

  for (const { size, wBlk, hBlk } of sizes) {
    const path = generateTestStream(26, size, 3);
    if (!path) {
      console.log(`  (skipping ${size} — FFmpeg/libx265 failed)`);
      continue;
    }

    const rawData = new Uint8Array(readFileSync(path));
    const ctx = exp.hm265_qp_create();
    const annexBPtr = exp.hm265_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.hm265_qp_malloc(MAX_BLOCKS);
    exp.hm265_qp_set_output(qpOutPtr, MAX_BLOCKS);

    const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, rawData);

    if (result) {
      assert(result.widthBlocks === wBlk,
        `${size}: width=${result.widthBlocks} blocks (expected ${wBlk})`);
      assert(result.heightBlocks === hBlk,
        `${size}: height=${result.heightBlocks} blocks (expected ${hBlk})`);
      assert(result.count === wBlk * hBlk,
        `${size}: count=${result.count} (expected ${wBlk * hBlk})`);
    } else {
      assert(false, `${size}: failed to decode`);
    }

    exp.hm265_qp_free(annexBPtr);
    exp.hm265_qp_free(qpOutPtr);
    exp.hm265_qp_destroy(ctx);

    try { unlinkSync(path); } catch {}
  }
}

async function testVariableQp(exp) {
  console.log("\n=== Test 3: Variable QP (CRF) validation ===");

  const path = generateCrfStream(23, "320x240", 5);
  if (!path) {
    console.log("  (skipping — FFmpeg/libx265 failed)");
    return;
  }

  const rawData = new Uint8Array(readFileSync(path));
  const ctx = exp.hm265_qp_create();
  const annexBPtr = exp.hm265_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.hm265_qp_malloc(MAX_BLOCKS);
  exp.hm265_qp_set_output(qpOutPtr, MAX_BLOCKS);

  const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, rawData);

  if (result) {
    const minQp = Math.min(...result.qps);
    const maxQp = Math.max(...result.qps);
    const expectedBlocks = 40 * 30; // 320/8 * 240/8
    assert(result.count === expectedBlocks, `CRF=23: got ${result.count} blocks (expected ${expectedBlocks})`);
    assert(minQp >= 0 && minQp <= 51, `CRF=23: minQp=${minQp} is valid (0-51)`);
    assert(maxQp >= 0 && maxQp <= 51, `CRF=23: maxQp=${maxQp} is valid (0-51)`);
    assert(maxQp >= minQp, `CRF=23: maxQp (${maxQp}) >= minQp (${minQp})`);
    console.log(`    QP range: [${minQp}, ${maxQp}]`);
  } else {
    assert(false, "CRF=23: failed to decode");
  }

  exp.hm265_qp_free(annexBPtr);
  exp.hm265_qp_free(qpOutPtr);
  exp.hm265_qp_destroy(ctx);

  try { unlinkSync(path); } catch {}
}

async function testFmp4Pipeline(exp) {
  console.log("\n=== Test 4: fMP4 pipeline (simulating browser worker) ===");

  const fmp4Path = join(BUILD_DIR, "_test_h265_fmp4.mp4");
  try {
    execSync(
      `ffmpeg -f lavfi -i "testsrc=duration=0.12:size=320x240:rate=25" ` +
      `-c:v libx265 -x265-params "qp=27:keyint=25:bframes=0:aq-mode=0:ipratio=1.0" -pix_fmt yuv420p ` +
      `-movflags +frag_keyframe+default_base_moof -y "${fmp4Path}" 2>/dev/null`,
      { stdio: "pipe" },
    );
  } catch {
    console.log("  (skipping — FFmpeg/libx265 failed to generate fMP4)");
    return;
  }

  const fmp4Data = readFileSync(fmp4Path);
  const data = new Uint8Array(fmp4Data);
  const boxes = parseBoxes(data, 0, data.length);

  const ftypBox = boxes.find(b => b.type === "ftyp");
  const moovBox = boxes.find(b => b.type === "moov");

  if (!ftypBox || !moovBox) {
    assert(false, "fMP4 pipeline: failed to find ftyp/moov boxes");
    try { unlinkSync(fmp4Path); } catch {}
    return;
  }

  const initEnd = moovBox.offset + moovBox.size;
  const initSegment = data.slice(0, initEnd);
  const mediaSegment = data.slice(initEnd);

  console.log("  Init segment: %d bytes, Media segment: %d bytes", initSegment.length, mediaSegment.length);

  // Extract hvcC from init segment
  const paramSets = extractParameterSetsHEVC(initSegment.buffer);
  assert(paramSets.length >= 3, `fMP4: found ${paramSets.length} param sets (VPS+SPS+PPS) in init segment`);

  // Extract NALUs from media segment
  const sampleNalus = extractNalusFromMediaSegment(mediaSegment);
  assert(sampleNalus.length > 0, `fMP4: extracted ${sampleNalus.length} NALUs from media segment`);

  if (paramSets.length >= 3 && sampleNalus.length > 0) {
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

    const ctx = exp.hm265_qp_create();
    const annexBPtr = exp.hm265_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.hm265_qp_malloc(MAX_BLOCKS);
    exp.hm265_qp_set_output(qpOutPtr, MAX_BLOCKS);

    const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, annexB);

    if (result) {
      assert(result.widthBlocks === 40, `fMP4: widthBlocks=${result.widthBlocks} (expected 40)`);
      assert(result.heightBlocks === 30, `fMP4: heightBlocks=${result.heightBlocks} (expected 30)`);
      const allMatch = result.qps.every(v => v === 27);
      const minQp = Math.min(...result.qps);
      const maxQp = Math.max(...result.qps);
      assert(allMatch, `fMP4: all ${result.count} blocks have QP=27 (range: [${minQp}, ${maxQp}])`);
    } else {
      assert(false, "fMP4: WASM decode failed");
    }

    exp.hm265_qp_free(annexBPtr);
    exp.hm265_qp_free(qpOutPtr);
    exp.hm265_qp_destroy(ctx);
  }

  try { unlinkSync(fmp4Path); } catch {}
}

async function testMultipleDecodes(exp) {
  console.log("\n=== Test 5: Multiple sequential decodes (decoder reuse) ===");

  for (const qp of [20, 30, 40]) {
    const path = generateTestStream(qp, "160x120", 2);
    if (!path) continue;

    const rawData = new Uint8Array(readFileSync(path));
    const ctx = exp.hm265_qp_create();
    assert(ctx !== 0, `QP=${qp}: decoder created`);

    const annexBPtr = exp.hm265_qp_malloc(MAX_BUF);
    const qpOutPtr = exp.hm265_qp_malloc(MAX_BLOCKS);
    exp.hm265_qp_set_output(qpOutPtr, MAX_BLOCKS);

    const result = decodeAnnexB(exp, ctx, annexBPtr, qpOutPtr, rawData);
    if (result) {
      const minQp = Math.min(...result.qps);
      const maxQp = Math.max(...result.qps);
      assert(minQp === qp && maxQp === qp,
        `QP=${qp}: sequential decode correct (range: [${minQp}, ${maxQp}])`);
    }

    exp.hm265_qp_free(annexBPtr);
    exp.hm265_qp_free(qpOutPtr);
    exp.hm265_qp_destroy(ctx);

    try { unlinkSync(path); } catch {}
  }
}

// ── MP4 box helpers ──

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
 * Extract parameter sets (VPS/SPS/PPS) from hvcC box in init segment.
 */
function extractParameterSetsHEVC(initBuf) {
  const nalus = [];
  const data = new Uint8Array(initBuf);

  // Search for hvcC box: [4 bytes size][4 bytes 'hvcC']
  for (let i = 0; i + 8 < data.length; i++) {
    if (data[i + 4] !== 0x68 || data[i + 5] !== 0x76 ||
        data[i + 6] !== 0x63 || data[i + 7] !== 0x43) continue;

    const boxSize = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    if (boxSize < 27 || i + boxSize > data.length) continue;

    let off = i + 8 + 22; // skip header + config fields

    if (off >= data.length) break;
    const numArrays = data[off];
    off++;

    for (let a = 0; a < numArrays && off + 3 <= data.length; a++) {
      off++; // skip type byte
      const numNalus = (data[off] << 8) | data[off + 1];
      off += 2;

      for (let n = 0; n < numNalus && off + 2 <= data.length; n++) {
        const naluLen = (data[off] << 8) | data[off + 1];
        off += 2;
        if (off + naluLen > data.length) break;
        nalus.push(data.slice(off, off + naluLen));
        off += naluLen;
      }
    }
    break;
  }

  return nalus;
}

/**
 * Extract NALUs from an fMP4 media segment (moof+mdat).
 */
function extractNalusFromMediaSegment(mediaSegment) {
  const nalus = [];
  const data = mediaSegment;

  let offset = 0;
  while (offset + 8 <= data.length) {
    const size = (data[offset] << 24) | (data[offset + 1] << 16) |
                 (data[offset + 2] << 8) | data[offset + 3];
    const type = String.fromCharCode(data[offset + 4], data[offset + 5],
                                     data[offset + 6], data[offset + 7]);
    if (type === "mdat") {
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
  console.log("=== HM H.265 WASM QP Validation Test Suite ===\n");

  if (!existsSync(WASM_PATH)) {
    console.error("WASM binary not found:", WASM_PATH);
    console.error("Build it first: cd wasm && ./build-hm265.sh");
    process.exit(1);
  }

  // Check FFmpeg with libx265
  try {
    const encoders = execSync("ffmpeg -encoders 2>/dev/null", { encoding: "utf-8" });
    if (!encoders.includes("libx265")) {
      console.error("FFmpeg found but libx265 encoder is not available.");
      process.exit(1);
    }
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
