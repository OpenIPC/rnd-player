/**
 * Node.js validation test for the ProRes WASM decoder.
 *
 * Reads the test fixture MOV, extracts a raw ProRes frame,
 * feeds it to the WASM decoder, and verifies the output planes.
 *
 * Usage: node wasm/test-prores.mjs
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WASM_PATH = resolve(__dirname, "../public/prores-decoder.wasm");
const MOV_PATH = resolve(__dirname, "../e2e/fixtures/test-prores-hq.mov");

/** Parse a MOV file to extract raw ProRes frame data + metadata. */
function extractFirstFrame(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  let mdatOffset = -1;
  let mdatSize = -1;
  let width = 0;
  let height = 0;
  let codecTag = "";
  let sampleSizes = [];
  let chunkOffsets = [];

  // Parse top-level boxes
  while (pos + 8 <= buf.length) {
    let boxSize = view.getUint32(pos);
    const boxType = String.fromCharCode(buf[pos+4], buf[pos+5], buf[pos+6], buf[pos+7]);

    if (boxSize === 1 && pos + 16 <= buf.length) {
      const hi = view.getUint32(pos + 8);
      const lo = view.getUint32(pos + 12);
      boxSize = hi * 0x100000000 + lo;
    }
    if (boxSize < 8) break;

    if (boxType === "mdat") {
      mdatOffset = pos + 8;
      mdatSize = boxSize - 8;
    }

    if (boxType === "moov") {
      // Parse moov recursively for trak/stbl info
      parseMoov(buf, pos + 8, pos + boxSize);
    }

    pos += boxSize;
  }

  function parseMoov(buf, start, end) {
    let p = start;
    while (p + 8 <= end) {
      let sz = view.getUint32(p);
      const tp = String.fromCharCode(buf[p+4], buf[p+5], buf[p+6], buf[p+7]);
      if (sz < 8) break;
      if (sz === 1 && p + 16 <= end) {
        const hi = view.getUint32(p + 8);
        const lo = view.getUint32(p + 12);
        sz = hi * 0x100000000 + lo;
      }

      // Container boxes: recurse
      if (["moov","trak","mdia","minf","stbl","dinf"].includes(tp)) {
        parseMoov(buf, p + 8, p + sz);
      }

      // stsd: sample description — extract codec tag and dimensions
      if (tp === "stsd") {
        // fullbox: 4 bytes version+flags, 4 bytes entry count
        const entryStart = p + 8 + 4 + 4;
        // Each entry: 4 bytes size, 4 bytes type
        if (entryStart + 8 <= end) {
          codecTag = String.fromCharCode(
            buf[entryStart+4], buf[entryStart+5],
            buf[entryStart+6], buf[entryStart+7]
          );
          // Video sample entry: skip 6+2+16 bytes of reserved/data_ref, then 2+2+12+2+2 → width at offset 32, height at 34
          width = view.getUint16(entryStart + 32);
          height = view.getUint16(entryStart + 34);
        }
      }

      // stsz: sample sizes
      if (tp === "stsz") {
        const fullboxStart = p + 8;
        // version (1) + flags (3) = 4
        const sampleSize = view.getUint32(fullboxStart + 4);
        const sampleCount = view.getUint32(fullboxStart + 8);
        sampleSizes = [];
        if (sampleSize === 0) {
          for (let i = 0; i < sampleCount; i++) {
            sampleSizes.push(view.getUint32(fullboxStart + 12 + i * 4));
          }
        } else {
          for (let i = 0; i < sampleCount; i++) {
            sampleSizes.push(sampleSize);
          }
        }
      }

      // stco: chunk offsets (32-bit)
      if (tp === "stco") {
        const fullboxStart = p + 8;
        const count = view.getUint32(fullboxStart + 4);
        chunkOffsets = [];
        for (let i = 0; i < count; i++) {
          chunkOffsets.push(view.getUint32(fullboxStart + 8 + i * 4));
        }
      }

      // co64: chunk offsets (64-bit)
      if (tp === "co64") {
        const fullboxStart = p + 8;
        const count = view.getUint32(fullboxStart + 4);
        chunkOffsets = [];
        for (let i = 0; i < count; i++) {
          const hi = view.getUint32(fullboxStart + 8 + i * 8);
          const lo = view.getUint32(fullboxStart + 8 + i * 8 + 4);
          chunkOffsets.push(hi * 0x100000000 + lo);
        }
      }

      p += sz;
    }
  }

  if (sampleSizes.length === 0 || chunkOffsets.length === 0) {
    throw new Error("Could not extract sample table from MOV");
  }

  // For simplicity, assume one sample per chunk (common for ProRes MOV)
  const frameOffset = chunkOffsets[0];
  const frameSize = sampleSizes[0];
  const frameData = buf.slice(frameOffset, frameOffset + frameSize);

  return { frameData, width, height, codecTag, frameCount: sampleSizes.length };
}

class WasiExit {
  constructor(code) { this.code = code; }
}

