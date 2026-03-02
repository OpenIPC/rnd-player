# Audio Decode Workarounds

Two browser bugs prevent audio metering and EC-3 playback. This document describes the root causes and implemented workarounds.

## Bug 1: Safari MSE Silence

### Root cause

[WebKit Bug #266922](https://bugs.webkit.org/show_bug.cgi?id=266922) — `MediaElementAudioSourceNode` returns silence for MSE-backed media. Safari's `AudioSourceProvider` does not route decoded PCM from the MSE pipeline into the Web Audio graph. Audio plays audibly through speakers, but `AnalyserNode` / `IIRFilterNode` connected to the source receive all zeros.

Affects: Safari on macOS/iOS, all codecs (AAC, EC-3, etc.), all MSE content (DASH/HLS via Shaka Player). Filed December 2023, still unresolved.

See `docs/safari-webaudio-silence-bug.md` for the full investigation.

### Workaround: ADTS decode fallback (`useAudioMeterFallback`)

Bypass Web Audio's `MediaElementAudioSourceNode` entirely. Instead, intercept raw audio segments and decode them independently.

```
Shaka plays audio natively (audible — unaffected)

Audio Levels opened in Safari:
  Shaka manifest → extract audio stream info (init URL, track IDs, codec)
  → fetch init segment → parse with mp4box (track config, timescale)
  → fetch media segments (bootstrap from manifest + ongoing via response filter)
  → extract raw AAC samples via mp4box setExtractionOptions/onSamples
  → wrap samples in 7-byte ADTS headers (syncword, profile, freq, channels, length)
  → concatenate ADTS frames → OfflineAudioContext.decodeAudioData()
  → compute per-2048-sample-block metering (RMS, K-weighted, TruePeak)
  → cache MeterBlock[] indexed by time → binary search for video.currentTime
```

#### Why ADTS wrapping

Safari's `OfflineAudioContext.decodeAudioData()` cannot decode fragmented MP4 (fMP4) directly — it expects self-contained audio formats. AAC samples extracted from fMP4 via mp4box are raw AU frames without framing. Wrapping each sample in a 7-byte ADTS header creates a valid ADTS stream that `decodeAudioData()` accepts.

ADTS header fields (7 bytes, no CRC):
- Syncword `0xFFF`, MPEG-4, Layer 0, no CRC
- Object type from codec string (e.g., `mp4a.40.2` → AAC-LC = 2)
- Frequency index from sample rate lookup table
- Channel configuration from track info
- Frame length = ADTS header (7) + sample size

#### Previous failed approaches

1. **Concatenating init + media fMP4** → `decodeAudioData()` rejects fMP4 on Safari
2. **WebCodecs `AudioDecoder`** → Crashes Safari's renderer process for AAC (tab killed with no JS error). WebKit-level bug, not a JS exception.
3. **Direct raw sample feeding** → No browser API accepts headerless AAC AU frames

#### DASH Presentation Time Offset

DASH segments contain media timeline timestamps in the `tfdt` box (Track Fragment Decode Time). These differ from `video.currentTime` (presentation timeline) by a fixed offset called `presentationTimeOffset` (PTO).

During bootstrap, the hook computes PTO:
```
PTO = extractTfdt(firstSegmentData, timescale) - shakaRef.getStartTime()
```

All subsequent segment timestamps are corrected: `presentationTime = mediaTime - PTO`. Without this correction, metering blocks are stored at wrong timestamps (e.g., 4168s instead of 573s) and `readLevels()` finds no matching block within its 150ms tolerance.

#### Key files

| File | Role |
|------|------|
| `src/hooks/useAudioMeterFallback.ts` | Main hook — bootstrap, response filter, ADTS decode, LUFS computation |
| `src/utils/biquadProcess.ts` | Software IIR biquad for K-weighting (worker-safe, no Web Audio dependency) |
| `src/components/AudioLevels.tsx` | Switches to fallback when `fallbackMode` prop is true |

---

## Bug 2: Chrome EC-3 Unsupported

### Root cause

Chrome (and Firefox) do not support EC-3 (Dolby Digital Plus) or AC-3 (Dolby Digital) audio codecs. `MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"')` returns false. Shaka Player filters out unsupported codecs during manifest parsing, so EC-3 audio tracks are invisible to the user.

Safari supports EC-3 natively (hardware decode via AudioToolbox).

### Workaround: WASM decode + AudioBufferSourceNode playback

Independent audio pipeline that fetches, decodes, and plays EC-3 segments alongside the video.

```
Before Shaka loads manifest:
  Parse MPD XML → detect EC-3 AdaptationSets
  → check MediaSource.isTypeSupported() → unsupported on Chrome
  → extract segment info (SegmentTemplate, SegmentTimeline, BaseURL)
  → strip EC-3 AdaptationSets from manifest XML (Shaka loads video + AAC only)
  → add EC-3 tracks to audio selector UI with "(SW)" suffix

When user selects an EC-3 track:
  useEc3Audio activates → spawns audioMeterWorker
  → resolves segment URLs (applying presentationTimeOffset)
  → fetches init + media segments independently (15s prefetch window)
  → posts to worker: { initData, mediaData, segmentStartTime, channels, sampleRate }

Worker (audioMeterWorker.ts):
  Try 1: OfflineAudioContext.decodeAudioData(init + media fMP4)
    → works in Safari (native EC-3 decode)
    → fails in Chrome (unsupported codec)
  Try 2 (WASM fallback):
    → demux fMP4 with mp4box → extract raw EC-3 frames via onSamples
    → load ec3-decoder.wasm (FFmpeg AC-3/E-AC-3 decoders, 512KB)
    → decode each frame → per-channel Float32Array PCM
    → compute metering blocks from PCM
    → post back: { pcmChannels (transferable), blocks, duration, sampleRate }

Main thread (useEc3Audio → useAudioPlayback):
  → enqueue PCM chunks sorted by time
  → schedule AudioBufferSourceNode.start(when) with 300ms lookahead
  → when = audioCtx.currentTime + (chunkTime - video.currentTime)
  → drift detection via RAF: if |expected - actual| > 50ms → re-sync
  → mute native video audio (videoEl.volume = 0)
  → handle play/pause/seek/ratechange events
```

#### WASM EC-3 Decoder

Built from FFmpeg's `libavcodec` (AC-3 + E-AC-3 decoders only) via Emscripten. EC-3 patents expired January 2026 — legal to distribute.

Build: `cd wasm && ./build-ec3.sh` (requires Emscripten SDK)
Output: `public/ec3-decoder.wasm` (512KB)
CI: `wasm-build` job verifies reproducible builds

The WASM module requires WASI initialization:

1. **Import stubs**: `args_sizes_get`, `environ_sizes_get` must write zeros to WASM memory pointers (argc=0, env_count=0). Other WASI functions (`fd_write`, `fd_seek`, etc.) return 0.

2. **`_start()` entry point**: Must be called before any decoder function. It runs `__wasm_call_ctors()` (initializes FFmpeg's codec registry via `avcodec_find_decoder`) then calls `main()` → `proc_exit(0)`. The `proc_exit` stub must throw an exception (not return) because WASM has an `unreachable` instruction after the call. The throw is caught and ignored — initialization is complete.

3. **Decoder lifecycle**: `ec3_decoder_create(channels, sampleRate)` → `ec3_decoder_decode(ptr, input, len, output, maxLen)` → returns interleaved float32 PCM → de-interleave into per-channel arrays.

#### Audio playback synchronization

`useAudioPlayback` schedules `AudioBufferSourceNode` instances against the video timeline:

- **Double buffering**: Always schedule the next chunk before the current one finishes (300ms lookahead)
- **Time mapping**: `audioContextTime = ctx.currentTime + (chunkVideoTime - video.currentTime)`
- **Drift detection**: RAF loop compares expected vs actual video position for currently-playing source. If drift exceeds 50ms, cancel all scheduled sources and let the scheduler recompute
- **Rate changes**: `source.playbackRate.value = videoEl.playbackRate` on all scheduled nodes
- **Seek**: Flush all scheduled sources + PCM queue. New segments arrive from re-fetch
- **Native audio muting**: `videoEl.volume = 0` when EC-3 active, restored on deactivate

#### Presentation time offset in manifest parsing

Same issue as Bug 1. DASH `<SegmentTimeline>` `@t` values are in media time. The `<SegmentTemplate>` `@presentationTimeOffset` attribute defines the offset:

```
presentationTime = (mediaTime - presentationTimeOffset) / timescale
```

`dashAudioParser.ts` extracts PTO from the template and applies it in `resolveSegmentUrls()` so segment timestamps align with `video.currentTime`.

#### Key files

| File | Role |
|------|------|
| `src/utils/dashAudioParser.ts` | Parse MPD for EC-3 tracks, resolve segment URLs with PTO |
| `src/hooks/useEc3Audio.ts` | Orchestrate: fetch, decode, play, meter with LUFS |
| `src/hooks/useAudioPlayback.ts` | AudioBufferSourceNode scheduling synced to video |
| `src/workers/audioMeterWorker.ts` | OfflineAudioContext → WASM fallback decode + metering |
| `src/wasm/ec3Decoder.ts` | WASM wrapper with WASI stubs and _start initialization |
| `wasm/build-ec3.sh` | Emscripten build script for FFmpeg EC-3 decoders |
| `public/ec3-decoder.wasm` | Pre-built WASM binary (512KB) |

---

## Integration: AudioLevels component

`AudioLevels.tsx` has three metering sources, selected by priority:

| Condition | Source | Hook |
|-----------|--------|------|
| EC-3 track active (`ec3Meter` prop) | Decoded PCM from WASM pipeline | `useEc3Audio.readLevels/readLoudness` |
| Safari MSE (`fallbackMode` prop) | ADTS-decoded segments | `useAudioMeterFallback.readLevels/readLoudness` |
| Default (Chrome/Firefox + native codec) | Web Audio `AnalyserNode` | `useAudioAnalyser` + `useLoudnessMeter` |

All three expose identical interfaces (`readLevels() → { levels: ChannelLevel[], error }` and `readLoudness() → LoudnessData | null`), so the rendering code is unchanged.

When `ec3Meter` is provided, both Web Audio and Safari fallback hooks are disabled (passed `enabled=false`) to avoid unnecessary resource usage.

---

## Debugging guide

### Safari metering not showing

1. Check `fallbackMode` prop reaches AudioLevels (should be `true` in Safari)
2. Verify bootstrap logs: init segment fetched, mp4box parsed tracks, ADTS decode produced PCM
3. Check PTO: if blocks exist but levels show empty, timestamps may not match `video.currentTime`
4. Verify response filter registered: ongoing segments should produce new blocks during playback

### Chrome EC-3 no sound

1. Check EC-3 tracks appear in audio selector (with "(SW)" suffix)
2. After selecting: check for decode errors in console (`[useEc3Audio] Decode error:`)
3. Verify WASM loads: fetch for `/ec3-decoder.wasm` should succeed (200, ~500KB)
4. Check WASM init: `_start()` must not throw (except the expected `WasiExit`)
5. Verify segment timing: decoded `segmentStartTime` should be near `video.currentTime`
6. Check AudioContext state: should be "running" (not "suspended" — needs user gesture)

### Common timing issues

- **Blocks stored at wrong time**: PTO not computed or applied. Check `dashAudioParser` PTO extraction and `useAudioMeterFallback` tfdt extraction.
- **Audio out of sync**: Drift detection threshold (50ms) may need adjustment for high-latency networks. Check `useAudioPlayback` scheduling logs.
- **Gaps in audio**: Prefetch window (15s) too small or segment fetch failures. Check network tab for failed requests.
