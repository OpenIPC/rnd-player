/**
 * WASM HM H.265/HEVC reference decoder wrapper for QP map extraction.
 *
 * Loads a minimal WASM build of the HM (HEVC Test Model) reference decoder
 * compiled via Emscripten (see wasm/build-hm265.sh). The WASM binary is loaded
 * lazily on first use.
 *
 * Mirror of jm264Decoder.ts but for H.265/HEVC. Same API shape.
 *
 * HEVC uses variable-size CUs (8x8 to 64x64). QP is output at 8x8 granularity
 * for a uniform, codec-agnostic overlay grid.
 *
 * Exports:
 *   - hm265_qp_create() → ptr
 *   - hm265_qp_decode(ptr, annexb_buf, len) → 0 | 1 (frame ready)
 *   - hm265_qp_flush(ptr) → 0 | 1
 *   - hm265_qp_copy_qps(ptr, out, max) → num_blocks
 *   - hm265_qp_get_width_mbs(ptr) → int (width in 8x8 blocks)
 *   - hm265_qp_get_height_mbs(ptr) → int (height in 8x8 blocks)
 *   - hm265_qp_destroy(ptr)
 *   - hm265_qp_malloc(size) → ptr
 *   - hm265_qp_free(ptr)
 *   - hm265_qp_set_output(buf, max) → void
 *   - hm265_qp_get_error_recovery() → ptr to recovery struct
 */

export interface Hm265QpInstance {
  /** Decode an entire Annex B buffer (VPS+SPS+PPS+slices with start codes). Returns true when a frame has been decoded. */
  decodeFrame(annexB: Uint8Array): boolean;
  /** Flush remaining frames from the decoder's DPB. Returns true if a frame became available. */
  flush(): boolean;
  /** Copy luma QP values into a Uint8Array. Returns number of 8x8 blocks. */
  copyQps(): { qpValues: Uint8Array; count: number };
  /** Width in 8x8 blocks. */
  getWidthBlocks(): number;
  /** Height in 8x8 blocks. */
  getHeightBlocks(): number;
  /** True after WasiExit (error during decode) — instance is no longer usable. */
  readonly destroyed: boolean;
  /** Release all resources. */
  destroy(): void;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  hm265_qp_create: () => number;
  hm265_qp_decode: (ctx: number, buf: number, len: number) => number;
  hm265_qp_flush: (ctx: number) => number;
  hm265_qp_copy_qps: (ctx: number, out: number, max: number) => number;
  hm265_qp_get_width_mbs: (ctx: number) => number;
  hm265_qp_get_height_mbs: (ctx: number) => number;
  hm265_qp_destroy: (ctx: number) => void;
  hm265_qp_malloc: (size: number) => number;
  hm265_qp_free: (ptr: number) => void;
  hm265_qp_set_output: (buf: number, max: number) => void;
  hm265_qp_get_error_recovery: () => number;
}

/** Max Annex B buffer size (8MB should cover any segment's worth of NALUs). */
const MAX_ANNEXB_SIZE = 8 * 1024 * 1024;
/** Max 8x8 blocks for QP output: 8K resolution = 960x540 = 518400 blocks. */
const MAX_BLOCKS = 520000;

let wasmModule: WebAssembly.Module | null = null;
let wasmLoadPromise: Promise<WebAssembly.Module> | null = null;

async function loadWasmModule(): Promise<WebAssembly.Module> {
  if (wasmModule) return wasmModule;
  if (wasmLoadPromise) return wasmLoadPromise;

  wasmLoadPromise = (async () => {
    // Vite serves public/ at root — use absolute path (works in both main thread and workers)
    const response = await fetch("/hm265-qp.wasm");
    if (!response.ok) {
      throw new Error(
        `HM265 QP WASM fetch failed: ${response.status}. Build it with: cd wasm && ./build-hm265.sh`,
      );
    }
    const bytes = await response.arrayBuffer();
    wasmModule = await WebAssembly.compile(bytes);
    return wasmModule;
  })();

  return wasmLoadPromise;
}

/**
 * Check if the HM265 WASM decoder is available.
 */
export async function isHm265Available(): Promise<boolean> {
  try {
    await loadWasmModule();
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an HM265 QP decoder instance.
 * Loads the WASM binary on first call (cached for subsequent calls).
 */
export async function createHm265QpDecoder(): Promise<Hm265QpInstance> {
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

  const ctxPtr = exports.hm265_qp_create();
  if (ctxPtr === 0) {
    throw new Error("Failed to create HM265 QP decoder instance");
  }

  // Allocate buffers in WASM memory
  const annexBPtr = exports.hm265_qp_malloc(MAX_ANNEXB_SIZE);
  const qpOutPtr = exports.hm265_qp_malloc(MAX_BLOCKS);
  if (annexBPtr === 0 || qpOutPtr === 0) {
    throw new Error("Failed to allocate WASM memory for HM265 decoder");
  }

  // Register the QP output buffer so error recovery can write QP data before exit
  exports.hm265_qp_set_output(qpOutPtr, MAX_BLOCKS);

  // Get pointer to error recovery struct
  const errorRecoveryPtr = exports.hm265_qp_get_error_recovery();

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

    decodeFrame(annexB: Uint8Array): boolean {
      if (destroyed) throw new Error("Decoder already destroyed");
      if (annexB.byteLength > MAX_ANNEXB_SIZE) {
        throw new Error(`Annex B buffer too large: ${annexB.byteLength} > ${MAX_ANNEXB_SIZE}`);
      }

      const memory = new Uint8Array(exports.memory.buffer);
      memory.set(annexB, annexBPtr);
      capturedOutput = "";

      try {
        return exports.hm265_qp_decode(ctxPtr, annexBPtr, annexB.byteLength) === 1;
      } catch (e) {
        if (e instanceof WasiExit) {
          console.warn("[HM265] decode aborted:", e.message);
          const hasRecovery = readErrorRecovery();
          destroyed = true;
          return hasRecovery;
        }
        if (e instanceof WebAssembly.RuntimeError) {
          console.warn("[HM265] WASM trap during decode:", e.message);
          destroyed = true;
          return false;
        }
        throw e;
      }
    },

    flush(): boolean {
      if (destroyed) return recoveryCount > 0;
      try {
        return exports.hm265_qp_flush(ctxPtr) === 1;
      } catch (e) {
        if (e instanceof WasiExit) {
          console.warn("[HM265] flush error:", e.message);
          const hasRecovery = readErrorRecovery();
          destroyed = true;
          return hasRecovery;
        }
        if (e instanceof WebAssembly.RuntimeError) {
          console.warn("[HM265] WASM trap during flush:", e.message);
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

      const count = exports.hm265_qp_copy_qps(ctxPtr, qpOutPtr, MAX_BLOCKS);
      const qpValues = new Uint8Array(count);
      qpValues.set(new Uint8Array(exports.memory.buffer, qpOutPtr, count));
      return { qpValues, count };
    },

    getWidthBlocks(): number {
      if (destroyed) return recoveryWidthBlocks;
      return exports.hm265_qp_get_width_mbs(ctxPtr);
    },

    getHeightBlocks(): number {
      if (destroyed) return recoveryHeightBlocks;
      return exports.hm265_qp_get_height_mbs(ctxPtr);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      exports.hm265_qp_free(annexBPtr);
      exports.hm265_qp_free(qpOutPtr);
      exports.hm265_qp_destroy(ctxPtr);
    },
  };
}
