/**
 * BMFF init segment structure validation.
 *
 * Fetches init segments via extractInitSegmentUrl(), parses with mp4box.js,
 * and validates box structure + encryption metadata.
 */

import shaka from "shaka-player";
import type { ValidationIssue } from "./types";
import { extractTenc, extractScheme } from "../../workers/cencDecrypt";
import { extractInitSegmentUrl } from "../extractInitSegmentUrl";

// Minimal mp4box types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mp4boxFile = any;
interface Mp4boxModule {
  createFile(): Mp4boxFile;
}

let mp4boxModule: Mp4boxModule | null = null;

async function getMp4box(): Promise<Mp4boxModule> {
  if (!mp4boxModule) {
    mp4boxModule = await import("mp4box");
  }
  return mp4boxModule;
}

interface StreamInfo {
  id: number;
  type: "video" | "audio";
  label: string;
  codecs: string;
  encrypted: boolean;
  drmScheme?: string;
  initSegmentUrl: string | null;
}

/**
 * Extract stream info + init segment URLs from Shaka manifest.
 */
export async function extractStreamsFromShaka(
  player: { getManifest(): shaka.extern.Manifest | null },
): Promise<StreamInfo[]> {
  const manifest = player.getManifest();
  if (!manifest) return [];

  const streams: StreamInfo[] = [];
  const seen = new Set<number>();

  for (const variant of manifest.variants) {
    for (const stream of [variant.video, variant.audio]) {
      if (!stream || seen.has(stream.id)) continue;
      seen.add(stream.id);

      const type = stream.type === "audio" ? "audio" as const : "video" as const;
      const label =
        type === "video" && stream.width && stream.height
          ? `video ${stream.width}x${stream.height}`
          : type === "audio"
            ? `audio${stream.channelsCount ? ` ${stream.channelsCount}ch` : ""}`
            : `${type} (id=${stream.id})`;

      let initUrl: string | null = null;
      try {
        await stream.createSegmentIndex();
        const segIndex = stream.segmentIndex;
        if (segIndex) {
          for (const ref of segIndex) {
            if (ref) {
              initUrl = extractInitSegmentUrl(ref);
              break;
            }
          }
        }
      } catch {
        // segment index creation failed
      }

      const encrypted = !!(stream.encrypted || (stream.drmInfos && stream.drmInfos.length > 0));
      const drmScheme = stream.drmInfos?.[0]?.encryptionScheme ?? undefined;

      streams.push({
        id: stream.id,
        type,
        label,
        codecs: stream.codecs ?? "",
        encrypted,
        drmScheme,
        initSegmentUrl: initUrl,
      });
    }
  }

  return streams;
}

/**
 * Validate init segment BMFF structure.
 * Returns issues found across all streams.
 */
