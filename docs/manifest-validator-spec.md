# Manifest & Stream Validation — Feature Spec

A diagnostic suite that validates streaming manifests (DASH, HLS, Smooth Streaming) and their underlying segments against industry specifications, surfacing packaging errors, compatibility issues, and spec violations directly in the player UI. Turns rnd-player into a stream engineer's debugging tool.

## Objective

Implement a multi-protocol manifest validator that checks manifest structure, timeline continuity, codec signaling, ISO BMFF container compliance, and cross-platform compatibility. The validator runs client-side using Shaka Player's parsed manifest data combined with raw manifest/segment inspection, presenting results in a panel UI with severity-ranked issues.

---

## Industry Tooling Landscape

### What exists today

Stream engineers currently use a fragmented set of tools to debug packaging problems. No single tool covers manifest validation, container inspection, and playback diagnostics in one place.

**Standalone manifest validators:**

| Tool | Protocols | UX | Strengths | Limitations |
|---|---|---|---|---|
| Apple `mediastreamvalidator` + `hlsreport` | HLS only | CLI (macOS only) → JSON → HTML report | Definitive HLS reference validator; checks segment timing, bitrate accuracy, codec tags | macOS only, CLI only, no DASH/Smooth, no web UI |
| DASH-IF Conformance Tool | DASH, CMAF, DVB, HbbTV | Web UI + CLI + Docker self-host | Multi-standard, open source, validates MPD + ISO BMFF timing (sidx, tfdt) | Slow on large manifests, no HLS, collects usage data on hosted instance |
| Unified Streaming Validator | CMAF, DVB-DASH | Web UI (color-coded pass/fail) | Pre-packaging validation, GOP alignment, fragment boundary checks | Commercial, tied to Unified ecosystem, file-based only |
| HLSAnalyzer.com | HLS, DASH | Web UI (freemium) | Dual protocol, SCTE-35 cue debugging | Advanced features require paid tier |
| Probe.dev | HLS | Cloud API + dashboard | 58% faster than local `mediastreamvalidator`, CI/CD integration | HLS only, cloud-dependent |

**Container inspection tools:**

| Tool | What it inspects | UX | Open source |
|---|---|---|---|
| Bento4 (mp4info, mp4dump) | Full BMFF box hierarchy, encryption, fragments | CLI, JSON output | Yes (GPLv2) |
| GPAC / MP4Box | BMFF boxes, muxing, encryption, DASH/HLS segmentation | CLI + MP4Box.js (browser) | Yes (LGPL) |
| ffprobe | Frame-level analysis (types, sizes, timestamps, GOP) | CLI with JSON/XML/CSV output | Yes (LGPL/GPL) |
| MediaInfo | Container metadata, codec properties, color space | GUI + CLI + library | Yes (BSD) |
| Thumbcoil (Brightcove) | TS/fMP4/FLV internals, H.264 NAL unit parsing | Web (drag-and-drop, runs in-browser) | Yes |

**Player-integrated diagnostics:**

| Tool | Focus | UX |
|---|---|---|
| Shaka Player demo | Error taxonomy, `probeSupport()`, debug logging | Web demo with URL hash state sharing |
| hls.js demo | BWE, buffer levels, ABR tuning, fMP4 data dump | Tabbed web UI with canvas-based metrics |
| dash.js reference player | Buffer/latency graphs, HTTP transaction logs | Web samples with debug panel |
| Bitmovin Stream Lab | Real-device QoE testing (180+ devices), AI root-cause analysis | Web dashboard + API, MCP Server for LLM-driven testing |
| Mux Data | QoE analytics (startup time, rebuffering, quality) | SDK integration + web dashboard |

**Professional/broadcast tools:**

| Tool | Focus |
|---|---|
| Telestream ARGUS | Live stream health monitoring, SCTE-35, "Live Look" visual inspection |
| Telestream Qualify | Automated file-based QC (MXF, DPP metadata, Dolby Vision) |
| Harmonic VOS + TAG | 500+ parameter real-time monitoring across ingest → CDN pipeline |
| AWS MediaTailor | SSAI quality, HLS Interstitials, manifest conditioning |

### Gap analysis — what's missing

No existing tool combines these three capabilities in one place:

