# DRM Diagnostics Panel — Feature Spec

Client-side DRM diagnostics panel that surfaces encryption metadata, EME session lifecycle events, license exchange details, silent failure patterns, and cross-DRM compatibility insights — all from within the player UI with zero server-side instrumentation required.

---

## Industry Tooling Landscape

### Standalone DRM Tools

| Tool | Capabilities | Limitations |
|------|-------------|-------------|
| **Bitmovin Stream Lab** | PSSH parsing, DRM detection, license exchange visualization | SaaS only, no self-hosted option, limited to Bitmovin player internals |
| **DRM Today Dashboard** | License issuance analytics, device fingerprinting stats | Server-side only, requires DRM Today integration |
| **BuyDRM KeyOS Inspector** | License request/response display, key status monitoring | Tied to BuyDRM ecosystem |
| **Widevine Device Analyzer** | L1/L3 detection, security level reporting, robustness queries | Widevine-only, requires partner portal access |
| **ExoPlayer DRM Debug** | EME event logging, key request/response hex dumps | Android-only, no web equivalent |

### Browser DevTools & Extensions

| Tool | Capabilities | Limitations |
|------|-------------|-------------|
| **chrome://media-internals** | EME session lifecycle, CDM version, key statuses | Chrome-only, raw event dumps with no interpretation, no PSSH decode |
| **EME Logger (Chrome extension)** | Intercepts `generateRequest`, `update`, `close` calls | Extension-only, no structured analysis, no failure diagnosis |
| **Firefox Media DevTools** | Basic EME status in about:debugging | Minimal DRM visibility, no PSSH decode |
| **Shaka Player Debug Log** | Verbose DRM subsystem logs at `shaka.log.DEBUG` level | Unstructured console output, requires manual filtering |

### Container Inspection

| Tool | Capabilities | Limitations |
|------|-------------|-------------|
| **mp4box.js** | PSSH box extraction, sinf/schm/tenc parsing | No DRM-specific interpretation, raw box data only |
| **Bento4 mp4dump** | Full ISOBMFF tree with PSSH/tenc/senc display | CLI tool, no browser integration, no live stream support |
| **ffprobe** | Encryption scheme detection, KID extraction | CLI tool, no real-time diagnostics |
| **GPAC MP4Box** | PSSH extraction, CENC metadata display | CLI tool, no web integration |

### Gap Analysis

No existing tool provides **all** of these in one place:

1. **Inline PSSH decoding** — Widevine protobuf parse, PlayReady XML parse, generic hex display — without leaving the player
2. **EME event timeline** — structured, filterable, with latency measurements between events
3. **Silent failure detection** — proactive diagnosis of CDM initialization failures, key status issues, or EME-present-but-non-functional scenarios (the macOS WebKit pattern this player already handles)
4. **License exchange inspection** — request/response bodies, headers, timing, error classification
5. **Cross-DRM compatibility matrix** — automated `requestMediaKeySystemAccess` probing across all four systems with robustness level detection

rnd-player is uniquely positioned: it already has ClearKey software decryption (`softwareDecrypt.ts`), CENC box parsing (`cencDecrypt.ts`), license server integration (`drmClient.ts`), and session management (`sessionManager.ts`). A diagnostics panel surfaces this internal state without adding new DRM logic.

### UX Patterns from Existing Tools

| Pattern | Source | Adaptation |
|---------|--------|------------|
| Collapsible tree view for nested data | chrome://media-internals | PSSH box tree, init segment encryption metadata |
| Timeline with latency annotations | Chrome Network DevTools | EME event timeline with inter-event durations |
| Color-coded status badges | Bitmovin Stream Lab | Key status indicators (usable/expired/output-restricted) |
| Copy-to-clipboard on click | mp4box.js demo | KID, key, PSSH hex, license URL |
| Severity-ranked issues list | rnd-player manifest-validator-spec | Silent failure diagnosis results |

---

## Diagnostic Capabilities

### 1. DRM Metadata Inspector

Extracts and displays encryption metadata from two sources: the manifest (MPD/m3u8) and init segments (ISOBMFF).

#### 1.1 Manifest-Level Metadata

Parse `ContentProtection` elements from DASH MPD (already fetched in `ShakaPlayer.tsx` as `manifestText`):

| Field | Source | Display |
|-------|--------|---------|
| Scheme ID URI | `@schemeIdUri` attribute | DRM system name (mapped: `urn:uuid:edef8ba9-...` → "Widevine", `urn:uuid:9a04f079-...` → "PlayReady", etc.) |
| Default KID | `@cenc:default_KID` | UUID format + raw hex, copy-to-clipboard |
| PSSH (base64) | `<cenc:pssh>` child element | Decoded via PSSH Box Decoder (section 6) |
| Robustness | `@robustness` attribute (Widevine) | `HW_SECURE_ALL`, `SW_SECURE_DECODE`, etc. |
| License URL | `<ms:laurl>` or `<widevine:license>` | Clickable (opens in new tab), copy-to-clipboard |

For HLS, parse `#EXT-X-KEY` and `#EXT-X-SESSION-KEY` tags:

| Field | Source | Display |
|-------|--------|---------|
| Method | `METHOD=` | `AES-128`, `SAMPLE-AES`, `SAMPLE-AES-CTR` |
| URI | `URI=` | Key/license URL |
| KEYFORMAT | `KEYFORMAT=` | DRM system identifier |
| KEYFORMATVERSIONS | `KEYFORMATVERSIONS=` | Version list |
| IV | `IV=` | Hex display |

#### 1.2 Init Segment Metadata

Reuse utilities from `cencDecrypt.ts` to parse ISOBMFF boxes from init segments:

| Field | Utility | Display |
|-------|---------|---------|
| Encryption scheme | `extractScheme(mp4, trackId)` | `cenc` / `cbcs` / `cbc1` / `cens` |
| Default KID | `extractTenc(mp4, trackId).defaultKID` | Hex, cross-validated against manifest KID |
| Default IV size | `extractTenc(mp4, trackId).defaultPerSampleIVSize` | `8` or `16` bytes |
| Constant IV | `extractTenc(mp4, trackId).defaultConstantIV` | Hex (cbcs only) |
| PSSH boxes | `findBoxData(initData, 'pssh')` | Decoded via PSSH Box Decoder |
| Track ID | `extractTrackIdFromTfhd()` or mp4box track list | Per-track encryption info |

**Validation cross-checks:**
- KID in manifest matches KID in tenc → show green checkmark
- KID mismatch → show warning with both values
- Scheme in manifest (`cenc:`) vs scheme in sinf/schm → show mismatch warning
- Multiple PSSH boxes → list all with system ID labels

### 2. EME Event Timeline — IMPLEMENTED

Structured timeline of EME lifecycle events with timing annotations, displayed as a collapsible section within `DrmDiagnosticsPanel`.

#### Event Capture Strategy

**Callback injection, not monkey-patching.** We control all DRM paths (ClearKey, Widevine, FairPlay) and inject `onEmeEvent` callbacks at existing call sites. For key systems handled by Shaka's built-in EME (e.g. PlayReady), we subscribe to Shaka's native player events.

Two capture layers:

1. **Proxy-level callbacks** — `onEmeEvent?: EmeEventCallback` added to `ConfigureWidevineProxyOpts` and `SetupFairPlayOpts`. ClearKey events recorded directly in `ShakaPlayer.tsx`'s `handleKeySubmit`. These capture DRM-path-specific detail (challenge bytes, license response, SPC/CKC, key errors).

2. **Shaka native events** — `player.addEventListener()` for `drmsessionupdate`, `keystatuschanged`, `expirationupdated`. These fire for any key system Shaka handles (including PlayReady) and supplement the proxy-level events.

**Ref-based accumulation, state sync on demand.** EME events fire rapidly during init. Using `useState` per event would thrash renders. Events accumulate in a `useRef<EmeCapture>`, synced to `drmDiagnosticsState.emeEvents` via a 500ms interval only when the panel is open.

#### Event Types

| Type | Label | Color | Sources |
|------|-------|-------|---------|
| `access-request` | ACCESS? | neutral | ClearKey probe, FairPlay probe, Widevine pre-load |
| `access-granted` | ACCESS ✓ | green | ClearKey EME supported, FairPlay supported |
| `access-denied` | ACCESS ✗ | yellow | ClearKey EME absent, FairPlay not supported |
| `keys-created` | KEYS | neutral | (reserved) |
| `keys-set` | SET | neutral | ClearKey/SW configured, Widevine configured, FairPlay WebKitMediaKeys |
| `generate-request` | INIT | neutral | FairPlay webkitneedkey |
| `message` | MSG | neutral | Widevine challenge, FairPlay SPC |
| `update` | UPDATE | green/neutral | License response, content loaded, SW fallback, Shaka drmsessionupdate |
| `key-status-change` | STATUS | neutral | FairPlay key added, Shaka keystatuschanged |
| `close` | CLOSE | neutral | (reserved) |
| `expiration-change` | EXPIRY | neutral | Shaka expirationupdated |
| `error` | ERROR | red | Parse failure, EME silent failure, key error, DRM load failure |

