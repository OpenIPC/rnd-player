import type { ValidationIssue } from "./types";

// --- Parsed HLS types ---

export interface HlsStreamInf {
  bandwidth?: number;
  codecs?: string;
  resolution?: { width: number; height: number };
  frameRate?: number;
  audio?: string;
  video?: string;
  subtitles?: string;
  closedCaptions?: string;
  uri: string;
  lineNumber: number;
}

export interface HlsMediaTag {
  type?: string;
  groupId?: string;
  name?: string;
  uri?: string;
  lineNumber: number;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  byteRange?: { length: number; offset?: number };
  discontinuity: boolean;
  mapUri?: string;
  lineNumber: number;
}

export interface ParsedHlsPlaylist {
  isMultivariant: boolean;
  version?: number;
  versionLines: number[];
  hasBom: boolean;
  hasExtm3u: boolean;
  hasControlChars: boolean;
  streamInfs: HlsStreamInf[];
  iFrameStreamInfs: HlsStreamInf[];
  mediaTags: HlsMediaTag[];
  duplicateAttrs: { tag: string; attr: string; lineNumber: number }[];
  // Media playlist fields
  targetDuration?: number;
  segments: HlsSegment[];
  endList: boolean;
  mediaSequenceLine?: number;
  firstSegmentLine?: number;
  discontinuitySequenceLine?: number;
  firstDiscontinuityOrSegmentLine?: number;
}

export interface ParsedHlsMediaPlaylist {
  playlist: ParsedHlsPlaylist;
  sourceUrl: string;
  label: string;
}

// --- Attribute parsing ---

/** Parse HLS attribute-list, handling commas inside quoted strings. */
export function parseAttributeList(input: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && input[i] === " ") i++;
    if (i >= len) break;

    // Read key
    const eqIdx = input.indexOf("=", i);
    if (eqIdx === -1) break;
    const key = input.substring(i, eqIdx).trim();
    i = eqIdx + 1;

    let value: string;
    if (i < len && input[i] === '"') {
      // Quoted string — find closing quote
      i++; // skip opening quote
      const closeIdx = input.indexOf('"', i);
      if (closeIdx === -1) {
        value = input.substring(i);
        i = len;
      } else {
        value = input.substring(i, closeIdx);
        i = closeIdx + 1;
      }
    } else {
      // Unquoted — read until comma or end
      const commaIdx = input.indexOf(",", i);
      if (commaIdx === -1) {
        value = input.substring(i).trim();
        i = len;
      } else {
        value = input.substring(i, commaIdx).trim();
        i = commaIdx;
      }
    }

    attrs.set(key, value);

    // Skip comma separator
    if (i < len && input[i] === ",") i++;
  }

  return attrs;
}

function parseResolution(val: string): { width: number; height: number } | undefined {
  const parts = val.split("x");
  if (parts.length !== 2) return undefined;
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);
  if (isNaN(width) || isNaN(height)) return undefined;
  return { width, height };
}

/** Check for duplicate attribute names in an attribute-list string. */
function findDuplicateAttrs(
  input: string,
  tag: string,
  lineNumber: number,
): { tag: string; attr: string; lineNumber: number }[] {
  const dupes: { tag: string; attr: string; lineNumber: number }[] = [];
  const seen = new Set<string>();
  let i = 0;
  const len = input.length;

  while (i < len) {
    while (i < len && input[i] === " ") i++;
    if (i >= len) break;

    const eqIdx = input.indexOf("=", i);
    if (eqIdx === -1) break;
    const key = input.substring(i, eqIdx).trim();
    i = eqIdx + 1;

    if (seen.has(key)) {
      dupes.push({ tag, attr: key, lineNumber });
    }
    seen.add(key);

    // Skip value
    if (i < len && input[i] === '"') {
      i++;
      const closeIdx = input.indexOf('"', i);
      i = closeIdx === -1 ? len : closeIdx + 1;
    } else {
      const commaIdx = input.indexOf(",", i);
      i = commaIdx === -1 ? len : commaIdx;
    }
    if (i < len && input[i] === ",") i++;
  }

  return dupes;
}

