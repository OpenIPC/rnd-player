# Compression Artifact Analysis Modes — Research & Implementation

## Executive Summary

**Implemented:**
- **Toggle/Flicker mode** — swap A/B visibility on a timer. Zero pixel processing.
- **Per-pixel difference map (WebGL2)** — two textures + fragment shader. Sub-millisecond GPU compute. No readback needed for display.
- **PSNR heatmap** — per-pixel dB computation in the same fragment shader, mapped to a 5-stop color gradient.
- **Per-frame PSNR readout** — CPU-side PSNR computed on `seeked` event at 160×90 resolution, displayed in the compare toolbar. Shown in all diff palettes, not just PSNR mode.
- **PSNR filmstrip strip** — accumulated PSNR values rendered as color-coded bars in the filmstrip timeline graph area.
- **SSIM heatmap** — CPU-side ssim.js `bezkrovny` at 160×90, quantized to R8 texture, GPU bilinear-upscaled to full resolution in the fragment shader. 5-stop color gradient. Per-frame mssim readout in toolbar.
- **SSIM filmstrip strip** — accumulated SSIM values rendered as color-coded bars above the PSNR strip.
- **Amplification & palette controls** — 4 amplification levels (1×/2×/4×/8×), 4 palettes (grayscale/temperature/PSNR/SSIM).
- **Mode switching UI + URL params** — toolbar button + keyboard shortcuts (T to cycle, D to toggle diff), all state persisted in shareable URL.

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

**Four palette modes (uniform `u_palette`):**

| Palette | `u_palette` | Mapping |
|---------|------------|---------|
| Grayscale | 0 | `color = vec3(val)` |
| Temperature | 1 | Blue → white → red (val < 0.5: blue→white, else white→red) |
| PSNR | 2 | Per-pixel dB heatmap with 5-stop gradient (see below) |
| SSIM | 3 | Samples precomputed R8 SSIM map texture, 5-stop gradient (see section 6) |

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

### 6. SSIM Heatmap (CPU + GPU Hybrid)

**Files:** `useDiffRenderer.ts`, `QualityCompare.tsx`

SSIM cannot be computed per-pixel in a fragment shader because it requires an 11×11 Gaussian windowed operation. The approach: compute SSIM map on CPU using ssim.js at 160×90, upload as a WebGL texture, let the GPU bilinear-sample it at full resolution, and apply a 5-stop color gradient in the shader.

**CPU computation** (`computeSsimMap`):
- Uses ssim.js `bezkrovny` algorithm (~0.2ms at 160×90, benchmarked in Q4)
- Input: two `ImageData` objects from the same offscreen canvases used for PSNR
- Output: `ssim_map` (per-window SSIM values, ≈150×80 for 160×90 input — 11×11 window trims edges)
- Quantization: `float → Uint8Array` via `Math.round(clamp(val, 0, 1) × 255)`. 1/255 precision loss invisible in heatmap.

**GPU upload** (`uploadSsimMap`):
- R8 texture (single unsigned byte channel) — universal WebGL2 compatibility, no float extension needed
- `LINEAR` filter on both min and mag — gives free GPU bilinear upscaling from ≈150×80 to full resolution
- `UNPACK_ALIGNMENT` set to 1 before upload (R8 row widths are not 4-byte aligned by default)

**Fragment shader** (`u_palette == 3`):
```glsl
float s = texture(u_texSsim, v_texCoord).r;
```
Samples the small SSIM texture at full-res UV coords. GPU bilinear filtering interpolates between texels.

**5-stop color gradient:**

| SSIM range | Color | RGB |
|------------|-------|-----|
| ≥ 0.99 | Dark green | `(0, 0.4, 0)` |
| 0.95–0.99 | Green blend | `(0, 0.8→0.4, 0)` |
| 0.85–0.95 | Yellow → green | `(1→0, 1→0.8, 0)` |
| 0.70–0.85 | Red → yellow | `(1, 0→1, 0)` |
| ≤ 0.50–0.70 | Magenta → red | `(1, 0, 1→0)` |

