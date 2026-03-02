# AudioCompare — Side-by-Side Audio Track Comparison

## Overview

Split-mode panel: Track A (playing) on the left, Track B (comparison) on the right, with a shared dB scale in the center. Compares dBFS levels, LUFS loudness (Momentary/Short-term/Integrated), True Peak, and Loudness Range across any two audio tracks in the manifest.

Accessed via right-click context menu → "Audio comparison". Requires `moduleConfig.audioCompare` and ≥2 audio tracks in the manifest.

## Files

| File | Role |
|------|------|
| `src/components/AudioCompare.tsx` | Main panel: canvas paint loop, toolbar, Track B dropdown, summary rows |
| `src/hooks/useTrackAMeter.ts` | Unified Track A metering selector (shared with AudioLevels) |
| `src/hooks/useAudioCompareMeter.ts` | Independent Track B metering (meter-only, no playback) |
| `src/hooks/useAudioAnalyser.ts` | Web Audio backend (Track A default on Chrome/Firefox) |
| `src/hooks/useLoudnessMeter.ts` | LUFS computation for Web Audio backend |
| `src/hooks/useAudioMeterFallback.ts` | Pre-computed block backend (Track A when AudioCompare is open; always-on for Safari) |
| `src/hooks/useEc3Audio.ts` | EC-3 software decode + playback + metering (Track A when EC-3 active) |
| `src/hooks/useAudioCompareMeter.ts` | Track B fetch + decode + metering (independent worker) |
| `src/workers/audioMeterWorker.ts` | Decodes fMP4 audio → PCM → MeterBlocks |
| `src/utils/audioMeterDraw.ts` | Shared canvas drawing (dBFS bars, LUFS bars, sparkline, dB scale) |
| `src/utils/dashAudioParser.ts` | `parseAllAudioTracks()`, `Ec3TrackInfo` type |
| `src/components/VideoControls.tsx` | Owns `showAudioCompare` state, computes `trackAId`, renders `<AudioCompare>` |
| `src/components/ContextMenu.tsx` | "Audio comparison" menu item |

## Architecture

### Track A metering

`useTrackAMeter` wraps three backends and selects one:

```
useTrackAMeter(videoEl, player, safariMSE, ec3Audio, preferPrecomputed)
  ├── useAudioAnalyser       — Web Audio AnalyserNode (real-time)
  ├── useLoudnessMeter       — K-weighted LUFS via Web Audio IIR
  ├── useAudioMeterFallback  — pre-computed blocks via response filter + OfflineAudioContext
  │
  └── Selection priority:
        1. EC-3 active      → ec3Audio.readLevels / readLoudness
        2. Safari MSE or    → fallback.readLevels / readLoudness
           preferPrecomputed
        3. Default          → webAudio.readLevels / webLoudness.readLoudness
```

**Key design decisions:**

- **`preferPrecomputed`** is `showAudioCompare`. When AudioCompare is open, Track A switches from real-time Web Audio to the pre-computed fallback pipeline — the same pipeline Track B uses. This eliminates metering discrepancy between the two panels caused by different timing, block alignment, and decode paths.

- **Fallback always runs** (when not EC-3). The response filter intercepts audio segments from the start, so pre-computed blocks are already populated when AudioCompare opens. Without this, the fallback would need to bootstrap (fetch init + media segments around current time) which causes a multi-second gap with no data.

- **Web Audio stays enabled** even when fallback output is selected. Disabling `useAudioAnalyser` would suspend the `AudioContext`, which kills the video's audio routing through `MediaElementAudioSourceNode` — freezing both audio and video playback.

### Track B metering

`useAudioCompareMeter` fetches and decodes segments independently (no native playback):

```
AudioCompare → useAudioCompareMeter(videoEl)
  ├── activate(track) → spawn Worker, fetch init segment
  ├── Prefetch loop (2s interval): resolve segment URLs, fetch media, post to worker
  ├── Worker ("decodeEc3"): 3-stage fallback:
  │     Stage 1: OfflineAudioContext on combined fMP4
  │     Stage 2a: mp4box demux → ADTS wrap → OfflineAudioContext
  │     Stage 2b: WASM EC-3/AC-3 decoder (for Dolby codecs)
  ├── readLevels(): binary-search closest MeterBlock by currentTime
  └── readLoudness(): LUFS ring buffers + gating + LRA
```

### Track selection

**`allAudioTracks`** — parsed from the MPD manifest by `parseAllAudioTracks()` in `ShakaPlayer.tsx`. Includes ALL audio tracks regardless of codec or native support.

**Identifying Track A** in `allAudioTracks` (`VideoControls.tsx`):
- EC-3 active: use `ec3Audio.activeTrackId` directly
- Native audio: match by language (normalized via `Intl.Locale` to handle ISO 639-1 "ru" vs ISO 639-2 "rus" mismatch between Shaka and MPD) + non-EC-3 codec

**Track B dropdown** (`AudioCompare.tsx`):
- Excludes the active Track A
- Sorted by relevance: same language first, different codec within same language at the top (e.g., AAC → EC-3 comparison is the most common use case)

## Canvas paint loop

Runs via `requestAnimationFrame`. Draws per frame:

| Layer | Description |
|-------|-------------|
| Track A dBFS bars | Gradient bars (green → yellow → red), peak hold (decays 10 dB/s), dB readout, channel labels |
| Center dB scale | Tick labels at -6, -12, -24, -48 with guide lines |
| Track B dBFS bars | Mirrored (bars grow right-to-left) |
| LUFS deltas | ΔM (momentary) and ΔS (short-term) in center column; color-coded: ≤1 LU green, ≤3 LU yellow, >3 LU red |
| Sparkline (bottom 32px) | 60-second LUFS momentary trace; Track A cyan, Track B orange; dashed target line |
| Summary rows (DOM, 4 Hz) | Integrated LUFS, True Peak dBTP, LRA LU per track + color-coded deltas |

## Pause behavior

All metering backends return silent bars (`dB: -60`) when `videoEl.paused`:
- No signal is flowing → meters reflect silence
- LUFS returns `null` → sparklines and integrated values freeze
- Consistent across Web Audio, fallback, EC-3, and Track B

## Module config

- `moduleConfig.audioCompare: boolean` — gated on Web Audio API presence
- Hard-disabled in `production` and `minimal` build presets
- Mutually exclusive with AudioLevels (opening one closes the other)

## Persistence

| Key | Storage | Description |
|-----|---------|-------------|
| `vp_loudness_target` | localStorage | Selected loudness target (-14, -16, -23, -24, -27 LUFS). Shared with AudioLevels |

No URL parameters. AudioCompare state (open/closed, Track B selection) is transient.

## Extending

**Adding a new metering backend**: Implement `readLevels()` / `readLoudness()` / `resetIntegrated()` matching the `TrackAMeterResult` interface. Add to `useTrackAMeter` dispatch. Ensure pause-silence behavior.

**Adding Track B codecs**: The `audioMeterWorker` 3-stage fallback handles this automatically. For new codecs not supported by `OfflineAudioContext` or the WASM EC-3 decoder, add a new stage in `handleDecodeEc3`.

**Adding delta metrics**: The center column in the canvas paint loop and the DOM summary rows are where deltas are computed and displayed. Add new computations in the `paint()` function and new DOM rows after the existing ones.

**Adding loudness presets**: Extend `TARGET_PRESETS` array in `AudioCompare.tsx`.
