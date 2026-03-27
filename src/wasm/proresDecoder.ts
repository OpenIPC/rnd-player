/**
 * WASM ProRes decoder wrapper.
 *
 * Loads a minimal WASM build of FFmpeg's ProRes decoder compiled via
 * Emscripten (see wasm/build-prores.sh). The WASM binary is loaded lazily
 * on first use and the compiled module is cached for reuse across workers.
 *
 * The WASM module exports:
 *   - prores_create(codec_tag: u32) → ptr
 *   - prores_decode(ptr, inputPtr, inputLen, yOut, cbOut, crOut, outWidth, outHeight) → i32
 *   - prores_get_width(ptr) → i32
 *   - prores_get_height(ptr) → i32
 *   - prores_get_pix_fmt(ptr) → i32
 *   - prores_destroy(ptr)
 *   - prores_malloc(size: i32) → ptr
 *   - prores_free(ptr)
 */

import type { DecodedFrame } from "../types/proResWorker.types";

interface WasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  prores_create: (codecTag: number) => number;
  prores_decode: (
    ptr: number,
    inputPtr: number,
    inputLen: number,
    yOut: number,
    cbOut: number,
    crOut: number,
    outWidth: number,
    outHeight: number,
  ) => number;
  prores_get_width: (ptr: number) => number;
  prores_get_height: (ptr: number) => number;
  prores_get_pix_fmt: (ptr: number) => number;
  prores_destroy: (ptr: number) => void;
  prores_malloc: (size: number) => number;
  prores_free: (ptr: number) => void;
}

/** FourCC string → 32-bit big-endian tag value. */
function fourccToTag(fourcc: string): number {
  return (
    (fourcc.charCodeAt(0) << 24) |
    (fourcc.charCodeAt(1) << 16) |
    (fourcc.charCodeAt(2) << 8) |
    fourcc.charCodeAt(3)
  );
}

/** Max compressed frame size: 4 MB (generous for 4K ProRes HQ). */
const MAX_INPUT_SIZE = 4 * 1024 * 1024;
/** Max decoded plane sizes: 4K 10-bit = ~16 MB per full plane, ~8 MB chroma. */
const MAX_PLANE_SIZE = 16 * 1024 * 1024;

let wasmModule: WebAssembly.Module | null = null;
let wasmLoadPromise: Promise<WebAssembly.Module> | null = null;

async function loadWasmModule(): Promise<WebAssembly.Module> {
  if (wasmModule) return wasmModule;
  if (wasmLoadPromise) return wasmLoadPromise;

  wasmLoadPromise = (async () => {
    const paths = ["/prores-decoder.wasm", "./prores-decoder.wasm"];

    for (const path of paths) {
      try {
        const response = await fetch(path);
        if (!response.ok) continue;
        const bytes = await response.arrayBuffer();
        wasmModule = await WebAssembly.compile(bytes);
        return wasmModule;
      } catch {
        continue;
      }
    }

    throw new Error(
      "ProRes WASM decoder not found. Build it with: cd wasm && ./build-prores.sh",
    );
  })();

  return wasmLoadPromise;
}

export interface ProResDecoderInstance {
  decode(frameData: Uint8Array, width: number, height: number, is444: boolean): DecodedFrame;
  destroy(): void;
}

class WasiExit {
  code: number;
  constructor(code: number) {
    this.code = code;
  }
}

