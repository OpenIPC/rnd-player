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

### Race 5: Compositor desync during playback (CONFIRMED — root cause identified)

**Symptom**: during playback, the diff overlay either freezes for seconds or shows inter-frame artifacts (red flashes in temperature palette). PSNR drops ~6-8 dB when mismatched.

**Root cause confirmed via diagnostic logging**: the two independent compositors present frames at systematically different times. Even when `currentTime` values are identical, the compositor independently picks which discrete frame to present for each video element. The RVFC callbacks report PTS values exactly 1 frame (33ms at 30fps) apart, causing `tryMatch` to reject the pair.

**Diagnostic data** (2-second windows at 30fps video):

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

The original implementation checked `gpuPtsA ≈ gpuPtsB` (within 10ms) in the rAF drawLoop. When compositors were 1 frame apart, this check failed on every rAF cycle → canvas froze for seconds.

Removing the gpuPts check and drawing unconditionally (once both textures are uploaded) fixes the freeze but reintroduces the visual mismatch from Race 2 — the diff overlay compares frames that may be from adjacent time positions. This is the **current trade-off**: smooth rendering with occasional 1-frame artifacts vs. accurate rendering with multi-second freezes.

**What needs to happen**: the GPU textures for both videos must be from the same PTS when `drawQuad()` fires. The current single-buffer approach can't guarantee this because each RVFC callback independently overwrites its texture. See Action Items below.

**Former hypotheses** (from initial investigation, now resolved by logging):

1. ~~GPU texture overwrite between RVFC callbacks~~ — **confirmed as the draw-side problem**, but the underlying cause is compositor desync, not callback ordering
2. ~~Metrics ImageData overwrite~~ — not the issue; metrics cost is <1ms
3. ~~Frame drops under load~~ — **ruled out**; `presentedFrames` counters match
4. ~~RVFC callback ordering~~ — not the primary issue; both callbacks fire at normal rate
5. ~~drawImage lag after RVFC~~ — not investigated yet, but the PTS mismatch accounts for the observed behavior

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

2. **Playing + RVFC** (`else if (hasRVFC && videoA)`): RVFC callbacks capture metrics data (`drawImage` + `getImageData`) and upload GPU textures (`texImage2D`) at composition time. `tryMatch()` computes metrics only when PTS matches (within 10ms). rAF drawLoop renders unconditionally once both textures are ready. **Trade-off** — metrics are accurate (PTS-checked) but the visual overlay may show 1-frame artifacts when compositors are out of phase.

3. **Playing without RVFC** (`else`): rAF-based fallback with `isVideoSynced()` guard and adaptive throttle. Less accurate — currentTime check can't guarantee same compositor frame.

### Key functions

- `computeMetrics(dataA, dataB)` — shared: computes PSNR, SSIM, MS-SSIM (if active), VMAF (if active), uploads heatmap R8 texture
- `uploadVideoTextures()` — reads from live video elements into GPU textures (used only in paused path now)
- `drawQuad()` — issues GL draw call with whatever textures are bound
- `resizeCanvas()` — matches canvas pixel buffer to CSS layout × DPR
- `isVideoSynced()` — currentTime-based sync check (paused path only)
- `tryMatch()` — PTS-checked metrics computation; computes only when both RVFC callbacks report same frame

### Current trade-off (Race 5)

The RVFC playback path currently accepts a visual trade-off:
- **Metrics** (PSNR, SSIM, VMAF readout): accurate, only computed on PTS-matched frames
- **GPU overlay** (diff heatmap): renders every rAF frame using whatever textures are currently bound — may show 1-frame artifacts when compositors are out of phase (inter-frame motion shows as red flashes in temperature palette)
- **Previous behavior**: GPU overlay was PTS-checked via `gpuPtsA ≈ gpuPtsB` — accurate when compositors aligned but froze for seconds when they didn't (the common case)

## Action Items

### Priority 1: Fix the visual overlay to only draw matched frames (without freezing)

The core problem: each RVFC callback independently overwrites its GPU texture. By the time the rAF drawLoop fires, one texture may have been overwritten with the next frame, making the pair inconsistent. The previous `gpuPts` check prevented drawing mismatched textures but caused multi-second freezes. Removing the check fixed freezing but reintroduced visual artifacts.

#### Option A: Double-buffer GPU textures (recommended)

Maintain two texture sets ("front" and "back"). RVFC callbacks write to back textures. When `tryMatch` succeeds (PTS match confirmed), swap front↔back atomically. The rAF drawLoop always draws from front textures — guaranteed to be a matched pair.

Implementation:
- Create 4 textures instead of 2: `texA_front`, `texA_back`, `texB_front`, `texB_back`
- RVFC-A uploads to `texA_back`, RVFC-B uploads to `texB_back`
- `tryMatch` success → swap front↔back for both A and B, mark `frontReady = true`
- drawLoop binds front textures → `drawQuad()` only when `frontReady`
- Between swaps, drawLoop repeats the last matched pair (no freeze, no artifacts)

Trade-off: uses 2× GPU texture memory (~32MB for two 1080p RGBA textures). Acceptable.

When compositors are out of phase (matchCount=0), the drawLoop repeats the last good matched pair — canvas shows a slightly stale but correct frame instead of freezing or showing artifacts.

#### Option B: Draw inside tryMatch only

Move `resizeCanvas()` + `drawQuad()` into `tryMatch` (draw synchronously at the moment PTS matches). At match time, both RVFC callbacks have uploaded their textures for the same PTS — textures are guaranteed consistent.

Problem: when compositors are out of phase (matchCount=0-1 per 2s), the canvas still effectively freezes because tryMatch rarely succeeds. This doesn't fix the freeze — it just moves it from drawLoop to tryMatch.

#### Option C: RVFC-driven drift correction

Feed RVFC PTS values back to the drift correction in `QualityCompare.tsx`. When consecutive missPts exceeds a threshold (e.g., 5 frames), nudge `slaveVideo.currentTime` by ±5ms to push the compositor to present the adjacent frame. This is a micro-seek that doesn't cause decoder flicker.

This attacks the root cause (compositor desync) rather than the symptom (stale textures). Could be combined with Option A for belt-and-suspenders.

Implementation:
- `useDiffRenderer` exposes a callback `onPtsDrift(driftMs)` or a ref with the current PTS gap
- `QualityCompare.tsx` reads this and applies a micro-seek correction when gap is consistently ≥ 1 frame
- The 5ms nudge changes which frame the compositor presents without visible seek

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
- WIP — Remove gpuPts drawLoop gate: fixes multi-second freezing but reintroduces visual artifacts when compositors are out of phase (1-frame diff). Added diagnostic logging. Next step: double-buffer GPU textures (Action Item A)
