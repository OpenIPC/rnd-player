# QP Heatmap Overlay

Per-macroblock QP (Quantization Parameter) heatmap overlay for H.264 streams, rendered on paused frames.

## Background

### How StreamEye and VQ Analyzer Extract QP

Both tools use full software decoders (not lightweight parsers) to extract per-macroblock QP values. StreamEye uses its own internal H.264 decoder; VQ Analyzer wraps reference decoders. The key insight: extracting QP requires full entropy decoding because of CABAC's serial dependency chain.

### H.264 QP Encoding Chain

The final QP for a macroblock is computed as:

```
QP = pic_init_qp_minus26 + 26 + slice_qp_delta + mb_qp_delta
```

- `pic_init_qp_minus26`: PPS-level base QP (range: -26..+25)
- `slice_qp_delta`: per-slice adjustment from slice header
- `mb_qp_delta`: per-macroblock delta, entropy-coded in the slice data

The `mb_qp_delta` is what makes lightweight parsing impossible — it's embedded in the CABAC/CAVLC bitstream interleaved with residual coefficients. You cannot skip to it without decoding everything before it.

### Why Full Entropy Decode Is Required

CABAC (Context-Adaptive Binary Arithmetic Coding) maintains internal state that depends on all previously decoded syntax elements. Each macroblock's QP delta is context-modeled based on the previous macroblock's QP delta. Skipping any macroblock corrupts the arithmetic decoder state, making all subsequent values wrong.

CAVLC is slightly more forgiving but still requires sequential parsing of all syntax elements within each macroblock to find the QP delta.

## Architecture

### JM H.264 Reference Decoder

