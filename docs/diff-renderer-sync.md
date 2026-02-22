# Diff Renderer Frame Synchronization

## Problem

The quality comparison mode (`QualityCompare.tsx`) plays two video elements side by side — a "slave" (videoA, typically 240p) and a "master" (videoB, typically 1080p) — and computes per-frame metrics (PSNR, SSIM, MS-SSIM, VMAF) plus a GPU heatmap overlay. The diff renderer (`useDiffRenderer.ts`) must capture the **same frame** from both videos to produce correct results. When it captures different frames, the heatmap shows inter-frame motion artifacts (red flashes in temperature palette) and metrics drop ~6-8 dB below true values.

## Architecture

### Two video elements

- **videoB (master)**: main Shaka Player instance, has audio, controlled by VideoControls
- **videoA (slave)**: separate Shaka Player instance, muted, follows master via sync logic in `QualityCompare.tsx`

### Sync mechanism (QualityCompare.tsx, lines 833-895)

- **Paused/seeking**: master fires `seeked` → handler sets `slaveVideo.currentTime = masterVideo.currentTime` → slave seeks asynchronously
- **Playback**: rAF loop with rate adjustment (±3% for drift <200ms, hard seek for >200ms)

### Diff renderer (useDiffRenderer.ts)

- **CPU metrics**: draws both videos to 120×68 OffscreenCanvases via `drawImage(video)`, calls `getImageData()`, computes PSNR/SSIM/VMAF
- **GPU overlay**: uploads both videos to WebGL textures via `texImage2D(video)`, fragment shader computes diff with selectable palette (grayscale, temperature, PSNR heatmap, SSIM/VMAF heatmap-over-video)

## Root Causes Identified

### Race 1: Paused seeking (FIXED)

**Problem**: master fires `seeked` → useDiffRenderer's listener captures immediately → but QualityCompare's listener hasn't set slave's `currentTime` yet (or slave seek is still async).

**Fix** (commit `3660d98`):
- Added `isVideoSynced()` guard checking `seeking` state + `currentTime` within 16ms
- Listen to both videos' `seeked` events (not just master)
- Guard both `fireMetrics()` and `render()` texture upload

**Status**: Working correctly.

### Race 2: Playback — currentTime is not frame-accurate (PARTIALLY FIXED)

**Problem**: during playback, `currentTime` advances smoothly but the compositor presents frames independently per video element. Two videos with `currentTime` within a few ms can display different frames.

**Evidence from debug logs**: `frameA≈N frameB≈N` (same `Math.round(currentTime * 30)`) but PSNR oscillates between ~35 dB (correct) and ~28 dB (mismatch), roughly every other computation.

**Attempted fix**: `requestVideoFrameCallback` (RVFC) to track presented PTS per video, skip computation when PTS differs.

**Result**: RVFC correctly detects ~33ms PTS gaps (one-frame desync) and skips those. BUT mismatches still occurred when PTS matched — because `drawImage(video)` in the rAF loop captured a different frame than what RVFC reported (compositor advanced between RVFC callback and rAF).

### Race 3: Playback — stale capture in rAF after RVFC (FIXED)

**Problem**: RVFC callback fires → we know the PTS → but by the time the rAF loop calls `drawImage(video)` or `texImage2D(video)`, the compositor may have already advanced to the next frame.

**Fix**: moved ALL capture operations into the RVFC callbacks:
- `drawImage(video)` + `getImageData()` for CPU metrics (120×68)
- `texImage2D(video)` for GPU textures (full resolution)
- Match by PTS: only compute metrics when both RVFC callbacks report the same PTS
- rAF loop only does `drawQuad()` (no capture, no texture upload)

**Status**: Working correctly in most cases.

### Race 4: tryMatch re-uploading from live video (FIXED)

**Problem**: `tryMatch()` called `uploadVideoTextures()` which re-read from the live video elements, overwriting the GPU textures that RVFC callbacks had correctly captured. When `tryMatch` runs inside RVFC B's callback, videoA may have already advanced.

**Fix**: removed `uploadVideoTextures()` from `tryMatch()`. RVFC callbacks already upload the correct textures individually.

**Status**: Fixed, but residual race still exists (see below).

