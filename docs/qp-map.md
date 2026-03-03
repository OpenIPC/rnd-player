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

## Scope

- **Codec**: H.264 only (avc1.* codec string)
- **Trigger**: Paused frames only (clears on play)
- **Rendering**: Canvas 2D overlay with pointer-events: none
- **Letterboxing**: Accounts for object-fit: contain in fullscreen

## Files

- `wasm/jm264_wrapper.c` — C wrapper for JM reference decoder
- `wasm/jm264_overrides.h` — Compile-time stubs for file I/O
- `wasm/build-jm264.sh` — Emscripten build script
- `src/wasm/jm264Decoder.ts` — TypeScript WASM loader
- `src/types/qpMapWorker.types.ts` — Worker message types
- `src/workers/qpMapWorker.ts` — QP extraction worker
- `src/hooks/useQpHeatmap.ts` — React hook
- `src/components/QpHeatmapOverlay.tsx` — Canvas overlay component
