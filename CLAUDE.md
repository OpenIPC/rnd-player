# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

R&D Player — a custom web video player built with React 19, TypeScript, and Shaka Player 5 for adaptive streaming (DASH/HLS). Replaces native browser controls with a dark-themed custom overlay. Supports ClearKey DRM auto-detection, multi-track audio/subtitles, playback diagnostics, and sleep/wake recovery.

## Commands

- `npm run dev` — Start Vite dev server with HMR
- `npm run build` — TypeScript check + Vite production build (full preset)
- `npm run build:production` — Build with analysis modules stripped (filmstrip, compare, audio levels, export)
- `npm run build:minimal` — Build with all optional modules disabled
- `npm run lint` — ESLint (flat config, ESLint 9+)
- `npm run test` — Vitest in watch mode
- `npm run test:run` — Vitest single run (CI mode)
- `npm run test:coverage` — Coverage report
- Run a single test file: `npx vitest run src/utils/formatTime.test.ts`
- `npm run test:e2e` — Playwright E2E tests (all browsers)
- `npx playwright test --project=chromium` — E2E for specific browser

## Architecture

Entry: `index.html` → `src/main.tsx` → `src/App.tsx`

**App.tsx** — Root component. Renders a URL input form; on submit passes the manifest URL to ShakaPlayer. On mount, runs device capability detection (`detectCapabilities`), computes the module config via `autoConfig` merged with user overrides from localStorage, and passes `moduleConfig`/`deviceProfile`/`onModuleConfigChange` down to ShakaPlayer. Waits for capability detection before rendering the player. Owns all scene data loading: fetches from `scenes` URL param on mount, provides a file picker button (orange "Scenes") in the URL form, and exposes `onLoadSceneData` (triggers file picker), `onLoadSceneFile` (reads+parses a `File`), and `onSceneDataChange` (for FPS correction and clearing) callbacks. The hidden file input is always mounted so it works from any screen.

**ShakaPlayer** (`src/components/ShakaPlayer.tsx`) — Bridge between React and the native Shaka Player library. Handles:
- One-time polyfill installation at module level
- Manifest fetching to auto-detect ClearKey DRM (`cenc:default_KID`)
- Prompting for decryption key when DRM is detected
- Playback state persistence via sessionStorage
- Error handling with severity categorization
- Clean destruction on unmount via a `destroyed` safety flag
- Module config gating: FilmstripTimeline render gated on `moduleConfig.filmstrip`, QualityCompare on `moduleConfig.qualityCompare`
- Passes scene data through to VideoControls and FilmstripTimeline
- Spawns `useBoundaryPreviews` hook for progress bar boundary preview images (independent of filmstrip panel), passes `boundaryPreviews`/`requestBoundaryPreview`/`clearBoundaryPreviews` to VideoControls
- Watermark overlay: extracts `WatermarkToken` from license response, stores in state, lazy-loads `WatermarkOverlay` gated on `moduleConfig.watermark && watermark && playerReady`

**WatermarkOverlay** (`src/components/WatermarkOverlay.tsx`) — Canvas-based forensic watermark overlay for DRM-protected content. Renders the `session_short` code (4 chars) at 5 positions across the video area. Features:
- Position rotation every 30s using `Math.floor(Date.now() / 30_000)` as seed
- Mulberry32 seeded PRNG for deterministic x/y/angle generation
- DPR-aware canvas sizing, `ResizeObserver` for fullscreen transitions
- Letterbox-aware placement via `getVideoRect()` (handles `object-fit: contain`)
- Font: `14px monospace`, fill: `rgba(255, 255, 255, opacity)`, `globalCompositeOperation: "lighter"`
- Invisible at ~3% opacity but detectable by forensic tools (contrast amplification)
- CSS: `vp-watermark-canvas` at `z-index: 1` (below controls at z-index 2)
- Only rendered when license server provides a `watermark` token; `?key=` manual override produces no watermark

