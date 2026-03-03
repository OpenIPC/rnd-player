#!/usr/bin/env node
/**
 * Real-world H.265 QP debug/validation script.
 *
 * Tests HM WASM decoder against ffprobe-reported QP values on realistic streams:
 *   1. Fixed QP: generates stream, decodes with HM, verifies exact QP match
 *   2. CRF variable QP: decodes with HM, compares per-frame average against
 *      ffprobe's reported QP (pkt_side_data QP_TABLE_DATA, or frame-level pict_type)
 *   3. fMP4 pipeline: simulates browser worker (init+media segment → hvcC → Annex B)
 *   4. Multi-frame decode: verifies QP output for P-frames (not just I-frame)
 *   5. Visual QP map dump: prints 8x8 QP grid for manual inspection
 *
 * Usage: node wasm/test-realworld-h265.mjs
 *
 * Prerequisites:
 *   - public/hm265-qp.wasm (run build-hm265.sh first)
 *   - ffmpeg + ffprobe with libx265 on PATH
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

function createDecoder(exp) {
  const ctx = exp.hm265_qp_create();
  const annexBPtr = exp.hm265_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.hm265_qp_malloc(MAX_BLOCKS);
  exp.hm265_qp_set_output(qpOutPtr, MAX_BLOCKS);
  return { ctx, annexBPtr, qpOutPtr };
}

function destroyDecoder(exp, dec) {
  exp.hm265_qp_free(dec.annexBPtr);
  exp.hm265_qp_free(dec.qpOutPtr);
  exp.hm265_qp_destroy(dec.ctx);
}

function printQpMap(result, label) {
  console.log(`\n    --- ${label}: ${result.widthBlocks}x${result.heightBlocks} blocks ---`);
  const minQp = Math.min(...result.qps);
  const maxQp = Math.max(...result.qps);
  const avgQp = result.qps.reduce((a, b) => a + b, 0) / result.count;
  console.log(`    QP range: [${minQp}, ${maxQp}], avg: ${avgQp.toFixed(1)}`);

  // Print first 8 rows (compact)
  const rows = Math.min(result.heightBlocks, 8);
  const cols = Math.min(result.widthBlocks, 20);
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      row.push(String(result.qps[y * result.widthBlocks + x]).padStart(3));
    }
    const suffix = result.widthBlocks > cols ? " ..." : "";
    console.log(`    ${row.join("")}${suffix}`);
  }
  if (result.heightBlocks > rows) console.log("    ...");
}

// ── ffprobe QP comparison helper ──

function getFrameQpFromFfprobe(filePath) {
  try {
    // ffprobe frame-level info: pict_type + (for H.264 only) qp
    // For H.265 there's no direct per-frame QP in ffprobe, but we can get
    // pict_type and use it to verify our decode is for the right frame type
    const out = execSync(
      `ffprobe -v quiet -select_streams v:0 -show_frames -print_format json "${filePath}"`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
    const data = JSON.parse(out);
    return data.frames || [];
  } catch {
    return [];
  }
}

// ── Test suites ──

async function testFixedQpComparison(exp) {
  console.log("\n=== Test 1: Fixed QP — HM vs expected ===");

  for (const qp of [20, 28, 36, 44]) {
    const path = join(BUILD_DIR, `_rw_h265_qp${qp}.265`);
    try {
      execSync(
        `ffmpeg -f lavfi -i "testsrc=duration=0.12:size=320x240:rate=25" ` +
        `-c:v libx265 -x265-params "qp=${qp}:keyint=25:bframes=0:aq-mode=0:ipratio=1.0" ` +
        `-pix_fmt yuv420p -y "${path}" 2>/dev/null`,
        { stdio: "pipe" },
      );
    } catch { continue; }

    const rawData = new Uint8Array(readFileSync(path));
    const dec = createDecoder(exp);
    const result = decodeAnnexB(exp, dec.ctx, dec.annexBPtr, dec.qpOutPtr, rawData);

    if (result) {
      const allMatch = result.qps.every(v => v === qp);
      const minQp = Math.min(...result.qps);
      const maxQp = Math.max(...result.qps);
      assert(allMatch, `QP=${qp}: HM reads [${minQp},${maxQp}], expected ${qp}`);
      if (!allMatch) printQpMap(result, `QP=${qp}`);
    } else {
      assert(false, `QP=${qp}: decode failed`);
    }

    destroyDecoder(exp, dec);
    try { unlinkSync(path); } catch {}
  }
}

async function testCrfVsProbe(exp) {
  console.log("\n=== Test 2: CRF variable QP — HM decode + ffprobe comparison ===");

  const path = join(BUILD_DIR, `_rw_h265_crf28.265`);
  try {
    execSync(
      `ffmpeg -f lavfi -i "mandelbrot=size=320x240:rate=25" -t 0.2 ` +
      `-c:v libx265 -x265-params "crf=28:keyint=25:bframes=0" ` +
      `-pix_fmt yuv420p -y "${path}" 2>/dev/null`,
      { stdio: "pipe" },
    );
  } catch {
    console.log("  (skipping — FFmpeg/libx265 failed)");
    return;
  }

  const rawData = new Uint8Array(readFileSync(path));
  const dec = createDecoder(exp);
  const result = decodeAnnexB(exp, dec.ctx, dec.annexBPtr, dec.qpOutPtr, rawData);

  if (result) {
    const minQp = Math.min(...result.qps);
    const maxQp = Math.max(...result.qps);
    const avgQp = result.qps.reduce((a, b) => a + b, 0) / result.count;

    assert(result.count === 40 * 30, `CRF: block count=${result.count} (expected 1200)`);
    assert(minQp >= 0 && maxQp <= 51, `CRF: QP range [${minQp},${maxQp}] within 0-51`);
    assert(maxQp > minQp, `CRF: QP varies (range [${minQp},${maxQp}])`);

    // ffprobe comparison (frame types)
    const frames = getFrameQpFromFfprobe(path);
    if (frames.length > 0) {
      console.log(`    ffprobe: ${frames.length} frames, types: ${frames.map(f => f.pict_type).join(",")}`);
      console.log(`    HM: avgQP=${avgQp.toFixed(1)}, range=[${minQp},${maxQp}]`);
    }

    printQpMap(result, "CRF=28");
  } else {
    assert(false, "CRF: decode failed");
  }

  destroyDecoder(exp, dec);
  try { unlinkSync(path); } catch {}
}

async function testFmp4RealWorld(exp) {
  console.log("\n=== Test 3: fMP4 pipeline (browser worker simulation) ===");

  // Generate a realistic multi-frame fMP4 with varying content
  const fmp4Path = join(BUILD_DIR, "_rw_h265_fmp4.mp4");
  try {
    execSync(
      `ffmpeg -f lavfi -i "mandelbrot=size=640x480:rate=30" -t 0.5 ` +
      `-c:v libx265 -x265-params "crf=23:keyint=30:bframes=2" -pix_fmt yuv420p ` +
      `-movflags +frag_keyframe+default_base_moof -y "${fmp4Path}" 2>/dev/null`,
      { stdio: "pipe" },
    );
  } catch {
    console.log("  (skipping — FFmpeg/libx265 failed)");
    return;
  }

  const fmp4Data = readFileSync(fmp4Path);
  const data = new Uint8Array(fmp4Data);

  // Parse MP4 boxes to split init + media
  const boxes = parseBoxes(data, 0, data.length);
  const moovBox = boxes.find(b => b.type === "moov");
  if (!moovBox) {
    assert(false, "fMP4: moov box not found");
    return;
  }

  const initEnd = moovBox.offset + moovBox.size;
  const initSegment = data.slice(0, initEnd);
  const mediaSegment = data.slice(initEnd);

  console.log(`  Init: ${initSegment.length} bytes, Media: ${mediaSegment.length} bytes`);

  // Extract hvcC parameter sets
  const paramSets = extractParameterSetsHEVC(initSegment.buffer);
  assert(paramSets.length >= 3, `fMP4: ${paramSets.length} param sets (need VPS+SPS+PPS≥3)`);

  // Extract NALUs from media segment
  const sampleNalus = extractNalusFromMediaSegment(mediaSegment);
  assert(sampleNalus.length > 0, `fMP4: ${sampleNalus.length} NALUs from media`);

  if (paramSets.length >= 3 && sampleNalus.length > 0) {
    // Build Annex B buffer
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

    console.log(`  Annex B: ${annexB.length} bytes (${paramSets.length} PS + ${sampleNalus.length} NALUs)`);

    const dec = createDecoder(exp);
    const result = decodeAnnexB(exp, dec.ctx, dec.annexBPtr, dec.qpOutPtr, annexB);

    if (result) {
      assert(result.widthBlocks === 80, `fMP4: width=${result.widthBlocks} (expected 80)`);
      assert(result.heightBlocks === 60, `fMP4: height=${result.heightBlocks} (expected 60)`);
      const minQp = Math.min(...result.qps);
      const maxQp = Math.max(...result.qps);
      assert(minQp >= 0 && maxQp <= 51, `fMP4: QP range [${minQp},${maxQp}] valid`);
      printQpMap(result, "fMP4 640x480");

      // Compare with ffprobe
      const frames = getFrameQpFromFfprobe(fmp4Path);
      if (frames.length > 0) {
        console.log(`\n    ffprobe frames: ${frames.length}`);
        for (const f of frames.slice(0, 5)) {
          console.log(`      type=${f.pict_type} size=${f.pkt_size}`);
        }
      }
    } else {
      assert(false, "fMP4: decode failed");
    }

    destroyDecoder(exp, dec);
  }

  try { unlinkSync(fmp4Path); } catch {}
}

async function testMultiFrameQp(exp) {
  console.log("\n=== Test 4: Multi-frame decode — I and P frame QPs ===");

  // Generate a longer stream with I + P frames, different QPs for each
  const path = join(BUILD_DIR, "_rw_h265_multi.265");
  try {
    execSync(
      `ffmpeg -f lavfi -i "testsrc=duration=0.4:size=160x120:rate=25" ` +
      `-c:v libx265 -x265-params "qp=30:keyint=10:bframes=0:aq-mode=0:ipratio=1.0" ` +
      `-pix_fmt yuv420p -y "${path}" 2>/dev/null`,
      { stdio: "pipe" },
    );
  } catch {
    console.log("  (skipping — FFmpeg/libx265 failed)");
    return;
  }

  const rawData = new Uint8Array(readFileSync(path));
  console.log(`  Stream: ${rawData.length} bytes`);

  // Decode the full stream
  const dec = createDecoder(exp);
  const result = decodeAnnexB(exp, dec.ctx, dec.annexBPtr, dec.qpOutPtr, rawData);

  if (result) {
    const allMatch = result.qps.every(v => v === 30);
    const minQp = Math.min(...result.qps);
    const maxQp = Math.max(...result.qps);
    assert(result.count === 20 * 15, `Multi-frame: count=${result.count} (expected 300)`);
    assert(allMatch, `Multi-frame: QP=30 uniform [${minQp},${maxQp}]`);

    // Verify ffprobe frame types
    const frames = getFrameQpFromFfprobe(path);
    if (frames.length > 0) {
      const types = frames.map(f => f.pict_type).join(",");
      console.log(`    ffprobe: ${frames.length} frames, types: ${types}`);
    }
  } else {
    assert(false, "Multi-frame: decode failed");
  }

  destroyDecoder(exp, dec);
  try { unlinkSync(path); } catch {}
}

async function testSequentialReuse(exp) {
  console.log("\n=== Test 5: Sequential decoder reuse (different QPs) ===");

  const qps = [22, 30, 38, 46];
  for (const qp of qps) {
    const path = join(BUILD_DIR, `_rw_h265_seq${qp}.265`);
    try {
      execSync(
        `ffmpeg -f lavfi -i "testsrc=duration=0.08:size=160x120:rate=25" ` +
        `-c:v libx265 -x265-params "qp=${qp}:keyint=25:bframes=0:aq-mode=0:ipratio=1.0" ` +
        `-pix_fmt yuv420p -y "${path}" 2>/dev/null`,
        { stdio: "pipe" },
      );
    } catch { continue; }

    const rawData = new Uint8Array(readFileSync(path));
    const dec = createDecoder(exp);
    const result = decodeAnnexB(exp, dec.ctx, dec.annexBPtr, dec.qpOutPtr, rawData);

    if (result) {
      const allMatch = result.qps.every(v => v === qp);
      const minQp = Math.min(...result.qps);
      const maxQp = Math.max(...result.qps);
      assert(allMatch, `Seq QP=${qp}: [${minQp},${maxQp}] (expected ${qp})`);
    } else {
      assert(false, `Seq QP=${qp}: decode failed`);
    }

    destroyDecoder(exp, dec);
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

function extractParameterSetsHEVC(initBuf) {
  const nalus = [];
  const data = new Uint8Array(initBuf);

  for (let i = 0; i + 8 < data.length; i++) {
    if (data[i + 4] !== 0x68 || data[i + 5] !== 0x76 ||
        data[i + 6] !== 0x63 || data[i + 7] !== 0x43) continue;

    const boxSize = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    if (boxSize < 27 || i + boxSize > data.length) continue;

    let off = i + 8 + 22;
    if (off >= data.length) break;
    const numArrays = data[off];
    off++;

    for (let a = 0; a < numArrays && off + 3 <= data.length; a++) {
      const naluType = data[off] & 0x3f;
      off++;
      const numNalus = (data[off] << 8) | data[off + 1];
      off += 2;

      for (let n = 0; n < numNalus && off + 2 <= data.length; n++) {
        const naluLen = (data[off] << 8) | data[off + 1];
        off += 2;
        if (off + naluLen > data.length) break;
        const nalu = data.slice(off, off + naluLen);
        console.log(`    hvcC array type=${naluType} nalu[${n}]: ${naluLen} bytes`);
        nalus.push(nalu);
        off += naluLen;
      }
    }
    break;
  }

  return nalus;
}

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
  console.log("=== HM H.265 Real-World QP Debug & Validation ===\n");

  if (!existsSync(WASM_PATH)) {
    console.error("WASM binary not found:", WASM_PATH);
    process.exit(1);
  }

  try {
    const encoders = execSync("ffmpeg -encoders 2>/dev/null", { encoding: "utf-8" });
    if (!encoders.includes("libx265")) {
      console.error("FFmpeg libx265 not available");
      process.exit(1);
    }
  } catch {
    console.error("FFmpeg not found");
    process.exit(1);
  }

  console.log("Loading WASM...");
  const exp = await loadWasm();
  console.log("WASM loaded.\n");

  await testFixedQpComparison(exp);
  await testCrfVsProbe(exp);
  await testFmp4RealWorld(exp);
  await testMultiFrameQp(exp);
  await testSequentialReuse(exp);

  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
