/**
 * Media segment deep scan — validates internal consistency of media segments.
 *
 * Fetches actual media segments and compares moof box structure (trun sample
 * sizes, senc sub-sample entries, mfhd sequence numbers, tfdt timestamps)
 * against expected values. Catches packaging bugs like the CDP senc/trun
 * mismatch that causes truncated responses on clear endpoints.
 *
 * Pure validation logic — no Shaka dependency. Shaka integration helper
 * at the bottom of the file.
 */

import shaka from "shaka-player";
import type { ValidationIssue } from "./types";
import { findBoxData, parseSencFromSegment, extractTenc } from "../../workers/cencDecrypt";
import { extractInitSegmentUrl } from "../extractInitSegmentUrl";

// --- Public types ---

export interface ScanTrack {
  label: string;
  type: "video" | "audio";
  /** Per-sample IV size from tenc (0 for CBCS constant-IV or clear content) */
  ivSize: number;
  /** Track timescale for tfdt comparison */
  timescale: number;
  segments: ScanSegmentRef[];
}

export interface ScanSegmentRef {
  index: number;
  startTime: number;
  endTime: number;
  url: string;
  startByte: number;
  endByte: number | null;
}

export interface SegmentFetchResult {
  data: ArrayBuffer;
  /** Value of Content-Length header, null if missing */
  contentLength: number | null;
}

export interface ScanProgress {
  trackLabel: string;
  segIndex: number;
  trackNumber: number;
  totalTracks: number;
}

export interface ScanOptions {
  /** Max segments to scan per track (default: 1 — seg0 is the most common failure point) */
  maxSegmentsPerTrack?: number;
}

export interface DeepScanResult {
  issues: ValidationIssue[];
  tracksScanned: number;
  segmentsFetched: number;
}

// --- Internal parsers ---

interface TrunSample {
  size: number;
  duration?: number;
}

/** Parse trun (Track Run) box to extract per-sample sizes */
function parseTrun(segmentData: Uint8Array): TrunSample[] | null {
  const content = findBoxData(segmentData, "trun");
  if (!content || content.length < 8) return null;

  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const flags = ((content[1] << 16) | (content[2] << 8) | content[3]) >>> 0;
  let pos = 4; // skip version + flags

  const sampleCount = view.getUint32(pos);
  pos += 4;

  // Optional fields before per-sample data
  if (flags & 0x1) pos += 4; // data_offset
  if (flags & 0x4) pos += 4; // first_sample_flags

  const hasDuration = !!(flags & 0x100);
  const hasSize = !!(flags & 0x200);
  const hasFlags = !!(flags & 0x400);
  const hasCTO = !!(flags & 0x800);

  const perSampleBytes =
    (hasDuration ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCTO ? 4 : 0);

  const samples: TrunSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    if (pos + perSampleBytes > content.length) break;

    let samplePos = pos;
    const duration = hasDuration ? view.getUint32(samplePos) : undefined;
    if (hasDuration) samplePos += 4;

    const size = hasSize ? view.getUint32(samplePos) : 0;
    if (hasSize) samplePos += 4;

    // skip sample_flags + composition_time_offset
    samples.push({ size, duration });
    pos += perSampleBytes;
  }

  return samples;
}

/** Parse tfhd to get default_sample_duration (flag 0x08) */
function parseTfhdDefaultDuration(segmentData: Uint8Array): number | null {
  const content = findBoxData(segmentData, "tfhd");
  if (!content || content.length < 8) return null;

  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const flags = ((content[1] << 16) | (content[2] << 8) | content[3]) >>> 0;
  let pos = 4 + 4; // skip version+flags + track_ID

  if (flags & 0x1) pos += 8; // base_data_offset
  if (flags & 0x2) pos += 4; // sample_description_index

  if (flags & 0x8) {
    if (pos + 4 > content.length) return null;
    return view.getUint32(pos);
  }

  return null;
}

