/**
 * Parse DASH MPD manifest XML to extract EC-3/AC-3 audio track info
 * for software decode playback.
 *
 * Extracts SegmentTemplate patterns, timescale, duration, channel config,
 * and provides segment URL resolution for independent fetching.
 */

export interface Ec3TrackInfo {
  /** Unique identifier for this track */
  id: string;
  /** Codec string (e.g., "ec-3", "ac-3") */
  codec: string;
  /** Language code */
  language: string;
  /** Display label */
  label: string;
  /** Number of audio channels */
  channelCount: number;
  /** Bandwidth in bits/sec */
  bandwidth: number;
  /** Audio sampling rate in Hz */
  sampleRate: number;
  /** Segment info for independent fetching */
  segments: Ec3SegmentInfo;
}

export interface Ec3SegmentInfo {
  /** Init segment URL (resolved) */
  initUrl: string;
  /** Timescale (ticks per second) */
  timescale: number;
  /** Segment duration in timescale units (for SegmentTemplate @duration) */
  segmentDuration: number;
  /** Start number for segments (default 1) */
  startNumber: number;
  /** Media URL template with $Number$/$Time$ placeholders */
  mediaTemplate: string;
  /** Base URL for resolving relative URLs */
  baseUrl: string;
  /** If using SegmentTimeline, the timeline entries */
  timeline: TimelineEntry[] | null;
  /** Total presentation duration in seconds (from MPD@mediaPresentationDuration) */
  presentationDuration: number;
  /** Presentation time offset in timescale units (maps media time → presentation time) */
  presentationTimeOffset: number;
}

export interface TimelineEntry {
  /** Start time in timescale units */
  start: number;
  /** Duration in timescale units */
  duration: number;
  /** Repeat count (0 = appears once, n = appears n+1 times) */
  repeat: number;
}

/**
 * Parse a DASH MPD document and extract EC-3/AC-3 audio tracks
 * that the browser cannot natively decode.
 *
 * @param manifestText Raw MPD XML string
 * @param manifestUrl The URL the manifest was loaded from (for relative URL resolution)
 * @returns Array of EC-3 track info objects, empty if none found or all natively supported
 */
export function parseEc3Tracks(manifestText: string, manifestUrl: string): Ec3TrackInfo[] {
  const doc = new DOMParser().parseFromString(manifestText, "text/xml");
  const tracks: Ec3TrackInfo[] = [];

  // Get presentation duration from MPD root
  const mpd = doc.querySelector("MPD");
  const presentationDuration = parseDuration(mpd?.getAttribute("mediaPresentationDuration") ?? "");

  // Get top-level BaseURL if present
  const mpdBaseUrl = getBaseUrl(doc.documentElement, manifestUrl);

  // Find all Periods
  const periods = doc.querySelectorAll("Period");
  for (const period of periods) {
    const periodBaseUrl = getBaseUrl(period, mpdBaseUrl);

    // Find audio AdaptationSets
    const adaptationSets = period.querySelectorAll("AdaptationSet");
    for (const as of adaptationSets) {
      const contentType = as.getAttribute("contentType");
      const mimeType = as.getAttribute("mimeType");

      // Filter to audio AdaptationSets
      const isAudio =
        contentType === "audio" ||
        mimeType?.startsWith("audio/") ||
        as.querySelector("Representation[mimeType^='audio/']") !== null;
      if (!isAudio) continue;

      const asCodecs = as.getAttribute("codecs") ?? "";
      const asLang = as.getAttribute("lang") ?? "und";
      const asLabel = as.getAttribute("label") ?? "";
      const asBaseUrl = getBaseUrl(as, periodBaseUrl);

      // Check AudioChannelConfiguration at AdaptationSet level
      const asChannels = parseChannelConfig(as);

      // Get SegmentTemplate at AdaptationSet level (may be overridden per Representation)
      const asSegTemplate = as.querySelector(":scope > SegmentTemplate");

      const representations = as.querySelectorAll("Representation");
      for (const rep of representations) {
        const codec = rep.getAttribute("codecs") ?? asCodecs;

        // Only interested in EC-3 and AC-3
        if (!isEc3Codec(codec)) continue;

        // Check if browser supports this codec natively
        const mimeForCheck = rep.getAttribute("mimeType") ?? mimeType ?? "audio/mp4";
        if (isNativelySupported(mimeForCheck, codec)) continue;

        const repBaseUrl = getBaseUrl(rep, asBaseUrl);
        const bandwidth = parseInt(rep.getAttribute("bandwidth") ?? "0", 10);
        const sampleRate = parseInt(
          rep.getAttribute("audioSamplingRate") ?? as.getAttribute("audioSamplingRate") ?? "48000",
          10,
        );
        const channelCount = parseChannelConfig(rep) || asChannels || 6;
        const repId = rep.getAttribute("id") ?? `ec3_${tracks.length}`;

        // Get SegmentTemplate (Representation-level overrides AdaptationSet-level)
        const repSegTemplate = rep.querySelector(":scope > SegmentTemplate") ?? asSegTemplate;
        if (!repSegTemplate) continue;

        const segments = parseSegmentTemplate(repSegTemplate, repBaseUrl, repId, presentationDuration);
        if (!segments) continue;

        const label = buildLabel(asLabel, asLang, channelCount, codec);

        tracks.push({
          id: repId,
          codec,
          language: asLang,
          label,
          channelCount,
          bandwidth,
          sampleRate,
          segments,
        });
      }
    }
  }

  return tracks;
}