1. **Manifest validation** against specs (Apple HLS Authoring Spec, DASH-IF IOP, RFC 8216)
2. **Container/segment inspection** (ISO BMFF box structure, sample entries, encryption boxes)
3. **Live playback context** (the stream is already loaded, parsed, and playing)

Apple's `mediastreamvalidator` is the gold standard for HLS but is macOS-only CLI with no DASH support. DASH-IF Conformance is the DASH equivalent but has no HLS support and runs separately from any player. Container tools like Bento4 and ffprobe are powerful but CLI-only and disconnected from the manifest layer.

**rnd-player's opportunity**: The player already fetches the manifest, parses it via Shaka, loads init segments via mp4box, and has full access to segment references and track metadata. A validator built into the player can cross-reference all three layers (manifest → init segment → media segments) with zero additional fetching for most checks.

### UX patterns from existing tools

| Pattern | Used by | Applicability |
|---|---|---|
| **Severity-ranked issue list** (error/warning/info) | Apple `mediastreamvalidator`, DASH-IF Conformance, ESLint | Primary results display |
| **Color-coded pass/fail table** | Unified Validator | Summary view for quick scan |
| **Tree view for box hierarchy** | Bento4 `mp4dump`, MP4Box.js viewer, Thumbcoil | ISO BMFF box inspection |
| **Tabbed panel with sections** | hls.js demo, dash.js reference | Organize checks by category |
| **Expandable detail rows** | Browser DevTools Network panel | Show raw data on demand |
| **Export to JSON/HTML report** | Apple `hlsreport`, Bento4 JSON output | Shareable results |
| **Inline spec references** | DASH-IF Conformance (links to spec sections) | Educational value |

---

## Validation Rules by Category

### Category 1 — Manifest Structure

Validate the internal structure and required attributes of the manifest itself.

#### 1.1 HLS (RFC 8216 / RFC 8216bis / Apple HLS Authoring Spec)

**Playlist-level checks:**

| Rule ID | Check | Severity | Spec reference |
|---|---|---|---|
| HLS-001 | `EXTM3U` is first line | Error | RFC 8216 §4.1 |
| HLS-002 | `EXT-X-VERSION` present and consistent | Warning | RFC 8216 §4.3.1.2 |
| HLS-003 | `EXT-X-TARGETDURATION` present in Media Playlist | Error | RFC 8216 §4.3.3.1 |
| HLS-004 | Playlist is either Multivariant or Media, never both | Error | RFC 8216 §2 |
| HLS-005 | UTF-8 encoding without BOM, no control characters | Warning | RFC 8216bis §4.1 |
| HLS-006 | `EXT-X-MEDIA-SEQUENCE` precedes first segment | Error | RFC 8216 §4.3.3.2 |
| HLS-007 | `EXT-X-DISCONTINUITY-SEQUENCE` before any segment or discontinuity tag | Error | RFC 8216 §4.3.3.3 |
| HLS-008 | No duplicate attribute names in attribute-lists | Error | RFC 8216 §4.2 |

**Multivariant playlist checks:**

| Rule ID | Check | Severity | Spec reference |
|---|---|---|---|
| HLS-101 | `EXT-X-STREAM-INF` has `BANDWIDTH` attribute | Error | RFC 8216 §4.3.4.2 |
| HLS-102 | `EXT-X-STREAM-INF` has `CODECS` attribute | Warning | RFC 8216 §4.3.4.2 (SHOULD) |
| HLS-103 | `EXT-X-STREAM-INF` has `RESOLUTION` for video | Warning | Apple Authoring Spec |
| HLS-104 | `EXT-X-STREAM-INF` has `FRAME-RATE` for video | Warning | Apple Authoring Spec |
| HLS-105 | `EXT-X-MEDIA` has `TYPE`, `GROUP-ID`, `NAME` | Error | RFC 8216 §4.3.4.1 |
| HLS-106 | `EXT-X-MEDIA` with `TYPE=CLOSED-CAPTIONS` has no `URI` | Error | RFC 8216 §4.3.4.1 |
| HLS-107 | All rendition groups referenced by `EXT-X-STREAM-INF` exist | Error | RFC 8216 §4.3.4.2 |
| HLS-108 | I-frame playlists provided for VOD | Info | Apple Authoring Spec |
| HLS-109 | Cellular-compatible variant present (BANDWIDTH <= 192 kbit/s) | Info | Apple Authoring Spec §1.25 |