The [JM (Joint Model)](https://vcgit.hhi.fraunhofer.de/jvet/JM) is the ITU-T/ISO reference implementation for H.264/AVC (JM 19.0). Advantages:

- Time-proven, standards-compliant — 100% correct decoding of all H.264 profiles
- Same approach extends to HEVC (HM) and VVC (VTM) reference decoders
- QP stored in `p_Vid->mb_data[mb_addr].qp` — flat array in raster scan order
- Out-of-tree patches can probe any internal data (MB structure, motion vectors, DCT coefficients)

The WASM build patches JM for in-memory operation: file I/O is replaced with memory buffer reads, YUV output is suppressed, and CLI parsing is stubbed. The decoder receives a complete Annex B bitstream (SPS+PPS+slices) in a single call.

### WASM Data Flow

```
Video frame (paused)
  → Shaka manifest: find active segment URL
  → Fetch init segment + media segment
  → Worker: mp4box extracts H.264 NAL units from fMP4
  → Worker: build Annex B buffer (SPS+PPS+slices with start codes)
  → Worker: decode via JM WASM decoder in one call
  → Worker: read mb_data[].qp per macroblock → Uint8Array
  → Main thread: QpHeatmapOverlay draws canvas overlay
```

### Color Mapping

5-stop gradient mapping QP to color at 50% alpha:

| QP Range | Color  | Meaning      |
|----------|--------|--------------|
| Low      | Blue   | High quality |
| Low-mid  | Cyan   | Good quality |
| Mid      | Green  | Average      |
| Mid-high | Yellow | Lower quality|
| High     | Red    | Low quality  |

The scale adapts to the actual min/max QP in each frame for maximum contrast.

## WASM Build

Build: `cd wasm && ./build-jm264.sh` — produces `public/jm264-qp.wasm` (~428KB).

11 patches applied to JM source, compiled with Emscripten (`emcc -O2 -DNDEBUG`):

| # | File | Patch |
|---|------|-------|
| 1 | annexb.c | Replace file read with memory buffer (`g_mem_buf`) |
| 2 | annexb.c | Skip `open_annex_b()` file open when using memory buffer |
| 3 | output.c | QP capture callback (`jm264_on_frame_output`) + suppress YUV writes |
| 4 | configfile.c | Stub `ParseCommand()` — skip CLI/config parsing |
| 5 | report.c | Suppress report file writes |
| 6 | ldecod.c | Suppress `Report()` log file writes |
| 7 | defines.h | Disable TRACE, fix duplicate `ColorComponent` symbol |
| 8 | mbuffer.c | DPB size violations: clamp values instead of `error()` |
| 9 | image.c | "Unintentional loss of pictures": printf instead of `error()` |
| — | build flag | `-DNDEBUG` disables all `assert()` calls (64 in total) |
| — | overrides.h | Compile-time stubs for file I/O and trace |

### Heredoc Quoting

Build script patches use Python heredocs to modify JM source. **Critical**: heredocs that contain `\\n` (C escape sequences) must use quoted delimiters (`<< 'PYEOF'`) to prevent bash from expanding `\\n` as a literal newline. Unquoted heredocs silently break C string literals, producing compile errors only on clean rebuilds (when `wasm/build/JM` is not cached).

Path variables (`$MBUFFER_SRC`, etc.) are passed via environment variables since quoted heredocs don't expand shell variables.

## Error Recovery (3 Layers)

### Layer 1 — Prevent Errors at Source

Configured via `jm264_wrapper.c` and build patches:

- `conceal_mode=0` (NOT 1): JM's concealment code (`erc_do_p.c`) has an assertion `conceal_from_picture != NULL` that crashes when the DPB is empty. With `conceal_mode=0`, `fill_frame_num_gap()` creates lightweight placeholder frames instead.
- `non_conforming_stream=1`: reference picture errors become printf warnings, not fatal `error()` calls. Re-applied before each decode since SPS parsing may reset it.
- mbuffer.c patches: DPB size violations (`max_dec_frame_buffering > MaxDpbSize`, `DPB size < num_ref_frames`) are clamped to valid values instead of calling `error()`.
- image.c patch: "unintentional loss of pictures" is a warning, not `error()`.

### Layer 2 — Capture QP During Frame Output

`write_out_picture()` is patched to call `jm264_on_frame_output()` which copies `p_Vid->mb_data[].qp` into the context's cache. This fires **before** DPB management, ensuring QP data is captured even if a subsequent `error()` triggers during the same decode loop iteration.

### Layer 3 — Error Recovery via `error()` Override

The wrapper overrides JM's `error()` function (via `--allow-multiple-definition` link order — wrapper.c must be first). Before calling `exit()`:

1. Captures `p_Vid->mb_data[].qp` to the pre-registered output buffer (`g_qp_out_buf`)
2. Writes a recovery struct (`g_error_recovery`) with `valid=1`, MB count, and dimensions
3. Calls `exit(code)` → `proc_exit` → JS `WasiExit` exception

JS reads the recovery struct from WASM linear memory after catching `WasiExit`, returning QP data even from failed decodes.

### WASM Trap Safety Net

JM's 64 `assert()` calls compiled to `unreachable` WASM instructions. Before adding `-DNDEBUG`, certain H.264 segments triggered these assertions intermittently (~10% failure rate). The traps produce `WebAssembly.RuntimeError: unreachable` which is **not** a `WasiExit` — it bypasses `proc_exit` entirely.

Fix (two-pronged):
1. **Build**: `-DNDEBUG` removes all `assert()` calls from the WASM binary
2. **Runtime**: `decodeFrame()`/`flush()` catch `WebAssembly.RuntimeError`, mark the decoder as destroyed, and return `false`. The worker nulls `cachedDecoder`, and the next pause/seek creates a fresh 64MB WASM instance.

## Issues and Workarounds

### WasiExit Must NOT Extend Error

`WasiExit` is a plain class, **not** `extends Error`. Chrome V8 crashes ("Aw Snap" tab crash — SIGABRT in JIT code) when `Error.captureStackTrace` runs during WASM `proc_exit` execution, because WASM frames on the stack can't be symbolized. This matches the pattern used by the EC-3 decoder.

### Vite WASM Loading in Workers

Use `fetch("/jm264-qp.wasm")` (absolute path from public/) — **not** `new URL("../../public/jm264-qp.wasm", import.meta.url)`. Vite transforms `new URL(...)` incorrectly in worker contexts, producing invalid paths.

### WASI fd_write Must Report Bytes

The `fd_write` WASI stub must set `nwritten` to the actual byte count. Returning 0 causes the C runtime's `write()` wrapper to retry in an infinite loop, hanging the WASM instance.

### Decoder Instance Caching

The decoder allocates 64MB of WASM memory on creation. Creating a new instance per decode request would cause memory pressure and GC pauses. The worker caches a single `Jm264QpInstance` and only recreates it after a `WasiExit` or `RuntimeError` marks it as destroyed.

### Link Order for error() Override

With `--allow-multiple-definition`, the wrapper's `error()` must win over JM's. `jm264_wrapper.c` must be the **first** source file in the `emcc` command line for its definition to take precedence.

### Always-On Audio Meter Fallback Crashes Chrome

`useAudioMeterFallback` (Safari MSE workaround) must **not** run unconditionally on all browsers. When enabled on Chrome with EC-3 audio streams, the fetch+decode pipeline causes tab crashes (SIGABRT). The fallback must be gated on `safariMSE && !ec3Active` — only activated on Safari where it's actually needed. (Identified via `git bisect`: commit `d827e04`.)

## Scope

- **Codec**: H.264 only (avc1.* codec string)
- **Trigger**: Paused frames only (clears on play)
- **Rendering**: Canvas 2D overlay with pointer-events: none
- **Letterboxing**: Accounts for object-fit: contain in fullscreen

## Files

- `wasm/jm264_wrapper.c` — C wrapper: memory buffer I/O, QP capture, error recovery, exported API
- `wasm/jm264_overrides.h` — Compile-time stubs for file I/O and trace
- `wasm/build-jm264.sh` — Emscripten build: clone JM, apply 11 patches, compile with `-DNDEBUG`
- `src/wasm/jm264Decoder.ts` — WASM loader: WASI stubs, WasiExit handling, RuntimeError safety net
- `src/types/qpMapWorker.types.ts` — Worker message types
- `src/workers/qpMapWorker.ts` — QP extraction worker: mp4box parsing, Annex B assembly, decoder caching
- `src/hooks/useQpHeatmap.ts` — React hook: codec detection, segment fetching, worker lifecycle
- `src/components/QpHeatmapOverlay.tsx` — Canvas overlay: 5-stop color gradient, letterbox-aware sizing

## Tests

- `wasm/test-validate-qp.mjs` — 32 tests: fixed QP, dimensions, CRF variable QP, fMP4 pipeline, decoder reuse
- `wasm/test-realworld.mjs` — 8 tests: baseline/main/high profiles, partial decode, error recovery, sequential decodes
- Run: `node wasm/test-validate-qp.mjs` and `node wasm/test-realworld.mjs`