export async function validateBmff(
  streams: StreamInfo[],
  fetchFn: (url: string) => Promise<ArrayBuffer>,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const brandIssues = new Map<string, string[]>(); // unknown brands → list of track labels
  const MP4Box = await getMp4box();

  // Group streams by init URL to avoid duplicate fetches
  const byUrl = new Map<string, StreamInfo[]>();
  for (const s of streams) {
    if (!s.initSegmentUrl) continue;
    const list = byUrl.get(s.initSegmentUrl) ?? [];
    list.push(s);
    byUrl.set(s.initSegmentUrl, list);
  }

  for (const [url, streamsForUrl] of byUrl) {
    const label = streamsForUrl.map((s) => s.label).join(", ");
    let data: ArrayBuffer;
    try {
      data = await fetchFn(url);
    } catch {
      issues.push({
        id: "BMFF-ERR",
        severity: "error",
        category: "Container",
        message: `Failed to fetch init segment for ${label}`,
      });
      continue;
    }

    const bytes = new Uint8Array(data);
    if (bytes.length < 8) {
      issues.push({
        id: "BMFF-ERR",
        severity: "error",
        category: "Container",
        message: `Init segment too small (${bytes.length} bytes) for ${label}`,
      });
      continue;
    }

    // BMFF-001: ftyp present and first box
    const firstBoxType = readBoxType(bytes, 0);
    if (firstBoxType !== "ftyp") {
      issues.push({
        id: "BMFF-001",
        severity: "error",
        category: "Container",
        message: `First box is "${firstBoxType}", expected "ftyp"`,
        detail: label,
        specRef: "ISO 14496-12",
      });
    }

    // Parse with mp4box for deeper inspection
    let mp4: Mp4boxFile;
    try {
      mp4 = MP4Box.createFile();
      const buf = data.slice(0) as ArrayBuffer & { fileStart: number };
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
      mp4.flush();
    } catch {
      issues.push({
        id: "BMFF-ERR",
        severity: "error",
        category: "Container",
        message: `Failed to parse init segment for ${label}`,
      });
      continue;
    }

    // BMFF-002: moov present
    if (!mp4.moov) {
      issues.push({
        id: "BMFF-002",
        severity: "error",
        category: "Container",
        message: `Missing moov box in init segment`,
        detail: label,
        specRef: "ISO 14496-12",
      });
      continue; // Can't do further checks without moov
    }

    // BMFF-003: mvex present (required for fMP4/MSE)
    if (!mp4.moov.mvex) {
      issues.push({
        id: "BMFF-003",
        severity: "error",
        category: "Container",
        message: `Missing mvex box (required for fragmented MP4)`,
        detail: label,
        specRef: "W3C MSE Byte Stream Format",
      });
    }

    // BMFF-007: Check ftyp brands
    if (mp4.ftyp) {
      const brands = [mp4.ftyp.major_brand, ...(mp4.ftyp.compatible_brands ?? [])];
      const knownBrands = new Set([
        "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9",
        "avc1", "hvc1", "hev1", "av01", "vp09",
        "mp41", "mp42", "mp71",
        "dash", "msdh", "msix",
        "cmfc", "cmfl", "cmff",
        "piff", // Microsoft PIFF (Smooth Streaming / ISM)
        "M4V ", "M4A ",
      ]);
      const unknown = brands.filter((b: string) => b && !knownBrands.has(b.trim()));
      if (unknown.length > 0) {
        const key = unknown.map((b: string) => b.trim()).sort().join(",");
        const labels = brandIssues.get(key) ?? [];
        labels.push(label);
        brandIssues.set(key, labels);
      }
    }

    // Per-track checks
    const traks = mp4.moov.traks ?? [];
    for (const trak of traks) {
      const trackId = trak.tkhd?.track_id;
      if (!trackId) continue;

      const stream = streamsForUrl.find((s) => s.id === trackId) ?? streamsForUrl[0];
      const trackLabel = stream?.label ?? `track ${trackId}`;

      // BMFF-008/009: Encryption box validation
      const tencInfo = extractTenc(mp4, trackId);
      const scheme = extractScheme(mp4, trackId);

      if (tencInfo) {
        // BMFF-011: tenc present but content might be clear
        const isProtected = tencInfo.defaultPerSampleIVSize > 0 ||
          tencInfo.defaultConstantIV !== null;
        const kid = Array.from(tencInfo.defaultKID as Uint8Array)
          .map((b: number) => b.toString(16).padStart(2, "0"))
          .join("");
        const isNonZeroKid = kid !== "00000000000000000000000000000000";

        if (isNonZeroKid && !stream?.encrypted) {
          issues.push({
            id: "BMFF-011",
            severity: "warning",
            category: "Container",
            message: `Encryption metadata on clear content`,
            detail: `${trackLabel}: tenc.isProtected=${isProtected ? 1 : 0}, KID=${kid.slice(0, 8)}..., scheme=${scheme ?? "none"} — but Shaka reports stream as unencrypted`,
          });
        }

        // BMFF-008: tenc validation
        if (isProtected && tencInfo.defaultPerSampleIVSize === 0 && !tencInfo.defaultConstantIV) {
          issues.push({
            id: "BMFF-008",
            severity: "error",
            category: "Container",
            message: `tenc has isProtected=1 but no IV size or constant IV`,
            detail: trackLabel,
            specRef: "CENC spec",
          });
        }
      }

      if (scheme) {
        // BMFF-009: scheme type is cenc or cbcs
        if (scheme !== "cenc" && scheme !== "cbcs" && scheme !== "cens" && scheme !== "cbc1") {
          issues.push({
            id: "BMFF-009",
            severity: "error",
            category: "Container",
            message: `Unknown encryption scheme "${scheme}"`,
            detail: `${trackLabel}. Expected "cenc" or "cbcs"`,
            specRef: "CENC spec",
          });
        }
      }
    }
  }

  // Emit deduplicated BMFF-007 brand issues
  for (const [key, labels] of brandIssues) {
    const brands = key.split(",").map((b) => `"${b}"`).join(", ");
    issues.push({
      id: "BMFF-007",
      severity: "info",
      category: "Container",
      message: `Uncommon ftyp brand(s): ${brands}`,
      detail: labels.length > 3
        ? `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more tracks`
        : labels.join(", "),
    });
  }

  return issues;
}

/**
 * Read 4-byte box type at a given offset in raw bytes.
 */
function readBoxType(data: Uint8Array, offset: number): string {
  if (offset + 8 > data.length) return "";
  return String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
}
