# Scene Boundary Timing — ISM/DASH PTS Offset Investigation

Investigation of scene boundary misalignment when loading av1an scene detection data for DASH streams served by IIS Smooth Streaming (ISM) origins.

## Problem Statement

When av1an scene detection JSON (produced from a locally downloaded copy of a DASH stream) is loaded into the player, scene boundary markers don't align with actual shot changes visible in the video. A related symptom: the first 2–3 frames of the video are inaccessible — seeking to 0:00:00.000 snaps forward to ~0:00:00.080.

## Test Stream

```
<ISM_DASH_MANIFEST_URL>
```

*(Redacted — internal CDN URL. Add locally for reproduction.)*

Properties:
- **Origin**: IIS Smooth Streaming (`output.ism`) repackaged to DASH
- **Codec**: HEVC (H.265) with B-frames
- **Frame rate**: 25 fps (exactly)
- **Representations**: 576p (696 kbps), 720p (1.87 Mbps), 1080p (3.84 Mbps)
- **Manifest duration**: `PT7M8.921S` (428.921s)
- **Segment structure**: 142 segments × 3.000s + 1 final segment × 2.920s (143 total)
- **Manifest timescale**: 10,000,000 (ISM standard, 100ns ticks)
- **Audio**: AAC 48 kHz stereo, 256 kbps

## Reproduction Steps

### 1. Download the stream locally

```bash
ffmpeg -i "<manifest_url>" -codec copy wolf.mp4
```

Note: `-r 24` or other frame rate flags are unnecessary and harmful with `-codec copy`.

### 2. Run av1an scene detection

```bash
av1an --sc-only -i wolf.mp4 --scenes wolf.json -x 0
```

### 3. Probe the downloaded file

```bash
# Stream metadata
ffprobe -select_streams v -show_entries stream=r_frame_rate,avg_frame_rate,nb_frames,duration,start_time,start_pts,time_base -of json wolf.mp4

# First 10 frame timestamps
ffprobe -select_streams v -show_entries frame=pts_time,pict_type -of csv=p=0 wolf.mp4 | head -10

# PTS drift analysis at key positions
ffprobe -select_streams v -show_entries frame=pts_time -of csv=p=0 wolf.mp4 | \
  awk -F, '{f=NR-1; exp=f/25.0; act=$1+0; drift=act-exp; \
    if (f==0||f==75||f==150||f==750||f==5000||f==10000) \
    printf "frame %5d: PTS=%.6f expected=%.6f drift=%+.6f (%.1f frames)\n", f, act, exp, drift, drift*25}'

# Keyframe positions (segment boundaries for 75-frame GOPs)
ffprobe -select_streams v -show_entries frame=pts_time,pict_type -of csv=p=0 wolf.mp4 | \
  awk -F, '$2=="I" {print NR-1": PTS="$1}' | head -20

# Audio stream timing
ffprobe -select_streams a -show_entries stream=start_time,start_pts,duration -of json wolf.mp4

# Container-level timing
ffprobe -show_entries format=start_time,duration -of json wolf.mp4
```

### 4. Load in player and compare

Open the manifest in the player, load `wolf.json` as scene data (via filmstrip right-click → "Load scene data..." or drag-and-drop), and compare marker positions with actual shot changes.

## Findings

### Finding 1: Constant PTS Offset (+93ms)

The video track in the downloaded MP4 starts at PTS 0.093018s, not 0.000s:

```
Video stream:  start_pts=1143  time_base=1/12288  → start_time=0.093018s
Audio stream:  start_pts=0     time_base=1/48000  → start_time=0.000000s
Container:     start_time=0.000000s (driven by audio)
```

The offset is **constant** across the entire file — no cumulative drift:

```
frame     0: PTS=0.093018   expected=0.000000   drift=+0.093018s (2.3 frames)
frame    75: PTS=3.093018   expected=3.000000   drift=+0.093018s (2.3 frames)
frame   150: PTS=6.093018   expected=6.000000   drift=+0.093018s (2.3 frames)
frame  2500: PTS=100.093018 expected=100.000000  drift=+0.093018s (2.3 frames)
frame  5000: PTS=200.093018 expected=200.000000  drift=+0.093018s (2.3 frames)
frame 10000: PTS=400.093018 expected=400.000000  drift=+0.093018s (2.3 frames)
frame 10647: PTS=425.972982 expected=425.880000  drift=+0.092982s (2.3 frames)
```

**Cause**: HEVC B-frame composition time offset (CTO). The first I-frame is displaced forward by ~2.3 frames to accommodate B-frames in the reorder buffer. This is standard HEVC encoder behavior with the ISM packager preserving the raw CTS values.

### Finding 2: Missing Last DASH Segment (75 frames / 2.92s)

