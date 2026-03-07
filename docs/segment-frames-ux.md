# Segment Frames Panel — UX Enhancement Plan

The `SegmentFramesModal` shows a grid of all decoded frames from a single DASH segment. Current state: frame thumbnail + color-coded type badge (I/P/B) + index + encoded size + timing + QP heatmap overlay. This document covers implemented features (Phase 1–2) and planned extensions (Phase 3–4).

## Data Flow

```
thumbnailWorker.ts
  extractAllSamplesFromSegment()  →  mp4box samples (cts, dts, duration, timescale, size, is_sync)
  classifyFrameTypes()            →  GopFrame[] { type: I|P|B, size: number }
  VideoDecoder                    →  ImageBitmap per frame

SegmentFrame message → { frameIndex, totalFrames, bitmap, frameType, sizeBytes, cts, dts, duration }

qpMapWorker.ts (when QP toggle is active)
  decodeSegmentQp message         →  WASM multi-frame decode → QpMapSegmentResult
  Per-frame: { qpValues, avgQp, minQp, maxQp }
  Segment-level: { widthMbs, heightMbs, blockSize, globalMinQp, globalMaxQp }
```

## Phase 1 — Enhanced Metadata (Implemented)

### 1.1 Frame Size Bar Chart

`SizeBarChart` component — a horizontal canvas strip between the header and the frame grid.

- One bar per frame, color-coded by type (I=red, P=blue, B=green)
- Height proportional to `sizeBytes / maxSizeBytes`
- Click a bar → scrolls the corresponding frame card into view
- Hover tooltip: `#N  I  42.1 KB`
- Single `<canvas>` element for performance (DPR-aware rendering)

### 1.2 Segment Summary Stats

`SegmentStats` component — a compact stats row below the header:

- **I/P/B count**: e.g. `1I 3P 8B` (color-coded, hover shows full GOP pattern)
- **Total size**: sum of all frame sizes
- **Avg bitrate**: `totalSize * 8 / segDuration`
- **Avg bpp**: bits per pixel across all frames
- **Size ratio**: `I:5.2 P:1.4 B:1.0` normalized to smallest non-zero average

### 1.3 Per-Frame Metadata

Two metadata rows per frame card:

**Row 1** (`vp-segment-frame-meta`): frame type badge, `#index`, QP (when available), size

**Row 2** (`vp-segment-frame-meta2`):
- PTS (3 decimal places)
- DTS (only shown if different from PTS, indicating B-frame reordering)
- Duration in ms
- bits/px: `sizeBytes * 8 / (width * height)`

### 1.4 Full-Size Frame Preview