/**
 * Strip EC-3/AC-3 AdaptationSets from a DASH MPD XML string.
 * Returns the modified XML string for Shaka to load without EC-3 tracks.
 */
export function stripEc3FromManifest(manifestText: string): string {
  const doc = new DOMParser().parseFromString(manifestText, "text/xml");

  const adaptationSets = doc.querySelectorAll("AdaptationSet");
  for (const as of adaptationSets) {
    const codecs = as.getAttribute("codecs") ?? "";
    if (isEc3Codec(codecs)) {
      as.parentNode?.removeChild(as);
      continue;
    }
    // Check representations within the AdaptationSet
    const reps = as.querySelectorAll("Representation");
    let allEc3 = reps.length > 0;
    for (const rep of reps) {
      if (!isEc3Codec(rep.getAttribute("codecs") ?? "")) {
        allEc3 = false;
        break;
      }
    }
    if (allEc3 && reps.length > 0) {
      as.parentNode?.removeChild(as);
    }
  }

  return new XMLSerializer().serializeToString(doc);
}

/**
 * Resolve segment URLs for a given time range.
 */
export function resolveSegmentUrls(
  info: Ec3SegmentInfo,
  startTime: number,
  endTime: number,
): { url: string; startTime: number; duration: number }[] {
  const segments: { url: string; startTime: number; duration: number }[] = [];
  const pto = info.presentationTimeOffset;

  if (info.timeline) {
    // SegmentTimeline mode
    // Timeline @t values are in media time; presentation time = (t - PTO) / timescale
    let number = info.startNumber;
    for (const entry of info.timeline) {
      let t = entry.start;
      for (let r = 0; r <= entry.repeat; r++) {
        const segStart = (t - pto) / info.timescale;
        const segDur = entry.duration / info.timescale;
        const segEnd = segStart + segDur;

        if (segEnd > startTime && segStart < endTime) {
          const url = resolveTemplate(info.mediaTemplate, info.baseUrl, number, t);
          segments.push({ url, startTime: segStart, duration: segDur });
        }

        t += entry.duration;
        number++;

        if (segStart >= endTime) break;
      }
    }
  } else if (info.segmentDuration > 0) {
    // SegmentTemplate @duration mode
    // With PTO, first media time = pto, so segment i has media time = pto + i * duration
    const segDurSec = info.segmentDuration / info.timescale;
    const firstSeg = Math.max(0, Math.floor(startTime / segDurSec));
    const lastSeg = Math.ceil(endTime / segDurSec);

    for (let i = firstSeg; i < lastSeg; i++) {
      const number = info.startNumber + i;
      const mediaTime = pto + i * info.segmentDuration;
      const segStart = i * segDurSec; // Presentation time
      const url = resolveTemplate(info.mediaTemplate, info.baseUrl, number, mediaTime);
      segments.push({ url, startTime: segStart, duration: segDurSec });
    }
  }

  return segments;
}

// ── Internal helpers ──

function isEc3Codec(codec: string): boolean {
  const lower = codec.toLowerCase();
  return lower.startsWith("ec-3") || lower.startsWith("ac-3") || lower === "eac3" || lower === "ac3";
}

function isNativelySupported(mimeType: string, codec: string): boolean {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported) return false;
  return MediaSource.isTypeSupported(`${mimeType}; codecs="${codec}"`);
}

