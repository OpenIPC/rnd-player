# DRM Diagnostics Panel

Client-side DRM diagnostics panel that surfaces encryption metadata, EME session lifecycle events, license exchange details, silent failure patterns, and cross-DRM compatibility insights — all from within the player UI with zero server-side instrumentation required.

---

## Features

### 1. DRM Metadata Inspector

Extracts and displays encryption metadata from two sources:

- **Manifest** (DASH MPD / HLS m3u8) — `ContentProtection` elements (scheme URI, default KID, PSSH base64, robustness, license URL) and `#EXT-X-KEY` tags (method, URI, key format, IV). Deduplicates identical entries across AdaptationSets.
- **Init segment** (ISOBMFF) — per-track encryption info from `tenc` boxes (scheme, KID, IV size) and PSSH boxes. Captured via Shaka response filter on first init segment.

PSSH boxes are decoded inline for known systems:
- **Widevine** — protobuf wire-format decode: algorithm, key IDs, provider, content ID, policy, protection scheme
- **PlayReady** — Object Header + UTF-16LE XML decode: KID (LE GUID reorder), LA_URL, LUI_URL, custom attributes
- **Generic** — hex dump with copy button

Data is grouped by DRM system name in the Metadata tab.

### 2. EME Event Timeline

Structured timeline of all EME lifecycle events with timing annotations.

**Capture strategy:** Callback injection at existing call sites (`onEmeEvent` in Widevine/FairPlay proxy opts, direct recording in ClearKey path), plus Shaka native events (`drmsessionupdate`, `keystatuschanged`, `expirationupdated`) for PlayReady coverage. No monkey-patching of `navigator.requestMediaKeySystemAccess`.

**Accumulation:** Events accumulate in a `useRef<EmeCapture>` to avoid per-event re-renders. State syncs to `drmDiagnosticsState.emeEvents` via 500ms interval when panel is open.

| Type | Label | Color | Sources |
|------|-------|-------|---------|
| `access-request` | ACCESS? | neutral | ClearKey/FairPlay/Widevine probe |
| `access-granted` | ACCESS+ | green | EME supported |
| `access-denied` | ACCESS- | yellow | EME absent |
| `keys-set` | SET | neutral | DRM configured |
| `generate-request` | INIT | neutral | FairPlay webkitneedkey |
| `message` | MSG | neutral | License challenge (Widevine/FairPlay) |
| `update` | UPDATE | green | License response, content loaded |
| `key-status-change` | STATUS | neutral | Key added, Shaka keystatuschanged |
| `expiration-change` | EXPIRY | neutral | Shaka expirationupdated |
| `error` | ERROR | red | Parse failure, EME silent failure |

Each row shows: relative timestamp, colored type badge, detail text, inter-event latency. Rows with `data` expand to show JSON on click. Per-tab Clear and Copy JSON buttons.

### 3. License Exchange Inspector

Captures license server communication via closure-based timing in existing request/response filters and fetch wrappers.

**Capture points:**
- **ClearKey** — wraps `fetchLicense()` in `drmClient.ts`
- **Widevine** — closure variables in `configureWidevineProxy()` request/response filters
- **FairPlay** — wraps `fetch()` in `setupFairPlay()` `webkitkeymessage` handler

**Security:** Bodies masked at capture time (`maskHeaders`, `maskClearKeyRequest/Response`, `maskWidevineRequest/Response`, `maskFairPlayRequest/Response`). Panel never sees raw secrets (tokens, keys, fingerprints).

**Decoded views** for our license server response formats: session ID, key count, policy (expiry, renewal, max resolution), transport key, watermark presence.

### 4. Silent Failure Detector

12 checks that proactively diagnose common DRM failure patterns producing no error message:

| ID | Pattern | Execution |
|----|---------|-----------|
| SF-001 | EME API absent | Pre-load |
| SF-002 | EME present, CDM absent | Pre-load |
| SF-003 | CDM present, silent decode failure (macOS WebKit) | Post-load |
| SF-004 | Key status `output-restricted` (HDCP) | Post-load |
| SF-005 | Key status `expired` | Post-load |
| SF-006 | Key status `internal-error` | Post-load |
| SF-007 | Key status `output-downscaled` | Post-load |
| SF-008 | KID mismatch (manifest vs init segment) | Post-load |
| SF-009 | Wrong encryption scheme for browser CDM | Post-load |
| SF-010 | PSSH missing for active DRM system | Post-load |
| SF-011 | License server unreachable | On-error |
| SF-012 | License server error response | On-error |