**VideoControls** (`src/components/VideoControls.tsx`) — Custom overlay UI with 20+ state variables managing:
- Play/pause, seek bar, volume slider, quality/speed/audio/subtitle popups
- Auto-hide (3s inactivity timer)
- Fullscreen API integration
- Module config gating: each optional feature (stats, audio levels, adaptation toast, subtitles, segment export, keyboard shortcuts, sleep/wake, scene markers) is conditionally rendered or enabled based on `moduleConfig` props
- Delegates right-click menu to `ContextMenu`, export picker to `ExportPicker`, sleep/wake to `useSleepWakeRecovery`
- Scene markers: renders orange tick marks on progress bar at scene boundaries, scene-aware hover tooltip ("01:23.456 · Scene 3") with clickable boundary preview images (4 frames showing before/after at left and right scene boundaries — clicking a pair seeks to that boundary), next/prev scene navigation via `goToNextScene`/`goToPrevScene` (mapped to PageDown/PageUp), drag-and-drop `.json` scene files onto the player (delegates to `onLoadSceneFile`), FPS correction when detected FPS differs from initial, `scenes=` param in shareable URL
- Boundary preview tooltip interaction: when preview images are present the tooltip switches to `pointer-events: auto` (class `vp-progress-tooltip-interactive`) with bottom padding replacing the margin gap so the cursor can travel from the progress bar into the previews. `onMouseMove` propagation is stopped on the tooltip to freeze the displayed scene while the cursor is inside. `onMouseLeave` on both the progress row and tooltip uses `relatedTarget` to avoid dismissing when the cursor moves between them

**ContextMenu** (`src/components/ContextMenu.tsx`) — Right-click context menu extracted from VideoControls. Renders via `createPortal` into the container element. Accepts `moduleConfig` and conditionally shows menu items: stats (`statsPanel`), audio levels (`audioLevels`), quality compare (`qualityCompare`), filmstrip (`filmstrip`), save MP4 (`segmentExport`). Always shows copy URL, in/out point controls, and subtitle-related items.

**ExportPicker** (`src/components/ExportPicker.tsx`) — Export rendition selection portal extracted from VideoControls. Reads the manifest's variant list from the Shaka player instance and renders a card with one row per rendition (height, codec, bitrate). Calls `onSelect` with the chosen `ExportRendition`.

**StatsPanel** (`src/components/StatsPanel.tsx`) — Real-time diagnostics overlay (13 stat rows, 1s update interval). Accessed via right-click context menu. Uses browser PlaybackQuality API with Shaka stats fallback.

**FilmstripTimeline** (`src/components/FilmstripTimeline.tsx`) — Canvas-based filmstrip panel below the video. Renders a zoomable/scrollable timeline with thumbnails generated by a web worker. Accepts an optional `clearKey` prop for encrypted content. Features:
- Two rendering modes: *packed* (one I-frame thumbnail per segment, segment width ≤ thumbnail width) and *gap* (multiple intra-frame thumbnails per segment when zoomed in)
- Per-segment bitrate graph drawn below thumbnails with colored bars (measured vs estimated)
- GOP tooltip on hover over bitrate bars showing per-frame size bars and per-type stats
- Save frame via right-click context menu with position-based frame targeting (see `docs/frame-pipeline.md`)
- Color-coded frame borders: red=I, blue=P, green=B
- Scene markers: dashed orange vertical lines (`rgba(255, 160, 40, 0.7)`) at scene boundaries spanning full canvas height, scene number labels ("S1", "S2", ...) in ruler area, hover tooltip when cursor is within ~3px of a boundary line showing before/after frame previews decoded via the thumbnail worker using frame-number-based index lookup (see `docs/boundary-preview.md`)
- Right-click context menu includes "Load scene data..." or "Clear scene data" (mutually exclusive, gated on `onLoadSceneData`/`onClearSceneData` props)

