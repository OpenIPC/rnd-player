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

### Component Tree

```
App.tsx                          — URL form, capability detection, module config, scene data loading
├── ShakaPlayer.tsx              — Shaka Player bridge, DRM, state persistence, error handling
│   ├── VideoControls.tsx        — Custom overlay UI (play/pause, seek, volume, popups, scene markers)
│   │   ├── ContextMenu.tsx      — Right-click menu (portal)
│   │   └── ExportPicker.tsx     — Rendition selection for segment export (portal)
│   ├── FilmstripTimeline.tsx    — Canvas filmstrip panel (zoomable thumbnails, bitrate graph, GOP tooltip)
│   ├── StatsPanel.tsx           — Real-time diagnostics overlay (13 stat rows)
│   ├── WatermarkOverlay.tsx     — Canvas forensic watermark for DRM content
│   └── QualityCompare           — Side-by-side quality comparison (see docs/quality-compare.md)
└── ProResViewer.tsx             — ProRes MOV playback (see docs/prores-viewer.md)
    ├── ProResCanvas.tsx         — WebGL2 YUV 4:2:2/4:4:4 10-bit → RGB renderer
    └── ProResControls.tsx       — Play/pause, frame step, scrubber, metadata badge
```

### Module System

Features are toggled via `PlayerModuleConfig` (`src/types/moduleConfig.ts`) — boolean fields for each optional module. Three-layer config: build presets → capability auto-detection → user overrides (localStorage). See `docs/module-config.md`.

### Key Subsystems

**Filmstrip & Frame Decode** — `useThumbnailGenerator` hook manages a `thumbnailWorker` (Web Worker) that fetches segments, decodes frames via `VideoDecoder`, and posts `ImageBitmap`s. Supports I-frame thumbnails (packed mode), all-frame decode (gap mode), save frame, GOP structure, and boundary previews. Frame targeting uses position-based indexing to avoid CTS mismatches. See `docs/frame-pipeline.md`.

**CENC Decryption** — Two paths: `cencDecrypt.ts` (in-worker AES-128-CTR for thumbnail decode) and `softwareDecrypt.ts` (Shaka response filter fallback for browsers with broken/missing EME). Software path uses two-layer detection: pre-check probe + post-load readyState polling.

**Scene Data** — av1an JSON integration. `parseSceneData` converts frame numbers to seconds. Boundary previews use frame-number-based index lookup (immune to CTS/FPS inaccuracies). Scene markers appear in both the progress bar and filmstrip. See `docs/boundary-preview.md`.

**Audio Metering** — Three backends: Web Audio (`useAudioAnalyser`), Safari fallback (`useAudioMeterFallback` — WebKit bug #266922), EC-3 software decode (`useEc3Audio` + `audioMeterWorker` + WASM FFmpeg decoder). `useTrackAMeter` dispatches by priority. AudioCompare uses `useAudioCompareMeter` for independent Track B. See `docs/audio-compare.md`, `docs/loudness-metering.md`.

**QP Heatmap** — JM H.264 WASM decoder extracts per-macroblock QP values. Worker uses direct trun/mdat parsing (not mp4box.js, which reorders by CTS). See `docs/qp-map.md`.

**ProRes Viewer** — Direct ProRes MOV playback in the browser. HTTP Range requests provide random access to frames in large files (up to 1.5 TB). `proResProbe.ts` parses the moov atom directly to build the sample table. A pool of N decode workers (`proResWorker.ts`) each run an FFmpeg ProRes WASM decoder (`proresDecoder.ts`), decoding frames in parallel (ProRes is intra-only). An adaptive ring buffer feeds a WebGL2 renderer (`useProResRenderer`) that converts YUV 4:2:2/4:4:4 10-bit to RGB via R16UI integer textures and BT.709 color matrix. See `docs/prores-viewer.md`.

**Sleep/Wake Recovery** — `useSleepWakeRecovery` detects sleep via `visibilitychange` + timer-gap detector, guards against Shaka's spurious recovery events.

## Testing

- **Unit**: Vitest + jsdom, files alongside source (`src/**/*.test.{ts,tsx}`)
- **E2E**: Playwright across Chromium, Firefox, WebKit, Edge, files in `e2e/`, route-intercepted fixtures
- See `docs/testing.md` for fixtures, CI matrix, codec support matrix, platform nuances

## Conventions

- CSS classes prefixed with `vp-` (vibe player)
- Shaka Player types accessed via the `shaka` global namespace
- Strict TypeScript (`strict: true`, `noUnusedLocals`, `noUnusedParameters`)
- Functional components with hooks only (no class components)
- Web Workers for heavy compute (frame decode, audio decode, QP extraction)
- Memory eviction patterns: bitmaps/blocks outside viewport or ±30s of playback position

## Docs

- `docs/testing.md` — E2E fixtures, CI matrix, codec support, platform nuances
- `docs/frame-pipeline.md` — Save frame pipeline, CTS pitfalls, cross-stream mismatches
- `docs/quality-compare.md` — Compare mode: layers, sync, URL params, analysis modes
- `docs/diff-renderer-sync.md` — Diff renderer WebGL2 pipeline and compositor sync
- `docs/module-config.md` — Config-based feature toggling, build presets, capability detection
- `docs/boundary-preview.md` — Frame-number-based scene boundary visualization
- `docs/audio-compare.md` — Side-by-side track metering, Track A/B pipeline
- `docs/loudness-metering.md` — LUFS/LRA metering implementation
- `docs/qp-map.md` — QP heatmap: JM WASM decoder, overlay rendering
- `docs/qp-heatmap-browser-bug.md` — mp4box.js CTS reordering bug and fix
- `docs/drm-system-spec.md` — DRM system architecture
- `docs/ssim-performance.md` — SSIM algorithm optimization research
- `docs/vmaf.md` — VMAF implementation specification
- `docs/adaptation-toast.md` — ABR adaptation toast component
- `docs/stats-for-nerds.md` — Stats panel implementation
- `docs/scene-boundary-timing.md` — DASH composition time offset analysis
- `docs/safari-webaudio-silence-bug.md` — Safari WebAudio silence workaround
- `docs/audio-decode-workarounds.md` — Audio decode fallback strategies
- `docs/manifest-validator-spec.md` — Manifest & stream validation rules
- `docs/artifact-analysis-research.md` — Video artifact analysis research
- `docs/windows-hevc-ci-codec.md` — Windows HEVC codec CI setup
- `docs/prores-viewer.md` — ProRes MOV viewer: WASM decode, multi-worker pool, WebGL2 rendering
- `docs/prores-network-fetch.md` — ProRes fetch strategy: Chrome trace debugging, browser limitations, action points
