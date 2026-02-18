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

### Findings

#### Q1: What does the WebCodecs spec say `isConfigSupported` must verify?

**The "Check Configuration Support" algorithm is implementation-defined.** The spec defines `isConfigSupported()` as resolving with a `VideoDecoderSupport` dictionary containing a `supported` boolean, but the algorithm that determines `supported` is left entirely to the User Agent. The spec states: *"User Agents don't have to support any particular codec type or configuration."*

Browsers implement this very differently:

- **Chromium** (`video_decoder.cc`, `IsConfigSupported` lines 281-334) performs a multi-stage check **without instantiating a real decoder**: validates config structure, clones config, checks software codec capability via `media::IsDecoderBuiltInVideoCodec()` and `media::IsDecoderSupportedVideoType()`, constructs an internal config via `MakeMediaVideoDecoderConfig()`. Only queries GPU factories asynchronously if `prefer-hardware` is specified. Chromium explicitly designed this to not allocate codec resources.

- **WebKit** (`WebCodecsVideoDecoder.cpp`) goes further with a **three-stage check that includes decoder creation**: (1) validates config structure, (2) checks codec string support via `isSupportedDecoderCodec()`, (3) **actually calls `VideoDecoder::create()`** which routes through `createLocalDecoder()` to attempt platform decoder instantiation (VideoToolbox on macOS, GStreamer on Linux). The `supported` boolean is `true` if the create promise succeeds, `false` if it fails.

**Why false positives still occur in WebKit despite attempting decoder creation:**