#### Event Coverage by DRM Path

| Path | Events recorded |
|------|----------------|
| **ClearKey (EME)** | access-request, access-granted, keys-set, update (load) + Shaka drmsessionupdate, keystatuschanged |
| **ClearKey (SW fallback)** | access-request, access-granted, keys-set, update (load), error (silent failure), update (SW fallback) |
| **ClearKey (no EME)** | access-request, access-denied, keys-set (SW decrypt), update (load) |
| **Widevine** | access-request, keys-set, message (challenge), update (license response), update (load) + Shaka drmsessionupdate, keystatuschanged |
| **FairPlay** | access-request, access-granted/denied, keys-set, generate-request, message (SPC), update (CKC), key-status-change, update (load), or error |
| **PlayReady** | Shaka drmsessionupdate, keystatuschanged, expirationupdated (generic Shaka events — no custom proxy) |
| **Unencrypted** | (no events — section hidden) |

#### Timeline Display

```
┌─ EME Events (7) ─────────────────────────────────────────────┐
│                                          [ Clear ] [Copy JSON]│
│                                                                │
│  00:00.000  ACCESS?  ClearKey EME probe                       │
│  00:00.012  ACCESS ✓ ClearKey EME supported        (+12ms)    │
│  00:00.013  SET      ClearKey configured             (+1ms)    │
│  00:00.156  UPDATE   Content loaded               (+143ms)    │
│  00:00.180  UPDATE   DRM session updated           (+24ms)    │
│  00:00.181  STATUS   Key status changed              (+1ms)    │
│                                                                │
│  (click row to expand data as JSON)                           │
└────────────────────────────────────────────────────────────────┘
```

Each event row shows: relative timestamp (MM:SS.mmm from first event), colored type badge, detail text, and inter-event latency `(+Nms)`. Rows with `data` are clickable — expands to show `JSON.stringify(event.data, null, 2)` in a `<pre>` block. Color coding: green for `success: true`, red for `success: false` or `type === "error"`, yellow for `access-denied`, neutral otherwise.

### 3. License Exchange Inspector — IMPLEMENTED

Capture license server communication via closure-based timing in existing request/response filters and fetch wrappers.

#### Capture Points

Shaka provides `player.getNetworkingEngine().registerRequestFilter()` and `registerResponseFilter()` for `RequestType.LICENSE`:

| Data | Source | Display |
|------|--------|---------|
| License URL | `request.uris[0]` | Full URL, copy-to-clipboard |
| Request method | `request.method` | GET/POST |
| Request headers | `request.headers` | Key-value list (Authorization bearer token masked) |
| Request body | `request.body` | Hex dump + decoded view (Widevine protobuf / PlayReady XML / ClearKey JSON) |
| Response status | Shaka error or success | HTTP status code |
| Response headers | `response.headers` | Key-value list |
| Response body | `response.data` | Hex dump + decoded view |
| Round-trip time | `performance.now()` delta | Milliseconds |
| Retry count | Shaka retry metadata | Number of attempts |

#### Decoded Views

For known license protocols, provide structured display:

**ClearKey (JSON)**
```json
{
  "keys": [
    { "kty": "oct", "kid": "...", "k": "..." }
  ],
  "type": "temporary"
}
```

**rnd-player License Server** (detected via `LicenseResponse` structure):
```
Session ID:     abc-123-def
Keys:           1 key(s)
  KID:          a1b2c3d4e5f60718... (copy)
  Key:          [present, 16 bytes]
Policy:
  Expiry:       2026-03-04T12:00:00Z (in 3h 42m)
  Renewal:      every 300s
  Max res:      1080
  Offline:      no
Transport:      ECDH-ES+A256KW (Phase 3)
Watermark:      session_short=A1B2, opacity=0.03
```

**Widevine** — protobuf license response (partially decoded where possible: key count, HDCP requirements, license duration).

**PlayReady** — XML license response (parsed: key count, policy, expiration).

#### Integration with Existing Code

The player already uses Shaka request/response filters in `softwareDecrypt.ts` (`configureSoftwareDecryption`). The diagnostics filter must be registered alongside (not replacing) existing filters. Shaka supports multiple filters — they execute in registration order.

The license fetch in `drmClient.ts` (`fetchLicense`) happens outside Shaka's network engine (direct `fetch`). For rnd-player's own license server, capture is done by wrapping `fetchLicense` rather than via Shaka filters.

### 4. Silent Failure Detector

Proactively diagnose common DRM failure patterns that produce no error message — the player simply doesn't play.

#### Failure Patterns

| ID | Pattern | Detection | Diagnosis |
|----|---------|-----------|-----------|
| SF-001 | EME API absent | `!navigator.requestMediaKeySystemAccess` | "Browser does not support EME. Software decryption will be used for ClearKey." |
| SF-002 | EME present, CDM absent | `requestMediaKeySystemAccess` rejects for all key systems | "No CDM installed. Widevine requires Chrome/Firefox/Edge. FairPlay requires Safari." |
| SF-003 | CDM present, silent decode failure | `hasClearKeySupport()` returns true but `waitForDecryption()` returns false | "EME API works but CDM produces invalid output (macOS WebKit pattern). Software decryption fallback activated." |
| SF-004 | Key status `output-restricted` | `player.getKeyStatuses()` contains `output-restricted` | "HDCP output protection triggered. Connect to an HDCP-compliant display or reduce resolution." |
| SF-005 | Key status `expired` | `player.getKeyStatuses()` contains `expired` | "License has expired. Renewal required." |
| SF-006 | Key status `internal-error` | `player.getKeyStatuses()` contains `internal-error` | "CDM internal error. This may indicate a corrupted CDM installation or incompatible hardware." |
| SF-007 | Key status `output-downscaled` | `player.getKeyStatuses()` contains `output-downscaled` | "Output is being downscaled due to HDCP constraints. Video quality may be reduced." |
| SF-008 | KID mismatch | Manifest `cenc:default_KID` ≠ `tenc.defaultKID` in init segment | "Key ID in manifest does not match init segment. Content may have been re-encrypted or re-packaged incorrectly." |
| SF-009 | Wrong encryption scheme | `extractScheme()` returns `cbcs` but browser only supports `cenc` (or vice versa) | "Content uses {scheme} encryption but this browser's CDM only supports {other}. Transcode with matching scheme." |
| SF-010 | PSSH missing for active DRM | Manifest has `ContentProtection` but no `<cenc:pssh>` and no PSSH in init segment | "No PSSH box found for {system}. The CDM cannot initialize without init data." |
| SF-011 | License server unreachable | `fetchLicense` or Shaka license request returns network error | "Cannot reach license server at {url}. Check network connectivity and CORS configuration." |
| SF-012 | License server error response | HTTP 4xx/5xx from license endpoint | "License server returned HTTP {status}. {interpretation based on status code}" |

#### Detection Execution

Checks run at three points:
1. **Pre-load** (SF-001, SF-002): during capability detection, before manifest load
2. **Post-load** (SF-003, SF-004..SF-007, SF-008..SF-010): after `player.load()` completes, using Shaka APIs and init segment data
3. **On-error** (SF-011, SF-012): when license fetch or EME operations fail

Results are accumulated in a `DiagnosticResult[]` array with severity levels:

```typescript
type DiagnosticSeverity = "error" | "warning" | "info";

interface DiagnosticResult {
  id: string;           // "SF-001" .. "SF-012"
  severity: DiagnosticSeverity;
  title: string;        // short description
  detail: string;       // full diagnosis message
  timestamp: number;    // performance.now()
  data?: unknown;       // supporting evidence (key statuses, PSSH bytes, etc.)
}
```

#### Relationship to Existing Detection

The player already implements SF-001 and SF-003 detection in `softwareDecrypt.ts`:
- `hasClearKeySupport()` → SF-001 (Layer 1)
- `waitForDecryption()` → SF-003 (Layer 2)

The diagnostics panel surfaces these existing detection results rather than duplicating the logic. It adds visibility into what the player already does silently.

### 5. Cross-DRM Compatibility Checker

Probe browser support for all four major DRM systems and report capabilities.

#### Probing Strategy

Call `navigator.requestMediaKeySystemAccess()` for each key system with progressively relaxed configurations:

```typescript
const KEY_SYSTEMS = [
  {
    id: "widevine",
    label: "Widevine",
    keySystem: "com.widevine.alpha",
    robustnessLevels: ["HW_SECURE_ALL", "HW_SECURE_DECODE", "HW_SECURE_CRYPTO", "SW_SECURE_DECODE", "SW_SECURE_CRYPTO"],
  },
  {
    id: "playready",
    label: "PlayReady",
    keySystem: "com.microsoft.playready",
    robustnessLevels: ["3000", "2000", "150"],
  },
  {
    id: "fairplay",
    label: "FairPlay",
    keySystem: "com.apple.fps",
    robustnessLevels: [],
  },
  {
    id: "clearkey",
    label: "ClearKey",
    keySystem: "org.w3.clearkey",
    robustnessLevels: [],
  },
];
```

For each key system:
1. Try `requestMediaKeySystemAccess` with video capabilities (`'video/mp4; codecs="avc1.640028"'`)
2. If successful, record the `MediaKeySystemAccess.getConfiguration()` result (actual selected config)
3. For Widevine: iterate robustness levels to find highest supported
4. Record `distinctiveIdentifier` and `persistentState` support

#### Display

```
┌─ Cross-DRM Compatibility ────────────────────────────────────┐
│                                                               │
│  DRM System        Status      Robustness    Notes           │
│  ─────────────     ──────      ──────────    ─────           │
│  Widevine          ● Supported  L3 (SW)     com.widevine.alpha │
│  PlayReady         ○ Not found  —           com.microsoft.playready │
│  FairPlay          ○ Not found  —           com.apple.fps    │
│  ClearKey          ● Supported  —           org.w3.clearkey  │
│                                                               │
│  EME API:          ✓ Present                                  │
│  Secure context:   ✓ HTTPS                                   │
│  CDM version:      (Widevine 4.10.2710.0)                    │
│                                                               │
│  Software decrypt: ✓ Available (ClearKey fallback)           │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

#### Integration with Existing Code

Reuse `hasClearKeySupport()` from `softwareDecrypt.ts` for the ClearKey check. The compatibility checker extends this pattern to all four DRM systems. Results are cached (same approach as `hasClearKeySupport`'s module-level `clearKeySupportCached`).

### 6. PSSH Box Decoder

Parse and display PSSH (Protection System Specific Header) boxes inline.

#### PSSH Box Structure (ISO 23001-7)

```
Box Type:   'pssh'
Container:  Movie Box ('moov') or Movie Fragment Box ('moof')
Fields:
  version           uint8     (0 or 1)
  flags             uint24
  SystemID          uint8[16] (DRM system UUID)
  KID_count         uint32    (version 1 only)
  KIDs              uint8[16] × KID_count (version 1 only)
  DataSize          uint32
  Data              uint8[DataSize] (system-specific)
```

#### System-Specific Decoding

**Widevine** (SystemID `edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`):

Decode the `Data` field as a protobuf (`WidevineCencHeader`):

| Field # | Type | Name | Display |
|---------|------|------|---------|
| 1 | enum | algorithm | `AESCTR` (1) |
| 2 | bytes (repeated) | key_id | Hex, one per line |
| 3 | string | provider | Provider name |
| 4 | bytes | content_id | Hex or UTF-8 attempt |
| 6 | string | policy | Policy name |
| 7 | uint32 | crypto_period_index | Number |
| 8 | bytes | grouped_license | Hex |
| 9 | uint32 | protection_scheme | `cenc`/`cbc1`/`cens`/`cbcs` (FourCC) |

Protobuf decoding is wire-format only (no .proto file needed): read field tags (field number + wire type), decode varints/length-delimited/fixed-width values. This is ~100 lines of code for the subset of types used in `WidevineCencHeader`.

**PlayReady** (SystemID `9a04f079-9840-4286-ab92-e65be0885f95`):

Decode the `Data` field as PlayReady Object Header:
1. Read PlayReady Header Object (little-endian length + record count)
2. Extract Record Type 1 (Rights Management Header) — UTF-16LE XML
3. Parse the XML to display:
   - `<KID>` — base64-encoded KID (convert to UUID format)
   - `<LA_URL>` — license acquisition URL
   - `<LUI_URL>` — license UI URL
   - `<CHECKSUM>` — integrity checksum
   - `<CUSTOMATTRIBUTES>` — custom data

**Generic / Unknown SystemID:**

Display hex dump with ASCII sidebar (16 bytes per row), similar to a hex editor view.

#### Display

```
┌─ PSSH Box #1 — Widevine ─────────────────────────────────────┐
│                                                                │
│  System ID:    edef8ba9-79d6-4ace-a3c8-27dcd51d21ed           │
│  Version:      0                                               │
│  Data size:    32 bytes                                        │
│                                                                │
│  Decoded (WidevineCencHeader):                                 │
│    Algorithm:  AESCTR                                          │
│    Key IDs:    a1b2c3d4-e5f6-0718-2930-a1b2c3d4e5f6           │
│    Provider:   "example_provider"                              │
│    Content ID: 6578616d706c65 (hex) / "example" (UTF-8)       │
│                                                                │
│  Raw:  [ Show hex dump ]                                       │
│                                                                │
│  [ Copy base64 ]  [ Copy hex ]                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Integration with Existing Infrastructure