Results sorted by severity (error > warning > info). Empty state shows "No issues detected".

### 5. Cross-DRM Compatibility Checker

Probes browser support for Widevine, PlayReady, FairPlay, and ClearKey via `requestMediaKeySystemAccess()` with progressively relaxed robustness levels. Results cached at module level.

Displays: support status, highest robustness level, key system ID. Footer shows EME API availability, secure context status, and software decrypt availability.

### 6. Report Export

Mirrors `src/utils/manifestValidation/reportExport.ts` pattern:

- **Copy** — `formatTextReport()` produces plain-text report covering all sections. `copyReport()` writes to clipboard with "Copied!" feedback.
- **PDF** — `openPrintReport()` builds styled HTML with severity colors and `@media print` rules, opens in new window, triggers print dialog.

Footer bar with Copy/PDF buttons always visible regardless of active tab.

### 7. Tab Navigation

Five tabs: Metadata | Timeline | License | Diagnostics | Compat. Tabs with items show count badges (e.g. "Timeline (7)"). Local `useState<TabId>` — no shared tab component.

### 8. Access Patterns

- **Context menu** — "DRM diagnostics" / "Hide DRM diagnostics" toggle, gated on `moduleConfig.drmDiagnostics`
- **Keyboard shortcut** — `D` key toggles panel (gated on `moduleConfig.keyboardShortcuts`)
- **Auto-badge** — orange dot on context menu item when silent failure diagnostics detect issues (`drmDiagnosticCount` prop)
- **Click isolation** — panel root `onClick` stops propagation, listed in VideoControls' play/pause click exclusion chain

---

## Architecture

### Data Flow

```
                 +------------------+
                 |   ShakaPlayer    |
                 +--------+---------+
                          |
        +-----------------+------------------+-----------------+
        |                 |                  |                  |
  manifestText       init segment      EME lifecycle    license exchanges
  (fetchWithCorsRetry) (Shaka filter)  (callbacks +     (closure capture in
        |                 |             Shaka events)    proxy filters/fetch)
        v                 v                  |                  |
  +-------------+  +-------------+  +-------------+  +----------------+
  |parseManifest|  |parseInitSeg |  |  EmeCapture |  | LicenseCapture |
  |Drm()        |  |Drm()        |  |  (useRef)   |  |   (useRef)     |
  |(DOMParser)  |  |(mp4box)     |  |  record()   |  |   record()     |
  +------+------+  +------+------+  +------+------+  +-------+--------+
         |                |                 |                  |
         +--------+-------+       500ms sync interval ---------+
                  |                 (when panel open)
                  v                        |
       +---------------------------+       |
       |   DrmDiagnosticsState     |<------+
       | { manifest,               |
       |   manifestPsshBoxes,      |
       |   initSegment,            |
       |   emeEvents,              |
       |   licenseExchanges,       |
       |   diagnostics,            |
       |   compatibility }         |
       +------------+--------------+
                    | props
                    v
       +---------------------------+
       |  DrmDiagnosticsPanel      |
       |  (lazy-loaded, tabbed)    |
       +---------------------------+
```

### Component Hierarchy

```
ShakaPlayer
+-- DrmDiagnosticsPanel (lazy, Suspense)
|   +-- Tab bar (Metadata | Timeline | License | Diagnostics | Compat)
|   +-- Metadata tab
|   |   +-- CollapsibleSection per DRM system (grouped by systemName)
|   |   |   +-- ContentProtectionRow
|   |   |   +-- PsshBoxView -> WidevinePsshView / PlayReadyPsshView
|   |   +-- CollapsibleSection("HLS Keys") -> HlsKeyRow
|   |   +-- CollapsibleSection("Track Encryption") -> TrackEncryptionRow
|   +-- Timeline tab -> EmeTimelineSection -> EmeEventRow
|   +-- License tab -> LicenseExchangeSection -> LicenseExchangeRow -> DecodedLicenseView
|   +-- Diagnostics tab -> DiagnosticsSection -> DiagnosticItem
|   +-- Compat tab -> CompatibilitySection -> CompatRow
|   +-- Export footer (Copy + PDF)
+-- VideoControls
|   +-- ContextMenu ("DRM diagnostics" item + orange badge)
+-- ...
```

### File Map

