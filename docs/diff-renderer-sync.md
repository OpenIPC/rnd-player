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

### Race 5: Residual playback race (OPEN — intermittent)

**Symptom**: mostly correct, but occasional mismatches still appear during playback.

**Hypotheses**:

1. **GPU texture overwrite between RVFC callbacks**: RVFC A uploads texA with frame N. Then RVFC A fires again (frame N+1) before rAF draws, overwriting texA. Meanwhile texB still has frame N. The rAF draw checks `gpuPtsA == gpuPtsB` but by the time it draws, the texture data doesn't match the tracked PTS because it was overwritten.

2. **Metrics ImageData overwrite**: similarly, `capturedDataA` is overwritten by the next RVFC A callback before `tryMatch` processes it. The PTS check should catch this (new PTS won't match old capturedPtsB), but there could be edge cases.

3. **Frame drops under load**: two independent decoders may drop different frames under CPU pressure (metrics computation takes ~2-7ms per frame). If video A drops frame N but video B doesn't, they can never show the same frame N. The PTS match handles this correctly (skips the unmatched frames), but it reduces the effective update rate.

4. **RVFC callback ordering**: the spec doesn't guarantee RVFC callbacks fire before rAF callbacks within the same frame. If rAF fires between two RVFC callbacks, it might draw with one texture updated and the other stale. The `gpuPtsA == gpuPtsB` check should prevent this, but timing edge cases are possible.

5. **drawImage capturing wrong frame despite RVFC timing**: `requestVideoFrameCallback` fires when a frame is "presented for compositing", but `drawImage(video)` captures the video element's "current frame for rendering". These might not be exactly the same thing in all browser implementations. There could be a one-tick lag between RVFC notification and the frame being available via `drawImage`.

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

1. **Paused** (`if (paused)`): captures from video on `seeked` events, uses `isVideoSynced()` (currentTime-based), uploads textures synchronously, draws immediately.

2. **Playing + RVFC** (`else if (hasRVFC && videoA)`): RVFC callbacks capture metrics data + upload GPU textures at composition time. `tryMatch()` computes metrics when PTS matches. rAF loop only draws.

3. **Playing without RVFC** (`else`): rAF-based fallback with `isVideoSynced()` guard and adaptive throttle. Less accurate — currentTime check can't guarantee same compositor frame.

### Key functions

- `computeMetrics(dataA, dataB)` — shared: computes PSNR, SSIM, MS-SSIM (if active), VMAF (if active), uploads heatmap R8 texture
- `uploadVideoTextures()` — reads from live video elements into GPU textures (used only in paused path now)
- `drawQuad()` — issues GL draw call with whatever textures are bound
- `resizeCanvas()` — matches canvas pixel buffer to CSS layout × DPR
- `isVideoSynced()` — currentTime-based sync check (paused path only)

## Action Items to Investigate

### 1. Double-buffer GPU textures

Instead of each RVFC overwriting a single texture, maintain two texture sets ("front" and "back"). RVFC callbacks write to the back buffer. When both back textures have matching PTS, swap front↔back atomically. rAF always draws from front buffer. This eliminates the window where one texture is overwritten before rAF draws.

### 2. Capture-and-hold with ImageBitmap

Instead of `texImage2D(video)` in RVFC (which reads from the live compositor), use `createImageBitmap(video)` (async but captures the current frame). Store the ImageBitmap and upload to GPU texture later. Caveat: `createImageBitmap` is async — the frame might change before the promise resolves. Could also try synchronous capture via OffscreenCanvas + `drawImage` at full resolution (not just 120×68).

### 3. Single-video approach

Instead of two Shaka Player instances, decode the second rendition in a Web Worker using `VideoDecoder` (like the filmstrip does). The worker can decode a specific segment's frames on demand, eliminating the compositor sync problem entirely. Downside: significant architectural change, and CPU decode of 1080p is expensive.

### 4. Pause-capture-resume

On each metrics computation: pause both videos briefly (1-2 frames), capture both, resume. This guarantees both decoders stop advancing. Downside: visible stutter during playback.

### 5. Frame hash comparison

After capturing both frames, compute a quick hash (e.g., sum of center row pixels) and compare. If they differ by more than the expected rendition difference, skip the frame. This is a heuristic — it works for frame-numbered test content but may false-positive on real content with large quality differences.

### 6. Investigate requestVideoFrameCallback accuracy

Test whether `drawImage(video)` inside the RVFC callback truly captures the reported frame, or whether there's a browser-specific one-tick lag. Could be tested by capturing the frame counter from the test fixture within the RVFC callback and comparing to the expected frame number from `meta.mediaTime * 30`.

### 7. Investigate frame drop correlation

Add logging to track `meta.presentedFrames` (RVFC metadata) for both videos. If the counts diverge, frames are being dropped. This would confirm or rule out the frame-drop hypothesis.

### 8. WebCodecs VideoFrame approach

Use `HTMLVideoElement.requestVideoFrameCallback` combined with the experimental `VideoFrame` API to get a `VideoFrame` object directly. This provides an immutable handle to the exact composited frame, avoiding the `drawImage` timing race entirely. Check browser support.

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
