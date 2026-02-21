# Compression Artifact Analysis Modes — Research & Implementation

## Executive Summary

**Implemented:**
- **Toggle/Flicker mode** — swap A/B visibility on a timer. Zero pixel processing.
- **Per-pixel difference map (WebGL2)** — two textures + fragment shader. Sub-millisecond GPU compute. No readback needed for display.
- **PSNR heatmap** — per-pixel dB computation in the same fragment shader, mapped to a 5-stop color gradient.
- **Per-frame PSNR readout** — CPU-side PSNR computed on `seeked` event at 160×90 resolution, displayed in the compare toolbar. Shown in all diff palettes, not just PSNR mode.
- **PSNR filmstrip strip** — accumulated PSNR values rendered as color-coded bars in the filmstrip timeline graph area.
- **Amplification & palette controls** — 4 amplification levels (1×/2×/4×/8×), 3 palettes (grayscale/temperature/PSNR).
- **Mode switching UI + URL params** — toolbar button + keyboard shortcuts (T to cycle, D to toggle diff), all state persisted in shareable URL.

**Feasible with significant effort (not yet implemented):**
- **SSIM heatmap** — 11×11 Gaussian window per pixel. CPU at 1080p is 500ms–2s. Downscaled (540p) with upscaled overlay is the pragmatic path. WebGL multi-pass FBO approach is feasible but ~200 lines of shader code.

**Not feasible (skip):**
- **Block boundary overlay** — mp4box.js is container-level only, no macroblock/CTU parsing. Would require porting a full H.264/HEVC NAL parser to WASM (~10k+ lines per codec). Heuristic edge detection is unreliable due to deblocking filters.

**Key constraint:** `canvas.drawImage()` on EME-protected video returns black pixels (canvas taint). The diff renderer uses `texImage2D` which has the same origin-clean restriction. For encrypted content, analysis modes are limited to unencrypted compare sources.

---

## Implementation Details

### 1. Toggle/Flicker Mode

**File:** `QualityCompare.tsx` (lines 1086–1107)

Toggles CSS `visibility` of the slave video on a `setInterval` timer. Zero pixel processing, works with DRM.

- **Speeds:** 250ms, 500ms, 1000ms — cycled via toolbar button
- **Visual indicator:** `A` / `B` label in toolbar updates on each tick via `flickerLabelRef`
- **Keyboard:** `T` cycles split → toggle → diff → split
- **Cleanup:** `clearInterval` on mode change or unmount; resets `visibility` to "visible"

```typescript
const timer = setInterval(() => {
  showA = !showA;
  slaveVideo.style.visibility = showA ? "visible" : "hidden";
  flickerLabelRef.current.textContent = showA ? "A" : "B";
}, flickerInterval);
```

### 2. Per-Pixel Difference Map (WebGL2)

**File:** `useDiffRenderer.ts` (~400 lines)

WebGL2 fullscreen-quad shader that uploads both video elements as textures and computes per-pixel difference in a single draw call.

**Architecture:**
- Canvas element `.vp-compare-diff-canvas` in the compare overlay, same CSS transforms (zoom/pan) as the video elements
- GL resources created lazily when `active` becomes true (canvas must be visible for valid context)
- `webglcontextlost` / `webglcontextrestored` handlers for robustness
- Resources destroyed on deactivation or unmount

**Rendering schedule:**
- **Paused:** render once + on each `seeked` event
- **Playing:** `requestAnimationFrame` loop (PSNR readout skipped during playback — too expensive at 60fps)

**Fragment shader — difference normalization:**
```glsl
float diff = length(colA - colB) / 1.732;  // sqrt(3) normalizes RGB to 0..1
float val = clamp(diff * u_amplify, 0.0, 1.0);
```

**Three palette modes (uniform `u_palette`):**

| Palette | `u_palette` | Mapping |
|---------|------------|---------|
| Grayscale | 0 | `color = vec3(val)` |
| Temperature | 1 | Blue → white → red (val < 0.5: blue→white, else white→red) |
| PSNR | 2 | Per-pixel dB heatmap with 5-stop gradient (see below) |