| Source | Frames | Duration | Last frame PTS |
|---|---|---|---|
| DASH manifest | 10,723 (calculated: 428.921 × 25) | 428.921s | ~428.973s |
| Downloaded MP4 | 10,648 (actual) | 426.013s | 425.973s |
| **Gap** | **75 frames** | **~2.908s** | — |

The gap is exactly one segment (75 frames at 25fps = 3.0s). ffmpeg's DASH demuxer failed to download the last segment. The last keyframe in the file is at frame 10,575 (PTS 423.093s), which is the start of segment 141 (0-indexed). Segment 142 (the final 2.92s segment) is missing entirely.

### Finding 3: Frame-Level Timing Structure

```
Keyframes every 75 frames (segment boundaries):
  frame    0: PTS=0.093018   (I) ← segment 0
  frame   75: PTS=3.093018   (I) ← segment 1
  frame  150: PTS=6.093018   (I) ← segment 2
  ...
  frame 10575: PTS=423.093018 (I) ← segment 141

GOP structure within each segment:
  I B B B P B B B P B B B P ... (75 frames total)

Frame interval: exactly 40ms (1/25s), alternating between:
  - 39.957ms and 40.039ms (rounding at timescale 1/12288)
  - Average: 39.998ms ≈ 40.000ms (no accumulated drift)
```

### Finding 4: Player Timeline vs MP4 Timeline