**useThumbnailGenerator** (`src/hooks/useThumbnailGenerator.ts`) — Hook that manages the thumbnail worker lifecycle. Extracts segment URLs from Shaka's manifest, spawns the worker, and handles lazy-loading based on visible viewport. When `clearKey` is provided for encrypted streams, passes the hex key to the worker for self-decryption. Exposes:
- `thumbnails` — `Map<number, ImageBitmap>`: I-frame thumbnails keyed by segment start time
- `intraFrames` — `Map<number, ImageBitmap[]>`: multiple decoded bitmaps per segment for gap mode
- `intraFrameTypes` — `Map<number, FrameType[]>`: I/P/B types for each intra bitmap
- `intraTimestamps` — `Map<number, number[]>`: exact CTS seconds for each intra bitmap (from mp4box, includes composition time offsets)
- `gopStructures` — `Map<number, GopFrame[]>`: frame types + byte sizes for GOP tooltip
- `saveFrame(time, framePosition?)` — one-shot full-resolution frame decode from the active stream; `framePosition` (0..1) identifies the frame by display-order index to avoid cross-stream CTS mismatches
- `boundaryPreviews` — `Map<number, BoundaryPreview>`: cached before/after ImageBitmaps for scene boundary hover tooltips, keyed by boundary time
- `requestBoundaryPreview(boundaryTime, frameNumber)` — triggers decode of frames adjacent to a scene boundary using frame-number-based index lookup
- `clearBoundaryPreviews()` — invalidates boundary preview cache when scene data changes (FPS correction)
- Memory eviction: bitmaps outside 3× the visible viewport span are closed and removed

**useBoundaryPreviews** (`src/hooks/useBoundaryPreviews.ts`) — Lightweight hook that spawns a dedicated `thumbnailWorker` instance purely for boundary preview decoding in the progress bar tooltip. Works independently of the filmstrip panel so boundary previews are available even when the filmstrip is closed. The worker is initialized with segment info via `generate` but receives no `updateQueue` messages, so it sits idle except when handling `boundaryPreview` requests. Overhead is minimal (one extra idle Worker thread, browser-cached init segment fetch). Enabled when `playerReady && !!sceneData && moduleConfig.sceneMarkers`. Called at the ShakaPlayer level; results are passed as props to VideoControls which renders two clickable pairs in the progress bar hover tooltip (left boundary: entry into current scene, right boundary: exit from current scene). Clicking a pair seeks the player to that scene boundary. Exposes:
- `boundaryPreviews` — `Map<number, BoundaryPreview>`: cached before/after ImageBitmaps keyed by boundary time
- `requestBoundaryPreview(boundaryTime, frameNumber)` — triggers decode of frames adjacent to a scene boundary
- `clearBoundaryPreviews()` — invalidates cache when scene data changes (FPS correction)

**thumbnailWorker** (`src/workers/thumbnailWorker.ts`) — Web Worker that fetches media segments, extracts samples via mp4box, decodes frames with VideoDecoder, and posts back ImageBitmaps. For CENC-encrypted content, integrates with `cencDecrypt` to decrypt samples before decoding. Key subsystems:

- **I-frame thumbnails** (`processQueue`): extracts sync samples only, decodes one I-frame per segment for the packed filmstrip view
- **Intra-frame generation** (`handleGenerateIntra`): decodes ALL frames in a segment, captures N evenly-spaced bitmaps for gap mode. Returns exact CTS timestamps alongside bitmaps so the component can snap to real presentation times
- **Frame type classification** (`classifyFrameTypes`): max-CTS heuristic — iterates samples in decode order tracking the highest CTS seen; sync samples → I, non-sync with CTS ≥ maxCts → P, non-sync with CTS < maxCts → B. Returns `GopFrame[]` in display (CTS) order with byte sizes
- **Active stream frame types** (`getActiveFrameTypes`): classifies from the watched rendition (e.g. 1080p) rather than the lowest-quality thumbnail stream, since different renditions may have different GOP structures. Results are cached by segment URL
- **Save frame** (`handleSaveFrame`): decodes all frames in the target segment at full resolution. When `framePosition` is provided (0..1), captures by display-order output index (`Math.round(position * (totalFrames - 1))`), which is immune to cross-stream CTS mismatches. Falls back to CTS-based timestamp matching when no position is given
- **GOP structure** (`requestGop`): lightweight handler that classifies frame types without video decoding, used for the GOP tooltip on hover
- **Boundary preview** (`handleBoundaryPreview`): decodes the last frame before and first frame after a scene boundary. Uses frame-number-based index lookup: receives the av1an frame number, computes `localIndex = frameNumber - segIdx * framesPerSeg`, reads exact CTS from `displayOrder[localIndex]`, then matches via `frame.timestamp`. This approach is immune to CTS/CTO/FPS mapping inaccuracies (see `docs/boundary-preview.md`)

