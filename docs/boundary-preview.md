# Boundary Preview — Frame-Number-Based Scene Boundary Visualization

When hovering over a scene boundary marker in the filmstrip timeline, the player shows a tooltip with the last frame before and the first frame after the boundary, decoded at thumbnail resolution. This document covers the architecture of this feature and the investigation that led to the current frame-number-based approach.

## Architecture

### Data flow

1. **av1an JSON** → `parseSceneData()` → `SceneData` with `originalFrames: number[]` (raw frame numbers) and `boundaries: number[]` (seconds)
2. **FPS correction** in `VideoControls` useEffect: recomputes `boundaries` from `originalFrames` whenever `detectedFps` or `startOffset` changes: `frame / fps + startOffset`
3. **Hover** in `FilmstripTimeline.onMouseMove`: finds nearest boundary, calls `requestBoundaryPreview(boundaryTime, frameNumber)` where `frameNumber` comes from `sceneData.originalFrames[boundaryIdx]`
4. **Worker** receives `{ type: "boundaryPreview", boundaryTime, frameNumber }`:
   - Uses `boundaryTime` (approximate) to find the right segment
   - Fetches and parses the segment to get `framesPerSeg`
   - Computes `localIndex = frameNumber - segmentIndex * framesPerSeg`
   - Looks up exact CTS from `displayOrder[localIndex - 1]` and `displayOrder[localIndex]`
   - Decodes all frames, captures the two targets via `frame.timestamp` matching
5. **Result** posted back as `{ type: "boundaryPreview", boundaryTime, beforeBitmap, afterBitmap }`
6. **Tooltip** renders two canvases side-by-side with an orange divider

### Cache management

- `useThumbnailGenerator` maintains `boundaryPreviews: Map<number, BoundaryPreview>` keyed by `boundaryTime`
- `pendingBoundaryRef: Set<number>` prevents duplicate in-flight requests
- `clearBoundaryPreviews()` invalidates cache when `sceneData` changes (FPS correction)
- Bitmaps are closed on cache clear and on hook cleanup

### Cross-segment boundaries

When `localIndex === 0` (boundary at segment start), the worker decodes two separate segments:
- **Before**: last frame (display order) of the previous segment
- **After**: first frame (display order) of the current segment

The `decodeSingleFrame(segIdx, "first" | "last")` helper handles this case.

## Investigation History

### Attempt 1: Output index counting

**Approach**: Decode all frames in the segment, count VideoDecoder output frames, capture at `outputIndex === targetIdx`.

**Failure**: VideoDecoder skips leading B-frames that lack references from the previous segment. For example, a segment starting at DASH time 2.0 may have its first sample at CTS 2.08 (I-frame), with B-frames at CTS 2.00 and 2.04 appearing later in DTS order. These B-frames fail to decode in isolation, so the decoder silently drops them. This shifts all output indices, causing the wrong frames to be captured.

### Attempt 2: CTS timestamp matching

**Approach**: Compute `dashTime = boundaryTime + startOffset`, find the CTS values just before/after `dashTime` in the segment's display order, then match `frame.timestamp` in the VideoDecoder output callback.

**Failure**: The mapping `frame / fps + startOffset` does not produce exact CTS values. CTS values in an mp4 segment depend on the encoder's actual composition time offsets per sample, not on a simple arithmetic formula. For example, frame 90 at 25fps with CTO 0.18 would suggest CTS = 3.78, but the actual segment might have frames at CTS 3.76 and 3.80 (no frame at 3.78). The worker would select the wrong adjacent pair.

### Attempt 3: FPS correction race condition fix

**Approach**: Store `originalFrames` in `SceneData` and always recompute boundaries from scratch: `frame / detectedFps + startOffset`. Added `clearBoundaryPreviews()` to invalidate cache on sceneData changes.

**Failure**: Eliminated cumulative drift in FPS correction, but the core problem remained: `detectedFps` and `startOffset` settle at different times during player initialization. The boundary time passed to the worker was sometimes computed with stale `startOffset`, producing an intermediate value (e.g., 3.78 instead of 3.6). Even with the correct boundary time, the formula-based CTS lookup still had precision issues.

### Attempt 4: Frame-number-based index lookup (final, working)

**Approach**: Pass the raw frame number from av1an's `originalFrames` directly to the worker. The worker:
1. Uses `boundaryTime` (approximate) only for segment location
2. Fetches the segment, counts actual frames → `framesPerSeg`
3. Computes `localIndex = frameNumber - segIdx * framesPerSeg`
4. Reads the exact CTS from `displayOrder[localIndex - 1]` and `displayOrder[localIndex]`
5. Matches via `frame.timestamp` in the decoder output

**Why it works**: The frame number is the ground truth from av1an. By looking up the CTS directly from the parsed segment data (not computing it from fps/offset), we bypass all CTS/CTO/FPS mapping inaccuracies. The `displayOrder` array is sorted by actual CTS from the mp4 container, so `displayOrder[N]` is always the Nth frame in presentation order, regardless of B-frame reordering, composition time offsets, or presentation timeline adjustments.

## Key Lessons

1. **VideoDecoder may silently skip frames** — leading B-frames without reference frames from the previous segment are dropped without error. Output index counting is unreliable.

2. **`frame / fps + startOffset` ≠ actual CTS** — the CTS grid in an mp4 segment depends on per-sample composition time offsets set by the encoder. Simple arithmetic from frame number and fps produces an approximation, not exact values.

3. **React state updates are not atomic across components** — `detectedFps` and `startOffset` propagate through separate state updates. The FPS correction useEffect may fire with stale values for one while the other has updated, producing intermediate boundary values.

4. **Frame numbers are the invariant** — av1an's frame numbers are absolute. Converting to timestamps introduces encoder-dependent, timeline-dependent, and timing-dependent errors. Keeping the raw frame number through the pipeline to the worker and resolving to CTS only at the point of segment parsing eliminates all intermediate mapping errors.
