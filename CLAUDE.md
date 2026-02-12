# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Vibe Player — a custom web video player built with React 19, TypeScript, and Shaka Player 5 for adaptive streaming (DASH/HLS). Replaces native browser controls with a dark-themed custom overlay. Supports ClearKey DRM auto-detection, multi-track audio/subtitles, playback diagnostics, and sleep/wake recovery.

## Commands

- `npm run dev` — Start Vite dev server with HMR
- `npm run build` — TypeScript check + Vite production build
- `npm run lint` — ESLint (flat config, ESLint 9+)
- `npm run test` — Vitest in watch mode
- `npm run test:run` — Vitest single run (CI mode)
- `npm run test:coverage` — Coverage report
- Run a single test file: `npx vitest run src/utils/formatTime.test.ts`

## Architecture

Entry: `index.html` → `src/main.tsx` → `src/App.tsx`

**App.tsx** — Root component. Renders a URL input form; on submit passes the manifest URL to ShakaPlayer.

**ShakaPlayer** (`src/components/ShakaPlayer.tsx`) — Bridge between React and the native Shaka Player library. Handles:
- One-time polyfill installation at module level
- Manifest fetching to auto-detect ClearKey DRM (`cenc:default_KID`)
- Prompting for decryption key when DRM is detected
- Playback state persistence via sessionStorage
- Error handling with severity categorization
- Clean destruction on unmount via a `destroyed` safety flag

**VideoControls** (`src/components/VideoControls.tsx`) — The largest component (~715 lines). Custom overlay UI with 20+ state variables managing:
- Play/pause, seek bar, volume slider, quality/speed/audio/subtitle popups
- Auto-hide (3s inactivity timer)
- Sleep/wake recovery (visibilitychange + timer-gap detection with 5s guard window)
- Right-click context menu (Stats toggle) rendered via React portal
- Fullscreen API integration

**StatsPanel** (`src/components/StatsPanel.tsx`) — Real-time diagnostics overlay (13 stat rows, 1s update interval). Accessed via right-click context menu. Uses browser PlaybackQuality API with Shaka stats fallback.

**Utilities** in `src/utils/`: `formatTime`, `formatTrackRes`, `safeNum` — small pure functions.

## Testing

Tests use Vitest + React Testing Library + jsdom. Test files live alongside source: `src/**/*.test.{ts,tsx}`.

Mock helpers in `src/test/helpers/`:
- `createMockVideoElement.ts` — mock HTMLVideoElement with event listener tracking
- `createMockShakaPlayer.ts` — mock Shaka Player instance with variant/audio/text tracks

Setup file: `src/test/setup.ts` (jest-dom matchers, automatic cleanup).

## Conventions

- CSS classes prefixed with `vp-` (vibe player)
- Shaka Player types accessed via the `shaka` global namespace
- Strict TypeScript (`strict: true`, `noUnusedLocals`, `noUnusedParameters`)
- Functional components with hooks only (no class components)