**Metric readout:** toolbar shows `mssim.toFixed(4)` when SSIM palette is active, PSNR dB otherwise.

**Both metrics always computed:** `fireMetrics()` computes PSNR + SSIM on every `seeked` (total <0.5ms at 160×90). Both histories accumulate regardless of active palette.

**Key design decisions:**
- **R8 not R32F:** SSIM values 0–1 quantized to 0–255. No float extension needed, `LINEAR` filtering always supported on R8 in WebGL2.
- **GPU bilinear, no CPU upscale:** The SSIM map from 160×90 input is ≈150×80. Uploading as a small texture with `LINEAR` filter lets the GPU bilinear-upscale for free when sampling at full-res UVs. No CPU upscale code needed.
- **UNPACK_ALIGNMENT = 1:** WebGL2 defaults to 4-byte row alignment. For R8 textures with non-multiple-of-4 widths (e.g. 150), the default alignment causes row misalignment — the GPU reads padding bytes that aren't there, shifting every row. Setting alignment to 1 fixes this.
- **Paused-only computation:** Like PSNR, SSIM is only computed on seeked events. During playback, the texture retains the last-computed map; the readout shows a dash.

### 7. SSIM History Accumulation & Filmstrip Strip

**Files:** `useDiffRenderer.ts`, `QualityCompare.tsx`, `ShakaPlayer.tsx`, `FilmstripTimeline.tsx`

**Data flow:** Same pattern as PSNR history (section 5):
1. `useDiffRenderer` maintains `ssimHistory` ref: `Map<number, number>` keyed by time rounded to 3dp
2. Each `fireMetrics()` call stores `ssimHistory.set(roundedTime, mssim)`
3. Map is cleared when `active` becomes false
4. `QualityCompare` forwards the ref to the parent via `ssimHistoryRef` prop
5. `ShakaPlayer` creates the shared ref and passes to both `QualityCompare` and `FilmstripTimeline`
6. `FilmstripTimeline` reads the map in its paint loop

**Filmstrip rendering:**
- Strip height: 8px, positioned above the PSNR strip when both are present
- Color uses `ssimColor(s)` with the same 5-stop gradient as the shader
- "SSIM" label at bottom-right (40% opacity)

### 8. Mode Switching & URL Persistence

**Three analysis modes** (`AnalysisMode = "split" | "toggle" | "diff"`):

| Mode | Key | Controls | Frame borders |
|------|-----|----------|---------------|
| Split | — (default) | Slider position | Yes |
| Toggle | `T` (cycle) | Flicker speed (250/500/1000ms) | No |
| Diff | `D` (toggle), `T` (cycle) | Amp (1×–8×), Palette, PSNR/SSIM readout | Yes |

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
| `palette` | `comparePal` | `"temperature"`, `"psnr"`, `"ssim"` | Only when `cmode=diff`, omit if `"grayscale"` |

State is written to `viewStateRef` on every transform update and mode/settings change, enabling shareable URLs that restore the exact analysis configuration.

---

## Research: Remaining Features

### SSIM Heatmap — Implemented

Implemented via the CPU + GPU hybrid approach described in section 6. The ssim.js `bezkrovny` algorithm at 160×90 resolution computes in ~0.2ms. R8 texture with GPU bilinear sampling eliminated the need for CPU upscaling or multi-pass FBO shaders. Both PSNR and SSIM are computed together in `fireMetrics()` with a total budget under 0.5ms.