/** Parse tfhd to get default_sample_size if per-sample sizes aren't in trun */
function parseTfhdDefaultSize(segmentData: Uint8Array): number | null {
  const content = findBoxData(segmentData, "tfhd");
  if (!content || content.length < 8) return null;

  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const flags = ((content[1] << 16) | (content[2] << 8) | content[3]) >>> 0;
  let pos = 4 + 4; // skip version+flags + track_ID

  if (flags & 0x1) pos += 8; // base_data_offset
  if (flags & 0x2) pos += 4; // sample_description_index
  if (flags & 0x8) pos += 4; // default_sample_duration

  if (flags & 0x10) {
    if (pos + 4 > content.length) return null;
    return view.getUint32(pos);
  }

  return null;
}

/** Parse mfhd (Movie Fragment Header) to get sequence number */
function parseMfhd(segmentData: Uint8Array): number | null {
  const content = findBoxData(segmentData, "mfhd");
  if (!content || content.length < 8) return null;

  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  return view.getUint32(4); // skip version+flags, read sequence_number
}

/** Parse tfdt (Track Fragment Decode Time) to get base media decode time */
function parseTfdt(segmentData: Uint8Array): number | null {
  const content = findBoxData(segmentData, "tfdt");
  if (!content || content.length < 8) return null;

  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const version = content[0];

  if (version === 1) {
    if (content.length < 12) return null;
    // 64-bit: read as two 32-bit values
    const hi = view.getUint32(4);
    const lo = view.getUint32(8);
    return hi * 0x100000000 + lo;
  }

  return view.getUint32(4);
}

// --- Main scanner ---

/**
 * Scan media segments for internal consistency issues.
 *
 * Pure validation — no Shaka dependency. Takes pre-extracted track data
 * and a fetch function.
 */
