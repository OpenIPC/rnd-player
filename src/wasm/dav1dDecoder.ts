/**
 * WASM dav1d AV1 decoder wrapper for QP map extraction.
 *
 * Loads a minimal WASM build of the dav1d AV1 decoder compiled via
 * Emscripten (see wasm/build-dav1d-av1.sh). The WASM binary is loaded
 * lazily on first use.
 *
 * Mirror of hm265Decoder.ts but for AV1. Same API shape.
 *
 * AV1 uses q_index (0-255) instead of QP (0-51). The overlay adapts
 * to min/max automatically. Output at 8x8 granularity (superblock-level
 * q_index expanded to 8x8 grid).
 *
 * Exports:
 *   - dav1d_qp_create() → ptr
 *   - dav1d_qp_decode(ptr, obu_buf, len) → 0 | 1 (frame ready)
 *   - dav1d_qp_flush(ptr) → 0 | 1
 *   - dav1d_qp_copy_qps(ptr, out, max) → num_blocks
 *   - dav1d_qp_get_width_mbs(ptr) → int (width in 8x8 blocks)
 *   - dav1d_qp_get_height_mbs(ptr) → int (height in 8x8 blocks)
 *   - dav1d_qp_destroy(ptr)
 *   - dav1d_qp_malloc(size) → ptr
 *   - dav1d_qp_free(ptr)
 *   - dav1d_qp_set_output(buf, max) → void
 *   - dav1d_qp_get_error_recovery() → ptr to recovery struct
 */

export interface Dav1dQpInstance {
  /** Decode OBU data (sequence header + frame OBUs). Returns true when a frame has been decoded. */
  decodeFrame(obuData: Uint8Array): boolean;
  /** Flush remaining frames from the decoder. Returns true if a frame became available. */
  flush(): boolean;
  /** Copy q_index values into a Uint8Array. Returns number of 8x8 blocks. */
  copyQps(): { qpValues: Uint8Array; count: number };
  /** Width in 8x8 blocks. */
  getWidthBlocks(): number;
  /** Height in 8x8 blocks. */
  getHeightBlocks(): number;
  /** Enable multi-frame QP capture mode. */
  setMultiFrame(enable: boolean): void;
  /** Get number of frames captured in multi-frame mode. */
  getFrameCount(): number;
  /** Copy QP values for a specific frame index (multi-frame mode). */
  copyFrameQps(index: number): { qpValues: Uint8Array; count: number };
  /** True after WasiExit (error during decode) — instance is no longer usable. */
  readonly destroyed: boolean;
  /** Release all resources. */
  destroy(): void;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  dav1d_qp_create: () => number;
  dav1d_qp_decode: (ctx: number, buf: number, len: number) => number;
  dav1d_qp_flush: (ctx: number) => number;
  dav1d_qp_copy_qps: (ctx: number, out: number, max: number) => number;
  dav1d_qp_get_width_mbs: (ctx: number) => number;
  dav1d_qp_get_height_mbs: (ctx: number) => number;
  dav1d_qp_destroy: (ctx: number) => void;
  dav1d_qp_malloc: (size: number) => number;
  dav1d_qp_free: (ptr: number) => void;
  dav1d_qp_set_output: (buf: number, max: number) => void;
  dav1d_qp_get_error_recovery: () => number;
  dav1d_qp_set_multi_frame: (ctx: number, enable: number) => void;
  dav1d_qp_get_frame_count: (ctx: number) => number;
  dav1d_qp_copy_frame_qps: (ctx: number, frameIdx: number, out: number, max: number) => number;
}

/** Max OBU buffer size (8MB should cover any segment). */
const MAX_OBU_SIZE = 8 * 1024 * 1024;
/** Max 8x8 blocks for QP output: 8K resolution = 960x540 = 518400 blocks. */
const MAX_BLOCKS = 520000;

let wasmModule: WebAssembly.Module | null = null;
let wasmLoadPromise: Promise<WebAssembly.Module> | null = null;

