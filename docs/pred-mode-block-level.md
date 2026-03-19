# Per-Block Prediction Mode: H.265/AV1 Limitations

## Status

- **H.264 (JM)**: Per-macroblock intra/inter/skip — fully working
- **H.265 (HM)**: Frame-level only (from NALU type) — per-block deferred
- **AV1 (dav1d)**: Frame-level only (from frame_type) — per-block deferred

## Problem

### H.265 / HM

HM's `TComDataCU` stores per-block prediction modes (`getPredictionMode()`, `isSkipped()`) in CTU partition data. These are valid after `copyToPic()` runs during decode. However, when decoding an **isolated DASH segment**, HM only fully reconstructs ~3 pictures (the IDR and 1–2 adjacent frames). The remaining P/B frames fail silently during decode because:

1. **DPB reference management**: P/B frames reference pictures from previous segments that aren't in the DPB. HM's error concealment doesn't mark them as reconstructed.
2. **Output ordering**: `xWriteOutput()` gates output on DPB fullness (`numPicsNotYetDisplayed > numReorderPicsHighestTid`). With a short segment, most pictures never meet the threshold.
3. **Flush behavior**: `xFlushOutput()` only processes pictures with `getOutputMark()=true`. Pictures that were never marked for output are destroyed without being captured.

Result: `getFrameCount()` returns ~3 for a 72-frame segment. All 3 frames have identical QP/mode data from the IDR.

### AV1 / dav1d

dav1d's QP capture hooks into superblock boundaries in `decode.c` via a patched `ts->last_qidx` read. Block-level prediction type (intra/inter/skip) is determined deeper, in `decode_b()`, which processes individual coding blocks within each superblock. The current QP patch only captures at the SB level — it doesn't have access to per-block prediction decisions.

Adding per-block mode capture would require:
1. A second global grid (`g_mode_sb_grid`) populated in `decode_b()`
2. Mapping CU-level prediction type to the 8×8 output grid
3. Handling variable block sizes (4×4 to 128×128)

## Current Workaround

For H.265 and AV1, the JS worker (`qpMapWorker.ts`) determines per-sample prediction mode from **NALU/OBU types** directly:

- **H.265**: `extractPerSampleModesHEVC()` scans each fMP4 sample's first VCL NALU. Types 16–23 (BLA/IDR/CRA) → intra, types 0–15 → inter.
- **AV1**: `dav1d_wrapper.c` checks `pic.frame_hdr->frame_type == DAV1D_FRAME_TYPE_KEY` → intra, else inter.

This gives correct **frame-level** classification (the whole frame is one color) but no block-level variation within a frame.

## Investigation Paths

### H.265: Force HM to decode all frames

Options explored:
- **Per-picture callback in `xFlushOutput`**: Added `hm265_on_pic_output()` for each picture before `destroy()`. Only captures pictures with `getReconMark()` — most P/B frames don't have it set.
- **Capture in `xWriteOutput` loop**: Added callback for non-output-mark pictures. Captures 1 additional frame but most still missing.
- **POC-based dedup**: Tracks captured POCs to avoid duplicates. Works but doesn't increase the number of unique frames.

Unexplored:
- **Patch HM's DPB error handling**: Make reference picture errors non-fatal (like JM's `non_conforming_stream=1`). Allow P/B decode to complete even with missing references. QP and prediction mode would still be valid even if pixel output is wrong.
- **Feed multiple segments**: Concatenate adjacent segments to give HM enough reference pictures. Complex — requires segment URL discovery and sequential decode.
- **Alternative HEVC decoder**: Use a more tolerant decoder (e.g., FFmpeg's hevc decoder compiled to WASM). FFmpeg's decoder handles missing references more gracefully.

### AV1: Patch dav1d decode_b()

The `decode_b()` function in `src/decode.c` processes each coding block and has access to:
- `b->intra` (1 = intra, 0 = inter)
- `b->skip` (skip mode)
- Block position and size

A patch similar to the QP SB-grid capture could store prediction type per block into a global grid, then expand to 8×8 in the wrapper. This is mechanical but requires careful handling of dav1d's variable block sizes and tile threading.
