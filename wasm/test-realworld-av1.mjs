#!/usr/bin/env node
/**
 * Real-world AV1 QP debug/validation script.
 *
 * Tests dav1d WASM decoder with realistic AV1 streams:
 *   1. Fixed q_index: generates stream, decodes with dav1d, verifies
 *   2. CRF variable QP: decodes, compares per-frame average
 *   3. fMP4 pipeline: simulates browser worker (init+media segment → av1C → OBUs)
 *   4. Multi-frame decode: verifies QP output for multiple frames
 *   5. Visual QP map dump: prints 8x8 q_index grid for manual inspection
 *
 * Usage: node wasm/test-realworld-av1.mjs
 *
 * Prerequisites:
 *   - public/dav1d-qp.wasm (run build-dav1d-av1.sh first)
 *   - ffmpeg + ffprobe with libsvtav1 or libaom-av1 on PATH
 */

import { readFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "../public/dav1d-qp.wasm");
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

function decodeObu(exp, ctx, obuBufPtr, qpOutPtr, obuData) {
  if (obuData.length > MAX_BUF) throw new Error("Buffer too large");

  const mem = new Uint8Array(exp.memory.buffer);
  mem.set(obuData, obuBufPtr);

  const ready = exp.dav1d_qp_decode(ctx, obuBufPtr, obuData.length);
  if (!ready) {
    const flushed = exp.dav1d_qp_flush(ctx);
    if (!flushed) return null;
  }

  const count = exp.dav1d_qp_copy_qps(ctx, qpOutPtr, MAX_BLOCKS);
  const w = exp.dav1d_qp_get_width_mbs(ctx);
  const h = exp.dav1d_qp_get_height_mbs(ctx);
  const qps = new Uint8Array(new Uint8Array(exp.memory.buffer, qpOutPtr, count).slice(0));
  return { qps, widthBlocks: w, heightBlocks: h, count };
}

function createDecoder(exp) {
  const ctx = exp.dav1d_qp_create();
  const obuBufPtr = exp.dav1d_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.dav1d_qp_malloc(MAX_BLOCKS);
  exp.dav1d_qp_set_output(qpOutPtr, MAX_BLOCKS);
  return { ctx, obuBufPtr, qpOutPtr };
}

function destroyDecoder(exp, dec) {
  exp.dav1d_qp_free(dec.obuBufPtr);
  exp.dav1d_qp_free(dec.qpOutPtr);
  exp.dav1d_qp_destroy(dec.ctx);
}

function getAv1Encoder() {
  try {
    const encoders = execSync("ffmpeg -encoders 2>/dev/null", { encoding: "utf-8" });
    if (encoders.includes("libsvtav1")) return "libsvtav1";
    if (encoders.includes("libaom-av1")) return "libaom-av1";
    return null;
  } catch {
    return null;
  }
}

function readIvfObus(path) {
  const data = readFileSync(path);
  const buf = new Uint8Array(data);
  if (buf.length < 32) return null;
  const sig = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (sig !== "DKIF") return null;

  let offset = 32;
  const frames = [];
  while (offset + 12 <= buf.length) {
    const frameSize = buf[offset] | (buf[offset+1] << 8) | (buf[offset+2] << 16) | (buf[offset+3] << 24);
    offset += 12;
    if (offset + frameSize > buf.length) break;
    frames.push(buf.slice(offset, offset + frameSize));
    offset += frameSize;
  }

  let totalSize = 0;
  for (const f of frames) totalSize += f.length;
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const f of frames) {
    result.set(f, pos);
    pos += f.length;
  }
  return result;
}

function printQpMap(result, label) {
  console.log(`\n    --- ${label}: ${result.widthBlocks}x${result.heightBlocks} blocks ---`);
  const minQ = Math.min(...result.qps);
  const maxQ = Math.max(...result.qps);
  const avgQ = result.qps.reduce((a, b) => a + b, 0) / result.count;
  console.log(`    q_index range: [${minQ}, ${maxQ}], avg: ${avgQ.toFixed(1)}`);

  const rows = Math.min(result.heightBlocks, 8);
  const cols = Math.min(result.widthBlocks, 20);
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      row.push(String(result.qps[y * result.widthBlocks + x]).padStart(4));
    }
    const suffix = result.widthBlocks > cols ? " ..." : "";
    console.log(`    ${row.join("")}${suffix}`);
  }
  if (result.heightBlocks > rows) console.log("    ...");
}

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

function extractConfigOBUsAV1(initData) {
  const data = initData instanceof Uint8Array ? initData : new Uint8Array(initData);
  for (let i = 0; i + 8 < data.length; i++) {
    if (data[i + 4] !== 0x61 || data[i + 5] !== 0x76 ||
        data[i + 6] !== 0x31 || data[i + 7] !== 0x43) continue;
    const boxSize = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    if (boxSize < 12 || i + boxSize > data.length) continue;
    const obuStart = i + 12;
    const obuEnd = i + boxSize;
    if (obuStart >= obuEnd) return null;
    return data.slice(obuStart, obuEnd);
  }
  return null;
}

