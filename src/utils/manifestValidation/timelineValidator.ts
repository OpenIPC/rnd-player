import shaka from "shaka-player";
import type { ValidationIssue } from "./types";

interface StreamTimeline {
  /** Human-readable label, e.g. "video 1280x720" or "audio 48kHz" */
  label: string;
  type: "video" | "audio" | "text";
  segments: { startTime: number; endTime: number }[];
}

/**
 * Validate segment timeline consistency across all streams.
 *
 * Operates on pre-extracted timeline data — no Shaka dependency here,
 * making it easy to unit test with synthetic data.
 */
export function validateTimelines(
  timelines: StreamTimeline[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Per-stream checks
  for (const tl of timelines) {
    if (tl.segments.length === 0) continue;

    // TL-001 / TL-002: Gaps and overlaps between consecutive segments
    for (let i = 0; i < tl.segments.length - 1; i++) {
      const curr = tl.segments[i];
      const next = tl.segments[i + 1];
      const delta = next.startTime - curr.endTime;

      if (delta > 0.001) {
        issues.push({
          id: "TL-001",
          severity: "warning",
          category: "Timeline",
          message: `Gap at ${fmtTime(curr.endTime)} (${fmtMs(delta)})`,
          detail: `Between segments ${i} and ${i + 1} of ${tl.label}. Expected: ${fmtTime(curr.endTime)}, got: ${fmtTime(next.startTime)}`,
        });
      } else if (delta < -0.001) {
        issues.push({
          id: "TL-002",
          severity: "warning",
          category: "Timeline",
          message: `Overlap at ${fmtTime(curr.endTime)} (${fmtMs(Math.abs(delta))})`,
          detail: `Between segments ${i} and ${i + 1} of ${tl.label}. Segment ${i} ends at ${fmtTime(curr.endTime)}, segment ${i + 1} starts at ${fmtTime(next.startTime)}`,
        });
      }
    }

    // TL-003: Duration variance — flag segments > 50% above or below mean
    const durations = tl.segments.map((s) => s.endTime - s.startTime);
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    if (mean > 0 && durations.length > 2) {
      for (let i = 0; i < durations.length; i++) {
        const d = durations[i];
        const pct = ((d - mean) / mean) * 100;
        // Skip last segment — often shorter (partial GOP)
        if (i === durations.length - 1) continue;
        if (Math.abs(pct) > 50) {
          issues.push({
            id: "TL-003",
            severity: "info",
            category: "Timeline",
            message: `Segment ${i} of ${tl.label}: duration ${d.toFixed(3)}s (${pct > 0 ? "+" : ""}${Math.round(pct)}% vs mean ${mean.toFixed(3)}s)`,
          });
        }
      }
    }
  }

  // TL-005: Duration mismatch across video representations
  const videoTimelines = timelines.filter((t) => t.type === "video");
  if (videoTimelines.length > 1) {
    const durations = videoTimelines.map((tl) => {
      const segs = tl.segments;
      return segs.length > 0 ? segs[segs.length - 1].endTime - segs[0].startTime : 0;
    });
    const maxDur = Math.max(...durations);
    const minDur = Math.min(...durations);
    const diff = maxDur - minDur;
    if (diff > 0.5) {
      // Group by duration (within 0.1s tolerance)
      const groups = groupByDuration(videoTimelines, durations, 0.1);
      const groupDescriptions = groups
        .map((g) => `${g.labels.join(", ")}: ${g.duration.toFixed(3)}s`)
        .join(" vs ");
      issues.push({
        id: "TL-005",
        severity: diff > 2 ? "error" : "warning",
        category: "Timeline",
        message: `Track duration mismatch (${diff.toFixed(3)}s difference)`,
        detail: groupDescriptions,
      });
    }
  }

  // TL-005 also for audio vs video duration mismatch
  const audioTimelines = timelines.filter((t) => t.type === "audio");
  if (videoTimelines.length > 0 && audioTimelines.length > 0) {
    const videoDur = getTimelineDuration(videoTimelines[0]);
    for (const atl of audioTimelines) {
      const audioDur = getTimelineDuration(atl);
      const diff = Math.abs(videoDur - audioDur);
      if (diff > 2) {
        issues.push({
          id: "TL-005",
          severity: "warning",
          category: "Timeline",
          message: `Audio/video duration mismatch (${diff.toFixed(3)}s)`,
          detail: `${audioTimelines[0].label}: ${audioDur.toFixed(3)}s vs ${videoTimelines[0].label}: ${videoDur.toFixed(3)}s`,
        });
      }
    }
  }

  // TL-006: Audio/video segment boundary alignment
  if (videoTimelines.length > 0 && audioTimelines.length > 0) {
    const videoSegs = videoTimelines[0].segments;
    const audioSegs = audioTimelines[0].segments;
    if (videoSegs.length > 0 && audioSegs.length > 0) {
      const videoSegDur = videoSegs.length > 1
        ? videoSegs[1].startTime - videoSegs[0].startTime
        : videoSegs[0].endTime - videoSegs[0].startTime;
      const audioSegDur = audioSegs.length > 1
        ? audioSegs[1].startTime - audioSegs[0].startTime
        : audioSegs[0].endTime - audioSegs[0].startTime;
      // Only check alignment if segment durations are very close (within 10%)
      // Different segment durations (e.g. 3s video / 2s audio in ISM) naturally
      // produce different segment grids — that's expected, not a problem.
      const durationRatio = Math.max(videoSegDur, audioSegDur) / Math.min(videoSegDur, audioSegDur);
      if (videoSegDur > 0 && audioSegDur > 0 && durationRatio < 1.1) {
        let misaligned = 0;
        const tolerance = Math.min(videoSegDur, audioSegDur) * 0.1;
        for (const vs of videoSegs) {
          const aligned = audioSegs.some(
            (as) => Math.abs(as.startTime - vs.startTime) < tolerance,
          );
          if (!aligned) misaligned++;
        }
        if (misaligned > videoSegs.length * 0.3) {
          issues.push({
            id: "TL-006",
            severity: "warning",
            category: "Timeline",
            message: `Audio/video segment boundaries misaligned`,
            detail: `${misaligned}/${videoSegs.length} video segment boundaries don't align with audio segments (tolerance: ${(tolerance * 1000).toFixed(0)}ms)`,
          });
        }
      }
    }
  }

  return issues;
}

function getTimelineDuration(tl: StreamTimeline): number {
  const segs = tl.segments;
  return segs.length > 0 ? segs[segs.length - 1].endTime - segs[0].startTime : 0;
}

interface DurationGroup {
  labels: string[];
  duration: number;
}

function groupByDuration(
  timelines: StreamTimeline[],
  durations: number[],
  tolerance: number,
): DurationGroup[] {
  const groups: DurationGroup[] = [];
  for (let i = 0; i < timelines.length; i++) {
    const existing = groups.find((g) => Math.abs(g.duration - durations[i]) < tolerance);
    if (existing) {
      existing.labels.push(timelines[i].label);
    } else {
      groups.push({ labels: [timelines[i].label], duration: durations[i] });
    }
  }
  return groups;
}

function fmtTime(seconds: number): string {
  return seconds.toFixed(3) + "s";
}

function fmtMs(seconds: number): string {
  return (seconds * 1000).toFixed(0) + "ms";
}

// --- Shaka integration helper ---

/**
 * Extract StreamTimeline[] from a Shaka player instance.
 * Call this from the component layer — keeps Shaka dependency out of pure validation logic.
 */
export async function extractTimelinesFromShaka(
  player: { getManifest(): shaka.extern.Manifest | null },
): Promise<StreamTimeline[]> {
  const manifest = player.getManifest();
  if (!manifest) return [];

  const timelines: StreamTimeline[] = [];
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

      const segments: { startTime: number; endTime: number }[] = [];
      for (const ref of segIndex) {
        if (!ref) continue;
        segments.push({
          startTime: ref.getStartTime(),
          endTime: ref.getEndTime(),
        });
      }

      const type = stream.type === "audio" ? "audio" : "video";
      const label =
        type === "video" && stream.width && stream.height
          ? `video ${stream.width}x${stream.height}`
          : type === "audio"
            ? `audio${stream.channelsCount ? ` ${stream.channelsCount}ch` : ""}`
            : `${type} (id=${stream.id})`;

      timelines.push({ label, type, segments });
    }
  }

  return timelines;
}