// --- Parser ---

export function parseHlsPlaylist(text: string): ParsedHlsPlaylist {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const cleaned = hasBom ? text.substring(1) : text;

  // Check for control characters (except \r, \n, \t)
  let hasControlChars = false;
  for (let i = 0; i < Math.min(cleaned.length, 10000); i++) {
    const code = cleaned.charCodeAt(i);
    if (code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) {
      hasControlChars = true;
      break;
    }
  }

  const lines = cleaned.split(/\r?\n/);
  const hasExtm3u = lines.length > 0 && lines[0].trim() === "#EXTM3U";

  const result: ParsedHlsPlaylist = {
    isMultivariant: false,
    hasBom,
    hasExtm3u,
    hasControlChars,
    versionLines: [],
    streamInfs: [],
    iFrameStreamInfs: [],
    mediaTags: [],
    duplicateAttrs: [],
    segments: [],
    endList: false,
  };

  let hasStreamInf = false;
  let hasSegment = false;
  let pendingStreamInf: Omit<HlsStreamInf, "uri"> | null = null;
  let pendingDiscontinuity = false;
  let currentMapUri: string | undefined;
  let lastByteRangeUri: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNumber = i + 1;

    if (line === "" || (line.startsWith("#") && !line.startsWith("#EXT"))) {
      continue;
    }

    // EXT-X-VERSION
    if (line.startsWith("#EXT-X-VERSION:")) {
      const version = parseInt(line.substring("#EXT-X-VERSION:".length).trim(), 10);
      if (!isNaN(version)) {
        result.version = result.version ?? version;
        result.versionLines.push(lineNumber);
      }
      continue;
    }

    // EXT-X-TARGETDURATION
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const td = parseInt(line.substring("#EXT-X-TARGETDURATION:".length).trim(), 10);
      if (!isNaN(td)) result.targetDuration = td;
      continue;
    }

    // EXT-X-ENDLIST
    if (line === "#EXT-X-ENDLIST") {
      result.endList = true;
      continue;
    }

    // EXT-X-MEDIA-SEQUENCE
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      result.mediaSequenceLine = lineNumber;
      continue;
    }

    // EXT-X-DISCONTINUITY-SEQUENCE
    if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) {
      result.discontinuitySequenceLine = lineNumber;
      continue;
    }

    // EXT-X-DISCONTINUITY
    if (line === "#EXT-X-DISCONTINUITY") {
      pendingDiscontinuity = true;
      if (result.firstDiscontinuityOrSegmentLine === undefined && result.firstSegmentLine === undefined) {
        result.firstDiscontinuityOrSegmentLine = lineNumber;
      }
      continue;
    }

    // EXT-X-MAP
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrStr = line.substring("#EXT-X-MAP:".length);
      const attrs = parseAttributeList(attrStr);
      currentMapUri = attrs.get("URI");
      continue;
    }

    // EXT-X-STREAM-INF
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      hasStreamInf = true;
      const attrStr = line.substring("#EXT-X-STREAM-INF:".length);
      result.duplicateAttrs.push(...findDuplicateAttrs(attrStr, "EXT-X-STREAM-INF", lineNumber));
      const attrs = parseAttributeList(attrStr);

      pendingStreamInf = {
        bandwidth: attrs.has("BANDWIDTH") ? parseInt(attrs.get("BANDWIDTH")!, 10) : undefined,
        codecs: attrs.get("CODECS"),
        resolution: attrs.has("RESOLUTION") ? parseResolution(attrs.get("RESOLUTION")!) : undefined,
        frameRate: attrs.has("FRAME-RATE") ? parseFloat(attrs.get("FRAME-RATE")!) : undefined,
        audio: attrs.get("AUDIO"),
        video: attrs.get("VIDEO"),
        subtitles: attrs.get("SUBTITLES"),
        closedCaptions: attrs.get("CLOSED-CAPTIONS"),
        lineNumber,
      };
      continue;
    }

    // EXT-X-I-FRAME-STREAM-INF
    if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) {
      hasStreamInf = true;
      const attrStr = line.substring("#EXT-X-I-FRAME-STREAM-INF:".length);
      result.duplicateAttrs.push(...findDuplicateAttrs(attrStr, "EXT-X-I-FRAME-STREAM-INF", lineNumber));
      const attrs = parseAttributeList(attrStr);
      result.iFrameStreamInfs.push({
        bandwidth: attrs.has("BANDWIDTH") ? parseInt(attrs.get("BANDWIDTH")!, 10) : undefined,
        codecs: attrs.get("CODECS"),
        resolution: attrs.has("RESOLUTION") ? parseResolution(attrs.get("RESOLUTION")!) : undefined,
        uri: attrs.get("URI") ?? "",
        lineNumber,
      });
      continue;
    }

    // EXT-X-MEDIA
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrStr = line.substring("#EXT-X-MEDIA:".length);
      result.duplicateAttrs.push(...findDuplicateAttrs(attrStr, "EXT-X-MEDIA", lineNumber));
      const attrs = parseAttributeList(attrStr);
      result.mediaTags.push({
        type: attrs.get("TYPE"),
        groupId: attrs.get("GROUP-ID"),
        name: attrs.get("NAME"),
        uri: attrs.get("URI"),
        lineNumber,
      });
      continue;
    }

    // EXTINF
    if (line.startsWith("#EXTINF:")) {
      const durationStr = line.substring("#EXTINF:".length).split(",")[0].trim();
      const duration = parseFloat(durationStr);
      // Next non-comment line is the URI — handle it when we see it
      // Store duration for the pending segment
      const segDuration = isNaN(duration) ? 0 : duration;

      // Look ahead for URI
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j].trim();
        if (nextLine === "" || (nextLine.startsWith("#") && !nextLine.startsWith("#EXT-X-BYTERANGE"))) {
          j++;
          continue;
        }
        if (nextLine.startsWith("#EXT-X-BYTERANGE:")) {
          // Handle inline byte-range, then continue to URI
          j++;
          continue;
        }
        break;
      }

      // Check for byte-range between EXTINF and URI
      let byteRange: { length: number; offset?: number } | undefined;
      for (let k = i + 1; k < j; k++) {
        const brl = lines[k].trim();
        if (brl.startsWith("#EXT-X-BYTERANGE:")) {
          const brVal = brl.substring("#EXT-X-BYTERANGE:".length).trim();
          const brParts = brVal.split("@");
          byteRange = {
            length: parseInt(brParts[0], 10),
            offset: brParts.length > 1 ? parseInt(brParts[1], 10) : undefined,
          };
        }
      }

      const segUri = j < lines.length ? lines[j].trim() : "";

      if (segUri && !segUri.startsWith("#")) {
        hasSegment = true;
        if (result.firstSegmentLine === undefined) {
          result.firstSegmentLine = lineNumber;
          if (result.firstDiscontinuityOrSegmentLine === undefined) {
            result.firstDiscontinuityOrSegmentLine = lineNumber;
          }
        }

        // Track byte-range predecessor
        if (byteRange && byteRange.offset === undefined) {
          // Offset can be omitted if it follows the previous byte-range of the same URI
          if (lastByteRangeUri !== segUri) {
            byteRange = { ...byteRange, offset: -1 }; // -1 = missing offset, no predecessor
          }
        }
        lastByteRangeUri = byteRange ? segUri : undefined;

        result.segments.push({
          uri: segUri,
          duration: segDuration,
          byteRange,
          discontinuity: pendingDiscontinuity,
          mapUri: currentMapUri,
          lineNumber: j + 1,
        });
        pendingDiscontinuity = false;
        i = j; // Skip past the URI line
      }
      continue;
    }

    // URI line for pending EXT-X-STREAM-INF
    if (pendingStreamInf && !line.startsWith("#")) {
      result.streamInfs.push({ ...pendingStreamInf, uri: line });
      pendingStreamInf = null;
      continue;
    }
  }

  result.isMultivariant = hasStreamInf && !hasSegment;

  return result;
}

