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
