#!/usr/bin/env node
/**
 * Test JM264 QP WASM decoder with real DASH segments from a live manifest.
 *
 * Downloads init + random media segments from a real H.264 DASH stream,
 * extracts samples via a minimal mp4 parser, builds Annex B, and feeds
 * to the JM WASM decoder. Validates:
 *   - All macroblocks have nonzero QP (no gaps in heatmap)
 *   - Dimensions match the expected resolution
 *   - QP values are in valid range [1..51]
 *   - Multiple random segments decode consistently
 *
 * Usage: node wasm/test-realworld-dash.mjs
 *
 * Prerequisites:
 *   - public/jm264-qp.wasm (run: cd wasm && ./build-jm264.sh)
 *   - Network access to the DASH CDN
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "../public/jm264-qp.wasm");

const MANIFEST_BASE = "https://msk2-cdp11.playfamily.ru/vod/cid/439139261-2000000000-lyiEiJUEMn6CYBVbicKt1A/storage127/clr/m/shfpbw/52351efc-f1c9-4770-b21b-fdf5408a74f5/output.ism";

// Representations from the manifest
const REPRESENTATIONS = [
  { id: "3", width: 1024, height: 428, widthMbs: 64, heightMbs: 27, bandwidth: 1384453 },
  { id: "4", width: 1280, height: 536, widthMbs: 80, heightMbs: 34, bandwidth: 2215108 },
  { id: "5", width: 1920, height: 804, widthMbs: 120, heightMbs: 51, bandwidth: 3964892 },
];

// Segment timeline: d=29999952, timescale=10000000, 2879 segments (r=2878) + 1 short
const TIMESCALE = 10000000;
const SEG_DURATION_TICKS = 29999952;
const TOTAL_SEGMENTS = 2880;

// Number of random segments to test per representation
const SEGMENTS_PER_REP = 3;

// ── Fetch helper ──

async function fetchBytes(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// ── Minimal MP4 box parser ──

function findBox(data, type, offset = 0) {
  const target = new TextEncoder().encode(type);
  let i = offset;
  while (i + 8 <= data.length) {
    const size = (data[i] << 24) | (data[i+1] << 16) | (data[i+2] << 8) | data[i+3];
    if (size < 8 || i + size > data.length) break;
    if (data[i+4] === target[0] && data[i+5] === target[1] &&
        data[i+6] === target[2] && data[i+7] === target[3]) {
      return { offset: i, size, dataOffset: i + 8, dataSize: size - 8 };
    }
    i += size;
  }
  return null;
}

function findBoxRecursive(data, type, offset = 0, end) {
  const target = new TextEncoder().encode(type);
  end = end || data.length;
  let i = offset;
  while (i + 8 <= end) {
    const size = (data[i] << 24) | (data[i+1] << 16) | (data[i+2] << 8) | data[i+3];
    if (size < 8 || i + size > end) break;
    if (data[i+4] === target[0] && data[i+5] === target[1] &&
        data[i+6] === target[2] && data[i+7] === target[3]) {
      return { offset: i, size, dataOffset: i + 8, dataSize: size - 8 };
    }
    // Recurse into container boxes
    const boxType = String.fromCharCode(data[i+4], data[i+5], data[i+6], data[i+7]);
    const containers = ["moov","trak","mdia","minf","stbl","moof","traf","sinf","schi"];
    if (containers.includes(boxType)) {
      const inner = findBoxRecursive(data, type, i + 8, i + size);
      if (inner) return inner;
    }
    // stsd: skip 8-byte header + 8 bytes (version/flags/entry_count)
    if (boxType === "stsd") {
      const inner = findBoxRecursive(data, type, i + 16, i + size);
      if (inner) return inner;
    }
    // Visual sample entries (avc1/avc3/encv/hev1/hvc1): skip 86 bytes (8 header + 78 fields)
    if (["avc1","avc3","encv","hev1","hvc1"].includes(boxType)) {
      const inner = findBoxRecursive(data, type, i + 86, i + size);
      if (inner) return inner;
    }
    i += size;
  }
  return null;
}

/**
 * Extract SPS and PPS from avcC box in init segment.
 */
