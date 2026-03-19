#!/usr/bin/env node
/**
 * ProRes WASM decoder benchmark.
 *
 * Compares WASM builds by decoding the same frame repeatedly.
 *
 * Usage:
 *   node wasm/bench-prores.mjs                              # default WASM + local fixture
 *   node wasm/bench-prores.mjs /tmp/prores-O3.wasm          # specific WASM build
 *   node wasm/bench-prores.mjs --url http://host/file.mov   # real-world 1080p from network
 *   node wasm/bench-prores.mjs --iterations 50              # more iterations
 *
 * Reports: min / median / avg / p95 / max / fps
 */

import { readFileSync, statSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Argument parsing ---

const args = process.argv.slice(2);
let wasmPath = resolve(__dirname, "../public/prores-decoder.wasm");
let movUrl = null;
let frameIndex = 0;
let iterations = 20;
let warmup = 3;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--url") {
    movUrl = args[++i];
  } else if (arg === "--frame-index") {
    frameIndex = parseInt(args[++i]);
  } else if (arg === "--iterations") {
    iterations = parseInt(args[++i]);
  } else if (arg === "--warmup") {
    warmup = parseInt(args[++i]);
  } else if (arg === "--help" || arg === "-h") {
    console.log(
      "Usage: node bench-prores.mjs [wasm-path] [--url URL] [--frame-index N] [--iterations N]"
    );
    process.exit(0);
  } else if (!arg.startsWith("--")) {
    wasmPath = resolve(arg);
  }
}

// --- MOV parsing ---

function parseMoovBoxes(buf, start, end) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let codecTag = "";
  let width = 0,
    height = 0;
  let sampleSizes = [];
  let chunkOffsets = [];
  let isVideoTrack = false;
  const proresTags = ["apch", "apcn", "apcs", "apco", "ap4h", "ap4x"];

  function walk(s, e) {
    let p = s;
    while (p + 8 <= e) {
      let sz = view.getUint32(p);
      const tp = String.fromCharCode(
        buf[p + 4],
        buf[p + 5],
        buf[p + 6],
        buf[p + 7]
      );
      if (sz < 8) break;
      if (sz === 1 && p + 16 <= e) {
        sz = view.getUint32(p + 8) * 0x100000000 + view.getUint32(p + 12);
      }
      const nextP = p + sz;

      if (tp === "trak") {
        isVideoTrack = false;
      }

      if (["moov", "trak", "mdia", "minf", "stbl", "dinf"].includes(tp)) {
        walk(p + 8, Math.min(nextP, e));
      }

      if (tp === "stsd" && p + 8 + 4 + 4 + 8 <= e) {
        const es = p + 8 + 4 + 4;
        const tag = String.fromCharCode(
          buf[es + 4],
          buf[es + 5],
          buf[es + 6],
          buf[es + 7]
        );
        if (proresTags.includes(tag)) {
          isVideoTrack = true;
          codecTag = tag;
          width = view.getUint16(es + 32);
          height = view.getUint16(es + 34);
        }
      }

      if (tp === "stsz" && isVideoTrack) {
        const fb = p + 8;
        const sampleSize = view.getUint32(fb + 4);
        const count = view.getUint32(fb + 8);
        sampleSizes = [];
        for (let j = 0; j < count; j++) {
          sampleSizes.push(
            sampleSize === 0 ? view.getUint32(fb + 12 + j * 4) : sampleSize
          );
        }
      }

      if (tp === "stco" && isVideoTrack) {
        const fb = p + 8;
        const count = view.getUint32(fb + 4);
        chunkOffsets = [];
        for (let j = 0; j < count; j++) {
          chunkOffsets.push(view.getUint32(fb + 8 + j * 4));
        }
      }

      if (tp === "co64" && isVideoTrack) {
        const fb = p + 8;
        const count = view.getUint32(fb + 4);
        chunkOffsets = [];
        for (let j = 0; j < count; j++) {
          chunkOffsets.push(
            view.getUint32(fb + 8 + j * 8) * 0x100000000 +
              view.getUint32(fb + 8 + j * 8 + 4)
          );
        }
      }

      p = nextP;
    }
  }

  walk(start, end);
  return { codecTag, width, height, sampleSizes, chunkOffsets };
}

