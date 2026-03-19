# Manifest & Stream Validation — Feature Spec

A diagnostic suite that validates streaming manifests (DASH, HLS, Smooth Streaming) and their underlying segments against industry specifications, surfacing packaging errors, compatibility issues, and spec violations directly in the player UI. Turns rnd-player into a stream engineer's debugging tool.

## Objective

Implement a multi-protocol manifest validator that checks manifest structure, timeline continuity, codec signaling, ISO BMFF container compliance, and cross-platform compatibility. The validator runs client-side using Shaka Player's parsed manifest data combined with raw manifest/segment inspection, presenting results in a panel UI with severity-ranked issues.

---

## Relationship to Stream Diagnostics

The player has two complementary diagnostic features:

| | **Stream Diagnostics** (Phase 0, shipped) | **Manifest Validator** (this spec) |
|---|---|---|
| **Trigger** | Reactive — fires during playback on errors | Proactive — user-initiated scan, can run before play |
| **Scope** | Currently active tracks only | All tracks, all representations |
| **Data source** | Shaka error events, network responses, buffer state | Raw manifest text + fetched init/media segments |
| **What it catches** | "Segment 23 failed with HTTP 500", "DRM OPM failure over RDP" | "Track 5 seg0 has 10/27 senc/trun mismatches", "Duration mismatch across representations" |
| **Analogy** | Browser DevTools Network tab (observes live traffic) | `mediastreamvalidator` / DASH-IF Conformance (scans everything) |
| **Code** | `src/utils/streamDiagnostics.ts` | `src/utils/manifestValidation/*` |

Stream Diagnostics catches **symptoms** ("HTTP 500 on segment fetch"). The Manifest Validator catches **root causes** ("senc sub-sample bytes don't match trun sample sizes"). They complement each other — a stream engineer sees the playback error in Stream Diagnostics, then opens the Manifest Validator to find the structural issue causing it.

---

## Motivating Example — ISM CBCS Clear Endpoint Bug

A real-world packaging bug that the Manifest Validator would catch at three diagnostic layers:

**Bug**: An ISM origin server's AES body filter truncates the first segment of HD/FHD tracks (720p, 900p, 1080p) mid-mdat. The mezzanine is structurally correct, but the transcoder's CBCS sub-sample generator produces `senc` entries whose byte totals are 2–5 bytes short of actual `trun` sample sizes for specific samples in seg0. The AES filter (which processes even `/clr/` clear content) treats the mismatch as fatal and returns HTTP 500 after headers are sent, causing DPR to truncate the response.

**What the user sees**: SD plays fine, HD/FHD won't load. Player stutters at ABR switch points.

**What Stream Diagnostics (Phase 0) reports**: "HTTP 500 on segment fetch" — the symptom.

**What the Manifest Validator would report at each layer:**