| Existing Capability | Reuse for Diagnostics | Phase |
|---------------------|----------------------|-------|
| `cencDecrypt.extractTenc()` | Parse tenc from init segment for metadata inspector | 1 ✓ |
| `cencDecrypt.extractScheme()` | Detect encryption scheme for metadata + compatibility checks | 1 ✓ |
| `cencDecrypt.findBoxData()` | PSSH box scanner reimplemented in `psshDecode.ts` with container descent into moov/moof/traf (findBoxData only descends into moof/traf) | 1 ✓ |
| `ShakaPlayer.tsx` manifest fetch | Raw MPD text available as `manifestText` — passed to `parseManifestDrm()` | 1 ✓ |
| `ShakaPlayer.tsx` `findBox()` | New top-level ISOBMFF box scan helper to detect init segments (moov/ftyp presence) | 1 ✓ |
| Shaka `registerResponseFilter` | Captures init segment bytes for PSSH/tenc extraction | 1 ✓ |
| `ContextMenu` gating pattern | `moduleConfig.drmDiagnostics && onToggleDrmDiagnostics && (...)` | 1 ✓ |
| `StatsPanel` UI pattern | Dark overlay, close button, monospace font, absolute positioning | 1 ✓ |
| `softwareDecrypt.hasClearKeySupport()` | ClearKey EME detection for compatibility checker | 4 |
| `softwareDecrypt.waitForDecryption()` | Silent failure detection (SF-003) | 4 |
| `drmClient.fetchLicense()` | Wrap for license exchange capture (rnd-player's own server) | 3 |
| `sessionManager` | Session lifecycle events for EME timeline | 2 |
| `player.drmInfo()` | Active DRM system info (keySystem in Shaka event data) | 2 ✓ |
| `player.getKeyStatuses()` | Per-key status for failure detection | 4 |
| `player.getExpiration()` | License expiration for timeline + metadata | 2 |
| `player.getStats().drmTimeSeconds` | DRM initialization timing | 2 |
| `player.getStats().licenseTime` | License exchange timing | 3 |
| `player.addEventListener("drmsessionupdate")` | Shaka DRM session update (covers PlayReady) | 2 ✓ |
| `player.addEventListener("keystatuschanged")` | Shaka key status change (covers PlayReady) | 2 ✓ |
| `player.addEventListener("expirationupdated")` | Shaka license expiration update | 2 ✓ |

### Module Config Integration

**Implemented (Phase 1).** `drmDiagnostics: boolean` added as field 14 to `PlayerModuleConfig` in `src/types/moduleConfig.ts`:

```typescript
export interface PlayerModuleConfig {
  // ... existing 13 fields ...
  drmDiagnostics: boolean;
}

export const MODULE_DEFAULTS: PlayerModuleConfig = {
  // ... existing 13 fields ...
  drmDiagnostics: true,
};
```

In `autoConfig.ts`, no hard-gate or soft-gate — the panel is read-only diagnostics with negligible overhead until opened. All browsers have the necessary parsing APIs (DOMParser, DataView, mp4box.js).

### Component Hierarchy

```
ShakaPlayer
├── DrmDiagnosticsPanel (lazy, Suspense)          ← Phase 1 ✓
│   ├── CollapsibleSection per DRM system (grouped by systemName)
│   │   ├── ContentProtectionRow (manifest CP entries for this system)
│   │   └── PsshBoxView (manifest + init-segment PSSH boxes for this system)
│   │       ├── WidevinePsshView (decoded protobuf)
│   │       ├── PlayReadyPsshView (decoded XML)
│   │       └── hex dump toggle
│   ├── CollapsibleSection("HLS Keys") — if HLS manifest
│   │   └── HlsKeyRow (per EXT-X-KEY tag)
│   ├── CollapsibleSection("Track Encryption")
│   │   └── TrackEncryptionRow (per encrypted track)
│   ├── EmeTimelineSection                          ← Phase 2 ✓
│   │   └── EmeEventRow (per event, expandable)
│   ├── LicenseExchangeSection                     ← Phase 3 ✓
│   │   └── LicenseExchangeRow (per exchange, expandable)
│   │       └── DecodedLicenseView
│   ├── DiagnosticsSection                          ← Phase 4 ✓
│   └── CompatibilitySection                        ← Phase 4 ✓
├── VideoControls
│   └── ContextMenu  ("DRM diagnostics" item)     ← Phase 1 ✓
└── ...
```

### File Structure

```
src/
  components/
    DrmDiagnosticsPanel.tsx      — Main panel component (lazy-loaded, 9.01 kB chunk)  ✓
    icons.tsx                    — DrmDiagnosticsIcon added  ✓
    ContextMenu.tsx              — "DRM diagnostics" menu item  ✓
    VideoControls.tsx            — toggle state + click exclusion  ✓
    ShakaPlayer.tsx              — state management + data collection  ✓
    ShakaPlayer.css              — vp-drm-* styles  ✓
  drm/
    diagnostics/
      types.ts                   — DRM_SYSTEM_IDS, PsshBox, ManifestDrmInfo, InitSegmentDrmInfo, DrmDiagnosticsState, utility fns  ✓
      parseManifestDrm.ts        — Extract ContentProtection from DASH / EXT-X-KEY from HLS, deduplicates across AdaptationSets  ✓
      parseInitSegmentDrm.ts     — Extract tenc/scheme/PSSH from init segment via mp4box + cencDecrypt  ✓
      psshDecode.ts              — PSSH box parser: parsePsshBox, findAllPsshBoxes, decodePsshBase64  ✓
      psshWidevinePb.ts          — Widevine protobuf wire-format decoder, handles hex-string KIDs (~140 lines)  ✓
      psshPlayready.ts           — PlayReady Object Header + UTF-16LE XML decoder  ✓
      psshDecode.test.ts         — 12 tests  ✓
      psshWidevinePb.test.ts     — 11 tests  ✓
      parseManifestDrm.test.ts   — 13 tests  ✓
      emeCapture.ts              — EmeCapture class + EmeEvent/EmeEventCallback types  ✓
      emeCapture.test.ts         — 8 tests  ✓
      licenseCapture.ts          — LicenseCapture class + LicenseExchange types + masking/decode helpers  ✓
      licenseCapture.test.ts     — 14 tests  ✓
      silentFailures.ts          — Silent failure pattern detection  (Phase 4) ✓
      silentFailures.test.ts     — 18 tests  ✓
      compatChecker.ts           — Cross-DRM requestMediaKeySystemAccess probing  (Phase 4) ✓
      compatChecker.test.ts      — 6 tests  ✓
```

### Data Types (Phase 1 — Implemented)

```typescript
/** DRM system UUID → human-readable name mapping (5 systems). */
export const DRM_SYSTEM_IDS: Record<string, string> = {
  "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": "Widevine",
  "9a04f079-9840-4286-ab92-e65be0885f95": "PlayReady",
  "94ce86fb-07ff-4f43-adb8-93d2fa968ca2": "FairPlay",
  "1077efec-c0b2-4d02-ace3-3c1e52e2fb4b": "ClearKey (W3C)",
  "e2719d58-a985-b3c9-781a-b030af78d30e": "ClearKey (DASH-IF)",
};

/** Parsed PSSH box. */
interface PsshBox {
  systemId: string;          // UUID string (formatted by formatUuid)
  systemName: string;        // looked up from DRM_SYSTEM_IDS, "Unknown" fallback
  version: number;           // 0 or 1
  keyIds: string[];          // UUID strings (version 1 only, from box header)
  data: Uint8Array;          // raw system-specific data
  decoded?: WidevinePssh | PlayReadyPssh; // auto-decoded for known systems
  source: "manifest" | "init-segment";
}

/** Widevine-specific decoded PSSH data (protobuf wire-format). */
interface WidevinePssh {
  algorithm?: string;        // "UNENCRYPTED" | "AESCTR"
  keyIds: string[];          // 16-byte → UUID, 32-byte hex-ASCII → UUID, other → hex
  provider?: string;
  contentId?: string;        // hex
  contentIdUtf8?: string;    // UTF-8 attempt (only if printable ASCII)
  policy?: string;
  protectionScheme?: string; // FourCC from fixed32 field 9
}

/** PlayReady-specific decoded PSSH data (Object Header → UTF-16LE XML). */
interface PlayReadyPssh {
  kid?: string;              // UUID (LE byte order decoded)
  laUrl?: string;            // from <LA_URL>
  luiUrl?: string;           // from <LUI_URL>
  customAttributes?: string; // raw XML from <CUSTOMATTRIBUTES>
}

/** A single ContentProtection element from a DASH MPD. */
interface ContentProtectionInfo {
  schemeIdUri: string;       // e.g. "urn:uuid:edef8ba9-..."
  systemName: string;        // mapped from DRM_SYSTEM_IDS or "CENC (mp4protection)"
  defaultKid?: string;       // hex, dashes stripped
  psshBase64?: string;       // raw base64 from <cenc:pssh>
  robustness?: string;       // Widevine robustness level
  licenseUrl?: string;       // from <ms:laurl>
}

/** HLS key tag info (EXT-X-KEY / EXT-X-SESSION-KEY). */
interface HlsKeyInfo {
  method: string;            // METHOD= value
  uri?: string;              // URI= value
  keyformat?: string;        // KEYFORMAT= value
  keyformatVersions?: string;
  iv?: string;               // IV= value
}

/** All DRM info extracted from a manifest. */
interface ManifestDrmInfo {
  type: "dash" | "hls" | "unknown";  // auto-detected from content
  contentProtections: ContentProtectionInfo[];
  hlsKeys: HlsKeyInfo[];
}

/** Encryption info for a single track in an init segment. */
interface TrackEncryptionInfo {
  trackId: number;
  scheme: string | null;     // from sinf.schm via extractScheme()
  defaultKid: string;        // hex from tenc.defaultKID
  defaultIvSize: number;     // 8 or 16
  defaultConstantIv: string | null; // hex, cbcs only
}

/** All DRM info extracted from an init segment. */
interface InitSegmentDrmInfo {
  tracks: TrackEncryptionInfo[];
  psshBoxes: PsshBox[];      // found via findAllPsshBoxes() scan
}

/** Combined diagnostics state. */
interface DrmDiagnosticsState {
  manifest: ManifestDrmInfo | null;
  manifestPsshBoxes?: PsshBox[];  // decoded from <cenc:pssh> elements
  initSegment: InitSegmentDrmInfo | null;
  emeEvents?: readonly EmeEvent[];  // Phase 2
  licenseExchanges?: readonly LicenseExchange[];  // Phase 3
}
```

### Data Types (Phase 2 — Implemented)

```typescript
/** EME event type union. */
type EmeEventType =
  | "access-request" | "access-granted" | "access-denied"
  | "keys-created" | "keys-set" | "generate-request"
  | "message" | "update" | "key-status-change"
  | "close" | "expiration-change" | "error";

/** Single captured EME event for the timeline. */
interface EmeEvent {
  id: number;
  timestamp: number;        // performance.now()
  type: EmeEventType;
  detail: string;
  data?: unknown;           // expandable raw data (click row)
  duration?: number;        // ms since previous event
  success?: boolean;        // drives color coding
}

/** Callback type used by proxy modules. */
type EmeEventCallback = (
  type: EmeEventType,
  detail: string,
  opts?: { data?: unknown; success?: boolean },
) => void;
```

`EmeCapture` class (`src/drm/diagnostics/emeCapture.ts`):
- `record(type, detail, opts?)` — push event with auto-incrementing id, `performance.now()` timestamp, duration from previous event
- `getEvents(): readonly EmeEvent[]` — returns accumulated events (same array reference until next `record()`)
- `clear()` — reset for new stream (IDs restart, no duration carry-over)
- `toJSON(): string` — serializes events array for Copy JSON button

### Data Types (Phase 3 — Implemented)

```typescript
/** Captured license exchange. */
interface LicenseExchange {
  id: number;
  timestamp: number;        // performance.now() of request start
  drmSystem: "clearkey" | "widevine" | "fairplay";
  url: string;
  method: string;
  requestHeaders: Record<string, string>;  // masked at capture time
  requestBody: string;      // masked JSON string
  responseStatus?: number;
  responseBody?: string;    // masked JSON string
  durationMs?: number;
  error?: string;
  decoded?: DecodedLicense;
}

type DecodedLicense =
  | { type: "clearkey"; sessionId: string; keyCount: number; policy: LicensePolicy; hasTransportKey: boolean; hasWatermark: boolean }
  | { type: "widevine"; sessionId: string; licenseSizeBytes: number; policy: LicensePolicy; hasWatermark: boolean }
  | { type: "fairplay"; sessionId: string; ckcSizeBytes: number; policy: LicensePolicy; hasWatermark: boolean };

type LicenseExchangeCallback = (exchange: Omit<LicenseExchange, "id">) => void;
```

`LicenseCapture` class (`src/drm/diagnostics/licenseCapture.ts`):
- `record(exchange)` — push with auto-incrementing id
- `getExchanges(): readonly LicenseExchange[]` — returns accumulated exchanges
- `clear()` — reset for new stream
- `toJSON(): string` — serializes exchanges array for Copy JSON button

Masking helpers (pure functions, mask at capture time — panel never sees raw secrets):
- `maskHeaders()` — `Authorization: Bearer ****...{last4}`, pass through others
- `maskClearKeyRequest/Response()`, `maskWidevineRequest/Response()`, `maskFairPlayRequest/Response()` — mask session_token, device_fingerprint, client_public_key, challenge/spc, key values, license/ckc base64, transport_key_params.epk

Decode helpers (extract structured views from our server's response formats):
- `decodeClearKeyResponse()` — session, key count, policy, transport key presence, watermark presence
- `decodeWidevineResponse()` — session, license size bytes, policy, watermark presence
- `decodeFairPlayResponse()` — session, CKC size bytes, policy, watermark presence

### Data Types (Future Phases)

```typescript
/** Cross-DRM compatibility probe result. (Phase 4) */
interface CompatResult {
  keySystem: string;
  label: string;
  supported: boolean;
  robustness?: string;
  config?: MediaKeySystemConfiguration;
  error?: string;
}
```

### Data Flow (Phase 1 + 2 + 3)

```
                 ┌──────────────────┐
                 │   ShakaPlayer    │
                 └────────┬─────────┘
                          │
        ┌─────────────────┼──────────────────┬─────────────────┐
        │                 │                  │                  │
  manifestText       init segment      EME lifecycle    license exchanges
  (fetchWithCorsRetry) (Shaka filter)  (callbacks +     (closure capture in
        │                 │             Shaka events)    proxy filters/fetch)
        ▼                 ▼                  │                  │
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │parseManifest │  │parseInitSeg  │  │  EmeCapture  │  │LicenseCapture│
  │Drm()         │  │Drm()         │  │  (useRef)    │  │  (useRef)    │
  │(DOMParser)   │  │(mp4box)      │  │  record()    │  │  record()    │
  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
         │                 │                  │                  │
         └────────┬────────┘        500ms sync interval ────────┘
                  │                 (when panel open)
                  ▼                          │
       ┌──────────────────────────┐          │
       │   DrmDiagnosticsState    │◀─────────┘
       │ { manifest,              │
       │   manifestPsshBoxes,     │
       │   initSegment,           │
       │   emeEvents,             │
       │   licenseExchanges }     │
       └────────────┬─────────────┘
                    │ props
                    ▼
       ┌──────────────────────────┐
       │  DrmDiagnosticsPanel     │
       │  (lazy-loaded)           │
       │  buildSystemGroups() +   │
       │  EmeTimelineSection +    │
       │  LicenseExchangeSection  │
       └──────────────────────────┘
```

**EME event sources:**
- ClearKey: `recordEmeEvent()` calls in `handleKeySubmit` (access probe, keys-set, load, SW fallback)
- Widevine: `onEmeEvent` callback passed to `configureWidevineProxy()` (keys-set, challenge, license response, parse error) + bookend events in ShakaPlayer
- FairPlay: `onEmeEvent` callback passed to `setupFairPlay()` (access probe, keys-set, needkey, SPC, CKC, key added/error) + bookend events in ShakaPlayer
- PlayReady / generic: Shaka `drmsessionupdate`, `keystatuschanged`, `expirationupdated` listeners on `player`

**License exchange capture sources:**
- ClearKey: `onLicenseExchange` callback passed to `fetchLicense()` — captures around existing `fetch()` call with timing, masks request/response bodies
- Widevine: `onLicenseExchange` callback in `configureWidevineProxy()` opts — closure variables (`licenseRequestStart`, `licenseRequestBody`) track timing across request/response filter pair
- FairPlay: `onLicenseExchange` callback in `setupFairPlay()` opts — captures around existing `fetch()` in `webkitkeymessage` handler

**Manifest parsing** runs synchronously in the `useEffect` after `fetchWithCorsRetry` returns, using the same `manifestText` already fetched for KID extraction.

**Init segment capture** uses a Shaka `registerResponseFilter` for `RequestType.SEGMENT` that detects init segments by scanning for `moov` or `ftyp` boxes via a lightweight `findBox()` helper (top-level ISOBMFF scan, ~15 lines). Only the first init segment is parsed — subsequent ones are skipped via `prev.initSegment ? prev : { ...prev, initSegment: initInfo }`.

**Panel rendering** is gated on `moduleConfig.drmDiagnostics && showDrmDiagnostics` and lazy-loaded via `React.lazy()` + `<Suspense>`. The chunk is 9.01 kB (1.66 kB gzipped).

**Click isolation** — the panel's root `<div className="vp-drm-panel">` is excluded from the play/pause click handler in `VideoControls.tsx` via `target.closest(".vp-drm-panel")`, preventing clicks on Copy buttons or collapsible sections from toggling playback.

---

## Implementation Phases

### Phase 1: DRM Metadata Inspector + PSSH Decoder — IMPLEMENTED

**Goal:** Display encryption metadata from manifest and init segments with decoded PSSH boxes.

**Files created:**

| File | Purpose | Details |
|------|---------|---------|
| `src/types/moduleConfig.ts` | Config | Added `drmDiagnostics: boolean` (field 14, defaults `true`) |
| `src/drm/diagnostics/types.ts` | Types | `DRM_SYSTEM_IDS` (5 systems), `PsshBox`, `WidevinePssh`, `PlayReadyPssh`, `ContentProtectionInfo`, `HlsKeyInfo`, `ManifestDrmInfo`, `TrackEncryptionInfo`, `InitSegmentDrmInfo`, `DrmDiagnosticsState`, `formatUuid()`, `toHex()` |
| `src/drm/diagnostics/psshDecode.ts` | PSSH parser | `parsePsshBox()` — parses FullBox header + systemId + KIDs (v1) + data, auto-delegates to Widevine/PlayReady decoders. `findAllPsshBoxes()` — recursive ISOBMFF scan descending into moov/moof/traf containers. `decodePsshBase64()` — decodes base64 `<cenc:pssh>` values (strips 8-byte box header) |
| `src/drm/diagnostics/psshWidevinePb.ts` | Widevine decode | Wire-format protobuf decoder (~140 lines). Handles 4 wire types (varint, fixed64, length-delimited, fixed32). Decodes fields 1 (algorithm enum → "AESCTR"/"UNENCRYPTED"), 2 (key_id → UUID for 16-byte raw or 32-byte hex-ASCII, else hex), 3 (provider string), 4 (content_id → hex + UTF-8 attempt if printable ASCII), 6 (policy string), 9 (protection_scheme → FourCC via `fourccFromUint32`). Unknown fields skipped safely. Overflow protection at 35-bit shift |
| `src/drm/diagnostics/psshPlayready.ts` | PlayReady decode | Parses PlayReady Object Header (LE uint32 length + uint16 record count). Extracts Record Type 1 (Rights Management Header) as UTF-16LE XML via `decodeUtf16Le()`. Parses `<KID>` (base64 → LE GUID byte reorder → UUID), `<LA_URL>`, `<LUI_URL>`, `<CUSTOMATTRIBUTES>` |
| `src/drm/diagnostics/parseManifestDrm.ts` | Manifest parser | `parseManifestDrm()` auto-detects DASH (`<?xml`/`<MPD`) vs HLS (`#EXTM3U`). DASH: uses `getElementsByTagName("*")` + `localName === "ContentProtection"` filter (cross-environment reliable, handles XML namespaces). Reads `schemeIdUri`, `cenc:default_KID` (prefixed + `getAttributeNS` fallback), `robustness`, `<ms:laurl>`, `<cenc:pssh>`. Maps `urn:uuid:` URIs via `DRM_SYSTEM_IDS`. **Deduplicates** identical ContentProtection entries and PSSH boxes across AdaptationSets (fingerprint: `schemeIdUri\|defaultKid\|psshBase64\|robustness\|licenseUrl`). HLS: regex matches `#EXT-X-(?:SESSION-)?KEY:` tags, extracts METHOD/URI/KEYFORMAT/KEYFORMATVERSIONS/IV via `extractAttr()` (quoted + unquoted) |
| `src/drm/diagnostics/parseInitSegmentDrm.ts` | Init segment parser | Async (lazy-loads mp4box). Creates mp4box file, appends buffer with `fileStart=0`, flushes. Iterates `mp4.moov.traks[].tkhd.track_id`, calls `extractTenc()` / `extractScheme()` from `cencDecrypt.ts` per track. Also calls `findAllPsshBoxes()` on raw bytes. Returns null if no encrypted tracks and no PSSH boxes |
| `src/components/DrmDiagnosticsPanel.tsx` | Panel UI | `buildSystemGroups()` groups ContentProtection entries and PSSH boxes by `systemName` into per-system collapsible sections (e.g. "Widevine", "PlayReady", "CENC (mp4protection)"). Separate sections for HLS Keys and Track Encryption. `CopyButton` with "Copied" feedback (1.2s timeout). `WidevinePsshView` and `PlayReadyPsshView` render decoded fields. Hex dump toggle per PSSH box. Empty state: "No DRM detected in this content" |
| `src/components/icons.tsx` | Icon | `DrmDiagnosticsIcon` — SVG shield-like icon (rect + cross stroke) |
| `src/components/ContextMenu.tsx` | Menu item | `"DRM diagnostics"` / `"Hide DRM diagnostics"` toggle, gated on `moduleConfig.drmDiagnostics && onToggleDrmDiagnostics`, icon: `DrmDiagnosticsIcon` |
| `src/components/ShakaPlayer.tsx` | Integration | `findBox()` helper (top-level ISOBMFF scan). State: `showDrmDiagnostics`, `drmDiagnosticsState`. Manifest parsing in `useEffect` after `fetchWithCorsRetry` — stores both `manifest` info and `manifestPsshBoxes` from `parseManifestDrm()`. Init segment capture via `registerResponseFilter` for `RequestType.SEGMENT` — detects init by `findBox(bytes, "moov") \|\| findBox(bytes, "ftyp")`, parses first one only. Lazy `DrmDiagnosticsPanel` import. Props passed to VideoControls: `showDrmDiagnostics`, `onToggleDrmDiagnostics` |
| `src/components/VideoControls.tsx` | Click isolation | Added `.vp-drm-panel` to the `target.closest()` exclusion chain in the play/pause click handler, and `showDrmDiagnostics` / `onToggleDrmDiagnostics` props |
| `src/components/ShakaPlayer.css` | Styles | `vp-drm-panel` (absolute, top-right, z-index 3, `rgba(0,0,0,0.85)`, 11px monospace, width 480px, min-width 280px, max-width 90%, max-height 80%, `resize: both`). `vp-drm-close`, `vp-drm-section-header` (clickable collapse), `vp-drm-card` (left border), `vp-drm-row` (flex label+value), `vp-drm-copy` (inline copy button), `vp-drm-decoded` (system-specific view), `vp-drm-hex-toggle` / `vp-drm-hex` (hex dump), `vp-drm-empty` (italic placeholder) |
| `src/components/ShakaPlayer.test.tsx` | Test fix | Added `getNetworkingEngine` mock returning `{ registerRequestFilter, registerResponseFilter }` |

**Tests (44 total across Phase 1 + 2):**

| Test file | Tests | Coverage |
|-----------|-------|----------|
| `psshDecode.test.ts` | 12 | Widevine/PlayReady/ClearKey/unknown systemId parsing, version 0 vs 1, KID extraction, moov container scan, multi-box, base64 decode, invalid input |
| `psshWidevinePb.test.ts` | 11 | Each protobuf field type individually, hex-ASCII KID string decoding, combined fields, empty data, unknown field skipping |
| `parseManifestDrm.test.ts` | 13 | DASH with namespace declarations, multiple CPs, deduplication across AdaptationSets, different-KID preservation, HLS keys + session keys, robustness attr, empty/unknown manifests |
| `emeCapture.test.ts` | 8 | Incrementing IDs, inter-event duration, first event no duration, clear() reset, toJSON() validity, getEvents() accumulation, data/success fields, omission |

**Build output:** `DrmDiagnosticsPanel` code-split into `DrmDiagnosticsPanel-Bkvx0rcl.js` (9.01 kB / 1.66 kB gzipped).

**Implementation notes:**
- Manifest parsing uses `localName === "ContentProtection"` via `getElementsByTagName("*")` instead of `querySelectorAll("ContentProtection")` — the latter fails in environments where XML namespace prefixes create qualified element names
- The `cenc:default_KID` attribute is read via both `getAttribute("cenc:default_KID")` (browser) and `getAttributeNS("urn:mpeg:cenc:2013", "default_KID")` (namespace-aware fallback)
- **Deduplication**: DASH manifests repeat identical `ContentProtection` elements in every `AdaptationSet` (video, audio, etc.). `parseDashDrm()` deduplicates by fingerprinting `schemeIdUri|defaultKid|psshBase64|robustness|licenseUrl`. Entries with different KIDs (separate keys per track) are preserved
- **Hex-string KIDs**: Some Widevine packagers store KIDs as 32-char hex ASCII strings (32 bytes) instead of raw 16-byte binary in the protobuf `key_id` field. The decoder detects this pattern (`/^[0-9a-f]{32}$/i` on the decoded text) and formats as UUID
- **Per-system grouping**: `buildSystemGroups()` in the panel groups ContentProtection entries and PSSH boxes by `systemName`, so all Widevine data appears together, all PlayReady data together, etc. HLS keys and track encryption stay in their own sections
- **Manifest PSSH boxes**: `parseManifestDrm()` returns PSSH boxes decoded from `<cenc:pssh>` elements separately. Stored as `manifestPsshBoxes` in `DrmDiagnosticsState` and merged with init-segment PSSH boxes in the panel
- **Resizable panel**: CSS `resize: both` allows dragging the bottom-right corner. Initial width 480px, constraints: min 280px / max 90% width, min 100px / max 80% height
- Init segment response filter only captures the first init segment per session (`prev.initSegment ? prev : ...`) to avoid redundant parsing
- The `moduleConfig.drmDiagnostics` check in the `useEffect` is not added to the dependency array to avoid re-initializing the entire player on config change

### Phase 2: EME Event Timeline — IMPLEMENTED

**Goal:** Structured timeline of all EME lifecycle events with timing.

**Files created:**

| File | Purpose | Details |
|------|---------|---------|
| `src/drm/diagnostics/emeCapture.ts` | Event collector | `EmeCapture` class: `record()` with auto-id, `performance.now()` timestamp, inter-event duration. `getEvents()`, `clear()`, `toJSON()`. Exports `EmeEvent`, `EmeEventType`, `EmeEventCallback` types |
| `src/drm/diagnostics/emeCapture.test.ts` | Unit tests | 8 tests: incrementing IDs, inter-event duration, first event no duration, clear() reset, toJSON() validity, getEvents() accumulation, data/success fields, omission when not provided |

**Files modified:**

| File | Changes |
|------|---------|
| `src/drm/diagnostics/types.ts` | Added `emeEvents?: readonly EmeEvent[]` to `DrmDiagnosticsState` |
| `src/drm/widevineProxy.ts` | Added `onEmeEvent?: EmeEventCallback` to `ConfigureWidevineProxyOpts`. Records: `keys-set` (DRM configured), `message` (license challenge with byte count), `update` (license response with sessionId), `error` (JSON parse failure) |
| `src/drm/fairplayProxy.ts` | Added `onEmeEvent?: EmeEventCallback` to `SetupFairPlayOpts`. Records: `access-request`/`access-granted`/`access-denied` (EME probe), `keys-set` (WebKitMediaKeys), `generate-request` (webkitneedkey), `message` (SPC), `update` (CKC applied), `key-status-change` (key added), `error` (key error, license failure) |
| `src/components/ShakaPlayer.tsx` | `emeCaptureRef = useRef(new EmeCapture())` + stable `recordEmeEvent` callback. Clears on new `src`. ClearKey path: probe, granted/denied, keys-set, load, SW fallback. Passes `onEmeEvent` to Widevine/FairPlay proxies. Shaka native events: `drmsessionupdate`, `keystatuschanged`, `expirationupdated` (covers PlayReady). 500ms sync interval when panel open. `onClearEmeEvents` prop to panel |
| `src/components/DrmDiagnosticsPanel.tsx` | Added `onClearEmeEvents` prop. `EmeTimelineSection`: collapsible section with event count, Clear + Copy JSON buttons. `EmeEventRow`: timestamp, colored type badge, detail, `(+Nms)` latency, expandable JSON data on click. `formatRelativeTime()` helper. Color: green (success), red (error/failure), yellow (access-denied), neutral (default). Type labels: ACCESS?/ACCESS ✓/ACCESS ✗/KEYS/SET/INIT/MSG/UPDATE/STATUS/CLOSE/EXPIRY/ERROR |
| `src/components/ShakaPlayer.css` | 7 new rules: `.vp-drm-timeline` (max-height 300px, scrollable), `.vp-drm-timeline-actions` (flex row, right-aligned), `.vp-drm-event` (flex row, clickable), `.vp-drm-event-time` (monospace, 10px), `.vp-drm-event-type` (bold, color inline), `.vp-drm-event-detail` (flex 1), `.vp-drm-event-latency` (9px, gray), `.vp-drm-event-data` (indented pre block) |

**Design decisions:**
- **Callback injection, not monkey-patching.** No `navigator.requestMediaKeySystemAccess` interception — we control all DRM paths and inject `onEmeEvent` callbacks at existing call sites. For PlayReady and other Shaka-native key systems, Shaka's own `drmsessionupdate`/`keystatuschanged`/`expirationupdated` events provide coverage without any patching.
- **Ref-based accumulation.** Events fire rapidly during init. `useRef<EmeCapture>` avoids per-event re-renders. State sync to `drmDiagnosticsState.emeEvents` happens via 500ms `setInterval` only when the panel is open.
- **Timeline inside existing panel.** `EmeTimelineSection` is a `CollapsibleSection` at the bottom of `DrmDiagnosticsPanel`, not a separate component/panel. Only renders when `emeEvents.length > 0`.

**Tests:** 8 new tests in `emeCapture.test.ts`. Total: 1019 tests across 37 files.

**Build output:** `DrmDiagnosticsPanel` chunk grew from 9.01 kB to 10.54 kB (2.33 kB gzipped) — includes timeline sub-components.

**Independently shippable:** Yes. EME timeline is valuable on its own for debugging DRM initialization issues.

### Phase 3: License Exchange Inspector — IMPLEMENTED

**Goal:** Capture and display license server request/response details.

**Design decisions:**
- **Simple `LicenseCapture` class, same pattern as `EmeCapture`.** `record()`, `getExchanges()`, `clear()`, `toJSON()`. No two-phase begin/complete — Widevine's request/response filter correlation handled via closure variables inside `configureWidevineProxy`.
- **Capture inside existing code, not separate filters.** Widevine captures in existing request/response filters (closure tracks timing). FairPlay/ClearKey capture around their existing `fetch()` calls. No new Shaka filter registrations.
- **Mask at capture time.** Sensitive values (tokens, keys, fingerprints) masked before entering React state. Panel never sees raw secrets.
- **Store bodies as masked strings, not ArrayBuffer.** All license exchanges use JSON envelopes through the proxy server. Storing masked JSON string avoids conversion overhead and simplifies display.
- **Decoded views for our server's response formats only.** ClearKey (session, key count, policy, transport key). Widevine (session, license size, policy). FairPlay (session, CKC size, policy). Raw Widevine protobuf decoding deferred.

**Files changed:**

1. `src/drm/diagnostics/licenseCapture.ts` — NEW: `LicenseCapture` class + `LicenseExchange`/`DecodedLicense` types + masking helpers (`maskHeaders`, `maskClearKeyRequest/Response`, `maskWidevineRequest/Response`, `maskFairPlayRequest/Response`) + decode helpers (`decodeClearKeyResponse`, `decodeWidevineResponse`, `decodeFairPlayResponse`)
2. `src/drm/diagnostics/licenseCapture.test.ts` — NEW: 14 tests (masking, capture class, decode helpers)
3. `src/drm/diagnostics/types.ts` — added `licenseExchanges` to `DrmDiagnosticsState`
4. `src/drm/widevineProxy.ts` — added `onLicenseExchange` to opts, closure variables for timing, capture in request/response filters
5. `src/drm/fairplayProxy.ts` — added `onLicenseExchange` to opts, capture around fetch in `webkitkeymessage` handler
6. `src/drm/drmClient.ts` — added optional `onLicenseExchange` param to `fetchLicense()`, capture around fetch
7. `src/components/ShakaPlayer.tsx` — wired `LicenseCapture` ref, passes callback to all three DRM paths, syncs to state on 500ms interval, passes clear handler
8. `src/components/DrmDiagnosticsPanel.tsx` — added `LicenseExchangeSection`, `LicenseExchangeRow` (expandable: headers, masked bodies, decoded view), `DecodedLicenseView` sub-components; DRM system color coding (clearkey=green, widevine=blue, fairplay=purple); status badges
9. `src/components/ShakaPlayer.css` — `.vp-drm-license*` styles

**Tests:** 14 new tests in `licenseCapture.test.ts`. Total: 1033 tests across 38 files.

**Build output:** `DrmDiagnosticsPanel` chunk grew from 10.54 kB to 15.49 kB (3.05 kB gzipped) — includes license exchange sub-components + masking/decode imports.

**Independently shippable:** Yes. License exchange visibility is one of the most requested DRM debugging features.

### Phase 4: Silent Failure Detector + Compatibility Checker (IMPLEMENTED)

**Goal:** Proactive failure diagnosis and cross-DRM support matrix.

**Files:**

- `src/drm/diagnostics/silentFailures.ts` — 12 checks (SF-001 through SF-012) as pure functions, three runners (pre-load, post-load, on-error)
- `src/drm/diagnostics/silentFailures.test.ts` — 18 tests
- `src/drm/diagnostics/compatChecker.ts` — probes Widevine, PlayReady, FairPlay, ClearKey with robustness iteration, module-level cache
- `src/drm/diagnostics/compatChecker.test.ts` — 6 tests
- `src/drm/diagnostics/types.ts` — added `diagnostics` and `compatibility` fields to `DrmDiagnosticsState`
- `src/components/DrmDiagnosticsPanel.tsx` — DiagnosticsSection (severity-ranked issue list) and CompatibilitySection (DRM system table with probe button)
- `src/components/ShakaPlayer.tsx` — runs pre-load checks after manifest parse, post-load checks after `player.load()`, on-error checks in error handler; compatibility probe triggered from panel
- `src/components/ShakaPlayer.css` — `.vp-drm-diag-*` and `.vp-drm-compat-*` styles

**Independently shippable:** Yes. Failure detection can run independently and display results even without the other sections.

### Phase 5: Polish & Export (IMPLEMENTED)

**Goal:** Refinements and data export, consistent with Manifest Validator's export UX.

**Files:** `src/drm/diagnostics/reportExport.ts`, `src/components/DrmDiagnosticsPanel.tsx` (tabs + footer), `src/hooks/useKeyboardShortcuts.ts` (`D` key), `src/components/ContextMenu.tsx` (badge), `src/components/ShakaPlayer.css` (tab/footer/badge styles)

**Changes:**

1. **Report export (Copy + PDF)** — same pattern as Manifest Validator (`reportExport.ts`):
   - **Copy** button — `formatTextReport(state): string` produces a plain-text report (metadata, PSSH decoded fields, EME timeline, license exchanges, diagnostics). `copyReport()` writes to `navigator.clipboard.writeText()`. Button shows "Copied!" for 2s feedback.
   - **PDF** button — `openPrintReport(state): void` builds a styled HTML document via `buildHtmlReport()`, opens in a new window (`window.open`), triggers `window.print()` on load. Uses `@media print` to hide the "Use Ctrl+P / Cmd+P" footer hint. Color coding preserved (green/red/yellow for EME events, severity icons for diagnostics).
   - File: `src/drm/diagnostics/reportExport.ts` (~150 lines, mirrors `src/utils/manifestValidation/reportExport.ts` structure)
   - Both buttons in a `vp-drm-footer` bar at the bottom of the panel (matching `vp-mv-footer` layout)
   - The EME timeline's existing "Copy JSON" button remains for quick JSON-only export; the footer Copy produces the full combined report
2. **Tab navigation** — tabs for each section (Metadata | Timeline | License | Diagnostics | Compatibility) to avoid vertical scrolling in the panel
3. **Keyboard shortcut** — `D` key to toggle the panel (gated on `moduleConfig.keyboardShortcuts`)
4. **Auto-open on failure** — when a silent failure is detected, show a subtle badge on the context menu item (orange dot) to draw attention
5. **Live updates** — key status changes and session heartbeats update the panel in real-time (1s polling interval, same as StatsPanel)
6. **Init segment caching** — avoid re-fetching init segments that are already cached by Shaka's network engine

#### Report Format (Plain Text — clipboard)

```
DRM Diagnostics Report
========================================
URL: https://example.com/stream.mpd
Type: DASH
Date: 2026-03-11T12:34:56.789Z

── Encryption Metadata ──
  DRM Systems: Widevine, ClearKey
  Default KID: a1b2c3d4e5f60718...
  Scheme: cenc (AES-CTR)

  Track 1: cenc, KID a1b2c3d4e5f60718..., IV 8 bytes
  Track 2: cenc, KID a1b2c3d4e5f60718..., IV 8 bytes

  PSSH: Widevine v0 — 1 key, provider "example"
  PSSH: ClearKey v1 — 1 KID

── EME Events (7) ──
  00:00.000  ACCESS?  ClearKey EME probe
  00:00.012  ACCESS+  ClearKey EME supported           (+12ms)
  00:00.013  SET      ClearKey configured                (+1ms)
  00:00.156  UPDATE   Content loaded                   (+143ms)
  00:00.180  UPDATE   DRM session updated               (+24ms)
  00:00.181  STATUS   Key status changed                  (+1ms)
```

#### Report Format (HTML — print-to-PDF)

Same data as plain text but with:
- Styled header with URL, type, date
- Color-coded EME events (green/red/yellow badges)
- Per-system PSSH sections with decoded fields
- `@media print` rules for clean PDF output
- Footer: "Use Ctrl+P / Cmd+P to save as PDF" (hidden on print)

**Future phases:**
- CBCS scheme support in software decryption + diagnostics
- Multi-period DRM transitions (key rotation) visualization
- Widevine L1/L3 detection via `MediaKeySystemAccess.getConfiguration()` heuristics
- License renewal timeline (heartbeat history from `sessionManager`)
- DRM performance benchmarks (decode latency with/without encryption)

---

## UX Design

### Panel Layout

```
┌─ DRM Diagnostics ──────────────────────────────────── [×] ┐
│                                                            │
│  [Metadata] [Timeline] [License] [Diagnostics] [Compat]  │
│  ─────────────────────────────────────────────────────────│
│                                                            │
│  ● Encryption Metadata                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Manifest (DASH MPD)                                 │  │
│  │    DRM Systems:  Widevine, ClearKey                  │  │
│  │    Default KID:  a1b2c3d4-e5f6-0718-... (copy)      │  │
│  │    Scheme:       cenc (AES-CTR)                      │  │
│  │                                                      │  │
│  │  Init Segment                                        │  │
│  │    Track 1 (video):                                  │  │
│  │      Scheme:     cenc ✓ (matches manifest)           │  │
│  │      KID:        a1b2c3d4e5f60718... ✓               │  │
│  │      IV size:    8 bytes                             │  │
│  │    Track 2 (audio):                                  │  │
│  │      Scheme:     cenc ✓                              │  │
│  │      KID:        a1b2c3d4e5f60718... ✓               │  │
│  │      IV size:    8 bytes                             │  │
│  │                                                      │  │
│  │  PSSH Boxes (2)                                      │  │
│  │    ▸ Widevine — 1 key, provider: "example"           │  │
│  │    ▸ ClearKey — version 1, 1 KID                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ● Diagnostics (0 errors, 1 warning)                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ▲ SF-003  EME present but CDM fails silently        │  │
│  │           Software decryption fallback activated.     │  │
│  │           Detected via waitForDecryption() timeout.   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│                                         [ Copy ]  [ PDF ] │
└────────────────────────────────────────────────────────────┘
```

### Access Patterns (Implemented)

- **Context menu** — "DRM diagnostics" / "Hide DRM diagnostics" toggle item, gated on `moduleConfig.drmDiagnostics && onToggleDrmDiagnostics`. Always shown when module config is enabled (works for both encrypted and unencrypted content — the panel shows "No DRM detected" for unencrypted)
- **Click isolation** — panel root has `onClick={(e) => e.stopPropagation()}` AND is listed in VideoControls' play/pause click exclusion chain (`target.closest(".vp-drm-panel")`)
- **Keyboard shortcut** — `D` key toggles panel (gated on `moduleConfig.keyboardShortcuts`)
- **Auto-badge** — orange dot on context menu item when diagnostics detect issues (`drmDiagnosticCount` prop)

### Styling Conventions (Implemented)

All CSS in `ShakaPlayer.css`, classes prefixed with `vp-drm-`:

| Class | Style |
|-------|-------|
| `vp-drm-panel` | `position: absolute; top: 8px; right: 8px; z-index: 3; background: rgba(0,0,0,0.85); font: 11px/1.6 monospace; color: #e0e0e0; max-width: 480px; max-height: 60%; overflow-y: auto` |
| `vp-drm-close` | Absolute top-right `×` button, `#aaa` → `#fff` on hover |
| `vp-drm-section-header` | Clickable, `cursor: pointer`, bold, user-select none |
| `vp-drm-collapse-icon` | `▸` collapsed / `▾` expanded, 12px wide inline-block |
| `vp-drm-card` | `border-left: 2px solid rgba(255,255,255,0.15); padding-left: 8px` |
| `vp-drm-row` | `display: flex; gap: 8px` with `vp-drm-label` (70px min-width, `#999`) + `vp-drm-value` (`#e0e0e0`, word-break) |
| `vp-drm-copy` | Inline button, 9px font, 1px border, "Copied" feedback on click |
| `vp-drm-decoded` | Separator border-top, decoded system-specific view |
| `vp-drm-decoded-title` | `color: #4488ff; font-size: 10px; font-weight: bold` |
| `vp-drm-hex-toggle` | Underlined `#4488ff` link-style button |
| `vp-drm-hex` | `rgba(255,255,255,0.05)` background, 10px font, word-break |
| `vp-drm-empty` | `#888` italic placeholder |

Severity icons for future phases: `●` error (`#ff4444`), `▲` warning (`#ffaa00`), `○` info (`#4488ff`).

### Lazy Loading (Implemented)

Same pattern as `WatermarkOverlay` in `ShakaPlayer.tsx`:

```tsx
const DrmDiagnosticsPanel = lazy(() => import("./DrmDiagnosticsPanel"));

// In render (inside vp-video-area, before error overlay):
{moduleConfig.drmDiagnostics && showDrmDiagnostics && (
  <Suspense fallback={null}>
    <DrmDiagnosticsPanel
      state={drmDiagnosticsState}
      onClose={() => setShowDrmDiagnostics(false)}
    />
  </Suspense>
)}
```

**Note:** Unlike StatsPanel (which uses `createPortal` into `containerEl` from VideoControls), DrmDiagnosticsPanel renders directly in ShakaPlayer's `vp-video-area` div. This avoids threading toggle state through VideoControls — the toggle callback is passed as a simple prop instead.

---

## References

### Specifications

- [ISO 23001-7 (CENC)](https://www.iso.org/standard/68042.html) — Common Encryption in ISO Base Media File Format
- [W3C Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media/) — EME API specification
- [ISO 14496-12 (ISOBMFF)](https://www.iso.org/standard/83102.html) — ISO Base Media File Format (sinf, schm, tenc, senc boxes)
- [Widevine DRM Architecture](https://developers.google.com/widevine/drm/overview) — Key concepts, security levels
- [PlayReady Header Specification](https://learn.microsoft.com/en-us/playready/specifications/playready-header-specification) — PlayReady Object Header format
- [DASH-IF CPIX](https://dashif.org/guidelines/others/cpix/) — Content Protection Information Exchange Format
- [DASH-IF IOP §7](https://dashif.org/guidelines/iop-v5/) — Interoperability guidelines for Content Protection
- [HLS Authoring Spec §4.3.2.4](https://developer.apple.com/documentation/http-live-streaming/about-apple-s-http-live-streaming-tools) — EXT-X-KEY tag

### Prior Art

- [Shaka Player DRM configuration](https://shaka-player-demo.appspot.com/docs/api/tutorial-drm-config.html) — Shaka's DRM API surface
- [Bento4 mp4dump](https://www.bento4.com/documentation/mp4dump/) — ISOBMFF box inspection tool
- [mp4box.js](https://gpac.github.io/mp4box.js/) — JavaScript MP4 parser (used in this project)
- [EME Logger](https://nicedoc.io/nicedoc/nicedoc) — Chrome extension for EME event logging
- [Chrome Media Internals](chrome://media-internals) — Chrome's built-in media diagnostics
- [Widevine protobuf definition](https://github.com/nicedoc/nicedoc) — `WidevineCencHeader` message format (field numbers referenced in §6)
