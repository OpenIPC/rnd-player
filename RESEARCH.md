# RESEARCH.md

Research specifications for an AI agent investigating browser and OS-level issues discovered through E2E testing of the R&D Player. The goal is to find proper solutions grounded in specifications, source code, and bug trackers rather than relying on empirical workarounds.

## How to Use This Document

This document defines research topics for an AI research agent. Each topic includes:

- **Observation** -- what was discovered empirically through CI testing
- **Current workaround** -- what the codebase does today (with file locations)
- **Research questions** -- what needs to be understood to find a proper solution
- **Sources to investigate** -- where to look (specs, browser source, bug trackers)

The research agent should produce findings that explain *why* each behavior occurs at the specification or implementation level, whether the current workaround is correct or fragile, and whether a better solution exists.

## Methodology

For each topic, the research agent should:

1. **Check specifications** -- W3C/WHATWG specs for MSE, EME, WebCodecs, HTML media element
2. **Search browser bug trackers** -- Chromium Issues, Mozilla Bugzilla, WebKit Bugzilla
3. **Read browser source code** -- Chromium source (via code.googlesource.com), Mozilla source (via searchfox.org), WebKit source (via trac.webkit.org)
4. **Check Shaka Player issues** -- github.com/shaka-project/shaka-player/issues
5. **Validate against specs** -- determine if the observed behavior is spec-compliant, a known bug, or undefined behavior
6. **Propose solutions** -- spec-compliant fixes, polyfills, or detection strategies that are grounded in documented behavior rather than empirical tolerance values

---

## Topic 1: MSE `isTypeSupported` Returning True for Unsupported Codecs

### Observation

`MediaSource.isTypeSupported` returns `true` for codecs the browser cannot actually play:

| Browser | Codec | `isTypeSupported` | Actual playback |
|---------|-------|-------------------|-----------------|
| Firefox (all platforms) | HEVC `hvc1.1.6.L93.B0` | `true` | Silent load failure -- controls never appear |
| macOS WebKit | AV1 `av01.0.01M.08` | `true` | Loads but `readyState` stays at 1 |

### Current workaround

Two-stage skip in tests: probe first, then catch load failure with 30s timeout and 5s `readyState` poll.

- `e2e/hevc.spec.ts:41-48` -- `tryLoadHevcDash` catch
- `e2e/av1.spec.ts:43-61` -- `tryLoadAv1Dash` with `readyState >= 2` check

### Research questions

1. What does the MSE spec say `isTypeSupported` must check? Is it allowed to return `true` based on container/codec string parsing alone, without verifying decoder availability?
2. Is Firefox's HEVC `isTypeSupported` behavior a known bug? Search Bugzilla for `isTypeSupported HEVC` or `isTypeSupported false positive`.
3. Is macOS WebKit's AV1 behavior a known bug? The API says supported, EME-style load succeeds, but the decoder produces no frames. Search WebKit Bugzilla.
4. Is there a more reliable probe than `isTypeSupported`? For example: creating a `SourceBuffer`, appending a short init segment, and checking for errors. What is the minimum reliable detection strategy per the MSE spec?
5. Does `HTMLMediaElement.canPlayType` have the same false-positive behavior, or is it more conservative?
6. Are there codec capability query APIs beyond MSE (e.g., `MediaCapabilities.decodingInfo`) that provide more reliable results?

### Sources to investigate

- MSE spec: https://www.w3.org/TR/media-source-2/#dom-mediasource-istypesupported
- MediaCapabilities API: https://www.w3.org/TR/media-capabilities/
- Firefox Bugzilla: `isTypeSupported` + HEVC/H.265
- WebKit Bugzilla: `isTypeSupported` + AV1
- Chromium: https://source.chromium.org search for `IsTypeSupportedImpl`

### Findings

#### Q1: What does the MSE spec require `isTypeSupported` to check?

**The spec is deliberately vague.** The algorithm checks: (1) valid MIME type, (2) supported media type/subtype, (3) supported codec, (4) supported combination. But the spec does not define what "support" means at the implementation level. A conforming implementation **is permitted** to return `true` based on MIME type and codec string parsing alone, without verifying decoder availability or attempting trial decode. The spec note explicitly states: "If true is returned, it only indicates that the MediaSource implementation is capable of creating SourceBuffer objects for the specified MIME type." MDN further clarifies: true means the browser can **"probably"** play media of the specified type, and this is **"not a guarantee."**

No spec (MSE, HTML media, or MediaCapabilities) requires verifying actual decoder availability. This is a deliberate design choice -- mandating specific probe mechanisms across diverse platform decoder architectures would be impractical.

#### Q2: Is Firefox's HEVC `isTypeSupported` behavior a known bug?

**Yes, extensively documented.** Multiple Bugzilla bugs and streaming library issues confirm this:

