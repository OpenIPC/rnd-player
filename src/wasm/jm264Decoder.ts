/**
 * WASM JM H.264 reference decoder wrapper for QP map extraction.
 *
 * Loads a minimal WASM build of the JM (Joint Model) H.264 reference decoder
 * compiled via Emscripten (see wasm/build-jm264.sh). The WASM binary is loaded
 * lazily on first use.
 *
 * Unlike edge264's per-NALU feeding, JM uses a "bulk Annex B" approach:
 * the caller passes an entire Annex B bitstream (SPS + PPS + slices with
 * 00 00 00 01 start codes) in a single decodeFrame() call.
 *
 * Error recovery: JM may call exit() on spec violations. The JS wrapper
 * catches the resulting WasiExit and reads QP data that was captured
 * before the error via the exit_picture → jm264_on_frame_decoded callback.
 *
 * Exports:
 *   - jm264_qp_create() → ptr
 *   - jm264_qp_decode(ptr, annexb_buf, len) → 0 | 1 (frame ready)
 *   - jm264_qp_flush(ptr) → 0 | 1
 *   - jm264_qp_copy_qps(ptr, out, max) → num_mbs
 *   - jm264_qp_get_width_mbs(ptr) → int
 *   - jm264_qp_get_height_mbs(ptr) → int
 *   - jm264_qp_destroy(ptr)
 *   - jm264_qp_malloc(size) → ptr
 *   - jm264_qp_free(ptr)
 *   - jm264_qp_set_output(buf, max) → void
 *   - jm264_qp_get_error_recovery() → ptr to recovery struct
 */

export interface Jm264QpInstance {
  /** Decode an entire Annex B buffer (SPS+PPS+slices with start codes). Returns true when a frame has been decoded. */
  decodeFrame(annexB: Uint8Array): boolean;
  /** Flush remaining frames from the decoder's DPB. Returns true if a frame became available. */
  flush(): boolean;
  /** Copy luma QP values into a Uint8Array. Returns number of macroblocks. */
  copyQps(): { qpValues: Uint8Array; count: number };
  /** Width in macroblocks (each MB = 16 pixels). */
  getWidthMbs(): number;
  /** Height in macroblocks (each MB = 16 pixels). */
  getHeightMbs(): number;
  /** True after WasiExit (error during decode) — instance is no longer usable. */
  readonly destroyed: boolean;
  /** Release all resources. */
  destroy(): void;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  _start: () => void;
  jm264_qp_create: () => number;
  jm264_qp_decode: (ctx: number, buf: number, len: number) => number;
  jm264_qp_flush: (ctx: number) => number;
  jm264_qp_copy_qps: (ctx: number, out: number, max: number) => number;
  jm264_qp_get_width_mbs: (ctx: number) => number;
  jm264_qp_get_height_mbs: (ctx: number) => number;
  jm264_qp_destroy: (ctx: number) => void;
  jm264_qp_malloc: (size: number) => number;
  jm264_qp_free: (ptr: number) => void;
  jm264_qp_set_output: (buf: number, max: number) => void;
  jm264_qp_get_error_recovery: () => number;
}

/** Max Annex B buffer size (8MB should cover any segment's worth of NALUs). */
const MAX_ANNEXB_SIZE = 8 * 1024 * 1024;
/** Max macroblocks for QP output: 8K resolution = 480x270 = 129600 MBs. */
const MAX_MBS = 130000;

let wasmModule: WebAssembly.Module | null = null;
let wasmLoadPromise: Promise<WebAssembly.Module> | null = null;

async function loadWasmModule(): Promise<WebAssembly.Module> {
  if (wasmModule) return wasmModule;
  if (wasmLoadPromise) return wasmLoadPromise;

  wasmLoadPromise = (async () => {
    // Vite serves public/ at root — use absolute path (works in both main thread and workers)
    const response = await fetch("/jm264-qp.wasm");
    if (!response.ok) {
      throw new Error(
        `JM264 QP WASM fetch failed: ${response.status}. Build it with: cd wasm && ./build-jm264.sh`,
      );
    }
    const bytes = await response.arrayBuffer();
    wasmModule = await WebAssembly.compile(bytes);
    return wasmModule;
  })();

  return wasmLoadPromise;
}

/**
 * Check if the JM264 WASM decoder is available.
 */