**Segment-level checks:**

| Rule ID | Check | Severity | Spec reference |
|---|---|---|---|
| HLS-201 | `EXTINF` duration (rounded) <= `EXT-X-TARGETDURATION` | Error | RFC 8216 §4.3.3.1 |
| HLS-202 | Segment duration matches `EXTINF` within 20% | Warning | Apple `mediastreamvalidator` threshold |
| HLS-203 | Measured bitrate within 10% of `BANDWIDTH` | Warning | Apple Authoring Spec §1.26 |
| HLS-204 | Measured average bitrate within 10% of `AVERAGE-BANDWIDTH` | Warning | Apple Authoring Spec §1.26 |
| HLS-205 | Byte-range offset valid (previous segment exists if offset omitted) | Error | RFC 8216 §4.3.2.2 |
| HLS-206 | Discontinuity count matches across renditions | Error | RFC 8216 §6.2.2 |
| HLS-207 | Live playlist has >= 3 target durations of segments | Warning | RFC 8216 §6.2.2 |
| HLS-208 | `EXT-X-MAP` present for fMP4 segments | Error | RFC 8216 §4.3.2.5 |

#### 1.2 DASH (ISO 23009-1 / DASH-IF IOP)

**MPD-level checks:**

| Rule ID | Check | Severity | Spec reference |
|---|---|---|---|
| DASH-001 | `xmlns` namespace correct (`urn:mpeg:dash:schema:mpd:2011`) | Error | ISO 23009-1 |
| DASH-002 | `@profiles` attribute present | Error | ISO 23009-1 |
| DASH-003 | `@minBufferTime` attribute present | Error | ISO 23009-1 |
| DASH-004 | `@type` is "static" or "dynamic" | Error | ISO 23009-1 |
| DASH-005 | For dynamic MPD: `@availabilityStartTime` present | Error | DASH-IF IOP |

**Period/AdaptationSet/Representation hierarchy:**

| Rule ID | Check | Severity | Spec reference |
|---|---|---|---|
| DASH-101 | Period `@id` present for dynamic MPDs | Error | DASH-IF IOP |
| DASH-102 | `@mimeType` present at AdaptationSet or Representation level | Error | ISO 23009-1 |
| DASH-103 | `@codecs` present (at AdaptationSet or Representation level) | Warning | DASH-IF IOP (required for interop) |
| DASH-104 | Representation `@id` present and non-empty | Error | ISO 23009-1 |
| DASH-105 | Representation `@bandwidth` present | Error | ISO 23009-1 |
| DASH-106 | Video Representation has `@width`, `@height` | Warning | DASH-IF IOP |
| DASH-107 | Video AdaptationSet has `@par` (pixel aspect ratio) | Info | DASH-IF IOP |
| DASH-108 | Multiple video AdaptationSets: at least one has `Role` value `"main"` | Warning | DASH-IF IOP |
| DASH-109 | `@segmentAlignment="true"` for multi-Representation ABR | Warning | DASH-IF IOP |
| DASH-110 | `@timescale` explicitly set (default of 1 is almost certainly an error) | Warning | DASH-IF IOP |

**Segment addressing:**

| Rule ID | Check | Severity | Spec reference |
|---|---|---|---|
| DASH-201 | At most one of SegmentBase/SegmentTemplate/SegmentList per level | Error | ISO 23009-1 |
| DASH-202 | All Representations in AdaptationSet use same addressing mode | Error | DASH-IF IOP |
| DASH-203 | SegmentBase has `@indexRange` for on-demand profile | Error | DASH-IF IOP |
| DASH-204 | SegmentTemplate for live has `$Number$` or `$Time$` identifier | Error | DASH-IF IOP |
| DASH-205 | `SegmentList` at Period level (discouraged in DVB-DASH) | Info | DVB-DASH |

**ContentProtection:**

| Rule ID | Check | Severity | Spec reference |
|---|---|---|---|
| DASH-301 | MP4 protection scheme descriptor present (`urn:mpeg:dash:mp4protection:2011`) | Warning | DASH-IF CPIX |
| DASH-302 | `cenc:default_KID` matches KID in init segment PSSH | Error | DASH-IF Security Guidelines |
| DASH-303 | DRM-specific descriptors present with correct `@schemeIdUri` UUIDs | Info | DASH-IF Security Guidelines |
| DASH-304 | `@value` is `"cenc"` or `"cbcs"` (not empty or unknown) | Warning | DASH-IF Security Guidelines |
| DASH-305 | `dashif:laurl` present for license server URL | Info | DASH-IF IOP v5 |