// --- Phase 1: Multivariant text validation ---

export function validateHls(playlist: ParsedHlsPlaylist): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // HLS-001: #EXTM3U is first line
  if (!playlist.hasExtm3u) {
    issues.push({
      id: "HLS-001",
      severity: "error",
      category: "Manifest Structure",
      message: "Playlist does not start with #EXTM3U",
      specRef: "RFC 8216 §4.3.1.1",
    });
  }

  // HLS-002: EXT-X-VERSION present and consistent
  if (playlist.versionLines.length === 0) {
    issues.push({
      id: "HLS-002",
      severity: "warning",
      category: "Manifest Structure",
      message: "Missing EXT-X-VERSION tag",
      specRef: "RFC 8216 §4.3.1.2",
    });
  } else if (playlist.versionLines.length > 1) {
    issues.push({
      id: "HLS-002",
      severity: "warning",
      category: "Manifest Structure",
      message: `Multiple EXT-X-VERSION tags (lines ${playlist.versionLines.join(", ")})`,
      specRef: "RFC 8216 §4.3.1.2",
    });
  }

  // HLS-004: Both multivariant and media
  const hasStreamInfs = playlist.streamInfs.length > 0 || playlist.iFrameStreamInfs.length > 0;
  const hasSegments = playlist.segments.length > 0;
  if (hasStreamInfs && hasSegments) {
    issues.push({
      id: "HLS-004",
      severity: "error",
      category: "Manifest Structure",
      message: "Playlist contains both stream variants and media segments",
      detail: "A playlist must be either a Multivariant Playlist or a Media Playlist, not both.",
      specRef: "RFC 8216 §4",
    });
  }

  // HLS-005: BOM or control characters
  if (playlist.hasBom) {
    issues.push({
      id: "HLS-005",
      severity: "warning",
      category: "Manifest Structure",
      message: "Playlist starts with a UTF-8 BOM",
      detail: "Some players may not handle BOM correctly.",
    });
  }
  if (playlist.hasControlChars) {
    issues.push({
      id: "HLS-005",
      severity: "warning",
      category: "Manifest Structure",
      message: "Playlist contains control characters",
    });
  }

  // HLS-008: Duplicate attribute names
  for (const dup of playlist.duplicateAttrs) {
    issues.push({
      id: "HLS-008",
      severity: "error",
      category: "Manifest Structure",
      message: `Duplicate attribute "${dup.attr}" in ${dup.tag}`,
      location: `line ${dup.lineNumber}`,
      specRef: "RFC 8216 §4.2",
    });
  }

  // --- Multivariant-specific checks ---
  if (playlist.isMultivariant) {
    // Collect defined group IDs by type
    const definedGroups = new Map<string, Set<string>>();
    for (const media of playlist.mediaTags) {
      if (media.type && media.groupId) {
        if (!definedGroups.has(media.type)) definedGroups.set(media.type, new Set());
        definedGroups.get(media.type)!.add(media.groupId);
      }
    }

    for (const si of playlist.streamInfs) {
      const loc = `line ${si.lineNumber}`;

      // HLS-101: Missing BANDWIDTH
      if (si.bandwidth === undefined) {
        issues.push({
          id: "HLS-101",
          severity: "error",
          category: "Manifest Structure",
          message: "EXT-X-STREAM-INF missing BANDWIDTH",
          location: loc,
          specRef: "RFC 8216 §4.3.4.2",
        });
      }

      // HLS-102: Missing CODECS
      if (!si.codecs) {
        issues.push({
          id: "HLS-102",
          severity: "warning",
          category: "Manifest Structure",
          message: "EXT-X-STREAM-INF missing CODECS",
          location: loc,
          specRef: "RFC 8216 §4.3.4.2",
        });
      }

      // Determine if variant has video
      const hasVideo = si.codecs
        ? !si.codecs.split(",").every((c) => c.trim().startsWith("mp4a") || c.trim().startsWith("ac-") || c.trim().startsWith("ec-"))
        : true; // If no codecs, assume video

      if (hasVideo) {
        // HLS-103: Missing RESOLUTION
        if (!si.resolution) {
          issues.push({
            id: "HLS-103",
            severity: "warning",
            category: "Manifest Structure",
            message: "Video variant missing RESOLUTION",
            location: loc,
          });
        }

        // HLS-104: Missing FRAME-RATE
        if (si.frameRate === undefined) {
          issues.push({
            id: "HLS-104",
            severity: "warning",
            category: "Manifest Structure",
            message: "Video variant missing FRAME-RATE",
            location: loc,
          });
        }
      }

      // HLS-107: Dangling rendition group references
      const groupRefs: { type: string; groupId: string }[] = [];
      if (si.audio) groupRefs.push({ type: "AUDIO", groupId: si.audio });
      if (si.video) groupRefs.push({ type: "VIDEO", groupId: si.video });
      if (si.subtitles) groupRefs.push({ type: "SUBTITLES", groupId: si.subtitles });
      if (si.closedCaptions && si.closedCaptions !== "NONE") {
        groupRefs.push({ type: "CLOSED-CAPTIONS", groupId: si.closedCaptions });
      }

      for (const ref of groupRefs) {
        const groups = definedGroups.get(ref.type);
        if (!groups || !groups.has(ref.groupId)) {
          issues.push({
            id: "HLS-107",
            severity: "error",
            category: "Manifest Structure",
            message: `Dangling ${ref.type} group reference "${ref.groupId}"`,
            detail: `EXT-X-STREAM-INF references group "${ref.groupId}" but no EXT-X-MEDIA with TYPE=${ref.type} and GROUP-ID="${ref.groupId}" exists.`,
            location: loc,
            specRef: "RFC 8216 §4.3.4.2",
          });
        }
      }
    }

    // HLS-105: EXT-X-MEDIA missing required attributes
    for (const media of playlist.mediaTags) {
      const loc = `line ${media.lineNumber}`;
      const missing: string[] = [];
      if (!media.type) missing.push("TYPE");
      if (!media.groupId) missing.push("GROUP-ID");
      if (!media.name) missing.push("NAME");
      if (missing.length > 0) {
        issues.push({
          id: "HLS-105",
          severity: "error",
          category: "Manifest Structure",
          message: `EXT-X-MEDIA missing ${missing.join(", ")}`,
          location: loc,
          specRef: "RFC 8216 §4.3.4.1",
        });
      }

      // HLS-106: CLOSED-CAPTIONS with URI
      if (media.type === "CLOSED-CAPTIONS" && media.uri) {
        issues.push({
          id: "HLS-106",
          severity: "error",
          category: "Manifest Structure",
          message: "EXT-X-MEDIA TYPE=CLOSED-CAPTIONS must not have URI",
          location: loc,
          specRef: "RFC 8216 §4.3.4.1",
        });
      }
    }

    // HLS-108: VOD without I-frame playlists
    if (playlist.endList && playlist.iFrameStreamInfs.length === 0) {
      issues.push({
        id: "HLS-108",
        severity: "info",
        category: "Manifest Structure",
        message: "VOD playlist without EXT-X-I-FRAME-STREAM-INF",
        detail: "I-frame playlists enable trick-play (fast forward/rewind).",
        specRef: "RFC 8216 §4.3.4.3",
      });
    }

    // HLS-109: No cellular-compatible variant
    const hasLowBandwidth = playlist.streamInfs.some(
      (si) => si.bandwidth !== undefined && si.bandwidth <= 192000,
    );
    if (playlist.streamInfs.length > 0 && !hasLowBandwidth) {
      issues.push({
        id: "HLS-109",
        severity: "info",
        category: "Compatibility",
        message: "No cellular-compatible variant (BANDWIDTH <= 192 kbps)",
        detail: "Apple recommends including a low-bandwidth variant for cellular networks.",
      });
    }
  }

  // --- Media playlist checks (if this is a standalone media playlist) ---
  if (hasSegments && !hasStreamInfs) {
    issues.push(...validateHlsMediaPlaylistInner(playlist));
  }

  return issues;
}