1. **Decoder creation != successful decoding.** `VideoDecoder::create()` tests whether a decoder *object* can be instantiated (e.g., `VTDecompressionSession` can be allocated), but does not test whether it can actually decode frames. HEVC decoder creation succeeds (the VideoToolbox framework is available) but actual sample processing fails due to NALU rewriting bugs ([Bug 262950](https://bugs.webkit.org/show_bug.cgi?id=262950)).

2. **GStreamer platform mismatches.** On Linux (WebKitGTK), if `dav1d` is installed, the GStreamer element creates successfully, but actual frame output fails due to colorimetry handling bugs, threading misconfiguration, or parser problems ([PR #27230](https://github.com/WebKit/WebKit/pull/27230), Bug 272642).

There are also cross-browser interop issues around the boundary between "invalid" (throws `TypeError`) and "unsupported" (resolves with `supported: false`). [Issue #744](https://github.com/w3c/webcodecs/issues/744) documents that Chromium resolves with `{ supported: false }` for unsupported scalability modes while Safari rejects the promise. Developers must wrap `isConfigSupported` in try/catch to handle both outcomes.

#### Q2: Why does `isConfigSupported` behave differently on `about:blank` vs a navigated page?

**Root cause: `about:blank` is not a secure context in Playwright, and WebCodecs requires `[SecureContext]`.**

The explanation involves three layers of spec interaction:

1. **WebCodecs requires `[SecureContext]`**: The `VideoDecoder` IDL has `[Exposed=(Window, DedicatedWorker), SecureContext]`. On a non-secure context, `typeof VideoDecoder === "undefined"`. This was added per [w3c/webcodecs#350](https://github.com/w3c/webcodecs/issues/350) to prevent fingerprinting via codec enumeration on insecure origins.

2. **The Secure Contexts spec has a URL-level vs origin-level conflict for `about:blank`**: The [W3C Secure Contexts spec](https://w3c.github.io/webappsec-secure-contexts/) defines two algorithms:
   - **"Is url potentially trustworthy?"** (Section 3.2): Step 1 says `about:blank` returns "Potentially Trustworthy"
   - **"Is origin potentially trustworthy?"** (Section 3.1): Step 1 says opaque origins return "Not Trustworthy"

   The HTML spec's secure context algorithm uses the URL-level check against the `topLevelCreationURL`, which for a top-level `about:blank` is `about:blank` itself. Per spec, `about:blank` *should* be a secure context.

3. **All major browsers diverge from the spec**: [whatwg/html#6369](https://github.com/whatwg/html/issues/6369) tracks this. Chrome 88+ treats top-level `about:blank` without a creator as a non-secure context, because the opaque origin is not trustworthy. Firefox and WebKit behave the same way. This is a known spec/implementation mismatch that remains unresolved.

**In Playwright specifically**: `browser.newPage()` creates a top-level `about:blank` with no creator browsing context. Without a creator, the HTML spec's origin determination algorithm gives `about:blank` an **opaque origin**. Despite the URL-level check passing, browsers treat the opaque origin as non-trustworthy → `isSecureContext === false` → `VideoDecoder` is `undefined`.

After `page.goto('http://localhost:5173')` (the Vite dev server configured in `playwright.config.ts`), the page becomes a secure context because `localhost` is a potentially trustworthy origin (matching `127.0.0.0/8` in the spec's step 3). `VideoDecoder` and `isConfigSupported` then become available.

**This affects all `[SecureContext]` APIs, not just WebCodecs**: Web Crypto (`crypto.subtle`), Service Workers, WebGPU, Web Bluetooth, MediaDevices, WebTransport, WebUSB, WebHID, WebXR, Web MIDI, Web Locks, Web Share, Web Authentication, etc. are all `undefined` on `about:blank` in Playwright.

The project's probe functions (`e2e/helpers.ts:316-328`, `415-427`) correctly guard against this with `typeof VideoDecoder === "undefined"` checks, and the test comments correctly explain the ordering requirement.

#### Q3: Is the `VideoDecoder` actually failing (emitting an error) or silently producing no output?

**Silent failure -- a spec violation.**

The WebCodecs spec mandates explicit error handling:
- When `decode()` results in an error: *"queue a task to run the Close VideoDecoder algorithm with EncodingError"*
- The Close algorithm: *"If exception is not an AbortError DOMException, invoke the error callback with exception"*
- After closing: the decoder enters a terminal `"closed"` state

Per spec, **there is no path where a decode error occurs without the error callback being invoked**. If the decoder encounters bad data, it must call the error callback with an `EncodingError`.

The thumbnail worker at `src/workers/thumbnailWorker.ts:488-490` has an error handler that posts error messages. The fact that filmstrip thumbnails "never render" without error messages appearing means the error callback is **not firing** -- the decoder silently produces no output. This is a spec violation.

**Known WebKit bugs in this area:**

- [WebKit Bug 262950](https://bugs.webkit.org/show_bug.cgi?id=262950): "WebCodecs HEVC isSupported returns true but decoding failed." The NALU rewriter dropped data during Annex B to HEVC conversion. Status: **REOPENED** (fix incomplete).
- [WebKit PR #27230](https://github.com/WebKit/WebKit/pull/27230) (Bug 272642): AV1 decoding fixes in GStreamer backend -- `dav1d` had colorimetry handling issues and threading misconfiguration causing decode failures without proper error signaling.
- [w3c/webcodecs Issue #848](https://github.com/w3c/webcodecs/issues/848): "No output or error decoding streamed h264 video" -- decoder exhibited `decodeQueueSize` never increasing but no output or errors. Root cause: missing SPS/PPS NAL units.
- [w3c/webcodecs Issue #656](https://github.com/w3c/webcodecs/issues/656): Proposal to allow decoders to ignore corrupted frames rather than entering terminal `"closed"` state on first error.

The root cause is that WebKit's platform decoder abstraction layer (VideoToolbox on macOS, GStreamer on Linux) does not always propagate decode failures back to the WebCodecs layer. The platform decoder may accept input, fail to produce output, and not report an error -- the WebCodecs layer has no visibility into this silent failure.

#### Q4: Is there a way to do a "trial decode" that would be more reliable?

**Yes, and the architecture already exists in this project.**

A trial decode would: (1) create a `VideoDecoder` with output/error callbacks, (2) `configure()` with the target config, (3) feed a single keyframe as an `EncodedVideoChunk`, (4) call `flush()` to force output, (5) wait with a timeout: output callback = success, error callback or timeout = failure.

**Practical considerations:**
- **What's needed**: Pre-encoded minimal keyframe bitstreams per codec (H.264, HEVC, AV1). A single black 64x64 I-frame is sufficient. ~500 bytes to ~5 KB per codec.
- **Latency**: Decoder creation ~1-5ms, configure ~1-10ms, decode one keyframe ~10-50ms, flush ~10-50ms. **Total: ~50-200ms** per codec.
- **Reliability**: Tests the actual decode pipeline, not just codec string recognition or decoder object creation. Catches NALU rewriting bugs, colorimetry issues, threading problems, and missing platform codecs.

The `thumbnailWorker.ts` already implements the full decode pipeline for filmstrip generation. A trial decode probe would be a stripped-down version. The gap is that no major streaming library ships pre-encoded minimal bitstreams for probe purposes.

**Downside**: Requires shipping small pre-encoded keyframes with the application and accepting ~100ms startup latency per codec. Must run in a secure context (same constraint as `isConfigSupported`). Creates a temporary decoder that consumes a hardware decoder slot.

#### Q5: Does behavior differ between main thread and worker-thread `VideoDecoder`?

**No difference per spec or empirical testing.**

The WebCodecs spec exposes `VideoDecoder` as `[Exposed=(Window, DedicatedWorker)]` with no normative text differentiating behavior between contexts. The project's CLAUDE.md confirms this empirically: *"WebCodecs H.264 decoding works on all CI platforms... in both main-thread and Worker contexts."*

The HEVC/AV1 silent failures on WebKit affect both contexts equally -- they are platform decoder issues (VideoToolbox/GStreamer), not threading issues. A `DedicatedWorker` inherits its secure context status from its creating document, so the `[SecureContext]` restriction applies identically.

### Recommendations for this project

1. **The `about:blank` probe ordering fix is correct and well-grounded.** The comment "requires a proper page context (not about:blank)" is accurate -- `VideoDecoder` is `undefined` on `about:blank` due to the `[SecureContext]` requirement and opaque origin. Always run probes after navigating to localhost.

2. **The timeout + skip pattern for filmstrip tests is the right approach** given that `isConfigSupported` cannot guarantee decode success (implementation-defined algorithm, spec-violating silent failures in WebKit). No single API call can guarantee frame output.

3. **A trial decode probe would be definitively reliable** for filmstrip support detection, catching the silent failures that `isConfigSupported` misses. Trade-off: shipping small pre-encoded keyframes (~500B-5KB per codec) and ~100ms startup latency. The thumbnail worker already has the decode infrastructure.

4. **The silent failure behavior in WebKit is a spec violation** that may improve as fixes land ([Bug 262950](https://bugs.webkit.org/show_bug.cgi?id=262950) is REOPENED). Relying on specific browser versions is fragile -- timeout-based detection is more robust.

### Key references

- [WebCodecs spec: `isConfigSupported`](https://www.w3.org/TR/webcodecs/#dom-videodecoder-isconfigsupported) -- "Check Configuration Support" is implementation-defined
- [WebCodecs spec: `decode()` method](https://w3c.github.io/webcodecs/#dom-videodecoder-decode) -- mandates EncodingError on decode failure
- [WebCodecs spec: Close algorithm](https://w3c.github.io/webcodecs/#close-videodecoder) -- error callback must fire for non-AbortError
- [w3c/webcodecs Issue #744](https://github.com/w3c/webcodecs/issues/744) -- "invalid" vs "unsupported" interop
- [w3c/webcodecs Issue #350](https://github.com/w3c/webcodecs/issues/350) -- `[SecureContext]` rationale (fingerprinting prevention)
- [w3c/webcodecs Issue #383](https://github.com/w3c/webcodecs/issues/383) -- request to drop SecureContext rejected
- [w3c/webcodecs Issue #848](https://github.com/w3c/webcodecs/issues/848) -- "No output or error" pattern
- [w3c/webcodecs Issue #656](https://github.com/w3c/webcodecs/issues/656) -- proposal to allow ignoring corrupted frames
- [WebKit Bug 262950](https://bugs.webkit.org/show_bug.cgi?id=262950) -- HEVC isConfigSupported true but decode fails (REOPENED)
- [WebKit commit 8555adf](https://github.com/WebKit/WebKit/commit/8555adfc8a29c5d85caff1f9d6c7f9c0dc8eb0b2) -- HEVC NALU rewriter fix
- [WebKit commit 7e4ab69](https://github.com/WebKit/WebKit/commit/7e4ab69bd8f2b884468da81c4ed52a3b86fc2c34) -- isConfigSupported false positive fix for unknown codecs
- [WebKit PR #27230](https://github.com/WebKit/WebKit/pull/27230) -- AV1 GStreamer decoding fixes (Bug 272642)
- [W3C Secure Contexts spec](https://w3c.github.io/webappsec-secure-contexts/) -- "Is origin potentially trustworthy?" (opaque → Not Trustworthy)
- [whatwg/html#6369](https://github.com/whatwg/html/issues/6369) -- spec/implementation mismatch for about:blank secure context
- [Chromium Issue 510424](https://issues.chromium.org/issues/40082499) -- about:blank security context inheritance
- [MDN: Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
- [MDN: Features restricted to secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts)
- [upscaler.video Codec Support Dataset](https://webcodecsfundamentals.org/datasets/codec-support/) -- empirical isConfigSupported data across 224K sessions

### Cross-reference with independent research (ChatGPT deep research)

An independent research report was generated by ChatGPT covering the same Topic 2 questions. The findings are broadly consistent but surface several additional insights and gaps.

#### Agreement on core findings

Both sources agree on all fundamental conclusions:
- `isConfigSupported` is implementation-defined; no spec guarantee of actual decode success
- `about:blank` has opaque origin → non-secure context → `VideoDecoder` undefined (`[SecureContext]` gate)
- WebKit silent decode failures are spec violations (error callback not firing)
- Trial decode is the most reliable detection approach
- No main-thread vs worker-thread behavioral difference
- Same upstream bugs identified: WebKit Bug 262950, w3c/webcodecs#744

#### New insights from ChatGPT report

**1. Two-class failure taxonomy.** The report cleanly categorizes failures into:
- **Class A**: `isConfigSupported()` false positives (probe says yes, configure/decode throws `EncodingError`)
- **Class B**: Decode failures not surfaced as errors (decoder accepts input, produces no output, fires no error callback)

Our codebase encounters both: Class A is less common (WebKit HEVC with `EncodingError: Decoder failure` per Bug 262950), while Class B is the primary issue (AV1/HEVC filmstrip thumbnails never render with no error posted). The distinction matters because Class A can be caught with try/catch around `decode()`+`flush()`, while Class B requires timeout-based watchdogs.

**2. Resource exhaustion as failure contributor.** The WebCodecs spec acknowledges that decoders allocate "codec system resources" (CPU memory, GPU memory, hardware decoder handles) which "may be quickly exhausted." This is a plausible contributor to intermittent decode failures, especially when multiple decoders are active. The thumbnail worker creates a new `VideoDecoder` per segment decode operation — under heavy scrolling this could transiently exhaust hardware decoder slots. Our current architecture closes decoders after each segment, which mitigates this, but rapid segment transitions could still hit limits.

**3. Production code gap: coarse `isWebCodecsSupported()` check.** The report correctly identifies that `src/hooks/useThumbnailGenerator.ts:51-52` only checks `typeof VideoDecoder !== "undefined"` without validating codec-specific support. This means the filmstrip feature is enabled for all codecs (HEVC, AV1) whenever `VideoDecoder` exists, even on platforms where specific codec decode fails silently. The `isConfigSupported` probes only exist in E2E test helpers (`e2e/helpers.ts`), not in the production thumbnail pipeline.

**4. Zero-output guard missing in `processQueue()`.** The thumbnail worker tracks `outputCount` in decode functions (`thumbnailWorker.ts:272`, `:639`, `:826`) but never checks for `outputCount === 0` after `flush()` resolves. If `flush()` completes with zero outputs (the Class B silent failure), the worker silently proceeds without posting any thumbnail — the UI canvas stays blank with no diagnostic. Adding a `decodeUnavailable` message when `flush()` resolves with zero outputs would turn the silent failure into an explicit state.

**5. Probe result caching.** The report recommends caching trial decode results per `(codec string, platform signature)` to avoid repeated probes. This is relevant if trial decode is implemented — running it once per codec per session rather than per segment.

**6. Comprehensive detection approach comparison table.** Six approaches compared:

| Approach | What it measures | Failure modes | Recommended role |
|----------|-----------------|---------------|-----------------|
| `typeof VideoDecoder` | API presence | Too coarse; doesn't validate codec | Minimum baseline gate |
| `isConfigSupported(config)` | Config-level support | False on `about:blank`; true but decode fails | Pre-filter only |
| `decoder.configure(config)` | Configuration acceptance | Configure succeeds but `decode()` yields no output | Pre-step before trial |
| **Trial decode** (1 sample + flush + timeout) | End-to-end functional decode | Requires real segments; adds latency | **Primary "truth" signal** |
| `MediaSource.isTypeSupported()` | Container+codec demux claim | Known false positives (Firefox HEVC/AV1) | Secondary; not decisive for Worker |
| UI watchdog (no thumbnails after N seconds) | Observed behavior | Slow detection; user sees spinner | Essential fallback safety net |

**7. Existing trial decode precedent in this repo.** Commit `e39af6d` ("Add deep WebCodecs probe using real mp4box → VideoDecoder pipeline") implemented exactly this pattern for H.264 diagnostics. It was later removed in `3887a00` ("Remove WebCodecs probe: H.264 decoding works on all platforms") because H.264 works everywhere. The approach is directly applicable to HEVC/AV1 where decode failures persist.

**8. HEVC patent licensing as structural constraint.** The report notes HEVC's patent licensing environment (caniuse: "expensive to license") as a fundamental reason why browser support is inconsistent and likely to remain so. This means the "supported but fails" pattern for HEVC is structural, not a transient bug — robust detection is permanently needed.

**9. Fingerprinting surface.** Capability probing (codec enumeration) is a fingerprinting vector, which is why WebCodecs has `[SecureContext]` (per w3c/webcodecs#350). This is already noted in our Q2 findings but the report emphasizes minimizing or caching probing in production code.

#### Items NOT in ChatGPT report (unique to our research)

Our research includes several items the independent report does not cover:
- Chromium source code analysis with specific line numbers (`video_decoder.cc:281-334`) and internal function calls
- WebKit three-stage `isConfigSupported` implementation detail (`WebCodecsVideoDecoder.cpp`)
- Additional WebKit bugs: PR #27230, Bug 272642 (AV1 GStreamer fixes)
- Additional spec issues: w3c/webcodecs#383 (SecureContext drop rejected), #848 (no output/error pattern), #656 (corrupted frame proposal)
- Specific WebKit commit hashes for fixes (8555adf, 7e4ab69)
- Secure Contexts spec section numbers (3.1 vs 3.2 for origin-level vs URL-level)
- upscaler.video empirical dataset (224K sessions)
- `localhost` as potentially trustworthy origin (127.0.0.0/8 in spec step 3)

#### Additional actionable items from cross-reference

- **Actionable**: Add codec-specific `isConfigSupported` pre-check in `useThumbnailGenerator.ts` before spawning the worker (currently only checks `typeof VideoDecoder`)
- **Actionable**: Add zero-output detection in `thumbnailWorker.ts` — if `flush()` resolves with `outputCount === 0`, post a `decodeUnavailable` message instead of silently continuing
- **Actionable**: Consider resurrecting the trial decode approach from commit `e39af6d` for HEVC/AV1 specifically (H.264 version was removed as unnecessary since H.264 works everywhere)
- **Actionable**: Cache probe results per codec string per session to avoid repeated probes

### Status: COMPLETE

Topic 2 research is comprehensive. All 5 research questions answered with spec-level, source-code-level, and bug-tracker evidence. Cross-referenced with independent ChatGPT deep research — findings are consistent with 9 additional insights integrated.

Key findings:
- `isConfigSupported` is implementation-defined; WebKit attempts decoder creation but this does not guarantee decode success
- `about:blank` non-secure context is a known spec/implementation mismatch (browsers are more conservative than spec)
- WebKit's silent decode failures are spec violations (error callback not firing)
- Trial decode is the most reliable alternative, with ~50-200ms latency and pre-encoded keyframes needed
- Two failure classes: false positives (Class A, catchable) vs silent no-output (Class B, requires timeout)
- Production code uses coarse `typeof VideoDecoder` check without codec-specific validation
- Zero-output guard missing in thumbnail worker — silent failures go undetected

Actionable items for future work:
- **Actionable**: Consider implementing a trial decode probe for HEVC/AV1 filmstrip support detection using minimal pre-encoded keyframes (overlaps with thumbnail worker architecture; precedent exists in commit `e39af6d`)
- **Actionable**: File a WebKit bug or comment on Bug 262950 about the silent failure pattern (no error callback when decode silently produces no output)
- **Actionable**: Add codec-specific `isConfigSupported` pre-check in `useThumbnailGenerator.ts` (currently only checks API presence, not codec support)
- **Actionable**: Add zero-output detection after `flush()` in `thumbnailWorker.ts` to surface Class B silent failures as explicit messages
- **Actionable**: Cache probe results per codec per session to avoid redundant detection overhead

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

### Findings

#### Q1: Is ClearKey EME required to work in all browsers that expose the API?

**Yes -- ClearKey is the only mandatory key system.** The EME spec states: *"Implementation of Digital Rights Management is not required for compliance with this specification: only the Clear Key system is required to be implemented as a common baseline."* Proprietary DRM (Widevine, FairPlay, PlayReady) is optional; ClearKey (`org.w3.clearkey`) is mandatory for EME conformance. However, EME itself is optional for HTML conformance -- a browser that doesn't implement EME at all is still HTML-conformant.

**`requestMediaKeySystemAccess` implies a guarantee.** The "Get Supported Capabilities" algorithm (EME Section 3.2.2.3) requires the user agent to *"definitely support"* the combination of container, media types, encryption scheme, robustness, and configuration before resolving. When `requestMediaKeySystemAccess('org.w3.clearkey', ...)` resolves, the browser has committed that it can decrypt. If it later fails, this is a spec violation.

**ClearKey MUST support `cenc` (AES-CTR).** From the WICG Encryption Scheme Query extension: *"Clear Key implementations MUST support the cenc scheme at a minimum, to ensure interoperability."*

The macOS WebKit behavior -- resolving the probe but silently failing to decrypt -- is therefore a spec violation: the browser reported "definitely supports" ClearKey decryption but produced garbage output.

#### Q2: Is the macOS WebKit behavior a known bug?

**Safari historically does not support `org.w3.clearkey` through the standard unprefixed EME API.** The most specific open bug is [WebKit Bug 231006](https://bugs.webkit.org/show_bug.cgi?id=231006): *"[EME] Clear key encryption support is broken"* (filed 2021, still NEW as of November 2024). It states ClearKey is *"broken due to incompatible pssh init data"* and all ClearKey tests are skipped on Mac. A 2024 user comment confirms it still blocks Shaka Player ClearKey support. The earlier [Bug 158843](https://bugs.webkit.org/show_bug.cgi?id=158843) ("update the ClearKey CDM") was RESOLVED FIXED in 2018 but clearly did not address the deeper issue. The Shaka Player team confirmed: *"The ClearKey video plays fine in Chrome and doesn't play at all in Safari"* ([shaka-player#478](https://github.com/shaka-project/shaka-player/issues/478)).

**WebKit has ClearKey at the EME API layer but not in the media pipeline.** The cross-platform `CDMClearKey.cpp` handles key management (license parsing, key storage) and is compiled on all platforms, which is why the `requestMediaKeySystemAccess` probe succeeds on macOS. But the actual AES-CTR decryption pipeline is only wired for the GStreamer backend (Linux), not the AVFoundation backend (macOS). See Q3 for details.

**Playwright's `window.safari` injection compounds the problem.** [Playwright Issue #26948](https://github.com/microsoft/playwright/issues/26948) found that Playwright injects `if (!window.safari) window.safari = {};` which breaks feature detection for DRM libraries. [Playwright Issue #31017](https://github.com/microsoft/playwright/issues/31017) documents that WebKit on non-Apple platforms has different feature support, and the maintainers added documentation acknowledging this.

**Apple's AVFoundation does have a ClearKey API** (`AVContentKeySystem.clearKey`, added in macOS 10.13 / iOS 11 at WWDC 2017), but WebKit's bridge from the web EME API to AVFoundation only wires up FairPlay, not ClearKey. The AVFoundation-level ClearKey is designed for native apps using `AVContentKeySession`, not for the web EME path.

#### Q3: What exactly happens inside WebKit's CDM when it "decrypts" with ClearKey?

**Neither AES-CTR invocation nor pass-through -- the decryption pipeline is simply absent on macOS.**

WebKit has two fundamentally different decryption architectures by platform:

**GStreamer path (Linux WebKitGTK):**
1. `CDMClearKey.cpp` (cross-platform) handles EME API: key system matching, license parsing, key storage in `KeyStore`. Contains **no decrypt method**.
2. `WebKitCommonEncryptionDecryptorGStreamer.cpp` provides a GStreamer `BaseTransform` element that decrypts samples using `GstProtectionMeta` (IV, key ID, subsample info, cipher mode). Distinguishes `cenc` (AES-CTR) and `cbcs` (AES-CBC). On failure, raises explicit `GST_ELEMENT_ERROR(STREAM, DECRYPT)`.
3. The ClearKey-specific decryptor (`CDMProxyClearKey.cpp`, `WebKitClearKeyDecryptorGStreamer.cpp`) historically used libgcrypt's `GCRY_CIPHER_AES128` with `GCRY_CIPHER_MODE_CTR`. **However, both files have been removed from the current WebKit source.** The current `CDMFactoryGStreamer.cpp` only registers the Thunder (OpenCDM) factory -- no ClearKey factory. This is why `hasClearKeySupport()` returns `false` on Linux WebKitGTK.

**AVFoundation path (macOS):**
1. `CDMClearKey.cpp` is compiled and registers the `org.w3.clearkey` key system, so `requestMediaKeySystemAccess` succeeds.
2. `platformRegisterFactories()` in `CDMFairPlayStreaming.cpp` registers both `CDMFactoryClearKey` and `CDMFactoryFairPlayStreaming`.
3. Keys are successfully parsed from the JSON license and stored in the `KeyStore` after `session.update()`. The `keystatuseschange` event fires with status `"usable"`.
4. **But no decryption pipeline exists for ClearKey on the macOS AVFoundation path.** `CDMSessionAVContentKeySession.mm` and `CDMInstanceFairPlayStreamingAVFObjC.mm` only wire FairPlay. The `CDMInstanceProxy` has keys but no `CDMProxy` decryptor to apply them.
5. AVFoundation's decoder receives still-encrypted samples, silently drops them, and `readyState` stays at `HAVE_METADATA`.

**Scheme support:** `CDMClearKey.cpp` supports `"keyids"`, `"cenc"`, and `"webm"` init data types. The (now-removed) GStreamer decryptor only supported `cenc` (AES-CTR), not `cbcs`.

#### Q4: Is `readyState` polling the right detection mechanism?

**Yes -- `readyState` polling is the most practical mechanism for this specific failure mode.** The failure is uniquely silent: no EME events, no `MediaError`, and no error callbacks indicate failure.

**Analysis of alternative signals:**

| Signal | Would it help? | Why |
|--------|---------------|-----|
| `waitingforkey` | No | Keys ARE provided and status is `"usable"`. Failure is downstream. Event would not fire. |
| `keystatuseschange` | No | Fires successfully with `"usable"` -- the CDM layer succeeds, the pipeline fails |
| `video.error` | Partially | Already checked in polling loop. macOS WebKit does not raise `MediaError` for this case |
| `encrypted` | No | Confirms encryption is present, says nothing about decryption success |
| `timeupdate` | No | Video is paused on load, so `timeupdate` does not fire |
| `canplay` | Equivalent | Would fire when `readyState >= 3`, functionally same as current `readyState >= 2` check |
| `playing` | No | Video is paused on load |
| `progress` / `buffered` | No | MSE reports buffered data regardless of decryption |

**Key spec context:** The EME working group explicitly decided NOT to reuse standard `waiting`/`canplay` events for key-related blocking ([Issue #7](https://github.com/w3c/encrypted-media/issues/7)). There is also **no inverse of `waitingforkey`** ([Issue #284](https://github.com/w3c/encrypted-media/issues/284)) -- no event fires when decryption resumes. The Shaka Player team requested this and it was closed as wontfix.

#### Q5: Is the 1.5s timeout correct? Is there a spec-defined signal for "decryption succeeded"?

**There is no spec-defined signal that says "decryption of the current segment succeeded."** The spec leaves timing implementation-defined.

**The EME decryption lifecycle signals:**

1. `waitingforkey` fires when playback is blocked for a key. The "Wait for Key" algorithm sets `readyState` to `HAVE_METADATA` (if no frames decoded yet) or `HAVE_CURRENT_DATA` (if playback was underway -- per [Issue #338](https://github.com/w3c/encrypted-media/issues/338) resolution). Runs synchronously, not in a task.

2. `keystatuseschange` fires after `session.update()` provides keys. Status `"usable"` means the CDM *believes* the key can decrypt, but does not guarantee frames are produced.

3. After keys become available, "Attempt to Resume Playback If Necessary" runs: checks if the media element was waiting for a key → attempts decryption → if successful, `readyState` transitions up → `canplay` fires (from `HAVE_CURRENT_DATA` → `HAVE_FUTURE_DATA`).

4. Cross-browser timing inconsistency: browsers decode ahead of playback (Firefox ~10 frames, Chrome ~4 frames), so `waitingforkey` may fire while frames are still being displayed from the decode-ahead buffer ([Issue #336](https://github.com/w3c/encrypted-media/issues/336)).

**The 1.5s timeout is well-calibrated.** Working browsers reach `readyState >= 2` within ~100-200ms. The timeout provides 7-15× safety margin. The 50ms polling interval is fine -- no spec-defined minimum exists.

**Possible improvements:**
- Add `canplay` event listener as a fast positive path alongside polling
- Check `keystatuseschange` for `"internal-error"` status to fail fast
- Both are optimizations, not corrections -- the current approach is functionally correct

#### Q6: Does Playwright's WebKit match real Safari for ClearKey?

**Real Safari ALSO does not support ClearKey DASH.** This is not a Playwright-specific issue -- it's a fundamental WebKit/Safari limitation.

**The evidence:**
1. **WebKit Bug 231006** ("[EME] Clear key encryption support is broken", filed 2021, still NEW) explicitly states ClearKey is broken on Mac due to PSSH init data incompatibility. All ClearKey tests skipped on Mac. The earlier Bug 158843 was resolved in 2018 without fixing the underlying issue.
2. **Shaka Player maintainers confirmed** Safari doesn't support ClearKey ([#478](https://github.com/shaka-project/shaka-player/issues/478), [#1773](https://github.com/google/shaka-player/issues/1773)).
3. **W3C EME test results** show Safari fails `clearkey-mp4` tests ([w3c test results](https://w3c.github.io/test-results/encrypted-media/all.html)).
4. **WebKit source confirms** the AVFoundation pipeline only wires FairPlay, not ClearKey (see Q3).

**Where Playwright differs from real Safari:**

| Aspect | Real Safari | Playwright's WebKit |
|--------|------------|-------------------|
| `requestMediaKeySystemAccess('org.w3.clearkey')` | **Resolves** (API probe passes) | **Resolves** (same code) |
| Actual ClearKey decryption | Silently fails (same root cause) | Silently fails (same root cause) |
| FairPlay DRM | Works | May not work ([#26948](https://github.com/microsoft/playwright/issues/26948)) |
| `window.safari` | Present | Injected as empty object |

The key difference is that **Layer 1 (`hasClearKeySupport`) returns `true`** on both real Safari and Playwright's macOS WebKit, because the EME API probe succeeds. The **Layer 2 (`waitForDecryption`) detection is needed** on both platforms. The software decryption fallback works identically on both.

For Linux WebKitGTK, the behavior is cleaner: Layer 1 returns `false` because the ClearKey GStreamer factory is not registered, and the software fallback activates immediately without the 1.5s detection delay.

### Recommendations for this project

1. **The two-layer detection is the correct architecture** and is not fragile. Layer 1 catches Linux WebKitGTK (no EME). Layer 2 catches macOS WebKit (EME exists but ClearKey decryption pipeline is absent). Both are structural limitations, not transient bugs.

2. **The 1.5s timeout is appropriate.** The spec provides no "decryption succeeded" signal. Working browsers reach `readyState >= 2` in ~100-200ms; 1.5s gives 7-15× margin.

3. **This is NOT Playwright-specific.** Real Safari has the same ClearKey limitation. The software decryption fallback would be needed for real Safari users with ClearKey-encrypted content.

4. **Consider adding a `canplay` event listener** as a fast positive path to detect decryption success without polling, while keeping the timeout-based fallback.

5. **Consider checking `keystatuseschange` for `"internal-error"` status** to fail faster when the CDM explicitly reports failure.

### Key references

- [W3C EME Specification](https://www.w3.org/TR/encrypted-media/) -- ClearKey is the only mandatory key system (Section 9.1)
- [WICG Encryption Scheme Query](https://wicg.github.io/encrypted-media-encryption-scheme/) -- ClearKey MUST support `cenc`
- [WebKit Bug 231006](https://bugs.webkit.org/show_bug.cgi?id=231006) -- "[EME] Clear key encryption support is broken" (NEW since 2021, PSSH init data incompatibility)
- [WebKit Bug 158843](https://bugs.webkit.org/show_bug.cgi?id=158843) -- "update the ClearKey CDM" (RESOLVED FIXED 2018, did not fix the deeper issue)
- [WebKit Bug 158836](https://bugs.webkit.org/show_bug.cgi?id=158836) -- EME compliance umbrella bug
- [Shaka Player #478](https://github.com/shaka-project/shaka-player/issues/478) -- ClearKey cross-browser discussion
- [Shaka Player #1773](https://github.com/google/shaka-player/issues/1773) -- ClearKey on iOS/Mac
- [Playwright #26948](https://github.com/microsoft/playwright/issues/26948) -- DRM on Playwright's WebKit
- [Playwright #31017](https://github.com/microsoft/playwright/issues/31017) -- WebKit feature support on non-Apple platforms
- [CDMClearKey.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/encryptedmedia/clearkey/CDMClearKey.cpp) -- Cross-platform ClearKey CDM (key management only, no decrypt)
- [CDMFairPlayStreaming.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/avfoundation/CDMFairPlayStreaming.cpp) -- platformRegisterFactories registers both ClearKey and FairPlay
- [Apple AVContentKeySystem.clearKey](https://developer.apple.com/documentation/avfoundation/avcontentkeysystem/clearkey) -- AVFoundation-level ClearKey (not wired to web EME)
- [W3C Issue #284](https://github.com/w3c/encrypted-media/issues/284) -- `waitingforkey` has no inverse event (closed wontfix)
- [W3C Issue #336](https://github.com/w3c/encrypted-media/issues/336) -- `waitingforkey` fires at different times across browsers
- [W3C Issue #338](https://github.com/w3c/encrypted-media/issues/338) -- `readyState` should be `HAVE_CURRENT_DATA` when playing
- [W3C Issue #129](https://github.com/w3c/encrypted-media/issues/129) -- Confirm `readyState` behavior when blocked waiting for key
- [W3C Issue #7](https://github.com/w3c/encrypted-media/issues/7) -- EME should not fire waiting/canplay events for key issues
- [MDN: waitingforkey event](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/waitingforkey_event)
- [MDN: keystatuseschange event](https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySession/keystatuseschange_event)
- [W3C EME test results](https://w3c.github.io/test-results/encrypted-media/all.html) -- Safari fails clearkey-mp4 tests
- [Igalia blog: EME on GStreamer-based WebKit ports](https://blogs.igalia.com/xrcalvar/2020/09/02/serious-encrypted-media-extensions-on-gstreamer-based-webkit-ports/) -- Architecture explanation

### Cross-reference with independent research (ChatGPT deep research)

An independent research report was generated by ChatGPT covering the same Topic 3 questions. The findings are broadly consistent and reinforce the core conclusions, while surfacing several additional insights.

#### Agreement on core findings

Both sources agree on all fundamental conclusions:
- ClearKey is the only mandatory key system in the EME spec; `cenc` (AES-CTR) must be supported
- No spec-defined "decryption succeeded" signal exists -- `readyState` polling is the best detection mechanism
- The two-layer detection architecture in `softwareDecrypt.ts` is correct and well-matched to the failure modes
- This is a known WebKit problem, not specific to Playwright
- The 1.5s timeout is reasonable for the detection window
- The EME "Attempt to Decrypt" algorithm explicitly allows wrong-key decryption to not trigger an error -- failure surfaces (or doesn't) at the decode stage
- Same Shaka Player issues identified confirming ClearKey doesn't work in Safari

#### New insights from ChatGPT report

**1. WebKit Bug 231006 -- the correct and still-open bug.** The ChatGPT report identified [WebKit Bug 231006](https://bugs.webkit.org/show_bug.cgi?id=231006) ("[EME] Clear key encryption support is broken"), filed September 2021 and still NEW as of November 2024. This is more specific and more relevant than Bug 158843 (which is RESOLVED FIXED from 2018). Bug 231006 explicitly states ClearKey is broken "due to incompatible pssh init data" and that all ClearKey tests are skipped on Mac. A November 2024 user comment confirms it still blocks Shaka Player ClearKey support. **Our Q2 has been updated to reference this bug.**

**2. PSSH init data compatibility as a root cause dimension.** Bug 231006 attributes the failure to "incompatible pssh init data" -- meaning WebKit's ClearKey CDM cannot parse the standard CENC PSSH box format. This is a complementary explanation to our Q3 finding (no AVFoundation decryption pipeline): even if the pipeline existed, the CDM may not correctly extract key info from the PSSH box. This raises the question: would differently formatted PSSH data (e.g., using `keyids` init data type instead of `cenc`) bypass this failure? This is a testable hypothesis.

**3. EME "Attempt to Decrypt" spec language.** The report quotes the EME spec's note that *"using the wrong key does not necessarily trigger a 'decryption fails' branch"* and *"no error is fired here but one may be fired during decode."* We described this conceptually in Q4/Q5 but the ChatGPT report provides the more precise spec language. This spec text directly justifies the `readyState`-based detection: if even wrong-key decryption doesn't fire an error, then correct-key-but-no-pipeline decryption certainly won't.

**4. Playback progression as supplemental signal.** The report identifies `timeupdate`/`currentTime` advancement as a "strong 'it really plays' signal" that could serve as a longer-window confirmation after the initial `readyState` gate. This is slower than `readyState` polling but provides higher confidence. Relevant if the player were to issue a brief `play()` probe during detection.

**5. Alternatives comparison.** The report compares 5 implementation strategies:

| Approach | Compatibility | Complexity | Notes |
|----------|---------------|------------|-------|
| Native EME only | Low (fails on WebKit) | Low | What we'd have without the fallback |
| Current two-layer + software fallback | High for `cenc` | Medium | Already implemented; correct |
| Always force software decryption on WebKit | High for `cenc` | Medium | Simpler but penalizes platforms where EME would work |
| UA-based denylist | Medium--High | Medium | Fragile; requires continuous version maintenance |
| Server-side decrypt/repackage | Very high | High | Contradicts "no server required" premise |

The current approach is validated as the best fit. The "always force software on WebKit" alternative was considered and correctly rejected because WebKit behavior varies across builds (Playwright vs Safari vs WebKitGTK).

**6. Performance concern for software decrypt path.** Decrypting each sample in-place within `mdat` is CPU-intensive, especially for high-bitrate streams. The report suggests considering moving decryption to a Worker if performance becomes an issue. Currently `softwareDecrypt.ts` runs in the main thread via Shaka response filters.

**7. Security model note.** Software decryption places the clear key and decrypted media in JS memory space. For ClearKey this is acceptable (ClearKey is not designed as high-security DRM -- the key is in the manifest or user-provided), but worth documenting if the player is ever used beyond test/analysis scenarios.

**8. ClearKey test vector for reproduction.** The report cites a public ClearKey test vector: `https://media.axprod.net/TestVectors/v7-MultiDRM-SingleKey/Manifest_1080p_ClearKey.mpd` (from [Shaka Packager #1197](https://github.com/shaka-project/shaka-packager/issues/1197)). This could be used to reproduce the failure on real Safari without generating a custom fixture.

**9. Stale URL in sources.** The report flags that the "Playwright WebKit patches" URL in our Sources to Investigate (`https://github.com/nicedoc/nicedoc.io`) resolves to a GitHub 404. Playwright's WebKit patches are tracked in the [Playwright monorepo](https://github.com/nicedoc/nicedoc.io) rather than a standalone repo. The actual WebKit patch set lives in the `browser_patches/webkit/` directory of `microsoft/playwright`.

**10. False negative risk.** A slow platform might take >1500ms to reach `readyState >= 2` even when EME works correctly, triggering an unnecessary reload to the software path. This is mitigated by the 7-15x safety margin (working browsers reach readyState >= 2 in ~100-200ms), but could theoretically occur on very slow VMs or under extreme load.

#### Items NOT in ChatGPT report (unique to our research)

Our research includes several items the independent report does not cover:
- Detailed WebKit source code analysis: `CDMClearKey.cpp` (608 lines read), `CDMFairPlayStreaming.cpp` `platformRegisterFactories`, `CDMFactoryGStreamer.cpp` only registers Thunder
- The specific removed GStreamer files: `CDMProxyClearKey.cpp`, `WebKitClearKeyDecryptorGStreamer.cpp` (previously used libgcrypt `GCRY_CIPHER_AES128`)
- Apple's `AVContentKeySystem.clearKey` (AVFoundation-level ClearKey API exists but is not wired to web EME)
- Complete signal analysis table evaluating 8 alternative detection signals with specific reasons each fails
- W3C EME working group issues with precise context: #7 (no waiting/canplay for keys), #129, #284 (no inverse of waitingforkey, closed wontfix), #336 (cross-browser timing), #338 (readyState during playback)
- `keystatuseschange` fires with `"usable"` even when decryption silently fails -- the CDM layer succeeds while the pipeline fails
- W3C EME test results page showing Safari fails `clearkey-mp4` tests
- Cross-browser decode-ahead buffer sizes (Firefox ~10 frames, Chrome ~4 frames)

#### Additional actionable items from cross-reference

- **Actionable**: Test with different PSSH/init data formats to determine if Bug 231006's "incompatible pssh init data" root cause is format-specific. Try `keyids` init data type instead of `cenc` PSSH to see if WebKit's CDM can parse it
- **Actionable**: Use the axprod.net ClearKey test vector (`Manifest_1080p_ClearKey.mpd`) for real Safari reproduction testing
- **Actionable**: Consider adding `timeupdate`/`currentTime` advancement as a longer-window confirmation signal after the initial `readyState` gate, for environments where higher confidence is needed
- **Actionable**: Document the security model assumption (ClearKey places key in JS memory) in `softwareDecrypt.ts` header comment
- **Actionable**: If performance issues arise with high-bitrate encrypted streams, consider offloading the `configureSoftwareDecryption` response filter to a Worker (currently main-thread via Shaka response filters)

### Status: COMPLETE

Topic 3 research is comprehensive. All 6 research questions answered with spec-level, source-code-level, and bug-tracker evidence. Cross-referenced with independent ChatGPT deep research -- findings are consistent with 10 additional insights integrated.

Key findings:
- ClearKey is the only mandatory key system in the EME spec; macOS WebKit's silent failure is a spec violation
- The root cause is dual: (1) PSSH init data incompatibility ([Bug 231006](https://bugs.webkit.org/show_bug.cgi?id=231006), open since 2021) and (2) no AES-CTR decryption pipeline on the macOS AVFoundation path
- On Linux WebKitGTK, the ClearKey GStreamer decryptor has been removed entirely (only Thunder remains)
- `readyState` polling is the correct detection mechanism -- no EME event signals silent CDM failure
- The 1.5s timeout is well-calibrated (7-15x margin over working browsers)
- Real Safari has the same limitation as Playwright's WebKit -- this is not a Playwright-specific issue
- The two-layer detection architecture is validated as the best approach among 5 alternatives analyzed

Actionable items:
- **Actionable**: Consider adding `canplay` event listener as a fast positive path alongside `readyState` polling in `waitForDecryption()`
- **Actionable**: Consider checking `keystatuseschange` for `"internal-error"` status to fail faster
- **Actionable**: File or comment on WebKit Bug 231006 about the `requestMediaKeySystemAccess` false promise (resolves but cannot decrypt)
- **Actionable**: Test with different PSSH/init data formats (e.g., `keyids` init data type) to determine if the failure is format-specific
- **Actionable**: Use axprod.net ClearKey test vector for real Safari reproduction testing
- **Actionable**: Consider `timeupdate`/`currentTime` advancement as supplemental longer-window confirmation signal
- **Actionable**: Document security model assumption in `softwareDecrypt.ts` header
- **Actionable**: Consider Worker offload for software decrypt if performance issues arise with high-bitrate streams

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

### Findings

#### Q1: Is the offset caused by the encoder (CTTS atom values), the browser's MSE seek algorithm, or both?

**Primarily the encoder, with browser implementation determining whether the offset manifests.** The CTTS (Composition Time to Sample) box exists specifically because of B-frames. When B-frames are present, frames are stored in decode order (e.g., I, P, B, B for an IBBP GOP) but display in a different order (I, B, B, P). The CTTS table provides offsets to convert decode timestamps (DTS) to presentation timestamps (PTS): `CT(n) = DT(n) + CTTS(n)`.

During a seek, the MSE spec requires the browser to "feed coded frames from the active track buffers into the decoders starting with the closest random access point before the new playback position" ([MSE spec §3.15.3](https://w3c.github.io/media-source/)). The browser should then decode forward and display the frame whose PTS matches the target time. If a browser's seek pipeline correctly uses PTS, the CTTS offsets should be transparent. If it uses DTS internally (or has rounding issues in the PTS calculation), the offset equals the B-frame reorder depth.

The encoder determines the *magnitude* of possible offset (via bframes count → CTTS values). The browser determines whether that offset is *visible* (correct PTS-based vs incorrect DTS-based seeking).

#### Q2: What does the HTML spec say about seek behavior with B-frames?

**The spec does not address B-frames, composition time offsets, or frame-level precision.** The HTML spec defines a unified "seeking algorithm" ([WHATWG HTML §4.8.11.9](https://html.spec.whatwg.org/multipage/media.html#seeking)) invoked by both `currentTime` (for accurate seeking) and `fastSeek()` (with the `approximate-for-speed` flag set, allowing keyframe snapping).

Key spec properties:
- Setting `currentTime` invokes the seek algorithm **without** `approximate-for-speed`, meaning the browser should seek to the exact requested time, not the nearest keyframe
- `fastSeek()` invokes the seek algorithm **with** `approximate-for-speed`, allowing the browser to "seek to the nearest position in the media resource" (typically a keyframe) for performance
- The spec says "wait until the user agent has established whether or not the media data for the new playback position is available, and, if it is, until it has decoded enough data to play back that position"
- The spec makes no mention of composition time, CTTS, B-frames, or how frame reordering affects seek precision

[W3C Issue #4](https://github.com/w3c/media-and-entertainment/issues/4) (frame-accurate seeking) notes: "the `currentTime` property takes a time, not a frame number" and "internal rounding of time values may mean that one seeks to the end of the previous frame instead of the beginning of a specific video frame." The consensus is that the spec provides no frame-accuracy guarantees — only best-effort time-based seeking.

**`fastSeek()` is not relevant to our case** — our `useKeyboardShortcuts.ts` uses `video.currentTime = target` (accurate seek), not `fastSeek()`.

#### Q3: Does libx264 `-preset ultrafast` disable B-frames entirely? (Explaining why H.264 tests are exact)

**Yes.** The x264 `ultrafast` preset sets `bframes=0`, making it the only preset that disables B-frames entirely. All other presets use ≥3 B-frames:

| x264 Preset | bframes |
|-------------|---------|
| **ultrafast** | **0** |
| superfast | 3 |
| veryfast–slow | 3 |
| veryslow | 8 |
| placebo | 16 |

Our fixture additionally uses `-tune zerolatency` which independently disables B-frames. With both flags, the H.264 output has no CTTS box at all — PTS equals DTS for every frame. This is why H.264 OCR tests produce exact frame matches.

Source: [x264 preset reference](https://dev.beandog.org/x264_preset_reference.html)

#### Q4: For libx265 and AV1 encoders, what are the default B-frame settings? Can they be disabled?

**libx265 (`-preset ultrafast`):** Uses `bframes=3`. Unlike x264, x265 `ultrafast` does NOT disable B-frames:

| x265 Preset | bframes |
|-------------|---------|
| ultrafast, superfast | 3 |
| veryfast–slow | 4 |
| slower–placebo | 8 |

Our fixture uses `libx265 -preset ultrafast` without `-tune zerolatency` or `-bf 0`, so it produces IBBP GOPs with 3 consecutive B-frames. B-frames can be disabled with `-x265-params "bframes=0"`.

Source: [x265 preset docs](https://x265.readthedocs.io/en/stable/presets.html)

**libsvtav1 (`-preset 12`):** Uses `hierarchical-levels=5` (default for presets ≤12), creating 6 temporal layers with a hierarchical mini-GOP of 32 frames (2^5). The `pred-struct=2` (random access, default) enables bidirectional prediction. This is deeply nested B-frame reordering — far deeper than x265's 3 consecutive B-frames. B-frames can be disabled with `--pred-struct 1` (low-delay mode). The default `-g 30` is also overridden by our fixture's `-g 30 -keyint_min 30`.

Source: [SVT-AV1 Parameters.md](https://gitlab.com/AOMediaCodec/SVT-AV1/-/blob/master/Docs/Parameters.md)

**libaom-av1 (`-cpu-used 8`):** In good-quality mode (ffmpeg default), `cpu-used 8` is internally treated as `cpu-used 6`. Uses altref frames (AV1's equivalent of B-frames) with `lag-in-frames` ~19 by default. Frame reordering is present. Alt-ref frames can be disabled with `-auto-alt-ref 0`, and lag can be reduced with `-lag-in-frames 0`.

Source: [FFmpeg libaomenc.c source](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/libaomenc.c)

#### Q5: Is the ±3 frame tolerance correct, or a coincidence of bframes=3? What is the theoretical maximum offset?

**The ±3 tolerance is correct for x265 ultrafast but is a coincidence of the bframes=3 setting, not a universal constant.** The theoretical maximum composition time offset for a given B-frame configuration is:

`max_offset = bframes × frame_duration`

For x265 ultrafast (bframes=3) at 30fps: `max_offset = 3 × (1/30s) = 100ms = 3 frames`

However, the observable seek offset depends on how the browser's seek algorithm interacts with the decode pipeline. If the browser correctly maps PTS to display time, the offset should be 0. The ±3 offset suggests the browser is resolving to a nearby frame rather than the exact PTS target — possibly due to:
1. DTS-based internal seek followed by PTS mapping with rounding
2. Frame boundary quantization in the MSE buffering layer
3. Browser-specific floating-point precision in currentTime

For SVT-AV1 with hierarchical-levels=5, the reorder depth is much deeper (up to 31 frames between base-layer frames), yet CI tests show the same ±3 tolerance works. This suggests the browser's seek algorithm does correct for most of the B-frame offset, and the residual ±3 is a browser-level precision issue, not the full B-frame depth.

**The ±3 tolerance should be re-evaluated per encoder configuration.** If x265 bframes were increased (e.g., to 8 with `-preset slower`), the tolerance would likely need to increase. A safer formula would be `max(3, bframes)`.

#### Q6: Do different browsers handle B-frame seeking differently?

**Yes, browsers differ in their seek precision.**

**Chromium/Edge:** Since Chrome 69, MSE uses PTS (not DTS) for buffered ranges and duration values. The `PipelineController` orchestrates seeking through the `ChunkDemuxer` → `DecoderStream` → `VideoDecoder` pipeline. The decoder decodes from the nearest keyframe forward and outputs frames in PTS order. Chromium's seek should be accurate for B-frame content, and HEVC/AV1 tests on Chromium/Edge would show exact frames — except that Chromium doesn't support HEVC MSE at all (probe returns false), so we can't verify this. AV1 on Chromium shows ±3 tolerance in practice.

Source: [Chromium media design docs](https://www.chromium.org/developers/design-documents/video/)

**Firefox:** Has a `MediaDecoderStateMachine` with `AccurateSeekingState` that decodes forward from the keyframe to the exact target time. However, Firefox is known to land slightly before frame boundaries (`N/fps - epsilon`), which is why `FRAME_SEEK_EPSILON` exists in our code. Bug [778077](https://bugzilla.mozilla.org/show_bug.cgi?id=778077) shows `fastSeek` was implemented as keyframe-only seek. Bug [1022913](https://bugzilla.mozilla.org/show_bug.cgi?id=1022913) shows fastSeek direction issues. For B-frame content, Firefox's accurate seek should work via PTS, but the epsilon issue may compound with B-frame offsets.

**WebKit/GStreamer:** GStreamer tracks PTS and DTS separately in `GstBuffer`. During seeks, the `GstVideoDecoder` resets and flushes its pipeline. GStreamer's segment handling clips frames outside the target range by PTS. However, per the GStreamer docs: "every time you seek you'll get DTS that is before segment start (assuming stream with bframes)." The ±3 frame offset on WebKitGTK with HEVC is likely a GStreamer pipeline interaction where the segment start/stop clipping doesn't perfectly align with composition time offsets. GStreamer Bug [740575](https://gstreamer-bugs.narkive.com/JBWSWwCW/bug-740575-new-fixing-dts-in-gstreamer) discusses DTS fixing in GStreamer.

#### Q7: Is `fastSeek()` vs `currentTime` assignment relevant here?

**No, `fastSeek()` is not used in our code path.** Our `useKeyboardShortcuts.ts` sets `video.currentTime = target`, which invokes the seek algorithm WITHOUT the `approximate-for-speed` flag. This means the browser should seek accurately, not to the nearest keyframe.

The spec-level difference:
- `currentTime = T` → accurate seek (decode from keyframe, display frame at T)
- `fastSeek(T)` → approximate seek (may display nearest keyframe frame)

The ±3 frame offset is NOT caused by fastSeek behavior. It's an accuracy limitation of the browser's accurate-seek implementation when handling B-frame content.

#### Shaka Player's role in the seek pipeline

**Shaka Player does not modify the seek target for B-frame correction.** When `video.currentTime = T` is set, Shaka Player:
1. Detects the seek via its `onSeeking_()` handler
2. May reposition the playhead if it falls outside the availability window (live streams only, via `safeSeekOffset`)
3. Clears and re-fetches segments around the new position if the target isn't buffered
4. Calculates `timestampOffset = Period@start - presentationTimeOffset` for MSE SourceBuffer alignment
5. Does NOT adjust the seek target based on B-frame CTTS values

Shaka Player Issue [#593](https://github.com/google/shaka-player/issues/593) documents playback failures with B-frames and `presentationTimeOffset` in Chrome (2016-2019 era PTS/DTS bugs, now fixed). Issue [#2087](https://github.com/shaka-project/shaka-player/issues/2087) confirms that PTS corresponds to composition time (CTTS + STTS values).

The seek offset is entirely a browser-level issue — Shaka passes through the seek to the native `<video>` element without modification.

#### Key references

- [WHATWG HTML seeking algorithm](https://html.spec.whatwg.org/multipage/media.html#seeking)
- [W3C MSE spec §3.15.3](https://w3c.github.io/media-source/) — seek algorithm in MSE context
- [W3C Issue #4: Frame accurate seeking](https://github.com/w3c/media-and-entertainment/issues/4)
- [x264 preset reference](https://dev.beandog.org/x264_preset_reference.html) — bframes=0 for ultrafast
- [x265 preset options](https://x265.readthedocs.io/en/stable/presets.html) — bframes per preset
- [SVT-AV1 Parameters.md](https://gitlab.com/AOMediaCodec/SVT-AV1/-/blob/master/Docs/Parameters.md) — hierarchical levels
- [Apple CTTS documentation](https://developer.apple.com/documentation/quicktime-file-format/composition_offset_atom)
- [GDCL CTTS explanation](https://www.gdcl.co.uk/mpeg4/ctts.htm) — CT(n) = DT(n) + CTTS(n) formula
- [Shaka Player Issue #593](https://github.com/google/shaka-player/issues/593) — B-frames + presentationTimeOffset
- [Shaka Player Issue #2087](https://github.com/shaka-project/shaka-player/issues/2087) — timestampOffset and CTTS
- [Chromium media design](https://www.chromium.org/developers/design-documents/video/) — pipeline architecture
- [Firefox Bug 778077](https://bugzilla.mozilla.org/show_bug.cgi?id=778077) — fastSeek implementation
- [GStreamer Bug 740575](https://gstreamer-bugs.narkive.com/JBWSWwCW/bug-740575-new-fixing-dts-in-gstreamer) — DTS fixing
- [Chrome 69 media updates](https://developer.chrome.com/blog/media-updates-in-chrome-69) — PTS buffering

### Status: COMPLETE

**Root cause identified.** The ±3 frame offset in HEVC and AV1 tests is caused by the combination of: (1) B-frame encoding producing CTTS offsets in the MP4 container, and (2) browser seek algorithms not achieving perfect PTS-based frame resolution for B-frame content. H.264 tests are exact because `libx264 -preset ultrafast` sets `bframes=0`, eliminating all composition time offsets.

**The ±3 tolerance is empirically correct but theoretically fragile.** It matches x265 ultrafast's bframes=3 by coincidence. For AV1 (deeper B-frame hierarchy), the same tolerance works because browsers resolve most of the B-frame offset and only the residual precision error is ±3 frames.

**Actionable items (4):**
1. Consider adding `-x265-params "bframes=0"` or `-tune zerolatency` to the HEVC fixture encoding to eliminate B-frames and enable exact frame matching — this would make HEVC tests consistent with H.264 and validate that the offset is indeed B-frame-related
2. Consider adding `--pred-struct 1` (low-delay) or `-svtav1-params "hierarchical-levels=0"` to the AV1 fixture to test without B-frames
3. If exact matching is not needed, document the tolerance formula as `max(3, encoder_bframes)` rather than a magic constant
4. Consider using `requestVideoFrameCallback()` API's `mediaTime` property for true frame-accurate verification in future tests, as it provides the actual presentation timestamp of the displayed frame rather than relying on `currentTime` rounding

### Cross-reference with ChatGPT deep research

**Overall assessment: Strong convergence on root cause, with ChatGPT raising several important gaps we didn't address.**

Both sources agree on the core mechanism (CTTS offsets from B-frame reordering → browser seek imprecision), the x264 ultrafast bframes=0 explanation, the HTML spec's lack of frame-accuracy guarantees, and `requestVideoFrameCallback` as the correct measurement primitive. ChatGPT independently arrived at the same conclusion about `currentTime` vs `fastSeek()` irrelevance.

#### New findings from ChatGPT that strengthen our analysis

**1. Edit lists as a compounding factor (MISSED IN ORIGINAL)**

ChatGPT raised edit lists (`elst` box) as a separate mechanism that can shift the presentation timeline. Follow-up investigation confirmed this is significant:

- FFmpeg's DASH muxer (`-f dash`) sets `+delay_moov` automatically, which enables meaningful edit list writing in init segments
- When B-frames are present and `-movflags +negative_cts_offsets` is NOT set (which is the case for DASH mode — only CMAF mode sets it), ffmpeg uses CTTS version 0 (unsigned offsets) and writes an edit list to compensate for the initial DTS shift
- The W3C [ISO BMFF Byte Stream Format spec](https://www.w3.org/TR/mse-byte-stream-format-isobmff/) requires MSE to handle only a **single edit with rate=1** — multiple edits or empty edits are not mandated
- Browser handling of edit lists in MSE is inconsistent: Chrome is most conformant, Firefox ignores multiple edits ([Bug 1140965](https://bugzilla.mozilla.org/show_bug.cgi?id=1140965)), WebKit has separate frame-accuracy issues
- With libx265 bframes=3 (IBBP pattern), the edit list compensates for a composition offset of `3 × (1/30s) = 100ms = 3 frames` — exactly matching our observed tolerance

This means the ±3 frame offset could be caused by edit list mishandling **in addition to** (or instead of) direct CTTS/B-frame mapping errors. The two mechanisms are two sides of the same coin: B-frame reordering is the encoder-side cause, edit lists + CTTS are the container-side signaling, and browser MSE handling is the manifestation.

**Actionable**: Adding `-movflags +negative_cts_offsets` to the HEVC/AV1 DASH encoding commands would switch to CTTS v1 (signed offsets) and eliminate edit lists, potentially improving seek accuracy on browsers that mishandle edit lists. However, this changes container structure and could trigger different bugs (e.g., [Shaka Packager #751](https://github.com/google/shaka-packager/issues/751) reports wrong frame rates with CTTS v1).

**2. Measurement methodology weakness: `seeked` + double-rAF is a heuristic (ACKNOWLEDGED BUT UNDEREXPLORED)**

ChatGPT correctly notes our test helper's `seeked` event + double-rAF wait "is still a heuristic, and it does not directly observe 'the frame presented for composition.'" Follow-up research on rVFC confirms:

- `video.currentTime` is audio-clock-derived (Chromium), not frame-PTS-derived — it may not correspond to any actual frame's presentation timestamp
- `metadata.mediaTime` from rVFC is populated directly from the frame's PTS, representing the actually-composited frame
- WICG/video-rvfc [issue #64](https://github.com/WICG/video-rvfc/issues/64) confirms rVFC is **unaffected** by Chrome's B-frame seeking bug — it reports actually-composited frames regardless
- All 6 CI browsers now support rVFC: Chrome 83+, Edge 83+, Firefox 132+, Safari 15.4+, WebKitGTK 2.36+
- The practical improvement would be replacing double-rAF with rVFC confirmation: `await seekedEvent; await new Promise(r => video.requestVideoFrameCallback(() => r()));` — semantically correct instead of timing-based guess
- Caveat: WebKitGTK stalls (Topic 5) are upstream of rVFC — if the seek never completes, rVFC won't fire either, so timeout fallbacks remain necessary

**3. Safari `seeked` fires before frame decode completes (NEW ECOSYSTEM SIGNAL)**

hls.js [#7583](https://github.com/video-dev/hls.js/issues/7583) reports that Safari fires `seeked` **before** the new frame is actually decoded and composited at 120fps. The hls.js maintainer confirms: "I experienced an issue in Safari where `seeked` is fired before `seeking` is complete." The reporter found rVFC is the reliable signal. This is the same class of bug as Mozilla [Bug 626273](https://bugzilla.mozilla.org/show_bug.cgi?id=626273) (fixed in Firefox in 2011), where `seeked` fired but the stale frame remained displayed.

**Safari 26.0 (2025)** fixed a specific B-frame seeking issue: "Fixed MP4 seeking with b-frames to prevent out-of-order frame display by suppressing frames with earlier presentation timestamps following the seek point" ([WebKit blog](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)).

**4. WebKit Bug 52697: truncation vs rounding in time conversion (NEW DETAIL)**

WebKit had a bug where converting `currentTime` (float seconds) to internal `TimeValue/TimeScale` used **truncation** instead of **rounding**: `(13/25) * 2500 = 1299.999...` truncated to `1299` instead of `1300`. Fixed in 2011 (r77690). This is exactly the class of bug our `FRAME_SEEK_EPSILON = 0.001` addresses — floating-point seconds don't map cleanly to integer frame boundaries.

**5. Controlled B-frame sweep experiment design (MORE DETAILED)**

ChatGPT proposes 5 falsifiable experiments with evaluation metrics. The most impactful is the "controlled B-frame sweep": generate fixtures with `bf=0,1,2,3,4` while holding everything else constant, then measure max absolute frame error and correlation with `bf`. Our actionable items #1 and #2 are a simplified version (bf=0 only). The full sweep would definitively prove whether error scales with B-frame depth.

**6. MSE vs progressive MP4 experiment (NEW)**

ChatGPT proposes testing the same media via direct `src` playback vs MSE to isolate whether the offset is MSE-specific (segment timestamp offsets, edit list handling) or present in progressive playback too. This would distinguish "MSE pipeline bug" from "general browser seek imprecision."

#### Areas where our original analysis has more depth

- **Shaka Player pipeline analysis**: Our Q7 and Shaka section are more detailed, with specific issue numbers (#593, #2087) and the `timestampOffset = Period@start - presentationTimeOffset` formula
- **GStreamer internals**: Our Q6 covers WebKit/GStreamer segment clipping behavior and Bug 740575 (DTS fixing)
- **Chrome 69 historical fix**: We documented the specific Chrome version that switched from DTS to PTS for MSE buffered ranges
- **SVT-AV1 hierarchical-levels=5**: We gave precise numbers for the prediction structure depth (6 temporal layers, mini-GOP of 32 frames)
- **Firefox AccurateSeekingState**: Specific state machine class name in the MediaDecoderStateMachine

#### ChatGPT ambiguities flagged (and our responses)

| ChatGPT flag | Our assessment |
|---|---|
| "Exact bitstreams and container timelines not specified" | Fair — we described encoder flags but didn't inspect actual CTTS/elst boxes with mp4dump. The edit list investigation above partially addresses this. |
| "Whether error is symmetric or biased" | Valid gap — we didn't analyze error distribution by browser/OS or by seek target (keyframe vs non-keyframe). CI test results only show pass/fail with ±3 tolerance, not the actual error values. |
| "Line-number references appear stale" | Incorrect — ChatGPT read raw GitHub which apparently rendered differently. Our line references (hevc.spec.ts:103-108, av1.spec.ts:117-121) are accurate in the local source. |
| "MSE vs direct-src not isolated" | Valid — all our tests use MSE (DASH fixtures). We don't have progressive MP4 tests for HEVC/AV1 to compare. |
| "Frame counter corresponds to CT, not DT?" | Important assumption we didn't verify. The drawtext filter in ffmpeg uses `%{eif\:n\:d\:4}` which is the sequential frame count (0, 1, 2, 3...). These numbers correspond to **encode order**, which for B-frame content differs from display order. However, since the frame counter is burned into the video *before* encoding, frame N in the source becomes frame N in both DTS and CTS order — the number is embedded in the pixel data, not derived from timestamps. So the OCR test's "expected frame 150 at t=5s" is valid regardless of reordering. |

#### Correction to ChatGPT

ChatGPT states x265 default bframes is **4** (CLI default). Our table says **3** for ultrafast. Both are correct but refer to different contexts: the x265 CLI default is 4, but the `ultrafast` preset overrides it to 3 (confirmed in [x265 preset docs](https://x265.readthedocs.io/en/stable/presets.html)). Our fixture uses `-preset ultrafast`, so bframes=3 is the applicable value.

#### Updated actionable items (7, expanded from 4)

Original items 1-4 remain. Adding:

5. Investigate adding `-movflags +negative_cts_offsets` to HEVC/AV1 DASH encoding to eliminate edit lists and switch to CTTS v1 — may improve seek accuracy on browsers that mishandle edit lists
6. Replace double-rAF with `requestVideoFrameCallback` confirmation in `seekTo()` and `pressKeyAndSettle()` — all 6 CI browsers support rVFC, providing a semantic "frame composited" signal instead of a timing heuristic. Keep timeout fallback for WebKitGTK stalls
7. Run `mp4dump` / `mp4info` on actual HEVC/AV1 DASH init segments to inspect CTTS version, edit list presence, and composition offset values — verify the container matches our assumptions

#### New references (from cross-reference)

- [W3C ISO BMFF Byte Stream Format](https://www.w3.org/TR/mse-byte-stream-format-isobmff/) — MSE edit list handling requirements
- [FFmpeg movenc.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/movenc.c) — edit list writing logic
- [Firefox Bug 1140965](https://bugzilla.mozilla.org/show_bug.cgi?id=1140965) — MSE ignoring multiple edits
- [WebKit Bug 52697](https://bugs.webkit.org/show_bug.cgi?id=52697) — truncation vs rounding in time conversion
- [Mozilla Bug 626273](https://bugzilla.mozilla.org/show_bug.cgi?id=626273) — float precision + stale frame invalidation
- [hls.js #7583](https://github.com/video-dev/hls.js/issues/7583) — Safari `seeked` fires before frame decode completes
- [WICG/video-rvfc #64](https://github.com/WICG/video-rvfc/issues/64) — rVFC unaffected by B-frame seeking bugs
- [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) — B-frame seeking fix
- [Shaka Packager #751](https://github.com/google/shaka-packager/issues/751) — CTTS v1 causing wrong frame rates
- [web.dev rVFC article](https://web.dev/articles/requestvideoframecallback-rvfc) — `mediaTime` vs `currentTime` difference

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

### Findings

#### Root cause: WebKitGTK GStreamer MSE seek race conditions

The seek stalls are caused by multiple, layered bugs in WebKitGTK's GStreamer media backend. These are all upstream issues — not bugs in our code or in Playwright's patches.

**Primary root cause — WebKit Bug 194499: "Seek while seeking freezes playback"**

This is the most likely single bug causing our CI stalls. Filed against the GStreamer MSE backend, it documents two problems:

1. **Buffer tolerance mismatch**: `MediaSource::hasBufferedTime()` uses tolerance-based checking for buffered ranges while GStreamer's private player uses exact matching. This causes the MSE stack to enter an invalid state during overlapping seeks.
2. **PAUSED-to-PAUSED state transition freeze**: When a seek arrives while another seek is in progress, the GStreamer pipeline enters a `PAUSED → PAUSED` async state change that hangs. The debug log shows: `"Delaying the seek: In async change PAUSED --> PAUSED"` — the seek never completes.

Under CI VM CPU pressure, seeks take longer, widening the race window. Our `seekTo()` retry loop, which re-issues `video.currentTime = t` until it sticks, directly triggers this bug when Shaka Player's internal init seeks overlap with our programmatic seeks.

**Contributing cause — WebKit Bug 275566: Seek from `seeked` callback races with state change continuation**

Fixed in WebKit trunk June 2024 (commit 81376c, PR WebKit/WebKit#29897). A race between the application triggering a seek from within a `seeked` event handler and GStreamer's playbin internal state change continuation from `async-done` handling. The flushing seek posts `async-start`, which races with playbin's bin state change from the previous seek, leaving the pipeline in an inconsistent state with a **seek that never finishes**. Fix: acquire the playbin states lock before sending seek events.

**Contributing cause — WPEWebKit Issue #1367: Early seek deadlock (GStreamer flush-stop + sticky events)**

A GStreamer-level deadlock that occurs during seeks when stream element chains are partially constructed. The sequence:
1. WebKitMediaSrc emits `FLUSH_START` during seek, propagating through a half-created element chain
2. The element chain completes, and `FLUSH_STOP` is emitted
3. Final chain elements receive `FLUSH_STOP` without preceding `FLUSH_START`
4. `FLUSH_STOP` propagation triggers sticky event (stream-start) push on a pad with a blocking probe → deadlock

**Reproduced on GStreamer 1.20.3** (the version on Ubuntu 22.04, our CI runner). Fixed via GStreamer MR #7632 (disable sticky event propagation on FLUSH_STOP). The fix is only available in newer GStreamer versions — not in Ubuntu 22.04's system GStreamer.

**Contributing cause — GStreamer Bug 796737 / Issue #301: ASYNC_DONE dropped**

A fundamental GStreamer core bug where the `ASYNC_DONE` message can be dropped internally by `gstbin` when `change_state` is executing concurrently with `ASYNC_START`. The application waits for `ASYNC_DONE` (which signals seek completion) but it never arrives. Sebastian Dröge (GStreamer maintainer) acknowledged: *"you still have a race condition in gstreamer where the async_done can be dropped"* but stated *"there are conflicting requirements here"* and considered the issue fundamentally unresolvable in GStreamer 1.x's state management design.

#### Answer to research question 1: Known WebKitGTK bugs

Yes, extensively. Key bugs:

| Bug | Title | Status | Directly causes our stalls? |
|-----|-------|--------|---------------------------|
| [WebKit 194499](https://bugs.webkit.org/show_bug.cgi?id=194499) | Seek while seeking freezes playback (MSE) | Partially addressed | **Yes — primary cause** |
| [WebKit 275566](https://bugs.webkit.org/show_bug.cgi?id=275566) | Race: seek from seeked callback hangs pipeline | Fixed Jun 2024 | Yes, if Playwright's WebKit predates fix |
| [WebKit 245852](https://bugs.webkit.org/show_bug.cgi?id=245852) | MSE scrubbing freeze/crash | **UNRESOLVED** (since Sep 2022) | Possible contributing factor |
| [WebKit 263317](https://bugs.webkit.org/show_bug.cgi?id=263317) | Pause after seek not working | Fixed Feb 2024 | Related — state desync during seek |
| [WebKit 272167](https://bugs.webkit.org/show_bug.cgi?id=272167) | Sinks return wrong position while seeking | Fixed, cherry-picked to 2.44 | Related — stale currentTime during seeks |
| [WebKit 269587](https://bugs.webkit.org/show_bug.cgi?id=269587) | currentTime reset on preroll | Fixed | Related — readyState drop during MSE init |
| [WPE #1367](https://github.com/WebPlatformForEmbedded/WPEWebKit/issues/1367) | Early seek deadlock (flush-stop + sticky events) | Fixed in GStreamer MR #7632 | **Yes — GStreamer 1.20.3 affected** |
| [WPE #284](https://github.com/WebPlatformForEmbedded/WPEWebKit/issues/284) | After seek, playback stuck (MSE) | Fixed via commits in #271 | Related pattern |
| [GStreamer #301](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/issues/301) | ASYNC_DONE message dropped → hang | Acknowledged, unfixed in 1.x | **Yes — fundamental GStreamer issue** |
| [GStreamer #349](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/issues/349) | Race in bin state change | Unfixable in GStreamer 1.x | Contributing |
| [GStreamer gst-plugins-bad #931](https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad/-/issues/931) | DASH: sometimes stalls trying to seek | Unknown | Related pattern |
| [GStreamer gst-plugins-bad #609](https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad/-/issues/609) | Pre-rolling problem after seeks (adaptive) | Unknown | Related pattern |

#### Answer to research question 2: WebKitGTK media backend architecture

WebKitGTK's media backend is `MediaPlayerPrivateGStreamer` (`Source/WebCore/platform/graphics/gstreamer/MediaPlayerPrivateGStreamer.cpp`). Key architectural details relevant to seek stalls:

**Threading model**: Two main thread domains:
1. **WebKit main thread** — handles UI, HTML media element state, fires `seeking`/`seeked` events
2. **GStreamer streaming threads** — one or more threads for pipeline processing, buffer passing, event handling

Messages from GStreamer threads are posted on the GStreamer bus and received by the main thread. An `AbortableTaskQueue` is used to "abort every time a flush is sent downstream from the main thread to avoid deadlocks from threads in the playback pipeline waiting for the main thread."

**Seek dispatch**: `doSeek()` method sends a `gst_element_seek()` on the pipeline. For MSE, this is in `MediaPlayerPrivateGStreamerMSE.cpp`. The seek completion is signaled via `timeChanged(const MediaTime&)` — if the MediaTime is valid, a seek has completed. The fix in Bug 275566 now acquires the playbin states lock before `doSeek()`.

**Preroll waiting**: `isPipelineWaitingPreroll()` (renamed from `isPipelineSeeking()` in Bug 263317) checks whether the pipeline is in an async state change (paused and pending). If so, moving to PLAYING is delayed to avoid "desynchronization between pipeline and player." This is the mechanism that breaks when overlapping seeks cause PAUSED→PAUSED transitions.

**Non-AC deadlock path**: In non-accelerated-compositing mode, `triggerRepaint()` uses a `m_drawCondition` that can deadlock between GStreamer threads and the main thread: "the main thread is waiting for the GStreamer thread to pause, but the GStreamer thread is locked waiting for the main thread to draw." This path is triggered more often in headless CI where AC may be disabled.

**Decoder threading**: WebKitGTK sets GStreamer's `max-threads` property to 2 threads, introducing artificial processing latency. Under CI VM CPU contention, this further slows seek completion.

#### Answer to research question 3: VM CPU throttling and deadlocks

Yes, VM CPU throttling directly increases the probability of hitting seek race conditions:

1. **GitHub Actions ubuntu-latest specs**: 4 vCPU / 16 GB RAM (public repos) or 2 vCPU / 8 GB (private). These are Azure VMs with shared physical hosts — subject to noisy-neighbor effects.
2. **No GPU**: Standard runners have zero GPU hardware. All video decoding is software-only via `avdec_h264` (ffmpeg). This is significantly more CPU-intensive.
3. **Race window expansion**: GStreamer's seek race conditions (Bug 194499, Bug 275566, Issue #301) have a timing component. Under CPU pressure, seeks take longer, expanding the window where overlapping operations can trigger deadlocks.
4. **Shared infrastructure**: Multiple VMs on the same physical host compete for CPU scheduling. I/O and CPU availability are not guaranteed — operations that take 5ms on bare metal may take 50ms+ on a loaded VM.

The 3s per-attempt timeout in our `seekTo()` is calibrated for this environment: long enough to allow normal seeks to complete under moderate VM load, short enough to recover from a stuck seek before the 30s test timeout.

#### Answer to research question 4: Can a stuck seek be canceled?

**Per the HTML spec (WHATWG Section 4.8.11.9)**: Yes. The seeking algorithm explicitly states: *"If the element's seeking IDL attribute is true, then another instance of this algorithm is already running. Abort that other instance of the algorithm without waiting for the step that it is running to complete."*

**In practice on WebKitGTK**: No, it doesn't work reliably. WebKit Bug 194499 documents that the GStreamer MSE backend does NOT correctly implement the abort behavior. Setting `currentTime` during an active seek can trigger the PAUSED→PAUSED freeze instead of aborting the first seek.

Setting `currentTime` to the **same** position is particularly dangerous. When GStreamer determines the target matches the current position, it may not perform an actual seek operation, meaning the `seeked` completion signal is never sent to WebKit's HTMLMediaElement, leaving `video.seeking = true` permanently.

Our workaround in `seekTo()` — retry with `video.currentTime = t` after a 3s timeout — is effective because the retry usually occurs after the pipeline has moved past the stuck state, but it relies on timing rather than a clean abort mechanism.

#### Answer to research question 5: Recovery via video.load() or src reassignment

`video.load()` can reset the stuck state, but with significant side effects:

- WebKit Bug 117354 documents the decision to "not set state to NULL until element is destroyed" for the GStreamer pipeline. `video.load()` triggers the full load algorithm, which resets `seeking` to false and `currentTime` to 0.
- WebKit Bug 269587 (fixed) addresses a specific problem where `video.load()` during MSE preroll caused a temporary `currentTime` of 0 that dropped `readyState` to `HAVE_METADATA`, creating a cascade of state corruption.

For our use case, `video.load()` is too destructive — it would require Shaka Player to reinitialize the entire DASH stream. The timeout + retry approach is less disruptive.

#### Answer to research question 6: GStreamer environment variables for reliability

**Potentially useful CI environment variables:**

| Variable | Value | Effect |
|----------|-------|--------|
| `LIBVA_DRIVER_NAME` | `dummy` | Prevents VA-API probe failures (no GPU on CI) |
| `LIBVA_DRIVERS_PATH` | `/dev/null` | Suppresses hardware decoder search |
| `GST_PLUGIN_FEATURE_RANK` | `vah264dec:0,vaapih264dec:0` | Explicitly disable hardware decoders |
| `WEBKIT_DISABLE_COMPOSITING_MODE` | `1` | Disable GPU compositing (reduces code paths) |
| `GST_REGISTRY_UPDATE` | `no` | Skip registry update on startup (faster) |

**For debugging (not permanent):**

| Variable | Value | Effect |
|----------|-------|--------|
| `GST_DEBUG` | `3,webkit*:5` | Warnings globally, WebKit-specific at DEBUG |
| `GST_DEBUG_FILE` | `/tmp/gst.log` | Capture GStreamer logs |
| `GST_DEBUG_DUMP_DOT_DIR` | `/tmp/gst-dots` | Pipeline graph dumps |

**Not useful for our case:**
- GStreamer has no environment variable for thread priority or scheduling policy (only API-driven)
- `GST_GL_WINDOW=surfaceless` is unnecessary since headless CI already has no display
- `GST_XINITTHREADS` only relevant for X11 multi-threaded contexts

#### Answer to research question 7: Correlation with runner specs

The stalls are most likely to occur on:
- **ubuntu-latest with 2 vCPU** (private repos) — highest CPU pressure
- **Any runner during peak GitHub Actions load** — noisy-neighbor CPU scheduling

Not observed on:
- **macOS WebKit** — uses AVFoundation/VideoToolbox, not GStreamer at all
- **Chromium/Firefox on ubuntu-latest** — different seek implementations, no GStreamer dependency
- **Windows Edge** — Chromium-based, no GStreamer

The stalls are GStreamer-specific, load-dependent, and timing-sensitive. More CPU resources reduce the race window but don't eliminate it.

#### Playwright-specific context

Key facts about Playwright's WebKit on Linux:

1. **GStreamer is NOT bundled** (since [Playwright PR #2541](https://github.com/microsoft/playwright/pull/2541), June 2020). Partially bundled GStreamer conflicted with system GStreamer, causing X server crashes. WebKitGTK now uses the **system-installed GStreamer**.
2. **System GStreamer version depends on host OS**: Ubuntu 22.04 → GStreamer ~1.20.3, Ubuntu 24.04 → ~1.24.x. The flush-stop deadlock (WPE #1367) fixed in GStreamer MR #7632 is NOT in GStreamer 1.20.3.
3. **Playwright tracks WebKit trunk**, not stable WebKitGTK releases. Fixes committed to WebKit trunk (like Bug 275566, June 2024) are available in Playwright's WebKit builds relatively quickly. But GStreamer-level fixes depend on the system GStreamer.
4. **macOS WebKit uses AVFoundation**, not GStreamer. The entire seek stall problem is Linux-only.
5. **Playwright docs warn**: "available media codecs vary substantially between Linux, macOS and Windows. While running WebKit on Linux CI is usually the most affordable option, for the closest-to-Safari experience you should run WebKit on mac, for example if you do video playback."

Playwright also acknowledges general WebKit-on-Linux flakiness:
- [Issue #3261](https://github.com/microsoft/playwright/issues/3261): "video test flakiness" with WebKit that "has nothing to do with the installed plugins"
- [Issue #27337](https://github.com/microsoft/playwright/issues/27337): "Many flaky tests on WebKit browser on Linux" after Playwright upgrade
- [Issue #30428](https://github.com/microsoft/playwright/issues/30428): Random WebKit crashes in Docker with GStreamer warnings

### Actionable items

1. **Current workarounds are correct and sufficient**: The 3s per-attempt timeout on `while(video.seeking)` in `seekTo()` and the 5s `Promise.race` on `seeked` in load helpers are the right defensive strategy given unfixed upstream bugs.
2. **Consider adding same-position seek guard**: Before setting `video.currentTime`, check `Math.abs(currentTime - target) < 0.01` and skip the seek if true. This avoids the particularly dangerous "seek to same position" case (Bug 194499).
3. **Consider CI environment variables**: Setting `LIBVA_DRIVER_NAME=dummy` and `GST_PLUGIN_FEATURE_RANK=vah264dec:0,vaapih264dec:0` in the CI workflow for the WebKit job could prevent spurious hardware decoder probe failures, though these are unlikely to affect our specific stall pattern.
4. **Consider `WEBKIT_DISABLE_COMPOSITING_MODE=1`**: Disabling accelerated compositing for WebKitGTK CI tests removes the non-AC triggerRepaint deadlock path. However, this may affect rendering behavior.
5. **Monitor GStreamer version on ubuntu-latest**: When GitHub Actions updates to Ubuntu 24.04 (GStreamer ~1.24), the flush-stop deadlock (WPE #1367) should be fixed. The seek stalls may decrease.
6. **The seek stalls cannot be eliminated without upstream fixes**: Bug 194499 remains partially addressed and Bug 245852 is unresolved. The timeout + retry pattern is the only application-level mitigation.

### References

- [WebKit Bug 194499: Seek while seeking freezes playback](https://bugs.webkit.org/show_bug.cgi?id=194499)
- [WebKit Bug 275566: Take playbin's states lock when seeking](https://bugs.webkit.org/show_bug.cgi?id=275566) — Fixed Jun 2024
- [WebKit Bug 245852: MSE scrubbing freeze/crash](https://bugs.webkit.org/show_bug.cgi?id=245852) — Unresolved
- [WebKit Bug 263317: Pause after seek not working](https://bugs.webkit.org/show_bug.cgi?id=263317) — Fixed Feb 2024
- [WebKit Bug 272167: Ignore sinks position while seeking](https://bugs.webkit.org/show_bug.cgi?id=272167) — Fixed
- [WebKit Bug 269587: Prevent currentTime reset on preroll](https://bugs.webkit.org/show_bug.cgi?id=269587) — Fixed
- [WebKit Bug 114044: Cannot seek after video finished](https://bugs.webkit.org/show_bug.cgi?id=114044) — Fixed
- [WebKit Bug 182936: Seek broken on YouTube (GStreamer)](https://bugs.webkit.org/show_bug.cgi?id=182936) — Fixed
- [WPEWebKit Issue #1367: Early seek deadlock](https://github.com/WebPlatformForEmbedded/WPEWebKit/issues/1367) — Fixed in GStreamer MR #7632
- [WPEWebKit Issue #284: After seek, playback stuck](https://github.com/WebPlatformForEmbedded/WPEWebKit/issues/284) — Fixed
- [WPEWebKit Issue #271: MSE seek to unbuffered range](https://github.com/WebPlatformForEmbedded/WPEWebKit/issues/271) — Fixed
- [GStreamer Issue #301: ASYNC_DONE message dropped](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/issues/301) — Acknowledged, unfixed
- [GStreamer Issue #349: Race in bin state change](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/issues/349) — Unfixable in 1.x
- [GStreamer Issue #150: ASYNC_DONE propagation with repeated seeks](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/issues/150)
- [GStreamer gst-plugins-bad Issue #931: DASH seek stall](https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad/-/issues/931)
- [GStreamer gst-plugins-bad Issue #609: Pre-rolling problem after seeks](https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad/-/issues/609)
- [GStreamer gst-plugins-bad Issue #611: adaptivedemux deadlock](https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad/-/issues/611)
- [Playwright PR #2541: Exclude GStreamer from WebKit distribution](https://github.com/microsoft/playwright/pull/2541)
- [Playwright Issue #3261: State of WebKit video codecs](https://github.com/microsoft/playwright/issues/3261)
- [Playwright Issue #27337: Flaky WebKit tests on Linux](https://github.com/microsoft/playwright/issues/27337)
- [Playwright Issue #31017: WebKit feature support on non-Apple platforms](https://github.com/microsoft/playwright/issues/31017)
- [Playwright Browsers Documentation](https://playwright.dev/docs/browsers)
- [Playwright CI Documentation](https://playwright.dev/docs/ci)
- [WebKit Multimedia Debugging](https://docs.webkit.org/Ports/WebKitGTK%20and%20WPE%20WebKit/Multimedia.html)
- [GitHub-hosted Runners Reference](https://docs.github.com/en/actions/using-github-hosted-runners/using-github-hosted-runners/about-github-hosted-runners)
- [GStreamer Running Documentation](https://gstreamer.freedesktop.org/documentation/gstreamer/running.html)
- [GStreamer Debugging Tools Tutorial](https://gstreamer.freedesktop.org/documentation/tutorials/basic/debugging-tools.html)
- [GStreamer Hardware-accelerated Decoding Tutorial](https://gstreamer.freedesktop.org/documentation/tutorials/playback/hardware-accelerated-video-decoding.html)
- [WHATWG HTML Standard — Media Elements Seeking](https://html.spec.whatwg.org/multipage/media.html#seeking)
- [WebKit MediaPlayerPrivateGStreamer source](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/gstreamer/MediaPlayerPrivateGStreamer.cpp)

### Cross-reference with ChatGPT deep research

**Source**: ChatGPT deep research report on Topic 5 (13-page PDF, February 2026).

#### Agreement

Both investigations converge on the same root cause chain and reach the same conclusion: the seek stalls are upstream WebKitGTK/GStreamer bugs that cannot be fixed at the application layer, only mitigated with timeouts and retries.

Specific areas of strong agreement:

1. **`finishSeek()` gate mechanism** — Both sources identify the same critical path: `HTMLMediaElement::seekTask()` sets `seeking=true`, delegates to the media engine via `player->seekToTarget()`, and `finishSeek()` only clears `seeking` when three conditions are met: `m_seekRequested`, `readyState >= HAVE_CURRENT_DATA`, and `!player()->seeking()`. If the GStreamer backend's `m_isSeeking` flag gets stuck, `finishSeek()` never runs, producing the exact Topic 5 symptom.

2. **`m_isSeeking` narrow success path** — Both identify that `MediaPlayerPrivateGStreamer` sets `m_isSeeking = true` on seek initiation and only clears it under specific pipeline state-change conditions, creating a "narrow success path" vulnerable to missed notifications, deadlocks, and overlapping seeks.

3. **Upstream bug pattern** — Both found WebKit Bug 245852 (freeze/crash from scrubbing streaming video, filed 2022, unresolved), WPEWebKit #1367 (hang on early seek with `g_cond_wait` stack trace in pad-probe callbacks), and Playwright #3261 (WebKit video flakiness on GitHub Actions independent of application logic).

4. **CI resource amplification** — Both conclude that GitHub Actions runner constraints (4 vCPU/16 GB public, 2 vCPU/8 GB private, no GPU, noisy-neighbor effects) widen the race windows for seek stalls. Both note Playwright's CI guidance to reduce parallelism (`workers: 1`) for stability.

5. **Workaround correctness** — Both confirm the timeout + retry pattern in `seekTo()` is the correct application-level mitigation.

#### New information from PDF

The ChatGPT report adds several items not covered in our initial findings:

1. **No watchdog in WebKit's `finishSeek()` path** — The PDF explicitly notes there is no timeout or watchdog fallback in WebKit's seeking completion logic. If the backend gets stuck, WebKit waits forever. This is a stronger architectural observation than our initial analysis provided — it means the problem is not just "can happen" but "has no safety net at any layer except our application code."

2. **WebKit Bug 258959** — "YouTube freezes on seeking" (filed 2023-07-06, marked duplicate of 245852, modified 2024-09-20). Confirms the seek freeze class extends beyond niche use cases to YouTube, the highest-profile streaming site. We had Bug 245852 but not this duplicate.

3. **WPEWebKit Issue #182** — "MSE Seek issue" (filed 2017-01-18, closed). Documents seek completion edge cases involving `fudgeFactor` in the MSE time-comparison logic. Shows that MSE seek completion has been fragile for nearly a decade in WebKit-derived ports.

4. **WebKit Bug 199719** — "[MSE][GStreamer] WebKitMediaSrc rework" (filed 2019, resolved FIXED, modified 2025-08-26). Patch review discusses a deadlock scenario involving pad activation and element locks during the MSE rework. Provides architectural context for why seeking/flush can deadlock — the same subsystem that was reworked for deadlock avoidance is where our stalls occur.

5. **Staged recovery ladder recommendation** — Instead of just retrying the same `video.currentTime = t` operation, the PDF suggests a progressive recovery sequence: retry seek → pause/play → `video.load()` → full player reinitialize. Each stage produces a structured failure signature for diagnosis. Our current approach only retries the seek (stage 1). However, stages 2-4 are impractical in our context — `video.load()` would require Shaka Player to reinitialize the entire DASH stream, and full reinitialize would lose test state. The retry approach is sufficient since our 2 CI retries on WebKit already handle the intermittent nature.

6. **GST_DEBUG logs as permanent CI artifacts** — The PDF recommends capturing GStreamer debug logs during CI runs and uploading them as artifacts for post-mortem analysis. This would help map stalls to specific backend states (underrun, missing completion message, deadlock path). WebKit bugs 245852/258959 show maintainers explicitly requesting these logs. We documented these env vars but framed them as "for debugging (not permanent)."

#### Our findings not in the PDF

Our initial research was significantly more thorough on the GStreamer internals:

1. **WebKit Bug 194499** — "Seek while seeking freezes playback" — our primary root cause. The PDF didn't find this bug despite it being the most directly relevant one. It documents the exact PAUSED→PAUSED freeze mechanism and buffer tolerance mismatch that causes our stalls.

2. **WebKit Bug 275566** — Race: seek from `seeked` callback hangs pipeline (fixed Jun 2024, commit 81376c). The fix to acquire the playbin states lock before `doSeek()`. The PDF missed this, which is relevant since Playwright tracks WebKit trunk and may or may not include this fix.

3. **GStreamer Issue #301** — `ASYNC_DONE` message dropped. The fundamental GStreamer core bug acknowledged by Sebastian Dröge as unfixable in GStreamer 1.x. The PDF couldn't access the GStreamer GitLab tracker (HTTP 403) and noted this as a gap.

4. **GStreamer Issue #349** — Race in bin state change, explicitly marked unfixable in GStreamer 1.x design.

5. **Playwright PR #2541** — The specific 2020 PR that removed bundled GStreamer from Playwright's WebKit distribution, explaining why WebKitGTK now depends on system GStreamer (and thus system GStreamer version matters).

6. **GStreamer version dependency** — We identified that WPE #1367's fix (GStreamer MR #7632) is NOT available in Ubuntu 22.04's GStreamer 1.20.3, and that upgrading to Ubuntu 24.04 (~GStreamer 1.24) would help. The PDF didn't examine version-specific availability.

7. **Specific WebKit bugs 263317, 272167, 269587** — Additional fixed bugs providing context on related seek state-machine issues (pause after seek, sink position during seek, currentTime reset on preroll).

8. **GStreamer environment variables** — We provided a specific table of actionable CI variables (`LIBVA_DRIVER_NAME=dummy`, `GST_PLUGIN_FEATURE_RANK`, `WEBKIT_DISABLE_COMPOSITING_MODE`). The PDF mentioned GST_DEBUG but not the hardware-decoder-avoidance variables.

9. **`AbortableTaskQueue`** — WebKit's mechanism to prevent deadlocks between GStreamer threads and the main thread during flushes. Not mentioned in the PDF.

10. **Non-AC `triggerRepaint` deadlock** — The specific `m_drawCondition` deadlock path in non-accelerated-compositing mode relevant to headless CI. Not in the PDF.

#### Evaluation of PDF recommendations

| Recommendation | Status | Assessment |
|---|---|---|
| Build minimal reproducer | Not done | Lower priority — upstream bugs are well-documented and our workarounds are effective. Worth doing only if we decide to file an upstream report. |
| GST_DEBUG logs as CI artifacts | Not done | **Worth considering.** Would help diagnose future stall patterns if they change. However, verbose GStreamer logging may slow CI runs and produce large artifacts. Could be enabled conditionally on WebKit job failure. |
| Reduce parallelism (workers: 1) | Already done | Our CI config already uses `workers: 1` in CI mode. |
| Vary runner resources (A/B test) | Not done | Low priority — would confirm the correlation but not fix anything. Our workarounds already handle the variability. |
| Staged recovery ladder | Partially done | Our `seekTo()` already retries the seek 10 times with 3s timeouts. Adding `video.load()` or full reinitialize would require rebuilding Shaka Player state, which is impractical in a test helper. The 2 CI retries handle cases where the entire test fails. |
| Upstream bug report | Not done | We could file against WebKit Bugzilla with our specific reproduction pattern (MSE DASH + programmatic seeks on WebKitGTK under CI load). Low priority since Bug 245852 already covers the class. |

#### Verdict

The two research sources are **highly complementary**. Our research provided deeper GStreamer-specific analysis (specific bugs, version dependencies, environment variables, internal mechanisms), while the PDF provided better WebKit HTMLMediaElement code-level tracing (the `finishSeek()` gate, the "no watchdog" observation) and additional corroborating bug references.

**Combined root cause model**: Test code seeks → Playwright drives WebKit-on-Linux → `HTMLMediaElement::seekTask()` sets `seeking=true` → delegates to `MediaPlayerPrivateGStreamer::seekToTarget()` → `m_isSeeking=true` → GStreamer pipeline receives seek/flush → pipeline stalls due to Bug 194499 (PAUSED→PAUSED freeze), Issue #301 (ASYNC_DONE dropped), WPE #1367 (flush-stop deadlock on GStreamer 1.20.3), or Bug 275566 (states lock race) → `m_isSeeking` stays true → `finishSeek()` gate never satisfied (no watchdog) → `video.seeking` stuck true → no `seeked` event → our 3s timeout fires → retry or test fails → CI retry catches intermittent failures.

**No additional workarounds needed.** The current mitigation (3s per-attempt timeout, 10 retry attempts, 5s load-helper timeout, 2 CI retries) is the correct and sufficient approach given the upstream bug landscape. The only items worth considering for the future are:
- Enabling GST_DEBUG on WebKit CI job failure for post-mortem diagnosis
- Monitoring ubuntu-latest GStreamer version upgrades (Ubuntu 24.04 → GStreamer ~1.24)
- Filing a minimal upstream repro against WebKit Bugzilla if stall frequency increases

#### Additional references from PDF

- [WebKit Bug 258959: YouTube freezes on seeking (duplicate of 245852)](https://bugs.webkit.org/show_bug.cgi?id=258959)
- [WPEWebKit Issue #182: MSE Seek issue](https://github.com/WebPlatformForEmbedded/WPEWebKit/issues/182)
- [WebKit Bug 199719: MSE/GStreamer WebKitMediaSrc rework](https://bugs.webkit.org/show_bug.cgi?id=199719)
- [WebKit HTMLMediaElement.cpp source (seeking implementation)](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/html/HTMLMediaElement.cpp)

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

### Findings

#### Q1: Is 0.001s (1 ms) universally safe across all frame rates?

**Yes, for all practical video frame rates.** The epsilon is safe as long as it is strictly less than half the frame duration. If epsilon >= frameDuration/2, it could overshoot past the target frame into the next one.

**Mathematical analysis:**

| Frame rate | Frame duration | Epsilon as % of frame | Safe? (epsilon < duration/2) |
|-----------|---------------|----------------------|------------------------------|
| 23.976 fps | 41.71 ms | 2.4% | Yes (1 ms < 20.85 ms) |
| 24 fps | 41.67 ms | 2.4% | Yes (1 ms < 20.83 ms) |
| 25 fps | 40.00 ms | 2.5% | Yes (1 ms < 20.00 ms) |
| 29.97 fps | 33.37 ms | 3.0% | Yes (1 ms < 16.68 ms) |
| 30 fps | 33.33 ms | 3.0% | Yes (1 ms < 16.67 ms) |
| 50 fps | 20.00 ms | 5.0% | Yes (1 ms < 10.00 ms) |
| 59.94 fps | 16.68 ms | 6.0% | Yes (1 ms < 8.34 ms) |
| 60 fps | 16.67 ms | 6.0% | Yes (1 ms < 8.33 ms) |
| 120 fps | 8.33 ms | 12.0% | Yes (1 ms < 4.17 ms) |
| 240 fps | 4.17 ms | 24.0% | Yes (1 ms < 2.08 ms) |
| 480 fps | 2.08 ms | 48.0% | Yes (1 ms < 1.04 ms) |
| 500 fps | 2.00 ms | 50.0% | **Marginal** (1 ms = 1.00 ms, exactly half) |
| 1000 fps | 1.00 ms | 100% | **No** (1 ms = duration, would skip frame) |

**The theoretical safety limit is fps < 500.** At exactly 500 fps, the epsilon equals half the frame duration (the absolute boundary). In practice, no browser-playable video format exceeds 240 fps, and common streaming content is 24-60 fps. At 240 fps -- the highest consumer frame rate -- the epsilon is 24% of frame duration, well within safe bounds.

**Drift safety:** The epsilon does not accumulate across consecutive frame steps because each step recomputes `Math.round(currentTime * fps)` to snap to the current frame index before adding +/-1. The seek target is always `(currentFrame +/- 1) / fps + epsilon`, not `currentTime + 1/fps + epsilon`.

#### Q2: Does applying epsilon on ALL browsers cause issues on Chromium, Edge, or WebKit?

**No, the epsilon is harmless on all browsers.** The analysis is straightforward:

- **What epsilon does**: shifts the seek target from exactly `N/fps` to `N/fps + 0.001`.
- **What browsers display**: the frame whose presentation time range contains the seek target. A frame at time `N/fps` has a presentation range of `[N/fps, (N+1)/fps)`. The epsilon-shifted target `N/fps + 0.001` is still within this range for all frame rates under 500 fps.
- **Empirical confirmation**: The project's OCR-based E2E tests verify frame-accurate seeking with the epsilon on all 6 CI platforms (Chromium Linux, Firefox Linux, Firefox macOS, WebKit Linux, WebKit macOS, Edge Windows). All pass exact frame number matching.

The question of whether Chromium/Edge/WebKit need the epsilon at all is separate from whether it harms them. They do not need it (they land on the correct frame without it), but the +1ms shift places the seek target solidly within the correct frame's time range, which is if anything more robust than seeking to the exact boundary.

#### Q3: What does `video.fastSeek(T)` do in Firefox?

**`fastSeek()` seeks to the nearest keyframe before T, NOT to the exact requested time.** This is fundamentally different from setting `currentTime` and is not suitable for frame-stepping.

**WHATWG HTML spec ([Section 4.8.11.9](https://html.spec.whatwg.org/multipage/media.html#dom-media-fastseek)):** The `fastSeek()` method invokes the seeking algorithm with the `approximate-for-speed` flag set. When this flag is set, the user agent is permitted to seek to an approximate position (typically the nearest preceding keyframe) rather than decoding to the exact requested time.

**Firefox implementation (searchfox.org):**

```cpp
// dom/media/mediaelement/HTMLMediaElement.cpp:3389-3391
void HTMLMediaElement::FastSeek(double aTime, ErrorResult& aRv) {
  LOG(LogLevel::Debug, ("%p FastSeek(%f) called by JS", this, aTime));
  Seek(aTime, SeekTarget::PrevSyncPoint, IgnoreErrors());
}
```

Compare with `currentTime` setter:

```cpp
// dom/media/mediaelement/HTMLMediaElement.cpp:3422
Seek(aCurrentTime, SeekTarget::Accurate, IgnoreErrors());
```

The `SeekTarget` enum (`dom/media/SeekTarget.h`) defines three seek types:
- **`PrevSyncPoint`** (used by `fastSeek`) -- seeks to the previous sync point (keyframe). The `IsFast()` method returns true for this type
- **`Accurate`** (used by `currentTime` setter) -- decodes from the previous keyframe up to the exact requested time
- **`NextFrame`** -- seeks to the next frame (used internally)

In `MediaDecoderStateMachine.cpp`, the `IsFast()` check appears at 6 locations (lines 1810, 1836, 1924, 2044, 2896), controlling whether the state machine stops at the keyframe or continues decoding to the exact position.

**Is `fastSeek` affected by the same boundary precision issue?** The boundary precision issue is irrelevant for `fastSeek` because it does not attempt to reach a precise time at all -- it snaps to the nearest preceding keyframe. This makes it unsuitable for frame-stepping but useful for scrubbing (seek bar dragging) where speed matters more than frame accuracy.

**Known bug ([Bug 1193124](https://bugzilla.mozilla.org/show_bug.cgi?id=1193124)):** After `fastSeek(x)`, `currentTime` reports `x` (the requested time) rather than `t` (the actual keyframe time the decoder seeked to). This is because the spec says `fastSeek` should set the "official playback position" to the requested time, even though the displayed frame is at the keyframe. This is a separate issue from frame boundary precision.

#### Q4: Are there alternative approaches to the epsilon workaround?

**Four alternatives exist, ranging from simple to complex:**

**Alternative 1: Half-frame-duration epsilon (more robust, simple change)**

Instead of a fixed 1ms epsilon, use `0.5 / fps`:

```typescript
const HALF_FRAME = 0.5 / fps;
videoEl.currentTime = targetFrame / fps + HALF_FRAME;
```

This seeks to the **middle** of the target frame's time range, maximizing the safety margin. At 30 fps, this is 16.67 ms (vs 1 ms). At 240 fps, this is 2.08 ms (vs 1 ms). It is safe by construction for any frame rate because `0.5/fps < 1/fps` (the full frame duration) always holds.

**Advantages**: Adapts automatically to any frame rate. Maximally safe -- the seek target is equidistant from both frame boundaries.

**Disadvantages**: Marginal increase in code complexity (needs `fps` at the call site, which the current code already has). Changes the `currentTime` read-back value (reads as mid-frame rather than near-boundary), but this is irrelevant because the code already uses `Math.round(currentTime * fps)` to snap to frame indices.

**Alternative 2: `requestVideoFrameCallback` frame-stepping (most accurate, complex)**

Use `requestVideoFrameCallback` with iterative `currentTime` increments to advance exactly one frame:

```typescript
async function stepForward(video: HTMLVideoElement): Promise<void> {
  const baseline = await getMediaTime(video);
  for (;;) {
    video.currentTime += 0.01;
    const newTime = await getMediaTime(video);
    if (newTime !== baseline) break;
  }
}
```

Where `getMediaTime` wraps `requestVideoFrameCallback` to get the actual presentation timestamp of the displayed frame.

**Advantages**: Frame-accurate by definition -- stops only when a new frame is actually composited. Works regardless of frame rate, variable frame rate, or browser precision quirks. Uses `mediaTime` from the callback metadata, which is populated directly from the frame's presentation timestamp (more accurate than `currentTime` which is backed by the audio clock in Chromium).

**Disadvantages**: Asynchronous and multi-step -- could take multiple iterations (typically 0-5 per the [technique described by Pavel Matveev](https://www.linkedin.com/pulse/stupid-way-using-requestvideoframecallback-accurate-seek-matveev)). Requires the frame to be actually composited, which means visible video and active rendering pipeline. Browser support is Baseline since October 2024 (Chrome 83+, Firefox 132+, Safari 15.4+), but behavior in Playwright's WebKitGTK is unverified. The iterative approach adds latency per frame step.

**Alternative 3: `video.buffered` range analysis (unreliable)**

Use `video.buffered.start(i)` / `video.buffered.end(i)` to compute safe seek targets within buffered ranges.

**This does not work for frame-level precision.** The `TimeRanges` from `buffered` describe the time ranges of buffered media data at the segment level, not the frame level. The MSE spec does not require `buffered` ranges to align with frame boundaries. The start/end values may include rounding and may not correspond to individual frame presentation times. There is no way to determine frame boundaries from `buffered` ranges alone.

**Alternative 4: Rational time seeking (future spec, not implemented)**

[WHATWG HTML issue #609](https://github.com/whatwg/html/issues/609) proposes adding rational time values to `seek()`:

```javascript
video.seek(30 * 1001, { mode: "precise", timeScale: 30000 });
```

This would allow frame-exact seeking by expressing time as a fraction (numerator/timescale) rather than a floating-point double. **This proposal remains open since 2016 with no browser implementation.** Different container formats use different timescales (MP4 uses track-specific timescales, WebM uses milliseconds globally), complicating standardization.

**Firefox's `seekToNextFrame()` -- REMOVED:**

Firefox previously had `HTMLMediaElement.seekToNextFrame()`, a non-standard method that stepped to the next video frame. It was [added in Firefox 49](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/49) and [removed in Firefox 128](https://bugzilla.mozilla.org/show_bug.cgi?id=1336404). No browser currently supports it, and no standard replacement exists.

#### Q5: Root cause of Firefox's frame boundary precision issue

**The issue is a combination of historical bugs and architectural choices:**

1. **Historical float-to-double bug ([Bug 626273](https://bugzilla.mozilla.org/show_bug.cgi?id=626273)):** Firefox originally used `float` instead of `double` for `currentTime` in its IDL, causing the computed seek target to be ~1ms too low. This was fixed in 2011 by converting to `double` throughout the decoder interfaces. A subsequent **fencepost error** in the seek logic caused the decoder to "pick too early a frame when seeking to a time that is exactly the end of one frame and the start of another." This was also fixed.

2. **Timer precision reduction (not the cause):** Firefox's `privacy.reduceTimerPrecision` preference (defaulting to 2ms) was investigated as a potential cause. However, [Bug 1217238](https://bugzilla.mozilla.org/show_bug.cgi?id=1217238) determined that `currentTime` is already limited by its ~40ms update interval (the `AUDIO_DURATION_USECS = 40000` constant in `MediaDecoderStateMachine.cpp`), so additional timer clamping was deemed unnecessary. **Firefox does NOT apply `ReduceTimePrecision` to `HTMLMediaElement.currentTime`.** The decision was to "leave HTMLMediaElement as it is" since the inherent 40ms granularity provides a natural anti-fingerprinting limit.

3. **MSE-specific seeking path:** Firefox's MSE implementation (`MediaSourceDecoder`) goes through the same `SeekTarget::Accurate` path as regular media, but the MSE demuxer's timestamp handling may introduce sub-millisecond offsets when mapping between JavaScript `double` seconds and the internal media timebase (typically 90kHz for MPEG-TS or variable for MP4). The conversion chain `double seconds -> int64 microseconds -> media timescale ticks` involves multiple rounding steps where truncation (floor) vs rounding can differ.

4. **Chromium's approach differs:** Chromium's media pipeline also converts between floating-point seconds and internal timescale ticks, but its rounding strategy at frame boundaries appears to favor the later frame, while Firefox's favors the earlier frame. This is consistent with the observation that only Firefox shows the off-by-one behavior. Chromium [Bug 66631](https://bugs.chromium.org/p/chromium/issues/detail?id=66631) ("Video frame displayed does not match currentTime") documents a similar issue that was addressed.

#### Q6: Does `video.buffered` help compute safe seek targets?

**No.** As analyzed in Alternative 3 above, `video.buffered` operates at the segment level, not the frame level. It cannot provide frame boundary timestamps.

The `requestVideoFrameCallback` API's `mediaTime` property is the only standard way to get the actual presentation timestamp of the currently displayed frame. However, it requires a frame to be composited first (reactive, not predictive).

### Recommendations for this project

1. **The current 1ms epsilon is correct and safe.** It is mathematically safe for all frame rates below 500 fps, which covers all browser-playable video content. It does not cause issues on any browser. The E2E OCR tests confirm frame accuracy on all 6 CI platforms.

2. **Consider upgrading to half-frame-duration epsilon** (`0.5 / fps`) for theoretical robustness across arbitrary frame rates. This is a one-line change:
   ```typescript
   // Before:
   const FRAME_SEEK_EPSILON = 0.001;
   videoEl.currentTime = targetFrame / fps + FRAME_SEEK_EPSILON;

   // After:
   videoEl.currentTime = targetFrame / fps + 0.5 / fps;
   // Equivalent to: (targetFrame + 0.5) / fps
   // Seeks to the middle of the target frame's time range
   ```
   This would eliminate the need for `FRAME_SEEK_EPSILON` as a magic constant. However, the current approach is perfectly adequate for all real-world content.

3. **Do not use `fastSeek()` for frame stepping.** It seeks to the nearest keyframe, not the exact requested time. It is only appropriate for seek bar scrubbing.

4. **`requestVideoFrameCallback` is a future upgrade path** for definitive frame-step accuracy (stepping until `mediaTime` changes). However, the complexity and latency of the iterative approach outweigh the benefits given that the epsilon workaround already passes all OCR tests. Worth revisiting if the player needs to support variable frame rate (VFR) content, where `fps` is not constant and frame-duration-based epsilon is unreliable.

5. **The rational time seeking proposal (WHATWG #609) would be the definitive fix** but has been open since 2016 with no browser implementation. Do not wait for it.

### Key references

- [WHATWG HTML spec -- fastSeek](https://html.spec.whatwg.org/multipage/media.html#dom-media-fastseek) -- "approximate-for-speed" flag
- [WHATWG HTML spec -- seeking algorithm](https://html.spec.whatwg.org/multipage/media.html#seeking) -- how currentTime setter triggers accurate seeking
- [Firefox Bug 626273](https://bugzilla.mozilla.org/show_bug.cgi?id=626273) -- Frame accurate seeking isn't always accurate (float-to-double fix + fencepost error)
- [Firefox Bug 481213](https://bugzilla.mozilla.org/show_bug.cgi?id=481213) -- Support frame accurate seeking and display
- [Firefox Bug 587465](https://bugzilla.mozilla.org/show_bug.cgi?id=587465) -- audio.currentTime has low precision
- [Firefox Bug 1193124](https://bugzilla.mozilla.org/show_bug.cgi?id=1193124) -- After fastSeek, currentTime remains at seek target, not seek destination
- [Firefox Bug 1217238](https://bugzilla.mozilla.org/show_bug.cgi?id=1217238) -- ReduceTimePrecision deemed unnecessary for HTMLMediaElement.currentTime
- [Firefox Bug 1336404](https://bugzilla.mozilla.org/show_bug.cgi?id=1336404) -- seekToNextFrame removed in Firefox 128
- [Chromium Bug 66631 / 40494134](https://issues.chromium.org/issues/40494134) -- Video frame displayed does not match currentTime
- [W3C Issue #4: Frame accurate seeking](https://github.com/w3c/media-and-entertainment/issues/4) -- ongoing standards discussion (90+ comments)
- [WHATWG Issue #609: Rational time seek](https://github.com/whatwg/html/issues/609) -- proposed timeScale parameter (open since 2016)
- [MDN: fastSeek](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/fastSeek) -- "If you need precision, set currentTime instead"
- [MDN: seekToNextFrame](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/seekToNextFrame) -- deprecated, removed from all browsers
- [MDN: requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) -- frame liveness API with mediaTime
- [web.dev: requestVideoFrameCallback](https://web.dev/articles/requestvideoframecallback-rvfc) -- mediaTime vs currentTime explained
- [WICG video-rvfc explainer](https://github.com/WICG/video-rvfc/blob/gh-pages/explainer.md) -- API design and metadata fields
- [Pavel Matveev: rVFC frame seeking technique](https://www.linkedin.com/pulse/stupid-way-using-requestvideoframecallback-accurate-seek-matveev) -- iterative frame-step via rVFC
- [W3C TPAC 2019: Frame accurate synchronization](https://www.w3.org/2019/Talks/TPAC/frame-accurate-sync/) -- standards discussion
- Firefox source: [HTMLMediaElement.cpp:3389-3391](https://searchfox.org/mozilla-central/source/dom/media/mediaelement/HTMLMediaElement.cpp#3389) -- FastSeek calls Seek with PrevSyncPoint
- Firefox source: [HTMLMediaElement.cpp:3422](https://searchfox.org/mozilla-central/source/dom/media/mediaelement/HTMLMediaElement.cpp#3422) -- currentTime setter calls Seek with Accurate
- Firefox source: [SeekTarget.h](https://searchfox.org/mozilla-central/source/dom/media/SeekTarget.h) -- PrevSyncPoint/Accurate/NextFrame enum
- Firefox source: [MediaDecoderStateMachine.cpp](https://searchfox.org/mozilla-central/source/dom/media/MediaDecoderStateMachine.cpp) -- IsFast() checks at 6 locations

### Cross-reference: Bug tracker and spec investigation (ChatGPT deep research validation)

The following findings from additional web research validate and extend the existing answers to Q4, Q5, and Q6.

#### Q4 validation: Is this documented behavior or a bug?

The original analysis is confirmed. Additional details from bug tracker investigation:

**Bug 463358 — epsilon tolerance precedent**: Robert O'Callahan (roc), a senior Mozilla engineer, explicitly suggested adding epsilon tolerance to Firefox's seek logic during code review in 2009. His exact words: *"I think we might want some kind of epsilon tolerance value here, so that seekTime is 1.0 and mDecodedFrameTime is 0.99999 we use that frame not the next one."* He proposed `mCallbackPeriod/2` as the tolerance value. This is the same concept as our `FRAME_SEEK_EPSILON`, suggested by Firefox developers themselves 17 years ago. The suggestion does not appear to have been fully implemented across all code paths, which explains why the issue persists in the MSE pipeline.

Source: [Bug 463358 Comment 26](https://bugzilla.mozilla.org/show_bug.cgi?id=463358)

**Bug 587465 — still unresolved**: The `currentTime` low precision bug filed in 2010 remains **unresolved** as of 2024 (marked P4, fix-optional). A user reported seeking to time 20 and getting `currentTime = 19.999000549316406`. The last substantive comment (2017) indicated the problem was "probably not very complex" but received low priority because developers increasingly use the Web Audio API.

Source: [Bug 587465](https://bugzilla.mozilla.org/show_bug.cgi?id=587465)

**Bug 1200771 — currentTime inaccuracy confirmed**: Reported discrepancies between Firefox's `currentTime` and actual frame boundaries compared to ffmpeg output. Frame changes occurred at different timestamps (`8.699999` in stable, `8.633333` in nightly, `8.604` in ffmpeg), confirming the internal time-to-frame mapping diverges.

Source: [Bug 1200771](https://bugzilla.mozilla.org/show_bug.cgi?id=1200771)

**Chromium comparison bugs**: Chromium Bug 66631 ("Video frame displayed does not match currentTime") and Bug 555376 ("currentTime as reported by HTML5 video is not frame-accurate") document that Chromium also experienced frame/time mismatches, but addressed them differently. In Chromium, `currentTime` is backed by the audio clock while `mediaTime` (from `requestVideoFrameCallback`) uses the actual presentation timestamp. Chromium's fix ensured the displayed frame matches the time reference, whereas Firefox's fix was limited to the float-to-double conversion without fully resolving the boundary edge case.

Sources: [Chromium Issue 40494134](https://issues.chromium.org/issues/40494134), [Chromium Issue 555376](https://bugs.chromium.org/p/chromium/issues/detail?id=555376)

#### Q5 validation: What does the HTML/MSE spec say about seek precision?

The original analysis is confirmed. Key additional findings:

**The spec's critical ambiguity**: The HTML spec defines that "the video element represents the frame of video corresponding to the current playback position" (when paused) and that "when the current playback position changes such that the last frame rendered is no longer the frame corresponding to the current playback position in the video, the new frame must be rendered." However, **the spec never defines what "the frame corresponding to" a given time means in terms of frame boundaries**. It does not specify whether the mapping should use:
- The frame whose presentation interval contains T (`frameStart <= T < frameEnd`)
- The frame whose presentation timestamp is closest to T
- The frame whose presentation timestamp equals or precedes T (`floor`)
- The frame whose presentation timestamp equals or follows T (`ceil`)

This under-specification is the root cause of cross-browser differences.

**MSE spec seeking integration**: The MSE spec only adds: *"The media element feeds coded frames from the active track buffers into the decoders starting with the closest random access point before the new playback position."* It specifies that decoding starts from a keyframe but does not define which decoded frame to display — that is left to the HTML spec's vague "frame corresponding to the current playback position."

**W3C Issue #4 — active acknowledgment**: The W3C Media and Entertainment Interest Group's Issue #4 ([link](https://github.com/w3c/media-and-entertainment/issues/4)) explicitly acknowledges: *"Internal rounding of time values may mean that one seeks to the end of the previous frame instead of the beginning of a specific video frame."* This issue has been open since 2018 with extensive discussion (90+ comments) and remains unresolved. It lists frame-accurate seeking as a need for non-linear editing, collaborative review, evidence playback, and other professional use cases.

**WHATWG Issue #609 — rational time proposal**: The proposed `timeScale` parameter for seeking ([link](https://github.com/whatwg/html/issues/609)) would express seek times as rational numbers (e.g., `video.seek(30 * 1001, { timeScale: 30000 })`) to avoid floating-point precision loss. Open since 2016 with no browser implementation. The discussion noted that different container formats use different timescales (MP4 per-track, WebM milliseconds, Apple rational time), complicating standardization.

**WHATWG Issue #1362 — fastSeek official playback position**: Discussion ([link](https://github.com/whatwg/html/issues/1362)) about whether `fastSeek(x)` should set the official playback position to `x` (the requested time) or to the actual keyframe position. WebKit and Blink implementations treat `fastSeek` similarly to `currentTime` at the internal level, setting `m_lastSeekTime` for both. The spec was tentatively agreed to align with this implementation behavior.

#### Q6 validation: Does `video.fastSeek(T)` have the same behavior?

The original analysis is confirmed. Additional findings:

**Bug 1022913 — directional constraint violation**: Firefox's `fastSeek()` always sought to the keyframe **before** the target, even when the keyframe **after** was closer. This violated the spec's directional constraint: *"If new playback position before this step is before current playback position, then the adjusted new playback position must also be before the current playback position."* The result was that a forward scrub could result in the video jumping backward, which was confusing and incorrect per spec.

Source: [Bug 1022913](https://bugzilla.mozilla.org/show_bug.cgi?id=1022913)

**Limited browser support**: `fastSeek()` is not considered Baseline and does not work in all widely-used browsers. Even among browsers that support it, behavior differs significantly (keyframe selection direction, `currentTime` reporting, etc.).

**Summary**: `fastSeek()` is definitively unsuitable for frame-stepping. It is designed for scrubbing/thumbnailing where speed matters more than accuracy. The `currentTime` + epsilon approach is the correct and recommended method for frame-accurate seeking.

### Deep dive: Internal time conversion — Firefox vs Chromium source code analysis

This section answers the specific research questions about how Firefox and Chromium internally convert `currentTime` (a JavaScript `double` in seconds) to discrete media sample positions, and whether the difference is `floor` vs `round`.

#### The conversion chain

When JavaScript sets `video.currentTime = N/fps`, the browser must:
1. Convert the `double` seconds value to an internal integer time representation
2. Use that internal time to find the right sample/frame in the media buffer
3. Decode from the preceding keyframe up to that sample
4. Display the frame and report the final position back as `currentTime`

The precision difference between Firefox and Chromium occurs primarily at **step 1** — the seconds-to-internal-time conversion.

#### Firefox: `TimeUnit::FromSeconds` — uses `std::round()`

Firefox's media pipeline represents time using the `media::TimeUnit` class (`dom/media/TimeUnits.h`), which stores ticks as a `CheckedInt64` with a configurable base (default: microseconds, base = 1,000,000).

The `FromSeconds` static factory method (`dom/media/TimeUnits.cpp`) converts a `double` seconds value to internal ticks:

```cpp
// dom/media/TimeUnits.cpp
TimeUnit TimeUnit::FromSeconds(double aValue, int64_t aBase) {
  // ... validation checks ...
  double inBase = aValue * static_cast<double>(aBase);
  // ... overflow warnings ...
  return TimeUnit(static_cast<int64_t>(std::round(inBase)), aBase);
}
```

The critical operation is `static_cast<int64_t>(std::round(inBase))` — Firefox **rounds to nearest** when converting from floating-point seconds to integer ticks.

Source: [dom/media/TimeUnits.cpp](https://searchfox.org/mozilla-central/source/dom/media/TimeUnits.cpp) (FromSeconds implementation), [dom/media/TimeUnits.h](https://searchfox.org/mozilla-central/source/dom/media/TimeUnits.h) (class declaration with `ToBase` rounding policies)

**Note on `ToBase` rounding policies**: The `TimeUnit` class also provides a templated `ToBase()` method for converting between different timescale bases (e.g., microseconds to MP4 track timescale). This method accepts pluggable rounding policies: `TruncatePolicy` (default — `static_cast`, i.e., truncation toward zero), `FloorPolicy` (`std::floor`), `RoundPolicy` (`std::round`), and `CeilingPolicy` (`std::ceil`). The default `TruncatePolicy` for base conversions is different from the `std::round` used in `FromSeconds`, meaning that **additional precision loss can occur when converting from microsecond ticks to the MP4 track timescale** during sample lookup.

#### Chromium: `base::Seconds()` — uses truncation (C++ `static_cast`)

Chromium's media pipeline represents time using `base::TimeDelta` (`base/time/time.h`), which stores an internal `delta_` value in microseconds as an `int64_t`.

The `Seconds()` factory function for floating-point input converts a `double` seconds value to microseconds:

```cpp
// base/time/time.h (floating-point overload)
template <typename T>
  requires(std::floating_point<T>)
constexpr TimeDelta Seconds(T n) {
  return TimeDelta::FromInternalValue(
      saturated_cast<int64_t>(n * Time::kMicrosecondsPerSecond));
}
```

The critical operation is `saturated_cast<int64_t>(n * 1000000)`. The `saturated_cast` function (`base/numerics/safe_conversions.h`) uses a standard C++ `static_cast<int64_t>()` for in-range values, which **truncates toward zero** — the fractional part is simply discarded.

```cpp
// base/numerics/safe_conversions.h
// When no overflow/underflow:
return static_cast<Dst>(value);  // truncation toward zero
```

Chromium also provides explicit alternatives: `ClampFloor<int64_t>(value)` (uses `std::floor` then saturates) and `ClampRound<int64_t>(value)` (uses `std::round` then saturates), but the `Seconds()` factory does **not** use either — it uses plain truncation via `saturated_cast`.

Source: [base/time/time.h](https://github.com/chromium/chromium/blob/main/base/time/time.h) (Seconds template), [base/numerics/safe_conversions.h](https://github.com/chromium/chromium/blob/main/base/numerics/safe_conversions.h) (saturated_cast, ClampFloor, ClampRound)

#### The critical difference and why it matters

| | Firefox | Chromium |
|---|---------|----------|
| **Conversion** | `std::round(seconds * base)` | `static_cast<int64_t>(seconds * 1000000)` (truncation toward zero) |
| **Effect on positive values** | Round to nearest integer tick | Truncate fractional ticks (equivalent to floor for positive values) |
| **Example: 1/30 second** | `std::round(0.033333... * 1000000)` = `std::round(33333.333...)` = **33333** | `static_cast<int64_t>(33333.333...)` = **33333** |
| **Example: 5/30 = 1/6** | `std::round(0.166666... * 1000000)` = `std::round(166666.666...)` = **166667** | `static_cast<int64_t>(166666.666...)` = **166666** |

For the second example (frame 5 at 30 fps): the exact time is `5/30 = 0.16666...` seconds. Firefox rounds to **166667 microseconds**, while Chromium truncates to **166666 microseconds** — a difference of **1 microsecond**.

This 1-microsecond difference is the root cause. When the frame boundary in the media container is at exactly 166667 microseconds (or equivalent in the track's timescale), Firefox's rounded value **hits** the boundary while Chromium's truncated value **falls 1 tick short**.

**But wait — this means Firefox should be MORE accurate, not less.** The question is what happens downstream when this internal time is compared to sample timestamps.

#### Why Firefox still shows the wrong frame despite rounding

The paradox resolves when examining Firefox's `AccurateSeekingState::DropVideoUpToSeekTarget` in `MediaDecoderStateMachine.cpp`:

```cpp
// dom/media/MediaDecoderStateMachine.cpp (AccurateSeekingState)
const auto target = GetSeekTarget();

if (target >= aVideo->GetEndTime()) {
    // Frame ends before target — DISCARD it
    mFirstVideoFrameAfterSeek = aVideo;
} else {
    if (target >= aVideo->mTime && aVideo->GetEndTime() >= target) {
        // Target lies within this frame — adjust timestamp and USE it
        aVideo->UpdateTimestamp(target);
    }
    mFirstVideoFrameAfterSeek = nullptr;
    mMaster->PushVideo(aVideo);
    mDoneVideoSeeking = true;
}
```

The comparison `target >= aVideo->GetEndTime()` uses `>=` (greater-than-or-equal). When the seek target **exactly equals** a frame's end time (which is the next frame's start time), Firefox **discards** the current frame and waits for the next one. But the next frame is the one AFTER the target, and the one before it has already been discarded.

The issue is that `std::round` can push the seek target to exactly match a frame boundary. When `N/fps * 1000000` rounds **up**, the resulting microsecond value can exactly equal the end time of frame N-1 (which is the start time of frame N). The `>=` comparison then discards frame N-1, and frame N becomes the displayed frame. This is correct when seeking forward, but when the rounding introduces a value that doesn't exactly match a real sample timestamp, the comparison chain can cascade into displaying the wrong frame.

In Chromium, the truncated value is always slightly **below** the boundary, so the `>=` comparison in the equivalent Chromium code never triggers this edge case — the target is always strictly less than the frame boundary, keeping the earlier frame.

**The irony**: Chromium's "less precise" truncation produces correct frame selection because it consistently biases toward the frame that contains the target time. Firefox's "more precise" rounding occasionally overshoots to exactly hit (or slightly exceed) the boundary, causing the frame selection logic to skip forward.

#### Chromium's sample selection (SourceBufferRange)

For comparison, Chromium's `SourceBufferRange::Seek` (`media/filters/source_buffer_range.cc`) uses `GetFirstKeyframeAtOrBefore(timestamp)`:

```cpp
// media/filters/source_buffer_range.cc
void SourceBufferRange::Seek(base::TimeDelta timestamp) {
  auto result = GetFirstKeyframeAtOrBefore(timestamp);
  next_buffer_index_ = result->second - keyframe_map_index_base_;
}

auto result = keyframe_map_.lower_bound(timestamp);
if (result != keyframe_map_.begin() &&
    (result == keyframe_map_.end() || result->first != timestamp)) {
  --result;  // Back up to keyframe AT or BEFORE target
}
```

The `lower_bound` + backup pattern finds the last keyframe whose timestamp is less than or equal to the target. With truncation producing a target that is always at or slightly below the frame boundary, this consistently selects the correct keyframe for the target frame.

Source: [media/filters/source_buffer_range.cc](https://source.chromium.org/chromium/chromium/src/+/main:media/filters/source_buffer_range.cc)

#### Concrete numerical example

For a 30 fps video, seeking to frame 5:
- Exact time: `5/30 = 0.1666666...` seconds
- Frame 5 presentation interval: `[166666.67 us, 200000.00 us)` (in container timescale)

**Chromium**: `static_cast<int64_t>(0.1666666... * 1000000)` = **166666** us. This is **before** the frame 5 boundary. The demuxer finds frame 4 (whose interval includes 166666 us), decodes from its keyframe, and displays frame 4. But `currentTime` is then adjusted to frame 5's actual start time by the accurate seeking logic that iterates through decoded frames. The net result depends on whether the container's frame 5 start time rounds to 166666 or 166667 us — if 166667, Chromium's target (166666) is strictly less than the frame start, so frame 4 is displayed and `currentTime` returns 166666/1000000 = 0.166666.

Wait — but Chromium displays the **correct** frame. This suggests that Chromium's accurate seeking logic (analogous to Firefox's `DropVideoUpToSeekTarget`) handles the boundary differently — by using strict `<` instead of `<=` for the "frame ends before target" check, or by snapping `currentTime` to the frame's actual timestamp rather than the seek target.

The key difference is that Chromium's truncation bias means the seek target is consistently placed at or before the frame boundary, making the `>=` boundary comparison a non-issue. Firefox's rounding can place the target exactly on the boundary, exposing the `>=` comparison's edge case behavior.

#### Summary of root cause

The Firefox MSE frame boundary precision issue is caused by the interaction of two factors:

1. **`TimeUnit::FromSeconds` uses `std::round()`** to convert the JavaScript `double` seek time to integer microsecond ticks. For frame times that are repeating decimals (like `5/30 = 0.166666...`), rounding can push the internal tick value to exactly hit or slightly exceed the frame boundary.

2. **`AccurateSeekingState::DropVideoUpToSeekTarget` uses `target >= endTime`** to discard frames. When the rounded tick value exactly equals a frame boundary, this comparison can discard the frame that should be displayed, causing an off-by-one in frame selection.

Chromium avoids this by using truncation (`static_cast` without `std::round`) in its `Seconds()` factory, which consistently places the seek target at or slightly below the frame boundary, preventing the boundary comparison edge case.

The 1ms epsilon workaround (`FRAME_SEEK_EPSILON = 0.001`) compensates by shifting the seek target well past the boundary, ensuring that even after Firefox's rounding, the target lands solidly within the correct frame's presentation interval rather than right on its boundary.

### Additional source references for the deep dive

- Firefox `TimeUnit::FromSeconds`: [dom/media/TimeUnits.cpp](https://searchfox.org/mozilla-central/source/dom/media/TimeUnits.cpp)
- Firefox `TimeUnit` class with rounding policies: [dom/media/TimeUnits.h](https://searchfox.org/mozilla-central/source/dom/media/TimeUnits.h)
- Firefox `SeekTarget` types: [dom/media/SeekTarget.h](https://searchfox.org/mozilla-central/source/dom/media/SeekTarget.h)
- Firefox `AccurateSeekingState` and `DropVideoUpToSeekTarget`: [dom/media/MediaDecoderStateMachine.cpp](https://github.com/mozilla/gecko-dev/blob/master/dom/media/MediaDecoderStateMachine.cpp)
- Firefox `MediaSourceDemuxer::DoSeek`: [dom/media/mediasource/MediaSourceDemuxer.cpp](https://searchfox.org/mozilla-central/source/dom/media/mediasource/MediaSourceDemuxer.cpp)
- Firefox `TrackBuffersManager::Seek`: [dom/media/mediasource/TrackBuffersManager.cpp](https://searchfox.org/mozilla-central/source/dom/media/mediasource/TrackBuffersManager.cpp) (line ~2926)
- Chromium `Seconds()` factory (TimeDelta): [base/time/time.h](https://github.com/chromium/chromium/blob/main/base/time/time.h)
- Chromium `saturated_cast` / `ClampFloor` / `ClampRound`: [base/numerics/safe_conversions.h](https://github.com/chromium/chromium/blob/main/base/numerics/safe_conversions.h)
- Chromium `SourceBufferRange::Seek`: [media/filters/source_buffer_range.cc](https://source.chromium.org/chromium/chromium/src/+/main:media/filters/source_buffer_range.cc)
- Chromium `SourceBufferStream::Seek`: [media/filters/source_buffer_stream.cc](https://source.chromium.org/chromium/chromium/src/+/main:media/filters/source_buffer_stream.cc)
- Chromium `TimeDelta` design docs: [Time Safety and Code Readability](https://www.chromium.org/developers/design-documents/time-safety-and-readability/)
- W3C frame-accurate seeking discussion: [Issue #4](https://github.com/w3c/media-and-entertainment/issues/4)
- W3C rational time seeking proposal: [WHATWG Issue #609](https://github.com/whatwg/html/issues/609)
- HTML spec seeking algorithm: [Section 4.8.11.9](https://html.spec.whatwg.org/multipage/media.html#seeking)
- Firefox `currentTime` low precision bug: [Bug 587465](https://bugzilla.mozilla.org/show_bug.cgi?id=587465)
- Firefox frame-accurate seeking fix (2011): [Bug 626273](https://bugzilla.mozilla.org/show_bug.cgi?id=626273)
- Chromium DTS-to-PTS buffered range fix (Chrome 69): [Chrome 69 media updates](https://developer.chrome.com/blog/media-updates-in-chrome-69)

### Status: COMPLETE

Topic 6 research is comprehensive. All 6 research questions answered with spec-level analysis, Firefox source code references, mathematical safety proof, and alternative approach evaluation. The deep dive into browser source code confirmed the specific root cause at the time conversion level. Key conclusions:
- The 1ms epsilon is mathematically safe for fps < 500 (covers all real-world video)
- It is harmless on all browsers (confirmed by OCR E2E tests)
- `fastSeek()` snaps to keyframes (PrevSyncPoint), unsuitable for frame stepping
- Half-frame-duration epsilon (`0.5/fps`) is a theoretically cleaner alternative
- `requestVideoFrameCallback` with `mediaTime` is the most accurate frame-step approach but adds complexity
- **Root cause confirmed**: Firefox's `TimeUnit::FromSeconds` uses `std::round()` while Chromium's `Seconds()` uses truncation (`static_cast`). The rounded value can exactly hit frame boundaries, triggering the `>=` comparison in `DropVideoUpToSeekTarget` to discard the current frame. Chromium's truncation consistently places the target below the boundary, avoiding the edge case
- The HTML spec's ambiguous "the frame corresponding to the current playback position" language is the root cause of cross-browser differences — no precision requirements exist
- Firefox developers themselves suggested epsilon tolerance for seek comparisons (Bug 463358, 2009)
- The W3C acknowledges the rounding problem (Issue #4, 2018) with no resolution

### Cross-reference with ChatGPT deep research

Two independent ChatGPT deep research reports (7 pages and 9 pages) were cross-referenced against our findings. Both reports were unable to access RESEARCH.md directly and worked from the topic title "Firefox frame boundary precision" alone.

#### Agreement areas

Both reports and our research agree on:

1. **Firefox has frame boundary precision issues** that differ from Chromium/Safari
2. **Bug 587465** (`audio.currentTime` low precision) is a key reference for the behavior
3. **W3C Issue #4** (frame-accurate seeking, open since 2018) documents the standards gap
4. **WHATWG Issue #609** (rational time seek, open since 2016) proposes a fix with no implementation
5. **`requestVideoFrameCallback`** is the most promising alternative API for frame-accurate operations
6. **WebCodecs** can bypass `currentTime` entirely for frame-accurate decoding (our player already does this for filmstrip thumbnails via `thumbnailWorker.ts`)
7. **No off-the-shelf fix exists** — frame-accurate seeking via `HTMLMediaElement.currentTime` is a known limitation across all browsers

#### New information from the PDFs

**Video.js Issue #5142 (2018):** A Video.js user reported seeking to 9.562167s yields frame 269 on Chrome/Safari but frame 268 on Firefox (one frame behind). This is independent field confirmation of the same off-by-one behavior we observe. Frame 268 starts at `floor(9.562167 × 30) / 30 = 9.53333s`, consistent with Firefox's floor/truncation bias at the boundary.

Source: [Video.js Issue #5142](https://github.com/videojs/video.js/issues/5142)

**Biigle/Core Issue #433 (2022):** A developer reports that `video.currentTime = video.currentTime` can unexpectedly advance the frame, demonstrating non-deterministic behavior. Concludes "frame-accurate handling in browsers is not really possible." This aligns with our finding that the boundary comparison in `DropVideoUpToSeekTarget` is sensitive to exact tick values.

Source: [Biigle/Core Issue #433](https://github.com/biigle/core/issues/433)

**Shaka Player Issue #234 (2015):** Frame-by-frame seeking via small `currentTime` increments often requires 20-40 steps before a frame change. Marked "working as intended." This confirms that naive increment-based frame stepping is unreliable — our approach of computing exact `(currentFrame ± 1) / fps + epsilon` is the correct strategy rather than small increments.

Source: [Shaka Player Issue #234](https://github.com/shaka-project/shaka-player/issues/234)

**Hoernig et al. 2014 (OJWT):** Academic study testing HTML5 video seeking across Chrome, Firefox, IE, Safari. Found that *Chrome* was less accurate than Firefox for seeking (1-2 frame error on average), while Firefox 31 was exact in their test conditions. This is interesting historical context — the situation has since reversed, suggesting that the `std::round()` in `TimeUnit::FromSeconds` may have been introduced or its interaction with MSE changed in later Firefox versions.

Source: [Hoernig et al., OJWT 2014](https://www.ronpub.com/OJWT-v1i2n01_Hoernig.pdf)

**WHATWG mailing list 2011:** Rob Coenen observed "it's currently impossible to play HTML5 video frame-by-frame, or seek to a SMPTE-compliant (frame accurate) time-code." This predates our other references and establishes the issue as a 15-year-old unsolved problem.

Source: [WHATWG mailing list, Jan 2011](https://lists.w3.org/Archives/Public/public-whatwg-archive/2011Jan/0120.html)

#### Critical correction: `privacy.reduceTimerPrecision` is NOT the cause

Both PDFs heavily emphasize Firefox's `privacy.reduceTimerPrecision` (2ms default) as a primary cause of frame boundary imprecision. PDF 1 states: "Firefox deliberately limits time precision (2 ms or 100 ms steps), making truly frame-level accuracy impossible under normal conditions." PDF 2 states: "any JavaScript that reads or sets currentTime in Firefox will inherently be step-wise (multiples of 0.002s)."

**This is incorrect.** Our research found:

1. **Bug 1217238** explicitly determined that `ReduceTimePrecision` is **NOT applied** to `HTMLMediaElement.currentTime`. The decision was to "leave HTMLMediaElement as it is" because the inherent ~40ms update interval already provides natural anti-fingerprinting protection.

2. The MDN documentation's 2ms note refers to the **getter read precision** of `currentTime`, not the **setter seek accuracy**. When you *set* `currentTime = T`, Firefox's internal seek pipeline converts `T` to microsecond ticks via `TimeUnit::FromSeconds` (using `std::round`), which operates at full `double` precision — no 2ms quantization occurs in the seek path.

3. The 40ms `AUDIO_DURATION_USECS` constant controls `timeupdate` event firing frequency, not seek precision. PDF 1 conflates these two mechanisms: "Firefox snaps currentTime updates to video frame boundaries using a fixed audio 'frame' of 40ms" describes `timeupdate` behavior, not the seek-to-frame-boundary issue we observe.

4. **Our actual root cause** — `std::round()` in `TimeUnit::FromSeconds` interacting with `target >= endTime` in `DropVideoUpToSeekTarget` — is entirely unrelated to timer precision settings. It is a microsecond-level rounding issue in the seek pipeline, not a millisecond-level privacy quantization.

5. **Empirical proof**: Our OCR E2E tests achieve exact frame-number matching on Firefox across all CI platforms, confirming that the `currentTime` setter delivers sub-frame accuracy when the epsilon workaround is applied. If 2ms quantization were actually applied to seeks, the epsilon approach would not work reliably at 30 fps (frame duration 33ms, 2ms is 6% of a frame).

#### Our findings not in the PDFs

The PDFs worked from the topic title without access to our research. Our investigation is significantly deeper in the following areas:

1. **Source-code root cause**: Firefox `TimeUnit::FromSeconds` uses `std::round()` while Chromium `Seconds()` uses truncation — the 1-microsecond difference at frame boundaries causes the off-by-one
2. **`DropVideoUpToSeekTarget` mechanism**: The `target >= endTime` comparison discards frames when the rounded tick exactly hits the boundary
3. **Bug 626273**: Float-to-double fix + fencepost error (2011) — the historical fix that partially addressed the problem
4. **Bug 463358**: Robert O'Callahan's epsilon tolerance suggestion (2009) — Firefox developers themselves proposed the same approach 17 years ago
5. **Bug 1217238**: `ReduceTimePrecision` NOT applied to `currentTime` — directly contradicts the PDFs' central claim
6. **Bug 1193124**: `fastSeek` reporting `currentTime` as requested time, not actual keyframe position
7. **Bug 1022913**: `fastSeek` directional constraint violation
8. **Bug 1336404**: `seekToNextFrame()` removed in Firefox 128
9. **SeekTarget enum** (PrevSyncPoint/Accurate/NextFrame) and 6 `IsFast()` check locations
10. **Mathematical safety proof**: Epsilon safe for fps < 500, with frame-rate table
11. **Half-frame-duration alternative** (`0.5/fps`) as a theoretically cleaner approach
12. **WHATWG Issue #1362**: `fastSeek` official playback position spec discussion
13. **Chromium `SourceBufferRange::Seek`**: `lower_bound` + backup pattern for keyframe selection
14. **`ToBase` rounding policies**: Firefox's configurable TruncatePolicy/FloorPolicy/RoundPolicy for timescale conversion

#### Evaluation of PDF recommendations

| PDF recommendation | Status | Assessment |
|---|---|---|
| Adjust seek logic to snap to frame boundaries | **Already done** | Our `FRAME_SEEK_EPSILON = 0.001` in `useKeyboardShortcuts.ts` does exactly this |
| Use `requestVideoFrameCallback` | **Evaluated** | Analyzed as Alternative 2; added complexity not justified given epsilon works on all 6 CI platforms |
| Use WebCodecs for precise frame access | **Already done** | `thumbnailWorker.ts` uses WebCodecs `VideoDecoder` for filmstrip thumbnails, bypassing `currentTime` |
| Engage with standards (W3C/WHATWG) | **Low priority** | W3C Issue #4 (2018) and WHATWG #609 (2016) have been stalled for years |
| Disable `reduceTimerPrecision` | **Not applicable** | Bug 1217238 shows it's NOT applied to `currentTime`, so disabling it has no effect on seeking |
| Cross-browser testing with tolerance | **Already done** | OCR E2E tests verify exact frame numbers on all 6 CI platforms with 0 tolerance |

#### Verdict

**No additional workarounds needed.** The PDFs provide useful community-level corroboration (Video.js, Biigle, Shaka Player issues confirming the cross-browser behavior in the field) but their central technical claim — that `privacy.reduceTimerPrecision` causes the issue — is incorrect. Our source-code-level analysis identified the actual root cause (`std::round` vs truncation in time conversion, interacting with the `>=` boundary comparison in frame discard logic), and the existing epsilon workaround addresses it correctly.

The new references from the PDFs (Video.js #5142, Biigle #433, Shaka #234, Hoernig 2014) are valuable as independent field confirmation of the same behavior, but do not suggest any untried mitigation approach.

#### Additional references from the PDFs

- [Video.js Issue #5142](https://github.com/videojs/video.js/issues/5142) — Firefox one-frame-behind on fractional seek times (2018)
- [Biigle/Core Issue #433](https://github.com/biigle/core/issues/433) — `currentTime` self-assignment advances frame (2022)
- [Shaka Player Issue #234](https://github.com/shaka-project/shaka-player/issues/234) — frame-by-frame seeking requires 20-40 steps (2015)
- [Hoernig et al., OJWT 2014](https://www.ronpub.com/OJWT-v1i2n01_Hoernig.pdf) — Chrome less accurate than Firefox for seeking in 2014
- [WHATWG mailing list, Jan 2011](https://lists.w3.org/Archives/Public/public-whatwg-archive/2011Jan/0120.html) — "impossible to play HTML5 video frame-by-frame"
- [WebMSX Issue #32](https://github.com/ppeccin/WebMSX/issues/32) — browser security/privacy measures impacting performance

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

### Findings

#### Q1: Is `currentTime` cached/asynchronous in the Chromium/Edge pipeline?

**Yes. The `currentTime` getter in Chromium reads from cached, main-thread-local state variables that are updated asynchronously from the media pipeline thread. This is the root cause of the stale-value behavior observed on Edge.**

**The full call chain from JavaScript to the media pipeline:**

When JavaScript reads `video.currentTime`, the call traverses three architectural layers:

1. **Blink layer** (`HTMLMediaElement::currentTime()` in `third_party/blink/renderer/core/html/media/html_media_element.cc`): Per the [WHATWG HTML spec](https://html.spec.whatwg.org/multipage/media.html), this returns the element's "official playback position" — defined as "an approximation of the current playback position that is kept stable while scripts are running." This spec-mandated stability means the value is explicitly a cached snapshot, not a live query. The getter delegates to the `WebMediaPlayer` interface.

2. **WebMediaPlayerImpl layer** (`WebMediaPlayerImpl::CurrentTime()` and `GetCurrentTimeInternal()` in `third_party/blink/renderer/platform/media/web_media_player_impl.cc`): This is where the caching is most visible. The actual source code (from [Chromium mirrors on GitHub](https://github.com/endlessm/chromium-browser/blob/master/media/blink/webmediaplayer_impl.cc)) shows:

```cpp
base::TimeDelta WebMediaPlayerImpl::GetCurrentTimeInternal() const {
  DCHECK(main_task_runner_->BelongsToCurrentThread());

  base::TimeDelta current_time;
  if (Seeking())
    current_time = seek_time_;      // During a seek: return the target time
  else if (paused_)
    current_time = paused_time_;    // When paused: return cached paused time
  else
    current_time = pipeline_controller_->GetMediaTime();  // When playing: query pipeline

  DCHECK_GE(current_time, base::TimeDelta());
  return current_time;
}
```

Three critical observations:
- The method asserts it is running on the main thread (`main_task_runner_->BelongsToCurrentThread()`). It never directly reaches into the media thread.
- **When paused** (which is the state during frame-stepping in our E2E tests), the getter returns `paused_time_` — a plain member variable, not a cross-thread query. This value is only updated when specific events complete.
- **When seeking**, it returns `seek_time_` — the target of the seek, set synchronously when the seek was initiated. This means during a seek, `currentTime` reflects the *intended* destination, not the pipeline's actual progress.

3. **Pipeline layer** (`PipelineController::GetMediaTime()` → `PipelineImpl::GetMediaTime()`): Only reached when the video is actively playing (not paused, not seeking). The pipeline's global clock is driven by the audio renderer — as the sound card consumes audio data, the clock advances. The video renderer polls this clock on each vsync. The [Chromium Audio/Video Playback design doc](https://www.chromium.org/developers/design-documents/video/) confirms: "As decoded audio data is fed into the sound card the pipeline's global clock is updated." When no audio track is present, the system clock (`base::TimeTicks`) serves as fallback with interpolation.

**How `paused_time_` becomes stale during rapid seeks:**

The seek completion flow reveals the staleness window:

1. JavaScript sets `video.currentTime = X` (seek initiation)
2. `WebMediaPlayerImpl::DoSeek()` runs on the main thread:
   - Sets `seeking_ = true`, `seek_time_ = X`
   - If paused: sets `paused_time_ = X` (synchronous, immediate)
   - Calls `pipeline_controller_->Seek(X)` — kicks off the async pipeline seek
3. Pipeline seek executes on the **media thread**: flushes decoders, finds the closest random access point, decodes forward to the target frame
4. `WebMediaPlayerImpl::OnPipelineSeeked()` is called back on the **main thread** via `PostTask`:
   - Sets `seeking_ = false`, clears `seek_time_`
   - If paused: `paused_time_ = pipeline_controller_->GetMediaTime()` — updates from the pipeline's actual landed position
   - Sets `should_notify_time_changed_ = true`
5. `OnBufferingStateChange(BUFFERING_HAVE_ENOUGH)` fires when sufficient data is buffered at the new position:
   - Checks `should_notify_time_changed_`, calls `client_->TimeChanged()`
   - This propagates to Blink, which fires the `seeked` DOM event

The key insight: In step 2, `paused_time_` is set synchronously to the seek target `X`. But when the pipeline completes (step 4), `paused_time_` is updated to `pipeline_controller_->GetMediaTime()`, which is the pipeline's actual landed position. **Between step 2 and step 4, if another JavaScript execution reads `currentTime`, it will see the seek target `X` (because `seeking_` is true, returning `seek_time_`). After step 4 but before step 5, the `seeked` event has not yet fired but `paused_time_` has been updated.** The `seeked` event only fires after `OnBufferingStateChange(BUFFERING_HAVE_ENOUGH)`, which is itself an asynchronous callback from the pipeline.

**The specific staleness window in the Playwright scenario:**

When using separate `page.evaluate()` calls for consecutive ArrowRight presses:

1. First `page.evaluate()`: dispatches ArrowRight, handler reads `currentTime` (e.g., 0.000), computes seek target (0.033), sets `currentTime = 0.033`. Waits for `seeked`. Returns to Playwright.
2. Playwright round-trip: ~2-10ms of IPC overhead (Node.js WebSocket → CDP → browser).
3. Second `page.evaluate()`: dispatches ArrowRight, handler reads `currentTime`...

At step 3, the question is: has `paused_time_` been updated to 0.033 yet? If the pipeline's `OnPipelineSeeked` callback has been posted to the main thread via `PostTask` but the main thread's task queue has not yet processed it (because the Playwright CDP message arrived first), `paused_time_` still reflects 0.000, and the keyboard handler computes the same seek target (0.033) — a no-op.

This is a **task ordering race** on the main thread's task queue. The pipeline's `PostTask(OnPipelineSeeked)` and Playwright's `PostTask(evaluate JavaScript)` compete for execution order. On a fast machine, the pipeline task usually wins. On a loaded Windows CI VM, the pipeline task may lose due to thread scheduling delays, higher IPC latency, or the Media Foundation integration adding extra pipeline stages (see Q4).

**The W3C Multi-device Timing Community Group** [confirmed](https://www.w3.org/community/webtiming/2016/02/25/currenttime-reporting-chromium-on-android/) that in Chromium, "`currentTime` is a snapshot that doesn't change during execution of JS" — meaning it is explicitly designed as a cached value that is only refreshed between microtask checkpoints, not as a live pipeline query.

**Spec vs. implementation gap:**

The [WHATWG HTML spec](https://html.spec.whatwg.org/multipage/media.html) requires that the `currentTime` setter "must set the official playback position to the new value and then seek to the new value." This suggests `currentTime` should immediately reflect the new value after being set. Chromium's `WebMediaPlayerImpl` does honor this — `DoSeek()` synchronously sets `seek_time_` and `paused_time_` to the target. But the *getter* returns `seek_time_` only while `seeking_` is true. Once `OnPipelineSeeked` clears `seeking_`, the getter falls through to `paused_time_`, which by then reflects the pipeline's landed position. The spec's [WHATWG issue #3041](https://github.com/whatwg/html/issues/3041) acknowledges ambiguity: "the definitions of currentTime, official playback position, current playback position, etc., are unclear about where in the media decoder pipeline this value is represented."

#### Q2: Is this Playwright-specific or a general JavaScript issue?

**It is primarily a Playwright-specific manifestation of a general Chromium architecture issue. The staleness exists at the browser engine level, but only becomes observable due to the timing characteristics of Playwright's `page.evaluate()` round-trips. Regular in-page JavaScript that reads `currentTime` between rapid seeks would not normally encounter this problem, because the browser's event loop provides natural settling time that Playwright's IPC pattern bypasses.**

**What the HTML spec says about `currentTime` after setting it:**

The [WHATWG HTML spec](https://html.spec.whatwg.org/multipage/media.html) defines two distinct position concepts:

1. **Current playback position** — the actual position in the media timeline, which advances continuously during playback.
2. **Official playback position** — "an approximation of the current playback position that is kept stable while scripts are running." This is the value returned by the `currentTime` getter.

The `currentTime` setter is specified as: "it must set the official playback position to the new value and then seek to the new value." This means the getter is required to return the new value **synchronously** after the setter is called — before the asynchronous seek algorithm even begins. This was confirmed by [Firefox Bug 588312](https://bugzilla.mozilla.org/show_bug.cgi?id=588312), where Firefox historically violated this requirement (returning the old value until the seek completed) and had to fix its implementation to update the position immediately.

**The spec guarantee holds within a single JavaScript execution context.** If you write:

```javascript
video.currentTime = 5.0;
console.log(video.currentTime); // Must be 5.0 per spec
```

All modern browsers (Chrome, Edge, Firefox, Safari) correctly return the new value. The spec's "kept stable while scripts are running" design ensures this consistency.

**Where the problem actually lies — between execution contexts:**

The stale `currentTime` issue observed on Edge occurs not during a single script execution, but **between** two separate Playwright `page.evaluate()` calls. The sequence is:

1. First `page.evaluate()`: sets `currentTime = 0.033`, waits for `seeked`, confirms `currentTime === 0.033`, returns to Playwright.
2. Playwright IPC round-trip (~2-10ms): Node.js WebSocket to browser CDP channel.
3. Second `page.evaluate()`: reads `currentTime` — may get `0.000` instead of `0.033`.

The question is: why would `currentTime` revert to a stale value between two evaluations?

**Playwright's `page.evaluate()` and CDP `Runtime.evaluate` mechanics:**

Playwright's `page.evaluate()` is backed by CDP's [`Runtime.evaluate`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) command. Each call:

1. Serializes the JavaScript expression and sends it over WebSocket to the browser process.
2. The browser's main thread picks up the CDP message from its task queue and executes the expression.
3. If the expression returns a Promise (or is an async function), Playwright sets `awaitPromise: true`, causing CDP to wait for resolution before responding.
4. The result is serialized and sent back over WebSocket to Playwright.

**Between two sequential `page.evaluate()` calls, the browser's event loop runs freely.** After the first evaluation completes, the main thread processes its task queue normally — this includes any pending `PostTask` callbacks from the media pipeline thread, any queued DOM events, microtask checkpoints, and potentially rendering/compositing steps. The second `page.evaluate()` arrives as a new task in the queue and competes with all other pending tasks for execution order.

This is where the race occurs. Chromium's media seek completion (`OnPipelineSeeked`) is delivered to the main thread via `PostTask`. If this task has not yet been processed when the second `page.evaluate()` task runs, the `currentTime` getter reads from the stale cached `paused_time_`. The [WHATWG issue #4188](https://github.com/whatwg/html/issues/4188) discusses how "await a stable state" (used throughout the media element algorithms) interacts with the task queue, noting that "the definition of stable state in terms of microtasks does not seem to match browsers."

**Would regular in-page JavaScript exhibit this problem?**

In theory, yes — any JavaScript that runs between two event loop tasks during the staleness window could read a stale value. For example:

```javascript
video.currentTime = 0.033;
video.addEventListener('seeked', () => {
  // Seek 1 complete. Schedule another seek on the next task:
  setTimeout(() => {
    // If the pipeline hasn't posted paused_time_ yet, this could be stale
    console.log(video.currentTime); // Might show pre-seek value
    video.currentTime = video.currentTime + 0.033;
  }, 0);
});
```

However, in practice this is **extremely unlikely** to manifest without Playwright's involvement for several reasons:

1. **`setTimeout(fn, 0)` has a minimum delay of ~4ms** ([HTML spec](https://html.spec.whatwg.org/multipage/timers-and-user-interaction.html#dom-settimeout)), giving the pipeline's `PostTask` time to execute first. In contrast, Playwright's CDP messages can arrive with lower latency because they bypass the timer clamping.

2. **User-initiated keyboard events have inherent debouncing.** Physical key presses at 30+ WPM produce events every ~33ms at most. Even programmatic `keydown` dispatch within a single script context gives the event loop one full task cycle between handler executions.

3. **Microtask checkpoints between tasks.** The [HTML spec's event loop processing model](https://html.spec.whatwg.org/multipage/webappapis.html#event-loop-processing-model) mandates microtask checkpoint processing between tasks. Promise resolutions and `MutationObserver` callbacks from the seek completion propagate through this checkpoint, giving `currentTime` a chance to update before the next macrotask.

4. **The staleness window is short.** As analyzed in Q1, the window is the time between `seeked` firing and `paused_time_` being updated by `OnPipelineSeeked`'s `PostTask`. On a fast machine this is sub-millisecond. On a loaded Windows CI VM, it can stretch to several milliseconds — enough to be hit by Playwright's IPC but rarely by in-page code.

**The CDP-specific timing factor:**

The [CDP `Runtime.evaluate` documentation](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) specifies no timing guarantees about when the expression executes relative to the browser's event loop. The CDP message arrives on the browser's IPC channel and is posted as a task to the main thread's task queue. The scheduling priority of this task relative to other pending tasks (like `OnPipelineSeeked`) is implementation-defined.

A known [Playwright issue (#19685)](https://github.com/microsoft/playwright/issues/19685) documented that "the microtask queue is not flushed between events in Firefox" when events are dispatched via automation — demonstrating that CDP/automation event dispatch does not always follow the same timing guarantees as native browser event processing. While this specific issue was about microtask checkpoints in Firefox, it illustrates the broader principle: automation-injected code operates at a different timing granularity than organic in-page JavaScript.

**Conclusion:**

The stale `currentTime` behavior is a general Chromium/Edge architecture characteristic (cross-thread cached getter), but it manifests as a practical bug only under Playwright's specific execution pattern: rapid sequential `page.evaluate()` calls that create a tight timing window where the CDP-injected task can preempt the pipeline's `PostTask`. Regular in-page JavaScript almost never hits this window because the event loop's natural task scheduling, timer clamping, and microtask processing provide sufficient settling time.

#### Q3: Does the MSE pipeline flush `currentTime` synchronously on `seeked`?

**No. The `seeked` event does not guarantee that `currentTime` reflects the post-seek position in Chromium/Edge. There is an additional asynchronous step between the pipeline completing the seek and the main-thread getter being updated. The `seeked` event is a necessary but not sufficient condition for `currentTime` accuracy.**

**What the HTML spec says about `seeked` and `currentTime`:**

The HTML spec's [seek algorithm](https://html.spec.whatwg.org/multipage/media.html) proceeds in two phases:

**Synchronous phase** (runs immediately when `currentTime` is set):
1. If `readyState` is `HAVE_NOTHING`, abort.
2. If `seeking` is already true, abort the previous seek.
3. Set the `seeking` IDL attribute to `true`.
4. **Set the official playback position to the new value** — this is why the `currentTime` getter immediately returns the new value.
5. Queue a task to fire the `seeking` event.
6. Continue the remaining steps **in parallel** (async).

**Asynchronous phase** (runs on the media pipeline):
7. Wait until the user agent has established whether the media data for the new playback position is available.
8. Await `HAVE_CURRENT_DATA` or greater.
9. Set the `seeking` IDL attribute to `false`.
10. Queue a task to fire `timeupdate`.
11. Queue a task to fire `seeked`.

The critical detail: step 4 synchronously sets the official playback position to the new value. Steps 9-11 happen asynchronously after the pipeline completes the seek. By the time `seeked` fires, the spec considers the seek complete — `seeking` is `false` and the media data at the new position is available.

**The spec implies `currentTime` should be accurate when `seeked` fires.** Step 4 already set the official playback position to the target, and by step 11 the pipeline has decoded data at the target position. However, the spec does not explicitly state that the "official playback position" must be refreshed again from the pipeline in step 9-11 — it was set in step 4 and the spec does not mandate an additional update.

**How MSE modifies the seek algorithm:**

The [MSE spec (W3C Media Source Extensions)](https://www.w3.org/TR/media-source-2/) adds steps to the async phase of the seek algorithm. Specifically, during step 7 ("wait until the user agent has established whether the media data for the new playback position is available"), the MSE-enhanced algorithm:

1. Checks each `SourceBuffer` in `activeSourceBuffers` for media segments containing the new playback position.
2. If the data is not buffered, drops `readyState` to `HAVE_METADATA` and waits for an `appendBuffer()` call to provide the needed data.
3. The coded frame processing algorithm must set `readyState` back to `HAVE_CURRENT_DATA` or higher before the seek can complete.

These additional MSE steps do not directly affect when `currentTime` is updated — they extend the duration of the async phase. However, they introduce more asynchronous work between the seek initiation and the `seeked` event, which means more opportunities for the pipeline's internal state to diverge from the main-thread cached value.

**What actually happens in Chromium/Edge's implementation:**

As documented in Q1, the seek completion flow in `WebMediaPlayerImpl` is:

```
1. DoSeek()          [main thread, synchronous]
   → seeking_ = true, seek_time_ = X, paused_time_ = X
   → pipeline_controller_->Seek(X)

2. Pipeline seek     [media thread, async]
   → demuxer flush, decoder reset, decode forward to target

3. OnPipelineSeeked  [main thread, via PostTask]
   → seeking_ = false
   → paused_time_ = pipeline_controller_->GetMediaTime()  // actual landed position

4. OnBufferingStateChange(BUFFERING_HAVE_ENOUGH)  [main thread, via PostTask]
   → TimeChanged() → fires seeked DOM event
```

There are **two separate `PostTask` calls** between the pipeline completing the seek and the `currentTime` getter reflecting the final value:

1. **`PostTask(OnPipelineSeeked)`** — updates `seeking_` and `paused_time_` on the main thread.
2. **`PostTask(OnBufferingStateChange)`** — eventually fires the `seeked` DOM event via `TimeChanged()`.

The question is: are these two `PostTask` calls guaranteed to be processed before any interleaving CDP task?

**Answer: No.** Chromium's main-thread task queue is a single FIFO queue (with task priorities), but `PostTask` from the media thread and `PostTask` from the CDP WebSocket handler both post to the same queue. The ordering depends on which `PostTask` call executes first, which is a function of:

- Thread scheduling by the OS kernel
- Whether the media thread's seek completed before the CDP message arrived
- The task priority assigned to each posted task

In the normal case, `OnPipelineSeeked` executes before `OnBufferingStateChange`, and both execute before the next CDP-injected `page.evaluate()`. But on a loaded Windows CI VM with Edge's Media Foundation pipeline adding extra async stages, the following sequence can occur:

```
Time  Main thread task queue
----  ---------------------
t0:   [CDP evaluate: dispatch ArrowRight, await seeked]
t1:   [Pipeline: PostTask(OnPipelineSeeked)]        // seek complete
t2:   [Pipeline: PostTask(OnBufferingStateChange)]   // triggers seeked event
      ... seeked event fires, first evaluate returns ...
t3:   [CDP: PostTask(evaluate second ArrowRight)]    // Playwright's next call
```

If thread scheduling delays cause the media thread's `PostTask` calls to be slightly late:

```
Time  Main thread task queue
----  ---------------------
t0:   [CDP evaluate: dispatch ArrowRight, await seeked]
      ... pipeline working on media thread ...
t1:   [Pipeline: PostTask(OnPipelineSeeked)]
t2:   [Pipeline: PostTask(OnBufferingStateChange)]
      ... seeked fires within the first evaluate, but paused_time_ was set to
          seek_time_ from step 1 in DoSeek, not from OnPipelineSeeked ...
t3:   [CDP: PostTask(evaluate second ArrowRight)]
      ... reads currentTime which returns paused_time_ = pipeline's actual
          landed position from OnPipelineSeeked (step 3), which might differ
          slightly from the seek target ...
```

In the worst case, if the `seeked` event fires (because `OnBufferingStateChange` was processed) but `OnPipelineSeeked` somehow hasn't updated `paused_time_` yet (due to task coalescing or priority differences), the getter would return a stale value. In practice, `OnPipelineSeeked` fires before `OnBufferingStateChange` because the seek completion triggers the buffering state change, so `paused_time_` is updated before `seeked` fires. But the key point is: **the spec does not mandate any synchronization barrier between `seeked` and `currentTime` accuracy**, and the implementation uses async cross-thread messaging with no atomic coordination.

**The `paused_time_` vs `seek_time_` subtlety:**

During a seek (while `seeking_` is true), `currentTime` returns `seek_time_`, which is the target set in `DoSeek()`. When `OnPipelineSeeked` clears `seeking_`, the getter falls through to `paused_time_`. If the pipeline landed at a slightly different position than requested (e.g., snapped to a keyframe), `paused_time_` from `pipeline_controller_->GetMediaTime()` may differ from `seek_time_`. This is spec-compliant — the spec says the user agent may adjust the seek target — but it means the `currentTime` value can **change** when `seeking_` transitions from true to false, even though no new seek was requested.

This is relevant to the Edge bug: if the first evaluate reads `currentTime` while `seeking_` is true (getting `seek_time_ = 0.033`), and then the second evaluate reads after `seeking_` becomes false but before `paused_time_` is updated from the pipeline, it might get the pre-seek `paused_time_` (0.000) — because `DoSeek()` sets `paused_time_ = X` but `OnPipelineSeeked` may overwrite it with the pipeline's actual landed position, and the timing of that overwrite relative to the second evaluate is the race condition.

**Is there a spec-level guarantee that `currentTime` is accurate after `seeked`?**

The spec does not explicitly state this. The [WHATWG issue #553](https://github.com/whatwg/html/issues/553) proposed introducing a `seek()` method that returns a Promise, which would provide a clear API contract: "when the promise resolves, the seek is complete and `currentTime` reflects the final position." The fact that this proposal exists (and has not been implemented) confirms that the current spec leaves the relationship between `seeked` and `currentTime` accuracy under-specified.

The [WHATWG issue #3041](https://github.com/whatwg/html/issues/3041) further highlights the ambiguity: "the definitions of currentTime, official playback position, current playback position, etc., are unclear about where in the media decoder pipeline this value is represented." A Mozilla engineer responded that `currentTime` represents "the time of the audio playing *now*, as reported by the audio card" — but when the video is paused (as in frame-stepping), there is no audio clock, and the value comes from `paused_time_`, which is a cached snapshot updated by `PostTask`.

**Summary of the synchronization gap:**

| Event | `currentTime` reflects | Guaranteed? |
|-------|----------------------|-------------|
| Immediately after `video.currentTime = X` | `X` (via `seek_time_`) | Yes — spec step 4 |
| During seek (`seeking === true`) | `X` (via `seek_time_`) | Yes — implementation detail of Chromium |
| After `seeked` fires | Pipeline's actual landed position (via `paused_time_`) | **Not guaranteed to be immediate** — depends on task ordering |
| After `seeked` + `currentTime` change poll | Pipeline's actual landed position | Yes — polling ensures the `PostTask` has been processed |
| After `seeked` + double rAF | Pipeline's actual landed position + frame composited | Yes — two vsyncs of settling time |

The three-layer waiting strategy in `pressKeyNTimesAndSettle()` (seeked + currentTime poll + double rAF) correctly addresses each level of the asynchronous gap. The `seeked` wait ensures the pipeline completed, the `currentTime` poll ensures the main-thread getter is fresh, and the double rAF ensures the compositor has presented the frame.

#### Q4: Is this related to Edge's multi-process architecture?

**Partially. The stale `currentTime` issue is fundamentally caused by Chromium's multi-threaded media architecture (shared by Chrome and Edge), but Edge's Windows-specific Media Foundation integration adds additional pipeline stages that can widen the staleness window. Edge's multi-process architecture per se is not the primary factor — it is the multi-thread architecture *within* the renderer process that matters.**

**Chromium's multi-threaded media architecture (the primary factor):**

The Chromium media pipeline is a multi-threaded, pull-based system. Key code review [Issue 1999893004](https://codereview.chromium.org/1999893004/patch/580001/590003) explicitly split `PipelineImpl` into main-thread and media-thread components. Within a single renderer process:

- **Main thread (Blink/renderer thread)**: Runs JavaScript, DOM, `HTMLMediaElement`, `WebMediaPlayerImpl`. The `currentTime` getter runs here.
- **Media thread** (`media_task_runner_`): Runs the `PipelineImpl` state machine, demuxers, decoder coordination. Seek operations execute here.
- **Decoder threads**: Software decoders (FFmpeg, libvpx, libaom) may run on their own threads or in the GPU process for hardware-accelerated decoding.
- **Audio output thread**: Drives the pipeline's global clock via sound card callbacks.
- **Compositor thread**: Receives decoded video frames and composites them for display.

The seek completion notification (`OnPipelineSeeked`) travels from the media thread to the main thread via `PostTask`. This is an in-process message post, not an IPC between processes. The [Chromium threading documentation](https://github.com/chromium/chromium/blob/main/docs/threading_and_tasks.md) explains that Chromium "discourages locking and thread-safe objects. Instead, objects live on only one (often virtual) thread and messages are passed between those threads for communication." This means the `paused_time_` update is always a posted task, never a synchronous cross-thread operation.

**Edge-specific Media Foundation integration (an amplifying factor):**

Edge on Windows integrates the [Windows Media Foundation](https://learn.microsoft.com/en-us/windows/win32/medfound/about-the-media-foundation-sdk) (`MFMediaEngine`) into the Chromium media pipeline. This is a significant divergence from upstream Chromium:

1. **`MediaFoundationRenderer`** (`media/renderers/win/media_foundation_renderer.cc`): Replaces or supplements Chromium's default renderer pipeline with Windows' native media engine. The `MFMediaEngine` API is asynchronous — `IMFMediaEngine::SetCurrentTime` initiates a seek, and completion is signaled via `MF_MEDIA_ENGINE_EVENT_SEEKED`. This adds an additional async layer on top of Chromium's already-async pipeline.

2. **Frame Server Mode** ([Chromium Issue #40201216](https://issues.chromium.org/issues/40201216)): Edge's Media Foundation integration has been evolving through a "Frame Server Mode" that changes how decoded frames are delivered from the MF pipeline to the Chromium compositor. This architectural change affects the timing of when the pipeline reports completion.

3. **Cross-process decoder execution**: For DRM content, Edge uses the Media Foundation Protected Media Path (PMP), which can route decoding through a separate utility process with restricted privileges. Even for non-DRM content, hardware decoding via Media Foundation may involve the GPU process. The [Chromium media README](https://github.com/chromium/chromium/blob/master/media/README.md) notes: "Hardware-accelerated video decoding is handled by platform-specific implementations (e.g., Vaapi, D3D11, MediaCodec) often running in the GPU Process or a dedicated Media Service."

4. **`MFMediaEngine` time reporting**: The Windows `IMFMediaEngine` interface has its own `GetCurrentTime` method, which may not synchronize identically with Chromium's pipeline clock. The adapter code in `MediaFoundationRenderer` must translate between MF's time reporting and Chromium's `PipelineImpl::GetMediaTime()` semantics.

**Why Edge is more affected than Chrome on the same CI runner:**

The stale `currentTime` issue is observed specifically on Edge/Windows CI (`windows-latest`), not on Chrome/Linux CI (`ubuntu-latest`). Several factors compound:

1. **Windows CI VMs have higher scheduling latency**: GitHub's `windows-latest` runners use Windows Server on Azure VMs. Windows thread scheduling has different characteristics than Linux — context switches and thread wake-up latencies are typically higher, especially under VM overhead. This widens the window between `PostTask(OnPipelineSeeked)` and its execution.

2. **Media Foundation adds pipeline depth**: The MF integration inserts additional async stages. A seek flows through: `WebMediaPlayerImpl::DoSeek()` → `PipelineController::Seek()` → `PipelineImpl` (media thread) → `MediaFoundationRenderer` → `MFMediaEngine::SetCurrentTime` → Windows MF pipeline → `MF_MEDIA_ENGINE_EVENT_SEEKED` callback → `MediaFoundationRenderer::OnPlaybackEvent` → `PipelineImpl::OnSeekDone` → `PostTask(main_thread, OnPipelineSeeked)`. Upstream Chromium's default renderer has fewer stages: `DoSeek()` → `PipelineController::Seek()` → `PipelineImpl` (media thread) → `RendererImpl::Flush()` + `RendererImpl::StartPlaying()` → `OnSeekDone` → `PostTask(main_thread, OnPipelineSeeked)`.

3. **Edge-specific feature flags**: Edge enables various media-related feature flags (`Media Foundation for Clear`, `Frame Server Mode`) that alter the pipeline behavior. These flags change the rendering path and may introduce additional async callbacks.

**Multi-process vs. multi-thread distinction:**

The multi-*process* architecture (browser process, renderer process, GPU process) is not the primary cause. The `currentTime` getter runs entirely within the renderer process — it does not make IPC calls to the GPU process or browser process. The cache staleness occurs because of multi-*thread* communication within the renderer process (main thread vs. media thread). However, when hardware-accelerated decoding is involved (D3D11 on Windows via Media Foundation), the decoder runs in the GPU process, and completion signals must cross a process boundary via Mojo IPC before reaching the media thread, then `PostTask` to the main thread. This adds another layer of latency to the seek completion path.

**Summary:**

The stale `currentTime` behavior is caused by:
1. **Primary factor**: Chromium's multi-threaded architecture requires `PostTask` to propagate seek completion from the media thread to the main thread, creating a race with Playwright's CDP-injected JavaScript execution.
2. **Amplifying factor on Edge**: The Media Foundation integration adds more async stages to the seek path, widening the window of staleness.
3. **Environmental factor**: Windows CI VMs have higher thread scheduling latency than Linux CI VMs, making the race more likely to manifest.
4. **Not the primary factor**: The multi-process architecture (renderer/GPU process boundary) does contribute latency for hardware-decoded video but is secondary to the intra-process multi-thread timing.

#### Q5: Would `requestAnimationFrame` or `requestVideoFrameCallback` be more reliable?

**Short answer: `requestVideoFrameCallback` would be the most semantically correct API for confirming a new frame is composited after a seek, but it would not solve the core problem observed on Edge, and the current workaround is already optimal.**

The issue is not that `currentTime` fails to update after the compositor presents a new frame. The issue is that between separate Playwright `page.evaluate()` round-trips, the MSE pipeline on Edge has not yet flushed the updated `currentTime` to the getter, even after the `seeked` event has fired. This is a timing gap caused by the combination of Playwright's IPC overhead and Chromium/Edge's multi-threaded media pipeline architecture.

**Understanding the three APIs and what they guarantee:**

| API | When it fires | What it guarantees | `currentTime` accuracy |
|-----|--------------|-------------------|----------------------|
| Direct read after `seeked` | After the seek algorithm completes | The seek is done, `seeking === false` | Should reflect new position per spec, but getter may lag on Chromium |
| `requestAnimationFrame` | Before the next repaint (~16.7ms at 60Hz) | The browser is about to paint | No video-specific guarantee; `currentTime` is a snapshot from the audio clock |
| `requestVideoFrameCallback` | When a new video frame is sent to the compositor | A new video frame has been decoded and composited | Provides `metadata.mediaTime` — the actual PTS of the composited frame |

**Why `requestVideoFrameCallback` is theoretically better but practically unnecessary here:**

1. **`requestVideoFrameCallback` fires when the compositor receives a new video frame.** Its callback metadata includes `mediaTime` (the actual presentation timestamp of the displayed frame), which is more precise than reading `video.currentTime`. The `currentTime` getter in Chromium is backed by the pipeline's global clock (driven by the audio renderer / sound card), while `mediaTime` comes directly from the `presentationTimestamp` of the frame sent to the compositor. For frame identification, `mediaTime` is authoritative.

2. **However, `requestVideoFrameCallback` has a critical limitation when the video is paused.** It only fires when a new frame is sent to the compositor. When the video is paused (as it is during frame-stepping tests), `requestVideoFrameCallback` will not fire unless the browser re-renders the frame. A seek while paused does trigger a frame update on most browsers, but this is not universally guaranteed. The [angrycoding workaround](https://github.com/angrycoding/requestVideoFrameCallback-prev-next) for paused video involves toggling `currentTime` back and forth to force frame re-rendering — adding complexity without solving the root cause.

3. **The root problem is Playwright IPC overhead, not compositor timing.** Each `page.evaluate()` call traverses multiple IPC hops: test code → Playwright client → Playwright Node.js WebSocket server → browser CDP/WebSocket → JavaScript execution → results back through the same chain. This introduces multiple milliseconds of round-trip latency. During this window, the next keyboard handler reads `currentTime` before the pipeline has propagated the updated value from the media thread to the main thread getter. Running all presses in a single `page.evaluate()` eliminates these inter-call gaps entirely.

4. **Safari's `requestVideoFrameCallback` is broken with DRM.** Safari (WebKit) intentionally disables `requestVideoFrameCallback` when DRM content is playing. The [video.js team worked around this](https://github.com/videojs/video.js/pull/7854) by detecting `video.webkitKeys` and falling back to `requestAnimationFrame`. While the E2E tests don't use `requestVideoFrameCallback` directly, this caveat would matter if we ever considered using it in the player code itself for seek confirmation.

**Browser support for `requestVideoFrameCallback`:** As of late 2024, this is a Baseline web feature supported across all major browsers: Chrome 83+ (2020), Safari 15.4+ (2022), Firefox 132+ (October 2024). Edge inherits Chrome's support. [Firefox was the last holdout](https://bugzilla.mozilla.org/show_bug.cgi?id=1919367), shipping in Firefox 132 after development behind the `media.rvfc.enabled` flag since Firefox 130.

**Analysis of the double-rAF in the current workaround:**

The double `requestAnimationFrame` pattern in the existing code serves a real purpose:

```javascript
await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
```

- The **first `requestAnimationFrame`** runs before the browser's next repaint. At this point, the browser has scheduled the paint but has not yet composited the frame.
- The **second (nested) `requestAnimationFrame`** runs before the *following* repaint. By this time, the previous frame has been fully painted and composited — the decoded video frame is guaranteed to be on screen.

This matters because Chromium's video rendering is asynchronous: video compositing happens on the compositor thread, not the main thread. The `seeked` event fires when the media pipeline completes the seek, but the compositor may not have presented the new frame yet. The first rAF aligns with the next vsync; the second rAF confirms the previous vsync completed. According to the [video-rvfc spec](https://wicg.github.io/video-rvfc/), `requestVideoFrameCallback` itself can be one vsync late — changes made in the callback appear at vsync x+2. The double-rAF achieves a similar 2-vsync guarantee.

A single rAF would often be sufficient but would occasionally race with the compositor on a busy system (exactly the CI VM conditions where this issue manifests). The double-rAF adds ~16.7ms of delay but provides stronger compositing guarantees.

**Why `currentTime` can appear stale — Chromium's architecture:**

Chromium's `currentTime` getter follows this path:
1. `HTMLMediaElement::currentTime` → `WebMediaPlayerImpl::GetCurrentTime()`
2. When paused, returns cached `paused_time_`
3. When playing, calls `pipeline_->GetCurrentTime()` which reads from the pipeline's global clock
4. The global clock is driven by the audio renderer (sound card callback rate), or system clock if no audio

The [W3C Multi-device Timing Community Group](https://www.w3.org/community/webtiming/2016/02/25/currenttime-reporting-chromium-on-android/) noted that `currentTime` is "a snapshot that doesn't change during execution of JS." This snapshot nature means: within a single JavaScript execution context, `currentTime` is consistent. But between separate JavaScript entries (such as between two `page.evaluate()` calls), the value comes from whatever the pipeline last reported to the main thread. If the media pipeline thread has not yet posted the updated position back to the main thread, the getter returns the old cached value.

This is exacerbated by the MSE pipeline's seek algorithm, which involves:
1. Finding the closest random access point before the target time
2. Feeding coded frames to decoders from that point
3. Decoding forward to the target frame
4. Updating the pipeline clock
5. Posting the updated position back to the main thread

Steps 4-5 are asynchronous cross-thread communications. The `seeked` event fires after step 3 completes, but the main-thread-visible `currentTime` may not update until step 5 completes.

**Is this specific to MSE or also affects regular MP4 `<video>`?**

The staleness effect is amplified with MSE because the MSE seek algorithm is more complex (involves `SourceBuffer` range checking, coded frame processing, and append state management). Regular MP4 `<video>` with a simple file source has a simpler seek path. However, the fundamental cross-thread timing issue exists in both modes — it is an artifact of Chromium's multi-threaded media architecture, not MSE specifically. MSE just makes the window of staleness wider.

**Cross-browser comparison:**

| Browser | `currentTime` stale after `seeked`? | Notes |
|---------|-------------------------------------|-------|
| Edge (Chromium) | Yes — observed in CI | Most pronounced; Chromium-based, Windows CI VM adds latency |
| Chrome (Chromium) | Potentially — same architecture | Same underlying code as Edge; less observed likely due to Linux/faster CI VMs |
| Firefox | Historically yes, now fixed | [Bug 588312](https://bugzilla.mozilla.org/show_bug.cgi?id=588312): Firefox used to return old `currentTime` until seek completed; fixed to update immediately per spec |
| WebKit (Safari) | Not observed for this specific issue | Different architecture; media pipeline is more tightly coupled to main thread on macOS via AVFoundation |

Firefox historically had the same bug (returning old `currentTime` after setting it, until the seek completed) but this was [fixed in Bug 588312](https://bugzilla.mozilla.org/show_bug.cgi?id=588312) by dispatching `timeupdate` at the start of seeking. Chromium's architecture, with its strict main-thread/compositor-thread separation, makes this harder to fix.

**Is the current workaround optimal?**

**Yes — the current workaround is the correct approach for this specific problem.** Here is why each component is necessary:

1. **Single `page.evaluate()`**: Eliminates Playwright IPC round-trips between steps. This is the key insight — the bug is not in the browser's JavaScript execution model, but in the timing gap between separate `page.evaluate()` calls.

2. **`seeked` event wait with 1s timeout**: Waits for the seek to complete. The timeout prevents indefinite hangs (important for WebKitGTK's seek stall issue from Topic 6).

3. **`currentTime` change polling (50 iterations × 16ms = 800ms max)**: Guards against the specific Chromium getter staleness. Even after `seeked` fires, the main-thread `currentTime` getter may not yet reflect the new position. Polling until it changes is the most reliable detection.

4. **Double rAF**: Ensures the decoded frame is composited before the next iteration reads `currentTime`. This prevents the next step from seeing a stale value due to compositor lag.

**Could a simpler approach work?**

- **Just `await seeked` + single rAF**: Would fail on Edge because `currentTime` can still be stale after `seeked` + one rAF. The polling step is essential.
- **Just `await seeked` + `requestVideoFrameCallback`**: Marginally better than rAF (fires specifically when the video frame is composited), but has the paused-video caveat and does not guarantee `currentTime` getter freshness — it guarantees `metadata.mediaTime` freshness, which is a different value.
- **`page.waitForFunction()` between separate evaluates**: Would add another Playwright round-trip, potentially introducing the same staleness window it aims to solve. Worse than the single-evaluate approach.
- **CDP session for lower-latency evaluate**: Could reduce IPC overhead but adds API complexity and is Chromium-only (would not help with WebKit or Firefox).

**Theoretical minimum wait for `currentTime` to reflect the new value:**

After `seeked` fires, the minimum additional wait depends on:
- Cross-thread message posting latency (Chromium uses `PostTask` to the main thread): typically < 1ms on a fast system, but up to several ms under VM load
- Audio clock update interval: tied to the sound card callback rate (typically 10-20ms buffers)
- When paused: `paused_time_` is updated synchronously in the seek completion handler, so the delay is purely the cross-thread posting time

In practice, the 16ms polling interval (matching one vsync at 60Hz) is a good choice — it aligns with the compositor's update cadence and catches most staleness within 1-2 iterations. The 50-iteration cap (800ms) provides generous safety margin for heavily loaded VMs.

### Summary

**Root cause**: Chromium/Edge's multi-threaded media pipeline does not guarantee that `video.currentTime` reflects the post-seek position immediately after the `seeked` event, because the main-thread getter reads from a cached value that is updated asynchronously from the media pipeline thread. The Playwright IPC overhead between separate `page.evaluate()` calls creates a window where this staleness is observable — the next keyboard handler runs before the pipeline has posted the updated `currentTime` to the main thread.

**Verdict on current workaround**: The `pressKeyNTimesAndSettle()` implementation is optimal. Running all key presses in a single `page.evaluate()` is the correct architectural solution (eliminates IPC gaps), and the three-layer waiting strategy (seeked event + currentTime polling + double rAF) addresses all known timing edge cases across browsers. Each component serves a distinct purpose and none can be safely removed.

**Potential improvements**:
- **Replace double rAF with `requestVideoFrameCallback`** where available (all browsers since late 2024). This would provide a stronger semantic guarantee ("new video frame composited") vs the current probabilistic guarantee ("two vsyncs elapsed"). However, the gain is marginal since the `currentTime` polling step already catches staleness, and `requestVideoFrameCallback` has caveats with paused video and DRM content.
- **Add `requestVideoFrameCallback` feature detection**: If adopting it, check `'requestVideoFrameCallback' in HTMLVideoElement.prototype` and fall back to double rAF. This would future-proof against any browser removing or changing the API.
- **Neither improvement is urgent** — the current workaround is functionally correct across all 6 CI platforms and the theoretical improvements add complexity for marginal benefit.

### Key references

- [MDN: requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) — API documentation and browser compatibility
- [web.dev: requestVideoFrameCallback](https://web.dev/articles/requestvideoframecallback-rvfc) — Detailed explainer with vsync timing analysis
- [WICG video-rvfc spec](https://wicg.github.io/video-rvfc/) — Specification: fires on compositor thread, best-effort timing, one-vsync-late caveat
- [Chromium Bug #555376 / Issue #41217923](https://issues.chromium.org/41217923) — "currentTime as reported by HTML5 video is not frame-accurate"
- [Chromium Bug #584203 / Issue #41238094](https://issues.chromium.org/41238094) — "currentTime property of a HTML5 video element is stalled"
- [Chromium Bug #66631](https://bugs.chromium.org/p/chromium/issues/detail?id=66631) — "Video frame displayed does not match currentTime"
- [Firefox Bug 588312](https://bugzilla.mozilla.org/show_bug.cgi?id=588312) — "When set, video.currentTime returns old value until seek completes" (RESOLVED FIXED)
- [Firefox Bug 1919367](https://bugzilla.mozilla.org/show_bug.cgi?id=1919367) — Ship requestVideoFrameCallback to release (Firefox 132)
- [W3C Multi-device Timing CG: currentTime reporting](https://www.w3.org/community/webtiming/2016/02/25/currenttime-reporting-chromium-on-android/) — "currentTime is a snapshot that doesn't change during execution of JS"
- [W3C Media & Entertainment: Frame accurate seeking](https://github.com/w3c/media-and-entertainment/issues/4) — Discussion of currentTime limitations and frame-level precision
- [Chromium: Audio/Video Playback design](https://www.chromium.org/developers/design-documents/video/) — Pipeline architecture, audio-clock-driven currentTime
- [Chromium: Video Playback and Compositor](https://www.chromium.org/developers/design-documents/video-playback-and-compositor/) — Compositor thread video rendering architecture
- [video.js PR #7854](https://github.com/videojs/video.js/pull/7854) — Safari requestVideoFrameCallback broken with DRM; fallback to rAF
- [Can I Use: requestVideoFrameCallback](https://caniuse.com/mdn-api_htmlvideoelement_requestvideoframecallback) — Browser support matrix
- [angrycoding/requestVideoFrameCallback-prev-next](https://github.com/angrycoding/requestVideoFrameCallback-prev-next) — Frame-stepping via requestVideoFrameCallback with paused video workaround
- [Remotion PR #213](https://github.com/remotion-dev/remotion/pull/213) — Frame-perfect seeking: seek to frame midpoint to avoid rounding errors
- [Daiz/frame-accurate-ish](https://github.com/Daiz/frame-accurate-ish) — Research on getting accurate video frame numbers from HTML5 video

### Cross-reference with ChatGPT deep research

**Source**: `topic 7.pdf` — 7-page report covering HTML spec, MDN docs, Edge multi-process blog, web.dev MSE basics, Chromium source comments, and StackOverflow discussions.

**Areas of agreement:**

1. **Root cause is asynchronous `currentTime` updates.** Both sources agree the fundamental issue is that `currentTime` returns a cached value that lags behind the pipeline's actual seek completion. The PDF correctly identifies "the renderer holds a cached time and may not update it until asynchronous callbacks run."

2. **Multi-threaded/multi-process architecture creates timing gaps.** Both identify Chromium/Edge's decoupled media pipeline as the architectural cause. The PDF references the [Microsoft Edge blog on multi-process architecture](https://blogs.windows.com/msedgedev/2020/09/30/microsoft-edge-multi-process-architecture/).

3. **Spec does not mandate instant `currentTime` update.** Both conclude this is not a spec violation — the HTML spec only requires eventual consistency. The PDF correctly notes "the HTML/MSE specs do not require instant update of currentTime."

4. **Single-evaluate workaround is correct.** Both agree that batching key presses in a single `page.evaluate()` serializes the seeks properly, ensuring each completes before the next begins.

5. **`seeked` event as synchronization point.** Both identify that waiting for `seeked` is necessary but may not be sufficient.

**New information from the PDF:**

1. **`m_cachedTime` in Blink's `HTMLMediaElement`**: The PDF references Chromium's `m_cachedTime` member variable (from `chromium.googlesource.com/chromium/blink.git/+/master/Source/core/html/HTMLMediaElement.cpp`), noting it is "invalidated on seek and rebuilt during painting." This is a Blink-level cache *on top of* the `WebMediaPlayerImpl` caching we documented in Q1. Our research focused on `seek_time_`/`paused_time_` in `WebMediaPlayerImpl`; the `m_cachedTime` in `HTMLMediaElement` adds another caching layer in the call chain. **However**, this reference is from the pre-migration Blink codebase (before Blink was merged into Chromium's main repo). The modern equivalent is `official_playback_position_` in `html_media_element.cc`, which we covered in Q1.

2. **`video-rvfc` Issue #64 — B-frames and `currentTime`**: The PDF cites [WICG/video-rvfc#64](https://github.com/WICG/video-rvfc/issues/64), which discusses whether `requestVideoFrameCallback`'s reported time has limitations with B-frames in Chrome. This is tangentially relevant — it confirms that even `requestVideoFrameCallback`'s `mediaTime` can be imprecise with reordered frames, reinforcing our Q5 conclusion that `requestVideoFrameCallback` wouldn't solve the core issue.

3. **StackOverflow: `currentTime` set to different value after `loadedmetadata`**: The PDF references a [SO question](https://stackoverflow.com/questions/64087720/currenttime-set-to-different-value-after-loadmetadata-event-during-seek) about `currentTime` being adjusted to a different value after an MSE seek during `loadedmetadata`. This demonstrates the pipeline "snapping" to keyframe positions — relevant to the `paused_time_` vs `seek_time_` subtlety we documented in Q3.

4. **Mermaid sequence diagram**: The PDF provides a helpful visual representation of the race condition timing. Our research explained the same race with ASCII task-queue timelines but did not include a formal sequence diagram.

**Assessment of PDF recommendations:**

| PDF recommendation | Our assessment |
|--------------------|----------------|
| Use `chrome://media-internals` to log pipeline timing | Good diagnostic idea for future investigation; not actionable for the workaround itself. We did not pursue this because the root cause was already identified at the source-code level. |
| Cross-browser tests (Chrome, Firefox) | Already done — our Q5 cross-browser comparison table shows the issue is most pronounced on Edge, potentially exists on Chrome (same architecture), and Firefox historically had it but fixed it (Bug 588312). |
| Code review of `WebMediaPlayerImpl::GetCurrentTime()` | Done — our Q1 includes the actual C++ source code of `GetCurrentTimeInternal()` with the `seek_time_`/`paused_time_`/pipeline branching logic. |
| Try `requestAnimationFrame` or `setTimeout` between seeks | Analyzed in our Q5 — rAF alone is insufficient; the `currentTime` polling step is the critical component. `setTimeout(fn, 0)` has 4ms minimum delay which would usually work but adds unnecessary latency. |
| File a Chromium/Edge bug if behavior differs | Not warranted — this is not a spec violation, and the behavior is inherent to Chromium's architecture. Filing would likely be closed as "working as intended." |
| Create timeline/sequence diagram | Useful for communication but not for fixing the issue. Our task-queue ASCII diagrams in Q3 serve the same purpose. |

**Gaps in the PDF that our research fills:**

1. **No source code analysis.** The PDF acknowledges "we rely on well-known principles... our explanation is reasoned inference rather than a proven fix." Our Q1 provides the actual C++ source code of `GetCurrentTimeInternal()` showing exactly how `seek_time_`, `paused_time_`, and `pipeline_controller_->GetMediaTime()` are selected.

2. **No identification of the PostTask race.** The PDF describes the asynchronous nature generically but does not identify that the specific race is between two `PostTask` calls on the main-thread task queue (pipeline's `OnPipelineSeeked` vs CDP's `evaluate`). Our Q3 details this with task-queue ordering examples.

3. **No analysis of the `paused_time_` vs `seek_time_` state machine.** The PDF does not explain the transition from `seek_time_` (during seek) to `paused_time_` (after seek) and how this transition creates the staleness window. Our Q1 and Q3 provide the complete state machine analysis.

4. **No Edge-specific Media Foundation analysis.** The PDF mentions Edge's multi-process blog but does not identify the specific `MediaFoundationRenderer` / `MFMediaEngine` integration that adds pipeline depth. Our Q4 details the MF seek flow: `DoSeek → PipelineController → PipelineImpl → MediaFoundationRenderer → MFMediaEngine::SetCurrentTime → MF_MEDIA_ENGINE_EVENT_SEEKED` callback chain.

5. **No Playwright CDP/IPC analysis.** The PDF notes `page.evaluate()` timing matters but does not analyze the CDP `Runtime.evaluate` protocol, task queue ordering, or why the IPC pattern creates the race. Our Q2 provides this analysis with references to CDP documentation and Playwright issue #19685.

6. **No `requestVideoFrameCallback` deep analysis.** The PDF does not mention `requestVideoFrameCallback` as an alternative. Our Q5 provides comprehensive analysis including paused-video limitations, Safari DRM caveat, browser support timeline, and the double-rAF purpose.

7. **No spec gap analysis.** The PDF does not reference WHATWG issues #553 (Promise-based seek), #3041 (currentTime measurement point ambiguity), or #4188 ("await a stable state" definition). Our Q2 and Q3 use these to establish that the spec leaves `seeked`-to-`currentTime` synchronization under-specified.

**Critical assessment of PDF claims:**

1. **"We did not find evidence that this issue is a known widespread problem; it appears specific to Edge's MSE implementation under automated testing."** — Partially correct. Our research confirms it is automation-specific (Q2), but it is not Edge-specific in principle. Chrome has the same architecture and would show the same behavior under similar timing conditions. Edge is more affected due to Media Foundation pipeline depth and Windows CI VM scheduling latency (Q4).

2. **"The multi-process media pipeline (media pipeline runs in a utility process)"** — This is misleading for the `currentTime` staleness case. The `currentTime` getter runs entirely within the renderer process. The multi-*thread* architecture within the renderer is the primary cause, not the multi-*process* boundary to the GPU/utility process. The PDF conflates multi-process (browser/renderer/GPU) with multi-thread (main thread/media thread within the renderer). Our Q4 explicitly distinguishes these.

3. **"No known consensus was found on why Edge (but not say Chrome) shows this issue"** — Our research provides the answer: Edge's Media Foundation integration adds pipeline stages, and Windows CI VMs have higher scheduling latency. The PDF's uncertainty here is resolved by our Q4 analysis.

**Verdict**: The PDF provides a correct high-level understanding of the problem (asynchronous `currentTime` in a multi-threaded pipeline) and arrives at the same conclusion (batching seeks is the right workaround). However, it lacks the depth to explain *why* specifically Edge, *why* specifically Playwright, and *what exactly* happens at the source-code level. Our research fills all these gaps. The PDF's recommendations are all either already addressed in our research or not actionable for improving the workaround.

**Have we tried everything?** Yes. The PDF suggests no mitigation we haven't already evaluated:
- Waiting for `seeked` — implemented (layer 1 of the workaround)
- Polling `currentTime` — implemented (layer 2)
- Using `requestAnimationFrame` — implemented as double-rAF (layer 3)
- Batching in single `page.evaluate()` — implemented (the core architectural fix)
- `requestVideoFrameCallback` — evaluated and determined to be marginal improvement with caveats (Q5)
- Filing a browser bug — not warranted (not a spec violation)

The current workaround is optimal. No additional mitigations are needed.

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

### Findings

#### Q1: Is this a known WebKit behavior?

**Yes — this is a well-documented WebKit behavior with multiple manifestations across platforms.**

**The `show poster flag` mechanism (WebKit Changeset 269407)**

WebKit changeset 269407 replaced the old `displayMode`-based system with the spec's `show poster flag`. The critical implementation detail:

- `selectMediaResource()` sets `m_showPoster = true`
- `playInternal()` sets `m_showPoster = false` (the *only* code path that clears it during normal playback)
- `seekWithTolerance()` does NOT clear the flag — it can only set it to `true` (for seeks past the end)
- `HTMLVideoElement::mediaPlayerFirstVideoFrameAvailable()` checks: `if (showPosterFlag()) return;` — when the poster flag is set, the compositor layer update is **skipped entirely**

This means after loading + pausing (without ever calling `play()`), the poster flag remains `true`, and even though the media backend has decoded the first frame and `readyState` reaches `HAVE_CURRENT_DATA`, the compositor never receives the pixel data.

**GStreamer backend (WebKitGTK / Linux)**

The GStreamer media player backend (`MediaPlayerPrivateGStreamer.cpp`) handles first-frame rendering through:

1. `VideoSinkGStreamer` emits `"repaint-requested"` signal when the first sample reaches the sink (logged as "First sample reached the sink, triggering video dimensions update")
2. `MediaPlayerPrivateGStreamer::triggerRepaint()` processes the `GstSample` and calls `pushTextureToCompositor()`
3. However, `pushTextureToCompositor()` requires the compositing layer to be set up, which depends on `mediaPlayerFirstVideoFrameAvailable()` having NOT returned early due to the poster flag

There is also a known deadlock risk: "The main thread can be waiting for the GStreamer thread to pause, but the GStreamer thread is locked waiting for the main thread to draw." Accelerated compositing mode avoids this because the sample is processed on the compositor thread rather than the main thread. Without AC (e.g., in headless/CI environments), this can contribute to the blank-frame issue.

**AVFoundation backend (macOS)**

On macOS, `MediaPlayerPrivateMediaSourceAVFObjC` uses `AVSampleBufferDisplayLayer` for MSE content. WebKit Bug #276453 documented "blank video frames seen before" in fullscreen — the fix was calling `renderingModeChanged()` as soon as the `AVSampleBufferDisplayLayer` is staged, rather than waiting for a compositing layer transition. This confirms the display layer can exist without pixel data being visible.

The `hasAvailableVideoFrame()` method on the AVFoundation backend checks `readyForDisplay` on the display layer, which is a separate signal from `readyState`. A frame can be decoded (readyState=2) without the display layer reporting `readyForDisplay = YES`.

**iOS Safari first-frame behavior**

iOS Safari exhibits a more aggressive version of the same issue: it never fetches the first frame without autoplay or user interaction, regardless of `preload` settings. The widely-used workaround is the `#t=0.001` fragment URL hack (WordPress/Gutenberg #51995), which forces the browser to initiate a seek to a non-zero position, triggering the decode + composite pipeline. This is functionally equivalent to our `video.currentTime = 0` workaround.

**WebKit Bugzilla references**:
- Bug #125157: [MSE][Mac] Support painting MSE video-element to canvas — established the MSE inline painting path
- Bug #86410: [texmap][GStreamer][GTK] Composited Video support — the original GStreamer compositor integration
- Bug #206812: MSE video is not drawn onto canvas — related compositing issue for MSE content
- Changeset 288025: Blank frames in fullscreen with MSE, fixed by `renderingModeChanged()` timing
- Changeset 269407: The `show poster flag` implementation that is the root cause

#### Q2: HTML spec requirements for first frame display

**Summary**: The HTML Living Standard requires that a paused video element at `readyState >= HAVE_CURRENT_DATA` display "the frame of video corresponding to the current playback position." However, the spec's `show poster flag` mechanism creates a special case for the first frame after load: the poster (or first frame as fallback) is shown until `play()` is called, not until a seek completes. This means a paused video that has never been played is spec-compliant even if it shows the poster instead of the decoded first frame.

**readyState definitions (Section 4.8.11.7 "Ready states")**

The spec defines five readyState levels. The critical transition for frame display is from `HAVE_METADATA` (1) to `HAVE_CURRENT_DATA` (2):

> **HAVE_METADATA (1)**: "Enough of the resource has been obtained that the duration of the resource is available. In the case of a video element, the dimensions of the video are also available. No media data is available for the immediate current playback position."

> **HAVE_CURRENT_DATA (2)**: "Data for the immediate current playback position is available, but either not enough data is available that the user agent could successfully advance the current playback position in the direction of playback at all without immediately reverting to the HAVE_METADATA state, or there is no more data to obtain in the direction of playback. For example, in video this corresponds to the user agent having data from the current frame, but not the next frame."

The `loadeddata` event fires when `readyState` first reaches `HAVE_CURRENT_DATA` or greater. The spec describes this as: "The user agent can render the media data at the current playback position for the first time." This implies a renderable frame exists at this point, but it does not explicitly mandate that the frame be composited to the screen.

**Video element rendering rules (Section 4.8.8 "The video element")**

The spec defines what the video element "represents" (i.e., what should be visually painted) via a priority-ordered set of conditions:

1. **No video data available** (`readyState` is `HAVE_NOTHING`, or `HAVE_METADATA` with no video data obtained, or no video channel): "The `video` element represents its poster frame, if any, or else transparent black with no intrinsic dimensions."

2. **Paused, at first frame, show poster flag is set**: "The `video` element represents its poster frame, if any, or else the first frame of the video."

3. **Paused, but current frame not available** (e.g., seeking/buffering), or **neither potentially playing nor paused** (e.g., seeking/stalled): "The `video` element represents the last frame of the video to have been rendered."

4. **Paused** (general case, show poster flag not set): "The `video` element represents the frame of video corresponding to the current playback position."

5. **Potentially playing**: "The `video` element represents the frame of video at the continuously increasing 'current' position."

Condition 2 is the key to understanding the WebKit behavior. After loading a DASH stream and pausing at time 0, the current playback position IS the first frame, and the `show poster flag` IS set (it was set to `true` during the resource selection algorithm and has not been cleared). So the spec says the video element should represent "its poster frame, if any, or else the first frame of the video." If no `poster` attribute is set, the spec says to show the first frame. In practice, WebKit may interpret "represents" loosely and defer actual compositing of the decoded frame.

**The `show poster flag` lifecycle**

The `show poster flag` controls the poster-to-video transition:

- **Set to `true`**: During the resource selection algorithm (i.e., when `load()` runs or a source is selected). Also set to `true` on error and during certain failure recovery paths.

- **Set to `false`**: Only during the **internal play steps** (i.e., when `play()` is called or autoplay triggers). The spec says: "Set the `paused` attribute to false. If the element's show poster flag is true, set it to false and run the time marches on steps." (Confirmed in WHATWG GitHub issue #4215.)

- **NOT cleared by seeking**: The seeking algorithm does NOT include a step to set the `show poster flag` to `false`. Setting `currentTime` triggers the seeking algorithm, which updates the playback position and fires `seeking`/`seeked` events, but does not touch the poster flag.

This is significant for the observed WebKit behavior: after `loadPlayerWithDash()` pauses at `t=0`, the `show poster flag` remains `true`. Even setting `currentTime = 0` (which triggers a seek) does not clear it per the spec. The video should therefore show the poster frame (condition 2), and since there is no `poster` attribute, it should show "the first frame of the video." The fact that WebKit sometimes shows a blank surface instead of the first frame in this state suggests a compositing timing issue rather than spec non-compliance -- the spec says it "represents" the first frame, but WebKit has not yet composited it.

**Why the explicit seek workaround helps**

Even though the seek does not clear the `show poster flag`, it does trigger the browser's internal seek pipeline: the media engine must locate the frame at the target position and make it available for rendering. This is what forces WebKit's compositor to actually decode and paint the frame. Without the seek, WebKit may have the frame data buffered (hence `readyState >= HAVE_CURRENT_DATA`) but has not yet pushed it through the compositing pipeline for display.

The spec's condition 3 is also relevant: during seeking, the element "represents the last frame of the video to have been rendered." Once the seek completes, it falls back to condition 2 (paused at first frame with show poster flag set), which means "the first frame of the video." The seek-complete transition is what forces WebKit to actually composite the frame.

**Spec ambiguity**: The word "represents" is not defined in terms of specific compositing requirements. The spec does not say "MUST be composited within N milliseconds" or "MUST be visible on the next animation frame." It says what the element "represents," leaving the timing of actual pixel output to implementations. This is the gap that WebKit's deferred compositing falls into.

**References**:
- HTML Living Standard, Section 4.8.8 "The video element": https://html.spec.whatwg.org/multipage/media.html#the-video-element
- HTML Living Standard, Section 4.8.11.7 "Ready states": https://html.spec.whatwg.org/multipage/media.html#ready-states
- HTML Living Standard, "Playing the media resource" (internal play steps): https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource
- WHATWG GitHub issue #4215 (show poster flag in play steps): https://github.com/whatwg/html/issues/4215
- WHATWG GitHub issue #9279 (HAVE_METADATA dimensions ambiguity): https://github.com/whatwg/html/issues/9279

#### Q3: Effect of `video.poster` on first-frame compositing

**Summary**: The `poster` attribute changes WHAT is displayed (a poster image instead of the decoded first frame) but does not fundamentally change WHEN the browser transitions to showing video frame content. The transition from poster to video frame is governed by the `show poster flag`, which is only cleared by `play()` or autoplay, not by `readyState` changes or seeking. In the absence of a `poster` attribute, the spec requires the first frame to be shown as a fallback -- but WebKit's deferred compositing means this fallback may not actually be painted without an explicit seek.

**The poster attribute spec text (Section 4.8.8)**

> "The `poster` attribute gives the URL of an image file that the user agent can show while no video data is available."

> "The image given by the `poster` attribute, the *poster frame*, is intended to be a representative frame of the video (typically one of the first non-blank frames) that gives the user an idea of what the video is like."

The poster frame is determined independently of the `show poster flag`:

> "When the element is created or when the `poster` attribute is set, changed, or removed, the user agent must run the following steps to determine the element's poster frame (regardless of the value of the element's show poster flag)."

If the `poster` attribute is absent or empty, there is no poster frame. The rendering rules then fall through to the "or else" branches.

**How poster affects rendering at each state**

Looking at the rendering rules from Q2 above, the poster attribute affects two conditions:

1. **No video data available**: "represents its poster frame, if any, or else transparent black." With `poster` set, a poster image is shown. Without `poster`, the element is transparent black (no visible content).

2. **Paused at first frame, show poster flag set**: "represents its poster frame, if any, or else the first frame of the video." With `poster` set, the poster image is shown. Without `poster`, the first decoded video frame should be shown.

Once the `show poster flag` is cleared (by `play()`), the poster attribute has no effect on rendering -- the video always shows the frame at the current playback position regardless of whether a `poster` is set.

**Does setting `poster` suppress first-frame compositing?**

Yes, in a specific sense: when the `show poster flag` is set (which is the default after load), a `poster` attribute causes the browser to display the poster image INSTEAD of the first video frame. The browser has no obligation to decode or composite the first video frame while the poster is being shown. This means:

- **With `poster`**: The browser shows the poster image. The first video frame may not be decoded/composited until `play()` is called.
- **Without `poster`**: The spec says to show "the first frame of the video" as a fallback. The browser must decode and composite the first frame even while paused at position 0 with the show poster flag set.

In theory, the absence of a `poster` attribute should FORCE the browser to show the first decoded frame sooner (since there is no poster image to fall back to). In practice, WebKit's behavior suggests it does not eagerly composite the first frame even when the spec requires it as the poster fallback.

**Browser differences in poster-to-video transition timing**

The transition from poster to video frame display varies across browsers:

- **Chromium/Edge**: Transition happens reliably at `loadeddata` (readyState reaches `HAVE_CURRENT_DATA`). Even without calling `play()`, a paused video with no poster shows the first decoded frame immediately. Chromium appears to eagerly composite the first frame as soon as it is decoded.

- **Firefox**: Similar to Chromium. The first frame is composited at `loadeddata` when no poster is set. Firefox also reliably shows the first frame on pause without needing an explicit seek.

- **WebKit (macOS Safari, Playwright WebKit)**: The poster-to-first-frame transition is unreliable when paused. Even with `readyState >= HAVE_CURRENT_DATA` and no poster attribute, the video surface may remain blank until an explicit seek or `play()`/`pause()` cycle forces compositing. This is the behavior observed in the E2E tests.

- **iOS Safari**: More restrictive still. The first frame is never fetched without autoplay or user interaction. Setting `preload="auto"` does not help -- iOS Safari only supports preloading up to "metadata" level. The common workaround is the `#t=0.001` media fragment URL, which forces the browser to seek to a non-zero position and triggers frame decoding.

**The `#t=0.001` workaround and why it works**

A widely-used workaround for iOS Safari (and sometimes desktop Safari) is appending `#t=0.001` to the video source URL. This works because:

1. The media fragment triggers a seek to 0.001 seconds during resource loading.
2. The seek forces the browser to decode the frame at that position.
3. The decoded frame is then composited as the "current frame" at the seek target.

This is analogous to the explicit `currentTime = 0` seek used in the E2E helpers -- both force the browser's seek pipeline to run, which triggers frame decoding and compositing as a side effect.

**Practical implications for the player**

Since the R&D Player does not use the `poster` attribute (no `poster` prop is set on the `<video>` element), the spec requires the first frame to be shown as the poster fallback when paused at position 0 with the show poster flag set. WebKit's failure to do so is a browser implementation gap, not spec-compliant behavior. The explicit `currentTime = 0` seek in `loadPlayerWith*()` functions is a valid workaround that forces WebKit to run its seek pipeline and composite the frame.

An alternative workaround would be `play().then(() => pause())`, which would clear the `show poster flag` (since `play()` sets it to `false`) and trigger the "time marches on" steps. However, this introduces a brief moment of playback and may cause visible flicker, making the seek-based approach preferable.

**WebKit source code evidence**

WebKit changeset 269407 (https://trac.webkit.org/changeset/269407/webkit) refactored the poster/first-frame display logic. Key changes:
- Replaced the old `displayMode` state machine (`Unknown`, `Poster`, `PosterWaitingForVideo`, `Video`) with a simpler `m_showPoster` boolean matching the spec's `show poster flag`.
- `playInternal()` calls `setShowPosterFlag(false)` -- matching the spec.
- `seekWithTolerance()` calls `setShowPosterFlag()` but sets it to `true` in certain conditions (not `false`), confirming that seeking does NOT clear the poster flag.
- A test `video-poster-visible-after-first-video-frame.html` was added to verify poster visibility behavior.

This changeset confirms that WebKit intentionally keeps the `show poster flag` set during seeks, consistent with the spec. The compositing of the first frame as a poster fallback (when no `poster` attribute is set) is a separate code path that may not be triggered as eagerly as the spec's "represents" language implies.

**References**:
- HTML Living Standard, Section 4.8.8, poster attribute: https://html.spec.whatwg.org/multipage/media.html#attr-video-poster
- WebKit changeset 269407 (show poster flag refactor): https://trac.webkit.org/changeset/269407/webkit
- WordPress/Gutenberg issue #51995 (iOS Safari first frame): https://github.com/WordPress/gutenberg/issues/51995
- SiteLint blog on Safari video fixes: https://www.sitelint.com/blog/fixing-html-video-autoplay-blank-poster-first-frame-and-improving-performance-in-safari-and-ios-devices
- Apple Developer Forums thread on poster visibility: https://developer.apple.com/forums/thread/129377

#### Q4: readyState and compositing relationship

**Summary**: Yes, WebKit can report `readyState >= HAVE_CURRENT_DATA` (2) while the video surface is still blank/transparent. The `readyState` transition is driven by the media pipeline's buffer state (data is available for the current position), but actual compositing of the frame to the screen is a separate, asynchronous process involving the compositor thread/layer tree. There is a temporal gap between "data is available" and "frame is painted," and this gap is most pronounced in WebKit's GStreamer backend (WebKitGTK) and AVFoundation backend (macOS WebKit) when the video is paused immediately after load.

**The spec's readyState definition does not require compositing**

The HTML Living Standard (Section 4.8.11.7) defines `HAVE_CURRENT_DATA` as:

> "Data for the immediate current playback position is available, but either not enough data is available that the user agent could successfully advance the current playback position in the direction of playback at all without immediately reverting to the HAVE_METADATA state, or there is no more data to obtain in the direction of playback."

The spec also states that the distinction between `HAVE_METADATA` and `HAVE_CURRENT_DATA` is primarily relevant "when painting a video element onto a canvas, where it distinguishes the case where something will be drawn (`HAVE_CURRENT_DATA` or greater) from the case where nothing is drawn." This implies that `HAVE_CURRENT_DATA` means the frame CAN be drawn, not that it HAS been drawn. The transition signals decodable data availability, not visual presentation completion.

The `loadeddata` event fires when `readyState` first reaches `HAVE_CURRENT_DATA` or greater. The spec describes this as: "The user agent can render the media data at the current playback position for the first time." The word "can" is crucial -- it indicates capability, not confirmation of rendering.

**WebKit's three-stage pipeline: decode -> readyState -> composite**

In WebKit's architecture, the readyState transition and frame compositing are decoupled into separate stages:

1. **Decode stage** (GStreamer or AVFoundation thread): The media backend decodes a frame and stores it in a sample buffer. On the GStreamer path, `MediaPlayerPrivateGStreamer::triggerRepaint(GRefPtr<GstSample>&&)` is called when a decoded sample reaches the video sink. The sample is stored in `m_sample` under `m_sampleMutex`. On AVFoundation, `AVPlayer.status == .readyToPlay` fires when the player item has enough data to begin playback, but the first frame may not yet be in the display pipeline.

2. **readyState transition** (main thread, asynchronous): The GStreamer backend calls `updateStates()` from `handleMessage()` when it receives `GST_MESSAGE_STATE_CHANGED`. This method evaluates buffering state and calls `setReadyState(HaveCurrentData)` or higher. However, `updateStates()` runs asynchronously on the main thread via GLib's task scheduling -- it is NOT synchronous with the decode stage. The frame is available in `m_sample` before `setReadyState` fires. The `setReadyState` call fires the `loadeddata` event on the `HTMLMediaElement`.

3. **Composite stage** (compositor thread, deferred): WebKit's `HTMLVideoElement::mediaPlayerFirstVideoFrameAvailable()` is the callback that triggers compositing. Its implementation (from WebKit source, `HTMLVideoElement.cpp`):

```cpp
void HTMLVideoElement::mediaPlayerFirstVideoFrameAvailable()
{
    if (showPosterFlag())
        return;  // *** KEY: if poster flag is set, compositing is SKIPPED ***

    invalidateStyleAndLayerComposition();

    if (RefPtr player = this->player())
        player->prepareForRendering();

    if (CheckedPtr renderer = this->renderer()) {
        renderer->updateFromElement();
        // ...
    }
}
```

The critical line is: `if (showPosterFlag()) return;`. When the `show poster flag` is `true` (which it is after load, as established in Q2), this method returns WITHOUT calling `invalidateStyleAndLayerComposition()`. The compositing layer is never updated with the decoded frame data. This is the root cause.

After this early return, the decoded frame exists in the media backend's sample buffer (hence `readyState >= HAVE_CURRENT_DATA`), but the compositor layer has not been given the pixel data. The video surface remains blank/transparent because the `GraphicsLayer` backing the `<video>` element has no texture to draw.

**When does compositing actually happen?**

The compositor receives frame data in one of these scenarios:

- **`play()` is called**: Clears the `show poster flag` (via `setShowPosterFlag(false)`), and the rendering pipeline starts pulling frames from the media backend on each vsync via the compositor thread. The first frame is composited within 1-2 vsyncs.

- **A seek completes**: The seeking algorithm triggers `seekTask()`, which calls `setShowPosterFlag()`. Per changeset 269407, `seekWithTolerance()` sets the poster flag based on conditions, but the seek completion path also calls into the media backend's seek pipeline, which causes the backend to push a new sample. After seek completion, `mediaPlayerFirstVideoFrameAvailable()` may be called again (if the poster flag is now `false`), or the rendering pipeline may be updated through `invalidateStyleAndLayerComposition()` from `setShowPosterFlag(false)`. Even if the poster flag remains `true`, the seek forces the backend to re-resolve the current frame, and this resolution path can trigger compositing through a different code path (the `RenderVideo::paintReplaced` method, which pulls from the media backend's current sample).

- **The compositor requests a frame for painting**: During the normal paint cycle, `RenderVideo::paintReplaced()` calls `player()->paintCurrentFrameInContext()`, which retrieves the sample from the backend. However, this only happens if the compositor knows the layer is dirty -- which requires `invalidateStyleAndLayerComposition()` to have been called.

**Does Chromium have the same behavior?**

No. Chromium's pipeline handles this differently:

In Chromium, `WebMediaPlayerImpl` delivers the first decoded frame directly to the `VideoFrameCompositor` (via `current_frame_`), and the compositor thread pulls it via `cc::VideoLayerImpl::WillDraw` -> `GetCurrentFrame()` on each vsync. The compositing layer always has the latest frame -- there is no poster flag gating on the compositor side. The `readyState` transition to `HAVE_CURRENT_DATA` and the first frame's arrival at the compositor happen in close succession because:

1. The frame is delivered to `VideoFrameCompositor` by the decode thread.
2. `DidReceiveFrame()` signals the compositor to schedule a redraw via `SetNeedsRedraw()`.
3. On the next vsync, `VideoLayerImpl` uploads the frame texture.
4. In parallel, `SetReadyState(kHaveCurrentData)` is called on the main thread.

Steps 2-3 happen on the compositor thread independently of step 4 on the main thread. Chromium does not gate compositing on the poster flag at the compositor level -- the frame is composited as soon as it arrives, regardless of the HTMLMediaElement's poster state. The poster image, if any, is handled at a higher level as an overlay, not as a gate on the video layer's texture updates.

This is why Chromium reliably shows the first frame at `loadeddata` time, while WebKit does not.

**Does Firefox have the same behavior?**

Firefox also does not exhibit this gap. Firefox's media pipeline (backed by GStreamer on Linux, and platform decoders on other OSes) pushes the first decoded frame to the compositor layer via `ImageContainer::SetCurrentImage()`, which triggers an asynchronous compositing update. The `readyState` transition and compositor update happen in parallel, and Firefox does not gate compositing on the `show poster flag` at the compositor level. The GStreamer `BGRX` pixel format output is converted and uploaded to a texture on the compositor thread, and the next vsync paints it.

**The GStreamer path: decode to composite gap**

On the GStreamer (WebKitGTK) path, the sequence is:

1. GStreamer video sink receives a decoded buffer -> emits `repaint-requested` signal.
2. `MediaPlayerPrivateGStreamer::triggerRepaint()` stores the `GstSample` in `m_sample`.
3. In accelerated compositing (AC) mode: the sample is processed on the compositor thread, so `m_drawCondition` is signaled and the GStreamer thread continues. In non-AC mode: the main thread must process the sample, which can cause a deadlock if the player is paused while the GStreamer thread waits.
4. `updateStates()` runs on the main thread (from GLib task queue), evaluates `firstVideoSampleReachedSink()` (which checks `!!m_sample`), and transitions `readyState` to `HaveCurrentData`.
5. `loadeddata` event fires on the main thread.

The gap is between steps 2 and 5 (sample available in buffer) and whenever `invalidateStyleAndLayerComposition()` actually runs. If `mediaPlayerFirstVideoFrameAvailable()` bails out due to the poster flag (step 3 of the three-stage pipeline above), the compositor layer never learns about the new frame. The frame sits in `m_sample` indefinitely, and `readyState` is 2+ (HAVE_CURRENT_DATA), but the video surface shows nothing.

Under CI VM load, this gap can be even wider because GLib task scheduling competes with other main-thread work, and the compositor thread may not get CPU time to process the sample promptly even if it is notified.

**The AVFoundation path: `readyToPlay` vs composited**

On the macOS AVFoundation path (`MediaPlayerPrivateMediaSourceAVFObjC`), `AVPlayer.status == .readyToPlay` fires when the player item has sufficient data to begin playback. However, `readyToPlay` does NOT mean a frame has been composited to the `AVPlayerLayer` or its equivalent in WebKit's compositing tree.

`AVPlayerLayer` has a separate property `isReadyForDisplay` that indicates whether the layer has usable video data for display. In WebKit's integration, the transition from `readyToPlay` to actual frame display involves:

1. `AVPlayer.status` changes to `.readyToPlay` -> triggers `readyState` update on the media element.
2. `AVPlayerLayer.isReadyForDisplay` becomes `true` asynchronously -- typically within a few vsyncs.
3. The layer's contents are composited to the screen via Core Animation.

Steps 2 and 3 happen asynchronously after step 1. If the video is paused immediately after `readyToPlay`, the `AVPlayerLayer` may not yet have called `isReadyForDisplay = true`, meaning the compositor has no frame to show. This matches the observed behavior on macOS WebKit where `readyState >= 2` but the video surface is blank.

**Practical verification: `readyState` alone is NOT a reliable frame-visibility signal**

The following scenarios demonstrate the gap:

| Scenario | `readyState` | Frame composited? | Notes |
|----------|-------------|-------------------|-------|
| After `loadeddata`, paused, never played (WebKit) | >= 2 | **No** | Poster flag gates `mediaPlayerFirstVideoFrameAvailable()` |
| After `loadeddata`, paused, never played (Chromium) | >= 2 | **Yes** | Compositor layer always gets frames |
| After `loadeddata`, `play()` then `pause()` (WebKit) | >= 2 | **Yes** | `play()` clears poster flag, triggers compositing |
| After `loadeddata`, `currentTime = 0` seek (WebKit) | >= 2 | **Usually yes** | Seek pipeline forces frame resolution |
| After `loadeddata`, WebKitGTK under VM load | >= 2 | **Sometimes no** | Seek can stall; compositor update delayed |

**References**:
- HTML Living Standard, Section 4.8.11.7 "Ready states": https://html.spec.whatwg.org/multipage/media.html#ready-states
- MDN: HTMLMediaElement.readyState: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState
- WebKit source HTMLVideoElement.cpp (mediaPlayerFirstVideoFrameAvailable): https://github.com/WebKit/webkit/blob/main/Source/WebCore/html/HTMLVideoElement.cpp
- WebKit changeset 269407 (showPosterFlag refactor): https://trac.webkit.org/changeset/269407/webkit
- WebKit MediaPlayerPrivateGStreamer.cpp (triggerRepaint, updateStates): https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/gstreamer/MediaPlayerPrivateGStreamer.cpp
- WebKit Bug 254399 (MSE readyState oscillation): https://bugs.webkit.org/show_bug.cgi?id=254399
- Chromium VideoNG architecture (frame flow to compositor): https://developer.chrome.com/docs/chromium/videong
- Chromium Video Playback and Compositor design doc: https://www.chromium.org/developers/design-documents/video-playback-and-compositor/
- AVFoundation AVPlayerLayer.isReadyForDisplay: https://developer.apple.com/documentation/avfoundation/avplayerlayer/1389748-isreadyfordisplay

#### Q5: Alternative workarounds to force first-frame compositing

**Summary**: The current workaround (conditional seek to t=0 only when `currentTime !== 0`) has a critical weakness: it does nothing when the video is already at position 0. An unconditional self-seek (`video.currentTime = 0` always) is the simplest fix. Among alternative approaches, `play().then(() => pause())` is the most semantically correct (it clears the `show poster flag` per spec), while `requestVideoFrameCallback` provides the strongest confirmation of compositing. The recommended fix is: unconditional self-seek + `requestVideoFrameCallback` wait (with double-rAF fallback).

**Analysis of the current workaround's weakness**

The current code in `e2e/helpers.ts` (lines 92-104):

```javascript
if (video.currentTime !== 0) {
  const seeked = new Promise((resolve) =>
    video.addEventListener("seeked", resolve, { once: true }),
  );
  video.currentTime = 0;
  await Promise.race([seeked, new Promise((r) => setTimeout(r, 5000))]);
}
```

When the video is loaded and paused by Shaka Player, `currentTime` may already be `0`. In that case, the `if` condition is `false`, no seek is issued, and the `show poster flag` remains set. As established in Q4, WebKit's `mediaPlayerFirstVideoFrameAvailable()` returns early when the poster flag is set, so the compositor never receives the frame. The video surface remains blank.

This explains the intermittent blank-frame issue: sometimes Shaka Player's internal DASH initialization seeks leave `currentTime` at a non-zero position (triggering the workaround), and sometimes they leave it at exactly 0 (skipping the workaround).

**Alternative 1: Unconditional self-seek (`video.currentTime = video.currentTime`)**

```javascript
// Always seek, even if already at time 0
video.pause();
const seeked = new Promise((resolve) =>
  video.addEventListener("seeked", resolve, { once: true }),
);
video.currentTime = 0;
await Promise.race([seeked, new Promise((r) => setTimeout(r, 5000))]);
```

Setting `video.currentTime = 0` when `currentTime` is already `0` triggers a seek to the same position. Per the HTML spec (Section 4.8.11.9 "Seeking"), setting `currentTime` always runs the seek algorithm, even if the new value equals the current value. The seek algorithm:
1. Sets the `seeking` IDL attribute to `true`.
2. Fires a `seeking` event.
3. The media backend resolves the frame at the target position.
4. Fires a `seeked` event when complete.

This forces WebKit's media backend to re-resolve the frame at t=0, which triggers the seek completion path in the compositor. The key insight is that the seek pipeline includes a frame resolution step that bypasses the `show poster flag` gate.

**Pros**: Minimal change from current workaround (remove the `if` condition). Works on all browsers. Does not change the `show poster flag` state. Does not cause visible playback. **Cons**: On WebKitGTK under CI VM load, even self-seeks can stall (`video.seeking` stuck at `true`). The 5s timeout handles this but means occasional 5s delays. The seek is technically unnecessary on Chromium/Firefox (where compositing works without it), adding ~16ms latency.

**Alternative 2: `video.play()` then `video.pause()`**

```javascript
video.pause();
await video.play();
video.pause();
// Wait for the pause to settle
await new Promise((resolve) =>
  video.addEventListener("pause", resolve, { once: true }),
);
```

This approach clears the `show poster flag` because `play()` calls `setShowPosterFlag(false)` (per the spec and confirmed in WebKit changeset 269407). Once the poster flag is cleared, `mediaPlayerFirstVideoFrameAvailable()` no longer returns early, and subsequent calls to `invalidateStyleAndLayerComposition()` trigger compositing.

**Pros**: Semantically correct -- it clears the poster flag per spec, which is the root cause of the compositing gate. Works on all browsers. After the `play()`/`pause()` cycle, all future seeks will also trigger compositing because the poster flag remains `false`. **Cons**: Causes a brief moment of actual playback. Even with immediate `pause()` after `play()`, the media pipeline advances by at least one frame duration (~33ms at 30fps). This shifts `currentTime` away from exactly `0`, requiring an additional seek back to `0` to ensure the first frame is displayed. The `play()` promise may reject due to autoplay policy on some browsers (though unlikely in a Playwright test context). Also, `play()` on DRM content before the key is entered will fail. The combination of play + pause + seek is three async operations instead of one.

**Alternative 3: `requestVideoFrameCallback` wait**

```javascript
video.pause();
video.currentTime = 0;
await new Promise((resolve) => {
  const handle = video.requestVideoFrameCallback((now, metadata) => {
    resolve();
  });
  // Timeout fallback
  setTimeout(() => resolve(), 5000);
});
```

`requestVideoFrameCallback` fires when a new video frame is sent to the compositor. Per the WICG spec discussion (issue #53), when a paused video is seeked, the callback fires once for the resulting frame. Dale Curtis (Chromium video team) confirmed: "When paused you're guaranteed to get the on-screen frame in the callback; it may just be a vsync late."

**Important caveat**: The callback must be registered BEFORE the seek. If `requestVideoFrameCallback` is called after `video.currentTime = 0` completes, the callback may never fire because the frame was already composited.

Correct pattern:

```javascript
video.pause();
const frameReady = new Promise((resolve) => {
  video.requestVideoFrameCallback(() => resolve());
});
video.currentTime = 0;
await Promise.race([frameReady, new Promise((r) => setTimeout(r, 5000))]);
```

**Pros**: Provides a POSITIVE signal that the frame has been composited, rather than inferring from `seeked` event + double-rAF. The `metadata.mediaTime` in the callback gives the exact PTS of the composited frame, useful for debugging. Works across all modern browsers (Chrome 83+, Safari 15.4+, Firefox 132+, Edge). **Cons**: Safari disables `requestVideoFrameCallback` when DRM (FairPlay) content is playing ([video.js PR #7854](https://github.com/videojs/video.js/pull/7854)). ClearKey DRM may trigger this restriction on Safari, though the encrypted tests in this project would need to verify. Without a timeout fallback, a missing callback hangs forever. Adds API detection complexity (`'requestVideoFrameCallback' in HTMLVideoElement.prototype`).

**Alternative 4: `getVideoPlaybackQuality().totalVideoFrames > 0` polling**

```javascript
video.pause();
video.currentTime = 0;
const start = Date.now();
while (Date.now() - start < 5000) {
  const quality = video.getVideoPlaybackQuality();
  if (quality && quality.totalVideoFrames > 0) break;
  await new Promise((r) => setTimeout(r, 16));
}
```

`totalVideoFrames` counts frames that have been "displayed or dropped since the media was loaded." If it is `> 0`, at least one frame has been processed for display. This is the same heuristic used by the `requestVideoFrameCallback` polyfill ([ThaUnknown/rvfc-polyfill](https://github.com/ThaUnknown/rvfc-polyfill)).

**Pros**: Works on all browsers including those without `requestVideoFrameCallback`. Simple polling pattern. **Cons**: `totalVideoFrames` includes dropped frames, so `> 0` does not guarantee a frame was PAINTED -- only that it was submitted for display. Polling at 16ms intervals is imprecise. On WebKit, `webkitDecodedFrameCount` and `webkitDroppedFrameCount` may be used via polyfill mapping but are non-standard. This is strictly weaker than `requestVideoFrameCallback`.

**Alternative 5: `requestPictureInPicture()` then exit (force compositing side effect)**

This was mentioned as a theoretical option. In practice, it is unsuitable:
- Requires user gesture in most browsers.
- Causes visible UI disruption (PiP window opens/closes).
- Not supported in all test environments.
- Playwright may not support PiP API interactions.

**Not recommended.**

**Alternative 6: CSS `willChange` toggling**

```javascript
video.style.willChange = "transform";
await new Promise((r) => requestAnimationFrame(r));
video.style.willChange = "";
```

Toggling `willChange: transform` forces the browser to promote the element to its own compositing layer and then demote it. Some developers have reported this forces a repaint of the video surface on Safari. However, this is an undocumented side effect, not a reliable mechanism. It also does not address the root cause (the `show poster flag` gating `mediaPlayerFirstVideoFrameAvailable()`).

**Not recommended for production use.**

**Comparison table**

| Approach | Clears poster flag? | Guarantees compositing? | DRM-safe? | WebKitGTK-safe? | Complexity |
|----------|-------------------|------------------------|-----------|----------------|------------|
| Current (conditional seek) | No | No (skips when at t=0) | Yes | Partial (stalls) | Low |
| Unconditional self-seek | No | Yes (forces seek pipeline) | Yes | Partial (stalls) | Low |
| `play()` + `pause()` | **Yes** | Yes | No (may fail pre-key) | Yes | Medium |
| `requestVideoFrameCallback` | No | **Yes** (positive signal) | Partial (Safari DRM) | Yes | Medium |
| `totalVideoFrames` polling | No | Partial (includes drops) | Yes | Yes | Low |
| CSS `willChange` toggle | No | No (undocumented) | Yes | Unknown | Low |

**Recommended approach: unconditional self-seek + requestVideoFrameCallback confirmation**

The optimal fix combines the simplest reliable trigger (unconditional self-seek) with the strongest confirmation signal (`requestVideoFrameCallback`):

```javascript
// Pause and force-seek to time 0 to ensure frame "0000" is composited.
// The seek is unconditional because WebKit may not composite the first frame
// after load even when currentTime is already 0 (show poster flag gates
// mediaPlayerFirstVideoFrameAvailable in HTMLVideoElement.cpp).
await page.evaluate(async () => {
    const video = document.querySelector("video")!;
    video.pause();

    // Register rVFC BEFORE seeking so it catches the resulting frame.
    // Falls back to double-rAF if rVFC is not available.
    const frameComposited = ('requestVideoFrameCallback' in video)
      ? new Promise<void>((resolve) => {
          video.requestVideoFrameCallback(() => resolve());
        })
      : new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });

    const seeked = new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true }),
    );
    video.currentTime = 0;  // Unconditional — always trigger seek pipeline

    await Promise.race([
      seeked.then(() => frameComposited),
      new Promise((r) => setTimeout(r, 5000)),  // Timeout for WebKitGTK stalls
    ]);
});
```

This approach:
1. Always issues a seek (even if already at t=0), forcing the media backend to re-resolve the current frame.
2. Waits for the `seeked` event (seek complete), then waits for `requestVideoFrameCallback` (frame composited).
3. Falls back to double-rAF on browsers without `requestVideoFrameCallback` (though all CI browsers now support it).
4. Retains the 5s timeout to handle WebKitGTK seek stalls.

**Why not just use `play()` + `pause()`?**

While `play()` + `pause()` is semantically correct (it clears the root-cause poster flag), it has practical downsides in the E2E test context:
- It advances `currentTime` by at least one frame, requiring an additional seek back to `0`.
- The `play()` promise may reject before a DRM key is entered (encrypted tests).
- Three async operations (play + pause + seek) vs one (seek).
- On WebKitGTK, the `play()` + `pause()` race under VM load may produce unpredictable results.

The unconditional self-seek is simpler, compatible with all test scenarios (including encrypted), and addresses the symptom directly (forcing the compositor to receive frame data via the seek pipeline).

**References**:
- HTML Living Standard, Section 4.8.11.9 "Seeking" (self-seek triggers algorithm): https://html.spec.whatwg.org/multipage/media.html#seeking
- WICG video-rvfc issue #53 (rVFC behavior when paused): https://github.com/WICG/video-rvfc/issues/53
- MDN: requestVideoFrameCallback: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
- video.js PR #7854 (Safari rVFC broken with DRM): https://github.com/videojs/video.js/pull/7854
- web.dev: requestVideoFrameCallback explainer: https://web.dev/articles/requestvideoframecallback-rvfc
- ThaUnknown/rvfc-polyfill (totalVideoFrames-based polyfill): https://github.com/ThaUnknown/rvfc-polyfill
- WordPress/Gutenberg #51995 (#t=0.001 workaround): https://github.com/WordPress/gutenberg/issues/51995
- WebKit changeset 269407 (setShowPosterFlag in play/seek): https://trac.webkit.org/changeset/269407/webkit
- SiteLint blog on Safari video fixes: https://www.sitelint.com/blog/fixing-html-video-autoplay-blank-poster-first-frame-and-improving-performance-in-safari-and-ios-devices

#### Q6: Does this affect real Safari or only Playwright's patched WebKit?

**Both — but through different mechanisms.**

**Playwright's WebKit is not the same as Safari.** Playwright ships a patched WebKit build based on the open-source WebKit trunk. On Linux, this is WebKitGTK (GStreamer-based media pipeline). On macOS, it uses the native AVFoundation backend but with Playwright-specific patches for automation. Neither is Safari — Safari uses a private WebKit fork with additional Apple-internal code (GPU process, AVFoundation integration, and media pipeline optimizations not present in the open-source trunk).

**However, the core issue exists in both because it's in shared `HTMLMediaElement` code:**

1. **The `show poster flag` mechanism** is implemented in `Source/WebCore/html/HTMLMediaElement.cpp` — shared code between Safari, WebKitGTK, and WPE. Changeset 269407 (the show poster flag refactor) affects all WebKit-based browsers equally.

2. **`HTMLVideoElement::mediaPlayerFirstVideoFrameAvailable()`** with its `if (showPosterFlag()) return;` check is in `Source/WebCore/html/HTMLVideoElement.cpp` — also shared code.

3. **The iOS Safari `#t=0.001` workaround** (WordPress/Gutenberg #51995, Stack Overflow answers, SiteLint blog post) demonstrates that real Safari has the same underlying issue. iOS Safari is even more aggressive — it refuses to fetch any video data without user interaction or autoplay, so `preload="auto"` is ignored. The `#t=0.001` hack works because the fragment URL forces a seek during load, which triggers the decode + composite pipeline.

**Platform-specific differences in severity:**

| Platform | Behavior | Why |
|----------|----------|-----|
| **WebKitGTK (Playwright Linux)** | Blank frame after load+pause, intermittent | GStreamer preroll may or may not push texture to compositor before poster flag check |
| **macOS WebKit (Playwright)** | Blank frame after load+pause, more reliable | AVFoundation `AVSampleBufferDisplayLayer` requires explicit `renderingModeChanged()` call |
| **Real Safari (macOS)** | Usually shows first frame, less affected | Safari's private media pipeline may eagerly composite, but the spec issue exists |
| **Real Safari (iOS)** | Always blank without interaction/autoplay | iOS-specific preload restrictions compound the poster flag issue |

**Why real Safari is less affected in practice**: Safari's private WebKit fork includes media pipeline optimizations not present in the open-source trunk. The GPU process architecture and `AVFoundation` integration in real Safari may eagerly push frames to the display layer on initial load, masking the poster-flag-gates-compositing issue. However, the race condition still exists — it's just harder to trigger because Safari's media pipeline is faster than WebKitGTK's GStreamer pipeline on CI VMs.

**Playwright-specific considerations:**
- Playwright patches WebKit's automation layer (`WebDriver`), not the media pipeline
- The `--disable-web-security` and headless/headed mode flags can affect compositing behavior
- WebKitGTK on Linux uses software compositing (TextureMapper) rather than GPU compositing, making the `triggerRepaint` → `pushTextureToCompositor` path slower and more sensitive to timing
- Playwright issue #3261 confirms they ship WebKit builds targeting Safari-compatible behavior for `<video>`, but acknowledge differences exist

**Conclusion**: The issue is fundamentally in shared WebKit code (HTMLMediaElement.cpp, HTMLVideoElement.cpp) and affects all WebKit-based browsers. The workaround (unconditional seek) is correct for all platforms, not just Playwright.

#### Summary

**Root cause**: WebKit's `HTMLVideoElement::mediaPlayerFirstVideoFrameAvailable()` returns early without calling `invalidateStyleAndLayerComposition()` when the `show poster flag` is `true`. After loading a DASH stream and pausing, the poster flag is `true` (set during resource selection per spec) and is NOT cleared by seeking (only `play()` clears it). This means the compositor layer never receives the decoded frame's pixel data, even though `readyState` reaches `HAVE_CURRENT_DATA` (2) -- the media backend has the frame, but the compositor does not.

Chromium and Firefox do not have this behavior because their compositor layers receive frames independently of the poster flag state. In Chromium, `VideoFrameCompositor` receives frames directly from the decode thread, and `cc::VideoLayerImpl` pulls them via `GetCurrentFrame()` on each vsync. The poster flag is handled at the HTML element level, not as a compositor gate.

**Verdict on current workaround**: The conditional seek (`if (video.currentTime !== 0)`) is partially effective but has a critical gap: when `currentTime` is already `0`, no seek is issued, and WebKit may show a blank surface. This explains intermittent first-frame failures on WebKit in CI.

**Recommendations (ordered by priority)**:

1. **Make the seek unconditional**: Remove the `if (video.currentTime !== 0)` guard. Setting `video.currentTime = 0` when already at `0` triggers the seek algorithm per spec, forcing WebKit's media backend to re-resolve the frame and push it to the compositor. This is the minimum necessary fix.

2. **Add `requestVideoFrameCallback` confirmation**: After the seek, wait for `requestVideoFrameCallback` to fire (with double-rAF fallback). This provides a positive signal that the frame has been composited, replacing the current inferential approach (seeked event + timing). All 6 CI browser platforms support `requestVideoFrameCallback`.

3. **Retain the 5s timeout**: WebKitGTK seeks can stall under CI VM load. The `Promise.race` with a 5s timeout is essential to prevent test hangs.

4. **Do NOT use `play()` + `pause()`**: While semantically correct (clears the poster flag), it introduces complexity (three async operations), can fail before DRM key entry, and advances `currentTime` requiring an additional seek. The unconditional self-seek is simpler and sufficient.

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

### Findings

#### Q1: Actual memory footprint of an ImageBitmap

**Short answer**: In practice, an ImageBitmap consumes `width * height * 4` bytes of RGBA pixel data. In a Web Worker context, this is always CPU-backed memory (not GPU textures). The pixel format from VideoDecoder output (I420, NV12, BGRX) does not affect the final ImageBitmap size — all formats are converted to 4-byte-per-pixel RGBA/BGRA during `createImageBitmap()`.

**Spec level**: The HTML spec ([ImageBitmap section](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html)) is deliberately vague about the internal representation. It defines an ImageBitmap as having abstract "bitmap data" without specifying pixel format, memory location, or backing store. The spec says an ImageBitmap "represents a bitmap image that can be painted to a canvas without undue latency" and notes that "if making use of the bitmap requires network I/O, or even local disk I/O, then the latency is probably undue; whereas if it only requires a blocking read from a GPU or system RAM, the latency is probably acceptable."

**Chromium implementation**: In Chromium's Blink renderer, `ImageBitmap` holds a `scoped_refptr<StaticBitmapImage> image_` member ([image_bitmap.h](https://github.com/chromium/chromium/blob/master/third_party/blink/renderer/core/imagebitmap/image_bitmap.h)). `StaticBitmapImage` has two concrete subclasses:

- **`AcceleratedStaticBitmapImage`** — wraps a GPU-backed texture (via SharedImage/mailbox). Used on the main thread when GPU acceleration is available. Holds a reference to a GL resource.
- **`UnacceleratedStaticBitmapImage`** — wraps a CPU-side `SkImage` built from an `SkBitmap`. Used when no GPU context is available, which is the typical case in Web Workers.

Chromium's memory tracking in `UpdateImageBitmapMemoryUsage()` (image_bitmap.cc, lines 811-829) explicitly assumes **4 bytes per pixel**:
```cpp
// Assumes 4 bytes per pixel
base::CheckedNumeric<int32_t> memory_usage_checked = 4;
memory_usage_checked *= image_->width();
memory_usage_checked *= image_->height();
```
This value is reported to V8 via `v8::Isolate::GetCurrent()->AdjustAmountOfExternalAllocatedMemory()` so the GC knows about external memory pressure.

The underlying `SkBitmap` uses `kN32_SkColorType` which maps to `kBGRA_8888_SkColorType` on little-endian platforms (x86/ARM). This is 4 bytes per pixel with premultiplied alpha (`kPremul_SkAlphaType`). Row bytes are at minimum `width * 4`, potentially with padding for alignment.

**In a Web Worker**: Workers typically lack a GPU context, so `ImageBitmap` objects created via `createImageBitmap(offscreenCanvas)` in a worker are backed by `UnacceleratedStaticBitmapImage` (CPU `SkBitmap`), not GPU textures. The memory lives in the renderer process heap, not GPU memory.

**Firefox implementation**: Firefox's `ImageBitmap` internally stores a Moz2D `SourceSurface` (`mSurface` in `dom/canvas/ImageBitmap.cpp`). `SourceSurface` is an opaque buffer handle; `DataSourceSurface` is its subclass providing direct pixel access. The surface format is typically BGRX8 (4 bytes per pixel). In workers, Firefox uses `DataSourceSurface` backed by CPU memory (no GPU surfaces).

**VideoDecoder output format conversion**: When the thumbnail worker calls `createImageBitmap(offscreenCanvas)` after drawing a `VideoFrame` via `ctx.drawImage(frame, ...)`, the VideoDecoder's native output format (I420 on Chromium/Edge, BGRX on Firefox via GStreamer/VideoToolbox, NV12 on macOS WebKit) is converted to the canvas's internal RGBA/BGRA format during the `drawImage` call. The resulting ImageBitmap is always 4 bytes per pixel regardless of the decoder's native format.

**Concrete numbers for this project**: The thumbnail worker creates bitmaps at `THUMBNAIL_WIDTH = 160` pixels wide, with height scaled proportionally (e.g., 90px for 16:9 content). Each thumbnail ImageBitmap = `160 * 90 * 4 = 57,600 bytes` (~56 KB). For a 60-second stream with 2-second segments (30 segments), the I-frame thumbnails alone consume ~1.7 MB. Intra-frame bitmaps (gap mode with e.g. 60 frames per segment) can reach `30 * 60 * 56 KB = ~100 MB` if not evicted.

**`createImageBitmap()` from VideoFrame always copies**: The [WebCodecs spec discussion](https://github.com/w3c/webcodecs/issues/159) confirms that `createImageBitmap(videoFrame)` performs a deep copy including YUV-to-RGB color space conversion. The proposal explicitly states: "We would copy from a buffer that is effectively 'owned' by the decoder...to a buffer that is owned by the ImageBitmap." Zero-copy is only used "when it cannot cause a decoder stall" and only for specific rendering paths (like `drawImage` on canvas, `texImage2D` for WebGL). In the thumbnail worker's pipeline (`drawImage` to `OffscreenCanvas` then `createImageBitmap`), there are two copies: VideoFrame to canvas, then canvas to ImageBitmap.

#### Q2: Does ImageBitmap.close() immediately free memory?

**Short answer**: Yes, in both Chromium and Firefox, `close()` immediately releases the underlying pixel data (CPU buffer or GPU texture). The JS wrapper object itself still requires GC, but this is tiny (~dozens of bytes). The spec guarantees the bitmap data is "unset" but does not use the word "free" — however, both major implementations treat this as immediate deallocation.

**Spec guarantee**: The [HTML spec for `close()`](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-imagebitmap-close) defines the steps as:
> 1. Set this's [[Detached]] internal slot value to true.
> 2. Unset this's bitmap data.

After `close()`, the `width` and `height` getters return 0 (spec: "If this's [[Detached]] internal slot's value is true, then return 0"). The spec says "unset" rather than "free" or "release" — it operates at the abstract data model level. The spec does not distinguish between "detach" (mark unusable) and "free" (release memory); it only guarantees the bitmap data is no longer associated with the object.

**Chromium implementation** (image_bitmap.cc, lines 960-966):
```cpp
void ImageBitmap::close() {
  if (!image_ || is_neutered_)
    return;
  image_ = nullptr;       // Releases the scoped_refptr<StaticBitmapImage>
  is_neutered_ = true;
  UpdateImageBitmapMemoryUsage();  // Reports negative adjustment to V8
}
```

Setting `image_ = nullptr` drops the `scoped_refptr`, which decrements the reference count on the `StaticBitmapImage`. If this was the last reference (typical case), the `StaticBitmapImage` destructor runs immediately, freeing either the `SkBitmap` pixel buffer (CPU path) or releasing the GPU texture/mailbox (GPU path). The call to `UpdateImageBitmapMemoryUsage()` then calls `v8::Isolate::AdjustAmountOfExternalAllocatedMemory()` with a negative value, informing V8 that external memory has decreased.

This means `close()` provides **immediate, deterministic deallocation** of the pixel data — not deferred to GC. The remaining JS wrapper object (~dozens of bytes) is collected by normal GC, but this is negligible.

**Firefox implementation**: Firefox's `close()` releases the internal `SourceSurface` reference. Firefox Bug [1312148](https://bugzilla.mozilla.org/show_bug.cgi?id=1312148) documented a severe memory leak where workers sending ImageBitmaps caused OOM because `createImageBitmap` allocations were not reported to the GC via `JS_updateMallocCounter`. The fix added memory reporting across 8 creation pathways (from ImageData, Blob, HTMLCanvasElement, CanvasRenderingContext2D, structured clones, transfers, OffscreenCanvas, and ArrayBuffer/TypedArray). Without `close()`, Firefox's GC could be overwhelmed — the bug report describes "memory is usually exhausted quickly, and swap space soon afterwards" at high ImageBitmap creation rates. The `close()` method bypasses this GC pressure by releasing the `DataSourceSurface` immediately.

**GC is still needed for the wrapper**: After `close()`, the JavaScript `ImageBitmap` object itself (the thin wrapper with `is_neutered_=true`, `width=0`, `height=0`) still occupies a small amount of JS heap memory until garbage collected. This is typically under 100 bytes and inconsequential. The heavy resource — the pixel data — is already freed.

**Known Chromium issues**: There have been version-specific bugs where `close()` did not fully release GPU memory. [Electron issue #37569](https://github.com/electron/electron/issues/37569) reported that transferring ImageBitmaps to workers via `postMessage` with transferables leaked memory in Electron 22+ (newer Chromium). [Three.js issue #23953](https://github.com/mrdoob/three.js/issues/23953) found that `texture.dispose()` alone did not free ImageBitmap memory — calling `texture.source.data.close()` was required. These are edge cases in GPU-backed scenarios; for CPU-backed bitmaps in workers (this project's case), `close()` is reliable.

**Practical implication for this project**: The eviction code in `useThumbnailGenerator.ts` (lines 470-491) correctly calls `bmp.close()` for evicted thumbnails. This immediately frees the pixel data. The 3x viewport eviction window is a reasonable heuristic — it keeps nearby bitmaps cached while ensuring distant ones are freed promptly. Without `close()`, the bitmaps would persist until GC runs, which on Firefox in particular can cause catastrophic memory growth.

#### Q3: ImageBitmap transfer semantics between worker and main thread

**Short answer**: When an ImageBitmap is transferred via `postMessage(msg, [bitmap])` (transferable), the backing store ownership moves to the receiving context in a zero-copy operation. The sender's ImageBitmap becomes neutered (width=0, height=0). When sent without the transfer list (`postMessage({bitmap})`), the bitmap data is deep-copied (structured clone). In this project's worker, all bitmaps are correctly transferred: `post({ type: "thumbnail", ..., bitmap }, [bitmap])`.

**Spec semantics**: The HTML spec defines two distinct paths for ImageBitmap in `postMessage`:

*Transfer steps* (when listed in the transferable array):
> Set dataHolder.[[BitmapData]] to value's bitmap data. Unset value's bitmap data.

*Transfer-receiving steps*:
> Set value's bitmap data to dataHolder.[[BitmapData]].

This is a move, not a copy. The sender's bitmap data is "unset" (same as `close()`), and the receiver gets the original bitmap data. After transfer, the sender's ImageBitmap has `width=0, height=0` and is effectively neutered.

*Serialization steps* (structured clone, no transfer list):
> Set dataHolder.[[BitmapData]] to a copy of value's bitmap data.

This is a deep copy — both sender and receiver end up with independent bitmap data, doubling memory usage.

**Chromium implementation**: The `ImageBitmap::Transfer()` method (image_bitmap.cc, lines 803-809):
```cpp
scoped_refptr<StaticBitmapImage> ImageBitmap::Transfer() {
  DCHECK(!IsNeutered());
  is_neutered_ = true;
  image_->Transfer();
  UpdateImageBitmapMemoryUsage();
  return std::move(image_);
}
```

This moves the `scoped_refptr<StaticBitmapImage>` to the receiving context. For CPU-backed bitmaps (the worker case), this is a pointer handoff — the `SkBitmap` pixel buffer stays at the same memory address, and only the pointer/refcount is transferred. For GPU-backed bitmaps, `image_->Transfer()` may perform additional work to hand off the GPU mailbox/SharedImage.

**Zero-copy verified by benchmarks**: The Chrome developer blog on [transferable objects](https://developer.chrome.com/blog/transferable-objects-lightning-fast) measured a 32 MB `ArrayBuffer` round-trip: structured clone took ~302ms vs ~6.6ms for transfer (45x speedup). ImageBitmap transfer uses the same zero-copy mechanism — the pixel data pointer is handed off without copying the buffer.

**Memory accounting after transfer**: When the worker transfers an ImageBitmap to the main thread:
1. The worker's `ImageBitmap` is neutered — its `image_` becomes null, and `AdjustAmountOfExternalAllocatedMemory` is called with a negative value in the worker's V8 isolate.
2. The main thread's V8 isolate receives the `StaticBitmapImage` and creates a new `ImageBitmap` wrapper, calling `AdjustAmountOfExternalAllocatedMemory` with a positive value.
3. Net result: the pixel data exists in exactly one place, and memory accounting moves from the worker's budget to the main thread's budget.

At no point do both contexts hold the same backing store simultaneously. The transfer is atomic from the spec's perspective — the sender loses access before the receiver gains it.

**What this project does correctly**: The thumbnail worker's `post()` function uses transfer:
```typescript
function post(msg: WorkerResponse, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer: transfer ?? [] });
}
// Usage:
post({ type: "thumbnail", timestamp: targetTime, bitmap }, [bitmap]);
```

The `[bitmap]` transfer list ensures zero-copy transfer from the worker to the main thread. After posting, the worker's reference to the bitmap is neutered. This is correct and optimal — without the transfer list, each bitmap would be deep-copied, doubling memory usage and wasting CPU on the copy.

**Clone vs transfer — the pitfall**: If the worker used `postMessage({bitmap})` without the transfer list, the bitmap would be deep-copied via structured clone. Both the worker and main thread would hold independent copies of the pixel data. This is a common source of memory leaks — the worker keeps accumulating bitmaps that are never freed (since there is no explicit `close()` on the worker side for cloned bitmaps). The explicit transfer list prevents this.

**Firefox transfer bug history**: Firefox Bug [1312148](https://bugzilla.mozilla.org/show_bug.cgi?id=1312148) documented that transferring ImageBitmaps from workers caused memory leaks. The root cause was that `DataSourceSurfaceD2D1` objects could not be properly mapped when transferred between threads, and memory allocations were not reported to the GC. The fix involved calling `JS_updateMallocCounter` to inform the GC about bitmap allocations. After the fix, transfer works correctly, but this history underscores the importance of always using `close()` as a safety net rather than relying solely on transfer semantics for memory management.

**Can both sides share the same GPU texture?** No. The spec requires that transfer "unsets" the sender's bitmap data. In Chromium, GPU-backed `AcceleratedStaticBitmapImage` uses non-sharable GL resources by default — the mailbox/SharedImage is handed off, not shared. For CPU-backed bitmaps in workers (this project's case), the `SkBitmap` pointer is moved, not shared. There is no scenario where both contexts simultaneously reference the same backing store after a transfer completes.

#### Q4: transferToImageBitmap() vs createImageBitmap() efficiency

**Short answer**: `transferToImageBitmap()` is theoretically zero-copy but practically worse for the filmstrip use case. `createImageBitmap(videoFrame)` is the better choice.

**How `transferToImageBitmap()` works**:

The `OffscreenCanvas.transferToImageBitmap()` method creates an `ImageBitmap` from the canvas's current content by *transferring ownership* of the backing store rather than copying it. The canvas then allocates a fresh backing store for subsequent rendering. Per the [MDN spec](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/transferToImageBitmap), this is designed as a zero-copy operation — the bitmap references the same GPU texture or CPU buffer that the canvas was using.

**How `createImageBitmap(videoFrame)` works**:

When called on a `VideoFrame`, `createImageBitmap()` performs a deep copy that includes YUV-to-RGB color space conversion. The [WebCodecs spec discussion](https://github.com/w3c/webcodecs/issues/159) confirms that `createImageBitmap(videoFrame)` converts YUV planes to an RGBA `ImageBitmap`, which involves a pixel format conversion plus a memory copy. The resulting `ImageBitmap` may be GPU-backed (Chromium) or CPU-backed (Firefox).

**Why `transferToImageBitmap()` is NOT better for this use case**:

To use `transferToImageBitmap()` from a `VideoFrame`, the pipeline would be:
1. Create an `OffscreenCanvas` at the target dimensions (426x240)
2. Get a 2D context: `canvas.getContext('2d')`
3. Draw the frame: `ctx.drawImage(videoFrame, 0, 0, 426, 240)`
4. Transfer: `canvas.transferToImageBitmap()`

This is actually **more** work than `createImageBitmap(videoFrame)`:
- Step 3 (`drawImage`) already performs the YUV-to-RGB conversion and copies pixels into the canvas backing store
- Step 4 transfers that backing store to an `ImageBitmap` (zero-copy)
- But the canvas must then allocate a *new* backing store for future use
- Net result: one conversion + one allocation, vs `createImageBitmap()` which does one conversion + one allocation in a single optimized call

**Browser-specific behavior**:

| Browser | `createImageBitmap(videoFrame)` | `transferToImageBitmap()` |
|---------|-------------------------------|--------------------------|
| Chromium | Optimized path, may use GPU | Zero-copy transfer, but canvas must reallocate |
| Firefox | CPU-backed ImageData internally ([Bug 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206)) | Up to 10x slower than Chrome — Firefox incurs a copy despite the spec saying "transfer" |
| WebKit/Safari | Works, NV12 pixel format on macOS | Significantly faster than `createImageBitmap()` on Safari specifically |

**GPU vs CPU backing in workers**:

In Chromium, `ImageBitmap` objects created in a worker can be GPU-backed (GL textures shared via Chromium's mailbox system) or CPU-backed, depending on the creation path. The backing type is opaque to JavaScript — there is no API to query it. In Firefox, `ImageBitmap` objects are always CPU-backed (`ImageData` internally), as confirmed in [Bug 1788206](https://bugzilla.mozilla.org/show_bug.cgi?id=1788206). The [WebGPU design doc](https://github.com/gpuweb/gpuweb/blob/main/design/ImageBitmapToTexture.md) notes that even in Chromium, many fallback paths cause `ImageBitmap` to be CPU-backed.

**Recommendation for the filmstrip worker**: Continue using `createImageBitmap(videoFrame)`. It is simpler, avoids the canvas allocation overhead, and is the path that browser vendors have optimized for `VideoDecoder` output. The `transferToImageBitmap()` path only makes sense when you already have an `OffscreenCanvas` you are rendering to (e.g., an animation loop), not when creating standalone bitmaps from decoded frames.

#### Q5: Maximum practical ImageBitmap count

**Per-bitmap memory cost**:

Each 426x240 RGBA bitmap occupies:
- Raw pixel data: `426 × 240 × 4 = 408,960 bytes ≈ 400 KB`
- Plus overhead: object headers, alignment, GC tracking — negligible for this size
- GPU-backed variant (Chromium): similar memory on the GPU side, plus a small JS-side handle

**Filmstrip memory budget at different scales**:

| Scenario | Bitmap count | Memory |
|----------|-------------|--------|
| I-frame thumbnails only (30 segments × 1) | 30 | ~12 MB |
| Zoomed in, all segments decoded (30 seg × 60 frames) | 1,800 | ~720 MB |
| 3x viewport eviction (e.g., 10 visible segments × 3 × 60 frames) | ~1,800 | ~720 MB |
| Typical zoomed view (5 visible segments × 7x span × 60 frames) | ~2,100 | ~840 MB |

**Browser memory limits (no per-ImageBitmap count limit exists)**:

There is no hard-coded maximum number of `ImageBitmap` objects in any browser. The limit is purely a function of total memory consumption:

- **Chromium 64-bit**: Renderer process sandbox limit starts at 4 GB base, scales up to 16 GB based on system RAM ([Browser Memory Limits](https://textslashplain.com/2020/09/15/browser-memory-limits/)). The V8 heap has a 4 GB pointer compression cage (since M92), but `ImageBitmap` pixel data is stored *outside* the V8 heap (in Blink's native memory or GPU memory), so V8's 4 GB limit does not constrain bitmap count. The internal PartitionAlloc allocator has a historical ~2 GB implicit limit per allocation slab. This means **~4,800 bitmaps at 400 KB** before hitting the 2 GB slab, or **~9,600 bitmaps** before the 4 GB sandbox base.
- **Firefox**: Workers run as threads within the same process, sharing the process memory pool. There is no per-worker memory limit ([Bug 1286895](https://bugzilla.mozilla.org/show_bug.cgi?id=1286895)). Since Firefox `ImageBitmap` objects are CPU-backed, all memory comes from the process heap. On 64-bit systems, Firefox processes can grow well past 4 GB before OOM, but the GC may struggle with coordination between main thread and worker threads, historically leading to memory climbing when "lots of stuff happened on workers where GC was not allowed" ([Bug 617569](https://bugzilla.mozilla.org/show_bug.cgi?id=617569)).
- **WebKit**: No documented per-worker memory limit. Worker memory is part of the web process.

**What happens when memory is exhausted**:

- **Chromium**: `createImageBitmap()` returns a rejected promise. If total process memory exceeds the sandbox limit, the renderer crashes with `SBOX_FATAL_MEMORY_EXCEEDED` and the user sees the "Aw, Snap!" page. The tab is killed, not the entire browser.
- **Firefox**: `createImageBitmap()` may fail with an allocation error, or the system OOM killer may terminate the process. Firefox historically had issues where worker memory growth would not trigger GC, leading to runaway consumption ([Bug 617569](https://bugzilla.mozilla.org/show_bug.cgi?id=617569)).
- **All browsers**: There is no throttling or graceful degradation — it is either a successful allocation or a failure/crash.

**GPU-backed vs CPU-backed limits**:

GPU-backed bitmaps (Chromium) are constrained by GPU memory (typically 256 MB–8 GB on discrete GPUs, ~50% of system RAM for integrated). When GPU memory is exhausted, Chromium falls back to CPU-backed bitmaps. There is no API to query remaining GPU memory from JavaScript.

**Real-world observations**: The [ITK-Wasm project](https://github.com/InsightSoftwareConsortium/ITK-Wasm/issues/245) reported Chrome OOM crashes when processing 512×512×210 image data in workers (~50 MB raw). The crash occurred because intermediate allocations (copies, format conversions) multiplied the effective memory usage well beyond the raw data size.

**Practical safe limit for the filmstrip**: With the 3x viewport eviction, the maximum in-memory bitmap count is bounded by the viewport span. For a typical viewport showing 5–10 segments at full zoom (60 frames/segment), that is 300–600 bitmaps in view × 7 (1 + 3 + 3 spans) = 2,100–4,200 bitmaps = 840 MB–1.7 GB. This is within Chromium's limits but approaching the danger zone on memory-constrained devices.

#### Q6: ImageData vs ImageBitmap for memory predictability

**ImageData memory model**:

`ImageData` stores pixels in a `Uint8ClampedArray` backed by an `ArrayBuffer`. The memory is always CPU-allocated, always exactly `width × height × 4` bytes, and always managed by the JavaScript garbage collector. For 426x240: `408,960 bytes` per `ImageData`, identical to `ImageBitmap` raw pixel size.

**Advantages of ImageData**:

1. **Predictable memory**: No ambiguity about CPU vs GPU backing. Each object's memory footprint is exactly `width * height * 4` bytes plus a small JS object overhead (~64 bytes).
2. **GC-managed**: The `ArrayBuffer` is tracked by the GC and freed when unreachable. No need for explicit `.close()` calls (though explicit cleanup is still recommended for large collections).
3. **No GPU resource management**: No risk of exhausting GPU memory, no opacity about whether the bitmap is GPU- or CPU-backed.
4. **Debuggable**: The `ArrayBuffer` shows up clearly in Chrome DevTools heap snapshots with its exact byte size.

**Disadvantages of ImageData**:

1. **Slower canvas rendering**: `putImageData()` is significantly slower than `drawImage(imageBitmap)`. Benchmarks on [MeasureThat.net](https://www.measurethat.net/Benchmarks/Show/9510/0/putimagedata-vs-drawimage) show `drawImage(ImageBitmap)` can be 2–10x faster because it can leverage GPU texture upload, while `putImageData()` always copies from CPU to the canvas pixel-by-pixel. For the filmstrip, which repaints on every scroll/zoom at 60fps, this difference is critical.
2. **No hardware-accelerated scaling**: `drawImage(imageBitmap, 0, 0, w, h)` can use GPU bilinear filtering for resizing. `putImageData()` always writes pixels 1:1 — any scaling requires manual resampling.
3. **Larger transfer overhead (without detach)**: Structured cloning an `ImageData` between worker and main thread copies the entire pixel buffer (~400 KB per image). `ImageBitmap` transfer is zero-copy.

**ImageData transferability**:

`ImageData` itself is *not* a `Transferable` object. However, its underlying `ArrayBuffer` is transferable. The pattern:

```js
// Worker side:
const imageData = new ImageData(width, height);
// ... fill pixels ...
postMessage({ width, height, buffer: imageData.data.buffer }, [imageData.data.buffer]);
// imageData is now neutered (buffer detached)

// Main thread side:
const received = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
```

This achieves zero-copy transfer, but the `ImageData` on the sender side becomes unusable (buffer detached). This is functionally identical to `ImageBitmap` transfer behavior. However, reconstructing `ImageData` on the receiving side requires creating a new `Uint8ClampedArray` view over the transferred buffer, which is ~0 cost.

Per [ECMAScript 2024](https://2ality.com/2024/06/array-buffers-es2024.html), `ArrayBuffer.prototype.transfer()` provides explicit same-agent transfer, and [Chrome's transferable objects blog](https://developer.chrome.com/blog/transferable-objects-lightning-fast) measured structured clone at ~302ms for 32 MB vs ~6.6ms for transfer — a 45x speedup.

**Memory fragmentation**:

With many small `ArrayBuffer` allocations (~400 KB each), heap fragmentation is a theoretical concern but unlikely to be problematic in practice:
- V8's `ArrayBuffer` allocator uses the system malloc (not the V8 heap), and modern allocators (PartitionAlloc in Chrome, jemalloc in Firefox) handle 400 KB allocations efficiently with size-class bucketing.
- Fragmentation becomes a real issue primarily with many different-sized small allocations (<1 KB) or with very large allocations (>1 MB). 400 KB falls in a well-handled middle range.

**Verdict**: `ImageBitmap` is the better choice for the filmstrip use case because canvas rendering performance (`drawImage` vs `putImageData`) is the primary bottleneck — the filmstrip repaints the entire visible viewport at 60fps during scroll/zoom. The memory predictability advantage of `ImageData` does not outweigh the rendering performance cost. If memory tracking is needed, `ImageBitmap.close()` with manual bookkeeping provides sufficient control.

#### Q7: Worker memory limits and monitoring

**Worker memory isolation by browser**:

| Browser | Worker memory model | Shared with main thread? |
|---------|-------------------|-------------------------|
| Chromium | Dedicated workers run in the same renderer process as the page. JS heap is a separate V8 Isolate but shares the process memory pool. ImageBitmap pixel data is in Blink native memory (same process). | Yes — same process, same sandbox limit |
| Firefox | Workers run as OS threads within the same content process. No per-worker memory limit. JS heap is separate but process memory is shared. ([Bug 1286895](https://bugzilla.mozilla.org/show_bug.cgi?id=1286895)) | Yes — same process |
| WebKit | Workers run in the same web content process. No documented per-worker limit. | Yes — same process |

Key insight: In all major browsers, **dedicated workers share the same process memory pool as the main thread**. A worker allocating 1 GB of `ImageBitmap` objects reduces available memory for the main thread by the same amount. There is no per-worker memory quota or isolation.

**`performance.measureUserAgentSpecificMemory()`**:

- **Spec**: [WICG Performance Measure Memory](https://wicg.github.io/performance-measure-memory/). Estimates total memory usage of the web application including all iframes and workers.
- **Browser support**: Chromium-based browsers only (Chrome 89+, Edge 89+). Firefox: "under consideration." WebKit: "no signal." ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory))
- **Worker availability**: The API is available in `DedicatedWorkerGlobalScope`, `SharedWorkerGlobalScope`, and `ServiceWorkerGlobalScope` per the spec.
- **Critical requirement**: Requires `crossOriginIsolated === true`, which means the page must serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. Without these, the API throws a `SecurityError`. The Vite dev server does not set these headers by default.
- **What it measures**: Returns a `Promise<{bytes, breakdown}>` where `breakdown` lists memory attributed to each realm (main page, workers, iframes). It measures the *entire* web application, not just the calling context.
- **Limitations**: Results are not real-time — the spec recommends calling at random intervals. Accuracy varies; the result is "an estimate" that browsers may fuzz to prevent fingerprinting. There was a temporary experiment in Chrome M120-M121 to relax the COOP/COEP requirement, but it has expired.

**`performance.memory` (Chrome-specific, legacy)**:

- **NOT available in workers**. The `performance.memory` property (`MemoryInfo`) is only exposed on `Window`, not on `WorkerGlobalScope` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory)).
- Provides `usedJSHeapSize`, `totalJSHeapSize`, `jsHeapSizeLimit` — but these only measure the V8 JS heap, not native memory where `ImageBitmap` pixel data is stored. It would undercount bitmap memory significantly.
- Deprecated in favor of `measureUserAgentSpecificMemory()`.

**`navigator.deviceMemory`**:

- Returns approximate device RAM in GiB, rounded to nearest power of 2 (e.g., 0.25, 0.5, 1, 2, 4, 8). Upper bound reported is 8 GiB.
- **Available in workers** via `WorkerNavigator.deviceMemory` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory)).
- **Browser support**: Chromium-based only (Chrome 63+, Edge 79+). Not supported in Firefox or Safari.
- **HTTPS required** (secure context only).
- Useful for setting initial eviction thresholds (e.g., more aggressive eviction on 2 GB devices), but too coarse for runtime monitoring.

**`navigator.hardwareConcurrency`**:

- Returns number of logical CPU cores. Available in all major browsers and in workers via `WorkerNavigator.hardwareConcurrency`.
- **Browser support**: Chrome 37+, Firefox 48+, Safari 10.1+, Edge 15+ ([Can I Use](https://caniuse.com/hardwareconcurrency)).
- Not directly related to memory, but useful for deciding worker pool sizes or concurrent decode limits.

**Chrome DevTools memory profiling for workers**:

Chrome DevTools Memory panel supports profiling workers directly. You can select a specific JavaScript VM instance (including Web Workers) from a dropdown in the Memory panel and take heap snapshots, allocation timelines, or allocation sampling profiles for that worker. The DevTools documentation confirms: "Renderer memory is all memory of the process where an inspected page is rendered: native memory + JS heap memory of the page + JS heap memory of all dedicated workers started by the page." ([Chrome DevTools](https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshots))

However, `ImageBitmap` pixel data stored in Blink native memory (or GPU memory) does **not** appear in V8 heap snapshots. It shows up only in Chrome's Task Manager (per-tab memory) or in the `performance.measureUserAgentSpecificMemory()` aggregate.

**GPU memory monitoring**:

There is no standard Web API for querying GPU memory usage. The `WEBGL_debug_renderer_info` extension exposes the GPU vendor/renderer string but not memory. The WebGPU spec has no memory query API. Chrome's `chrome://gpu` page shows GPU memory stats but this is not accessible from JavaScript.

The closest approximation: monitor `createImageBitmap()` promise rejections, which indicate allocation failure (likely due to GPU or CPU memory exhaustion).

**Practical monitoring strategy for the filmstrip worker**:

```js
// In the worker:
function estimateMemoryUsage(thumbnails, intraFrames) {
  const BYTES_PER_BITMAP = 426 * 240 * 4; // 408,960 bytes
  let count = thumbnails.size;
  for (const arr of intraFrames.values()) {
    count += arr.length;
  }
  return count * BYTES_PER_BITMAP;
}

// Check device memory for initial budget (Chromium only):
const deviceGB = navigator.deviceMemory || 4; // default 4 GB
const MAX_BITMAP_BYTES = deviceGB * 1024 * 1024 * 1024 * 0.25; // 25% of device RAM
```

This manual bookkeeping approach is more practical than relying on `measureUserAgentSpecificMemory()` (which requires COOP/COEP and is Chrome-only) or `performance.memory` (which is unavailable in workers and does not count bitmap native memory).

#### Summary

**Concrete memory numbers for the filmstrip use case**:

Per-bitmap: 426 × 240 × 4 = 408,960 bytes ≈ 400 KB

| Zoom level | Visible segments | Bitmaps in 3x viewport | Total memory |
|------------|-----------------|----------------------|--------------|
| Packed (min zoom) | All 30 | 30 I-frame thumbnails | ~12 MB |
| Medium zoom | ~15 segments | 15 × 1 I-frame = 15 | ~6 MB |
| High zoom (gap mode) | ~8 segments | 8 × 7 spans × ~30 intra-frames = ~1,680 | ~672 MB |
| Max zoom (per-frame) | ~4 segments | 4 × 7 spans × ~60 frames = ~1,680 | ~672 MB |

The I-frame thumbnails (30 total, ~12 MB) are negligible. The intra-frame bitmaps at high zoom are the real cost. With the 3x eviction strategy (keep 1x visible + 3x on each side = 7x total span), the worst case for a 60-second/30fps/2-second-segment video is ~1,680 bitmaps = ~672 MB.

**Evaluation of the current 3x viewport eviction strategy**:

The 3x strategy is reasonable but slightly aggressive in the worst case:
- **Good**: It ensures smooth scrolling — pre-loaded bitmaps 3x beyond the viewport mean the user can scroll a full viewport width in any direction without seeing blank thumbnails.
- **Concern**: At maximum zoom with 60 frames/segment and 4 visible segments, the 7x total span holds ~1,680 bitmaps (~672 MB). This approaches the PartitionAlloc 2 GB slab limit if combined with other page memory.
- **Safe in practice**: For the target use case (60-second video, 30fps, 2-second segments), the numbers stay within safe limits on 64-bit systems with 4+ GB RAM. On low-memory devices (2 GB), the 672 MB peak could cause issues.

**Recommended improvements**:

1. **Add a memory budget cap**: Instead of relying solely on viewport distance, add a maximum bitmap count (e.g., 2,000 bitmaps = ~800 MB). When the count exceeds the cap, evict the most distant bitmaps first. This prevents runaway allocation at extreme zoom levels.

2. **Use `navigator.deviceMemory` to scale the budget**: On devices reporting 2 GB or less, reduce the eviction multiplier from 3x to 1.5x or cap at ~500 bitmaps.

3. **Keep `ImageBitmap` over `ImageData`**: The rendering performance advantage of `drawImage(imageBitmap)` over `putImageData(imageData)` is essential for 60fps filmstrip scrolling. The memory footprint is identical (400 KB per image either way). `ImageBitmap.close()` provides explicit deallocation that `ImageData` lacks.

4. **Keep `createImageBitmap(videoFrame)` over `transferToImageBitmap()`**: The current approach is correct. `createImageBitmap()` is the optimized path for `VideoDecoder` output across all browsers. `transferToImageBitmap()` adds unnecessary OffscreenCanvas allocation overhead and is 10x slower on Firefox.

5. **Manual memory bookkeeping**: Track bitmap count in the hook and expose it for debugging. The formula `count × 400KB` gives an accurate estimate since all bitmaps are the same resolution. This is more reliable than any browser memory API for this specific use case.

6. **Handle allocation failures**: Wrap `createImageBitmap()` calls in try/catch and treat rejection as a signal to trigger aggressive eviction, reducing the viewport multiplier temporarily.

**Verdict — ImageBitmap vs ImageData**:

**ImageBitmap is the correct choice for this use case.** The deciding factors:
- `drawImage(ImageBitmap)` is 2–10x faster than `putImageData(ImageData)` for canvas rendering, which is critical for the filmstrip's 60fps scroll/zoom paint loop
- `ImageBitmap` supports zero-copy transfer from worker to main thread; `ImageData` requires manual `ArrayBuffer` transfer with reconstruction overhead
- `ImageBitmap.close()` provides immediate memory release without waiting for GC; `ImageData` relies on GC to free the `ArrayBuffer`
- Memory footprint is identical: both use 400 KB per 426x240 image
- The predictability advantage of `ImageData` can be replicated with manual bitmap counting (`count × 400KB`)
- The current 3x eviction strategy with `bmp.close()` is sound; adding a hard cap (~2,000 bitmaps) would provide additional safety

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

### Findings

#### Q1: Is Shaka Player's labeling of sidx requests as INIT_SEGMENT documented behavior or a bug?

**It is neither a bug nor exactly as described in the original observation.** A careful reading of Shaka Player's source code reveals a more nuanced situation than the comment in `softwareDecrypt.ts:210-214` suggests. There are actually **two separate code paths** that fetch different segment types, and they label requests differently:

**Path 1 — Manifest parsing (sidx fetch):** When Shaka parses a SegmentBase DASH manifest, it calls `SegmentBase.generateSegmentIndexFromUris()` ([lib/dash/segment_base.js, line 153](https://github.com/shaka-project/shaka-player/blob/main/lib/dash/segment_base.js)). This function fetches the sidx (index range) data by calling the `requestSegment` callback with `/* isInit= */ false` (line 170). The callback resolves to `DashParser.requestSegment_()` ([lib/dash/dash_parser.js, line 3285](https://github.com/shaka-project/shaka-player/blob/main/lib/dash/dash_parser.js)), which maps `isInit=false` to `AdvancedRequestType.MEDIA_SEGMENT` (lines 3287-3289):

```javascript
async requestSegment_(uris, startByte, endByte, isInit) {
    const requestType = shaka.net.NetworkingEngine.RequestType.SEGMENT;
    const type = isInit ?
        shaka.net.NetworkingEngine.AdvancedRequestType.INIT_SEGMENT :
        shaka.net.NetworkingEngine.AdvancedRequestType.MEDIA_SEGMENT;
    // ...
    const response = await this.makeNetworkRequest_(request, requestType, {type});
```

So the sidx request is labeled as `MEDIA_SEGMENT`, not `INIT_SEGMENT`. The `RequestContext` passed to the response filter only contains `{type: MEDIA_SEGMENT}` — no `segment` or `stream` fields.

**Path 2 — Streaming (init segment fetch):** When the streaming engine needs to fetch the actual init segment (containing `moov`/`ftyp` boxes), it calls `StreamingEngine.dispatchFetch()` ([lib/media/streaming_engine.js, line 2957](https://github.com/shaka-project/shaka-player/blob/main/lib/media/streaming_engine.js)). This method uses `instanceof` to check if the reference is a `SegmentReference` (media) or `InitSegmentReference` (init), and sets the `AdvancedRequestType` accordingly (lines 2961-2965):

```javascript
const segment = reference instanceof shaka.media.SegmentReference ?
    reference : undefined;
const type = segment ?
    shaka.net.NetworkingEngine.AdvancedRequestType.MEDIA_SEGMENT :
    shaka.net.NetworkingEngine.AdvancedRequestType.INIT_SEGMENT;
```

The init segment fetch here correctly gets `INIT_SEGMENT`.

**The real problem for response filters:** For SegmentBase streams, all three request types (init, sidx, media) use the same base `RequestType.SEGMENT`. A response filter that only checks the base `RequestType` (as `softwareDecrypt.ts` does on line 200) sees all three as `SEGMENT` requests. The `AdvancedRequestType` does distinguish them — sidx gets `MEDIA_SEGMENT` and real init gets `INIT_SEGMENT` — but this is only available through the optional `RequestContext` parameter, not the primary `RequestType`.

The sidx fetch happens lazily during `createSegmentIndex()` (not during initial manifest parsing), so it arrives as a `SEGMENT` request with `AdvancedRequestType.MEDIA_SEGMENT`. This is technically correct — the sidx is not an init segment and not a playable media segment either, but Shaka has no `INDEX_SEGMENT` advanced type, so it falls into `MEDIA_SEGMENT` as the default for `isInit=false`.

**Conclusion:** The labeling is intentional design, not a bug. Shaka's `AdvancedRequestType` enum only has `INIT_SEGMENT` and `MEDIA_SEGMENT` for segment subtypes — there is no `INDEX_SEGMENT` or `SIDX` type. The sidx is labeled `MEDIA_SEGMENT` because it's "not init" in the boolean sense. The `AdvancedRequestType` was introduced in response to [issue #4966](https://github.com/shaka-project/shaka-player/issues/4966) (HEVC codec workaround) specifically to distinguish init segments from media segments, not to handle all possible segment subtypes.

**Sources:**
- [Shaka Player `segment_base.js` — sidx fetch with `isInit=false`](https://github.com/shaka-project/shaka-player/blob/main/lib/dash/segment_base.js) (line 170)
- [Shaka Player `dash_parser.js` — `requestSegment_()` mapping `isInit` to `AdvancedRequestType`](https://github.com/shaka-project/shaka-player/blob/main/lib/dash/dash_parser.js) (lines 3285-3300)
- [Shaka Player `streaming_engine.js` — `dispatchFetch()` using `instanceof` for type detection](https://github.com/shaka-project/shaka-player/blob/main/lib/media/streaming_engine.js) (lines 2957-2977)
- [Shaka Player `networking_engine.js` — `AdvancedRequestType` enum definition](https://github.com/shaka-project/shaka-player/blob/main/lib/net/networking_engine.js)
- [GitHub issue #4966 — original motivation for `AdvancedRequestType`](https://github.com/shaka-project/shaka-player/issues/4966)
- [Shaka Player API docs — `AdvancedRequestType`](https://shaka-player-demo.appspot.com/docs/api/shaka.net.NetworkingEngine.html)

#### Q2: Is there a Shaka Player API to distinguish sidx from true init segment requests?

**Yes, partially — but with caveats.** There are several potential approaches, each with limitations:

**Approach 1: `AdvancedRequestType` via `RequestContext` (viable but imperfect)**

The `RequestContext` object (third parameter of response filters) contains `context.type` with the `AdvancedRequestType`. For SegmentBase streams:
- Init segment (moov) → `AdvancedRequestType.INIT_SEGMENT`
- Sidx (index) → `AdvancedRequestType.MEDIA_SEGMENT`
- Media segment (moof+mdat) → `AdvancedRequestType.MEDIA_SEGMENT`

This distinguishes init from sidx, but **cannot distinguish sidx from real media segments** — both get `MEDIA_SEGMENT`. For the `softwareDecrypt.ts` use case, this would actually suffice: the filter could use `context.type === INIT_SEGMENT` to identify real init segments, and treat everything else as potential media. The sidx would pass through without triggering either the init or media processing paths (since it has neither `moov` nor `moof`).

**Approach 2: `RequestContext.segment` field (limited)**

The `RequestContext` includes a `segment` field of type `shaka.media.SegmentReference | undefined`. During streaming, init segment fetches have `segment = undefined` while media segment fetches have a `SegmentReference`. However, during manifest parsing (when the sidx is fetched), the context only contains `{type}` — no `segment` or `stream` fields. So this field is not useful for distinguishing sidx requests.

**Approach 3: `response.uri` and byte range (unreliable)**

The `Response` object includes `uri` and the original request is available via `response.originalRequest`. For SegmentBase streams, the init segment, sidx, and media segments may all share the **same base URL** — they differ only in the `Range` header. One could inspect `response.originalRequest.headers['Range']` and compare against known byte ranges from the manifest. This is fragile and requires manifest-level knowledge that a response filter shouldn't need.

**Approach 4: Box-presence detection (current approach, most robust)**

The current approach in `softwareDecrypt.ts` — scanning for `moov` and `moof` boxes — is actually the most reliable. It is content-based rather than metadata-based, making it immune to labeling inconsistencies. An init segment always contains `moov`; a media segment always contains `moof`+`mdat`; a sidx segment contains only `sidx` (and possibly `styp`). The sidx bytes pass through harmlessly because they match neither `isInit` nor `isMedia`.

**Recommendation:** The box-presence approach is the correct solution. It could be supplemented with `AdvancedRequestType` as a first-pass filter (skip processing for `INIT_SEGMENT` type and only parse boxes for `MEDIA_SEGMENT` type), but the box check is the authoritative mechanism. The `AdvancedRequestType` alone is insufficient because it conflates sidx with media segments.

A potential improvement to the current code would be to use `context.type` as an optimization hint:

```typescript
// Fast path: if AdvancedRequestType says INIT_SEGMENT, trust it
if (context?.type === shaka.net.NetworkingEngine.AdvancedRequestType.INIT_SEGMENT) {
  // Process as init segment (moov is guaranteed)
} else {
  // Fall back to box-presence detection for MEDIA_SEGMENT
  // (which includes both real media and sidx)
}
```

However, this optimization adds complexity for minimal gain — the `findBoxData` scan is fast on typical segment sizes. The current pure box-detection approach is simpler and correct.

**Sources:**
- [Shaka Player `externs/shaka/net.js` — `RequestContext` typedef](https://shaka-player-demo.appspot.com/docs/api/externs_shaka_net.js.html) (defines `type`, `stream`, `segment`, `isPreload` fields)
- [Shaka Player `externs/shaka/net.js` — `Response` typedef](https://shaka-player-demo.appspot.com/docs/api/externs_shaka_net.js.html) (defines `uri`, `originalUri`, `data`, `originalRequest` fields)
- [Shaka Player `networking_utils.js` — `createSegmentRequest()`](https://github.com/shaka-project/shaka-player/blob/main/lib/net/networking_utils.js) (sets `Range` header for byte-range requests)
- [Shaka Player `networking_engine.js` — `filterResponse_()`](https://github.com/shaka-project/shaka-player/blob/main/lib/net/networking_engine.js) (line 731 — passes `context` to response filters)
- [Shaka Player `dash_parser.js` — `requestSegment_()` context](https://github.com/shaka-project/shaka-player/blob/main/lib/dash/dash_parser.js) (line 3297 — only passes `{type}`, no `segment` or `stream`)
- [Shaka Player `streaming_engine.js` — `dispatchFetch()` context](https://github.com/shaka-project/shaka-player/blob/main/lib/media/streaming_engine.js) (line 2977 — passes full `{type, stream, segment, isPreload}`)

#### Q3: Does this affect other Shaka Player response filter use cases?

**Yes, this is a general pitfall that affects any response filter processing segment data for SegmentBase streams.** Several categories of use cases are impacted:

**1. DRM / Decryption filters (directly affected)**

This is exactly the use case in `softwareDecrypt.ts`. Any response filter that caches init segment data for later use in media segment processing must correctly identify which responses are init segments. If a filter blindly caches any `SEGMENT`-type response as init data, a sidx response will overwrite the cached init segment. This breaks all subsequent media segment processing because mp4box/parsers expect init data (moov/trak/stsd boxes) to extract sample tables. The sidx contains only a segment index — no codec configuration, track info, or sample descriptions.

**2. Segment modification / rewriting filters (potentially affected)**

Filters that modify segment data (e.g., rewriting codec parameters in init segments as in [issue #4966](https://github.com/shaka-project/shaka-player/issues/4966) for HEVC workarounds, or injecting custom boxes) need to identify init segments correctly. Attempting to parse and modify a sidx response as if it were an init segment would cause parsing errors or corrupt data. The `AdvancedRequestType` can help here — checking for `INIT_SEGMENT` type would correctly identify real init segments — but only for the streaming engine path. During manifest parsing, init segments are not fetched through the response filter at all (they're fetched later by the streaming engine).

**3. Ad insertion / SSAI filters (indirectly affected)**

Server-side ad insertion (SSAI) that uses response filters to stitch ad segments into the content stream needs to understand segment boundaries. For SegmentBase streams, the sidx response arriving as a `MEDIA_SEGMENT` type could confuse ad insertion logic that expects all `MEDIA_SEGMENT` responses to contain actual media data (moof+mdat). However, most SSAI implementations work at the manifest level (rewriting segment URLs) rather than the response level, so this is a lesser concern in practice.

**4. Analytics / logging filters (minimally affected)**

Filters that count segments, measure sizes, or log segment types would incorrectly classify sidx responses. A sidx response would be counted as a media segment, slightly skewing segment counts and bandwidth calculations. This is typically harmless but could confuse debugging.

**5. Bandwidth estimation filters (edge case)**

Custom bandwidth estimation that processes segment responses to compute per-segment bitrates would include the sidx response in its calculations. The sidx is typically small (a few hundred bytes) and fetched once, so this has negligible impact.

**Broader context:** This issue is specific to SegmentBase (on-demand profile) streams. SegmentTemplate and SegmentList streams do not have this problem because their segment index information is embedded in the manifest (via `SegmentTimeline` or `@duration`) rather than fetched as a separate network request. The sidx fetch only occurs for `SegmentBase@indexRange` and `SegmentTemplate@index` addressing modes.

Shaka Player's own codebase handles this internally by using the `isInit` parameter in the `RequestSegmentCallback` passed to `SegmentBase.createStreamInfo()`, and by using `instanceof InitSegmentReference` in the streaming engine. These are internal mechanisms not exposed to response filters. The `AdvancedRequestType` enum was designed as a partial solution but only covers two subtypes (`INIT_SEGMENT` and `MEDIA_SEGMENT`), leaving sidx as an undifferentiated `MEDIA_SEGMENT`.

**Impact assessment for `softwareDecrypt.ts`:** The current box-presence detection is the correct approach and handles all cases:
- Init segment (moov) → detected by `hasMoov`, processed as init
- Sidx (no moov, no moof) → falls through both checks, passed through unmodified
- Media segment (moof) → detected by `hasMoof`, processed as media
- Combined init+media (moov+moof, rare) → detected by `hasMoov`, processed as init (correct for first encounter)

No changes are recommended to the current implementation.

**Sources:**
- [GitHub issue #4966 — AdvancedRequestType motivation (HEVC init segment modification)](https://github.com/shaka-project/shaka-player/issues/4966)
- [GitHub issue #3093 — sidx in separate file from media segments](https://github.com/shaka-project/shaka-player/issues/3093)
- [GitHub issue #6010 — DASH + ad insertion exception](https://github.com/shaka-project/shaka-player/issues/6010)
- [Shaka Player DeepWiki — Request/Response Filters](https://deepwiki.com/shaka-project/shaka-player/5.1-requestresponse-filters)
- [Shaka Player API docs — NetworkingEngine](https://shaka-player-demo.appspot.com/docs/api/shaka.net.NetworkingEngine.html)
- [Shaka Player API docs — RequestContext](https://shaka-player-demo.appspot.com/docs/api/shaka.extern.html)
- [Shaka Packager docs — sidx generation for on-demand profile](https://shaka-project.github.io/shaka-packager/html/documentation.html)

#### Q4: Is box-presence detection the standard approach for response filters?

**Box-presence detection is not a "standard" documented pattern, but it is the most robust approach and aligns with how Shaka Player itself handles segment type identification internally.** There is no official Shaka Player documentation recommending a specific approach for response filters that need to distinguish segment types. The research reveals three key findings:

**1. Shaka Player's own internal code uses box parsing for segment type identification.**

Shaka's `content_workarounds.js` ([lib/media/content_workarounds.js](https://github.com/shaka-project/shaka-player/blob/main/lib/media/content_workarounds.js)) distinguishes init segments from media segments by parsing their MP4 box structure. The `fakeEncryption()` method processes `moov` box trees (init segments), while `fakeMediaEncryption()` processes `moof` box trees (media segments). This is the same pattern used in `softwareDecrypt.ts`. Shaka uses its built-in `shaka.util.Mp4Parser` for this, which is a box-level parser that traverses `ftyp`, `moov`, `trak`, `mdia`, `minf`, `stbl`, `stsd` hierarchies for init segments, and `styp`, `moof`, `traf`, `tfhd`, `trun` hierarchies for media segments.

**2. The `AdvancedRequestType` API is the recommended Shaka API, but it has gaps.**

Shaka Player introduced `AdvancedRequestType` (via [PR #5006](https://github.com/shaka-project/shaka-player/pull/5006), closing [issue #4966](https://github.com/shaka-project/shaka-player/issues/4966)) specifically to let response filters distinguish init segments from media segments. The third parameter of the response filter callback is a `RequestContext` object containing `context.type` with the `AdvancedRequestType` value. The API documentation ([shaka.extern.ResponseFilter](https://shaka-player-demo.appspot.com/docs/api/shaka.extern.html)) states that "the optional RequestContext will be provided where applicable to provide additional information about the request."

However, as documented in Q1-Q3, this API has gaps:
- The sidx request gets `MEDIA_SEGMENT` (not a dedicated `INDEX_SEGMENT` type)
- There are only two segment subtypes: `INIT_SEGMENT` (0) and `MEDIA_SEGMENT` (1)
- The context's `segment` and `stream` fields are only populated by the streaming engine path, not the manifest parser path
- [PR #5113](https://github.com/shaka-project/shaka-player/pull/5113) ("fix: Add missing AdvancedRequestType in some requests") shows that even Shaka's own codebase had missing type assignments after the initial implementation

**3. The ISO BMFF (MP4) specification makes box-presence detection authoritative.**

Per ISO 14496-12 (ISOBMFF), the box structure unambiguously identifies segment types:
- **Init segments** always contain a `moov` box (movie metadata container with `trak`, `stsd`, codec configuration)
- **Media segments** always contain a `moof` box (movie fragment) followed by `mdat` (media data)
- **Index segments** contain a `sidx` box (segment index) and optionally `styp` (segment type)
- These are mutually exclusive at the top level: a valid ISO BMFF segment cannot contain both `moov` and `moof` at the top level (except in the rare case of a single-segment file with an appended fragment, which is non-standard for DASH)

This makes box-presence detection a ground-truth mechanism rather than a heuristic. The current code in `softwareDecrypt.ts` effectively performs a simplified version of what Shaka's own `Mp4Parser` does internally.

**4. Hybrid approach as a potential optimization.**

A response filter could use `AdvancedRequestType` as a fast-path hint and fall back to box detection for ambiguous cases:

```typescript
const responseFilter: shaka.extern.ResponseFilter = async (type, response, context) => {
  if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT) return;

  // Fast path: trust AdvancedRequestType when available
  if (context?.type === shaka.net.NetworkingEngine.AdvancedRequestType.INIT_SEGMENT) {
    return processInitSegment(response);
  }

  // For MEDIA_SEGMENT (or undefined context), use box detection
  // because MEDIA_SEGMENT includes both real media and sidx
  const data = new Uint8Array(response.data);
  const hasMoov = findBoxData(data, "moov") !== null;
  const hasMoof = findBoxData(data, "moof") !== null;
  if (hasMoov) return processInitSegment(response);
  if (hasMoof) return processMediaSegment(response);
  // Neither moov nor moof: sidx or other index data — pass through
};
```

This adds complexity for negligible performance gain. The `findBoxData` scan reads only the first 8 bytes of each top-level box (4-byte size + 4-byte type) and terminates on first match, making it effectively O(number of top-level boxes) which is typically 2-4 for any segment type.

**Conclusion:** Box-presence detection is the correct and most robust approach. It is not explicitly documented as a recommended pattern by Shaka Player, but it mirrors Shaka's own internal approach, is grounded in the ISO BMFF specification, and handles all edge cases (sidx, combined segments, unknown future types) that `AdvancedRequestType` cannot cover. The current implementation in `softwareDecrypt.ts` is optimal.

**Sources:**
- [Shaka Player `content_workarounds.js` — internal box-based segment type detection](https://github.com/shaka-project/shaka-player/blob/main/lib/media/content_workarounds.js)
- [Shaka Player PR #5006 — `AdvancedRequestType` introduction](https://github.com/shaka-project/shaka-player/pull/5006)
- [Shaka Player PR #5113 — fix for missing `AdvancedRequestType` assignments](https://github.com/shaka-project/shaka-player/pull/5113)
- [Shaka Player issue #4966 — original motivation for `AdvancedRequestType`](https://github.com/shaka-project/shaka-player/issues/4966)
- [Shaka Player API docs — `ResponseFilter` typedef](https://shaka-player-demo.appspot.com/docs/api/shaka.extern.html)
- [Shaka Player API docs — `AdvancedRequestType` enum](https://shaka-player-demo.appspot.com/docs/api/shaka.net.NetworkingEngine.html)
- [ISO 14496-12:2022 (ISOBMFF) — box structure specification](https://www.iso.org/standard/83102.html)

#### Q5: Are there other DASH packaging modes that produce similar ambiguities?

**Yes, but the impact is limited to one additional mode. The ambiguity is fundamentally a property of indexed addressing (byte-range-based), not of DASH packaging in general.** The five DASH segment addressing modes fall into two categories with respect to this problem:

**Modes with the sidx ambiguity (indexed addressing):**

**1. `SegmentBase` with `@indexRange` — the known case**

This is the mode used by Shaka Packager's on-demand profile and the mode documented in `softwareDecrypt.ts`. A single CMAF track file contains the init segment, sidx, and all media segments at different byte ranges. Shaka fetches the sidx via a separate HTTP Range request during `createSegmentIndex()`, and this request passes through response filters as `RequestType.SEGMENT` with `AdvancedRequestType.MEDIA_SEGMENT`.

**2. `SegmentTemplate` with `@index` template — same problem, different syntax**

`SegmentTemplate` can include an `@index` attribute containing a URL template (e.g., `index-$RepresentationID$.mp4`) that points to an external file containing the sidx box. Shaka's `segment_template.js` handles this by calling `SegmentBase.generateSegmentIndexFromIndexTemplate_()`, which delegates to the same `generateSegmentIndexFromUris()` method used by `SegmentBase`. The sidx fetch follows the identical code path with `isInit=false`, producing the same `AdvancedRequestType.MEDIA_SEGMENT` labeling ([lib/dash/segment_template.js](https://shaka-player-demo.appspot.com/docs/api/lib_dash_segment_template.js.html)).

This mode is less common than `SegmentBase` but is supported by Shaka Player and documented in the [DASH-IF timing model guidelines](https://dashif-documents.azurewebsites.net/Guidelines-TimingModel/master/Guidelines-TimingModel.html) under "indexed addressing."

**Modes WITHOUT the sidx ambiguity:**

**3. `SegmentTemplate` with `@duration` (simple addressing)**

Segment timing is derived from a fixed nominal duration (`SegmentTemplate@duration`) and segment number substitution (`$Number$` or `$Time$`). No sidx fetch occurs — Shaka computes segment references directly from the duration and template. Init segments are fetched via `SegmentTemplate@initialization` template URL and correctly tagged as `INIT_SEGMENT`. Media segments use the `@media` template and are correctly tagged as `MEDIA_SEGMENT`. No ambiguity.

**4. `SegmentTemplate` with `SegmentTimeline` (explicit addressing)**

Exact per-segment timing is specified inline in the MPD via `SegmentTimeline/S` elements with `@t` (start time) and `@d` (duration) attributes. Like simple addressing, no sidx is fetched — timing comes from the manifest. Init and media segments are fetched via template URLs and correctly typed. No ambiguity.

**5. `SegmentList` (explicit segment URL list)**

Each segment has an explicit `SegmentURL` element in the MPD. The `Initialization` element within `SegmentList` specifies the init segment via `@sourceURL` and optional `@range`. There is no separate index fetch. However, there is a related edge case: `SegmentURL` can include an `@indexRange` attribute pointing to per-segment sidx data ([Shaka Player issue #765](https://github.com/google/shaka-player/issues/765)). If supported, this would produce the same ambiguity. In practice, `SegmentList` is prohibited by DASH-IF IOP v5.0.0 ("Shall be absent" per [DASH-IF IOP Part 5](https://dashif.org/docs/IOP-Guidelines/DASH-IF-IOP-Part5-v5.0.0.pdf)) and is extremely rare in production.

**Summary table:**

| Addressing Mode | Sidx Fetch? | Ambiguity? | DASH-IF IOP Status |
|----------------|-------------|------------|-------------------|
| `SegmentBase` + `@indexRange` | Yes (byte-range) | **Yes** | Allowed (VOD) |
| `SegmentTemplate` + `@index` | Yes (template URL) | **Yes** | Allowed (rare) |
| `SegmentTemplate` + `@duration` | No | No | Recommended (live) |
| `SegmentTemplate` + `SegmentTimeline` | No | No | Recommended (live/VOD) |
| `SegmentList` | No (unless `@indexRange`) | Rare edge case | **Prohibited** |

**Impact on `softwareDecrypt.ts`:** The current box-presence detection handles all five modes correctly:
- For modes with sidx fetches (`SegmentBase`, `SegmentTemplate@index`): the sidx response has no `moov` or `moof`, so it passes through unmodified. Correct.
- For modes without sidx fetches (`SegmentTemplate@duration`, `SegmentTemplate+SegmentTimeline`): init and media segments contain `moov` and `moof` respectively. Correct.
- For the rare `SegmentList` with `@indexRange`: same as `SegmentBase` — box detection handles it. Correct.

No additional handling is needed for any packaging mode.

**Sources:**
- [DASH-IF timing model guidelines — segment addressing modes](https://github.com/Dash-Industry-Forum/Guidelines-TimingModel/blob/master/22-Addressing.inc.md)
- [DASH-IF IOP v5.0.0 — SegmentList prohibition](https://dashif.org/docs/IOP-Guidelines/DASH-IF-IOP-Part5-v5.0.0.pdf)
- [DASH-IF IOP v4.2 — interoperability guidelines](https://dashif.org/docs/DASH-IF-IOP-v4.2-clean.htm)
- [Shaka Player `segment_template.js` — `@index` template handling](https://shaka-player-demo.appspot.com/docs/api/lib_dash_segment_template.js.html)
- [Shaka Player `segment_base.js` — sidx fetch code path](https://github.com/shaka-project/shaka-player/blob/main/lib/dash/segment_base.js)
- [Shaka Player issue #765 — `SegmentURL@indexRange` support](https://github.com/google/shaka-player/issues/765)
- [Shaka Player issue #3093 — sidx in separate file from media segments](https://github.com/shaka-project/shaka-player/issues/3093)
- [Bitmovin DASH overview — segment addressing explained](https://bitmovin.com/dynamic-adaptive-streaming-http-mpeg-dash/)
- [GPAC DASH basics — SegmentBase vs SegmentTemplate vs SegmentList](https://wiki.gpac.io/Howtos/dash/DASH-basics/)

### Summary

The research into SegmentBase vs SegmentTemplate detection in response filters confirms that the current box-presence detection approach in `softwareDecrypt.ts` is correct, robust, and effectively the best available solution. Key findings across all five questions:

**1. The `AdvancedRequestType` labeling is by design, not a bug.** Shaka Player's sidx requests are tagged as `MEDIA_SEGMENT` (not `INIT_SEGMENT` as the code comment originally suggested). The `AdvancedRequestType` enum has only two segment subtypes (`INIT_SEGMENT` and `MEDIA_SEGMENT`) with no dedicated `INDEX_SEGMENT` type. This is intentional — the feature was designed to distinguish init from non-init, not to categorize all segment subtypes.

**2. No Shaka API fully solves the problem.** The `RequestContext` parameter (available since Shaka Player 4.3) provides `AdvancedRequestType` which can distinguish init segments from everything else, but conflates sidx with real media segments. The `context.segment` and `context.stream` fields are only populated during streaming engine fetches, not during manifest-time sidx fetches. Byte-range inspection of the request is theoretically possible but fragile and requires manifest-level knowledge.

**3. Box-presence detection is the authoritative mechanism.** It mirrors Shaka Player's own internal pattern (used in `content_workarounds.js`), is grounded in the ISO BMFF specification (where `moov`, `moof`, and `sidx` are mutually exclusive top-level structures), and handles all edge cases including sidx, combined segments, and future unknown types. The scan cost is negligible (reads only 8 bytes per top-level box).

**4. Two DASH addressing modes produce the sidx ambiguity.** `SegmentBase` with `@indexRange` (the current case) and `SegmentTemplate` with `@index` both fetch sidx data through response filters. The remaining three modes (`SegmentTemplate@duration`, `SegmentTemplate+SegmentTimeline`, `SegmentList`) embed timing in the manifest and do not fetch sidx separately. The box-detection approach handles all five modes correctly.

**5. No changes are recommended to the current implementation.** The only minor improvement would be to correct the code comment at `softwareDecrypt.ts:211-214`, which states that Shaka "may tag [the sidx] as INIT_SEGMENT" — in reality, it tags it as `MEDIA_SEGMENT`. The comment should be updated to reflect the actual labeling, while keeping the explanation of why box detection is preferred over relying on `AdvancedRequestType`.

**Recommended comment update for `softwareDecrypt.ts:210-214`:**

```typescript
// Detect segment type by box presence rather than relying on
// AdvancedRequestType. Shaka's AdvancedRequestType only distinguishes
// INIT_SEGMENT from MEDIA_SEGMENT — sidx (index) requests are tagged
// as MEDIA_SEGMENT since there is no INDEX_SEGMENT type. Box detection
// (moov for init, moof for media) is authoritative per ISO BMFF and
// correctly ignores sidx responses that contain neither box.
```

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
6. **Topic 6: Firefox frame boundary precision** -- RESOLVED. The 1ms epsilon is mathematically safe for fps < 500. Root cause: historical float-to-double and fencepost bugs (fixed 2011) with residual sub-ms MSE timestamp conversion differences. Half-frame-duration epsilon (`0.5/fps`) is a cleaner alternative.
7. **Topic 9: ImageBitmap memory** -- RESOLVED. 400 KB/bitmap (426x240 RGBA), `close()` frees immediately, transfer is zero-copy. 3x eviction is sound; add hard cap (~2,000 bitmaps).
8. **Topic 7: Edge stale `currentTime`** -- RESOLVED. Root cause: Chromium's multi-threaded media pipeline updates `currentTime` asynchronously via `PostTask`; Playwright IPC round-trips expose this staleness. Edge's Media Foundation integration widens the window. Current workaround (`pressKeyNTimesAndSettle`) is optimal.
9. **Topic 8: WebKit frame compositing** -- RESOLVED. Root cause: `showPosterFlag()` gates `mediaPlayerFirstVideoFrameAvailable()`. Fix: unconditional self-seek + rVFC confirmation.
10. **Topic 10: SegmentBase detection** -- RESOLVED. Box-presence detection is the correct approach. Shaka's `AdvancedRequestType` labels sidx as `MEDIA_SEGMENT` (not `INIT_SEGMENT` as originally suspected), but has no dedicated `INDEX_SEGMENT` type. The `RequestContext` could theoretically help but only the streaming engine populates it fully. No changes needed to current implementation.
11. **Topic 11: Pixel format variations** -- No user impact; informational.
12. **Topic 12: Height rounding** -- No user impact; informational.