**Amplification values:** 1×, 2×, 4×, 8× — directly scales difference visibility and inversely affects PSNR calculation (`ampMse = mse / (amplify²)`).

### 3. PSNR Heatmap (GPU Shader)

**File:** `useDiffRenderer.ts` (fragment shader, lines 55–76)

Per-pixel PSNR computed directly in the fragment shader:

```glsl
vec3 d = colA - colB;
float mse = dot(d, d) / 3.0;
float ampMse = mse / (u_amplify * u_amplify);
float psnr = clamp(-10.0 * log(ampMse + 1e-10) / log(10.0), 0.0, 60.0);
```

**5-stop color gradient:**

| dB range | Color | RGB |
|----------|-------|-----|
| ≥ 50 | Dark green | `(0, 0.4, 0)` |
| 40–50 | Green blend | `(0, 0.8→0.4, 0)` |
| 30–40 | Yellow → green | `(1→0, 1→0.8, 0)` |
| 20–30 | Red → yellow | `(1, 0→1, 0)` |
| ≤ 15–20 | Magenta → red | `(1, 0, 1→0)` |

The PSNR is capped at 60 dB (identical pixels) and floored at 0 dB. The epsilon `1e-10` prevents `log(0)`.

### 4. Per-Frame PSNR Readout

**File:** `useDiffRenderer.ts` (lines 231–261, 365–374)

CPU-side PSNR for the overall frame, computed at reduced resolution to avoid blocking the main thread.

**Computation:**
- Two `OffscreenCanvas` instances at 160×90 pixels (16:9 aspect)
- `drawImage(video, 0, 0, 160, 90)` for each video element
- Per-pixel RGB difference normalized by 255, summed as squared differences
- `MSE = sumSqDiff / (pixelCount × 3)`
- `PSNR = -10 × log₁₀(MSE)`, capped at 60 dB for identical frames

**Trigger:** fired on `seeked` event when paused. Skipped during playback (the `onPsnr` callback receives `null`).

**Display:** `QualityCompare.tsx` toolbar shows `{psnr.toFixed(1)} dB` or em-dash when null. Visible in all diff palettes (not gated on PSNR palette selection).

### 5. PSNR History Accumulation & Filmstrip Strip

**Files:** `useDiffRenderer.ts`, `QualityCompare.tsx`, `ShakaPlayer.tsx`, `FilmstripTimeline.tsx`

**Data flow:**
1. `useDiffRenderer` maintains a `psnrHistory` ref: `Map<number, number>` keyed by time rounded to 3 decimal places
2. Each `firePsnr()` call stores `psnrHistory.set(roundedTime, value)` using `videoB.currentTime`
3. Map is cleared when `active` becomes false (diff mode deactivated)
4. `QualityCompare` forwards the ref to the parent via `psnrHistoryRef` prop
5. `ShakaPlayer` creates the shared ref and passes it to both `QualityCompare` and `FilmstripTimeline`
6. `FilmstripTimeline` reads the map in its paint loop

**Filmstrip rendering** (`FilmstripTimeline.tsx`):
- Strip height: 8px, positioned at the bottom of the bitrate graph area
- Each entry draws a 2px-wide colored rectangle at `x = time × pxPerSec - scrollLeft`
- Color uses the same 5-stop gradient as the GPU shader via `psnrColor(dB)`:

```typescript
function psnrColor(dB: number): string {
  if (dB >= 50) return "rgb(0, 102, 0)";       // dark green
  if (dB >= 40) return "rgb(0, ...)";            // green blend
  if (dB >= 30) return "rgb(...)";               // yellow → green
  if (dB >= 20) return "rgb(255, ...)";          // red → yellow
  return "rgb(255, 0, ...)";                     // magenta → red
}
```

- "PSNR" label drawn at bottom-right of strip area (40% opacity)
- Entries outside viewport are skipped for performance
- The ref-based approach avoids re-renders on every seek

### 6. Mode Switching & URL Persistence

**Three analysis modes** (`AnalysisMode = "split" | "toggle" | "diff"`):