// --- Phase 2: Media playlist validation ---

function validateHlsMediaPlaylistInner(
  playlist: ParsedHlsPlaylist,
  label?: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const prefix = label ? `[${label}] ` : "";

  // HLS-003: Missing EXT-X-TARGETDURATION
  if (playlist.targetDuration === undefined) {
    issues.push({
      id: "HLS-003",
      severity: "error",
      category: "Manifest Structure",
      message: `${prefix}Missing EXT-X-TARGETDURATION`,
      specRef: "RFC 8216 §4.3.3.1",
    });
  }

  // HLS-006: EXT-X-MEDIA-SEQUENCE after first segment
  if (
    playlist.mediaSequenceLine !== undefined &&
    playlist.firstSegmentLine !== undefined &&
    playlist.mediaSequenceLine > playlist.firstSegmentLine
  ) {
    issues.push({
      id: "HLS-006",
      severity: "error",
      category: "Manifest Structure",
      message: `${prefix}EXT-X-MEDIA-SEQUENCE appears after first media segment`,
      location: `line ${playlist.mediaSequenceLine}`,
      specRef: "RFC 8216 §4.3.3.2",
    });
  }

  // HLS-007: EXT-X-DISCONTINUITY-SEQUENCE after first segment/discontinuity
  if (
    playlist.discontinuitySequenceLine !== undefined &&
    playlist.firstDiscontinuityOrSegmentLine !== undefined &&
    playlist.discontinuitySequenceLine > playlist.firstDiscontinuityOrSegmentLine
  ) {
    issues.push({
      id: "HLS-007",
      severity: "error",
      category: "Manifest Structure",
      message: `${prefix}EXT-X-DISCONTINUITY-SEQUENCE appears after first segment or discontinuity`,
      location: `line ${playlist.discontinuitySequenceLine}`,
      specRef: "RFC 8216 §4.3.3.3",
    });
  }

  // HLS-201: EXTINF > TARGETDURATION
  if (playlist.targetDuration !== undefined) {
    for (const seg of playlist.segments) {
      if (Math.ceil(seg.duration) > playlist.targetDuration) {
        issues.push({
          id: "HLS-201",
          severity: "error",
          category: "Manifest Structure",
          message: `${prefix}Segment duration ${seg.duration.toFixed(3)}s (rounded up: ${Math.ceil(seg.duration)}) exceeds TARGETDURATION ${playlist.targetDuration}`,
          location: `line ${seg.lineNumber}`,
          specRef: "RFC 8216 §4.3.3.1",
        });
      }
    }
  }

  // HLS-205: Byte-range offset missing without predecessor
  for (const seg of playlist.segments) {
    if (seg.byteRange && seg.byteRange.offset === -1) {
      issues.push({
        id: "HLS-205",
        severity: "error",
        category: "Manifest Structure",
        message: `${prefix}Byte-range missing offset without preceding byte-range for same URI`,
        location: `line ${seg.lineNumber}`,
        specRef: "RFC 8216 §4.3.2.2",
      });
    }
  }

  // HLS-207: Live playlist with fewer than 3 target durations of segments
  if (!playlist.endList && playlist.targetDuration !== undefined) {
    const totalDuration = playlist.segments.reduce((sum, s) => sum + s.duration, 0);
    if (totalDuration < playlist.targetDuration * 3) {
      issues.push({
        id: "HLS-207",
        severity: "warning",
        category: "Manifest Structure",
        message: `${prefix}Live playlist has ${totalDuration.toFixed(1)}s of segments (< 3 × TARGETDURATION ${playlist.targetDuration}s)`,
        specRef: "RFC 8216 §6.2.2",
      });
    }
  }

  // HLS-208: fMP4 segments without EXT-X-MAP
  // Heuristic: if any segment URI ends with .m4s/.mp4 and has no map URI
  for (const seg of playlist.segments) {
    const isFmp4 = /\.(m4s|mp4|m4v|m4a|cmfv|cmfa)(\?.*)?$/i.test(seg.uri);
    if (isFmp4 && !seg.mapUri) {
      issues.push({
        id: "HLS-208",
        severity: "error",
        category: "Manifest Structure",
        message: `${prefix}fMP4 segment without EXT-X-MAP`,
        detail: `Segment "${seg.uri}" appears to be fMP4 but has no initialization segment defined via EXT-X-MAP.`,
        location: `line ${seg.lineNumber}`,
        specRef: "RFC 8216 §3",
      });
      break; // One issue per playlist is enough
    }
  }

  return issues;
}