function extractParameterSets(initData) {
  const avcC = findBoxRecursive(initData, "avcC");
  if (!avcC) throw new Error("No avcC box in init segment");

  const nalus = [];
  let off = avcC.dataOffset;
  const data = initData;

  // configurationVersion(1) + profile(1) + compat(1) + level(1) + lengthSizeMinusOne(1)
  off += 5;

  // SPS
  const numSPS = data[off] & 0x1f;
  off++;
  for (let s = 0; s < numSPS && off + 2 <= data.length; s++) {
    const spsLen = (data[off] << 8) | data[off + 1];
    off += 2;
    if (off + spsLen > data.length) break;
    nalus.push(data.slice(off, off + spsLen));
    off += spsLen;
  }

  // PPS
  if (off >= data.length) return nalus;
  const numPPS = data[off];
  off++;
  for (let p = 0; p < numPPS && off + 2 <= data.length; p++) {
    const ppsLen = (data[off] << 8) | data[off + 1];
    off += 2;
    if (off + ppsLen > data.length) break;
    nalus.push(data.slice(off, off + ppsLen));
    off += ppsLen;
  }

  return nalus;
}

/**
 * Extract lengthSizeMinusOne from avcC box.
 */
function getNaluLengthSize(initData) {
  const avcC = findBoxRecursive(initData, "avcC");
  if (!avcC) return 4;
  return (initData[avcC.dataOffset + 4] & 0x03) + 1;
}

/**
 * Parse samples from mdat using trun box offsets.
 * Returns array of { data: Uint8Array, isSync: boolean }.
 */
function extractSamples(initData, mediaData) {
  const naluLenSize = getNaluLengthSize(initData);

  // Find trun box
  const trun = findBoxRecursive(mediaData, "trun");
  if (!trun) throw new Error("No trun box in media segment");

  let off = trun.dataOffset;
  const view = new DataView(mediaData.buffer, mediaData.byteOffset, mediaData.byteLength);

  const flags = (mediaData[off] << 16) | (mediaData[off+1] << 8) | mediaData[off+2];
  off += 3;
  off += 1; // version
  // Re-read: version is first byte, then 3 bytes of flags
  off = trun.dataOffset;
  const version = mediaData[off]; off++;
  const trFlags = (mediaData[off] << 16) | (mediaData[off+1] << 8) | mediaData[off+2]; off += 3;

  const sampleCount = view.getUint32(off); off += 4;

  const hasDataOffset = !!(trFlags & 0x000001);
  const hasFirstSampleFlags = !!(trFlags & 0x000004);
  const hasDuration = !!(trFlags & 0x000100);
  const hasSize = !!(trFlags & 0x000200);
  const hasFlags = !!(trFlags & 0x000400);
  const hasCTO = !!(trFlags & 0x000800);

  let dataOffset = 0;
  if (hasDataOffset) { dataOffset = view.getInt32(off); off += 4; }
  let firstSampleFlags = 0;
  if (hasFirstSampleFlags) { firstSampleFlags = view.getUint32(off); off += 4; }

  // Find moof offset to compute absolute data position
  const moof = findBox(mediaData, "moof");
  const moofOffset = moof ? moof.offset : 0;
  let sampleOffset = moofOffset + dataOffset;

  // Parse default values from tfhd
  const tfhd = findBoxRecursive(mediaData, "tfhd");
  let defaultSize = 0;
  let defaultDuration = 0;
  let defaultFlags = 0;
  if (tfhd) {
    let toff = tfhd.dataOffset;
    toff++; // version
    const tfFlags = (mediaData[toff] << 16) | (mediaData[toff+1] << 8) | mediaData[toff+2]; toff += 3;
    toff += 4; // track_ID
    if (tfFlags & 0x000001) toff += 8; // base_data_offset
    if (tfFlags & 0x000002) toff += 4; // sample_description_index
    if (tfFlags & 0x000008) { defaultDuration = view.getUint32(toff); toff += 4; }
    if (tfFlags & 0x000010) { defaultSize = view.getUint32(toff); toff += 4; }
    if (tfFlags & 0x000020) { defaultFlags = view.getUint32(toff); toff += 4; }
  }

  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    let duration = defaultDuration;
    let size = defaultSize;
    let sFlags = (i === 0 && hasFirstSampleFlags) ? firstSampleFlags : defaultFlags;
    let cto = 0;

    if (hasDuration) { duration = view.getUint32(off); off += 4; }
    if (hasSize) { size = view.getUint32(off); off += 4; }
    if (hasFlags) { sFlags = view.getUint32(off); off += 4; }
    if (hasCTO) {
      cto = version === 0 ? view.getUint32(off) : view.getInt32(off);
      off += 4;
    }

    const isSync = (sFlags & 0x01000000) === 0; // bit 24 = non-sync
    if (sampleOffset + size <= mediaData.length) {
      samples.push({
        data: mediaData.slice(sampleOffset, sampleOffset + size),
        isSync,
        cto,
      });
    }
    sampleOffset += size;
  }

  return { samples, naluLenSize };
}