### Race 5: Compositor desync during playback (PARTIALLY FIXED — double-buffered textures)

**Symptom**: during playback, the diff overlay either froze for seconds or showed inter-frame artifacts (red flashes in temperature palette). PSNR dropped ~6-8 dB when mismatched.

**Root cause confirmed via diagnostic logging**: the two independent compositors present frames at systematically different times. Even when `currentTime` values are identical, the compositor independently picks which discrete frame to present for each video element. The RVFC callbacks report PTS values exactly 1 frame (33ms at 30fps) apart, causing `tryMatch` to reject the pair.

**Diagnostic data** (2-second windows at 30fps video, before fix):

| State | rvfcA/s | rvfcB/s | matchCount | missPts | drawCount | lastPts gap |
|-------|---------|---------|------------|---------|-----------|-------------|
| **Freeze** | 28 | 30 | **1** | **112** | **1** | **33ms** (1 frame) |
| **Freeze** | 26 | 30 | **0** | **113** | **0** | **66ms** (2 frames) |
| **1-2fps** | 29 | 30 | **16** | **71** | **16** | **33ms** |
| **OK** | 28 | 28 | **57** | **0** | **120** | **0ms** |
| **OK** | 30 | 30 | **60** | **0** | **120** | **0ms** |

**Key findings from logs**:

1. **RVFC callbacks fire at normal rate** (~28-30/s each) — no frame drops
2. **Metrics cost is negligible** (0.1-0.6ms) — not a CPU bottleneck
3. **No frame drops** — `meta.presentedFrames` counters are nearly identical
4. **The problem is pure PTS mismatch**: compositors present frames 1 frame apart (33ms > 10ms threshold → `tryMatch` rejects)
5. **The intermittent nature** depends on compositor phase alignment — sometimes both videos happen to present the same frame (OK), sometimes they're offset by exactly 1 frame (freeze/stutter)

**Why the drift correction doesn't help**: the rAF-based drift correction in `QualityCompare.tsx` operates on `currentTime` (a smooth value), with a 16ms "synced" threshold. Two videos can have identical `currentTime` yet present different compositor frames. The correction can't see the per-frame PTS reported by RVFC. Rate adjustment of ±3% takes ~1 second to close a 33ms gap — during that second, no PTS matches occur and the diff canvas is frozen.

**Evolution of fixes**:

1. **Single-buffer with gpuPts gate** (original): checked `gpuPtsA ≈ gpuPtsB` (within 10ms) in the rAF drawLoop. When compositors were 1 frame apart, this check failed on every rAF cycle → canvas froze for seconds.

2. **Single-buffer without gate** (intermediate): removed the gpuPts check, drew unconditionally once both textures were uploaded. Fixed the freeze but reintroduced visual mismatch from Race 2 — each RVFC callback independently overwrites its texture, so by the time drawLoop fires, the two textures can be from different frames.

3. **Double-buffer with atomic swap** (current fix): maintains two texture sets — "front" (read by drawLoop) and "back" (written by RVFC). When `tryMatch` confirms both videos have the same PTS, front↔back are swapped atomically via JS reference swap. The drawLoop always binds front textures — guaranteed to be a PTS-matched pair. Between matches, the last matched pair is repeated at 60fps. No freeze, no artifacts.

**How double-buffering solves both problems**:

```
RVFC-A fires (PTS N)  → uploads to backA (frontA untouched)
RVFC-B fires (PTS N)  → uploads to backB (frontB untouched)
tryMatch: PTS match!   → swap front↔back (frontA/B now have PTS N)
drawLoop               → binds frontA + frontB → correct matched pair

RVFC-A fires (PTS N+1) → uploads to backA (frontA still has N)
RVFC-B fires (PTS N+2) → uploads to backB (frontB still has N)
tryMatch: PTS mismatch → no swap
drawLoop               → binds frontA + frontB → still shows matched N (stale but correct)
```

When compositors are out of phase (matchCount=0), the canvas shows a slightly stale but PTS-correct frame pair instead of freezing or showing inter-frame artifacts. The visual update rate degrades to the match rate, but no incorrect frames are ever drawn.