function parseChannelConfig(el: Element): number {
  const acc = el.querySelector("AudioChannelConfiguration");
  if (!acc) return 0;

  const value = acc.getAttribute("value") ?? "";
  const scheme = acc.getAttribute("schemeIdUri") ?? "";

  // MPEG-DASH scheme: value is a hex bitmask
  if (scheme.includes("23003-3")) {
    const bitmask = parseInt(value, 16);
    if (!isNaN(bitmask)) {
      // Count set bits (each bit = one channel presence)
      let count = 0;
      let n = bitmask;
      while (n) {
        count += n & 1;
        n >>= 1;
      }
      return count || parseInt(value, 10) || 0;
    }
  }

  // Simple numeric value
  const num = parseInt(value, 10);
  return isNaN(num) ? 0 : num;
}

function getBaseUrl(el: Element, parentBase: string): string {
  const baseUrlEl = el.querySelector(":scope > BaseURL");
  if (baseUrlEl?.textContent) {
    const base = baseUrlEl.textContent.trim();
    // If it's absolute, use it directly
    try {
      new URL(base);
      return base;
    } catch {
      // Relative — resolve against parent
      return new URL(base, parentBase).href;
    }
  }
  return parentBase;
}

function parseSegmentTemplate(
  el: Element,
  baseUrl: string,
  repId: string,
  presentationDuration: number,
): Ec3SegmentInfo | null {
  const mediaAttr = el.getAttribute("media");
  if (!mediaAttr) return null;

  const initAttr = el.getAttribute("initialization") ?? "";
  const timescale = parseInt(el.getAttribute("timescale") ?? "1", 10);
  const duration = parseInt(el.getAttribute("duration") ?? "0", 10);
  const startNumber = parseInt(el.getAttribute("startNumber") ?? "1", 10);
  const pto = parseInt(el.getAttribute("presentationTimeOffset") ?? "0", 10);

  // Replace $RepresentationID$ in templates
  const mediaTemplate = mediaAttr.replace(/\$RepresentationID\$/g, repId);
  const initTemplate = initAttr.replace(/\$RepresentationID\$/g, repId);

  // Resolve init URL
  const initUrl = initTemplate
    ? resolveTemplate(initTemplate, baseUrl, 0, 0)
    : "";

  // Parse SegmentTimeline if present
  const timelineEl = el.querySelector("SegmentTimeline");
  let timeline: TimelineEntry[] | null = null;

  if (timelineEl) {
    timeline = [];
    const sElements = timelineEl.querySelectorAll("S");
    let currentTime = 0;
    for (const s of sElements) {
      const t = parseInt(s.getAttribute("t") ?? "", 10);
      const d = parseInt(s.getAttribute("d") ?? "0", 10);
      const r = parseInt(s.getAttribute("r") ?? "0", 10);

      if (!isNaN(t)) currentTime = t;

      timeline.push({
        start: currentTime,
        duration: d,
        repeat: r,
      });

      currentTime += d * (r + 1);
    }
  }

  return {
    initUrl,
    timescale,
    segmentDuration: duration,
    startNumber,
    mediaTemplate,
    baseUrl,
    timeline,
    presentationDuration,
    presentationTimeOffset: pto,
  };
}

function resolveTemplate(template: string, baseUrl: string, number: number, time: number): string {
  const url = template
    .replace(/\$Number(?:%(\d+)d)?\$/g, (_match, pad) => {
      const padLen = pad ? parseInt(pad, 10) : 0;
      return number.toString().padStart(padLen, "0");
    })
    .replace(/\$Time\$/g, time.toString());

  // Resolve relative URL against base
  try {
    new URL(url);
    return url; // Already absolute
  } catch {
    return new URL(url, baseUrl).href;
  }
}

/**
 * Parse ISO 8601 duration (e.g., "PT1H23M45.678S") to seconds.
 */
function parseDuration(iso: string): number {
  if (!iso) return 0;
  const match = iso.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return 0;
  const hours = parseFloat(match[1] ?? "0");
  const minutes = parseFloat(match[2] ?? "0");
  const seconds = parseFloat(match[3] ?? "0");
  return hours * 3600 + minutes * 60 + seconds;
}

function buildLabel(label: string, lang: string, channels: number, codec: string): string {
  const parts: string[] = [];

  // Language display name
  if (lang && lang !== "und") {
    try {
      const name = new Intl.DisplayNames([navigator.language], { type: "language" }).of(lang);
      if (name) parts.push(name);
    } catch {
      parts.push(lang);
    }
  } else if (label) {
    parts.push(label);
  }

  // Channel layout
  if (channels === 6) parts.push("5.1");
  else if (channels === 8) parts.push("7.1");
  else if (channels === 2) parts.push("2.0");
  else parts.push(`${channels}ch`);

  // Codec
  parts.push(codec.toUpperCase());
  parts.push("(SW)");

  return parts.join(" · ");
}