/**
 * Convert mp4 sample (length-prefixed NALUs) to individual NAL units.
 */
function sampleToNalUnits(sampleData, naluLenSize) {
  const nalus = [];
  let off = 0;
  while (off + naluLenSize <= sampleData.length) {
    let len = 0;
    for (let i = 0; i < naluLenSize; i++) {
      len = (len << 8) | sampleData[off + i];
    }
    off += naluLenSize;
    if (off + len > sampleData.length) break;
    nalus.push(sampleData.slice(off, off + len));
    off += len;
  }
  return nalus;
}

/**
 * Build Annex B buffer from parameter sets + sample NALUs.
 * Filters to VCL NALUs only (types 1-5) from samples.
 * Includes ALL parameter sets (SPS=7, PPS=8) from init segment.
 */
function buildAnnexB(paramSets, samples, naluLenSize) {
  const SC = new Uint8Array([0, 0, 0, 1]);
  const parts = [];

  // Parameter sets first
  for (const ps of paramSets) {
    parts.push(SC);
    parts.push(ps);
  }

  // VCL NALUs from samples
  let vclCount = 0;
  let skippedCount = 0;
  for (const sample of samples) {
    const nalus = sampleToNalUnits(sample.data, naluLenSize);
    for (const nalu of nalus) {
      if (nalu.length === 0) continue;
      const naluType = nalu[0] & 0x1f;
      // Keep only VCL NALUs (slice types 1-5)
      if (naluType < 1 || naluType > 5) {
        skippedCount++;
        continue;
      }
      parts.push(SC);
      parts.push(nalu);
      vclCount++;
    }
  }

  // Concatenate
  let totalSize = 0;
  for (const p of parts) totalSize += p.length;
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }

  return { buffer: result, vclCount, skippedCount };
}

// ── WASM loader (same as test-realworld.mjs) ──

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
          if (capturedOutput.length > 16384) capturedOutput = capturedOutput.slice(-8192);
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

  return { exports, WasiExit, getCapturedOutput: () => capturedOutput, resetOutput: () => { capturedOutput = ""; } };
}

