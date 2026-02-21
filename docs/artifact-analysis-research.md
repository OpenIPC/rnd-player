# Compression Artifact Analysis Modes — Feasibility & UX Research Report

## Executive Summary

**Feasible now (Easy-Medium effort):**
- **Toggle/Flicker mode** — swap A/B visibility on a timer. Zero pixel processing. Maximum impact, minimum effort.
- **Per-pixel difference map (WebGL)** — two textures + fragment shader. Sub-millisecond GPU compute. No readback needed for display.
- **PSNR heatmap** — trivial extension of the difference shader (`diff^2`, color-mapped). No windowed computation.
- **Per-frame PSNR readout** — compute on `seeked` event, display in compare toolbar next to frame type badge.

**Feasible with significant effort (Medium-Hard):**
- **SSIM heatmap** — 11x11 Gaussian window per pixel. CPU at 1080p is 500ms-2s. Downscaled (540p) with upscaled overlay is the pragmatic starting path. WebGL multi-pass FBO approach is feasible but ~200 lines of shader code.

**Not feasible (skip):**
- **Block boundary overlay** — mp4box.js is container-level only, no macroblock/CTU parsing. Would require porting a full H.264/HEVC NAL parser to WASM (~10k+ lines per codec). Heuristic edge detection is unreliable due to deblocking filters.

**Key constraint:** `canvas.drawImage()` on EME-protected video returns black pixels (canvas taint). For encrypted content, analysis modes would need the WebCodecs decode path from the thumbnail worker, limiting them to paused-only.

---

## Per-Area Findings

### 1. Frame Pixel Access — Easy (unencrypted) / Hard (encrypted)

The codebase already has all the infrastructure:
- `canvas.drawImage(videoEl)` + `getImageData()` — used in `FilmstripTimeline.tsx:170-190` with DRM taint detection
- `OffscreenCanvas` in workers — used throughout `thumbnailWorker.ts:68-69, 356, 499`
- `VideoFrame` from `VideoDecoder` — `thumbnailWorker.ts:567-573`

| Path | Perf (1080p) | Cross-browser | DRM-safe |
|------|-------------|---------------|----------|
| `canvas.drawImage(video)` + `getImageData()` | 25-50ms | All | No (tainted) |
| `VideoFrame.copyTo({format: "RGBA"})` | 15-20ms | Since Sep 2024 | N/A (WebCodecs only) |
| WebGL `texImage2D(video)` → shader | <1ms (no readback) | All (WebGL2) | Likely no (same origin-clean flag) |

The <16ms target for pixel extraction is only achievable by keeping frames on the GPU via WebGL (no readback for display).

### 2. Difference Map Modes — Easy-Medium

**Toggle/flicker mode** (~15 lines of code): toggle CSS `visibility` of the slave video at configurable interval (250/500/1000ms). Works with DRM. Zero pixel processing.

**WebGL difference map**: the project currently has zero WebGL code. Adding a WebGL2 canvas at z-index 2 inside `.vp-compare-overlay`:
1. Upload both video elements as textures via `texImage2D` (~0.1ms each, GPU-to-GPU)
2. Fragment shader computes `abs(A - B) * amplify` with palette
3. Total: <1ms per frame, feasible at 60fps during playback

Standard amplification factors: 1x (raw), 4x (enhanced), 8x (maximum). Palette options:

```glsl
// Grayscale: direct amplitude
gl_FragColor = vec4(vec3(diff * amplify), 1.0);

// Temperature: blue → white → red
float t = clamp(diff * amplify, 0.0, 1.0);
gl_FragColor = vec4(t, 1.0 - abs(2.0*t - 1.0), 1.0 - t, 1.0);

// PSNR-clip: green below threshold, red above
float mse = diff * diff;
gl_FragColor = mse > threshold ? vec4(1,0,0,1) : vec4(0,1,0,0.3);
```

### 3. SSIM Heatmap — Medium-Hard

CPU at 1080p: 500ms-2s (11x11 Gaussian window × 2M pixels). Not real-time, but acceptable paused-only with spinner.