### Category 2 — Timeline & Segment Analysis

Cross-reference segment timing data from Shaka's parsed manifest against actual segment content.

| Rule ID | Check | Severity | How |
|---|---|---|---|
| TL-001 | No timeline gaps between consecutive segments | Warning | Compare `ref[n].endTime` vs `ref[n+1].startTime` |
| TL-002 | No timeline overlaps between consecutive segments | Warning | Same comparison, opposite direction |
| TL-003 | Segment duration consistency (all segments within 20% of mean) | Info | Iterate segment index |
| TL-004 | Segment duration matches declared target duration (HLS) or `@duration` (DASH) | Warning | Compare actual vs declared |
| TL-005 | Total duration of segments matches manifest-declared duration | Warning | Sum vs `Duration` element or `EXT-X-ENDLIST` position |
| TL-006 | Audio/video segment boundaries align within tolerance | Warning | Compare segment indexes across streams |
| TL-007 | GOP alignment across representations (keyframe positions match) | Info | Sample `tfdt` + `trun` from multiple representations |
| TL-008 | Segment duration drift over time (cumulative error) | Info | Running sum of `EXTINF` vs container timestamps |

### Category 3 — Codec String & Tag Verification

Validate that codec signaling in the manifest matches the actual container content.

| Rule ID | Check | Severity | Notes |
|---|---|---|---|
| CS-001 | `hvc1` vs `hev1` — Apple requires `hvc1` for HLS HEVC | Error (HLS) | Apple Authoring Spec §1.10; Safari rejects `hev1` |
| CS-002 | `avc1` vs `avc3` — `avc1` preferred for broader compatibility | Info | Parameter sets in sample entry vs in-band |
| CS-003 | Codec string in manifest matches sample entry box type in init segment | Error | Parse `stsd` box via mp4box, compare with `stream.codecs` |
| CS-004 | AVC profile/level in codec string matches SPS | Warning | E.g., `avc1.64001F` = High @ 3.1; verify against actual SPS |
| CS-005 | H.264 fallback variant present alongside HEVC/AV1 | Info | Cross-platform compatibility |
| CS-006 | Audio codec matches declared codec (`mp4a.40.2` = AAC-LC, etc.) | Warning | Parse audio sample entry |
| CS-007 | For encrypted content: `encv`/`enca` sample entries have `sinf` box | Error | ISO 14496-12 |
| CS-008 | Encryption scheme in `sinf/schm` matches manifest ContentProtection `@value` | Error | `cenc` vs `cbcs` mismatch |
| CS-009 | HEVC in HLS must use fMP4 container (not MPEG-TS) | Error | Apple Authoring Spec §1.5 |

### Category 4 — ISO BMFF Container Compliance

Validate the structure of init segments and (optionally sampled) media segments.

| Rule ID | Check | Severity | Notes |
|---|---|---|---|
| BMFF-001 | `ftyp` box present and first box | Error | ISO 14496-12 |
| BMFF-002 | `moov` box present in init segment | Error | ISO 14496-12 |
| BMFF-003 | `mvex` box present in `moov` (required for fMP4) | Error | MSE requirement |
| BMFF-004 | Sample tables in init segment have `entry_count` = 0 | Warning | MSE requirement for fMP4 |
| BMFF-005 | `tfdt` box present in each `traf` | Error | MSE + DASH requirement |
| BMFF-006 | `trun` has `data-offset-present` flag set | Warning | Best practice |
| BMFF-007 | Brands in `ftyp` are recognized (`isom`, `iso6`, `dash`, `mp41`, `cmfc`) | Info | Unknown brands may indicate issues |
| BMFF-008 | For encrypted: `tenc` box present with valid `default_isProtected`, `default_Per_Sample_IV_Size`, `default_KID` | Error | CENC spec |
| BMFF-009 | For encrypted: `schm` box has scheme type `cenc` or `cbcs` | Error | CENC spec |
| BMFF-010 | `senc` box present in media segments when encrypted | Warning | CENC spec (samples need per-sample IV/subsample info) |