export async function scanSegments(
  tracks: ScanTrack[],
  fetchFn: (url: string, startByte?: number, endByte?: number | null) => Promise<SegmentFetchResult>,
  options?: ScanOptions,
  onProgress?: (progress: ScanProgress) => void,
): Promise<DeepScanResult> {
  const issues: ValidationIssue[] = [];
  const maxSegs = options?.maxSegmentsPerTrack ?? 1;
  let segmentsFetched = 0;

  // Collect per-video-track sample duration for BMFF-S05 cross-track fps comparison
  const videoDurations: Array<{ label: string; fps: number }> = [];

  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    const segsToScan = track.segments.slice(0, maxSegs);
    let prevSeqNum: number | null = null;

    for (const seg of segsToScan) {
      onProgress?.({
        trackLabel: track.label,
        segIndex: seg.index,
        trackNumber: ti + 1,
        totalTracks: tracks.length,
      });

      let result: SegmentFetchResult;
      try {
        result = await fetchFn(seg.url, seg.startByte, seg.endByte);
        segmentsFetched++;
      } catch {
        issues.push({
          id: "BMFF-S02",
          severity: "error",
          category: "Container",
          message: `Failed to fetch segment ${seg.index} of ${track.label}`,
        });
        continue;
      }

      const bytes = new Uint8Array(result.data);

      // BMFF-S02: Content-Length vs received bytes (truncation detection)
      if (result.contentLength !== null && result.data.byteLength < result.contentLength) {
        const missing = result.contentLength - result.data.byteLength;
        const pct = ((missing / result.contentLength) * 100).toFixed(1);
        issues.push({
          id: "BMFF-S02",
          severity: "error",
          category: "Container",
          message: `Truncated segment ${seg.index} of ${track.label}`,
          detail: `Content-Length: ${result.contentLength}, received: ${result.data.byteLength} (${pct}% missing)`,
        });
      }

      // BMFF-S03: Sequence number monotonically increasing
      const seqNum = parseMfhd(bytes);
      if (seqNum !== null) {
        if (prevSeqNum !== null && seqNum <= prevSeqNum) {
          issues.push({
            id: "BMFF-S03",
            severity: "warning",
            category: "Container",
            message: `Non-monotonic moof sequence: seg ${seg.index} has seq ${seqNum} (prev: ${prevSeqNum})`,
            detail: track.label,
          });
        }
        prevSeqNum = seqNum;
      }

      // BMFF-S04: tfdt vs expected timeline position
      if (track.timescale > 0) {
        const tfdt = parseTfdt(bytes);
        if (tfdt !== null) {
          const expectedTicks = seg.startTime * track.timescale;
          const diffTicks = Math.abs(tfdt - expectedTicks);
          const diffSeconds = diffTicks / track.timescale;
          // Allow 1 frame tolerance (~50ms for 20fps, ~33ms for 30fps)
          if (diffSeconds > 0.1) {
            issues.push({
              id: "BMFF-S04",
              severity: "warning",
              category: "Container",
              message: `tfdt mismatch on seg ${seg.index} of ${track.label}`,
              detail: `tfdt=${tfdt} (${(tfdt / track.timescale).toFixed(3)}s), expected=${Math.round(expectedTicks)} (${seg.startTime.toFixed(3)}s), diff=${diffSeconds.toFixed(3)}s`,
            });
          }
        }
      }

      // BMFF-S05: collect sample duration for video tracks (first segment only)
      if (track.type === "video" && seg.index === 0 && track.timescale > 0) {
        let sampleDuration = parseTfhdDefaultDuration(bytes);
        if (sampleDuration === null) {
          // Fallback: use first trun sample's duration
          const trunForDuration = parseTrun(bytes);
          if (trunForDuration && trunForDuration.length > 0 && trunForDuration[0].duration !== undefined) {
            sampleDuration = trunForDuration[0].duration;
          }
        }
        if (sampleDuration !== null && sampleDuration > 0) {
          videoDurations.push({
            label: track.label,
            fps: track.timescale / sampleDuration,
          });
        }
      }

      // BMFF-S01: senc sub-sample totals vs trun sample sizes
      const trunSamples = parseTrun(bytes);
      if (!trunSamples || trunSamples.length === 0) continue;

      // If trun has no per-sample sizes, check tfhd default
      const hasPerSampleSizes = trunSamples.some((s) => s.size > 0);
      if (!hasPerSampleSizes) {
        const defaultSize = parseTfhdDefaultSize(bytes);
        if (defaultSize !== null && defaultSize > 0) {
          for (const s of trunSamples) s.size = defaultSize;
        }
      }

      const sencSamples = parseSencFromSegment(result.data, track.ivSize);
      if (sencSamples.length === 0) continue; // no senc → nothing to compare

      const mismatches: Array<{
        sampleIdx: number;
        trunSize: number;
        sencTotal: number;
        diff: number;
      }> = [];

      const count = Math.min(trunSamples.length, sencSamples.length);
      for (let i = 0; i < count; i++) {
        const trunSize = trunSamples[i].size;
        const sencSample = sencSamples[i];
        if (!sencSample.subsamples || sencSample.subsamples.length === 0) continue;

        const sencTotal = sencSample.subsamples.reduce(
          (sum, ss) => sum + ss.clearBytes + ss.encryptedBytes,
          0,
        );

        if (trunSize > 0 && sencTotal > 0 && trunSize !== sencTotal) {
          mismatches.push({
            sampleIdx: i,
            trunSize,
            sencTotal,
            diff: trunSize - sencTotal,
          });
        }
      }

      if (mismatches.length > 0) {
        const diffs = mismatches.map((m) => m.diff);
        const minDiff = Math.min(...diffs);
        const maxDiff = Math.max(...diffs);
        const diffRange = minDiff === maxDiff ? `${minDiff}` : `${minDiff}–${maxDiff}`;

        issues.push({
          id: "BMFF-S01",
          severity: "error",
          category: "Container",
          message: `senc/trun mismatch: ${mismatches.length}/${count} samples in seg ${seg.index} of ${track.label}`,
          detail: `Samples ${mismatches.map((m) => m.sampleIdx).join(", ")} have senc sub-sample totals ${diffRange} bytes short of trun sizes`,
          specRef: "CENC spec / ISO 23001-7",
        });
      }
    }
  }

  // BMFF-S05: cross-track video frame rate mismatch (container-level complement to DASH-112)
  if (videoDurations.length >= 2) {
    // Group by fps with 0.5 fps tolerance
    const groups: Array<{ fps: number; labels: string[] }> = [];
    for (const vd of videoDurations) {
      const existing = groups.find((g) => Math.abs(g.fps - vd.fps) < 0.5);
      if (existing) {
        existing.labels.push(vd.label);
      } else {
        groups.push({ fps: vd.fps, labels: [vd.label] });
      }
    }

    if (groups.length > 1) {
      const groupDescs = groups
        .map((g) => `${g.fps.toFixed(2)} fps (${g.labels.join(", ")})`)
        .join(" vs ");
      issues.push({
        id: "BMFF-S05",
        severity: "error",
        category: "Container",
        message: `Mixed frame rates across video tracks: ${groupDescs}`,
        detail: "Different sample_duration values in tfhd/trun across video tracks. May cause A/V desync during ABR switches.",
      });
    }
  }

  return { issues, tracksScanned: tracks.length, segmentsFetched };
}