**Evaluated but not used:**
- GPU multi-pass FBO approach (~200 lines of shader code) — unnecessary given CPU compute at 160×90 is sub-millisecond
- WebGPU compute shader — browser support gaps, and CPU performance is already more than sufficient
- R32F texture — float extension not universally supported; R8 with 1/255 precision is invisible in heatmap

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
  |     +-- Three textures: masterVideo + slaveVideo via texImage2D, SSIM map (R8)
  |     +-- Fragment shader: diff/temperature/PSNR/SSIM per u_palette + u_amplify
  |     +-- Renders on seeked (paused) or rAF loop (playing)
  |     +-- Hidden when mode === "split" or "toggle"
  |     +-- Returns psnrHistory + ssimHistory refs (Map<time, value>)
  |
  +-- analysisMode state: "split" | "toggle" | "diff"
  +-- amplification state: 1 | 2 | 4 | 8
  +-- palette state: "grayscale" | "temperature" | "psnr" | "ssim"
  +-- flickerInterval: 250 | 500 | 1000 ms
  +-- psnrValue state: number | null (CPU-side readout)
  +-- ssimValue state: number | null (CPU-side mssim readout)
  +-- viewStateRef: zoom, pan, slider, cmode, amp, palette

ShakaPlayer.tsx
  |
  +-- psnrHistoryRef: shared ref between QualityCompare and FilmstripTimeline
  +-- ssimHistoryRef: shared ref between QualityCompare and FilmstripTimeline
  +-- Passes both to QualityCompare (writes) and FilmstripTimeline (reads)

FilmstripTimeline.tsx
  |
  +-- Reads psnrHistory + ssimHistory refs in paint loop
  +-- PSNR: 2px colored bars at bottom of bitrate graph area (8px strip)
  +-- SSIM: 2px colored bars above PSNR strip (8px strip)
  +-- psnrColor(dB) and ssimColor(s) map to 5-stop gradients matching shaders
```

**Data flow for difference map (WebGL, during playback):**

```
rAF loop:
  1. gl.texImage2D(TEXTURE0, masterVideo)  -- GPU upload, ~0.1ms
  2. gl.texImage2D(TEXTURE1, slaveVideo)   -- GPU upload, ~0.1ms
  3. gl.bindTexture(TEXTURE2, texSsim)     -- bind pre-uploaded SSIM map
  4. gl.drawArrays(TRIANGLES, 0, 6)        -- fragment shader, <0.5ms
  5. Browser composites diffCanvas          -- standard compositing
```

No pixel readback needed. Total: <1ms per frame. Feasible at 60fps.

**Data flow for metrics (CPU, on seeked):**

```
seeked event (fireMetrics):
  1. drawImage(videoA, 0, 0, 160, 90)      -- offscreen canvas A
  2. drawImage(videoB, 0, 0, 160, 90)      -- offscreen canvas B
  3. getImageData() for both                -- ~0.1ms at 160×90
  4. Per-pixel RGB MSE → PSNR dB            -- ~0.05ms (14,400 pixels)
  5. ssim(dataA, dataB, {bezkrovny})        -- ~0.2ms at 160×90
  6. Quantize ssim_map to Uint8Array        -- val × 255
  7. gl.texImage2D(R8, mapW, mapH, bytes)   -- upload SSIM map texture
  8. Store in psnrHistory + ssimHistory      -- keyed by rounded time
  9. Fire onPsnr + onSsim callbacks          -- updates toolbar display
```

**Data flow for filmstrip metric strips:**

```
FilmstripTimeline paint loop (every rAF):
  1. Read psnrHistory.current (Map<time, dB>)
  2. For each entry: ctx.fillRect(x, stripY, 2, 8) with psnrColor(dB)
  3. Read ssimHistory.current (Map<time, mssim>)
  4. For each entry: ctx.fillRect(x, ssimStripY, 2, 8) with ssimColor(s)
  5. SSIM strip positioned above PSNR strip when both present
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
| 8 | SSIM heatmap (CPU + GPU hybrid) | Done | Medium | Medium — structural quality metric |
| 9 | SSIM strip on filmstrip | Done | Easy | Medium — SSIM-over-time |

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
| [ssim.js](https://github.com/obartra/ssim) | Pure JS SSIM with multiple algorithm modes | Used for SSIM heatmap — `bezkrovny` algorithm at 160×90 |
