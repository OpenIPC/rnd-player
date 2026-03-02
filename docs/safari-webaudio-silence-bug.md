# Safari Web Audio Silence Bug — Research Results

## Problem

When opening the Audio Levels panel in **Safari** (macOS), `AnalyserNode.getFloatTimeDomainData()` returns all-zero samples despite the `AudioContext` reporting `state === "running"`. The video is playing with audible audio. After 10 consecutive zero-frame reads (~166ms at 60fps), the CORS detection heuristic triggers and displays:

> Audio levels unavailable (cross-origin media)

**Chrome and Firefox work correctly** — the same code produces non-zero analyser data.

## Architecture

```
<video> (MSE — Shaka Player DASH/HLS, no src attribute, uses MediaSource)
   │
   └─ createMediaElementSource(videoEl)
        │
        ├─ source.connect(splitter1)  → AnalyserNode[] (useAudioAnalyser — dBFS bars)
        ├─ source.connect(splitter2)  → IIRFilter → AnalyserNode[] (useLoudnessMeter — LUFS)
        │                             → AnalyserNode[] (raw, for True Peak)
        └─ source.connect(destination) (speakers — ensured via flag in cache)
```

Both hooks share a single `AudioContext` + `MediaElementAudioSourceNode` via a `WeakMap<HTMLVideoElement, AudioSourceEntry>` cache (`audioSourceCache.ts`), because `createMediaElementSource()` throws if called twice on the same element.

### Key files

| File | Role |
|------|------|
| `src/utils/audioSourceCache.ts` | WeakMap cache — `getOrCreateAudioSource()`, `ensureDestinationConnected()` |
| `src/hooks/useAudioAnalyser.ts` | dBFS per-channel metering via `AnalyserNode` |
| `src/hooks/useLoudnessMeter.ts` | LUFS/True Peak via K-weighted `IIRFilterNode` chain + `AnalyserNode` |
| `src/components/AudioLevels.tsx` | UI component that calls both hooks |
| `src/components/VideoControls.tsx` | Parent — toggles `showAudioLevels` state from context menu |

### Video element details

- `<video ref={videoRef} />` — **no `crossOrigin` attribute** set
- Loaded via Shaka Player (MSE/MediaSource) — `videoEl.src` is empty string
- Shaka fetches manifest and segments via its networking engine (with CORS proxy plugin for cross-origin CDNs)
- Audio is audible through speakers (Shaka handles media pipeline)

## Safari console logs (verbatim)

```
[useAudioAnalyser] setup, videoEl= ""
[audioSourceCache] created new entry, sampleRate= 48000 "state=" "suspended"
[useAudioAnalyser] resuming suspended context
[audioSourceCache] connecting source → destination
[useAudioAnalyser] connected: source → splitter ( 2 "ch), source → destination"
[useLoudnessMeter] setup
[audioSourceCache] reusing existing entry, context.state= "suspended" "connectedToDestination=" true
[useLoudnessMeter] resuming suspended context
[useLoudnessMeter] connected: source → splitter ( 2 "ch K-weighted +" 2 "ch raw)"
[useAudioAnalyser] cleanup
[useLoudnessMeter] cleanup
[useAudioAnalyser] setup, videoEl= ""
[audioSourceCache] reusing existing entry, context.state= "suspended" "connectedToDestination=" true
[useAudioAnalyser] resuming suspended context
[useAudioAnalyser] connected: source → splitter ( 2 "ch), source → destination"
[useLoudnessMeter] setup
[audioSourceCache] reusing existing entry, context.state= "suspended" "connectedToDestination=" true
[useLoudnessMeter] resuming suspended context
[useLoudnessMeter] connected: source → splitter ( 2 "ch K-weighted +" 2 "ch raw)"
[useAudioAnalyser] first zero frame, analysers= 2 "context.state=" "running"
[useAudioAnalyser] CORS detection triggered after 10 "zero frames"
```

### Notable observations from logs

1. **React strict mode double-invoke**: setup → setup → cleanup → cleanup → setup → setup. Both hooks' effects fire twice in dev mode.
2. **Context repeatedly "suspended"**: After the first cleanup cycle, the context goes back to "suspended" despite `context.resume()` having been called. Neither cleanup function calls `context.suspend()`.
3. **Context eventually "running"**: By the time zero frames are detected, `context.state === "running"`. But AnalyserNode data is still all zeros.
4. **`videoEl.src` is empty**: Confirms MSE (MediaSource) is in use, not a direct URL.