**useBitrateGraph** (`src/hooks/useBitrateGraph.ts`) — Hook that computes per-segment bitrate for the filmstrip graph. Data sources in priority order:
1. Measured from network via Shaka's response filter (actual `response.data.byteLength`)
2. Byte-range metadata from segment references in the manifest
3. Estimated from the variant's declared `bandwidth` (lighter color in graph)

Formula: `bitrateBps = (bytes × 8) / segmentDuration`. Listens to `variantchanged`/`adaptation` events for rendition switches and retains historical measurements across switches.

**filmstripFrameMapping** (`src/utils/filmstripFrameMapping.ts`) — Pure functions modeling the save-frame pipeline for testability. Three stages that must agree:
1. Paint loop frame assignment: slot index → `captureIndices[arrIdx]` → which frame is displayed
2. Context-menu snap: click pixel → slot → `arrIdx` → normalized `framePosition` (0..1)
3. Worker frame capture: `framePosition` → `Math.round(position * (totalFrames - 1))` → display-order output index

The diagnostic test (`filmstripFrameMapping.test.ts`) runs the full pipeline at every zoom level (packed through max) with composition time offsets (0–3 frames) and cross-stream CTS mismatches. Run with `npx vitest run src/utils/filmstripFrameMapping.test.ts`.

**cencDecrypt** (`src/workers/cencDecrypt.ts`) — CENC decryption utility for ClearKey DRM in the thumbnail worker. Parses `tenc` and `schm` boxes from mp4box's tree, manually parses `senc` boxes from raw segment bytes (mp4box's senc parser is disabled), and performs AES-128-CTR decryption via Web Crypto API with subsample support. Key details:
- Only supports `cenc` scheme (AES-CTR); bails on `cbcs`/`cbc1`
- IV is right-padded to 16 bytes per CENC spec
- With subsamples: concatenates encrypted ranges into a single decrypt call, then re-interleaves with clear bytes
- Decryption is fully opt-in — gated on `clearKeyHex` being provided in the worker message

**softwareDecrypt** (`src/utils/softwareDecrypt.ts`) — Software ClearKey decryption fallback for browsers where ClearKey EME is absent or silently fails. Uses a two-layer detection strategy:
- **Layer 1 — pre-check** (`hasClearKeySupport()`): Probes `navigator.requestMediaKeySystemAccess('org.w3.clearkey', ...)` before loading. Result cached for session. Returns `false` on browsers where EME is entirely absent (e.g. Linux WebKitGTK) — software decryption is used directly, skipping EME entirely. Returns `true` on Chromium, Firefox, macOS WebKit.
- **Layer 2 — post-load detection** (`waitForDecryption()`): After loading with EME, polls `video.readyState` every 50ms for 1.5s. If readyState stays at HAVE_METADATA (1) despite buffered data, EME decryption silently failed — the CDM produced garbage the decoder drops. The player then unloads and reloads with the software decryption response filter. This catches macOS WebKit, where the EME API exists and the pre-check passes, but actual decryption silently fails.
- The two layers are complementary: Layer 1 prevents `player.load()` from hanging/throwing on browsers without EME; Layer 2 catches browsers that lie about EME support.