| Layer | Check | Fetching cost | Finding |
|---|---|---|---|
| 1. Manifest-level | TL-005 duration mismatch | Zero (Shaka's parsed data) | "Video tracks 5–7: 404.241s vs tracks 3–4: 406.361s — 2.12s difference" |
| 2. Init segment | BMFF-011 encryption metadata on clear content | One fetch per track | "`tenc.isProtected=1`, KID=`86ac5e...` but content served unencrypted" |
| 3. Media segment deep scan | BMFF-S01 senc/trun mismatch | N segment fetches | "Track 5 seg0: 10/27 samples have senc sub-sample totals 2–5 bytes short of trun sizes" |

This layered approach — instant manifest checks first, deeper segment scans on demand — drives the staged implementation plan below.

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
| DASH-007 | Empty `<SegmentTimeline>` (0 `<S>` entries) with Representations present — player hangs | Error | — |

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
| DASH-112 | Mixed frame rates in video AdaptationSet (causes A/V desync on ABR switch) | Error | DASH-IF IOP §3.2.4 |
| DASH-113 | Some but not all Representations have `@frameRate` | Warning | DASH-IF IOP |

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
| BMFF-011 | `tenc.isProtected=1` but content served unencrypted (clear endpoint) | Warning | Encryption metadata present without actual encryption — may trigger AES filter bugs on ISM origins |

#### 4.2 Media Segment Deep Scan (on-demand)

These checks require fetching actual media segments and are gated behind a "Deep Scan" action.

| Rule ID | Check | Severity | Notes |
|---|---|---|---|
| BMFF-S01 | `senc` sub-sample byte totals match `trun` sample sizes | Error | Sum of `(clear_bytes + cipher_bytes)` per sample must equal `trun` sample size. Mismatch causes AES filter truncation on ISM origins. |
| BMFF-S02 | `Content-Length` matches received bytes | Error | Truncated response detection — headers sent before body error |
| BMFF-S03 | `moof` sequence numbers are monotonically increasing | Warning | Gaps indicate missing or misordered fragments |
| BMFF-S04 | `tfdt` base media decode time matches expected timeline position | Warning | Cross-reference with manifest segment timeline |
| BMFF-S05 | Video tracks have consistent frame rates (`sample_duration` in `tfhd`/`trun`) | Error | Compares `timescale / sample_duration` across all video tracks (0.5 fps tolerance). Container-level complement to DASH-112 — catches mixed frame rates even when `@frameRate` is missing from the MPD. |

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
- **Lazy loading**: `React.lazy()` import in `ShakaPlayer.tsx`, same pattern as all other optional panels. Validator code (types, orchestrator, individual validators) is only loaded when the user opens the panel.

### Component hierarchy

```
VideoControls.tsx
  └─ ManifestValidator.tsx          — Panel UI (portaled into containerEl, like StatsPanel)
       ├─ Summary bar               — Error/warning/info counts + Re-scan button
       ├─ Category sections          — Collapsible, auto-expand on errors
       │    └─ Issue rows            — Severity icon, rule ID, message, expandable detail
       └─ Footer                    — Timing + manifest type
```

### File structure

```
src/
  components/
    ManifestValidator.tsx              — Panel UI component (lazy loaded in VideoControls)
    icons.tsx                          — ManifestValidatorIcon added
    ContextMenu.tsx                    — "Validate manifest" menu item
    VideoControls.tsx                  — Portal rendering, click-area exclusion
    ShakaPlayer.css                    — .vp-mv-* panel styles
  utils/
    manifestValidation/
      types.ts                         — ValidationIssue, ValidationResult, Severity enums
      runValidation.ts                 — Orchestrator: progressive (timeline → BMFF+codec → deep scan)
      timelineValidator.ts             — Gap/overlap/duration checks (pure + Shaka helper)
      timelineValidator.test.ts        — 17 unit tests (incl. ISM pattern scenario)
      bmffValidator.ts                 — ISO BMFF init segment validation + Shaka helper
      bmffValidator.test.ts            — 16 unit tests (mocked mp4box + cencDecrypt)
      codecValidator.ts                — Codec string vs init segment sample entry
      codecValidator.test.ts           — 16 unit tests (mocked mp4box)
      segmentScanner.ts                — Media segment deep scan (senc/trun, truncation, seq, tfdt)
      segmentScanner.test.ts           — 20 unit tests (synthetic BMFF segments)
      reportExport.ts                  — Text + HTML report generation (clipboard copy, print-to-PDF)
      dashValidator.ts                 — [Stage 4] MPD XML structure + DASH-IF IOP checks
      dashValidator.test.ts            — 52 unit tests
      hlsValidator.ts                  — [Stage 4] HLS m3u8 line-based parser + RFC 8216 checks
      hlsValidator.test.ts             — 54 unit tests
      compatValidator.ts               — [Stage 4] Cross-platform compatibility warnings (not yet implemented)
  types/
    moduleConfig.ts                    — manifestValidator field added
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
    └─ User opens ManifestValidator panel (via context menu)
         │
         runValidation(player, onProgress, rawManifestText) orchestrator
         │
         ├─ Stage 1 (instant, no fetching):
         │   extractTimelinesFromShaka(player)
         │   └─ validateTimelines(timelines) → TL-001..TL-006
         │
         ├─ Stage 1b (instant, no fetching — manifest text checks):
         │   ├─ [DASH] parseMpd(rawManifestText)
         │   │   └─ validateDash(mpd) → DASH-001..DASH-007, DASH-102..DASH-106, DASH-112, DASH-113
         │   └─ [HLS] parseHlsPlaylist(rawManifestText)
         │       └─ validateHls(playlist) → HLS-001..HLS-008, HLS-101..HLS-109, HLS-201..HLS-208
         │   └─ onProgress(timelineIssues + dashIssues + hlsIssues) → panel shows results immediately
         │
         ├─ Stage 2 (fetches init segments + child playlists, parallel):
         │   extractStreamsFromShaka(player) → stream info + init URLs
         │   ├─ validateBmff(streams, fetch) → BMFF-001..BMFF-011
         │   │   └─ mp4box parse → ftyp/moov/mvex/tenc/schm checks
         │   ├─ validateCodecs(streams, fetch) → CS-001, CS-003, CS-007
         │   │   └─ mp4box parse → stsd sample entry comparison
         │   └─ [HLS] fetchAndValidateHlsChildren(playlist, baseUrl, fetch) → HLS-003..HLS-208, HLS-206
         │       └─ fetch child m3u8 → parse → validate each + cross-rendition discontinuity check
         │
         ├─ [Stage 3] segmentScanner — media segment deep scan (on-demand)
         └─ [Stage 4] compatValidator — cross-platform warnings (not yet implemented)
         │
         ▼
    ValidationResult → ManifestValidator.tsx renders final issues
```

### Validation execution

- **On-demand** — validation runs when the user opens the panel, not automatically on every load. Avoids unnecessary network requests and computation.
- **Progressive** — Stage 1 (timeline) results appear instantly via `onProgress` callback. Stage 2 (BMFF/codec) results appear when init segment fetches complete. Panel shows "Scanning..." indicator during Stage 2.
- **Parallel** — BMFF and codec validators run concurrently via `Promise.all`. Init segment fetches are deduplicated by URL.
- **Fault-tolerant** — each validator is wrapped in `.catch()`. One validator failing (e.g. CORS on init segment fetch) doesn't block others.
- **Non-blocking** — all validation logic runs on the main thread (it's fast enough — text parsing and object iteration). Init segment fetching uses `await fetch()`.

---

## Implementation Stages

### Stage 0 — Stream Error Diagnostics (DONE)

**Goal**: Replace cryptic Shaka error messages with structured, actionable diagnostics for network/segment errors. First foundation piece of the analytics engine.

**Motivation**: A buggy ISM origin server returned HTTP 404 for segments past the first 2-3 (cross-track TFRA time mismatches in `SegmentTimeline`), but the player showed only "Failed to load video (HTTP 500). Check the stream URL." — no indication that the manifest loaded fine and the problem was at the segment level.

**Implemented:**

1. **`src/utils/streamDiagnostics.ts`** — Pure diagnostic functions
   - `StreamError` type: `{ summary, details[], url?, httpStatus? }`
   - `diagnoseNetworkError(shakaError, context)` — Analyzes Shaka error code 1001 (BAD_HTTP_STATUS), 1002 (HTTP_ERROR), 1003 (TIMEOUT) with request type awareness (manifest vs segment vs license)
   - `simpleError(message)` — Wraps plain strings for non-network errors (DRM, decode, CORS)
   - Context-aware: accepts `segmentSuccessCount` (how many segments loaded before failure) and `manifestUrl`
   - Pattern detection: ISM URL patterns (`.ism`, `/Q()/F()`) trigger specific guidance about cross-track TFRA time mismatches
   - URL shortening for display: `host/.../{last 3 path segments}`

2. **`ShakaPlayer.tsx` integration**
   - Error state changed from `string` to `StreamError`
   - Segment success counter via Shaka networking engine response filter
   - All error paths updated: network errors use `diagnoseNetworkError()`, others use `simpleError()`
   - Error overlay renders structured output: red summary headline + detail lines + monospaced URLs

3. **`ShakaPlayer.css` error overlay styles**
   - `.vp-error-summary` — red, bold headline
   - `.vp-error-details` — smaller detail lines with dimmer color
   - `.vp-error-url` — monospaced, word-break for long URLs

4. **Unit tests** — 16 tests in `src/utils/streamDiagnostics.test.ts` covering manifest/segment errors, ISM patterns, timeouts, URL shortening, edge cases

5. **PlayReady OPM/RDP detection** — `diagnoseDrmPlaybackError(shakaError)`
   - Detects PlayReady Output Protection Management (OPM) failures that occur over Windows Remote Desktop (RDP)
   - **Problem**: PlayReady CDM requires OPM to query the display driver's HDCP status. Over RDP, the virtual display driver doesn't support OPM → Windows Media Foundation blocks decryption → Shaka surfaces as cryptic error 3014 (MEDIA, category 3) or 6008 (DRM, category 6)
   - **Detection**: matches Shaka codes 3014+cat3 / 6008, or error data containing `output protection`, `OPM`, `0xC0262500`
   - **What the user sees**: instead of "Media decode error: the video could not be played", the player explains the real issue — the display doesn't support output protection — and advises testing on a real display or using ClearKey DRM
   - The DRM license exchange succeeds (key status = "usable"); decryption is blocked at the Windows MF renderer level. This affects ALL PlayReady content on the machine, including Microsoft's own test streams
   - 8 unit tests covering all detection patterns
   - See `../free-drm/docs/playready-cdm-debugging.md` issue #21 for full investigation

### Stage 1 — Foundation + Manifest-Level Checks (DONE)

**Goal**: Ship the validator panel UI, the orchestrator, and the first set of checks that require zero additional fetching. Instant results from Shaka's already-parsed manifest.

**Implemented:**

1. **`manifestValidator` added to `PlayerModuleConfig`**
   - Added to `src/types/moduleConfig.ts` (interface + `MODULE_DEFAULTS`)
   - No capability gates needed (pure JS, no special APIs)
   - Disabled in `production` and `minimal` build presets (`vite.config.ts`)
   - Context menu item: "Validate manifest" / "Hide manifest validator"

2. **Lazy loading** — `React.lazy()` import of `ManifestValidator.tsx` in `VideoControls.tsx` (not ShakaPlayer — the panel is portaled into `containerEl` to avoid click-to-play interference). All validation code tree-shakes away when `manifestValidator` is disabled. Separate chunk: 13.8KB (4.8KB gzipped).

3. **`src/utils/manifestValidation/types.ts`** — `Severity`, `ValidationIssue`, `ValidationResult`, `ValidationCategory`

4. **`src/utils/manifestValidation/runValidation.ts`** — Orchestrator
   - Accepts Shaka player instance
   - Progressive: `onProgress` callback reports Stage 1 (timeline) results immediately while Stage 2 (BMFF/codec) fetches init segments in the background
   - Runs BMFF and codec validators in parallel via `Promise.all`
   - Catches per-validator failures gracefully (one validator crashing doesn't block others)

5. **`src/utils/manifestValidation/timelineValidator.ts`** — Pure validation logic + Shaka integration helper
   - `validateTimelines(timelines)` — pure function, easy to unit test with synthetic data
   - `extractTimelinesFromShaka(player)` — extracts `StreamTimeline[]` from Shaka manifest (deduplicates streams by ID, calls `createSegmentIndex()`)
   - TL-001: Gap detection (>1ms between consecutive segments)
   - TL-002: Overlap detection (<-1ms between consecutive segments)
   - TL-003: Duration variance (>50% from mean, excludes last segment which is often partial)
   - TL-005: Duration mismatch across video representations (error >2s, warning 0.5–2s). Groups representations by duration for readable messages.
   - TL-005: Audio/video duration mismatch (warning >2s)
   - TL-006: Audio/video segment boundary alignment — only checks when segment durations are within 10% of each other. Different segment grids (e.g. 3s video / 2s audio in ISM/DASH) are expected and not flagged.

6. **`src/components/ManifestValidator.tsx`** — Panel UI
   - Portaled into `containerEl` via `createPortal` (same as StatsPanel) — prevents click-to-play interference
   - Added `.vp-mv-panel` to the click-area exclusion list in `VideoControls.tsx`
   - Summary bar with error/warning/info counts + Re-scan button
   - Collapsible categories, auto-expanded based on severity (errors first, then warnings)
   - Expandable issue rows with detail text and spec references
   - Shows timing and manifest type in footer

7. **`ManifestValidatorIcon`** added to `src/components/icons.tsx`

8. **17 unit tests** in `timelineValidator.test.ts` — gaps, overlaps, duration variance, representation mismatch, audio/video mismatch, boundary alignment, edge cases, ISM pattern multi-track scenario (5 video reps in 2 duration groups + 2 audio tracks)

### Stage 2 — Init Segment BMFF + Codec Validation (DONE)

**Goal**: Cross-reference manifest codec declarations against actual init segment content. One fetch per unique init segment (typically one per track).

**Implemented:**

1. **`src/utils/manifestValidation/bmffValidator.ts`**
   - `extractStreamsFromShaka(player)` — extracts stream info + init segment URLs from Shaka manifest (type, codecs, encrypted flag, DRM scheme)
   - `validateBmff(streams, fetchFn)` — fetches init segments, parses with mp4box.js
   - Deduplicates fetches: streams sharing an init segment URL are fetched once
   - Deduplicates BMFF-007 brand issues: tracks with the same uncommon brands produce one grouped message
   - BMFF-001: `ftyp` present and first box
   - BMFF-002: `moov` present
   - BMFF-003: `mvex` present (required for fMP4/MSE)
   - BMFF-007: Recognized brands in `ftyp` — known list includes `isom`/`iso2`–`iso9`, `avc1`/`hvc1`/`hev1`/`av01`/`vp09`, `mp41`/`mp42`/`mp71`, `dash`/`msdh`/`msix`, `cmfc`/`cmfl`/`cmff`, `piff` (Microsoft PIFF/Smooth Streaming), `M4V`/`M4A`
   - BMFF-008: `tenc` has IV size or constant IV when `isProtected=1`
   - BMFF-009: Encryption scheme is `cenc`/`cbcs`/`cens`/`cbc1`
   - BMFF-011: `tenc.isProtected=1` with non-zero KID but Shaka reports stream as unencrypted (the ISM clear-endpoint pattern)
   - Reuses `extractTenc()` and `extractScheme()` from `src/workers/cencDecrypt.ts`

2. **`src/utils/manifestValidation/codecValidator.ts`**
   - `validateCodecs(streams, fetchFn)` — cross-references manifest codec strings with `stsd` sample entries
   - Handles `encv`/`enca` encrypted wrappers: reads original format from `sinf.frma.data_format`
   - Codec equivalence tables: `avc1`≈`avc3`, `hvc1`≈`hev1`, `ac-3`≈`ac_3`, `ec-3`≈`ec_3`
   - CS-001: `hev1` in HLS (Apple requires `hvc1` — Safari rejects `hev1`)
   - CS-003: Codec string in manifest doesn't match init segment sample entry type
   - CS-007: Encrypted sample entry (`encv`/`enca`) missing `sinf` box

3. **16 unit tests** in `bmffValidator.test.ts` — mocked mp4box + cencDecrypt, covers BMFF-001/002/003/007/009/011/ERR, ISM encryption-on-clear pattern, piff brand acceptance, fetch deduplication, brand issue deduplication

4. **16 unit tests** in `codecValidator.test.ts` — mocked mp4box, covers CS-001/003/007, codec equivalence pairs (avc1/avc3, hvc1/hev1), encrypted encv/enca wrappers with sinf.frma resolution, HLS-specific checks, audio codecs, fetch deduplication

5. **Test data**: All tests use synthetic data modeled on the ISM origin bug pattern (duration groups, encryption metadata on clear content, different audio/video segment grids). No production URLs or media segments.

6. **Progressive panel UI** — Timeline results appear immediately on panel open. "Scanning..." indicator shows while BMFF/codec checks fetch init segments. Final results replace the partial view.

### Stage 3 — Media Segment Deep Scan (DONE)

**Goal**: Fetch actual media segments and validate internal consistency. This is what directly catches the ISM senc/trun bug. Gated behind a "Deep Scan" button — not auto-run, since fetching is expensive.

**Implemented:**

1. **`src/utils/manifestValidation/segmentScanner.ts`**
   - `scanSegments(tracks, fetchFn, options, onProgress)` — pure validation, no Shaka dependency
   - `extractScanTracksFromShaka(player, initFetchFn, maxSegs)` — Shaka integration helper, gets segment URLs + IV sizes from init segment tenc
   - Internal parsers: `parseTrun` (sample sizes from trun flags), `parseTfhdDefaultSize`, `parseMfhd` (sequence numbers), `parseTfdt` (v0/v1 base decode time)
   - Reuses `findBoxData`, `parseSencFromSegment`, `extractTenc` from `cencDecrypt.ts`
   - Configurable `maxSegmentsPerTrack` (default: 1 — seg0 is the most common failure point per the ISM bug)
   - **BMFF-S01**: `senc` sub-sample byte totals ≠ `trun` sample sizes (the exact ISM bug). Reports count, affected sample indices, and byte shortfall range.
   - **BMFF-S02**: `Content-Length` header vs received bytes mismatch (truncation detection). Also reports fetch failures.
   - **BMFF-S03**: `moof` sequence numbers monotonically increasing within a track
   - **BMFF-S04**: `tfdt` base media decode time matches expected timeline position (0.1s tolerance)
   - **BMFF-S05**: Cross-track video frame rate mismatch. Reads `default_sample_duration` from `tfhd` (flag 0x08) or falls back to first trun sample duration, converts to fps via `timescale / sample_duration`, and compares across all video tracks (0.5 fps tolerance). Container-level complement to DASH-112 — catches mixed frame rates even when `@frameRate` is absent from the MPD.

2. **`src/utils/manifestValidation/runValidation.ts`** — Added `runDeepScan(player, onProgress, options)` export. Uses browser `fetch()` to get both `ArrayBuffer` and `Content-Length` header.

3. **`src/components/ManifestValidator.tsx`** — "Deep Scan Segments" button in panel (blue accent, below issues). Progress indicator: "Scanning video 1280x720 seg 0... (3/9 tracks)". Results merge into existing issue list with auto-expand on Container category.

4. **32 unit tests** in `segmentScanner.test.ts` — synthetic BMFF segments built from binary helpers (`makeMoof`, `makeTrun`, `makeSenc`, etc.). Tests include:
   - Individual parser tests (trun, mfhd, tfdt v0/v1, tfhd default size, tfhd default duration)
   - BMFF-S01: pattern 10/27 mismatch, matching samples, 8-byte IV CENC, no-senc skip
   - BMFF-S02: truncation detection, Content-Length match, fetch failure
   - BMFF-S03: non-monotonic sequence numbers
   - BMFF-S04: tfdt mismatch, tfdt within tolerance
   - BMFF-S05: mixed fps across video tracks, same fps no error, audio excluded, trun fallback
   - Full ISM origin scenario: SD track clean + HD track with senc/trun mismatch
   - Mixed frame rate regression for BMFF-S05: 14-track (7×25fps + 7×50fps) scenario mirroring mixed frame rate A/V desync with ISM timescale/duration values, verifying fps group detection, track labels, audio exclusion, and no false positive when only one fps group is present
   - Progress callback, maxSegmentsPerTrack option

5. **No production URLs or media segments** — all test data is synthetic, modeled on the ISM origin bug pattern.

**Future enhancements:**
- "[View segment details →]" expandable table showing per-sample senc vs trun comparison
- Web Worker for scanning many segments (current main-thread async/await is fine for small N)

### Stage 4 — DASH/HLS Manifest Text Validation (DASH + HLS implemented)

**Goal**: Parse raw manifest text for spec compliance. These are pure text/XML checks that complement the structural checks from earlier stages.

**DASH validator (implemented):**

1. **`dashValidator.ts`** — pure validation module (no Shaka dependency)
   - `parseMpd(xml)` — DOMParser-based extraction using `localName` matching (works with XML namespace-qualified elements)
   - `normalizeFrameRate(fr)` — handles `"25"`, `"25/1"`, `"30000/1001"` formats
   - `validateDash(mpd)` — 13 rules implemented:
     - MPD-level: DASH-001 through DASH-005 (namespace, profiles, minBufferTime, type, availabilityStartTime)
     - **DASH-007**: Empty SegmentTimeline detection — catches manifests where `<SegmentTimeline>` exists but has zero `<S>` entries, causing infinite player hang (real-world empty-timeline regression)
     - Hierarchy: DASH-102 through DASH-106 (mimeType, codecs, id, bandwidth, width/height)
     - **DASH-112**: Mixed frame rates in video AdaptationSet — error severity, catches the A/V desync bug (real-world mixed-fps regression)
     - **DASH-113**: Partial `@frameRate` coverage within AdaptationSet
   - Runs in Stage 1b (instant, no fetching) — raw MPD text passed via `ShakaPlayer → VideoControls → ManifestValidator → runValidation()`
   - **Player guard**: `ShakaPlayer.tsx` also checks the active variant's video segment index post-load — if empty, shows error immediately instead of hanging

2. **52 unit tests** in `dashValidator.test.ts` — includes Mixed frame rate regression tests:
   - Mixed frame rate manifest (14 representations, 7x 25fps + 7x 50fps) — real-world mixed-fps regression
   - Empty video SegmentTimeline (9 representations, 0 segments) with populated audio — real-world empty-timeline regression

**Files:** `dashValidator.ts` (parser + validator), `dashValidator.test.ts` (52 tests), `runValidation.ts` (Stage 1b orchestration), `ShakaPlayer.tsx` / `VideoControls.tsx` / `ManifestValidator.tsx` (raw manifest text plumbing)

**Not yet implemented (DASH):** DASH-101, DASH-107 through DASH-110, DASH-201 through DASH-205, DASH-301 through DASH-305

**HLS validator (implemented):**

3. **`hlsValidator.ts`** — pure validation module (no Shaka dependency)
   - `parseHlsPlaylist(text)` — line-based m3u8 parser with state-machine attribute-list parsing (handles commas inside quoted strings, e.g. `CODECS="avc1.4d401f,mp4a.40.2"`)
   - Detects multivariant vs media playlist, BOM, control characters, duplicate attributes, EXT-X-VERSION consistency
   - `validateHls(playlist)` — Phase 1 checks (instant, no fetching):
     - Playlist-level: HLS-001 through HLS-008 (EXTM3U, VERSION, mixed playlist type, BOM, duplicate attrs)
     - Multivariant: HLS-101 through HLS-109 (BANDWIDTH, CODECS, RESOLUTION, FRAME-RATE, MEDIA tag validation, dangling group refs, I-frame playlists, cellular variant)
     - Media playlist: HLS-003, HLS-006, HLS-007, HLS-201, HLS-205, HLS-207, HLS-208 (TARGETDURATION, tag ordering, segment duration, byte-range, live playlist depth, fMP4 EXT-X-MAP)
   - `validateHlsMediaPlaylist(media)` — validates fetched child playlists with source label prefix
   - `fetchAndValidateHlsChildren(playlist, baseUrl, fetchFn)` — Phase 2: fetches child media playlists, validates each, and runs cross-rendition checks:
     - **HLS-206**: Discontinuity count mismatch across renditions
   - Skipped rules (require segment byte fetching): HLS-202, HLS-203, HLS-204
   - Runs in Stage 1b (multivariant text checks) + Stage 2 (child playlist fetching in `Promise.all` alongside BMFF/codec)

4. **54 unit tests** in `hlsValidator.test.ts`:
   - Parser tests: attribute parsing, RESOLUTION, quoted commas, BOM, multivariant/media detection, I-frame stream infs, duplicate attributes, FRAME-RATE, EXT-X-VERSION
   - Structural checks: HLS-001 through HLS-008
   - Multivariant checks: HLS-101 through HLS-109
   - Media playlist checks: HLS-003, HLS-006, HLS-007, HLS-201, HLS-205, HLS-207, HLS-208
   - Cross-rendition checks: HLS-206 discontinuity count mismatch (match, mismatch, fetch failure)
   - QA regression scenarios: realistic multivariant with duration-mismatched variants, child playlist with segment exceeding TARGETDURATION

**Files:** `hlsValidator.ts` (parser + validator), `hlsValidator.test.ts` (54 tests), `runValidation.ts` (Stage 1b + Stage 2 orchestration)

**Compatibility validator (not yet implemented):**

5. **Implement `compatValidator.ts`**
   - Pure logic based on manifest type + codec strings + encryption scheme
   - No fetching required
   - Checks: COMPAT-001 through COMPAT-007

### Stage 5 — Export & Polish (DONE)

**Goal**: Report export and UX refinements.

**Implemented:**

1. **Copy report** — formatted plain-text report to clipboard (for pasting into JIRA description)
2. **Print-to-PDF** — styled HTML report opens in new tab with auto-print trigger (replaces JSON export — PDF is more practical for JIRA attachments). Zero dependencies, uses browser's built-in print-to-PDF.
3. **Severity filter** — click error/warning/info counts in summary bar to toggle visibility. Dimmed counts = filtered out. At least one severity stays active.
4. **Issue count badge** — red badge on "Validate manifest" context menu item showing error count. Appears after panel has been opened at least once, persists when panel is closed.
5. **Re-scan preserves state** — re-scan re-merges deep scan issues, preserves user's expanded/collapsed categories
6. **Dismissable error overlay** — error overlay has × button so it doesn't block the validator panel

**Files:** `reportExport.ts` (text + HTML generation), `ManifestValidator.tsx` (filter, export, onErrorCount), `ContextMenu.tsx` (badge), `VideoControls.tsx` (error count state)

### Future stages (out of scope for initial implementation)

- **GOP structure validation** — reuse `classifyFrameTypes()` from thumbnail worker to check keyframe interval consistency across representations
- **Smooth Streaming** — ISM/ISML manifest validation (XML-based, similar approach to DASH)
- **SCTE-35 cue validation** — check ad insertion markers in HLS/DASH
- **Live stream monitoring** — periodic re-validation as manifest updates (for dynamic DASH / live HLS)
- **Bitstream-level checks** — H.264 SPS/PPS parsing to verify profile/level matches codec string (requires NAL unit parsing beyond what mp4box provides)

---

## UX Design

### Panel layout

Modeled after the StatsPanel pattern but with an issue-list format. The panel has two operational modes:

1. **Manifest scan** (instant) — runs on panel open, validates manifest structure and timeline from Shaka's parsed data + init segment BMFF checks
2. **Deep scan** (on demand) — user clicks "Deep Scan" to fetch and validate media segments

```
┌───────────────────────────────────────────────────────┐
│  Manifest Validator                          [×] close │
│───────────────────────────────────────────────────────│
│  ● 2 errors  ▲ 3 warnings  ○ 1 info       [Re-scan]  │
│───────────────────────────────────────────────────────│
│  ▼ Timeline (1 error, 1 warning)                      │
│    ● TL-005   Track duration mismatch                 │
│               Video tracks 5,6,7 (720p–1080p):        │
│               404.241s vs tracks 3,4 (486p–576p):     │
│               406.361s — 2.12s difference.            │
│               Audio: 406.399s                         │
│    ▲ TL-003   Duration variance 28%                   │
│               Segment 15 duration is 3.2s vs          │
│               mean of 2.0s (60% above mean).          │
│                                                       │
│  ▼ Container (1 error, 1 warning)                     │
│    ● BMFF-S01 senc/trun size mismatch                 │
│               Track 5 seg0: 10/27 samples have        │
│               senc sub-sample totals 2–5 bytes        │
│               short of trun sample sizes.             │
│               Track 6 seg0: 17/27 mismatches          │
│               Track 7 seg0: 5/27 mismatches           │
│               [View segment details →]                │
│    ▲ BMFF-011 Encryption metadata on clear content    │
│               tenc.isProtected=1, KID=86ac5e...       │
│               but content is served unencrypted.      │
│                                                       │
│  ▼ Manifest Structure (0 errors, 1 warning)           │
│    ▲ DASH-110 Implicit timescale=1                    │
│               AdaptationSet[0] does not set            │
│               @timescale explicitly.                   │
│               Spec: DASH-IF IOP                       │
│                                                       │
│  ▶ Codec & Tags (✓ no issues)                         │
│  ▶ Compatibility (1 info)                             │
│───────────────────────────────────────────────────────│
│  [Deep Scan]  [Export JSON]  [Copy Report]            │
│  Scanning track 5 seg 0... (3/9 tracks)        ██░░░  │
└───────────────────────────────────────────────────────┘
```

### Deep scan detail view

When user clicks "[View segment details →]" on a BMFF-S01 issue, an expandable section shows the per-sample comparison:

```
│    ● BMFF-S01 senc/trun size mismatch — Track 5 seg0  │
│    ┌──────┬───────────┬────────────┬──────┐           │
│    │ Sam# │ trun size │ senc total │ diff │           │
│    ├──────┼───────────┼────────────┼──────┤           │
│    │   17 │    22,984 │     22,980 │   +4 │           │
│    │   18 │     3,405 │      3,400 │   +5 │           │
│    │   19 │     4,656 │      4,652 │   +4 │           │
│    │  ... │       ... │        ... │  ... │           │
│    └──────┴───────────┴────────────┴──────┘           │
```

### Access

- **Context menu** → "Validate Manifest" item (gated on `moduleConfig.manifestValidator`)
- **Keyboard shortcut** (if keyboard shortcuts enabled) — candidate: `V`
- Panel appears as overlay, same positioning approach as StatsPanel
- On first open: manifest-level + init segment checks run automatically
- Deep scan: only on explicit user action (button click)

### Styling

- CSS classes prefixed with `vp-` per project convention
- Dark theme consistent with existing overlays
- Severity icons: `●` error (red), `▲` warning (yellow/amber), `○` info (blue)
- Collapsible categories with issue count badges
- Expandable issue rows showing detail + spec reference
- Deep scan progress bar in panel footer
- Categories auto-expand if they contain errors, collapsed if clean

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