async function loadWasmModule(): Promise<WebAssembly.Module> {
  if (wasmModule) return wasmModule;
  if (wasmLoadPromise) return wasmLoadPromise;

  wasmLoadPromise = (async () => {
    // Vite serves public/ at root — use absolute path (works in both main thread and workers)
    const response = await fetch("/dav1d-qp.wasm");
    if (!response.ok) {
      throw new Error(
        `dav1d QP WASM fetch failed: ${response.status}. Build it with: cd wasm && ./build-dav1d-av1.sh`,
      );
    }
    const bytes = await response.arrayBuffer();
    wasmModule = await WebAssembly.compile(bytes);
    return wasmModule;
  })();

  return wasmLoadPromise;
}

/**
 * Check if the dav1d WASM decoder is available.
 */
export async function isDav1dAvailable(): Promise<boolean> {
  try {
    await loadWasmModule();
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a dav1d QP decoder instance.
 * Loads the WASM binary on first call (cached for subsequent calls).
 */
export async function createDav1dQpDecoder(): Promise<Dav1dQpInstance> {
  const mod = await loadWasmModule();

  // Late-binding memory reference for WASI stubs that write to WASM memory
  const memRef: { current: WebAssembly.Memory | null } = { current: null };
  const getView = () => new DataView(memRef.current!.buffer);

  // Plain class — NOT extends Error. Chrome V8 crashes (Aw Snap) when
  // Error.captureStackTrace runs during WASM execution in proc_exit.
  class WasiExit {
    code: number;
    message: string;
    constructor(code: number, output: string) {
      this.code = code;
      this.message = `WASM exit(${code})${output ? ": " + output.trim() : ""}`;
    }
  }

  // Capture WASM stdout/stderr for diagnostics
  let capturedOutput = "";

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
      proc_exit: (code: number) => { throw new WasiExit(code, capturedOutput); },
      fd_close: () => 0,
      fd_read: () => 0,
      fd_write: (_fd: number, iovs: number, iovsLen: number, nwrittenPtr: number) => {
        // Must report actual byte count; returning 0 causes C runtime write-retry loop
        const v = getView();
        const mem = new Uint8Array(memRef.current!.buffer);
        let totalBytes = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = v.getUint32(iovs + i * 8, true);
          const len = v.getUint32(iovs + i * 8 + 4, true);
          totalBytes += len;
          const text = new TextDecoder().decode(mem.subarray(ptr, ptr + len));
          capturedOutput += text;
          if (capturedOutput.length > 4096) {
            capturedOutput = capturedOutput.slice(-2048);
          }
        }
        v.setUint32(nwrittenPtr, totalBytes, true);
        return 0;
      },
      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      clock_time_get: (_clockId: number, _precision: bigint, timePtr: number) => {
        const v = getView();
        v.setBigUint64(timePtr, 0n, true);
        return 0;
      },
    },
  });

  const exports = instance.exports as unknown as WasmExports;
  memRef.current = exports.memory;

  // Initialize WASM runtime
  try {
    exports._start();
  } catch (e) {
    if (!(e instanceof WasiExit)) throw e;
  }
  capturedOutput = "";

  const ctxPtr = exports.dav1d_qp_create();
  if (ctxPtr === 0) {
    throw new Error("Failed to create dav1d QP decoder instance");
  }

  // Allocate buffers in WASM memory
  const obuBufPtr = exports.dav1d_qp_malloc(MAX_OBU_SIZE);
  const qpOutPtr = exports.dav1d_qp_malloc(MAX_BLOCKS);
  if (obuBufPtr === 0 || qpOutPtr === 0) {
    throw new Error("Failed to allocate WASM memory for dav1d decoder");
  }

  // Register the QP output buffer so error recovery can write QP data before exit
  exports.dav1d_qp_set_output(qpOutPtr, MAX_BLOCKS);

  // Get pointer to error recovery struct
  const errorRecoveryPtr = exports.dav1d_qp_get_error_recovery();

  let destroyed = false;

  // Error recovery data
  let recoveryCount = 0;
  let recoveryWidthBlocks = 0;
  let recoveryHeightBlocks = 0;

  function readErrorRecovery(): boolean {
    try {
      const view = new DataView(exports.memory.buffer);
      const valid = view.getInt32(errorRecoveryPtr, true);
      if (valid) {
        recoveryCount = view.getInt32(errorRecoveryPtr + 4, true);
        recoveryWidthBlocks = view.getInt32(errorRecoveryPtr + 8, true);
        recoveryHeightBlocks = view.getInt32(errorRecoveryPtr + 12, true);
        return recoveryCount > 0 && recoveryWidthBlocks > 0 && recoveryHeightBlocks > 0;
      }
    } catch {
      // Memory access failed
    }
    return false;
  }

  return {
    get destroyed() { return destroyed; },

    decodeFrame(obuData: Uint8Array): boolean {
      if (destroyed) throw new Error("Decoder already destroyed");
      if (obuData.byteLength > MAX_OBU_SIZE) {
        throw new Error(`OBU buffer too large: ${obuData.byteLength} > ${MAX_OBU_SIZE}`);
      }

      const memory = new Uint8Array(exports.memory.buffer);
      memory.set(obuData, obuBufPtr);
      capturedOutput = "";

      try {
        return exports.dav1d_qp_decode(ctxPtr, obuBufPtr, obuData.byteLength) === 1;
      } catch (e) {
        if (e instanceof WasiExit) {
          console.warn("[dav1d] decode aborted:", e.message);
          const hasRecovery = readErrorRecovery();
          destroyed = true;
          return hasRecovery;
        }
        if (e instanceof WebAssembly.RuntimeError) {
          console.warn("[dav1d] WASM trap during decode:", e.message);
          destroyed = true;
          return false;
        }
        throw e;
      }
    },

    flush(): boolean {
      if (destroyed) return recoveryCount > 0;
      try {
        return exports.dav1d_qp_flush(ctxPtr) === 1;
      } catch (e) {
        if (e instanceof WasiExit) {
          console.warn("[dav1d] flush error:", e.message);
          const hasRecovery = readErrorRecovery();
          destroyed = true;
          return hasRecovery;
        }
        if (e instanceof WebAssembly.RuntimeError) {
          console.warn("[dav1d] WASM trap during flush:", e.message);
          destroyed = true;
          return false;
        }
        throw e;
      }
    },

    copyQps(): { qpValues: Uint8Array; count: number } {
      if (destroyed) {
        if (recoveryCount > 0) {
          try {
            const qpValues = new Uint8Array(recoveryCount);
            qpValues.set(new Uint8Array(exports.memory.buffer, qpOutPtr, recoveryCount));
            return { qpValues, count: recoveryCount };
          } catch {
            return { qpValues: new Uint8Array(0), count: 0 };
          }
        }
        return { qpValues: new Uint8Array(0), count: 0 };
      }

      const count = exports.dav1d_qp_copy_qps(ctxPtr, qpOutPtr, MAX_BLOCKS);
      const qpValues = new Uint8Array(count);
      qpValues.set(new Uint8Array(exports.memory.buffer, qpOutPtr, count));
      return { qpValues, count };
    },

    getWidthBlocks(): number {
      if (destroyed) return recoveryWidthBlocks;
      return exports.dav1d_qp_get_width_mbs(ctxPtr);
    },

    getHeightBlocks(): number {
      if (destroyed) return recoveryHeightBlocks;
      return exports.dav1d_qp_get_height_mbs(ctxPtr);
    },

    setMultiFrame(enable: boolean) {
      if (destroyed) return;
      exports.dav1d_qp_set_multi_frame(ctxPtr, enable ? 1 : 0);
    },

    getFrameCount(): number {
      if (destroyed) return 0;
      return exports.dav1d_qp_get_frame_count(ctxPtr);
    },

    copyFrameQps(index: number): { qpValues: Uint8Array; count: number } {
      if (destroyed) return { qpValues: new Uint8Array(0), count: 0 };
      const count = exports.dav1d_qp_copy_frame_qps(ctxPtr, index, qpOutPtr, MAX_BLOCKS);
      const qpValues = new Uint8Array(count);
      qpValues.set(new Uint8Array(exports.memory.buffer, qpOutPtr, count));
      return { qpValues, count };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      exports.dav1d_qp_free(obuBufPtr);
      exports.dav1d_qp_free(qpOutPtr);
      exports.dav1d_qp_destroy(ctxPtr);
    },
  };
}