When activated, `configureSoftwareDecryption()` registers an async Shaka response filter with three stages:
- MANIFEST — strips `ContentProtection` elements from MPD XML so Shaka skips EME setup
- INIT_SEGMENT — caches original init bytes, parses tenc via mp4box, imports CryptoKey, rewrites `encv→avc1` and removes `sinf`/`pssh` via `stripInitEncryption`
- MEDIA_SEGMENT — parses senc, extracts samples via mp4box (using cached init), decrypts each sample in-place within mdat via `decryptSample`
- Segment type detection uses box presence (`moov` for init, `moof` for media) rather than Shaka's `AdvancedRequestType`, because SegmentBase streams tag sidx (index range) requests as INIT_SEGMENT which would overwrite cached init data
- Reuses utilities from `cencDecrypt.ts` (`importClearKey`, `extractTenc`, `parseSencFromSegment`, `decryptSample`, `findBoxData`) and `stripEncryptionBoxes.ts` (`stripInitEncryption`)
- Only supports `cenc` scheme (AES-CTR)

**useSleepWakeRecovery** (`src/hooks/useSleepWakeRecovery.ts`) — Hook extracted from VideoControls that detects system sleep via two complementary strategies: `visibilitychange` events and a timer-gap detector (1s interval that triggers when elapsed time exceeds 4s). On wake, starts a 5s guard window that intercepts unwanted play/seek events from Shaka's internal recovery. Accepts `videoEl` and `enabled` (gated on `moduleConfig.sleepWakeRecovery`). Returns `{ lastTimeRef, wasPausedRef, guardUntilRef }` so VideoControls' play/pause handlers can read them.

**useKeyboardShortcuts** (`src/hooks/useKeyboardShortcuts.ts`) — Hook for JKL shuttle, frame step, volume, fullscreen, in/out points, subtitle toggles, help modal hotkeys, and scene navigation (PageDown/PageUp). Accepts an `enabled` option (default `true`, gated on `moduleConfig.keyboardShortcuts`) — when `false`, the `useEffect` returns early without registering any key listeners. Scene navigation callbacks (`onNextScene`/`onPrevScene`) are optional and only wired when scene data is loaded.

**PlayerModuleConfig** (`src/types/moduleConfig.ts`) — Interface with boolean fields controlling which optional modules are active: `filmstrip`, `qualityCompare`, `statsPanel`, `audioLevels`, `segmentExport`, `subtitles`, `adaptationToast`, `keyboardShortcuts`, `sleepWakeRecovery`, `sceneMarkers`, `qpHeatmap`, `watermark`. `MODULE_DEFAULTS` has all fields `true`.

**SceneData types** (`src/types/sceneData.ts`) — Types for av1an scene detection integration: `Av1anScene` (raw scene entry with `start_frame`/`end_frame`), `Av1anSceneJson` (top-level JSON shape with `frames` count and `scenes` array), `SceneData` (processed: `totalFrames`, `boundaries: number[]` in seconds, `fps`, `originalFrames: number[]` preserving raw frame numbers for index-based worker lookup).

**parseSceneData** (`src/utils/parseSceneData.ts`) — Pure function `parseSceneData(json: unknown, fps: number): SceneData | null`. Validates av1an JSON structure, converts `start_frame > 0` to seconds via `frame / fps`, sorts and deduplicates boundaries, preserves original frame numbers in `originalFrames`. Returns null on invalid input or fps <= 0.

**detectCapabilities** (`src/utils/detectCapabilities.ts`) — Async function that probes browser APIs (`VideoDecoder`, `WebGL2`, `AudioContext`, `Worker`, `OffscreenCanvas`) and hardware (`hardwareConcurrency`, `deviceMemory`) to produce a `DeviceProfile`. Result is cached at module level. Classifies a `performanceTier` of `'low'`/`'mid'`/`'high'` used for soft-gating heavy modules.