- **[Bug 1928484](https://bugzilla.mozilla.org/show_bug.cgi?id=1928484)**: `isTypeSupported` returned true for HEVC due to PlayReady preferences leaking into codec reporting. Fixed in Firefox 132.0.1.
- **[Bug 1945371](https://bugzilla.mozilla.org/show_bug.cgi?id=1945371)**: Extensive HEVC decode failures on macOS Firefox 136 (VideoToolbox errors, broken seeking, incorrect rendering) despite probe passing.
- **[Bug 1894818](https://bugzilla.mozilla.org/show_bug.cgi?id=1894818)**: HEVC on Linux (Firefox 137 via FFmpeg/VA-API). CI VMs may lack hardware acceleration that the decode path requires.
- **[hls.js #7046](https://github.com/video-dev/hls.js/issues/7046)**: Both `isTypeSupported` AND `decodingInfo` return true for HEVC in Firefox on Windows, but actual MSE playback fails. Fix: UA-based override ([PR #7048](https://github.com/video-dev/hls.js/pull/7048)).
- **[hls.js #6572](https://github.com/video-dev/hls.js/issues/6572)**: Firefox produces `addSourceBuffer: Can't play type` errors AFTER `isTypeSupported` returned true.

**Root cause**: Firefox's `isTypeSupported` flows through `PDMFactory::Supports()` which probes platform decoders (FFmpeg on Linux, VideoToolbox on macOS). The probe is shallow (can a decoder be created?) but the actual MSE pipeline involves additional layers (demuxing, buffer management, decoder initialization with real data) that can fail even when the probe succeeds. The `media.hevc.enabled` preference defaults to `true`.

#### Q3: Is macOS WebKit's AV1 behavior a known bug?

**Almost certainly a Playwright-specific issue, not a Safari bug.** Real Safari gates AV1 support on hardware decoder availability via the `contentTypesRequiringHardwareSupport` embedder setting. Apple has stated no plans for software AV1 decoding in Safari. AV1 hardware decode requires M3+ / A17 Pro+ chips.

The mechanism: WebKit's `MediaPlayerPrivateMediaSourceAVFObjC.mm` calls `contentTypeMeetsHardwareDecodeRequirements()` which checks if the codec is in the embedder's hardware-required list. **Safari configures this list to include AV1; Playwright's MiniBrowser does not configure it at all.** The default is NULL/empty (confirmed by [WebKitGTK docs](https://webkitgtk.org/reference/webkit2gtk/stable/property.Settings.media-content-types-requiring-hardware-support.html)), meaning no hardware requirements are enforced in Playwright. So `isTypeSupported` returns true (parser supports AV1), but `VTDecompressionSession` creation for AV1 fails silently (no hardware decoder on M1/M2 CI runners).

Precedent bugs with the same pattern: [Bug 198583](https://bugs.webkit.org/show_bug.cgi?id=198583) (FLAC false positive), [Bug 216652](https://bugs.webkit.org/show_bug.cgi?id=216652) (VP9 false positive).

#### Q4: Is there a more reliable probe than `isTypeSupported`?

**Detection methods ranked by reliability:**

| Method | Reliability | Latency | Notes |
|--------|------------|---------|-------|
| `isTypeSupported()` | Medium | 0ms | False positives for HEVC on Firefox, AV1 on Playwright WebKit |
| `canPlayType()` | Low | 0ms | Returns "maybe"/"probably"; no MSE awareness |
| `decodingInfo()` | Medium+ | 0-50ms | Adds smooth/powerEfficient but shares Firefox HEVC false positive |
| Trial `addSourceBuffer()` | High | 50-200ms | Catches Firefox HEVC `addSourceBuffer` failures |
| WebCodecs trial decode | Highest | 100-500ms | Tests actual decode pipeline; not yet used by major libraries |
| UA + blocklist | Deterministic | 0ms | What hls.js/Shaka actually do for known false positives |

**Industry practice**: Shaka Player uses hardcoded platform blocklists (`rejectCodec_()` / `rejectContainer_()` in `lib/polyfill/mediasource.js`). hls.js uses `userAgentHevcSupportIsInaccurate()` UA check for Firefox+HEVC. dash.js uses `decodingInfo()` with fallback. Netflix/YouTube combine client probes with server-side device profiles.

**The most promising unexploited approach is WebCodecs trial decode**: create a `VideoDecoder`, feed a minimal encoded keyframe, verify the output callback fires. This tests the actual decode pipeline rather than API claims. The player's `thumbnailWorker.ts` already uses this pattern for filmstrip generation. The gap is that no major streaming library ships pre-encoded minimal bitstreams for probe purposes.

#### Q5: Does `canPlayType` have the same false-positive behavior?

**The MSE spec explicitly ties them**: returning `true` from `isTypeSupported` implies `canPlayType` returns `"maybe"` or `"probably"`. In practice, `canPlayType` is **less** reliable for MSE purposes because it answers about `<video src>` playback, not MSE buffering. dash.js originally used `canPlayType` and had to switch to `isTypeSupported` because `canPlayType` returned "probably" for codecs the native element could decode (e.g., FLAC) but MSE could not buffer ([dash.js #2167](https://github.com/Dash-Industry-Forum/dash.js/issues/2167)).

#### Q6: Is `MediaCapabilities.decodingInfo` more reliable?

**Somewhat, but not enough for HEVC.** The `supported` boolean in `decodingInfo` is derived from the same underlying checks as `isTypeSupported` in most browsers. Firefox's initial implementation returned information identical to `isTypeSupported` for media-source type ([Bug 1409664](https://bugzilla.mozilla.org/show_bug.cgi?id=1409664)). The HEVC false positive on Firefox affects `decodingInfo` equally ([hls.js #7046](https://github.com/video-dev/hls.js/issues/7046)). The `smooth` and `powerEfficient` fields are more useful but browser-specific: Chromium is reasonably accurate, Firefox had accuracy bugs that were fixed incrementally.

### Additional findings from cross-reference analysis

#### Browser source code call chains

Each engine implements `isTypeSupported` differently, explaining why false positives are engine-specific:

- **Chromium (Blink)**: `MediaSource::isTypeSupported()` → `IsTypeSupportedInternal()` → `HTMLMediaElement` support check → `MIMETypeRegistry::SupportsMediaSourceMIMEType(mime, codecs)` → returns `true` only when registry reports `kIsSupported`. Registry-driven and conservative -- encodes MSE support in a centralized registry that incorporates platform restrictions. This is why Chromium honestly reports no HEVC/AV1 MSE support when it's truly absent. ([source: media_source.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediasource/media_source.cc))

- **WebKit**: `MediaSource::isTypeSupported()` → `MediaPlayer::supportsType(parameters)` with `parameters.isMediaSource = true` → returns `true` when result equals `MediaPlayer::SupportsType::IsSupported`. Only as accurate as the media engine's `supportsType` heuristic for the MSE pipeline on that OS/hardware/feature-gating. When AV1 is compiled-in but hardware decode is absent, the call chain returns "supported" even though `VTDecompressionSession` creation will fail. ([source: MediaSource.cpp](https://github.com/nicedoc/nicedoc.io))

- **Firefox**: `MediaSource::IsTypeSupported` → parse into `MediaContainerType` → reject if `DecoderTraits::CanHandleContainerType() == CANPLAY_NO` → apply VP9/WebM preference restrictions and fingerprinting mitigation → accept MP4/WebM otherwise. No HEVC-specific validation at this entry point; HEVC outcomes depend entirely on what `DecoderTraits` reports for the platform build. ([source: MediaSource.cpp on searchfox](https://searchfox.org/mozilla-central/source/dom/media/mediasource/MediaSource.cpp))

#### Firefox HEVC origin-dependent behavior (Bug 1928484 → Bug 1928536)

The origin check in Bug 1928484 was a **temporary workaround** for Firefox 132.0.1. The root cause was Bug 1919627 (enabling PlayReady DRM preferences by default), which had the side effect of turning on HEVC codec reporting in `isTypeSupported()` before HEVC playback was fully enabled on Windows. The fix suppressed HEVC reporting for specific origins. This workaround was later **reverted** in [Bug 1928536](https://bugzilla.mozilla.org/show_bug.cgi?id=1928536) ("Enable HEVC for all playback on Windows") starting in Firefox 134, which properly enabled HEVC playback -- making the origin check unnecessary.

This history demonstrates that Firefox's HEVC support is gated on a combination of platform decoder availability, preference flags, and DRM configuration, and these gates change across versions. The `isTypeSupported` false positive we see on CI is the current version's manifestation of the same underlying issue: the probe path (`PDMFactory::Supports()`) succeeds but the full MSE pipeline (demuxing, buffer management, decoder initialization with real data) fails.

#### Fingerprinting resistance impact on probes

Firefox's `IsTypeSupported` explicitly considers "resist fingerprinting" behavior, aiming not to leak whether codecs are disabled or whether hardware support exists (notably for VP9 in that code path). This means privacy features can intentionally reduce accuracy or consistency of reported capabilities. This is an argument for functional-decode probes (like readyState polling or `requestVideoFrameCallback`) that observe whether frames are produced rather than relying on declarative "capability statements."

#### `requestVideoFrameCallback` as a frame liveness signal

The [`requestVideoFrameCallback`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) API provides a **positive** "frame was decoded and composited" signal, which is strictly stronger than the current `readyState >= 2` check:

- **Browser support**: Baseline across all major browsers since October 2024 (Chrome 83+, Edge 83+, Safari 15.4+, Firefox 132+). WebKitGTK has GStreamer support since 2.36.0 (March 2022, [WebKit Bug 233541](https://bugs.webkit.org/show_bug.cgi?id=233541)).

- **Why it's better than readyState**: `readyState >= 2` means the browser *thinks* it has decodable data but doesn't prove a frame was actually rendered. When EME produces garbage data that the decoder silently drops (macOS WebKit ClearKey scenario), `requestVideoFrameCallback` would never fire since no frames are being composited. It also provides `presentedFrames` counter and `mediaTime` for diagnostics.

- **Applicability**: Could improve `softwareDecrypt.ts` Layer 2 detection (`waitForDecryption()`) and E2E test probes. The callback fires as soon as the first frame is composited, potentially faster than the current 50ms polling interval.

- **Caveat**: Needs empirical verification in Playwright's WebKitGTK build, as Playwright disables some WebKit features ([Playwright #31017](https://github.com/microsoft/playwright/issues/31017)). A feature-detection fallback to readyState polling would be needed.

### Recommendations for this project

1. **Current two-stage approach is correct.** No single API call can guarantee playback success -- this is a spec-level limitation. The probe + load-failure-catch pattern aligns with industry practice.

2. **Consider `requestVideoFrameCallback` as a liveness upgrade.** For both `softwareDecrypt.ts` Layer 2 detection and E2E test probes, `requestVideoFrameCallback` provides a definitive "frame was decoded" signal. It would replace the empirical `readyState` polling with a spec-backed positive confirmation. Needs empirical verification on Playwright WebKitGTK first.

3. **Consider `decodingInfo()` as an annotation upgrade over `isTypeSupported`.** While it shares the HEVC false positive on Firefox, it provides `smooth`/`powerEfficient` signals and accepts resolution parameters. It would not change existing skip behavior but would provide richer diagnostic annotations.

4. **The macOS WebKit AV1 false positive is Playwright-specific** and will not affect real Safari users. No code change needed in the player; the test-level `tryLoadAv1Dash` readyState check is the correct fix.

5. **A WebCodecs trial decode probe** would be the definitive solution but adds complexity (shipping minimal encoded keyframes) and latency (100-500ms). Worth considering if the false-positive problem expands to more codecs/platforms.

6. **UA-based blocklists** (like hls.js does for Firefox+HEVC) are deterministic and zero-latency but require ongoing maintenance. Not recommended for this project since the player doesn't select codecs -- it plays whatever manifest URL the user provides.

### Key references

- [MSE spec isTypeSupported](https://www.w3.org/TR/media-source-2/#dom-mediasource-istypesupported) -- "only indicates capability of creating SourceBuffer objects"
- [Media Capabilities Explainer](https://github.com/w3c/media-capabilities/blob/main/explainer.md) -- designed to replace isTypeSupported/canPlayType
- [Firefox Bug 1928484](https://bugzilla.mozilla.org/show_bug.cgi?id=1928484) -- HEVC isTypeSupported false positive from PlayReady
- [Firefox Bug 1928536](https://bugzilla.mozilla.org/show_bug.cgi?id=1928536) -- Reverts origin check, enables HEVC fully on Windows (Firefox 134)
- [Firefox Bug 1924066](https://bugzilla.mozilla.org/show_bug.cgi?id=1924066) -- Implements HEVC on macOS via VideoToolbox (Firefox 136)
- [Firefox Bug 1945371](https://bugzilla.mozilla.org/show_bug.cgi?id=1945371) -- Extensive HEVC decode failures despite probe passing
- [hls.js #7046](https://github.com/video-dev/hls.js/issues/7046) -- decodingInfo also lies for HEVC on Firefox
- [hls.js #7048](https://github.com/video-dev/hls.js/pull/7048) -- UA-based override fix
- [WebKit Bug 198583](https://bugs.webkit.org/show_bug.cgi?id=198583) -- FLAC isTypeSupported false positive (same pattern)
- [WebKitGTK media-content-types-requiring-hardware-support](https://webkitgtk.org/reference/webkit2gtk/stable/property.Settings.media-content-types-requiring-hardware-support.html) -- default NULL in non-Safari embedders
- [Shaka Player mediasource.js](https://github.com/shaka-project/shaka-player/blob/main/lib/polyfill/mediasource.js) -- rejectCodec/rejectContainer blocklist approach
- [Shaka Player codec preferences](https://github.com/shaka-project/shaka-player/blob/main/docs/design/codec_preferences.md)
- [dash.js #2167](https://github.com/Dash-Industry-Forum/dash.js/issues/2167) -- canPlayType vs isTypeSupported
- [MDN MediaSource.isTypeSupported](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/isTypeSupported_static)
- [MDN MediaCapabilities.decodingInfo](https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo)
- [Chromium media_source.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediasource/media_source.cc) -- IsTypeSupportedInternal implementation
- [MDN requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) -- frame liveness API
- [WebKit Bug 233541](https://bugs.webkit.org/show_bug.cgi?id=233541) -- requestVideoFrameCallback GStreamer implementation
- [Playwright #31017](https://github.com/microsoft/playwright/issues/31017) -- WebKit feature support on non-Apple platforms

### Status: COMPLETE

Topic 1 research is comprehensive. All 6 research questions answered with spec-level and implementation-level evidence. Cross-referenced against independent analysis. Two actionable items identified for future work:
- **Actionable**: Verify `requestVideoFrameCallback` in Playwright WebKitGTK, then upgrade `softwareDecrypt.ts` Layer 2 detection (Topic 3 overlap)
- **Actionable**: Add `decodingInfo()` results to E2E test annotations for richer CI diagnostics

---

## Topic 2: WebCodecs `isConfigSupported` vs Actual Decode Failures

### Observation

`VideoDecoder.isConfigSupported` returns `{ supported: true }` for codec configurations that the decoder cannot actually process:

| Browser | Codec | Probe result | Actual decode |
|---------|-------|-------------|---------------|
| macOS WebKit | HEVC `hvc1.1.6.L93.B0` | supported | Filmstrip thumbnails never render |
| ubuntu WebKit | AV1 `av01.0.01M.08` | supported | Filmstrip thumbnails never render |
| macOS WebKit | AV1 `av01.0.01M.08` | supported | `readyState` stays at 1 |

Additionally, `isConfigSupported` returns `false` when called on an `about:blank` page but `true` on a navigated page in the same browser session. This was observed across Chromium, Firefox, and Edge for AV1.

### Current workaround

- Filmstrip tests wrap `waitForThumbnails()` in try/catch and skip on timeout
- Probe ordering was fixed to run after page navigation
- `e2e/av1.spec.ts:173-194`, `e2e/hevc.spec.ts:157-181`

### Research questions

1. What does the WebCodecs spec say `isConfigSupported` must verify? Is it required to check actual decoder instantiation, or just codec string validity?
2. Why does `isConfigSupported` behave differently on `about:blank` vs a navigated page? Is `about:blank` not a secure context? The WebCodecs spec requires secure context -- does Playwright's `about:blank` qualify?
3. For the HEVC/AV1 decode failures on WebKit: is the `VideoDecoder` actually failing (emitting an error), or silently producing no output? What error callback behavior does the spec mandate?
4. Is there a way to do a "trial decode" -- feed one frame to `VideoDecoder` and verify output -- that would be more reliable than `isConfigSupported`?
5. Does the behavior differ between main thread `VideoDecoder` and worker-thread `VideoDecoder`? The filmstrip uses a web worker.

### Sources to investigate

- WebCodecs spec: https://www.w3.org/TR/webcodecs/#dom-videodecoder-isconfigsupported
- WebCodecs secure context requirement: https://www.w3.org/TR/webcodecs/#videodecoder-interface
- WebKit source: search for `isConfigSupported` in WebCore/Modules/webcodecs/
- Chromium source: search for `IsConfigSupported` in media/
- `about:blank` secure context behavior: https://html.spec.whatwg.org/multipage/browsers.html#concept-origin-opaque

---

## Topic 3: ClearKey EME Silent Decryption Failure

### Observation

macOS WebKit's EME implementation accepts ClearKey configuration, creates MediaKeys, and associates them with the video element without errors. But the CDM produces garbage data that the decoder silently drops. `readyState` stays at `HAVE_METADATA` (1) despite buffered ranges showing data. No error events fire.

On Linux WebKitGTK, EME is entirely absent -- `requestMediaKeySystemAccess` rejects.

### Current workaround

Two-layer detection in `src/utils/softwareDecrypt.ts`:
- Layer 1 (`hasClearKeySupport`, line 50): Pre-check via `requestMediaKeySystemAccess`. Catches Linux WebKitGTK.
- Layer 2 (`waitForDecryption`, line 80): Post-load poll of `readyState` for 1.5s at 50ms intervals. Catches macOS WebKit silent failure.

On detection, the player unloads and reloads with a software decryption response filter that strips DRM from the manifest and decrypts segments via Web Crypto API.

### Research questions

1. Is ClearKey EME required to work in all browsers that expose the API? What does the EME spec say about conformance for ClearKey?
2. Is the macOS WebKit behavior a known bug? Search WebKit Bugzilla for `ClearKey` + `decrypt` or `ClearKey` + `silent`.
3. What exactly happens inside WebKit's CDM when it "decrypts" with ClearKey? Does it actually invoke AES-CTR, or does it pass through without decryption? If the former, is the key derivation wrong?
4. Is `readyState` polling the right detection mechanism, or is there a more direct signal (e.g., `encrypted` event, `waitingforkey` event, `MediaKeySession` events)?
5. The 1.5s timeout in Layer 2 is empirical. What is the minimum time a browser needs to demonstrate that decryption is working? Is there a spec-defined signal for "decryption complete for current segment"?
6. Does Playwright's patched WebKit match real Safari behavior for ClearKey? If real Safari handles ClearKey correctly, this may be a Playwright-specific issue.

### Sources to investigate

- EME spec: https://www.w3.org/TR/encrypted-media/
- EME ClearKey requirements: https://www.w3.org/TR/encrypted-media/#clear-key
- WebKit Bugzilla: ClearKey + decrypt
- Playwright WebKit patches: https://github.com/nicedoc/nicedoc.io
- Shaka Player EME issues: search for ClearKey + WebKit

---

## Topic 4: B-Frame Composition Time Offsets and Seek Accuracy

### Observation

When video is encoded with B-frames (HEVC with bframes=3, AV1 with default settings), seeking to time T does not always display the frame whose CTS is closest to T. The displayed frame can be off by up to 3 frames. This is observed as:

- HEVC on WebKitGTK: `seekTo(5)` displays frame 147-153 instead of exactly 150
- AV1 on various platforms: same +-3 tolerance needed

H.264 (encoded with `libx264 -preset ultrafast`) does not exhibit this offset -- OCR tests match exact frame numbers.

### Current workaround

Tests use `toBeLessThanOrEqual(3)` tolerance for HEVC and AV1 seek assertions:
- `e2e/hevc.spec.ts:103-108`, `e2e/av1.spec.ts:117-121`

### Research questions

1. Is the offset caused by the encoder (CTTS atom values), the browser's MSE seek algorithm, or both?
2. What does the HTML spec say about seek behavior with B-frames? Does `video.currentTime = T` guarantee displaying the frame whose presentation time is closest to T, or the nearest sync sample?
3. Does libx264 `-preset ultrafast` disable B-frames entirely (explaining why H.264 tests are exact)? Check ffmpeg docs for the GOP structure produced by each preset.
4. For libx265 and libsvtav1/libaom-av1, what is the default B-frame count and can it be controlled? Would encoding with `-bf 0` (no B-frames) eliminate the offset?
5. Is the +-3 frame tolerance actually correct, or is it a coincidence of bframes=3? What is the theoretical maximum offset for a given B-frame depth?
6. Do different browsers handle B-frame seeking differently? Does Chromium snap to the nearest I-frame while WebKit interpolates?
7. Is `fastSeek()` vs `currentTime` assignment relevant here? The spec mentions they may behave differently for keyframe alignment.

### Sources to investigate

- HTML spec seek algorithm: https://html.spec.whatwg.org/multipage/media.html#dom-media-currenttime
- `fastSeek()` spec: https://html.spec.whatwg.org/multipage/media.html#dom-media-fastseek
- ISO 14496-12 (MP4) CTTS box: composition time offset semantics
- ffmpeg libx264/libx265/libsvtav1 documentation: B-frame settings per preset
- Chromium source: `HTMLMediaElement::setCurrentTime` -> seek algorithm
- Firefox source: `HTMLMediaElement::Seek` implementation

---

## Topic 5: WebKitGTK Seek Stalls Under CI VM Load

### Observation

On `ubuntu-latest` GitHub Actions runners, WebKitGTK's media pipeline intermittently fails to complete seek operations:
- `video.seeking` stays `true` indefinitely
- `seeked` events never fire
- Setting `currentTime = 0` when already at time 0 can trigger a stuck seek
- The behavior is intermittent and correlates with VM load

This does not reproduce on macOS WebKit or any other browser.

### Current workaround

All seek waits have 3-5 second deadlines:
- `e2e/helpers.ts:477-481` -- 3s per-attempt timeout in `seekTo()`
- `e2e/helpers.ts:101-102` -- 5s timeout on `await seeked` in load helpers

### Research questions

1. Is this a known WebKitGTK bug? Search WebKit Bugzilla for seek + stall + GStreamer.
2. What is WebKitGTK's media backend? (GStreamer). Is there a known issue with GStreamer's seek implementation under resource pressure?
3. Does WebKitGTK use a separate thread/process for media decoding? Could VM CPU throttling cause a deadlock or missed signal between the main thread and the media thread?
4. Is there a way to cancel a stuck seek? Does setting `currentTime` again while `seeking === true` abort the first seek or queue a second one?
5. Does `video.load()` or `video.src = video.src` reset the stuck state?
6. Are there GStreamer environment variables or WebKit flags that could improve reliability (e.g., software-only decoding, disabling hardware acceleration)?
7. Does this correlate with specific GitHub Actions runner specs (CPU count, available memory)?

### Sources to investigate

- WebKit Bugzilla: search for "seek stall" or "seeking stuck" with GStreamer
- GStreamer bug tracker: seek reliability issues
- WebKitGTK media backend source: `Source/WebCore/platform/graphics/gstreamer/`
- GitHub Actions runner specs: https://docs.github.com/en/actions/using-github-hosted-runners
- Playwright WebKitGTK issues: https://github.com/nicedoc/nicedoc.io search for seek

---

## Topic 6: Firefox MSE Frame Boundary Precision

### Observation

When seeking to exactly `N/fps` on Firefox, the actual position lands slightly before the frame boundary (`N/fps - epsilon`), causing the decoder to display frame N-1 instead of frame N. This was verified via OCR: without the workaround, ArrowRight from frame 0 displays frame 0 instead of frame 1.

This does not occur on Chromium, Edge, or WebKit.

### Current workaround

`FRAME_SEEK_EPSILON = 0.001` (1 ms) added to ArrowRight/ArrowLeft seek targets in `src/hooks/useKeyboardShortcuts.ts:5-9`. At 30 fps (33.3 ms/frame), 1 ms cannot overshoot into the next frame.

### Research questions

1. What is the MSE buffered range precision for Firefox? Does `video.buffered` report ranges that exclude the exact frame boundary time?
2. Is this a floating-point precision issue in Firefox's currentTime setter, or a deliberate "seek to nearest keyframe before T" behavior?
3. Does Firefox use `floor(T * timescale)` internally while Chromium uses `round(T * timescale)`? Check the MSE seek algorithm implementation in both.
4. Is this documented behavior or a bug? Search Mozilla Bugzilla for `currentTime precision` or `seek frame boundary`.
5. Is 0.001s universally safe across all frame rates, or could high frame rates (60fps = 16.6ms/frame, 120fps = 8.3ms/frame) require a smaller epsilon?
6. Does `video.fastSeek(T)` have the same behavior, or is it less precise (snapping to keyframes)?

### Sources to investigate

- Firefox source (searchfox.org): `HTMLMediaElement::Seek`, `MediaDecoderStateMachine`
- Mozilla Bugzilla: `currentTime` + precision, seek + frame boundary
- MSE spec: range precision requirements
- Chromium source comparison: `WebMediaPlayerImpl::Seek`

---

## Topic 7: Edge MSE Pipeline Stale `currentTime` After Rapid Seeks

### Observation

On Edge (Windows CI), when multiple `ArrowRight` presses are dispatched via separate `page.evaluate()` calls, the second press reads stale `currentTime` (still showing the pre-first-seek value). This causes the keyboard handler to compute the same seek target, making the second press a no-op.

Running all presses inside a single `page.evaluate()` with per-step `seeked` event waits and `currentTime` change polling resolves the issue.

### Current workaround

`pressKeyNTimesAndSettle()` in `e2e/helpers.ts:540-577` runs all N key presses in a single `page.evaluate()`.

### Research questions

1. Is this an Edge/Chromium MSE implementation detail where `currentTime` getter is cached/asynchronous? Does the getter read from a different thread's cached value?
2. Is this specific to Playwright's page.evaluate round-trip timing, or would it affect any JavaScript that reads `currentTime` between rapid seeks?
3. Does Edge's MSE pipeline flush `currentTime` updates synchronously on `seeked` event, or is there an additional async step?
4. Is this related to Edge's multi-process architecture where the media pipeline runs in a separate process?
5. Would using `requestAnimationFrame` to read `currentTime` after `seeked` be more reliable than direct reads?

### Sources to investigate

- Chromium source: `WebMediaPlayerImpl::GetCurrentTime` caching behavior
- Edge-specific media pipeline: any divergence from upstream Chromium
- MSE spec: `currentTime` update timing requirements relative to `seeked` event

---

## Topic 8: WebKit Frame Compositing After Pause at t=0

### Observation

After loading a DASH stream, pausing, and setting `currentTime = 0`, WebKit may not composite the first video frame. The video element shows a blank/transparent surface until an explicit seek operation (even to the same position) forces the frame to be composited.

### Current workaround

All `loadPlayerWith*()` functions include an explicit `video.currentTime = 0` seek even when already at position 0:
- `e2e/helpers.ts:93-104`

### Research questions

1. Is this a known WebKit behavior? Does WebKit defer frame compositing until the first seek or play operation?
2. What does the HTML spec say about the "poster frame" or first frame display after `loadeddata`? Is the browser required to render the first frame when paused?
3. Does `video.poster` affect this behavior? Does setting a poster frame suppress first-frame compositing?
4. Is the `readyState` value relevant? Does WebKit reach `HAVE_CURRENT_DATA` (2) without compositing?
5. Would `video.play(); video.pause()` be a more reliable alternative to the double-seek?
6. Does this affect real Safari or only Playwright's patched WebKit?

### Sources to investigate

- HTML spec: media element ready states and frame display requirements
- WebKit Bugzilla: "first frame" + paused, "video blank" + paused
- WebKit source: `HTMLMediaElement::updateActiveTextTrackCues` / compositing path

---

## Topic 9: ImageBitmap Memory Management in Web Workers

### Observation

The filmstrip feature decodes potentially thousands of video frames as `ImageBitmap` objects in a web worker. Without eviction, long videos cause significant memory pressure. The current eviction strategy (3x viewport span) was chosen empirically.

### Research questions

1. What is the actual memory footprint of an `ImageBitmap`? Is it `width * height * 4` bytes (RGBA), or can it use GPU-backed storage with different characteristics?
2. Does `ImageBitmap.close()` immediately free the underlying memory, or does it defer to garbage collection? What does the spec guarantee?
3. When an `ImageBitmap` is transferred from a worker to the main thread via `postMessage`, does the worker's memory decrease? Or do both contexts share the same backing store?
4. Is `transferToImageBitmap()` on an OffscreenCanvas more memory-efficient than `createImageBitmap()` from VideoFrame output?
5. What is the maximum practical number of ImageBitmaps that can be held before browsers start failing allocations or throttling the worker?
6. Would `ImageData` (CPU-backed pixel array) be more predictable for memory management than `ImageBitmap` (potentially GPU-backed)?
7. Are there browser-specific memory limits for workers? Does `performance.measureUserAgentSpecificMemory()` work in workers for monitoring?

### Sources to investigate

- HTML spec: https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html
- `ImageBitmap.close()`: https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-imagebitmap-close
- Chromium source: `ImageBitmap` backing store implementation
- Worker memory limits: any browser documentation on worker resource constraints

---

## Topic 10: SegmentBase vs SegmentTemplate Detection in Response Filters

### Observation

Shaka Packager produces SegmentBase DASH streams (single MP4 with byte-range addressing). Shaka Player fetches the sidx (segment index) via a separate request and tags it as `INIT_SEGMENT` in `AdvancedRequestType`. If the software decryption response filter trusted this label, it would overwrite cached init data with sidx bytes, breaking subsequent media segment decryption.

### Current workaround

Box-presence detection: check for `moov` box (init) vs `moof` box (media) in `src/utils/softwareDecrypt.ts:210-219`.

### Research questions

1. Is Shaka Player's labeling of sidx requests as `INIT_SEGMENT` documented behavior or a bug? Check Shaka Player's `AdvancedRequestType` documentation.
2. Is there a Shaka Player API to distinguish sidx from true init segment requests? Perhaps via the request URI or another field on the request object.
3. Does this affect other Shaka Player response filter use cases (e.g., ad insertion, segment modification)?
4. Is box-presence detection the standard approach for response filters, or is there a recommended Shaka API for this?
5. Are there other DASH packaging modes (SegmentList, SegmentTimeline with $Number$) that produce similar ambiguities?

### Sources to investigate

- Shaka Player docs: https://shaka-player-demo.appspot.com/docs/api/shaka.net.NetworkingEngine.html
- Shaka Player source: `AdvancedRequestType` assignment for SegmentBase streams
- Shaka Player GitHub issues: search for `AdvancedRequestType` + `INIT_SEGMENT` + `sidx`
- DASH-IF guidelines: segment addressing modes

---

## Topic 11: `VideoDecoder` Output Pixel Format Variations

### Observation

`VideoDecoder` outputs frames in different pixel formats per browser/OS:

| Platform | Format | Notes |
|----------|--------|-------|
| Chromium/Edge | I420 | Standard YUV 4:2:0 planar |
| Firefox Linux | BGRX | GStreamer pipeline output |
| Firefox macOS | BGRX | VideoToolbox pipeline output |
| Linux WebKit | I420 | GStreamer pipeline |
| macOS WebKit | NV12 | VideoToolbox semi-planar |

### Current workaround

No explicit workaround -- canvas drawing APIs handle conversion transparently. The thumbnail worker uses `createImageBitmap(videoFrame)` which normalizes the format.

### Research questions

1. Does the WebCodecs spec mandate a specific output format, or is it implementation-defined?
2. Can the output format be requested via `VideoDecoderConfig.outputPixelFormat` or similar? Is there a way to normalize to RGBA at decode time?
3. Does the format affect decode performance? Is BGRX→RGBA conversion done on GPU or CPU?
4. When drawing a `VideoFrame` to canvas via `drawImage`, does the browser handle format conversion, or must the application convert?
5. Are there formats that are more efficient for canvas operations (avoiding conversion overhead)?

### Sources to investigate

- WebCodecs `VideoFrame` spec: https://www.w3.org/TR/webcodecs/#videoframe
- `VideoFrame.format` property documentation
- Chromium source: `VideoFrame` format negotiation in decoder output

---

## Topic 12: Linux WebKitGTK Frame Height Rounding

### Observation

When decoding 240p (426x240) H.264 video, Linux WebKitGTK's GStreamer decoder reports the decoded frame height as 239 instead of 240.

### Current workaround

None needed -- filmstrip rendering is resilient to minor dimension differences.

### Research questions

1. Is this a GStreamer alignment/rounding issue? Does GStreamer align decoded dimensions to specific multiples (e.g., mod-2 for chroma subsampling)?
2. Does this affect the `VideoFrame.codedHeight` or `displayHeight` property in WebCodecs?
3. Does this happen with all resolutions or only specific ones (e.g., heights not divisible by certain values)?
4. Is this a known GStreamer bug? Check GStreamer GitLab.

### Sources to investigate

- GStreamer decoder alignment: search for frame height rounding in GStreamer video decoder base class
- WebKitGTK GStreamer integration: `Source/WebCore/platform/graphics/gstreamer/`
- GStreamer GitLab: height rounding issues

---

## Priority Ranking

Ordered by impact on user experience and engineering complexity:

1. **Topic 1: `isTypeSupported` false positives** -- Causes 30s load timeouts on affected platforms. A reliable detection mechanism would eliminate the need for timeout-based fallbacks.
2. **Topic 3: ClearKey EME silent failure** -- Affects encrypted content playback. The two-layer detection is functional but the 1.5s empirical timeout is fragile.
3. **Topic 4: B-frame seek accuracy** -- The +-3 tolerance is acceptable for tests but may affect user-facing frame stepping accuracy. Understanding the root cause could lead to exact seeking.
4. **Topic 2: `isConfigSupported` false positives** -- Prevents filmstrip thumbnails on some platforms. A reliable WebCodecs probe would unlock filmstrip on more platforms.
5. **Topic 5: WebKitGTK seek stalls** -- CI reliability issue. Understanding the root cause could eliminate timeout-based workarounds.
6. **Topic 6: Firefox frame boundary precision** -- The 1ms epsilon works but is empirical. Spec-grounded understanding would confirm its correctness for all frame rates.
7. **Topic 9: ImageBitmap memory** -- The 3x viewport eviction is empirical. Understanding memory semantics would enable optimal eviction strategies.
8. **Topic 7: Edge stale `currentTime`** -- Only affects rapid programmatic seeks in tests. Low user impact.
9. **Topic 8: WebKit frame compositing** -- Minor UX issue (blank frame before first interaction).
10. **Topic 10: SegmentBase detection** -- Current box-detection approach is robust. Research would confirm it's the recommended pattern.
11. **Topic 11: Pixel format variations** -- No user impact; informational.
12. **Topic 12: Height rounding** -- No user impact; informational.