Click any frame thumbnail to open a full-screen preview:
- Arrow key / button navigation between frames
- ESC to close (capture phase so it doesn't close the modal)
- Info bar: type, index, size, PTS, DTS, duration, bpp, QP (when available), dimensions

### Data Changes (Phase 1)

Worker `SegmentFrame` message extended with `cts`, `dts`, `duration` fields. Timing is sent directly from the worker where mp4box samples are in scope — no changes to `GopFrame` type.

## Phase 2 — Per-Frame QP Maps (Implemented)

### Architecture

Three layers of changes enable per-frame QP extraction:

**Layer 1 — C/C++ WASM wrappers** (`wasm/jm264_wrapper.c`, `hm265_wrapper.cpp`, `dav1d_wrapper.c`):

Each wrapper's `QpContext` struct extended with:
```c
#define MAX_QP_FRAMES 128
uint8_t *qp_frames[MAX_QP_FRAMES];   // per-frame QP map pointers
int qp_frame_sizes[MAX_QP_FRAMES];   // size of each QP map
int qp_frame_count;                   // number of captured frames
int multi_frame_mode;                 // 0 = legacy single-frame, 1 = capture all
```

New exported functions (same pattern for all three codecs):
- `*_qp_set_multi_frame(ctx, enable)` — switches between single/multi-frame mode
- `*_qp_get_frame_count(ctx)` — returns number of captured QP maps
- `*_qp_copy_frame_qps(ctx, frame_idx, out, max)` — copies specific frame's QP data

Codec-specific capture changes:
- **H.264 (JM)**: `jm264_on_frame_decoded()` — in multi-frame mode, appends every frame's QP map (not just IDR). Single-frame mode unchanged (backward compatible).
- **H.265 (HM)**: `hm265_on_frame_output()` / `hm265_on_flush_output()` — call `maybe_append_multi_frame()` after `capture_qp_from_list()` to store each frame's QP.
- **AV1 (dav1d)**: `dav1d_qp_decode()` — in multi-frame mode, loops over all `dav1d_get_picture()` results instead of returning after the first. Calls `maybe_append_multi_frame()` after each `expand_sb_to_8x8()`.

**Layer 2 — TypeScript decoder wrappers** (`src/wasm/jm264Decoder.ts`, `hm265Decoder.ts`, `dav1dDecoder.ts`):

Each instance interface extended with:
```typescript
setMultiFrame(enable: boolean): void;
getFrameCount(): number;
copyFrameQps(index: number): { qpValues: Uint8Array; count: number };
```

**Layer 3 — Worker message API** (`src/types/qpMapWorker.types.ts`, `src/workers/qpMapWorker.ts`):

New request type:
```typescript
interface QpMapDecodeSegmentRequest {
  type: "decodeSegmentQp";
  initSegment: ArrayBuffer;
  mediaSegment: ArrayBuffer;
  codec: "h264" | "h265" | "av1";
  clearKeyHex?: string;
}
```

New response type:
```typescript
interface QpMapSegmentResult {
  type: "qpSegment";
  frames: PerFrameQp[];          // one entry per decoded frame
  widthMbs: number;              // block grid width (same for all frames)
  heightMbs: number;             // block grid height
  blockSize: number;             // 16 (H.264) or 8 (H.265/AV1)
  globalMinQp: number;           // min QP across all frames
  globalMaxQp: number;           // max QP across all frames
}

interface PerFrameQp {
  qpValues: Uint8Array;          // flat array, one value per block, raster order
  avgQp: number;                 // mean QP for the frame
  minQp: number;
  maxQp: number;
}
```

The worker's `handleDecodeSegmentQp()` creates a fresh decoder, enables multi-frame mode, feeds the full segment, then copies each frame's QP map. All `qpValues` buffers are transferred (zero-copy) via `postMessage`.

### UI Components

**`useSegmentQp` hook** (inside `SegmentFramesModal.tsx`):
- Resolves init/media segment URLs from Shaka player's variant tracks and segment index
- Spawns a dedicated `qpMapWorker` when QP toggle is activated
- Fetches segments, sends `decodeSegmentQp` message, stores `QpMapSegmentResult`
- Cleans up worker on unmount or toggle-off

**QP toggle button** (`vp-segment-qp-toggle`):
- Appears in the modal header when the active codec supports QP (H.264/H.265/AV1)
- Blue highlight when active, spinner during decode
- Off by default — QP decode is opt-in (it's slower than frame decode)

**QP legend strip** (`vp-segment-qp-legend`):
- Appears below the size bar chart when QP is active
- Shows the 5-stop color gradient bar (blue→cyan→green→yellow→red) with global QP range

**`QpOverlayCanvas` component**:
- Renders a semi-transparent (alpha=0.5) heatmap canvas over each frame thumbnail
- Uses the same 5-stop gradient as `QpHeatmapOverlay` on the main video
- All frames share a consistent color scale (global min/max across the segment)
- Also rendered in the full-size preview when QP is active

**Per-frame average QP**:
- Shown in the metadata row: `QP 28.3`
- Shown in the full-size preview info bar
- Tooltip shows per-frame min–max range

### Props Flow

```
FilmstripTimeline (has player, clearKey)
  └→ SegmentFramesModal (receives player, clearKey as new props)
       └→ useSegmentQp(player, segmentStartTime, showQp, clearKey)
            └→ qpMapWorker (decodeSegmentQp message)
```

### Backward Compatibility

- Single-frame QP mode (main video overlay via `useQpHeatmap`) is unchanged
- WASM wrappers default to `multi_frame_mode=0` — existing `decode`/`copyQps` API works identically
- Existing validation tests (32 tests), real-world tests (8 tests), and DASH tests (9 tests) all pass

## Phase 3 — New Data Extraction (Planned)

### 3.1 Prediction Mode Map

Add capture of prediction mode per block:
- H.264: `mb_data[i].mb_type` → intra/inter/skip classification
- H.265: `pCtu->getPredictionMode()` + `pCtu->isSkipped()` → intra/inter/skip
- AV1: `b->intra` + `b->skip` → intra/inter/skip

Overlay: yellow=intra, blue=inter, dark=skip. Toggle "Modes" button.

### 3.2 Partition Structure Overlay

Draw block partition boundaries:
- H.264: fixed 16x16 (no variation — skip this codec)
- H.265: `pCtu->getDepth()` quad-tree → draw borders at CU boundaries
- AV1: recursive partition → draw borders at block boundaries

### 3.3 Motion Vector Field

Extract MVs per block and render as arrow overlay:
- H.264: `dec_picture->mv_info` array
- H.265: `pCtu->getCUMvField()->getMv()` per partition
- AV1: `b->mv` per block

## Phase 4 — Advanced (Planned)

### 4.1 Frame Diff / Residual View

Compute `|frame[n] - frame[n-1]|` from decoded bitmaps (already available). Amplify and display as grayscale overlay. No WASM changes — pure pixel math on existing ImageBitmaps.

### 4.2 Temporal Complexity Graph

Plot frame sizes normalized by type (compared to type average) to identify outlier frames that consumed unusually many or few bits.