### Category 5 — Cross-Platform Compatibility

Not spec violations but practical compatibility warnings.

| Rule ID | Check | Severity | Notes |
|---|---|---|---|
| COMPAT-001 | HEVC content uses `hvc1` for iOS/Safari compatibility | Warning | `hev1` fails on Apple devices |
| COMPAT-002 | DRM: multiple DRM systems signaled (Widevine + FairPlay + PlayReady) | Info | Required for universal device coverage |
| COMPAT-003 | `cbcs` encryption scheme used (required by FairPlay, supported by Widevine/PlayReady) | Info | `cenc` only = no FairPlay = no iOS |
| COMPAT-004 | Audio codec is AAC-LC or HE-AAC (universal support) | Info | xHE-AAC, AC-3, E-AC-3 have limited support |
| COMPAT-005 | H.264 baseline variant available for legacy devices | Info | Some Smart TVs/STBs only support H.264 |
| COMPAT-006 | Maximum resolution does not exceed 4K (device support varies) | Info | Some devices cap at 1080p |
| COMPAT-007 | HLS served with correct MIME type (`application/vnd.apple.mpegurl`) | Warning | `text/plain` causes issues on some CDNs |

---

## Architecture

### Integration with existing infrastructure

The player already has most of the low-level primitives needed:

| Capability | Existing code | How it helps |
|---|---|---|
| Raw manifest XML/text | `ShakaPlayer.tsx` fetches manifest via `fetchWithCorsRetry()` | HLS/DASH raw text parsing |
| Parsed manifest model | `player.getManifest()` → variants, streams, segment references | Timeline analysis, codec extraction |
| Manifest type detection | `player.getManifestType()` → `"DASH"` / `"HLS"` | Route to correct validator |
| Segment index iteration | `stream.segmentIndex` with `getStartTime()`/`getEndTime()` | Gap/overlap/duration checks |
| Init segment fetching | `extractInitSegmentUrl()` in `useThumbnailGenerator.ts` | BMFF box inspection |
| MP4 box parsing | mp4box.js in `thumbnailWorker.ts` | `stsd`, `ftyp`, `moov`, `sinf`, `tenc`, `schm` parsing |
| CENC box parsing | `cencDecrypt.ts` — `extractTenc()`, `parseSencFromSegment()` | Encryption validation |
| Segment byte sizes | `useBitrateGraph.ts` response filter captures `response.data.byteLength` | Bitrate accuracy checks |
| Codec information | `stream.codecs` from Shaka manifest | Codec string extraction |
| CORS-safe fetching | `corsProxy.ts` + `installCorsSchemePlugin()` | Fetch raw manifest/segments from any origin |

### Module config integration

Add `manifestValidator: boolean` to `PlayerModuleConfig`:

```
PlayerModuleConfig {
  ...existing 9 fields...
  manifestValidator — ManifestValidator panel
}
```

- **Hard gate**: none (all checks use standard DOM/JS APIs + existing mp4box dependency)
- **Soft gate**: none (validation is lightweight, not GPU/memory intensive)
- **Build preset**: enabled in `full`, disabled in `production` and `minimal`
- **Default**: `true`

### Component hierarchy

```
ShakaPlayer.tsx
  └─ ManifestValidator.tsx          — Panel UI (similar to StatsPanel)
       ├─ ValidationSummary         — Pass/warn/error counts, expandable
       ├─ ValidationCategory        — Collapsible section per category
       │    └─ ValidationIssue      — Single issue row (severity icon, message, detail)
       └─ ValidationActions         — Re-run, export JSON, copy report
```

### File structure

```
src/
  components/
    ManifestValidator.tsx            — Panel UI component
    ManifestValidatorIssue.tsx       — Single issue row (reusable)
  utils/
    manifestValidation/
      types.ts                       — ValidationIssue, ValidationResult, Severity enums
      runValidation.ts               — Orchestrator: runs all validators, collects results
      hlsValidator.ts                — HLS playlist text parsing + RFC 8216 checks
      dashValidator.ts               — MPD XML structure + DASH-IF IOP checks
      timelineValidator.ts           — Gap/overlap/duration checks (protocol-agnostic)
      codecValidator.ts              — Codec string vs init segment sample entry
      bmffValidator.ts               — ISO BMFF box structure checks
      compatValidator.ts             — Cross-platform compatibility warnings
  types/
    (add to existing moduleConfig.ts)
```