```
src/drm/diagnostics/
  types.ts                   -- DRM_SYSTEM_IDS, PsshBox, ManifestDrmInfo, InitSegmentDrmInfo, DrmDiagnosticsState
  parseManifestDrm.ts        -- DASH ContentProtection + HLS EXT-X-KEY extraction
  parseInitSegmentDrm.ts     -- tenc/scheme/PSSH from init segment via mp4box
  psshDecode.ts              -- PSSH box parser, recursive ISOBMFF scan, base64 decode
  psshWidevinePb.ts          -- Widevine protobuf wire-format decoder
  psshPlayready.ts           -- PlayReady Object Header + UTF-16LE XML decoder
  emeCapture.ts              -- EmeCapture class (record, getEvents, clear)
  licenseCapture.ts          -- LicenseCapture class + masking/decode helpers
  silentFailures.ts          -- 12 failure pattern checks (pre-load, post-load, on-error)
  compatChecker.ts           -- Cross-DRM requestMediaKeySystemAccess probing
  reportExport.ts            -- Plain text + HTML report export (Copy + PDF)
  parseManifestDrm.test.ts   -- 13 tests
  psshDecode.test.ts         -- 12 tests
  psshWidevinePb.test.ts     -- 11 tests
  emeCapture.test.ts         -- 8 tests
  licenseCapture.test.ts     -- 14 tests
  silentFailures.test.ts     -- 18 tests
  compatChecker.test.ts      -- 6 tests
  reportExport.test.ts       -- 10 tests

src/components/
  DrmDiagnosticsPanel.tsx    -- Main panel (tabbed, lazy-loaded)
  ShakaPlayer.tsx            -- State management, data collection, Shaka integration
  ShakaPlayer.css            -- vp-drm-* styles
  VideoControls.tsx          -- Toggle state, click exclusion, keyboard shortcut wiring
  ContextMenu.tsx            -- Menu item + diagnostic count badge
  icons.tsx                  -- DrmDiagnosticsIcon

src/hooks/
  useKeyboardShortcuts.ts    -- D key handler
```

### Key Design Decisions

- **Callback injection, not monkey-patching.** All DRM paths are controlled code — `onEmeEvent` / `onLicenseExchange` callbacks injected at existing call sites. PlayReady covered via Shaka's native events.
- **Mask at capture time.** Sensitive values (tokens, keys, fingerprints) masked in `LicenseCapture` helpers before entering React state. Panel never sees raw secrets.
- **Ref-based accumulation.** EME events and license exchanges accumulate in `useRef` instances to avoid per-event re-renders. State syncs via 500ms interval only when panel is open.
- **First init segment only.** Response filter skips subsequent init segments via `prev.initSegment ? prev : ...`.
- **No WASM decoder reuse pitfall.** Each subsystem creates fresh instances where needed (same principle as QP heatmap — WASM module cached at loader level).
- **Module config gating.** `drmDiagnostics: true` in `PlayerModuleConfig` defaults. No hard/soft gate in `autoConfig.ts` — read-only diagnostics with negligible overhead until opened.

### Styling

All CSS in `ShakaPlayer.css`, classes prefixed `vp-drm-`:

| Group | Classes |
|-------|---------|
| Panel | `vp-drm-panel`, `vp-drm-close`, `vp-drm-title`, `vp-drm-empty` |
| Tabs | `vp-drm-tab-bar`, `vp-drm-tab`, `vp-drm-tab.active`, `vp-drm-tab-count` |
| Sections | `vp-drm-section`, `vp-drm-section-header`, `vp-drm-section-body`, `vp-drm-collapse-icon` |
| Cards/rows | `vp-drm-card`, `vp-drm-row`, `vp-drm-label`, `vp-drm-value`, `vp-drm-mono`, `vp-drm-truncate` |
| PSSH | `vp-drm-decoded`, `vp-drm-decoded-title`, `vp-drm-hex-toggle`, `vp-drm-hex` |
| Timeline | `vp-drm-timeline`, `vp-drm-timeline-actions`, `vp-drm-event`, `vp-drm-event-time/type/detail/latency/data` |
| License | `vp-drm-license`, `vp-drm-license-header/system/url/status/duration/details/subsection/body/decoded` |
| Diagnostics | `vp-drm-diag-item/header/severity/id/title/detail/pass` |
| Compat | `vp-drm-compat-table/supported/unsupported/footer/probe` |
| Export | `vp-drm-footer`, `vp-drm-export`, `vp-drm-export-btn` |
| Badge | `vp-drm-diag-badge` (orange `#fb3`, mirrors `vp-mv-badge` pattern) |
| Buttons | `vp-drm-copy` (inline copy) |