export async function createProResDecoder(
  fourcc: string,
  precompiledModule?: WebAssembly.Module,
): Promise<ProResDecoderInstance> {
  const mod = precompiledModule ?? await loadWasmModule();

  // eslint-disable-next-line prefer-const
  let mem: WebAssembly.Memory;
  const getView = () => new DataView(mem.buffer);

  const instance = await WebAssembly.instantiate(mod, {
    env: {
      emscripten_notify_memory_growth: () => {},
      __main_argc_argv: () => 0,
    },
    wasi_snapshot_preview1: {
      args_sizes_get: (argcPtr: number, argvBufSizePtr: number) => {
        const v = getView();
        v.setUint32(argcPtr, 0, true);
        v.setUint32(argvBufSizePtr, 0, true);
        return 0;
      },
      args_get: () => 0,
      environ_sizes_get: (countPtr: number, bufSizePtr: number) => {
        const v = getView();
        v.setUint32(countPtr, 0, true);
        v.setUint32(bufSizePtr, 0, true);
        return 0;
      },
      environ_get: () => 0,
      proc_exit: (code: number) => {
        throw new WasiExit(code);
      },
      fd_close: () => 0,
      fd_read: () => 0,
      fd_write: (_fd: number, iovs: number, iovsLen: number, nwrittenPtr: number) => {
        const v = getView();
        let totalBytes = 0;
        for (let i = 0; i < iovsLen; i++) {
          const len = v.getUint32(iovs + i * 8 + 4, true);
          totalBytes += len;
        }
        v.setUint32(nwrittenPtr, totalBytes, true);
        return 0;
      },
      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      clock_time_get: () => 0,
    },
  });

  const exports = instance.exports as unknown as WasmExports;
  mem = exports.memory;

  try {
    exports._start();
  } catch (e) {
    if (!(e instanceof WasiExit)) throw e;
  }

  const tag = fourccToTag(fourcc);
  const decoderPtr = exports.prores_create(tag);
  if (decoderPtr === 0) {
    throw new Error("Failed to create ProRes decoder instance");
  }

  const inputPtr = exports.prores_malloc(MAX_INPUT_SIZE);
  const yPtr = exports.prores_malloc(MAX_PLANE_SIZE);
  const cbPtr = exports.prores_malloc(MAX_PLANE_SIZE);
  const crPtr = exports.prores_malloc(MAX_PLANE_SIZE);
  // 2 ints for width/height output
  const dimPtr = exports.prores_malloc(8);

  if (!inputPtr || !yPtr || !cbPtr || !crPtr || !dimPtr) {
    throw new Error("Failed to allocate WASM memory for ProRes decoder");
  }

  let destroyed = false;

  return {
    decode(
      frameData: Uint8Array,
      _width: number,
      _height: number,
      is444: boolean,
    ): DecodedFrame {
      if (destroyed) throw new Error("Decoder already destroyed");
      if (frameData.byteLength > MAX_INPUT_SIZE) {
        throw new Error(
          `ProRes frame too large: ${frameData.byteLength} > ${MAX_INPUT_SIZE}`,
        );
      }

      const memory = new Uint8Array(exports.memory.buffer);
      memory.set(frameData, inputPtr);

      const ret = exports.prores_decode(
        decoderPtr,
        inputPtr,
        frameData.byteLength,
        yPtr,
        cbPtr,
        crPtr,
        dimPtr,
        dimPtr + 4,
      );

      if (ret !== 0) {
        throw new Error(`ProRes decode failed (code ${ret})`);
      }

      const view = new DataView(exports.memory.buffer);
      const decW = view.getInt32(dimPtr, true);
      const decH = view.getInt32(dimPtr + 4, true);

      const chromaW = is444 ? decW : (decW + 1) >> 1;
      const chromaH = decH;

      // Copy planes out of WASM memory (it may grow, invalidating views)
      const yPlane = new Uint16Array(decW * decH);
      yPlane.set(
        new Uint16Array(exports.memory.buffer, yPtr, decW * decH),
      );

      const cbPlane = new Uint16Array(chromaW * chromaH);
      cbPlane.set(
        new Uint16Array(exports.memory.buffer, cbPtr, chromaW * chromaH),
      );

      const crPlane = new Uint16Array(chromaW * chromaH);
      crPlane.set(
        new Uint16Array(exports.memory.buffer, crPtr, chromaW * chromaH),
      );

      return {
        width: decW,
        height: decH,
        chromaWidth: chromaW,
        chromaHeight: chromaH,
        yPlane,
        cbPlane,
        crPlane,
      };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      exports.prores_free(inputPtr);
      exports.prores_free(yPtr);
      exports.prores_free(cbPtr);
      exports.prores_free(crPtr);
      exports.prores_free(dimPtr);
      exports.prores_destroy(decoderPtr);
    },
  };
}