function extractFrameLocal(movPath, idx) {
  const buf = readFileSync(movPath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  let moovStart = -1,
    moovEnd = -1;

  while (pos + 8 <= buf.length) {
    let boxSize = view.getUint32(pos);
    const boxType = String.fromCharCode(
      buf[pos + 4],
      buf[pos + 5],
      buf[pos + 6],
      buf[pos + 7]
    );
    if (boxSize === 1 && pos + 16 <= buf.length) {
      boxSize =
        view.getUint32(pos + 8) * 0x100000000 + view.getUint32(pos + 12);
    }
    if (boxSize < 8) break;
    if (boxType === "moov") {
      moovStart = pos + 8;
      moovEnd = pos + boxSize;
    }
    pos += boxSize;
  }
  if (moovStart < 0) throw new Error("moov not found in local MOV");

  const { codecTag, width, height, sampleSizes, chunkOffsets } =
    parseMoovBoxes(buf, moovStart, moovEnd);
  if (idx >= sampleSizes.length)
    throw new Error(`Frame ${idx} out of range (${sampleSizes.length} frames)`);
  if (idx >= chunkOffsets.length)
    throw new Error(
      `Frame ${idx}: no chunk offset (${chunkOffsets.length} chunks)`
    );

  const offset = chunkOffsets[idx];
  const size = sampleSizes[idx];
  const frameData = buf.slice(offset, offset + size);

  return { frameData, width, height, codecTag, frameCount: sampleSizes.length };
}

async function fetchFrameRemote(url, idx) {
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD failed: ${head.status}`);
  const fileSize = parseInt(head.headers.get("content-length"));
  console.log(`Remote file: ${(fileSize / 1073741824).toFixed(2)} GB`);

  // Scan top-level boxes to find moov
  let pos = 0;
  let moovOffset = -1,
    moovSize = -1;
  while (pos < fileSize) {
    const resp = await fetch(url, {
      headers: { Range: `bytes=${pos}-${pos + 15}` },
    });
    const hdr = new Uint8Array(await resp.arrayBuffer());
    const hv = new DataView(hdr.buffer);
    let boxSize = hv.getUint32(0);
    const boxType = String.fromCharCode(...hdr.slice(4, 8));
    if (boxSize === 1 && hdr.length >= 16) {
      boxSize = hv.getUint32(8) * 0x100000000 + hv.getUint32(12);
    }
    if (boxSize < 8) throw new Error(`Invalid box at ${pos}`);
    console.log(`  box: ${boxType}  offset=${pos}  size=${boxSize}`);
    if (boxType === "moov") {
      moovOffset = pos;
      moovSize = boxSize;
      break;
    }
    pos += boxSize;
  }
  if (moovOffset < 0) throw new Error("moov atom not found");

  console.log(`Fetching moov (${(moovSize / 1024).toFixed(0)} KB)...`);
  const moovResp = await fetch(url, {
    headers: { Range: `bytes=${moovOffset}-${moovOffset + moovSize - 1}` },
  });
  const moovBuf = new Uint8Array(await moovResp.arrayBuffer());

  const { codecTag, width, height, sampleSizes, chunkOffsets } =
    parseMoovBoxes(moovBuf, 8, moovSize);
  if (idx >= sampleSizes.length)
    throw new Error(`Frame ${idx} out of range (${sampleSizes.length} frames)`);
  if (idx >= chunkOffsets.length)
    throw new Error(`Frame ${idx}: no chunk offset`);

  const offset = chunkOffsets[idx];
  const size = sampleSizes[idx];
  console.log(
    `Frame ${idx}: offset=${offset}, size=${(size / 1024).toFixed(1)} KB`
  );

  const frameResp = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + size - 1}` },
  });
  const frameData = new Uint8Array(await frameResp.arrayBuffer());

  return { frameData, width, height, codecTag, frameCount: sampleSizes.length };
}

// --- WASM loader ---

class WasiExit {
  constructor(code) {
    this.code = code;
  }
}

async function loadWasm(path) {
  const bytes = readFileSync(path);
  const mod = await WebAssembly.compile(bytes);
  let mem;
  const getView = () => new DataView(mem.buffer);

  const instance = await WebAssembly.instantiate(mod, {
    env: {
      emscripten_notify_memory_growth: () => {},
      __main_argc_argv: () => 0,
    },
    wasi_snapshot_preview1: {
      args_sizes_get: (a, b) => {
        const v = getView();
        v.setUint32(a, 0, true);
        v.setUint32(b, 0, true);
        return 0;
      },
      args_get: () => 0,
      environ_sizes_get: (a, b) => {
        const v = getView();
        v.setUint32(a, 0, true);
        v.setUint32(b, 0, true);
        return 0;
      },
      environ_get: () => 0,
      proc_exit: (code) => {
        throw new WasiExit(code);
      },
      fd_close: () => 0,
      fd_read: () => 0,
      fd_write: (_fd, iovs, iovsLen, nPtr) => {
        const v = getView();
        let total = 0;
        for (let i = 0; i < iovsLen; i++)
          total += v.getUint32(iovs + i * 8 + 4, true);
        v.setUint32(nPtr, total, true);
        return 0;
      },
      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      clock_time_get: () => 0,
    },
  });

  mem = instance.exports.memory;
  try {
    instance.exports._start();
  } catch (e) {
    if (!(e instanceof WasiExit)) throw e;
  }

  return { exports: instance.exports, memory: mem };
}