## Fixes attempted (all failed)

### Fix 1 — Targeted `source.disconnect(splitter)` instead of `source.disconnect()`

**Hypothesis**: `source.disconnect()` (no args) disconnects ALL connections from the source, including `source → destination`. On re-setup, the `connectedToDestination` flag is still `true`, so `ensureDestinationConnected` skips reconnection. Without source → destination, the MediaElementAudioSourceNode might not produce audio.

**Change**: Replaced `source.disconnect()` with `source.disconnect(splitter)` in both hooks' cleanup functions.

**Result**: No change. Same zero-frame behavior.

### Fix 2 — Remove `source.disconnect(splitter)` entirely from cleanup

**Hypothesis**: Safari's `AudioNode.disconnect(specificDestination)` might sever ALL source connections (known Safari WebAudio bug with selective disconnect), not just the specified one. Removing the call entirely avoids this.

**Change**: Removed `source.disconnect(splitter)` from both hooks. Cleanup now only calls `splitter.disconnect()` (which disconnects the splitter's outputs) and `analyser.disconnect()`.

**Result**: No change. Same zero-frame behavior.

### Fix 3 — Eagerly create & resume AudioContext in user gesture handler

**Hypothesis**: Safari requires `AudioContext.resume()` to be called within a user gesture call stack. The hooks call `resume()` from `useEffect`, which runs asynchronously after render (outside the gesture context). By creating and resuming the context in the synchronous click handler, Safari should honor the resume.

**Change**: In the `onToggleAudioLevels` click handler in `VideoControls.tsx`, added:
```typescript
const { context } = getOrCreateAudioSource(videoEl);
if (context.state === "suspended") context.resume();
```
This runs synchronously during the user's click (context menu item selection).

**Result**: No change. The context still reports "suspended" when hooks' useEffects fire, gets resumed, eventually reaches "running", but AnalyserNode data remains all zeros.

## Research questions for exhaustive investigation

### Question 1 — Safari + MSE + createMediaElementSource compatibility

Does Safari support `createMediaElementSource()` on a `<video>` element that uses MediaSource Extensions (MSE)? When Shaka Player loads DASH/HLS via MSE, the video element has no `src` attribute — audio/video data is appended to SourceBuffers. Does the `MediaElementAudioSourceNode` capture the MSE audio output in Safari? Or does Safari's implementation only work with direct `src` URLs?

**Search terms**: `Safari createMediaElementSource MediaSource`, `WebKit MediaElementAudioSourceNode MSE`, `Safari Web Audio API MediaSource Extensions silent`, `WebKit bug createMediaElementSource SourceBuffer`

### Question 2 — Safari crossOrigin attribute requirement

Does Safari require `<video crossOrigin="anonymous">` for `createMediaElementSource()` to produce non-silent output? The spec says MediaElementAudioSourceNode should produce silence for cross-origin media without CORS. Even though Shaka uses MSE (not direct URLs), Safari might treat the MediaSource content as cross-origin if the element doesn't have `crossOrigin` set.

**Search terms**: `Safari createMediaElementSource crossOrigin`, `MediaElementAudioSourceNode CORS silence`, `crossOrigin attribute MediaSource Safari`, `WebKit tainted media element audio source`

### Question 3 — Safari AudioContext.resume() from useEffect

Does `AudioContext.resume()` actually work in Safari when called from a React useEffect (microtask/macrotask, not direct user gesture)? The logs show the context transitions to "running", but does "running" guarantee the nodes are processing? Could Safari report "running" while the audio graph is effectively dead?

**Search terms**: `Safari AudioContext resume useEffect`, `Safari AudioContext running but no audio`, `WebKit AudioContext resume user gesture requirement`, `Safari AudioContext state running silent`

### Question 4 — Alternative APIs

If `createMediaElementSource` fundamentally doesn't work with MSE in Safari, what alternatives exist?
- `HTMLMediaElement.captureStream()` + `createMediaStreamSource()` — Safari 17+?
- `AudioWorklet` processing
- Web Audio `MediaStreamAudioSourceNode` via `RTCPeerConnection` loopback
- ScriptProcessorNode (deprecated but widely supported)

**Search terms**: `Safari captureStream HTMLMediaElement`, `Safari HTMLVideoElement captureStream support`, `alternative to createMediaElementSource Safari`, `Safari Web Audio MSE workaround`

### Question 5 — WebKit bug tracker

Are there known WebKit bugs related to `createMediaElementSource` + MSE silence?

**Search terms**: `site:bugs.webkit.org createMediaElementSource`, `site:bugs.webkit.org MediaElementAudioSourceNode MSE`, `site:bugs.webkit.org Web Audio MediaSource`

### Question 6 — React strict mode interaction

Could the double-invoke from React 18+ strict mode be creating a permanently broken state in Safari's Web Audio implementation? E.g., creating a `MediaElementAudioSourceNode`, connecting it, disconnecting it, then reconnecting — does Safari's implementation handle this reconnection correctly?

**Search terms**: `Safari Web Audio reconnect AnalyserNode`, `Safari MediaElementAudioSourceNode disconnect reconnect`, `Web Audio disconnect reconnect Safari bug`

## Environment

- **Safari version**: macOS Safari (latest, WebKit-based)
- **React**: 19 (strict mode in dev)
- **Shaka Player**: 5.x (MSE-based DASH/HLS)
- **Dev server**: Vite, HTTP (not HTTPS)
- **Audio Context sample rate**: 48000 Hz
- **Channel count**: 2 (stereo)

## Research conclusions

### Root cause — confirmed WebKit bug

**[WebKit Bug #266922](https://bugs.webkit.org/show_bug.cgi?id=266922)** — `MediaElementAudioSourceNode` doesn't pass audio sample data to subsequent nodes when the source uses MSE. Filed December 2023, status **NEW (unresolved)**.

**[WebKit Bug #180696](https://bugs.webkit.org/show_bug.cgi?id=180696)** — `createMediaElementSource()` not working with HLS streams. Filed December 2017, status **NEW (unresolved after 8+ years)**. A commenter noted: "This still haunts me 8 years later."

Safari's `AudioSourceProvider` architecture does not route decoded PCM samples from MSE/HLS pipelines into the Web Audio graph. Audio plays audibly through the normal output path, but `MediaElementAudioSourceNode` receives only zeros. Chrome and Firefox handle this correctly.

### Not CORS-related

MSE blob URLs are same-origin by definition. The `wouldTaintOrigin()` check in WebKit's `MediaElementAudioSourceNode.cpp` passes for MSE content. Setting `crossOrigin="anonymous"` has no effect. The original "cross-origin media" error message was a misdiagnosis.

### No viable workaround

| Approach | Status | Why it fails |
|----------|--------|--------------|
| `captureStream()` + `createMediaStreamSource()` | Not supported in Safari (through 26.4) | Apple hasn't implemented it |
| `AudioWorklet` replacing `AnalyserNode` | Same silent source | The zeros come from `MediaElementAudioSourceNode`, not the analyser |
| `getUserMedia()` permission hack | Unreliable | Only reported for direct src, not MSE/HLS |
| `crossOrigin="anonymous"` attribute | Irrelevant | MSE is already same-origin |
| Response filter + `decodeAudioData()` | Theoretically possible | Extreme complexity: sync, demux, double-decode |
| WebCodecs `AudioDecoder` | Limited Safari support | Same complexity as above |
| User gesture `context.resume()` | Context does resume | The issue is audio routing, not context state |

### Resolution

Implemented full workaround: `useAudioMeterFallback` hook bypasses `MediaElementAudioSourceNode` entirely. Extracts raw AAC samples from fMP4 segments via mp4box, wraps in ADTS headers, decodes via `OfflineAudioContext.decodeAudioData()`, and computes metering from the decoded PCM. See `docs/audio-decode-workarounds.md` for the complete implementation details.

### Key sources

- [WebKit Bug #266922](https://bugs.webkit.org/show_bug.cgi?id=266922) — MSE + MediaElementAudioSourceNode = silence
- [WebKit Bug #180696](https://bugs.webkit.org/show_bug.cgi?id=180696) — HLS + createMediaElementSource = silence (since 2017)
- [WebKit Bug #231656](https://bugs.webkit.org/show_bug.cgi?id=231656) — Duplicate of #180696, filed as P1/Blocker
- [Shaka Player #3616](https://github.com/shaka-project/shaka-player/issues/3616) — Web Audio in Safari produces nothing
- [Shaka Player #2595](https://github.com/shaka-project/shaka-player/issues/2595) — Web Audio API with Shaka (works in Chrome, not Safari)
- [Apple Developer Forums](https://developer.apple.com/forums/thread/694697) — Confirmed: MP4/MP3 works, HLS/MSE does not
- [caniuse: captureStream](https://caniuse.com/mdn-api_htmlmediaelement_capturestream) — Safari: not supported
