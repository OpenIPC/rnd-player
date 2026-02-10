# Stats for Nerds — Technical Reference

How real-time playback diagnostics are extracted from Shaka Player and the browser.

## Data Sources

All stats are polled every **1 second** via `setInterval` — Shaka Player has no stats-changed event.

### Shaka Player APIs

| API | Returns | Used For |
|-----|---------|----------|
| `player.getAssetUri()` | `string \| null` | Manifest URL (Row 1) |
| `player.getManifestType()` | `string \| null` | Format label — `"DASH"`, `"HLS"`, etc. (Row 1) |
| `player.getStats()` | `shaka.extern.Stats` | Bandwidth, frames, bytes downloaded, latency, stalls, play/buffer/pause time, live latency (Rows 2, 7-12) |
| `player.getBufferedInfo()` | `shaka.extern.BufferedInfo` | Buffer health from `total` ranges (Row 9) |
| `player.getVariantTracks()` | `shaka.extern.Track[]` | Active/optimal resolution, codecs, color info (Rows 3, 5, 6) |

### HTMLVideoElement Properties

| Property / Method | Used For |
|-------------------|----------|
| `clientWidth`, `clientHeight` | Viewport size, multiplied by `devicePixelRatio` (Row 2) |
| `videoWidth`, `videoHeight` | Intrinsic (decoded) video frame dimensions (Row 2) |
| `getVideoPlaybackQuality()` | Browser-native frame stats — `totalVideoFrames`, `droppedVideoFrames`. Used as primary source; Shaka's `decodedFrames`/`droppedFrames` used as fallback when API unavailable (e.g. Safari). See "NaN Handling" below. |
| `volume`, `muted` | Volume percentage and mute state (Row 4) |
| `currentTime` | Subtracted from buffer end to get buffer health (Row 9) |

## Stats Rows

### Row 1 — Manifest
```
player.getAssetUri()  →  truncated to 60 chars if longer
player.getManifestType()  →  appended in parentheses, e.g. "(DASH)"
```

### Row 2 — Viewport / Frames
```
Viewport:  Math.round(videoEl.clientWidth * dpr) × Math.round(videoEl.clientHeight * dpr)
Intrinsic: videoEl.videoWidth × videoEl.videoHeight  (shown in parentheses if available)
Frames:    droppedVideoFrames  dropped of  totalVideoFrames  (from getVideoPlaybackQuality())
Fallback:  stats.droppedFrames / stats.decodedFrames  (if PlaybackQuality API unavailable)
```
The intrinsic resolution (`videoWidth`×`videoHeight`) shows the actual decoded frame size, which may differ from the viewport (CSS layout size × DPR) and the track's declared resolution.

### Row 3 — Current / Optimal Res
```
Current:  active track's  width×height@frameRate
Optimal:  highest-resolution track from getVariantTracks(), sorted by width*height descending
```

### Row 4 — Volume / Normalized
```
Volume:  Math.round(videoEl.volume * 100)%
State:   videoEl.muted → "muted" / "unmuted"
```

### Row 5 — Codecs
```
Video:  activeTrack.videoCodec  (activeTrack.videoId)
Audio:  activeTrack.audioCodec  (activeTrack.audioId)
```

### Row 6 — Color *(hidden if both null)*
```
activeTrack.colorGamut  /  activeTrack.hdr
```

### Row 7 — Connection Speed *(bar chart)*
```
stats.estimatedBandwidth / 1000  →  Kbps
Bar max: 20,000 Kbps
```

### Row 8 — Network Activity *(bar chart)*
```
Delta:  stats.bytesDownloaded(current) - stats.bytesDownloaded(previous tick)
Converted to KB/s (÷ 1024)
Total:  stats.bytesDownloaded / (1024 * 1024)  →  MB (cumulative, shown alongside delta)
Bar max: 2,048 KB/s
```
A `useRef` stores the previous tick's `bytesDownloaded` to compute the delta.

### Row 9 — Buffer Health *(bar chart)*
```
bufferedInfo.total[last].end - videoEl.currentTime  →  seconds
Bar max: 30 s
```

### Row 10 — Mystery Text
```
s:{stats.streamBandwidth}      — Stream bandwidth (bps)
t:{stats.loadLatency}          — Load latency (sec)
g:{stats.gapsJumped}/{stats.stallsDetected}  — Gaps jumped / Stalls detected
m:{stats.manifestSizeBytes}    — Manifest size (bytes)
```
Each value has a hover tooltip explaining the abbreviation.

### Row 11 — Playback
```
stats.playTime   →  seconds spent playing (rounded)
stats.bufferingTime  →  seconds spent buffering (1 decimal)
stats.pauseTime  →  seconds spent paused (rounded)
```

### Row 12 — Live Latency *(hidden for VOD)*
```
stats.liveLatency  →  seconds behind the live edge (2 decimals)
Only shown when liveLatency > 0 (i.e., live stream is active).
```

### Row 13 — Date
```
new Date().toString()
```

## NaN Handling

Some stats may be `NaN` or `undefined` depending on browser and content type:
- Frame counts (`decodedFrames`, `droppedFrames`) can be `NaN` on Safari.
- `liveLatency` is 0 or `NaN` for VOD content.
- Various stats may be 0 before playback begins.

A `safeNum()` helper guards every numeric stat value: if `NaN` or `undefined`, it returns `0`. The `getVideoPlaybackQuality()` API is preferred for frame counts (works reliably on Chrome/Edge/Firefox); Shaka's stats are used as fallback.

## Architecture

- **Portal rendering**: `StatsPanel` is rendered via `createPortal` into the player container (`vp-container`), *outside* the controls wrapper (`vp-controls-wrapper`). This keeps the panel visible when controls auto-hide during playback.
- **Click isolation**: The panel root has `onClick={e => e.stopPropagation()}`, and `.vp-stats-panel` is added to the `closest()` check in the container's click-to-play handler, preventing play/pause toggling when interacting with the panel.
- **Bar charts**: Inline `StatsBar` component renders a `<div>` fill inside a dark track. Width is `Math.min(value/max * 100, 100)%`.
- **Frame stats strategy**: `video.getVideoPlaybackQuality()` is checked first (feature-detected via `typeof`). If available, its `totalVideoFrames`/`droppedVideoFrames` are used. Otherwise, Shaka's `stats.decodedFrames`/`stats.droppedFrames` serve as fallback.
