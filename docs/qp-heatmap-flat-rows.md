# QP Heatmap: Flat Row Patterns and Quality Control UI

## Problem

When viewing the QP heatmap overlay on certain streams, the heatmap appears as horizontal color bands rather than showing spatial variation around content features (logos, text, faces). Users expect an "efficient encoder" to concentrate bits (lower QP) on visually important regions and save bits (higher QP) on flat backgrounds.

## Root Cause: Encoder Configuration, Not a Player Bug

Validated against a real DASH stream (libx264-encoded, ISM/Smooth manifest):
- Three resolutions tested: 214p (397kbps), 428p (1.4Mbps), 804p (4Mbps)
- Two segments per resolution, all 72 frames per segment decoded

### Findings

**I-frames show good per-macroblock variation** at all resolutions:
- 214p: 17 distinct QP values, 0% constant rows
- 428p: 15 distinct QP values, 0% constant rows
- 804p: 17 distinct QP values, 0% constant rows

**P-frames are mostly row-constant:**
- 428p P-frames: typically 50-70% of rows have identical QP for every macroblock
- 804p P-frames: rows are ~80% constant with variations only at content edges
- Single dominant QP value covers 40-58% of all macroblocks in a frame

### Why

In H.264, each macroblock's QP is derived from the slice QP plus an optional `mb_qp_delta`. The stream's encoder (libx264) was configured without Adaptive Quantization (AQ), or with very low AQ strength. x264's AQ modes:

| Mode | Flag | Behavior |
|------|------|----------|
| None | `--no-aq` or `--aq-mode 0` | Flat QP per slice row — produces horizontal bands |
| Variance AQ | `--aq-mode 1` (default) | Adjusts QP based on block variance |
| Auto-variance | `--aq-mode 2` | Stronger adaptation, biases toward flat areas |
| Auto-variance biased | `--aq-mode 3` | Even stronger, better for dark scenes |

With AQ disabled (`aq-mode=0`), the rate control sets QP per slice (one row of macroblocks) and never emits `mb_qp_delta`, so every MB in a row gets the same QP. The heatmap correctly renders these as horizontal bands.

This is a common pattern in streams where:
- Encoding speed was prioritized over perceptual quality
- The encoder preset was `ultrafast`/`superfast` (which may disable AQ)
- The encoding pipeline didn't tune AQ parameters

## Verification

The QP extraction code is confirmed correct:
- `jm264_wrapper.c` reads `p_Vid->mb_data[i].qp` — this is the effective per-MB QP after all deltas
- I-frames at every resolution show rich 2D spatial variation (17 distinct values)
- The horizontal pattern appears only in P-frames of streams with low/no AQ

## Quality Control UI (Future Work)

The QP heatmap reveals encoder configuration quality, which is useful for QC workflows. Planned enhancements:

### AQ Detection Indicator

Detect and display whether the stream uses adaptive quantization:
- Compute per-row QP variance: `var(row) = mean((qp[i] - mean_qp_row)^2)`
- If mean row variance < threshold (e.g., 0.5) across P-frames → flag as "No AQ / flat QP"
- Display as a badge or tooltip on the QP legend: "AQ: none detected" / "AQ: active"

### Spatial Complexity vs QP Correlation

Show whether the encoder allocates bits where they matter:
- Compute per-MB spatial complexity from decoded pixels (variance of 16x16 block)
- Correlate with per-MB QP: negative correlation = good AQ (complex areas get lower QP)
- Display as a scatter plot or correlation coefficient

### QP Efficiency Score

A single metric combining:
- Intra-row QP variance (higher = more adaptive)
- QP-complexity correlation (more negative = better bit allocation)
- I-frame vs P-frame QP spread (wider = more aggressive rate control)

### Row-Constant Warning

When >50% of P-frame rows have zero intra-row QP variance, show a visual indicator on the heatmap overlay (e.g., a subtle "flat QP" label or a different legend style) so users understand the banding is from the encoder, not a rendering artifact.