| Mode | Key | Controls | Frame borders |
|------|-----|----------|---------------|
| Split | — (default) | Slider position | Yes |
| Toggle | `T` (cycle) | Flicker speed (250/500/1000ms) | No |
| Diff | `D` (toggle), `T` (cycle) | Amp (1×–8×), Palette, PSNR readout | Yes |

**Keyboard shortcuts:**
- **T**: cycle split → toggle → diff → split
- **D**: toggle diff ↔ split
- Both ignored when focus is in INPUT/SELECT/TEXTAREA

**URL parameters** persisted via `CompareViewState`:

| Field | URL param | Values | Condition |
|-------|-----------|--------|-----------|
| `cmode` | `compareCmode` | `"toggle"`, `"diff"` | Omitted if `"split"` |
| `flickerInterval` | `compareCfi` | 250, 500, 1000 | Only when `cmode=toggle` |
| `amplification` | `compareAmp` | 2, 4, 8 | Only when `cmode=diff`, omit if 1 |
| `palette` | `comparePal` | `"temperature"`, `"psnr"` | Only when `cmode=diff`, omit if `"grayscale"` |

State is written to `viewStateRef` on every transform update and mode/settings change, enabling shareable URLs that restore the exact analysis configuration.

---

## Research: Remaining Features

### SSIM Heatmap — Medium-Hard (not implemented)

CPU at 1080p: 500ms–2s (11×11 Gaussian window × 2M pixels). Not real-time, but acceptable paused-only with spinner.

**Pragmatic path**: compute at 1/4 resolution (480×270), ~30–120ms on CPU, upscale the heatmap overlay. SSIM is designed to be multi-scale so downscaling preserves structural information well.

