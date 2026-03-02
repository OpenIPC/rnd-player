/**
 * WASM EC-3 (Dolby Digital Plus) / AC-3 (Dolby Digital) decoder wrapper.
 *
 * Loads a minimal WASM build of FFmpeg's AC-3 and E-AC-3 decoders compiled
 * via Emscripten (see wasm/build-ec3.sh). The WASM binary is loaded lazily
 * on first use.
 *
 * EC-3 patents expired January 2026 — legal to ship without license.
 *
 * The WASM module exports:
 *   - ec3_decoder_create(channels: i32, sampleRate: i32) → ptr
 *   - ec3_decoder_decode(ptr, inputPtr: ptr, inputLen: i32, outputPtr: ptr, maxOutputLen: i32) → i32
 *   - ec3_decoder_destroy(ptr)
 *   - ec3_malloc(size: i32) → ptr
 *   - ec3_free(ptr)
 */

export interface Ec3DecoderInstance {
  /** Decode a single AC-3/EC-3 frame. Returns per-channel Float32Array PCM. */
  decode(frame: Uint8Array): Float32Array[];
  /** Number of audio channels the decoder was initialized with. */
  channels: number;
  /** Sample rate the decoder was initialized with. */
  sampleRate: number;
  /** Release all resources. */
  destroy(): void;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  ec3_decoder_create: (channels: number, sampleRate: number) => number;
  ec3_decoder_decode: (
    ptr: number,
    inputPtr: number,
    inputLen: number,
    outputPtr: number,
    maxOutputLen: number,
  ) => number;
  ec3_decoder_destroy: (ptr: number) => void;
  ec3_malloc: (size: number) => number;
  ec3_free: (ptr: number) => void;
}

/** Max EC-3 frame size (6144 bytes per ATSC A/52). Allocate generously. */
const MAX_INPUT_SIZE = 8192;
/** Max decoded output size per frame: 6 channels × 256 blocks × 6 segments × 4 bytes ≈ 36KB per channel */
const MAX_OUTPUT_SIZE = 6 * 6144 * 4;

let wasmModule: WebAssembly.Module | null = null;
let wasmLoadPromise: Promise<WebAssembly.Module> | null = null;

/**
 * Load the WASM binary. The binary is expected at `/ec3-decoder.wasm`
 * (served from the public directory) or as a separate chunk.
 */
async function loadWasmModule(): Promise<WebAssembly.Module> {
  if (wasmModule) return wasmModule;
  if (wasmLoadPromise) return wasmLoadPromise;

  wasmLoadPromise = (async () => {
    // Try multiple paths for the WASM binary
    const paths = [
      new URL("../../public/ec3-decoder.wasm", import.meta.url).href,
      "/ec3-decoder.wasm",
      "./ec3-decoder.wasm",
    ];

    for (const path of paths) {
      try {
        console.log(`[ec3-wasm] trying: ${path}`);
        const response = await fetch(path);
        if (!response.ok) {
          console.log(`[ec3-wasm] ${path} → HTTP ${response.status}`);
          continue;
        }
        const bytes = await response.arrayBuffer();
        console.log(`[ec3-wasm] loaded ${bytes.byteLength} bytes, compiling...`);
        wasmModule = await WebAssembly.compile(bytes);
        console.log("[ec3-wasm] compiled successfully");
        return wasmModule;
      } catch (err) {
        console.log(`[ec3-wasm] ${path} failed:`, err);
        continue;
      }
    }

    throw new Error(
      "EC-3 WASM decoder not found. Build it with: cd wasm && ./build-ec3.sh",
    );
  })();

  return wasmLoadPromise;
}

/**
 * Check if the EC-3 WASM decoder is available.
 * Returns true if the WASM binary can be loaded.
 */
export async function isEc3DecoderAvailable(): Promise<boolean> {
  try {
    await loadWasmModule();
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an EC-3 decoder instance.
 * Loads the WASM binary on first call (cached for subsequent calls).
 */
export async function createEc3Decoder(
  channels: number,
  sampleRate: number,
): Promise<Ec3DecoderInstance> {
  const mod = await loadWasmModule();

  // Late-binding memory reference for WASI stubs that write to WASM memory
  let mem: WebAssembly.Memory;
  const getView = () => new DataView(mem.buffer);

  // _start() calls main() then proc_exit(). proc_exit must throw
  // because the WASM has an unreachable instruction after the call
  // (it assumes proc_exit never returns). We catch the throw after
  // initialization completes.
  class WasiExit { code: number; constructor(code: number) { this.code = code; } }

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
      proc_exit: (code: number) => { throw new WasiExit(code); },
      fd_close: () => 0,
      fd_read: () => 0,
      fd_write: () => 0,
      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      clock_time_get: () => 0,
    },
  });

  const exports = instance.exports as unknown as WasmExports;
  mem = exports.memory;

  // Initialize WASM runtime (FFmpeg codec registry, global state).
  // _start() → __wasm_call_ctors() → main() → proc_exit() → throws WasiExit
  try {
    exports._start();
  } catch (e) {
    if (!(e instanceof WasiExit)) throw e;
    // Normal exit after main() — global constructors ran, codecs registered
  }

  // Allocate decoder context
  const decoderPtr = exports.ec3_decoder_create(channels, sampleRate);
  if (decoderPtr === 0) {
    throw new Error("Failed to create EC-3 decoder instance");
  }

  // Allocate input/output buffers in WASM memory
  const inputPtr = exports.ec3_malloc(MAX_INPUT_SIZE);
  const outputPtr = exports.ec3_malloc(MAX_OUTPUT_SIZE);
  if (inputPtr === 0 || outputPtr === 0) {
    throw new Error("Failed to allocate WASM memory for EC-3 decoder");
  }

  let destroyed = false;

  return {
    channels,
    sampleRate,

    decode(frame: Uint8Array): Float32Array[] {
      if (destroyed) throw new Error("Decoder already destroyed");
      if (frame.byteLength > MAX_INPUT_SIZE) {
        throw new Error(`EC-3 frame too large: ${frame.byteLength} > ${MAX_INPUT_SIZE}`);
      }

      // Copy input frame to WASM memory
      const memory = new Uint8Array(exports.memory.buffer);
      memory.set(frame, inputPtr);

      // Decode
      const outputSamples = exports.ec3_decoder_decode(
        decoderPtr,
        inputPtr,
        frame.byteLength,
        outputPtr,
        MAX_OUTPUT_SIZE,
      );

      if (outputSamples <= 0) {
        return [];
      }

      // Read output: interleaved float32 PCM
      const samplesPerChannel = outputSamples / channels;
      const interleavedF32 = new Float32Array(
        exports.memory.buffer,
        outputPtr,
        outputSamples,
      );

      // De-interleave into per-channel arrays
      const result: Float32Array[] = [];
      for (let ch = 0; ch < channels; ch++) {
        const channelData = new Float32Array(samplesPerChannel);
        for (let i = 0; i < samplesPerChannel; i++) {
          channelData[i] = interleavedF32[i * channels + ch];
        }
        result.push(channelData);
      }

      return result;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      exports.ec3_free(inputPtr);
      exports.ec3_free(outputPtr);
      exports.ec3_decoder_destroy(decoderPtr);
    },
  };
}