**Pragmatic path**: compute at 1/4 resolution (480x270), ~30-120ms on CPU, upscale the heatmap overlay. SSIM is designed to be multi-scale so downscaling preserves structural information well.

**Simpler alternative first**: PSNR heatmap is per-pixel `10 * log10(255²/MSE)` — no windowed computation, runs in the same fragment shader as the difference map. Start here.

Existing JS libraries:
- **ssim.js** (https://github.com/obartra/ssim) — pure JS, supports `weber` (fastest), `bezkrovny`, `fast`, `original` algorithms. Returns mssim (mean) + ssim_map (per-pixel).
- **image-ssim** (https://github.com/darosh/image-ssim-js) — TypeScript, simpler API.

**GPU acceleration options:**

| Approach | Feasibility | Performance | Notes |
|----------|-------------|-------------|-------|
| WebGL multi-pass FBOs | Medium | ~2-5ms | Separable Gaussian blur (2 passes for mean), then variance/covariance textures, then SSIM formula. 4-6 render passes total |
| WebGPU compute shader | Medium-Hard | ~1-2ms | More natural for neighborhood operations but browser support gaps |

### 4. Block Boundary Overlay — Infeasible

mp4box.js parses container-level boxes only (moov, moof, mdat, tenc, senc). It does not parse codec-level NAL units, macroblock syntax, or CTU quad-tree structures. No JavaScript/WASM library provides this. Elecard StreamEye achieves this with ~5,000-20,000 lines of native C++ per codec, including CABAC/CAVLC entropy decoding.

Heuristic detection from pixel discontinuities fails because modern codecs apply deblocking filters specifically to smooth block edges.

**Skip this feature entirely.**

### 5. Per-Frame Quality Metric Graph — Medium

Follow the `useBitrateGraph` pattern (`src/hooks/useBitrateGraph.ts`):
- Data structure: `FrameQualityInfo { time, psnr, ssim?, computed }`
- Trigger: compute on `seeked` event (same event used for frame type detection, `QualityCompare.tsx:850`)
- Cache by `(heightA, heightB, segStartTime, frameIdx)`
- Display: inline in toolbar next to frame badge (`I 42.3 KB | PSNR 38.2 dB`), or sparkline on filmstrip below bitrate graph
- "Bad frame" detection: flag frames where PSNR < 30 dB, highlight with red markers

### 6. UX Integration — Easy-Medium

**Analysis canvas placement**: z-index 2 (same level as spotlight), `position: absolute; inset: 0`. Split slider (z-index 4) and toolbar (z-index 5) remain above.

**Mode switching**: keyboard shortcut cycle + toolbar dropdown:

| Mode | Key | Visual |
|------|-----|--------|
| Split (existing) | — | Default A/B split slider |
| Difference | `D` | Per-pixel difference overlay |
| PSNR Heatmap | `H` | Color-mapped quality heatmap |
| Toggle/Flicker | `T` | Rapid A/B swap |

URL param: `&cmode=diff` alongside existing zoom/pan/split params.

**Spotlight interaction**: highlight draw + auto-zoom work on top of the analysis canvas in Difference/Heatmap modes. The same CSS transforms (zoom/pan) apply to the analysis canvas. Suppressed in Toggle mode.

**How commercial tools handle mode switching:**
- Elecard StreamEye: toolbar buttons + ALT+1-6 hotkeys for overlay toggles; CTRL+1-6 for panel switches (decoded/predicted/unfiltered/residual/reference/difference)
- MSU VQMT: tabbed panels with Results Plot, Frames View, and Visualization modes
- VQ Probe: dropdown selector for visualization mode in a floating toolbar

### 7. Performance & Architecture — Medium

**Separate `analysisWorker.ts`** (not reusing the already-complex thumbnailWorker at ~1,094 lines). Receives RGBA `ArrayBuffer` via `Transferable`, returns metrics.

**SharedArrayBuffer is not viable** — requires COEP `require-corp` headers which would break all cross-origin segment fetches from arbitrary CDNs.

**WebGPU**: not yet universal enough (Firefox Linux, some mobile gaps). Use WebGL2 as primary path.

**WebGPU browser support matrix (as of Feb 2026):**

| Platform | Chrome/Edge | Firefox | Safari |
|----------|------------|---------|--------|
| Windows | Stable (since 113) | Stable (since 141) | N/A |
| macOS | Stable (since 113) | Stable (145, ARM only) | Stable (Safari 26) |
| Linux | Beta (144+, Intel Gen12+) | In progress | N/A |
| iOS/Android | Chrome Android 121+ | In progress | iOS 26 |

**Memory budget**: ~25 MB per analysis state (two 1080p source frames + one output). Cache eviction via LRU keyed by `(heightA, heightB, segStartTime)`, following the same pattern as `useThumbnailGenerator` 3x-viewport eviction.

**Worker strategy:**

| Computation | Where | Rationale |
|-------------|-------|-----------|
| Pixel extraction (`getImageData`) | Main thread | Must access `<video>` element |
| Difference map (WebGL) | Main thread | WebGL context on visible canvas |
| Difference map (CPU fallback) | Worker | Offload 8MB pixel loop |
| SSIM computation | Worker | Heavy CPU work, 500ms-2s |
| Quality metric cache | Worker | Avoid blocking UI during precomputation |

---

## Recommended Implementation Order

| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| 1 | Toggle/Flicker mode | Easy | High — simplest A/B comparison |
| 2 | Per-pixel difference map (WebGL) | Medium | High — visual artifact detection |
| 3 | Amplification & palette controls | Easy | Medium — makes diff map usable |
| 4 | PSNR heatmap (same shader) | Easy | Medium — quality visualization |
| 5 | Per-frame PSNR readout in toolbar | Easy | Medium — instant quality number |
| 6 | Mode switching UI + URL params | Easy | Medium — discoverability |
| 7 | Quality sparkline on filmstrip | Medium | Medium — quality-over-time |
| 8 | SSIM heatmap (downscaled CPU) | Hard | Low-Medium — niche metric |

---

## Architecture Sketch

```
QualityCompare.tsx
  |
  +-- [existing] masterVideo (HTMLVideoElement, right/B side)
  +-- [existing] slaveVideo (HTMLVideoElement, left/A side, clipped)
  +-- [new] analysisCanvas (HTMLCanvasElement, WebGL2 context, z-index 2)
  |     |
  |     +-- WebGL program: loads masterVideo + slaveVideo as textures
  |     +-- Fragment shader: computes diff/PSNR per mode + amplification + palette
  |     +-- Renders to analysisCanvas on seeked event (or rAF during playback)
  |     +-- Hidden when mode === "split" or "toggle"
  |
  +-- [new] analysisMode state: "split" | "diff" | "heatmap" | "toggle"
  +-- [new] amplification state: 1 | 2 | 4 | 8
  +-- [new] palette state: "grayscale" | "temperature" | "psnr-clip"
  +-- [new] flickerInterval: 250 | 500 | 1000 ms (for toggle mode)
  +-- [existing] viewStateRef: add cmode, amplify, palette fields
  |
  +-- [new] useAnalysisMetrics hook
        |
        +-- Spawns analysisWorker (separate from thumbnailWorker)
        +-- On seeked: extract RGBA from both videos via canvas.drawImage + getImageData
        +-- Transfer ArrayBuffers to worker
        +-- Worker computes: mean PSNR, mean SSIM (downscaled), per-frame values
        +-- Cache results keyed by (heightA, heightB, segStart, frameIdx)
        +-- Returns: { psnr: number, ssim?: number }
        +-- Displayed in compare toolbar next to frame type badge

analysisWorker.ts (new Web Worker)
  |
  +-- Receives: { type: "computeMetrics", frameA: ArrayBuffer, frameB: ArrayBuffer, width, height }
  +-- Computes: PSNR (per-pixel MSE -> 10*log10(255^2/MSE))
  +-- Computes: SSIM at 1/4 resolution (downsample, 11x11 window, return mean + map)
  +-- Returns: { psnr: number, ssim: number, ssimMap?: ArrayBuffer }
```

**Data flow for difference map (WebGL, during playback):**

```
rAF loop:
  1. gl.texImage2D(TEXTURE0, masterVideo)  -- GPU upload, ~0.1ms
  2. gl.texImage2D(TEXTURE1, slaveVideo)   -- GPU upload, ~0.1ms
  3. gl.drawArrays(TRIANGLE_STRIP, 0, 4)   -- fragment shader, <0.5ms
  4. Browser composites analysisCanvas      -- standard compositing
```

No pixel readback needed. Total: <1ms per frame. Feasible at 60fps.

**Integration with existing components:**

- `QualityCompare.tsx`: Add mode state + analysis canvas + toolbar dropdown. ~100 lines of additions.
- `ShakaPlayer.css`: Add `.vp-compare-analysis-canvas` at z-index 2, `position: absolute; inset: 0;`.
- `ShakaPlayer.tsx`: Extend `CompareViewState` with `cmode` field, serialize to URL params.
- `App.tsx`: Parse `cmode` from URL.
- `FilmstripTimeline.tsx`: Optionally display quality sparkline below bitrate graph using same canvas rendering approach.

---

## Open Questions (Need Prototyping)

1. **WebGL `texImage2D` from EME video** — does it also taint/fail like `canvas.drawImage()`? Needs browser testing.

2. **`willReadFrequently` performance delta** — the save-frame code (`FilmstripTimeline.tsx:172`) creates a canvas without this flag. Setting it could halve readback time (50ms → 25ms) for the CPU analysis path but disables GPU acceleration for draws. Needs benchmarking.

3. **ssim.js `weber` algorithm accuracy** — fastest mode doesn't match Wang et al. exactly. Is the approximation sufficient for a video player? Prototype with the DASH fixture to measure speed/accuracy delta.

4. **WebGL context limits** — typically 8-16 per page. The player doesn't currently use WebGL, but embedded deployments might. Need `webglcontextlost` event handling with fallback to CPU path.

5. **Dual-manifest resolution mismatch** — two CDNs may serve different pixel dimensions at the same selected height (e.g., 1920x1080 vs 1920x1088 due to codec alignment). Analysis canvas must normalize to the smaller resolution.

6. **Frame sync for analysis** — the rAF drift correction (`QualityCompare.tsx:777-799`) keeps videos within 16ms during playback, but pixel-accurate difference maps need exact frame alignment. Analysis should probably be paused-only except for WebGL difference (which tolerates slight desync).

7. **SSIM at 1/4 resolution upscale artifacts** — does bilinear upscaling of a 480x270 SSIM map to 1920x1080 produce distracting interpolation artifacts? Or does the inherent smoothness of SSIM windows make this invisible? Needs prototyping with synthetic test patterns.

---

## Industry Tool Reference

| Tool | Key Visualization Features | Relevance |
|------|---------------------------|-----------|
| [Elecard StreamEye](https://elecard.com/products/video-analysis/streameye-studio) | Macroblock/CTU overlays, 6 overlay modes (ALT+1-6), 6 data panels (CTRL+1-6), split view with 7 comparison modes | Gold standard for block-level analysis (requires native bitstream parsing) |
| [Vicuesoft VQ Probe](https://vicuesoft.com/blog/titles/VQ_Probe_Advantages/) | Split-line, per-pixel diff (heat map + B&W), PSNR/SSIM/VMAF heatmaps, zoom to pixel values | Closest model for our UX — split + analysis overlay modes |
| [MSU VQMT](https://videoprocessing.ai/vqmt/basic/) | Per-frame metric Results Plot, residue visualization with gamma, toggle view (Ctrl+1/2/3), bad frame detection | Best model for quality-over-time graph and frame comparison |
| [Vicuesoft VQ Analyzer](https://vicuesoft.com/vq-analyzer/) | Block-level codec internals: loop filter, SAO, ALF, per-pixel formulas on click | Deep codec analysis — not replicable in browser without bitstream parser |
| [ssim.js](https://github.com/obartra/ssim) | Pure JS SSIM with multiple algorithm modes | Candidate library for CPU SSIM path |