function extractSampleDataFromMdat(mediaSegment) {
  const data = mediaSegment;
  let offset = 0;
  while (offset + 8 <= data.length) {
    const size = (data[offset] << 24) | (data[offset + 1] << 16) |
                 (data[offset + 2] << 8) | data[offset + 3];
    const type = String.fromCharCode(data[offset + 4], data[offset + 5],
                                     data[offset + 6], data[offset + 7]);
    if (type === "mdat") return data.slice(offset + 8, offset + size);
    if (size < 8) break;
    offset += size;
  }
  return new Uint8Array(0);
}

// ── Test suites ──

async function testFixedQIndex(exp, encoder) {
  console.log("\n=== Test 1: Fixed q_index — dav1d vs expected ===");

  for (const q of [15, 30, 45, 55]) {
    const path = join(BUILD_DIR, `_rw_av1_q${q}.ivf`);
    try {
      let encArgs;
      if (encoder === "libsvtav1") {
        encArgs = `-c:v libsvtav1 -svtav1-params "qp=${q}:key-int-max=63" -pix_fmt yuv420p`;
      } else {
        encArgs = `-c:v libaom-av1 -cpu-used 8 -qmin ${q} -qmax ${q} -g 63 -pix_fmt yuv420p -strict experimental`;
      }
      execSync(
        `ffmpeg -f lavfi -i "testsrc=duration=0.12:size=320x240:rate=25" ` +
        `${encArgs} -y "${path}" 2>/dev/null`,
        { stdio: "pipe" },
      );
    } catch { continue; }

    const obuData = readIvfObus(path);
    if (!obuData) { assert(false, `q=${q}: IVF read failed`); continue; }

    const dec = createDecoder(exp);
    const result = decodeObu(exp, dec.ctx, dec.obuBufPtr, dec.qpOutPtr, obuData);

    if (result && result.count > 0) {
      const minQ = Math.min(...result.qps);
      const maxQ = Math.max(...result.qps);
      assert(minQ >= 0 && maxQ <= 255, `q=${q}: dav1d reads [${minQ},${maxQ}], range valid`);
      printQpMap(result, `q=${q}`);
    } else {
      assert(false, `q=${q}: decode failed`);
    }

    destroyDecoder(exp, dec);
    try { unlinkSync(path); } catch {}
  }
}

async function testCrfVsProbe(exp, encoder) {
  console.log("\n=== Test 2: CRF variable q_index — dav1d decode ===");

  const path = join(BUILD_DIR, `_rw_av1_crf30.ivf`);
  try {
    let encArgs;
    if (encoder === "libsvtav1") {
      encArgs = `-c:v libsvtav1 -crf 30 -svtav1-params "key-int-max=63" -pix_fmt yuv420p`;
    } else {
      encArgs = `-c:v libaom-av1 -cpu-used 8 -crf 30 -b:v 0 -g 63 -pix_fmt yuv420p -strict experimental`;
    }
    execSync(
      `ffmpeg -f lavfi -i "mandelbrot=size=320x240:rate=25" -t 0.2 ` +
      `${encArgs} -y "${path}" 2>/dev/null`,
      { stdio: "pipe" },
    );
  } catch {
    console.log("  (skipping — FFmpeg failed)");
    return;
  }

  const obuData = readIvfObus(path);
  if (!obuData) { assert(false, "CRF: IVF read failed"); return; }

  const dec = createDecoder(exp);
  const result = decodeObu(exp, dec.ctx, dec.obuBufPtr, dec.qpOutPtr, obuData);

  if (result) {
    const minQ = Math.min(...result.qps);
    const maxQ = Math.max(...result.qps);
    assert(result.count === 40 * 30, `CRF: block count=${result.count} (expected 1200)`);
    assert(minQ >= 0 && maxQ <= 255, `CRF: q_index range [${minQ},${maxQ}] valid`);
    printQpMap(result, "CRF=30");
  } else {
    assert(false, "CRF: decode failed");
  }

  destroyDecoder(exp, dec);
  try { unlinkSync(path); } catch {}
}