### Data types

```typescript
type Severity = 'error' | 'warning' | 'info';

interface ValidationIssue {
  id: string;            // e.g., "HLS-001", "DASH-105", "TL-001"
  severity: Severity;
  category: string;      // "Manifest Structure", "Timeline", "Codec", "BMFF", "Compatibility"
  message: string;       // Human-readable summary
  detail?: string;       // Expanded explanation with spec reference
  specRef?: string;      // e.g., "RFC 8216 §4.3.3.1", "Apple Authoring Spec §1.10"
  location?: string;     // e.g., "Period[0] > AdaptationSet[1] > Representation[3]"
}

interface ValidationResult {
  manifestType: string;  // "DASH" | "HLS" | "Smooth"
  manifestUrl: string;
  timestamp: number;
  duration: number;      // ms taken to run validation
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
}
```

### Data flow

```
User loads manifest
    │
    ├─ Shaka parses manifest → player.getManifest()
    │                        → player.getManifestType()
    │
    ├─ Raw manifest text available from initial fetch
    │
    └─ User opens ManifestValidator panel (via context menu)
         │
         runValidation() orchestrator
         │
         ├─ hlsValidator(rawText)           — if HLS
         │   or dashValidator(rawXml)       — if DASH
         │
         ├─ timelineValidator(segmentIndex) — protocol-agnostic
         │
         ├─ codecValidator(streams, initSegment)
         │   └─ fetches init segment → mp4box parse → stsd comparison
         │
         ├─ bmffValidator(initSegment)
         │   └─ reuses fetched init segment from above
         │
         └─ compatValidator(streams, manifestType)
             └─ pure logic, no fetching
         │
         ▼
    ValidationResult → ManifestValidator.tsx renders issues
```

### Validation execution