**Implementation details**:
- 4 GPU textures created in `initGl` (`texA`, `texB` = initial front; `texABack`, `texBBack` = initial back)
- Local variables `frontA`/`frontB`/`backA`/`backB` track which texture is which — swap is a JS reference swap (zero GPU cost)
- `frontReady` flag gates the first draw — prevents drawing uninitialized front textures before the first swap
- The paused path is unchanged — it uses `uploadVideoTextures()` which writes to `texA`/`texB` directly (no double-buffering needed when both videos are stopped)
- GPU memory overhead: 2 extra RGBA textures (~16MB at 1080p). Acceptable.

**Remaining issue**: during compositor desync periods, the overlay visual update rate degrades to the PTS match rate (3-19 fps instead of 30). The double-buffer repeats the last correct matched pair at 60 fps (no freeze, no artifacts), but the overlay content visibly stutters/lags because metrics and texture swaps only occur when the compositors happen to present the same frame. This is a cosmetic issue — the displayed diff is always from a correctly matched frame pair, never from mismatched frames. The desync episodes are intermittent and vary by browser, hardware, and system load.

**Former hypotheses** (from initial investigation, now resolved by logging):

1. ~~GPU texture overwrite between RVFC callbacks~~ — **confirmed as the draw-side problem**, fixed by double-buffering
2. ~~Metrics ImageData overwrite~~ — not the issue; metrics cost is <1ms
3. ~~Frame drops under load~~ — **ruled out**; `presentedFrames` counters match
4. ~~RVFC callback ordering~~ — not the primary issue; both callbacks fire at normal rate
5. ~~drawImage lag after RVFC~~ — not investigated; PTS mismatch accounts for observed behavior

### Bug 6: Double frame-step in quality compare mode (FIXED)

**Problem**: frame-by-frame stepping (ArrowRight/ArrowLeft) in quality compare mode sometimes jumped by 2 frames instead of 1 (e.g. 1043→1045→1047→1049). The issue was intermittent and did not reproduce in single-player mode.

**Root cause**: `useKeyboardShortcuts.ts` registered the same `onKeyDown` handler on **both** `containerEl` and `document`:

```javascript
containerEl.addEventListener("keydown", onKeyDown);
document.addEventListener("keydown", onKeyDown);
```

When focus was on any element **inside** `containerEl` (buttons, video element, etc.), a single keypress event bubbled through `containerEl` first (triggering the first listener), then continued to `document` (triggering the second listener). Since `video.currentTime` updates synchronously per HTML spec (the seek algorithm sets the official playback position immediately), the second invocation read the already-stepped position and advanced again:

1. First call: `curFrame = 1043` → sets `currentTime = 1044/30 + ε`
2. Second call: reads updated `currentTime` → `curFrame = 1044` → sets `currentTime = 1045/30 + ε`
3. Net result: 1043 → 1045 (skipped frame 1044)

