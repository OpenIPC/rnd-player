import shaka from "shaka-player";
import type { ValidationIssue, ValidationResult } from "./types";
import { validateTimelines, extractTimelinesFromShaka } from "./timelineValidator";
import { validateBmff, extractStreamsFromShaka } from "./bmffValidator";
import { validateCodecs } from "./codecValidator";
import { parseMpd, validateDash } from "./dashValidator";
import { scanSegments, extractScanTracksFromShaka } from "./segmentScanner";
import type { ScanProgress, DeepScanResult } from "./segmentScanner";

/**
 * Run all available validators and collect results.
 *
 * Stage 1: Timeline checks (no fetching).
 * Stage 2: BMFF + codec checks (fetches init segments).
 */
export async function runValidation(
  player: shaka.Player,
  onProgress?: (issues: ValidationIssue[]) => void,
  rawManifestText?: string,
): Promise<ValidationResult> {
  const start = performance.now();
  const manifestUrl = player.getAssetUri() ?? "";
  const manifestType = player.getManifestType() ?? "unknown";

  // Stage 1: Timeline validation (uses Shaka's parsed manifest, no fetching)
  const timelines = await extractTimelinesFromShaka(player);
  const timelineIssues = validateTimelines(timelines);

  // Stage 1b: DASH MPD validation (pure XML checks, no fetching)
  let dashIssues: ValidationIssue[] = [];
  if (manifestType === "DASH" && rawManifestText) {
    dashIssues = validateDash(parseMpd(rawManifestText));
  }

  // Report Stage 1 + 1b results immediately
  const stage1Issues = [...timelineIssues, ...dashIssues];
  if (onProgress) onProgress(stage1Issues);

  // Stage 2: BMFF + Codec validation (fetches init segments)
  const streams = await extractStreamsFromShaka(player);
  const fetchInit = async (url: string): Promise<ArrayBuffer> => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.arrayBuffer();
  };

  const [bmffIssues, codecIssues] = await Promise.all([
    validateBmff(streams, fetchInit).catch((e) => {
      console.warn("[ManifestValidator] BMFF validation failed:", e);
      return [] as ValidationIssue[];
    }),
    validateCodecs(
      streams.map((s) => ({ ...s, manifestType })),
      fetchInit,
    ).catch((e) => {
      console.warn("[ManifestValidator] Codec validation failed:", e);
      return [] as ValidationIssue[];
    }),
  ]);

  const issues = [...timelineIssues, ...dashIssues, ...bmffIssues, ...codecIssues];
  const duration = performance.now() - start;

  return {
    manifestType,
    manifestUrl,
    timestamp: Date.now(),
    duration,
    issues,
    summary: {
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
      info: issues.filter((i) => i.severity === "info").length,
    },
  };
}

/**
 * Run deep scan — fetches media segments and validates internal consistency.
 * Separate from runValidation because it's user-initiated (expensive).
 *
 * Stage 3: senc/trun mismatch, truncation, sequence numbers, tfdt timing.
 */
export async function runDeepScan(
  player: shaka.Player,
  onProgress?: (progress: ScanProgress) => void,
  options?: { maxSegmentsPerTrack?: number },
): Promise<DeepScanResult> {
  const fetchInit = async (url: string): Promise<ArrayBuffer> => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.arrayBuffer();
  };

  const tracks = await extractScanTracksFromShaka(
    player,
    fetchInit,
    options?.maxSegmentsPerTrack ?? 1,
  );

  const fetchSegment = async (url: string, startByte?: number, endByte?: number | null) => {
    const headers: Record<string, string> = {};
    if (startByte !== undefined && startByte > 0) {
      const rangeEnd = endByte != null ? endByte : "";
      headers["Range"] = `bytes=${startByte}-${rangeEnd}`;
    }
    const resp = await fetch(url, { headers });
    if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status} for ${url}`);
    const contentLengthHeader = resp.headers.get("content-length");
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
    const data = await resp.arrayBuffer();
    return { data, contentLength };
  };

  return scanSegments(tracks, fetchSegment, options, onProgress);
}

export type { DeepScanResult, ScanProgress };