- **On-demand** — validation runs when the user opens the panel, not automatically on every load. Avoids unnecessary network requests and computation.
- **Cached** — results are cached per manifest URL. Re-run button clears cache and re-validates.
- **Progressive** — manifest structure and timeline checks run immediately (use already-parsed data). Codec and BMFF checks that require fetching init segments show a loading state and populate asynchronously.
- **Non-blocking** — all validation logic runs on the main thread (it's fast enough — text parsing and object iteration). If init segment fetching is needed, use `await fetch()` without blocking the UI.

---

## Implementation Phases

### Phase 1 — Foundation + Timeline Analysis

**Goal**: Ship the validator panel UI, the orchestrator, and the first set of checks that require zero additional fetching.

**Tasks:**

1. **Add `manifestValidator` to `PlayerModuleConfig`**
   - Add field to `src/types/moduleConfig.ts`
   - Update `MODULE_DEFAULTS` (true)
   - Update `autoConfig.ts` preset mappings (enabled in `full` only)
   - Add context menu item in `ContextMenu.tsx`

2. **Implement `ValidationResult` types** in `src/utils/manifestValidation/types.ts`

3. **Implement `timelineValidator.ts`**
   - Input: Shaka's `segmentIndex` for each stream
   - Checks: TL-001 through TL-006 (gaps, overlaps, duration consistency, audio/video alignment)
   - This is the highest-value, lowest-effort check — the infrastructure already exists in `useBitrateGraph.ts`

4. **Implement `ManifestValidator.tsx` panel UI**
   - Similar to `StatsPanel.tsx` — overlay panel opened from context menu
   - Severity-ranked issue list with expandable detail rows
   - Summary bar: X errors, Y warnings, Z info
   - Color coding: red for errors, yellow for warnings, blue for info

5. **Implement `runValidation.ts` orchestrator**
   - Accepts Shaka player instance + raw manifest text
   - Routes to available validators, collects results
   - Returns `ValidationResult`

6. **Wire up in `ShakaPlayer.tsx`**
   - Pass raw manifest text (already fetched) to validator
   - Gate on `moduleConfig.manifestValidator`

7. **Unit tests** for `timelineValidator.ts` with synthetic segment index data

### Phase 2 — HLS Manifest Validation

**Goal**: Parse raw HLS playlist text and validate against RFC 8216 and Apple's Authoring Spec.

**Tasks:**

1. **Implement HLS text parser**
   - Line-based parser for m3u8 format
   - Extract tags, attributes, segment URIs, durations
   - Shaka parses HLS internally but does not expose the raw AST — we need our own lightweight parser
   - Not a full parser: only extract the fields needed for validation (tags, attribute-lists, EXTINF durations)

2. **Implement `hlsValidator.ts`**
   - Playlist-level checks: HLS-001 through HLS-008
   - Multivariant playlist checks: HLS-101 through HLS-109
   - Segment-level checks: HLS-201 through HLS-208
   - For bitrate accuracy checks (HLS-203, HLS-204): use measured bitrates from `useBitrateGraph.ts` if available

3. **Unit tests** with sample m3u8 playlists (valid and intentionally broken)

### Phase 3 — DASH Manifest Validation

**Goal**: Parse MPD XML and validate against ISO 23009-1 and DASH-IF IOP.

**Tasks:**

1. **Implement `dashValidator.ts`**
   - Input: raw MPD XML (already fetched as XML by `ShakaPlayer.tsx`)
   - Use `DOMParser` to parse XML (already done in `ShakaPlayer.tsx` for ClearKey detection)
   - MPD-level checks: DASH-001 through DASH-005
   - Hierarchy checks: DASH-101 through DASH-110
   - Segment addressing checks: DASH-201 through DASH-205
   - ContentProtection checks: DASH-301 through DASH-305

2. **Unit tests** with sample MPD documents

### Phase 4 — Codec & BMFF Validation

**Goal**: Cross-reference manifest codec declarations against actual init segment content.

**Tasks:**

1. **Implement `codecValidator.ts`**
   - Fetch init segment (reuse `extractInitSegmentUrl()` from thumbnail generator)
   - Parse with mp4box: extract `stsd` box → sample entry type (`avc1`/`hvc1`/`hev1`/`encv`)
   - Compare with `stream.codecs` from Shaka manifest
   - Checks: CS-001 through CS-009

2. **Implement `bmffValidator.ts`**
   - Parse init segment box tree via mp4box
   - Validate required boxes: `ftyp`, `moov`, `mvex`, sample table entry counts
   - For encrypted content: validate `sinf`/`schm`/`tenc` (reuse `extractTenc()` from `cencDecrypt.ts`)
   - Checks: BMFF-001 through BMFF-010

3. **Implement `compatValidator.ts`**
   - Pure logic based on manifest type + codec strings + encryption scheme
   - No fetching required
   - Checks: COMPAT-001 through COMPAT-007

4. **Unit tests** with real init segments (can reuse E2E test fixtures from `e2e/fixtures/`)

### Phase 5 — Export & Polish

**Goal**: Report export, persistent results, and UX refinements.

**Tasks:**

1. **JSON export** — download `ValidationResult` as `.json` file
2. **Copy report** — copy formatted text summary to clipboard
3. **Persistent results** — cache validation results in sessionStorage per manifest URL
4. **Re-validate button** — clear cache and re-run all checks
5. **Filter controls** — toggle visibility by severity (errors only / errors+warnings / all)
6. **Issue count badge** — show error count on context menu item (like notification badge)

### Future phases (out of scope for initial implementation)

- **Media segment sampling** — fetch N random media segments and validate `moof`/`mdat` structure, `trun` sample counts, `senc` presence for encrypted segments
- **GOP structure validation** — reuse `classifyFrameTypes()` from thumbnail worker to check keyframe interval consistency across representations
- **Smooth Streaming** — ISM/ISML manifest validation (XML-based, similar approach to DASH)
- **SCTE-35 cue validation** — check ad insertion markers in HLS/DASH
- **Live stream monitoring** — periodic re-validation as manifest updates (for dynamic DASH / live HLS)
- **Bitstream-level checks** — H.264 SPS/PPS parsing to verify profile/level matches codec string (requires NAL unit parsing beyond what mp4box provides)

---

## UX Design

### Panel layout

Modeled after the StatsPanel pattern but with an issue-list format:

```
┌─────────────────────────────────────────────────┐
│  Manifest Validator                    [×] close │
│─────────────────────────────────────────────────│
│  ● 2 errors  ▲ 5 warnings  ○ 3 info   [Re-run] │
│─────────────────────────────────────────────────│
│  ▼ Manifest Structure (1 error, 2 warnings)     │
│    ● HLS-003  Missing EXT-X-TARGETDURATION      │
│               Media Playlist at index 2 does     │
│               not contain the required tag.      │
│               Spec: RFC 8216 §4.3.3.1            │
│    ▲ HLS-102  Missing CODECS attribute           │
│               Variant stream #4 (1080p) does     │
│               not declare codecs. Players may    │
│               select incompatible renditions.    │
│    ▲ HLS-104  Missing FRAME-RATE attribute       │
│               ...                                │
│                                                  │
│  ▼ Timeline (1 error, 1 warning)                 │
│    ● TL-001   Gap at 45.032s (120ms)             │
│               Between segments 22 and 23.        │
│               Expected: 45.032s, got: 45.152s    │
│    ▲ TL-003   Duration variance 28%              │
│               Segment 15 duration is 3.2s vs     │
│               mean of 2.0s (60% above mean).     │
│                                                  │
│  ▶ Codec & Tags (0 errors, 2 warnings)           │
│  ▶ Container (0 issues)                          │
│  ▶ Compatibility (3 info)                        │
│─────────────────────────────────────────────────│
│  [Export JSON]  [Copy Report]                    │
└─────────────────────────────────────────────────┘
```

### Access

- **Context menu** → "Validate Manifest" item (gated on `moduleConfig.manifestValidator`)
- **Keyboard shortcut** (if keyboard shortcuts enabled) — candidate: `V`
- Panel appears as overlay, same positioning approach as StatsPanel

### Styling

- CSS classes prefixed with `vp-` per project convention
- Dark theme consistent with existing overlays
- Severity icons: `●` error (red), `▲` warning (yellow/amber), `○` info (blue)
- Collapsible categories with issue count badges
- Expandable issue rows showing detail + spec reference

---

## References

### Specifications

- [RFC 8216 — HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216)
- [RFC 8216bis — HLS 2nd Edition (draft-pantos-hls-rfc8216bis)](https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis)
- [Apple HLS Authoring Specification for Apple Devices](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)
- [ISO 23009-1 — DASH](https://www.iso.org/standard/83314.html)
- [DASH-IF Interoperability Points v5](https://dashif.org/guidelines/iop-v5/)
- [DASH-IF Content Protection & Security Guidelines](https://dashif-documents.azurewebsites.net/Guidelines-Security/master/Guidelines-Security.html)
- [ISO 14496-12 — ISO Base Media File Format](https://www.iso.org/standard/83102.html)
- [W3C ISO BMFF Byte Stream Format (MSE)](https://w3c.github.io/mse-byte-stream-format-isobmff/)

### Industry tools (prior art)

- [Apple HTTP Live Streaming Tools](https://developer.apple.com/documentation/http-live-streaming/using-apple-s-http-live-streaming-hls-tools)
- [DASH-IF Conformance Tool](https://conformance.dashif.org/) ([source](https://github.com/Dash-Industry-Forum/DASH-IF-Conformance))
- [Unified Streaming Validator](https://validator.unified-streaming.com/)
- [Bento4](https://www.bento4.com/) ([source](https://github.com/axiomatic-systems/Bento4))
- [GPAC / MP4Box](https://gpac.io/) ([MP4Box.js](https://github.com/gpac/mp4box.js))
- [Thumbcoil](https://github.com/videojs/thumbcoil) (Brightcove H.264 bitstream inspector)
- [HLSAnalyzer.com](https://hlsanalyzer.com/)
- [Bitmovin Stream Lab](https://bitmovin.com/stream-lab/)

### Relevant blog posts and technical resources

- [Fraunhofer — Common Pitfalls in MPEG-DASH Streaming](https://websites.fraunhofer.de/video-dev/common-pitfalls-in-mpeg-dash-streaming/)
- [Fraunhofer — Segment Alignment for ABR Streaming](https://websites.fraunhofer.de/video-dev/why-and-how-to-align-media-segments-for-abr-streaming/)
- [Bitmovin — hvc1 vs hev1 Differences](https://community.bitmovin.com/t/whats-the-difference-between-hvc1-and-hev1-hevc-codec-tags-for-fmp4/101)
- [debugvideo.com — Manifest Issues](https://www.debugvideo.com/manifest-issues)
- [video-dev Community — List of ISO BMFF/MP4 Tools](https://github.com/video-dev/community-knowledge-base/blob/master/list-of-iso-bmff-mp4-tools.md)
