# Modular Architecture — Config-Based Feature Toggling

How the player enables and disables analysis modules at runtime and build time, allowing deployment as a full R&D tool (all modules on) or a lightweight near-production player (analysis modules stripped).

## Core Concept

Core playback (play/pause, seek, volume, quality, speed, fullscreen) is always available. Everything else is a **toggleable module** controlled by a unified `PlayerModuleConfig` — 10 boolean flags that gate rendering, event listeners, and lazy chunk loading.

```
PlayerModuleConfig {
  filmstrip         — FilmstripTimeline, useThumbnailGenerator, thumbnailWorker
  qualityCompare    — QualityCompare, useDiffRenderer, vmafCore
  statsPanel        — StatsPanel overlay
  audioLevels       — AudioLevels meter
  segmentExport     — Segment MP4 export (useSegmentExport, worker)
  subtitles         — SubtitleOverlay, useMultiSubtitles
  adaptationToast   — ABR adaptation toast notifications
  keyboardShortcuts — JKL shuttle, frame step, hotkeys
  sleepWakeRecovery — Visibilitychange + timer-gap sleep detector
  sceneMarkers      — av1an scene boundary visualization (progress bar ticks, filmstrip lines)
}
```

Default: all `true`. Defined in `src/types/moduleConfig.ts`.

## Three Configuration Layers

The final config is computed by stacking three layers. Each layer can only **disable** features that the previous layer left enabled — it cannot override a hard gate.

### Layer 1 — Build Preset (`vite.config.ts`)

The `VITE_MODULE_PRESET` environment variable selects a named preset that is compiled into the bundle as `__MODULE_PRESET__`. Three presets are defined:

| Preset | Modules disabled | Use case |
|---|---|---|
| `full` (default) | none | R&D / development |
| `production` | filmstrip, qualityCompare, audioLevels, segmentExport | Lightweight deployment |
| `minimal` | all 10 modules | Bare player with only core playback |

```bash
npm run build                  # full preset (default)
npm run build:production       # production preset
npm run build:minimal          # minimal preset
VITE_MODULE_PRESET=production npm run build  # explicit
```

The preset value is injected via Vite's `define` as `__MODULE_PRESET__` and read at runtime by `App.tsx` during capability detection.

### Layer 2 — Device Capability Detection (`src/utils/detectCapabilities.ts`)

On mount, `App.tsx` calls `detectCapabilities()` which probes the browser for hardware and API support. The result is a `DeviceProfile`:

| Field | Source | Fallback |
|---|---|---|
| `cpuCores` | `navigator.hardwareConcurrency` | 4 |
| `deviceMemoryGB` | `navigator.deviceMemory` | 4 |
| `webCodecs` | `typeof VideoDecoder` | — |
| `webGL2` | `canvas.getContext('webgl2')` | — |
| `webAudio` | `typeof AudioContext` (+ webkit prefix) | — |
| `workers` | `typeof Worker` | — |
| `offscreenCanvas` | `typeof OffscreenCanvas` | — |
| `performanceTier` | Heuristic from above fields | — |

The result is cached at module level (same pattern as `softwareDecrypt.ts:hasClearKeySupport()`).

**Performance tier classification** (`classifyTier`):

- **high** — cores >= 8, memory >= 8 GB, WebCodecs + WebGL2 both present
- **low** — cores <= 2 or memory <= 2 GB
- **mid** — everything else

`autoConfig()` in `src/utils/autoConfig.ts` maps the profile to a config by applying two kinds of gates:

**Hard gates** — disable modules when required browser APIs are absent:

| Module | Required APIs |
|---|---|
| `filmstrip` | WebCodecs, OffscreenCanvas |
| `qualityCompare` | WebCodecs, WebGL2 |
| `audioLevels` | Web Audio API |
| `segmentExport` | Web Workers |

**Soft gates** — disable computationally heavy modules on low-tier devices:

- `performanceTier === "low"` → `filmstrip = false`, `qualityCompare = false`

Evaluation order: build preset is applied first, then hard gates override on top. A build preset cannot enable a feature the device doesn't support.

### Layer 3 — User Overrides (Settings Modal)

Users can toggle individual modules in the Settings modal (gear icon → Features section). Overrides are persisted in `localStorage` under the `vp_settings` key as `moduleOverrides: Partial<PlayerModuleConfig>`.

Hard-gated modules (API absent per `DeviceProfile`) are shown as disabled checkboxes with an explanation (e.g. "Requires WebCodecs API"). Users cannot enable features the device doesn't support.

The merge in `App.tsx` follows this order:

```
autoConfig(deviceProfile, buildPreset)   → base config
  + user overrides from localStorage     → merged config
  + hard gate re-application             → final config
```

## Data Flow