**autoConfig** (`src/utils/autoConfig.ts`) — Maps a `DeviceProfile` + optional build preset to a `PlayerModuleConfig`. Applies hard gates (missing APIs disable dependent modules) and soft gates (low-tier devices disable filmstrip + qualityCompare). See `docs/module-config.md` for the full three-layer config system.

**biquadProcess** (`src/utils/biquadProcess.ts`) — Software IIR biquad filter for use in Web Workers where Web Audio IIRFilterNode is unavailable. Implements Direct Form I transfer function. Provides `applyBiquad(samples, coeffs, state)` and `applyKWeighting(samples, kCoeffs, shelfState, hpfState)`. State persists across blocks for filter continuity. Reuses `BiquadCoeffs`/`KWeightCoeffs` types from `kWeighting.ts`.

**audioMeterWorker** (`src/workers/audioMeterWorker.ts`) — Web Worker for EC-3 software decode: concatenates init + media fMP4 bytes, decodes via `OfflineAudioContext.decodeAudioData()`, computes per-channel levels/K-weighting/TruePeak per 2048-sample block, posts back `MeterBlock[]` and per-channel PCM `Float32Array[]` (transferable) for playback via `AudioBufferSourceNode`. Also exports shared types (`MeterBlock`, message interfaces).

**useAudioMeterFallback** (`src/hooks/useAudioMeterFallback.ts`) — Fallback audio metering for Safari MSE (WebKit bug #266922: `MediaElementAudioSourceNode` returns silence). Runs entirely on the main thread — no worker dependency. Pipeline: bootstraps by extracting audio stream from Shaka's manifest → fetches init segment → parses with mp4box for track IDs/timescale/codec → fetches media segments → extracts raw AAC samples via mp4box `setExtractionOptions`/`onSamples` → wraps in ADTS headers → decodes via `OfflineAudioContext.decodeAudioData()` → computes per-block RMS/K-weighted/TruePeak metering. Also registers a Shaka response filter for ongoing segments. Computes presentation time offset (PTO) from tfdt vs Shaka's segment reference to map DASH media timeline to presentation timeline. Caches `MeterBlock[]` sorted by time with binary-search lookup. Maintains LUFS ring buffers, gating state, and LRA state (same logic as `useLoudnessMeter`). Exposes `readLevels()` and `readLoudness()` with identical interfaces to `useAudioAnalyser`/`useLoudnessMeter`. Memory eviction: blocks outside ±30s of playback position.

**dashAudioParser** (`src/utils/dashAudioParser.ts`) — Parses DASH MPD XML to extract EC-3/AC-3 audio tracks that the browser cannot natively decode. Extracts `SegmentTemplate` patterns, `SegmentTimeline`, `BaseURL`, channel config, bandwidth. Provides `parseEc3Tracks(manifestText, manifestUrl)` → `Ec3TrackInfo[]`, `stripEc3FromManifest(manifestText)` → modified XML, and `resolveSegmentUrls(segInfo, startTime, endTime)` for independent segment fetching.

**ec3Decoder** (`src/wasm/ec3Decoder.ts`) — WASM EC-3/AC-3 decoder wrapper. Loads a minimal WASM build of FFmpeg's AC-3/E-AC-3 decoders (see `wasm/build-ec3.sh`). Provides `createEc3Decoder(channels, sampleRate)` → `Ec3DecoderInstance` with `decode(frame)` → per-channel `Float32Array[]` PCM. EC-3 patents expired January 2026.

**useAudioPlayback** (`src/hooks/useAudioPlayback.ts`) — Plays decoded PCM through `AudioContext` → `AudioBufferSourceNode`, synchronized to video timeline. Double-buffer scheduling (300ms lookahead), drift detection (re-sync if >50ms), handles play/pause/seek/ratechange events. Mutes native video audio when active. Exposes `enqueueChunk(PcmChunk)`, `flush()`, `getAudioContext()`.

**useEc3Audio** (`src/hooks/useEc3Audio.ts`) — Orchestrates EC-3 software decode playback. When activated: fetches EC-3 segments independently (15s prefetch), sends to `audioMeterWorker` for decode, feeds PCM to `useAudioPlayback`, provides metering blocks. Handles seek (flush + re-fetch), memory eviction (±30s). Exposes `activate(track)`, `deactivate()`, `readMeterBlocks()`.

**useTrackAMeter** (`src/hooks/useTrackAMeter.ts`) — Unified Track A metering selector shared by AudioLevels and AudioCompare. Wraps three backends (Web Audio, Safari fallback, EC-3) and dispatches by priority: EC-3 → fallback (Safari or `preferPrecomputed`) → Web Audio. The `preferPrecomputed` flag is `showAudioCompare` — when AudioCompare is open, Track A uses the same pre-computed pipeline as Track B to eliminate metering discrepancy. The fallback always runs (when not EC-3) so blocks are pre-populated. Web Audio stays enabled even when fallback output is selected to keep the `AudioContext` alive. See `docs/audio-compare.md`.

**useAudioCompareMeter** (`src/hooks/useAudioCompareMeter.ts`) — Independent Track B metering for AudioCompare. Fetches and decodes audio segments via a dedicated `audioMeterWorker` instance (no native playback). 3-stage decode fallback: `OfflineAudioContext` on fMP4 → ADTS-wrapped AAC → WASM EC-3 decoder. Prefetches 15s ahead, evicts ±30s. Exposes `activate(track)`, `deactivate()`, `readLevels()`, `readLoudness()`.

**Utilities** in `src/utils/`: `formatTime`, `formatTrackRes`, `safeNum`, `formatBitrate`, `parseSceneData` — small pure functions.

## Testing

Unit tests: Vitest + jsdom. Files alongside source (`src/**/*.test.{ts,tsx}`). See `docs/testing.md` for full details.

E2E tests: Playwright across Chromium, Firefox, WebKit, Edge. Files in `e2e/`. Uses route-intercepted fixtures (MP4, DASH, encrypted DASH, HEVC, AV1). See `docs/testing.md` for fixtures, CI matrix, codec support matrix, platform nuances, and per-suite documentation.

## Conventions

- CSS classes prefixed with `vp-` (vibe player)
- Shaka Player types accessed via the `shaka` global namespace
- Strict TypeScript (`strict: true`, `noUnusedLocals`, `noUnusedParameters`)
- Functional components with hooks only (no class components)

## Detailed Documentation

- `docs/testing.md` — E2E fixtures, CI matrix, codec support, platform nuances, per-suite docs
- `docs/frame-pipeline.md` — Save frame pipeline, frame analysis pitfalls (CTS, cross-stream mismatches)
- `docs/quality-compare.md` — Compare mode internals: layer architecture, sync strategy, URL params, highlight/spotlight, analysis modes
- `docs/diff-renderer-sync.md` — Diff renderer WebGL2 pipeline and compositor sync
- `docs/ssim-performance.md` — SSIM algorithm optimization research
- `docs/vmaf.md` — VMAF implementation specification
- `docs/adaptation-toast.md` — ABR adaptation toast component
- `docs/artifact-analysis-research.md` — Video artifact analysis research
- `docs/stats-for-nerds.md` — Stats panel implementation
- `docs/module-config.md` — Modular architecture: config-based feature toggling, build presets, capability detection
- `docs/manifest-validator-spec.md` — Manifest & stream validation: industry landscape, validation rules, implementation phases
- `docs/scene-boundary-timing.md` — Scene boundary CTO investigation: DASH composition time offset analysis
- `docs/boundary-preview.md` — Boundary preview: frame-number-based scene boundary visualization, investigation history
- `docs/audio-compare.md` — AudioCompare: side-by-side track metering, Track A/B pipeline, pause behavior, extending