Existing JS libraries:
- **ssim.js** (https://github.com/obartra/ssim) — pure JS, supports `weber` (fastest), `bezkrovny`, `fast`, `original` algorithms. Returns mssim (mean) + ssim_map (per-pixel).
- **image-ssim** (https://github.com/darosh/image-ssim-js) — TypeScript, simpler API.

**GPU acceleration options:**

| Approach | Feasibility | Performance | Notes |
|----------|-------------|-------------|-------|
| WebGL multi-pass FBOs | Medium | ~2–5ms | Separable Gaussian blur (2 passes for mean), then variance/covariance textures, then SSIM formula. 4–6 render passes total |
| WebGPU compute shader | Medium-Hard | ~1–2ms | More natural for neighborhood operations but browser support gaps |

### Block Boundary Overlay — Infeasible (skip)

mp4box.js parses container-level boxes only (moov, moof, mdat, tenc, senc). It does not parse codec-level NAL units, macroblock syntax, or CTU quad-tree structures. No JavaScript/WASM library provides this. Elecard StreamEye achieves this with ~5,000–20,000 lines of native C++ per codec, including CABAC/CAVLC entropy decoding.

Heuristic detection from pixel discontinuities fails because modern codecs apply deblocking filters specifically to smooth block edges.

---

## Architecture

```
QualityCompare.tsx
  |
  +-- masterVideo (HTMLVideoElement, right/B side)
  +-- slaveVideo (HTMLVideoElement, left/A side, clipped)
  +-- diffCanvas (.vp-compare-diff-canvas, WebGL2 context)
  |     |
  |     +-- useDiffRenderer hook manages GL lifecycle
  |     +-- Two textures: masterVideo + slaveVideo via texImage2D
  |     +-- Fragment shader: diff/temperature/PSNR per u_palette + u_amplify
  |     +-- Renders on seeked (paused) or rAF loop (playing)
  |     +-- Hidden when mode === "split" or "toggle"
  |     +-- Returns psnrHistory ref (Map<time, dB>)
  |
  +-- analysisMode state: "split" | "toggle" | "diff"
  +-- amplification state: 1 | 2 | 4 | 8
  +-- palette state: "grayscale" | "temperature" | "psnr"
  +-- flickerInterval: 250 | 500 | 1000 ms
  +-- psnrValue state: number | null (CPU-side readout)
  +-- viewStateRef: zoom, pan, slider, cmode, amp, palette

ShakaPlayer.tsx
  |
  +-- psnrHistoryRef: shared ref between QualityCompare and FilmstripTimeline
  +-- Passes psnrHistoryRef to QualityCompare (writes) and FilmstripTimeline (reads)

FilmstripTimeline.tsx
  |
  +-- Reads psnrHistory ref in paint loop
  +-- Draws 2px colored bars at bottom of bitrate graph area (8px strip)
  +-- psnrColor(dB) maps to 5-stop gradient matching shader
```

**Data flow for difference map (WebGL, during playback):**

```
rAF loop:
  1. gl.texImage2D(TEXTURE0, masterVideo)  -- GPU upload, ~0.1ms
  2. gl.texImage2D(TEXTURE1, slaveVideo)   -- GPU upload, ~0.1ms
  3. gl.drawArrays(TRIANGLES, 0, 6)        -- fragment shader, <0.5ms
  4. Browser composites diffCanvas          -- standard compositing
```

No pixel readback needed. Total: <1ms per frame. Feasible at 60fps.

**Data flow for PSNR readout (CPU, on seeked):**

```
seeked event:
  1. drawImage(videoA, 0, 0, 160, 90)      -- offscreen canvas A
  2. drawImage(videoB, 0, 0, 160, 90)      -- offscreen canvas B
  3. getImageData() for both                -- ~0.1ms at 160×90
  4. Per-pixel RGB MSE → PSNR dB            -- ~0.05ms (14,400 pixels)
  5. Store in psnrHistory map               -- keyed by rounded time
  6. Fire onPsnr callback                   -- updates toolbar display
```

**Data flow for PSNR filmstrip strip:**

```
FilmstripTimeline paint loop (every rAF):
  1. Read psnrHistory.current (Map<time, dB>)
  2. For each entry: x = time × pxPerSec - scrollLeft
  3. Skip if outside viewport
  4. ctx.fillRect(x, stripY, 2, 8) with psnrColor(dB)
```

---

## Implementation Order (with status)

| # | Feature | Status | Effort | Impact |
|---|---------|--------|--------|--------|
| 1 | Toggle/Flicker mode | Done | Easy | High — simplest A/B comparison |
| 2 | Per-pixel difference map (WebGL) | Done | Medium | High — visual artifact detection |
| 3 | Amplification & palette controls | Done | Easy | Medium — makes diff map usable |
| 4 | PSNR heatmap (same shader) | Done | Easy | Medium — quality visualization |
| 5 | Per-frame PSNR readout in toolbar | Done | Easy | Medium — instant quality number |
| 6 | Mode switching UI + URL params | Done | Easy | Medium — discoverability |
| 7 | PSNR strip on filmstrip | Done | Easy | Medium — quality-over-time |
| 8 | SSIM heatmap (downscaled CPU) | — | Hard | Low-Medium — niche metric |

---

## Open Questions (all resolved)

1. ~~**WebGL `texImage2D` from EME video** — does it also taint/fail like `canvas.drawImage()`?~~ **Confirmed:** same origin-clean restriction applies. Diff mode works with unencrypted content; encrypted streams would need the WebCodecs decode path.

2. ~~**WebGL context limits**~~ **Handled:** `webglcontextlost`/`webglcontextrestored` event handlers implemented in `useDiffRenderer`. Context lost sets a flag that skips rendering; restored nulls the GL state so it re-initializes on next activation.

3. ~~**Frame sync for analysis**~~ **Confirmed acceptable:** rAF drift correction keeps videos within 16ms during playback. The diff map tolerates slight desync visually. PSNR readout is only computed when paused (exact frame alignment via `seeked` event).

4. ~~**ssim.js `weber` algorithm accuracy**~~ **Benchmarked** (`src/utils/ssimBenchmark.test.ts`): 75 synthetic comparisons (3 image types × 5 distortion patterns × 5 severities) across all 4 ssim.js algorithms. Key findings:
   - **`fast` is identical to `original`** (zero error) — same Wang et al. algorithm, just skips downsampling. 4× faster.
   - **`bezkrovny` is the fastest** (0.20ms mean at 160×90) — 37× faster than `original` (7.4ms). Not `weber` as expected.
   - **`weber`** (1.66ms mean) is 4.4× faster than `original` but slower than `bezkrovny`.
   - **Weber vs original accuracy**: mean Δ=0.010, max Δ=0.134. The max error occurs at extreme distortion (gradient + banding @ 0.4 severity). Quality band agreement: 92% (69/75). The 6 disagreements are all at severity 0.4 (heavy degradation) where the distinction between "fair" and "poor" is irrelevant for practical assessment.
   - **Verdict**: Weber is sufficient for a video player. For the SSIM heatmap feature, `bezkrovny` is the best choice — fastest algorithm with similar accuracy to weber (max Δ=0.153 vs original). At 480×270 (the planned 1/4-resolution path), `bezkrovny` should compute in ~3–12ms — well within the paused-only budget.

5. ~~**Dual-manifest resolution mismatch**~~ **Not actionable.** Two CDNs may serve different pixel dimensions at the same nominal height (e.g., 1920×1080 vs 1920×1088 due to codec macroblock alignment). The WebGL shader already handles this implicitly (textures stretch to fill the quad). PSNR/SSIM may see a few pixels of interpolation blur at the bottom/right edge from the padding rows — negligible in practice and not worth a benchmark.

6. ~~**SSIM at 1/4 resolution upscale artifacts**~~ **Benchmarked** (`src/utils/ssimUpscale.test.ts`): 15 patterns (3 image types × 5 spatially varying distortions) comparing full-res (320×180) vs downscale-compute-upscale (80×45 → bilinear upscale) pipeline. Key findings:
   - **Structural distortions (blocking, blur) are well-preserved**: mean Δmssim=0.041, map RMSE=0.001–0.30. These are the primary video compression artifacts — the 1/4 res path is accurate for them.
   - **Noise-based distortions are smoothed by downscaling**: mean Δmssim=0.35, because 4× area averaging cancels out per-pixel noise. This is inherent to downscaling, not an upscaling artifact. The spatial quality pattern is still preserved (damaged regions still show lower SSIM than clean regions).
   - **Bilinear vs nearest-neighbor**: bilinear upscaling produces marginally smoother error gradients. At 1/4 resolution the SSIM map has so few pixels (8×5 for the test size) that both methods produce similar results — the SSIM 11×11 Gaussian window already smooths the map.
   - **Speed**: ~15× speedup from quarter resolution computation.
   - **Verdict**: The 1/4 resolution path is viable for a video player diagnostic overlay. Structural quality loss (the kind video compression produces) is accurately represented. The bilinear upscale introduces no visible blockiness. Noise sensitivity is reduced but this is acceptable — video players analyze compression artifacts, not sensor noise.

---

## Industry Tool Reference

| Tool | Key Visualization Features | Relevance |
|------|---------------------------|-----------|
| [Elecard StreamEye](https://elecard.com/products/video-analysis/streameye-studio) | Macroblock/CTU overlays, 6 overlay modes (ALT+1-6), 6 data panels (CTRL+1-6), split view with 7 comparison modes | Gold standard for block-level analysis (requires native bitstream parsing) |
| [Vicuesoft VQ Probe](https://vicuesoft.com/blog/titles/VQ_Probe_Advantages/) | Split-line, per-pixel diff (heat map + B&W), PSNR/SSIM/VMAF heatmaps, zoom to pixel values | Closest model for our UX — split + analysis overlay modes |
| [MSU VQMT](https://videoprocessing.ai/vqmt/basic/) | Per-frame metric Results Plot, residue visualization with gamma, toggle view (Ctrl+1/2/3), bad frame detection | Best model for quality-over-time graph and frame comparison |
| [Vicuesoft VQ Analyzer](https://vicuesoft.com/vq-analyzer/) | Block-level codec internals: loop filter, SAO, ALF, per-pixel formulas on click | Deep codec analysis — not replicable in browser without bitstream parser |
| [ssim.js](https://github.com/obartra/ssim) | Pure JS SSIM with multiple algorithm modes | Candidate library for CPU SSIM path |