```
App.tsx (mount)
  ├─ detectCapabilities() → DeviceProfile
  ├─ loadModuleOverrides() → Partial<PlayerModuleConfig>
  ├─ autoConfig(profile, __MODULE_PRESET__) → base config
  ├─ merge user overrides + re-apply hard gates → final PlayerModuleConfig
  └─ pass moduleConfig + deviceProfile + onModuleConfigChange as props
       │
       ├─ ShakaPlayer.tsx
       │    ├─ Gates FilmstripTimeline render on moduleConfig.filmstrip
       │    ├─ Gates QualityCompare render on moduleConfig.qualityCompare
       │    └─ Passes all three props to VideoControls
       │
       └─ VideoControls.tsx
            ├─ ContextMenu gates items per module flag
            ├─ StatsPanel portal gated on moduleConfig.statsPanel
            ├─ AudioLevels portal gated on moduleConfig.audioLevels
            ├─ AdaptationToast gated on moduleConfig.adaptationToast
            ├─ SubtitleOverlay receives empty cues when !moduleConfig.subtitles
            ├─ useKeyboardShortcuts receives enabled: moduleConfig.keyboardShortcuts
            ├─ useSleepWakeRecovery receives enabled: moduleConfig.sleepWakeRecovery
            ├─ ExportPicker gated via ContextMenu's moduleConfig.segmentExport
            ├─ Scene ticks/tooltip/navigation gated on moduleConfig.sceneMarkers
            └─ SettingsModal receives all three props for the Features UI
```

## Extracted Components and Hooks

Three pieces were extracted from `VideoControls.tsx` to support clean module gating:

### ContextMenu (`src/components/ContextMenu.tsx`)

The right-click context menu, previously ~130 lines of inline JSX in VideoControls. Now a standalone component that accepts `moduleConfig` and conditionally renders menu items:

- Stats for nerds: `moduleConfig.statsPanel`
- Audio levels: `moduleConfig.audioLevels`
- Quality compare: `moduleConfig.qualityCompare`
- Filmstrip timeline: `moduleConfig.filmstrip`
- Save MP4: `moduleConfig.segmentExport`

### ExportPicker (`src/components/ExportPicker.tsx`)

The export rendition picker portal (~60 lines), previously inline in VideoControls. Reads the manifest's variant list from the Shaka player and renders a selection card.

### useSleepWakeRecovery (`src/hooks/useSleepWakeRecovery.ts`)

The sleep/wake detection logic (visibilitychange listener + timer-gap detector + guard window), previously three refs and two `useEffect` blocks in VideoControls. Accepts `videoEl` and `enabled` parameters. Returns `{ lastTimeRef, wasPausedRef, guardUntilRef }` so VideoControls' play/pause handlers can still read them.

## Settings Persistence

`src/hooks/useSettings.ts` stores all player settings in `localStorage` under `vp_settings`. The `PlayerSettings` interface now includes:

```typescript
interface PlayerSettings {
  alwaysShowBitrate: boolean;
  moduleOverrides: Partial<PlayerModuleConfig>;  // added
}
```

Backward-compatible: existing stored `vp_settings` without `moduleOverrides` gets `{}` from the default spread. The convenience function `loadModuleOverrides()` returns the overrides directly.

When a user toggles a module in the Settings modal, `onModuleConfigChange` propagates up to `App.tsx`, which updates state and persists the full config as `moduleOverrides`.

## Settings Modal UI

The Settings modal (`src/components/SettingsModal.tsx`) has a new "Features" section below existing settings. Each module is a checkbox row with:

- **Label** — human-readable module name
- **Description** — one-line explanation (shown in smaller text below the label)
- **Disabled state** — when a hard gate applies, the checkbox is disabled and the description is replaced with the gate reason (e.g. "Requires WebCodecs API")

CSS classes: `.vp-settings-section-title`, `.vp-settings-desc`, `.vp-settings-disabled`.

## File Map

**Types and config:**
- `src/types/moduleConfig.ts` — `PlayerModuleConfig` interface, `MODULE_DEFAULTS` constant
- `src/utils/detectCapabilities.ts` — `DeviceProfile` interface, `detectCapabilities()` async probe
- `src/utils/autoConfig.ts` — `autoConfig()` merges preset + hard/soft gates

**Extracted components:**
- `src/components/ContextMenu.tsx` — right-click menu with module-aware item rendering
- `src/components/ExportPicker.tsx` — export rendition selection portal

**Extracted hooks:**
- `src/hooks/useSleepWakeRecovery.ts` — sleep/wake detection with `enabled` toggle

**Modified files:**
- `src/App.tsx` — capability detection, config state, prop passing
- `src/components/ShakaPlayer.tsx` — accepts config props, gates filmstrip/compare renders
- `src/components/VideoControls.tsx` — accepts config props, uses extracted components/hooks, gates all features
- `src/components/SettingsModal.tsx` — Features section with module toggles
- `src/hooks/useSettings.ts` — `moduleOverrides` field, `loadModuleOverrides()`
- `src/hooks/useKeyboardShortcuts.ts` — `enabled` parameter with early return
- `src/globals.d.ts` — `__MODULE_PRESET__` type declaration
- `vite.config.ts` — preset map, `VITE_MODULE_PRESET` env var, `__MODULE_PRESET__` define
- `package.json` — `build:production`, `build:minimal` scripts