async function main() {
  console.log("=== ProRes WASM Decoder Test ===\n");

  // Load WASM
  const wasmBytes = readFileSync(WASM_PATH);
  console.log(`WASM binary: ${wasmBytes.length} bytes`);

  const mod = await WebAssembly.compile(wasmBytes);

  let mem;
  const getView = () => new DataView(mem.buffer);

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
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          total += v.getUint32(iovs + i * 8 + 4, true);
        }
        v.setUint32(nwrittenPtr, total, true);
        return 0;
      },
      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      clock_time_get: () => 0,
    },
  });

  const exp = instance.exports;
  mem = exp.memory;

  // Init WASM runtime
  try { exp._start(); } catch (e) {
    if (!(e instanceof WasiExit)) throw e;
  }
  console.log("WASM runtime initialized");

  // Load test fixture
  const movData = readFileSync(MOV_PATH);
  console.log(`Test fixture: ${movData.length} bytes`);

  const { frameData, width, height, codecTag, frameCount } = extractFirstFrame(movData);
  console.log(`Codec: ${codecTag}, ${width}x${height}, ${frameCount} frames`);
  console.log(`First frame: ${frameData.length} bytes`);

  // Create decoder (apch = 0x61706368)
  const tag = (codecTag.charCodeAt(0) << 24) |
              (codecTag.charCodeAt(1) << 16) |
              (codecTag.charCodeAt(2) << 8) |
              codecTag.charCodeAt(3);

  const decoderPtr = exp.prores_create(tag);
  if (decoderPtr === 0) throw new Error("prores_create failed");
  console.log(`Decoder created (ptr=${decoderPtr})`);

  // Allocate buffers
  const inputPtr = exp.prores_malloc(frameData.length);
  const chromaW = Math.ceil(width / 2);
  const ySize = width * height * 2;
  const cSize = chromaW * height * 2;
  const yPtr = exp.prores_malloc(ySize);
  const cbPtr = exp.prores_malloc(cSize);
  const crPtr = exp.prores_malloc(cSize);
  const dimPtr = exp.prores_malloc(8);

  // Copy frame to WASM memory
  new Uint8Array(mem.buffer).set(frameData, inputPtr);

  // Decode
  console.log("\nDecoding frame 0...");
  const t0 = performance.now();
  const ret = exp.prores_decode(decoderPtr, inputPtr, frameData.length, yPtr, cbPtr, crPtr, dimPtr, dimPtr + 4);
  const dt = performance.now() - t0;

  if (ret !== 0) {
    console.error(`FAIL: prores_decode returned ${ret}`);
    process.exit(1);
  }

  const dv = new DataView(mem.buffer);
  const decW = dv.getInt32(dimPtr, true);
  const decH = dv.getInt32(dimPtr + 4, true);
  console.log(`Decoded: ${decW}x${decH} in ${dt.toFixed(1)}ms`);

  // Validate dimensions
  let pass = true;
  if (decW !== width || decH !== height) {
    console.error(`FAIL: expected ${width}x${height}, got ${decW}x${decH}`);
    pass = false;
  }

  // Read Y plane and check not all zeros
  const yPlane = new Uint16Array(mem.buffer, yPtr, decW * decH);
  let yMin = 65535, yMax = 0, ySum = 0;
  for (let i = 0; i < yPlane.length; i++) {
    const v = yPlane[i];
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
    ySum += v;
  }
  const yMean = ySum / yPlane.length;
  console.log(`Y plane:  min=${yMin} max=${yMax} mean=${yMean.toFixed(1)} (10-bit range: 0-1023)`);

  if (yMax === 0) {
    console.error("FAIL: Y plane is all zeros");
    pass = false;
  }
  if (yMax > 1023) {
    // Values should be in 10-bit range (though stored in 16-bit)
    console.warn(`WARN: Y values exceed 10-bit range (max=${yMax})`);
  }

  // Read Cb plane
  const cbPlane = new Uint16Array(mem.buffer, cbPtr, chromaW * decH);
  let cbMin = 65535, cbMax = 0;
  for (let i = 0; i < cbPlane.length; i++) {
    if (cbPlane[i] < cbMin) cbMin = cbPlane[i];
    if (cbPlane[i] > cbMax) cbMax = cbPlane[i];
  }
  console.log(`Cb plane: min=${cbMin} max=${cbMax}`);

  // Read Cr plane
  const crPlane = new Uint16Array(mem.buffer, crPtr, chromaW * decH);
  let crMin = 65535, crMax = 0;
  for (let i = 0; i < crPlane.length; i++) {
    if (crPlane[i] < crMin) crMin = crPlane[i];
    if (crPlane[i] > crMax) crMax = crPlane[i];
  }
  console.log(`Cr plane: min=${crMin} max=${crMax}`);

  if (cbMax === 0 || crMax === 0) {
    console.error("FAIL: Chroma planes are all zeros");
    pass = false;
  }

  // Cleanup
  exp.prores_free(inputPtr);
  exp.prores_free(yPtr);
  exp.prores_free(cbPtr);
  exp.prores_free(crPtr);
  exp.prores_free(dimPtr);
  exp.prores_destroy(decoderPtr);

  console.log(`\n${pass ? "PASS" : "FAIL"}: ProRes WASM decoder test`);
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