**Why intermittent**: depended on which element had DOM focus. After clicking a `<button>` (play, volume, fullscreen), focus stayed on the button (inside `containerEl`) → both listeners fired → double-step. After using keyboard-only workflow (Space/K to pause), focus stayed on `document.body` (outside `containerEl`'s subtree) → only the `document` listener fired → correct single-step.

**Why quality-compare-specific**: in QualityCompare mode, users interact more with UI controls (compare toolbar, quality selects, buttons), moving focus inside `containerEl`. In single-player mode, keyboard-only workflow is more common.

**Fix** (commit `20858d4`): removed the redundant `containerEl` listener. The `document` listener alone catches all keyboard events regardless of focus state. Also removed `containerEl` from the hook's interface and dependency array.

**Lesson learned**: never register the same event handler on both a container element and `document` — the event will fire twice when focus is inside the container due to DOM event bubbling.

## Current Implementation

### Three code paths in useDiffRenderer.ts

1. **Paused** (`if (paused)`): captures from video on `seeked` events, uses `isVideoSynced()` (currentTime-based), uploads textures synchronously, draws immediately. **Correct** — both videos are stopped, no compositor race.

2. **Playing + RVFC** (`else if (hasRVFC && videoA)`): double-buffered RVFC capture. RVFC callbacks upload to back textures and capture metrics data. `tryMatch()` computes metrics and swaps front↔back only when PTS matches (within 10ms). rAF drawLoop binds front textures and draws — always a PTS-matched pair. Between matches, last matched pair repeats. **Correct** — no freeze, no artifacts.

3. **Playing without RVFC** (`else`): rAF-based fallback with `isVideoSynced()` guard and adaptive throttle. Less accurate — currentTime check can't guarantee same compositor frame.

### Key functions

- `computeMetrics(dataA, dataB)` — shared: computes PSNR, SSIM, MS-SSIM (if active), VMAF (if active), uploads heatmap R8 texture
- `uploadVideoTextures()` — reads from live video elements into GPU textures (used only in paused path)
- `drawQuad()` — issues GL draw call with whatever textures are bound to TEXTURE0/TEXTURE1
- `resizeCanvas()` — matches canvas pixel buffer to CSS layout × DPR
- `isVideoSynced()` — currentTime-based sync check (paused path only)
- `tryMatch()` — PTS-checked metrics computation + front↔back texture swap; only fires when both RVFC callbacks report same frame

## Action Items

### Priority 1: Fix the visual overlay to only draw matched frames (without freezing) — PARTIAL

**Partially resolved by Option A (double-buffer GPU textures).** No artifacts (wrong frames never displayed), no hard freezes. Remaining issue: overlay update rate drops to PTS match rate during compositor desync episodes (3-19 fps visual stutter). See Race 5 section for details.

#### ~~Option A: Double-buffer GPU textures~~ (IMPLEMENTED)

Implemented in `useDiffRenderer.ts`. Four GPU textures (front + back for each video), RVFC callbacks write to back, `tryMatch` swaps front↔back on PTS match, drawLoop binds front. No freeze, no artifacts.

#### Option B: Draw inside tryMatch only (not needed)

Move `resizeCanvas()` + `drawQuad()` into `tryMatch` (draw synchronously at the moment PTS matches). At match time, both RVFC callbacks have uploaded their textures for the same PTS — textures are guaranteed consistent.

Problem: when compositors are out of phase (matchCount=0-1 per 2s), the canvas still effectively freezes because tryMatch rarely succeeds. This doesn't fix the freeze — it just moves it from drawLoop to tryMatch.

#### ~~Option C: RVFC-driven drift correction~~ (ATTEMPTED — FAILED)

**Attempted** feeding RVFC PTS drift back to QualityCompare's sync loop. `useDiffRenderer` exposed a `ptsDriftRef` with the average PTS gap (seconds). The sync loop used `targetTime = masterVideo.currentTime + ptsDriftRef.current` instead of raw `masterVideo.currentTime`. The ±3% rate adjustment would gradually shift the slave's `currentTime` to compensate for the compositor phase offset.

**Why it failed**: the drift correction overcompensated. Observed `drift=65.4ms` (~2 frames) instead of the expected ~33ms. Root causes:

1. **Convergence delay amplifies drift**: the sync loop's ±3% rate adjustment takes ~1s to shift `currentTime` by 33ms. During convergence, the drift detection keeps accumulating PTS mismatches. Although the running average (`cumulativeDrift / consecutivePtsMisses`) should stay at ~33ms mathematically, the interaction between the gradually shifting `currentTime` and the compositor's frame selection creates a feedback loop. The compositors respond to `currentTime` changes with unpredictable lag (depends on decoder queue, vsync phase), so the PTS gap during convergence can oscillate between 0ms and 66ms, inflating the average.

2. **Compositor phase is not a function of `currentTime`**: the compositor's vsync phase is a hardware/OS-level property independent of the media timeline. Shifting `currentTime` by 33ms changes which frame the decoder targets, but the compositor's relative phase offset persists. The correction shifts the *content* (frame N+1 instead of N) without shifting the *timing* (when the compositor presents). This means the correction might align frames for one vsync period and then fall out of phase again as the compositor continues its fixed-phase presentation.

3. **Sync loop fights the correction**: even if the drift is set correctly at 33ms, the sync loop detects `absDrift = 33ms > 16ms` and adjusts `playbackRate` to correct it. But correcting back to `currentTime ≈ masterTime` undoes the drift compensation. The correction is stable only if the drift value stays exactly at 33ms AND the sync loop maintains that offset — but oscillation between "match → reset counters" and "mismatch → re-detect" causes instability.

**Result**: the slave ended up 2 frames ahead of the master instead of aligned. The diff overlay showed inter-frame artifacts (difference between frame N and frame N+2), which was **worse** than the original 1-frame compositor desync. Reverted.

**Diagnostic data** (during failed attempt):

| State | match | missPts | drift | Symptom |
|-------|-------|---------|-------|---------|
| Start freeze, then OK | 6 → 56-60 | 99 → 0-5 | 65.4ms | Initial desync, correction converges but overshoots |
| Mixed freeze/OK | 30-49 | 19-56 | 49-51ms | Oscillating between overcorrection and re-detection |
| Random freeze + artifacts | 9-57 | 2-93 | 51.5ms | Stale drift causes comparison of wrong frames |

**Key lesson**: `currentTime` adjustment cannot reliably fix compositor phase desync. The compositor's frame selection depends on the decoder output queue and vsync cycle, not just the media timeline position. A different approach is needed — either accepting the reduced update rate during desync (current double-buffer behavior) or using a fundamentally different synchronization mechanism.

### Priority 2: Investigate further (completed / deprioritized)

#### ~~Investigate frame drop correlation~~ (DONE)

Added `meta.presentedFrames` tracking. **Result**: presentedA ≈ presentedB in all states — frame drops are NOT the cause.

#### ~~Investigate requestVideoFrameCallback accuracy~~ (DEPRIORITIZED)

The PTS mismatch fully accounts for the observed behavior. RVFC accuracy may still matter but is not the primary blocker.

#### ~~Frame hash comparison~~ (DEPRIORITIZED)

Heuristic approach — superseded by PTS-based matching which is exact.

### Priority 3: Architectural alternatives (future)

#### Single-video approach (WebCodecs worker)

Instead of two Shaka Player instances, decode the second rendition in a Web Worker using `VideoDecoder` (like the filmstrip does). The worker decodes specific segment frames on demand, eliminating the compositor sync problem entirely. Downside: significant architectural change, CPU decode of 1080p is expensive, and no audio sync.

#### Pause-capture-resume

On each metrics computation: pause both videos briefly (1-2 frames), capture both, resume. Guarantees both decoders stop advancing. Downside: visible stutter during playback.

#### WebCodecs VideoFrame approach

Use `HTMLVideoElement.requestVideoFrameCallback` combined with the experimental `VideoFrame` API to get a `VideoFrame` object directly. Provides an immutable handle to the exact composited frame, avoiding the `drawImage` timing race entirely. Browser support is limited.

## File References

- `src/hooks/useDiffRenderer.ts` — all sync logic, metrics computation, GPU rendering
- `src/components/QualityCompare.tsx:833-895` — master↔slave sync (seeked events, rAF drift correction)
- `src/utils/vmafCore.ts` — VMAF computation engine
- `src/components/QualityCompare.tsx:326-339` — where `useDiffRenderer` is called
- `src/hooks/useKeyboardShortcuts.ts` — keyboard shortcuts including frame-step (ArrowRight/Left)

## Test Fixture

The DASH test fixture (`e2e/generate-dash-fixture.sh`) has a 4-digit frame counter overlay (white text on black, centered). At 30 fps, frame N appears at time N/30 seconds. This makes frame mismatches visually obvious and measurable via PSNR drop (~35 dB for same-frame cross-rendition vs ~28 dB for consecutive-frame comparison).

## Commits

- `3660d98` — Fix diff renderer race: skip metrics when videos are on different frames (paused fix)
- `8d8f0b6` — RVFC-based playback capture + tryMatch fix (removes uploadVideoTextures re-read)
- `20858d4` — Fix double frame-step in quality compare mode (remove duplicate containerEl keyboard listener)
- `f7e44b5` — Remove gpuPts drawLoop gate: fixes multi-second freezing but reintroduces visual artifacts (intermediate step)
- `8790ec0` — Double-buffer GPU textures: front/back texture pairs with atomic swap on PTS match. Eliminates both freezing and visual artifacts
