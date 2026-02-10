# Stats for Nerds — Technical Reference

How real-time playback diagnostics are extracted from Shaka Player and the browser.

## Data Sources

All stats are polled every **1 second** via `setInterval` — Shaka Player has no stats-changed event.

### Shaka Player APIs

| API | Returns | Used For |
|-----|---------|----------|
| `player.getAssetUri()` | `string \| null` | Manifest URL (Row 1) |
| `player.getManifestType()` | `string \| null` | Format label — `"DASH"`, `"HLS"`, etc. (Row 1) |
| `player.getStats()` | `shaka.extern.Stats` | Bandwidth, frames, bytes downloaded, latency, stalls (Rows 2, 7-10) |
| `player.getBufferedInfo()` | `shaka.extern.BufferedInfo` | Buffer health from `total` ranges (Row 9) |
| `player.getVariantTracks()` | `shaka.extern.Track[]` | Active/optimal resolution, codecs, color info (Rows 3, 5, 6) |

### HTMLVideoElement Properties

| Property | Used For |
|----------|----------|
| `clientWidth`, `clientHeight` | Viewport size, multiplied by `devicePixelRatio` (Row 2) |
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
Frames:    stats.droppedFrames  dropped of  stats.decodedFrames
```

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

### Row 11 — Date
```
new Date().toString()
```

## Architecture

- **Portal rendering**: `StatsPanel` is rendered via `createPortal` into the player container (`vp-container`), *outside* the controls wrapper (`vp-controls-wrapper`). This keeps the panel visible when controls auto-hide during playback.
- **Click isolation**: The panel root has `onClick={e => e.stopPropagation()}`, and `.vp-stats-panel` is added to the `closest()` check in the container's click-to-play handler, preventing play/pause toggling when interacting with the panel.
- **Bar charts**: Inline `StatsBar` component renders a `<div>` fill inside a dark track. Width is `Math.min(value/max * 100, 100)%`.