export function validateHlsMediaPlaylist(media: ParsedHlsMediaPlaylist): ValidationIssue[] {
  return validateHlsMediaPlaylistInner(media.playlist, media.label);
}

// --- Fetch + cross-rendition checks ---

export async function fetchAndValidateHlsChildren(
  playlist: ParsedHlsPlaylist,
  baseUrl: string,
  fetchFn: (url: string) => Promise<string>,
): Promise<ValidationIssue[]> {
  if (!playlist.isMultivariant) return [];

  const childUrls: { url: string; label: string }[] = [];
  for (const si of playlist.streamInfs) {
    const url = resolveUrl(baseUrl, si.uri);
    const label = si.resolution
      ? `${si.resolution.width}x${si.resolution.height}`
      : si.bandwidth
        ? `${si.bandwidth}bps`
        : si.uri;
    childUrls.push({ url, label });
  }

  // Deduplicate by URL
  const uniqueChildren = childUrls.filter(
    (c, i) => childUrls.findIndex((o) => o.url === c.url) === i,
  );

  // Fetch and parse children
  const childResults = await Promise.all(
    uniqueChildren.map(async ({ url, label }) => {
      try {
        const text = await fetchFn(url);
        const parsed = parseHlsPlaylist(text);
        return { playlist: parsed, sourceUrl: url, label };
      } catch {
        return null;
      }
    }),
  );

  const children = childResults.filter((c): c is ParsedHlsMediaPlaylist => c !== null);

  const issues: ValidationIssue[] = [];

  // Validate each child
  for (const child of children) {
    issues.push(...validateHlsMediaPlaylist(child));
  }

  // HLS-206: Discontinuity count mismatch across renditions
  const discCounts = children
    .filter((c) => c.playlist.segments.length > 0)
    .map((c) => ({
      label: c.label,
      count: c.playlist.segments.filter((s) => s.discontinuity).length,
    }));

  if (discCounts.length > 1) {
    const uniqueCounts = new Set(discCounts.map((d) => d.count));
    if (uniqueCounts.size > 1) {
      const detail = discCounts.map((d) => `${d.label}: ${d.count}`).join(", ");
      issues.push({
        id: "HLS-206",
        severity: "error",
        category: "Manifest Structure",
        message: "Discontinuity count mismatch across renditions",
        detail: `Renditions have different discontinuity counts: ${detail}`,
        specRef: "RFC 8216 §6.2.2",
      });
    }
  }

  return issues;
}

function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith("http://") || relative.startsWith("https://")) {
    return relative;
  }
  try {
    return new URL(relative, base).href;
  } catch {
    // Fallback: simple path join
    const baseDir = base.substring(0, base.lastIndexOf("/") + 1);
    return baseDir + relative;
  }
}