// --- Shaka integration helper ---

/**
 * Extract scan tracks from a Shaka player instance.
 * Gets segment URLs, IV sizes from init segments, and timescales.
 */
export async function extractScanTracksFromShaka(
  player: { getManifest(): shaka.extern.Manifest | null },
  initFetchFn: (url: string) => Promise<ArrayBuffer>,
  maxSegmentsPerTrack = 1,
): Promise<ScanTrack[]> {
  const manifest = player.getManifest();
  if (!manifest) return [];

  // Lazy-load mp4box for init segment parsing (tenc extraction)
  let Mp4box: { createFile(): ReturnType<typeof Object> } | null = null;
  try {
    Mp4box = await import("mp4box");
  } catch {
    // mp4box not available — we'll scan without tenc info (ivSize=0)
  }

  const tracks: ScanTrack[] = [];
  const seen = new Set<number>();

  for (const variant of manifest.variants) {
    for (const stream of [variant.video, variant.audio]) {
      if (!stream || seen.has(stream.id)) continue;
      seen.add(stream.id);

      try {
        await stream.createSegmentIndex();
      } catch {
        continue;
      }

      const segIndex = stream.segmentIndex;
      if (!segIndex) continue;

      const type = stream.type === "audio" ? "audio" as const : "video" as const;
      const label =
        type === "video" && stream.width && stream.height
          ? `video ${stream.width}x${stream.height}`
          : type === "audio"
            ? `audio${stream.channelsCount ? ` ${stream.channelsCount}ch` : ""}`
            : `${type} (id=${stream.id})`;

      // Collect segment refs
      const segments: ScanSegmentRef[] = [];
      let initSegUrl: string | null = null;

      for (const ref of segIndex) {
        if (!ref) continue;
        if (!initSegUrl) {
          initSegUrl = extractInitSegmentUrl(ref);
        }
        if (segments.length >= maxSegmentsPerTrack) break;

        const uris = ref.getUris();
        if (!uris || uris.length === 0) continue;

        segments.push({
          index: segments.length,
          startTime: ref.getStartTime(),
          endTime: ref.getEndTime(),
          url: uris[0],
          startByte: ref.getStartByte(),
          endByte: ref.getEndByte(),
        });
      }

      if (segments.length === 0) continue;

      // Parse init segment for ivSize (tenc) and timescale (mdhd)
      let ivSize = 0;
      let timescale = 90000; // default fallback

      if (initSegUrl && Mp4box) {
        try {
          const initData = await initFetchFn(initSegUrl);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mp4 = (Mp4box as any).createFile();
          const buf = initData.slice(0) as ArrayBuffer & { fileStart: number };
          buf.fileStart = 0;
          mp4.appendBuffer(buf);
          mp4.flush();

          // Try to get tenc for ivSize — use mp4box track IDs, not Shaka's
          const traks = mp4.moov?.traks ?? [];
          for (const trak of traks) {
            const trackId = trak.tkhd?.track_id;
            if (!trackId) continue;
            const tenc = extractTenc(mp4, trackId);
            if (tenc) {
              ivSize = tenc.defaultPerSampleIVSize;
            }
            // Get timescale from mdhd
            const mdhd = trak.mdia?.mdhd;
            if (mdhd?.timescale) {
              timescale = mdhd.timescale;
            }
            break; // Use first track in this init segment
          }
        } catch {
          // Failed to parse init segment — scan with defaults
        }
      }

      tracks.push({ label, type, ivSize, timescale, segments });
    }
  }

  return tracks;
}

// Export internal parsers for testing
export { parseTrun, parseMfhd, parseTfdt, parseTfhdDefaultSize, parseTfhdDefaultDuration };