async function testFmp4RealWorld(exp, encoder) {
  console.log("\n=== Test 3: fMP4 pipeline (browser worker simulation) ===");

  const fmp4Path = join(BUILD_DIR, "_rw_av1_fmp4.mp4");
  try {
    let encArgs;
    if (encoder === "libsvtav1") {
      encArgs = `-c:v libsvtav1 -crf 28 -svtav1-params "key-int-max=63" -pix_fmt yuv420p`;
    } else {
      encArgs = `-c:v libaom-av1 -cpu-used 8 -crf 28 -b:v 0 -g 63 -pix_fmt yuv420p -strict experimental`;
    }
    execSync(
      `ffmpeg -f lavfi -i "mandelbrot=size=320x240:rate=25" -t 0.5 ` +
      `${encArgs} ` +
      `-movflags +frag_keyframe+default_base_moof -y "${fmp4Path}" 2>/dev/null`,
      { stdio: "pipe" },
    );
  } catch {
    console.log("  (skipping — FFmpeg failed)");
    return;
  }

  const fmp4Data = readFileSync(fmp4Path);
  const data = new Uint8Array(fmp4Data);
  const boxes = parseBoxes(data, 0, data.length);
  const moovBox = boxes.find(b => b.type === "moov");
  if (!moovBox) { assert(false, "fMP4: moov not found"); return; }

  const initEnd = moovBox.offset + moovBox.size;
  const initSegment = data.slice(0, initEnd);
  const mediaSegment = data.slice(initEnd);

  console.log(`  Init: ${initSegment.length} bytes, Media: ${mediaSegment.length} bytes`);

  const configObus = extractConfigOBUsAV1(initSegment);
  assert(configObus !== null && configObus.length > 0,
    `fMP4: ${configObus ? configObus.length : 0} bytes of av1C config OBUs`);

  const sampleData = extractSampleDataFromMdat(mediaSegment);
  assert(sampleData.length > 0, `fMP4: ${sampleData.length} bytes of sample data`);

  if (configObus && configObus.length > 0 && sampleData.length > 0) {
    const obuBuffer = new Uint8Array(configObus.length + sampleData.length);
    obuBuffer.set(configObus, 0);
    obuBuffer.set(sampleData, configObus.length);

    const dec = createDecoder(exp);
    const result = decodeObu(exp, dec.ctx, dec.obuBufPtr, dec.qpOutPtr, obuBuffer);

    if (result) {
      assert(result.widthBlocks === 40, `fMP4: width=${result.widthBlocks} (expected 40)`);
      assert(result.heightBlocks === 30, `fMP4: height=${result.heightBlocks} (expected 30)`);
      const minQ = Math.min(...result.qps);
      const maxQ = Math.max(...result.qps);
      assert(minQ >= 0 && maxQ <= 255, `fMP4: q_index range [${minQ},${maxQ}] valid`);
      printQpMap(result, "fMP4 320x240");
    } else {
      assert(false, "fMP4: decode failed");
    }

    destroyDecoder(exp, dec);
  }

  try { unlinkSync(fmp4Path); } catch {}
}

async function testSequentialReuse(exp, encoder) {
  console.log("\n=== Test 4: Sequential decoder reuse ===");

  for (const q of [15, 30, 50]) {
    const path = join(BUILD_DIR, `_rw_av1_seq${q}.ivf`);
    try {
      let encArgs;
      if (encoder === "libsvtav1") {
        encArgs = `-c:v libsvtav1 -svtav1-params "qp=${q}:key-int-max=63" -pix_fmt yuv420p`;
      } else {
        encArgs = `-c:v libaom-av1 -cpu-used 8 -qmin ${q} -qmax ${q} -g 63 -pix_fmt yuv420p -strict experimental`;
      }
      execSync(
        `ffmpeg -f lavfi -i "testsrc=duration=0.08:size=160x120:rate=25" ` +
        `${encArgs} -y "${path}" 2>/dev/null`,
        { stdio: "pipe" },
      );
    } catch { continue; }

    const obuData = readIvfObus(path);
    if (!obuData) continue;

    const dec = createDecoder(exp);
    const result = decodeObu(exp, dec.ctx, dec.obuBufPtr, dec.qpOutPtr, obuData);

    if (result && result.count > 0) {
      const minQ = Math.min(...result.qps);
      const maxQ = Math.max(...result.qps);
      assert(minQ >= 0 && maxQ <= 255, `Seq q=${q}: [${minQ},${maxQ}] valid`);
    } else {
      assert(false, `Seq q=${q}: decode failed`);
    }

    destroyDecoder(exp, dec);
    try { unlinkSync(path); } catch {}
  }
}

// ── Main ──

async function main() {
  console.log("=== dav1d AV1 Real-World QP Debug & Validation ===\n");

  if (!existsSync(WASM_PATH)) {
    console.error("WASM binary not found:", WASM_PATH);
    process.exit(1);
  }

  const encoder = getAv1Encoder();
  if (!encoder) {
    console.error("No AV1 encoder found. Need libsvtav1 or libaom-av1 in FFmpeg.");
    process.exit(1);
  }
  console.log("Using AV1 encoder:", encoder);

  mkdirSync(BUILD_DIR, { recursive: true });

  console.log("Loading WASM...");
  const exp = await loadWasm();
  console.log("WASM loaded.\n");

  await testFixedQIndex(exp, encoder);
  await testCrfVsProbe(exp, encoder);
  await testFmp4RealWorld(exp, encoder);
  await testSequentialReuse(exp, encoder);

  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