// --- Statistics ---

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const n = sorted.length;
  const median =
    n % 2 === 0
      ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : sorted[Math.floor(n / 2)];
  const p95idx = Math.min(Math.ceil(n * 0.95) - 1, n - 1);
  return {
    min: sorted[0],
    median,
    avg: sum / n,
    p95: sorted[p95idx],
    max: sorted[n - 1],
    fps: 1000 / median,
  };
}

// --- Main ---

async function main() {
  const wasmSize = statSync(wasmPath).size;
  console.log(`\n=== ProRes WASM Benchmark ===`);
  console.log(
    `WASM:       ${basename(wasmPath)} (${(wasmSize / 1024).toFixed(0)} KB)`
  );

  let frame;
  if (movUrl) {
    console.log(`Source:     ${movUrl} (frame ${frameIndex})`);
    frame = await fetchFrameRemote(movUrl, frameIndex);
  } else {
    const movPath = resolve(__dirname, "../e2e/fixtures/test-prores-hq.mov");
    console.log(`Source:     ${basename(movPath)} (frame ${frameIndex})`);
    frame = extractFrameLocal(movPath, frameIndex);
  }

  const { frameData, width, height, codecTag, frameCount } = frame;
  console.log(`Codec:      ${codecTag}  ${width}x${height}  ${frameCount} frames`);
  console.log(`Frame:      ${(frameData.length / 1024).toFixed(1)} KB`);
  console.log(`Iterations: ${warmup} warmup + ${iterations} timed\n`);

  const { exports: exp, memory: mem } = await loadWasm(wasmPath);

  // Create decoder
  const tag =
    (codecTag.charCodeAt(0) << 24) |
    (codecTag.charCodeAt(1) << 16) |
    (codecTag.charCodeAt(2) << 8) |
    codecTag.charCodeAt(3);
  const decoder = exp.prores_create(tag);
  if (!decoder) throw new Error("prores_create failed");

  // Allocate buffers
  const inputPtr = exp.prores_malloc(frameData.length);
  const is422 =
    codecTag === "apch" ||
    codecTag === "apcn" ||
    codecTag === "apcs" ||
    codecTag === "apco";
  const chromaW = is422 ? Math.ceil(width / 2) : width;
  const ySize = width * height * 2;
  const cSize = chromaW * height * 2;
  const yPtr = exp.prores_malloc(ySize);
  const cbPtr = exp.prores_malloc(cSize);
  const crPtr = exp.prores_malloc(cSize);
  const dimPtr = exp.prores_malloc(8);

  // Copy frame data into WASM memory
  new Uint8Array(mem.buffer).set(frameData, inputPtr);

  // Warmup
  for (let i = 0; i < warmup; i++) {
    const ret = exp.prores_decode(
      decoder,
      inputPtr,
      frameData.length,
      yPtr,
      cbPtr,
      crPtr,
      dimPtr,
      dimPtr + 4
    );
    if (ret !== 0) throw new Error(`Warmup decode failed (ret=${ret})`);
  }

  // Benchmark
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    exp.prores_decode(
      decoder,
      inputPtr,
      frameData.length,
      yPtr,
      cbPtr,
      crPtr,
      dimPtr,
      dimPtr + 4
    );
    times.push(performance.now() - t0);
  }

  // Report
  const s = stats(times);
  console.log(`Results (${iterations} iterations):`);
  console.log(`  min    = ${s.min.toFixed(2)} ms`);
  console.log(`  median = ${s.median.toFixed(2)} ms`);
  console.log(`  avg    = ${s.avg.toFixed(2)} ms`);
  console.log(`  p95    = ${s.p95.toFixed(2)} ms`);
  console.log(`  max    = ${s.max.toFixed(2)} ms`);
  console.log(
    `  fps    = ${s.fps.toFixed(0)} (single-worker, based on median)`
  );

  // Sanity check
  const dv = new DataView(mem.buffer);
  const decW = dv.getInt32(dimPtr, true);
  const decH = dv.getInt32(dimPtr + 4, true);
  if (decW !== width || decH !== height) {
    console.error(
      `\nWARN: dimensions mismatch: expected ${width}x${height}, got ${decW}x${decH}`
    );
  }

  // Cleanup
  exp.prores_free(inputPtr);
  exp.prores_free(yPtr);
  exp.prores_free(cbPtr);
  exp.prores_free(crPtr);
  exp.prores_free(dimPtr);
  exp.prores_destroy(decoder);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