export async function isJm264Available(): Promise<boolean> {
  try {
    await loadWasmModule();
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a JM264 QP decoder instance.
 * Loads the WASM binary on first call (cached for subsequent calls).
 */
export async function createJm264QpDecoder(): Promise<Jm264QpInstance> {
  const mod = await loadWasmModule();

  // Late-binding memory reference for WASI stubs that write to WASM memory
  const memRef: { current: WebAssembly.Memory | null } = { current: null };
  const getView = () => new DataView(memRef.current!.buffer);

  // Plain class — NOT extends Error. Chrome V8 crashes (Aw Snap) when
  // Error.captureStackTrace runs during WASM execution in proc_exit,
  // because WASM frames on the stack can't be symbolized.
  // Matches the working EC-3 decoder pattern.
  class WasiExit {
    code: number;
    message: string;
    constructor(code: number, output: string) {
      this.code = code;
      this.message = `WASM exit(${code})${output ? ": " + output.trim() : ""}`;
    }
  }

  // Capture WASM stdout/stderr so we can see JM's error messages
  let capturedOutput = "";

  const instance = await WebAssembly.instantiate(mod, {
    env: {
      emscripten_notify_memory_growth: () => {},
      __main_argc_argv: () => 0,
      // JM timing stubs — gettime writes to a TIME_T* (struct timeval = 2x i32)
      // timediff and timenorm return int64 (BigInt in WASM)
      gettime: () => {},
      timediff: () => 0n,
      timenorm: () => 0n,
      init_time: () => {},
      // JM RTP stubs (not used — we use Annex B)
      OpenRTPFile: () => 0,
      CloseRTPFile: () => {},
      GetRTPNALU: () => -1,
    },
    // Only the 8 WASI functions actually imported by the WASM binary
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
          // Capture text output for diagnostics
          const text = new TextDecoder().decode(mem.subarray(ptr, ptr + len));
          capturedOutput += text;
          // Keep buffer from growing unbounded
          if (capturedOutput.length > 64000) {
            capturedOutput = capturedOutput.slice(-32000);
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

  const ctxPtr = exports.jm264_qp_create();
  capturedOutput = "";
  if (ctxPtr === 0) {
    throw new Error("Failed to create JM264 QP decoder instance");
  }

  // Allocate buffers in WASM memory
  const annexBPtr = exports.jm264_qp_malloc(MAX_ANNEXB_SIZE);
  const qpOutPtr = exports.jm264_qp_malloc(MAX_MBS);
  if (annexBPtr === 0 || qpOutPtr === 0) {
    throw new Error("Failed to allocate WASM memory for JM264 decoder");
  }

  // Register the QP output buffer so error() can write QP data before exit
  exports.jm264_qp_set_output(qpOutPtr, MAX_MBS);

  // Get pointer to error recovery struct (4 × int32: valid, count, width_mbs, height_mbs)
  const errorRecoveryPtr = exports.jm264_qp_get_error_recovery();

  let destroyed = false;

  // Error recovery data — populated from WASM memory after WasiExit
  let recoveryCount = 0;
  let recoveryWidthMbs = 0;
  let recoveryHeightMbs = 0;

  /**
   * After a WasiExit, read QP data that was captured by error() before exit.
   * The recovery struct at errorRecoveryPtr has: valid(i32), count(i32), width_mbs(i32), height_mbs(i32).
   * QP values were written to qpOutPtr.
   */
  function readErrorRecovery(): boolean {
    try {
      const view = new DataView(exports.memory.buffer);
      const valid = view.getInt32(errorRecoveryPtr, true);
      if (valid) {
        recoveryCount = view.getInt32(errorRecoveryPtr + 4, true);
        recoveryWidthMbs = view.getInt32(errorRecoveryPtr + 8, true);
        recoveryHeightMbs = view.getInt32(errorRecoveryPtr + 12, true);
        return recoveryCount > 0 && recoveryWidthMbs > 0 && recoveryHeightMbs > 0;
      }
    } catch {
      // Memory access failed — struct not available
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
        return exports.jm264_qp_decode(ctxPtr, annexBPtr, annexB.byteLength) === 1;
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

    flush(): boolean {
      if (destroyed) return recoveryCount > 0;
      try {
        return exports.jm264_qp_flush(ctxPtr) === 1;
      } catch (e) {
        if (e instanceof WasiExit) {
          console.warn("[JM264] flush error:", e.message);
          const hasRecovery = readErrorRecovery();
          destroyed = true;
          return hasRecovery;
        }
        if (e instanceof WebAssembly.RuntimeError) {
          console.warn("[JM264] WASM trap during flush:", e.message);
          destroyed = true;
          return false;
        }
        throw e;
      }
    },

    copyQps(): { qpValues: Uint8Array; count: number } {
      if (destroyed) {
        // Error recovery: read QP data written by error() to the output buffer
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

      const count = exports.jm264_qp_copy_qps(ctxPtr, qpOutPtr, MAX_MBS);
      const qpValues = new Uint8Array(count);
      qpValues.set(new Uint8Array(exports.memory.buffer, qpOutPtr, count));
      return { qpValues, count };
    },

    getWidthMbs(): number {
      if (destroyed) return recoveryWidthMbs;
      return exports.jm264_qp_get_width_mbs(ctxPtr);
    },

    getHeightMbs(): number {
      if (destroyed) return recoveryHeightMbs;
      return exports.jm264_qp_get_height_mbs(ctxPtr);
    },

    destroy() {
      if (destroyed) return; // After WasiExit, WASM calls are unsafe
      destroyed = true;
      exports.jm264_qp_free(annexBPtr);
      exports.jm264_qp_free(qpOutPtr);
      exports.jm264_qp_destroy(ctxPtr);
    },
  };
}