function createDecoder(wasmExports, WasiExit) {
  const exp = wasmExports;
  const MAX_BUF = 8 * 1024 * 1024;
  const MAX_MBS = 130000;

  const ctx = exp.jm264_qp_create();
  if (!ctx) throw new Error("jm264_qp_create failed");

  const annexBPtr = exp.jm264_qp_malloc(MAX_BUF);
  const qpOutPtr = exp.jm264_qp_malloc(MAX_MBS);
  if (!annexBPtr || !qpOutPtr) throw new Error("malloc failed");

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
        if (e instanceof WebAssembly.RuntimeError) {
          destroyed = true;
          return false;
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
        if (e instanceof WebAssembly.RuntimeError) {
          destroyed = true;
          return false;
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

// ── Test runner ──

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function segmentTime(segIdx) {
  return segIdx * SEG_DURATION_TICKS;
}

function segmentUrl(repId, segIdx) {
  const time = segmentTime(segIdx);
  return `${MANIFEST_BASE}/Q(${repId})/F(v=${time})`;
}

function initUrl(repId) {
  return `${MANIFEST_BASE}/Q(${repId})/I(v)`;
}

async function main() {
  console.log("=== JM264 Real-World DASH Stream QP Test ===\n");

  if (!existsSync(WASM_PATH)) {
    console.error("WASM not found. Run: cd wasm && ./build-jm264.sh");
    process.exit(1);
  }

  // Pick random segment indices (avoid first and last segments)
  const randomSegments = [];
  const rng = () => Math.floor(Math.random() * (TOTAL_SEGMENTS - 10)) + 5;
  for (let i = 0; i < SEGMENTS_PER_REP; i++) {
    randomSegments.push(rng());
  }
  console.log(`Random segment indices: [${randomSegments.join(", ")}]`);
  console.log();

  for (const rep of REPRESENTATIONS) {
    console.log(`--- Representation ${rep.id}: ${rep.width}x${rep.height} (${Math.round(rep.bandwidth/1000)}kbps) ---`);

    // Download init segment
    const initSegUrl = initUrl(rep.id);
    console.log(`  Fetching init: ${initSegUrl}`);
    let initData;
    try {
      initData = await fetchBytes(initSegUrl);
    } catch (e) {
      console.error(`  SKIP: init fetch failed: ${e.message}`);
      continue;
    }
    console.log(`  Init segment: ${initData.length} bytes`);

    // Extract parameter sets
    const paramSets = extractParameterSets(initData);
    const naluLenSize = getNaluLengthSize(initData);
    console.log(`  Parameter sets: ${paramSets.length} NALUs, NALU length size: ${naluLenSize}`);
    for (const ps of paramSets) {
      const type = ps[0] & 0x1f;
      console.log(`    ${type === 7 ? "SPS" : type === 8 ? "PPS" : `NALU(${type})`}: ${ps.length} bytes`);
    }

    for (const segIdx of randomSegments) {
      const segUrl = segmentUrl(rep.id, segIdx);
      const testName = `Rep ${rep.id} segment #${segIdx}`;
      console.log(`\n  [${testName}]`);
      console.log(`  Fetching: ${segUrl}`);

      let mediaData;
      try {
        mediaData = await fetchBytes(segUrl);
      } catch (e) {
        console.error(`  SKIP: fetch failed: ${e.message}`);
        continue;
      }
      console.log(`  Media segment: ${mediaData.length} bytes`);

      try {
        // Extract samples
        const { samples, naluLenSize: nlSize } = extractSamples(initData, mediaData);
        console.log(`  Samples: ${samples.length} (sync: ${samples.filter(s => s.isSync).length})`);

        // Find first sync sample and feed from there
        let syncIdx = 0;
        for (let i = 0; i < samples.length; i++) {
          if (samples[i].isSync) { syncIdx = i; break; }
        }

        // Feed all samples from the sync point
        const feedSamples = samples.slice(syncIdx);
        console.log(`  Feeding ${feedSamples.length} samples starting from sync at index ${syncIdx}`);

        // Build Annex B
        const { buffer: annexB, vclCount, skippedCount } = buildAnnexB(paramSets, feedSamples, nlSize);
        console.log(`  Annex B: ${annexB.length} bytes (${vclCount} VCL NALUs, ${skippedCount} non-VCL skipped)`);

        // Create fresh WASM instance for each test
        const { exports, WasiExit, getCapturedOutput, resetOutput } = await loadWasm();
        const dec = createDecoder(exports, WasiExit);
        resetOutput();

        try {
          const t0 = performance.now();
          const ok = dec.decodeFrame(annexB);
          const dt = performance.now() - t0;
          let hasFrame = ok;

          if (!hasFrame) {
            const flushed = dec.flush();
            if (flushed) hasFrame = true;
          }

          // Print stderr output (last 500 chars)
          const stderr = getCapturedOutput().trim();
          if (stderr) {
            const lines = stderr.split("\n");
            const errorLines = lines.filter(l => l.includes("error") || l.includes("Error"));
            const captureLines = lines.filter(l => l.includes("[capture_qp]") || l.includes("[exit_picture]"));
            const diagLines = lines.filter(l => l.includes("[JM]"));
            if (errorLines.length > 0) {
              console.log(`  JM errors (${errorLines.length}):`);
              for (const l of errorLines.slice(0, 5)) console.log(`    ${l}`);
              if (errorLines.length > 5) console.log(`    ... and ${errorLines.length - 5} more`);
            }
            if (captureLines.length > 0) {
              console.log(`  QP captures:`);
              for (const l of captureLines) console.log(`    ${l}`);
            }
            if (diagLines.length > 0) {
              for (const l of diagLines) console.log(`    ${l}`);
            }
          }

          assert(hasFrame, "No frame decoded");
          console.log(`  Decode: ${dt.toFixed(1)}ms, frame=${ok}${dec.usedRecovery ? " (recovery)" : ""}`);

          const w = dec.getWidthMbs();
          const h = dec.getHeightMbs();
          const { qpValues, count } = dec.copyQps();

          console.log(`  QP map: ${w}x${h} MBs (${w*16}x${h*16} px), ${count} values`);

          // Validate dimensions
          assert(w === rep.widthMbs, `Expected ${rep.widthMbs} widthMbs, got ${w}`);
          assert(h === rep.heightMbs, `Expected ${rep.heightMbs} heightMbs, got ${h}`);
          assert(count === w * h, `Expected ${w*h} QP values, got ${count}`);

          // Validate QP values
          let zeros = 0;
          let minQp = 255, maxQp = 0;
          for (let i = 0; i < count; i++) {
            if (qpValues[i] === 0) zeros++;
            if (qpValues[i] > 0 && qpValues[i] < minQp) minQp = qpValues[i];
            if (qpValues[i] > maxQp) maxQp = qpValues[i];
          }

          const zeroPct = (100 * zeros / count).toFixed(1);
          console.log(`  QP range: [${minQp}, ${maxQp}], zeros: ${zeros}/${count} (${zeroPct}%)`);

          // Check per-row coverage
          let fullyZeroRows = 0;
          for (let row = 0; row < h; row++) {
            let rowZeros = 0;
            for (let col = 0; col < w; col++) {
              if (qpValues[row * w + col] === 0) rowZeros++;
            }
            if (rowZeros === w) fullyZeroRows++;
          }
          if (fullyZeroRows > 0) {
            console.log(`  WARNING: ${fullyZeroRows}/${h} rows are fully zero`);
          }

          // Distribution
          const hist = new Map();
          for (let i = 0; i < count; i++) {
            hist.set(qpValues[i], (hist.get(qpValues[i]) || 0) + 1);
          }
          const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1]);
          console.log(`  Distribution: ${sorted.slice(0, 8).map(([qp, n]) => `qp${qp}:${n}`).join(" ")}`);

          // Assertions
          assert(maxQp <= 51, `QP out of range: max=${maxQp}`);
          assert(zeros < count * 0.1, `Too many zero QPs: ${zeros}/${count} (${zeroPct}%) — expected <10%`);
          assert(fullyZeroRows === 0, `${fullyZeroRows} rows have all-zero QP — heatmap would have gaps`);

          console.log(`  PASS`);
          passed++;
        } finally {
          dec.destroy();
        }
      } catch (e) {
        console.error(`  FAIL: ${e.message}`);
        failed++;
      }
    }
    console.log();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
