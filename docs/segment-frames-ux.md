# Segment Frames Panel — UX Enhancement Plan

The `SegmentFramesModal` shows a grid of all decoded frames from a single DASH segment. Current state: frame thumbnail + color-coded type badge (I/P/B) + index + encoded size. This plan adds richer diagnostics using data already available from the decode pipeline and the WASM reference decoders.

## Current Data Flow

```
thumbnailWorker.ts
  extractAllSamplesFromSegment()  →  mp4box samples (cts, dts, duration, timescale, size, is_sync)
  classifyFrameTypes()            →  GopFrame[] { type: I|P|B, size: number }
  VideoDecoder                    →  ImageBitmap per frame

SegmentFrame message → { frameIndex, totalFrames, bitmap, frameType, sizeBytes }
```

Only `frameType` and `sizeBytes` are surfaced. CTS/DTS/duration are available in the worker but not forwarded.

## Phase 1 — No WASM Changes (Current Data)

### 1.1 Frame Size Bar Chart

A horizontal bar chart strip between the header and the frame grid. One bar per frame, color-coded by type (I=red, P=blue, B=green), height proportional to `sizeBytes / maxSizeBytes`.

- Bars rendered as a single `<canvas>` for performance
- Click a bar → scroll the corresponding frame card into view
- Hover tooltip: `#N  I  42.1 KB`
- Shows bit allocation pattern at a glance (I-frame spike, P/B ratio)

### 1.2 Segment Summary Stats

A stats row in the header area showing computed aggregates:

- **GOP pattern**: e.g. `I B B P B B P B B P` (from frame types in order)
- **Total size**: sum of all frame sizes
- **Avg frame size**: total / count
- **I/P/B count**: e.g. `1I 3P 8B`
- **Avg bitrate**: `totalSize * 8 / segDuration`
- **Size ratio**: `avgI : avgP : avgB` normalized (e.g. `5.2 : 1.4 : 1.0`)

Displayed as a compact single line below the title/duration.

### 1.3 Enhanced Per-Frame Metadata

Extend the worker message to include CTS, DTS, and duration. Add a second metadata row per card:

- **PTS** (presentation timestamp in seconds, 3 decimal places)
- **DTS** (decode timestamp — only shown if different from PTS, indicating reordering)
- **Duration** (frame duration in ms)
- **bits/px**: `sizeBytes * 8 / (width * height)` — quality-normalized metric

The second row is always visible (not collapsed) since media engineers want this data.

### Data Changes for Phase 1

**Worker message** — add fields to `segmentFrame`:
```typescript
// New fields on SegmentFrame
cts: number;        // composition time in seconds
dts: number;        // decode time in seconds
duration: number;   // frame duration in seconds
```

**GopFrame** — extend to carry timing:
No change needed. Timing is sent directly in segmentFrame message from the worker where samples are in scope.

## Phase 2 — Per-Frame QP Maps (WASM + Worker Changes)

### Current state

The QP overlay on the main video already works for every segment — each segment starts with a key frame and the worker creates a fresh decoder per request. But each decode produces **one** QP map per segment:

- **H.264 (JM)**: `!frame_ready` guard in `jm264_on_frame_decoded` → captures only the first (IDR) frame
- **H.265 (HM)**: no guard, `capture_qp_from_list` overwrites on each frame → captures the **last** output frame
- **AV1 (dav1d)**: single `g_qp_sb_grid` buffer, returns after first `dav1d_get_picture` → captures the key frame

All three decoders decode the full segment but only return one QP map.

### 2.1 Per-Frame QP Heatmap Overlay

To show QP per frame in the segment frames modal, the WASM wrappers and worker need to return **N QP maps** (one per decoded frame). Changes needed:

- **WASM wrappers**: accumulate QP maps into a list (or callback per frame) instead of a single cache. H.264: remove `!frame_ready` guard, append to array. H.265: append instead of overwrite. AV1: capture per-picture instead of returning after first.
- **Worker API**: new message type `decodeSegmentQp` that returns an array of QP maps indexed by display order
- **UI**: toggle button in header: "QP" (off by default). When active, runs QP decode, renders semi-transparent heatmap canvas over each frame thumbnail. Consistent color scale across all frames (global min/max for the segment).

### 2.2 Average QP in Metadata

Even without the visual overlay, show the average QP value per frame in the metadata line. This is the single most-asked question: "what QP did this frame get?"

## Phase 3 — New Data Extraction (WASM Wrapper Extensions)

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

## Phase 4 — Advanced

### 4.1 Frame Diff / Residual View

Compute `|frame[n] - frame[n-1]|` from decoded bitmaps (already available). Amplify and display as grayscale overlay. No WASM changes — pure pixel math on existing ImageBitmaps.

### 4.2 Temporal Complexity Graph

Plot frame sizes normalized by type (compared to type average) to identify outlier frames that consumed unusually many or few bits.