In the DASH player (MSE pipeline):
- Audio SourceBuffer starts at time 0.000s
- Video SourceBuffer first frame appears at 0.080s (CTO partially normalized by Shaka's `timestampOffset`)
- `video.currentTime` = 0 corresponds to audio start, first video frame renders at 0.080

The raw MP4 CTO is 0.093018s, but Shaka's segment timeline mapping normalizes it to 0.080s (exactly 2 frames at 25fps). The MSE-visible offset is 0.08, not 0.093.

Consequence: seeking to time 0.000s shows no video (or a black frame), the visible first video frame is at 0.080s. This explains why frames 0 and 1 in the filmstrip are "inaccessible" — clicking them seeks to a time before the first video PTS.

### Finding 6: Inaccessible First Frames — ISM PTS Offset, Not HEVC Codec

~~Initially attributed to a browser MSE HEVC seek limitation.~~ **Invalidated by testing**: the HEVC Frame Counter fixture (`fixtures/frames/hevc/manifest.mpd`) starts at PTS 0.000 with the same IBBBP B-frame structure and frames 0–1 are perfectly accessible and synchronized between main player and filmstrip.

The inaccessible frames 0–1 on the ISM stream are caused by the non-zero PTS offset (0.093s), not by the HEVC codec. The `startOffset` detection in ShakaPlayer (`video.currentTime` at `canplay`) likely returns 0 for this stream (positioned at the audio start, not the first video frame), so the seek clamp has no effect.

**Corrected comparison**:

| Fixture | Codec | First frame PTS | Frames 0-1 accessible? | Cause |
|---|---|---|---|---|
| Frame Counter (AVC) | H.264 | 0.000s | Yes | — |
| Frame Counter (HEVC) | H.265 | 0.000s | Yes | — |
| ISM HEVC stream | H.265 | 0.093s | No | Non-zero CTO from ISM packager |

**Root cause identified** — see Finding 7.

### Finding 7: `startOffset` Detection Had Two Bugs

The original detection in `ShakaPlayer.tsx` used `video.currentTime` at the `canplay` event, gated on `loadStartTime == null`:

```typescript
// Original (broken)
if (loadStartTime == null) {
  const onCanPlay = () => {
    setStartOffset(video.currentTime);
  };
  video.addEventListener("canplay", onCanPlay, { once: true });
}
```

**Bug 1 — Detection skipped on repeated loads**: The player persists playback position to `sessionStorage`. On the ISM stream, the minimum reachable position is 0.08s (frame 2), so that gets saved. On next load, `loadStartTime = 0.08`, the `loadStartTime == null` guard is false, and the entire detection block is skipped. `startOffset` stays at 0. This was the primary bug — the detection method was fine, it was just never called.

**Bug 2 — `video.currentTime` reflects seek target, not CTO**: Even if the guard were removed, `video.currentTime` at `canplay` when loading from a non-zero saved position (e.g. 120s) returns ~120, not the CTO. This made the approach fundamentally unsuitable for resumed playback.

### Finding 8: Shaka `getBufferedInfo()` Exposes Per-Track Buffer Ranges

Diagnostic output from a fresh load (no saved state) of the ISM stream:

```
shaka bufferedInfo.audio: [{"start":0,"end":2.986666}]
shaka bufferedInfo.video: [{"start":0.08,"end":3.08}]
video.buffered (intersection): 0.08 – 2.986666
video.currentTime: 0.08
```

Key observations:

1. **Audio SourceBuffer starts at 0.000**, video at **0.080**. The delta (0.08) is the CTO as seen by the MSE pipeline — 2 frames at 25fps.

2. **`video.buffered` returns the intersection** of audio + video ranges (0.08–2.99). `video.buffered.start(0)` = 0.08, which equals `video.currentTime` = 0.08. Both methods give the same result on a fresh load.

3. **The CTO in MSE (0.080s) differs from the raw MP4 CTO (0.093s)**. The ISM packager stores the raw composition time offset (0.093018s at timescale 1/12288). Shaka's DASH parser applies `timestampOffset` adjustments when mapping segment timeline to SourceBuffer, partially normalizing the CTO. The result is 0.08 (exactly 2 frames) rather than 0.093 (2.3 frames). The MSE-visible CTO is the correct value to use since the player operates in the MSE presentation timeline, not the raw MP4 timeline.

4. **The delta approach works for any seek position**: the CTO is constant across segments (same GOP structure). When loading from a mid-stream saved position, audio and video buffers for the loaded segment still differ by the CTO. `video[0].start - audio[0].start ≈ 0.08` regardless of which segment was loaded.

### Finding 5: Scene Boundary Conversion Error

The current conversion `boundary_time = start_frame / fps` assumes frame 0 is at time 0.000s. But in the DASH player, frame 0 is at time ~0.093s.

For every scene boundary:

| Scene boundary | Our marker | Actual position in player | Error |
|---|---|---|---|
| Frame 105 | 4.200s | ~4.293s | -93ms (2.3 frames early) |
| Frame 510 | 20.400s | ~20.493s | -93ms (2.3 frames early) |
| Frame 5000 | 200.000s | ~200.093s | -93ms (2.3 frames early) |

All markers are placed ~93ms (2.3 frames) before the actual scene change. The error is constant, not growing.

## Scene Data Summary

```
av1an output: 129 scenes, 128 boundaries
Frame range: 0–10,648
Total boundaries: 128
First 5: frames 105, 201, 287, 336, 375
Last 5:  frames 10297, 10339, 10381, 10421, 10543
```

## Analysis: Why the Offset Exists

The root cause is the mismatch between two time domains:

1. **DASH presentation timeline** — starts at 0, segment 0 begins at 0.000s. The player's seekbar and `video.currentTime` operate in this domain. However, the first video sample has a composition time offset (CTO) that places it at 0.080s (2 frames), not 0.000s.

2. **MP4 frame index domain** — av1an numbers frames sequentially (0, 1, 2, ...). Frame N's PTS in the container is `0.093 + N × 0.040s`. The conversion `N / 25` maps to `N × 0.040s`, missing the base offset.

The offset originates from the HEVC encoder's B-frame reordering. With a reorder depth of ~2 frames, the first I-frame's composition time is pushed forward to leave room for B-frames that precede it in display order but follow in decode order. The ISM packager preserves this raw CTS (0.093018s in the MP4). Shaka's DASH segment timeline mapping partially normalizes it when setting `timestampOffset` on the SourceBuffer, resulting in a clean 0.080s (2 frames) offset in the MSE presentation timeline.

### Three Time Domains

| Domain | Frame 0 PTS | Frame 105 PTS | Source |
|---|---|---|---|
| Raw MP4 (ffprobe) | 0.093018s | 4.293018s | Container timestamps |
| MSE presentation (browser) | 0.080s | 4.280s | After Shaka `timestampOffset` |
| av1an frame index (`N/fps`) | 0.000s | 4.200s | Frame count ÷ fps |

The player operates in the MSE presentation domain. Scene boundaries must be corrected from the av1an domain by adding the MSE-visible CTO (0.080s), not the raw MP4 CTO (0.093s).

## Action Plan

### AP-1: Auto-detect PTS offset from per-track buffer ranges ✅

After the video loads, compare audio and video buffer start times via `player.getBufferedInfo()`. The delta `video[0].start - audio[0].start` gives the CTO as seen by MSE. Store it as `startOffset` and apply to all scene boundaries: `corrected_time = (start_frame / fps) + startOffset`.

This avoids MP4 box parsing entirely — Shaka/MSE already computed the offset. The detection works regardless of whether loading from the beginning or from a saved position (the CTO is constant across segments). The correction is applied alongside the existing FPS correction in VideoControls.

**Implementation** (`ShakaPlayer.tsx`, `canplay` handler):

```typescript
const bi = player.getBufferedInfo();
let offset = 0;
if (bi.audio.length > 0 && bi.video.length > 0) {
  const delta = bi.video[0].start - bi.audio[0].start;
  if (delta > 0.001 && delta < 0.5) {
    offset = delta;
  }
} else if (loadStartTime == null) {
  // Video-only or audio-only: fall back to buffered start
  offset = video.buffered.length > 0
    ? video.buffered.start(0)
    : video.currentTime;
}
setStartOffset(offset);
```

Note: the `loadStartTime == null` guard is only on the fallback path. The primary detection (audio/video delta) always runs.

### AP-2: Clamp seek targets to first video PTS ✅

When seeking via progress bar or filmstrip, clamp the target time to `startOffset` (detected first-frame PTS). This prevents seeking to a time before the first video frame.

**Implemented**: Seek clamping in VideoControls (`handleSeek`, `goToPrevScene`) and FilmstripTimeline (`seekToX`). Now works correctly because `startOffset` is reliably detected via AP-1.

### AP-3: Add `sceneOffset` URL param (manual calibration fallback)

Add a `sceneOffset` URL parameter (seconds) that shifts all boundaries. For cases where auto-detection doesn't work or the user wants fine-tuning. Include in shareable URL.

### AP-4: Warn on frame count mismatch

When scene data's `totalFrames` (10648) differs significantly from `duration × fps` (10723), show a console warning. Signals the source file doesn't match the stream exactly (e.g. missing last segment from ffmpeg download).

### AP-5: Document ffmpeg best practices

Add a note about the last-segment download issue. Recommend `yt-dlp` or `shaka-packager` as alternatives for full segment enumeration.

## Potential Solutions (Research)

The following options were considered during investigation. AP-1 supersedes Options A–D by using `player.getBufferedInfo()` to compare audio/video buffer starts instead of parsing MP4 boxes or segment timelines.

### Option A: Detect and apply PTS offset from first segment

When scene data is loaded, probe the first video segment to extract the initial CTO. Apply it as a constant offset to all boundaries: `corrected_time = (start_frame / fps) + initial_cts_offset`.

Pros: Automatic, handles any stream. Cons: Requires parsing the first segment's MP4 boxes (trun/ctts) from the worker.

### Option B: User-configurable offset parameter

Add a `sceneOffset` URL parameter (in seconds or frames) that shifts all boundaries. The user can calibrate by comparing a known scene change.

Pros: Simple, works for any source of error. Cons: Manual calibration.

### Option C: Scale boundaries to match DASH duration

If the MP4 duration differs from the manifest duration, apply a linear scale: `corrected_time = (start_frame / fps) × (manifest_duration / mp4_duration)`.

Pros: Corrects for duration mismatch. Cons: Doesn't fix the constant CTO offset; the two errors (offset + scale) are independent.

### Option D: Frame-to-PTS mapping via segment timeline

Use the DASH SegmentTimeline to build a segment-aware mapping. Each segment's start time is known (0, 3.0, 6.0, ...) and contains 75 frames. Frame N maps to: `segment_start_time + (N % 75) × (segment_duration / 75)`. This accounts for segment-level timing without needing to parse MP4 boxes.

Pros: Uses data already available from Shaka. Cons: Assumes uniform frame count per segment.

## Open Questions

1. Is the 93ms CTO offset universal for ISM/DASH streams, or does it vary per encoder/packager? Other ISM streams should be tested. The ffmpeg-generated HEVC fixture does NOT exhibit the CTO offset (PTS starts at 0.000), confirming this is ISM-specific.
2. ~~Does Shaka Player's `timestampOffset` on the SourceBuffer ever compensate for the CTO? Current evidence says no (the inaccessible frames 0–1 confirm it).~~ **Partially answered**: Shaka applies `timestampOffset` that normalizes the raw CTO (0.093s) to a frame-aligned value (0.080s = 2 frames at 25fps). The CTO is not fully compensated away — it becomes a clean 2-frame offset instead of 2.3 frames.
3. Does av1an's scene detection accuracy itself contribute to perceived misalignment? The detection algorithm may place boundaries 1–2 frames away from the true cut point independently of the timing issue.
4. The last-segment download failure with ffmpeg — is this reproducible across streams, or specific to short final segments?
5. ~~Is the HEVC MSE seek skip (Finding 6) consistent across browsers?~~ Invalidated — HEVC seeking works fine when PTS starts at 0. The issue is ISM PTS offset specific.
6. ~~What does `video.buffered.start(0)` return for the ISM stream after loading?~~ **Answered**: Returns 0.08 (the intersection of audio 0–2.99 and video 0.08–3.08). Both `video.buffered.start(0)` and `video.currentTime` return 0.08 on a fresh load. The actual detection uses `player.getBufferedInfo()` to compare per-track ranges, which works regardless of load position.
7. ~~Does Shaka expose the first video sample's PTS offset via its API?~~ **Answered**: `player.getBufferedInfo()` returns separate `.audio` and `.video` buffer ranges. The delta between `video[0].start` and `audio[0].start` gives the CTO. `player.getStats()` and manifest metadata do not expose it directly.
