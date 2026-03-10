import type { ValidationIssue } from "./types";

// --- Parsed MPD types ---

interface MpdRepresentation {
  id?: string;
  mimeType?: string;
  codecs?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: string;
}

interface MpdAdaptationSet {
  contentType?: string;
  mimeType?: string;
  codecs?: string;
  frameRate?: string;
  representations: MpdRepresentation[];
}

interface MpdPeriod {
  adaptationSets: MpdAdaptationSet[];
}

export interface ParsedMpd {
  namespace?: string;
  profiles?: string;
  type?: string;
  minBufferTime?: string;
  availabilityStartTime?: string;
  periods: MpdPeriod[];
}

// --- Parsing ---

/** Match direct children by localName — works in both HTML and XML namespace modes. */
function childrenByLocalName(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((el) => el.localName === name);
}

export function parseMpd(xml: string): ParsedMpd {
  const doc = new DOMParser().parseFromString(xml, "text/xml");

  // Check for parse error
  if (doc.querySelector("parsererror")) {
    return { periods: [] };
  }

  const mpdEl = doc.documentElement;

  const result: ParsedMpd = {
    namespace: mpdEl.namespaceURI ?? undefined,
    profiles: mpdEl.getAttribute("profiles") ?? undefined,
    type: mpdEl.getAttribute("type") ?? undefined,
    minBufferTime: mpdEl.getAttribute("minBufferTime") ?? undefined,
    availabilityStartTime: mpdEl.getAttribute("availabilityStartTime") ?? undefined,
    periods: [],
  };

  const periodEls = childrenByLocalName(mpdEl, "Period");
  for (const periodEl of periodEls) {
    const period: MpdPeriod = { adaptationSets: [] };

    const asEls = childrenByLocalName(periodEl, "AdaptationSet");
    for (const asEl of asEls) {
      const as: MpdAdaptationSet = {
        contentType: asEl.getAttribute("contentType") ?? undefined,
        mimeType: asEl.getAttribute("mimeType") ?? undefined,
        codecs: asEl.getAttribute("codecs") ?? undefined,
        frameRate: asEl.getAttribute("frameRate") ?? undefined,
        representations: [],
      };

      const repEls = childrenByLocalName(asEl, "Representation");
      for (const repEl of repEls) {
        const rep: MpdRepresentation = {
          id: repEl.getAttribute("id") ?? undefined,
          mimeType: repEl.getAttribute("mimeType") ?? undefined,
          codecs: repEl.getAttribute("codecs") ?? undefined,
          bandwidth: repEl.hasAttribute("bandwidth")
            ? Number(repEl.getAttribute("bandwidth"))
            : undefined,
          width: repEl.hasAttribute("width")
            ? Number(repEl.getAttribute("width"))
            : undefined,
          height: repEl.hasAttribute("height")
            ? Number(repEl.getAttribute("height"))
            : undefined,
          frameRate: repEl.getAttribute("frameRate") ?? undefined,
        };
        as.representations.push(rep);
      }

      period.adaptationSets.push(as);
    }

    result.periods.push(period);
  }

  return result;
}

// --- Frame rate helpers ---

export function normalizeFrameRate(fr: string): number {
  if (!fr || fr.trim() === "") return NaN;
  const parts = fr.trim().split("/");
  if (parts.length === 1) {
    return Number(parts[0]);
  }
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (den === 0) return NaN;
    return num / den;
  }
  return NaN;
}

function frameRatesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

// --- Helpers ---

function resolvedMimeType(as: MpdAdaptationSet, rep: MpdRepresentation): string | undefined {
  return rep.mimeType ?? as.mimeType;
}

function resolvedCodecs(as: MpdAdaptationSet, rep: MpdRepresentation): string | undefined {
  return rep.codecs ?? as.codecs;
}

function resolvedFrameRate(as: MpdAdaptationSet, rep: MpdRepresentation): string | undefined {
  return rep.frameRate ?? as.frameRate;
}

function inferContentType(as: MpdAdaptationSet): string | undefined {
  if (as.contentType) return as.contentType;
  const mime = as.mimeType ?? as.representations[0]?.mimeType;
  if (mime) {
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("text/") || mime === "application/ttml+xml") return "text";
  }
  return undefined;
}

function repLabel(rep: MpdRepresentation): string {
  if (rep.width && rep.height) return `${rep.width}x${rep.height}`;
  if (rep.id) return `id=${rep.id}`;
  if (rep.bandwidth) return `${rep.bandwidth}bps`;
  return "unknown";
}

// --- Validation ---

export function validateDash(mpd: ParsedMpd): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // DASH-001: MPD namespace
  if (mpd.namespace && !mpd.namespace.includes("urn:mpeg:dash:schema:mpd:2011")) {
    issues.push({
      id: "DASH-001",
      severity: "warning",
      category: "Manifest Structure",
      message: "MPD namespace does not include urn:mpeg:dash:schema:mpd:2011",
      detail: `Found namespace: ${mpd.namespace}`,
    });
  }

  // DASH-002: @profiles present
  if (!mpd.profiles) {
    issues.push({
      id: "DASH-002",
      severity: "warning",
      category: "Manifest Structure",
      message: "MPD missing @profiles attribute",
    });
  }

  // DASH-003: @minBufferTime present
  if (!mpd.minBufferTime) {
    issues.push({
      id: "DASH-003",
      severity: "warning",
      category: "Manifest Structure",
      message: "MPD missing @minBufferTime attribute",
    });
  }

  // DASH-004: @type is "static" or "dynamic"
  if (mpd.type && mpd.type !== "static" && mpd.type !== "dynamic") {
    issues.push({
      id: "DASH-004",
      severity: "info",
      category: "Manifest Structure",
      message: `MPD @type is "${mpd.type}" (expected "static" or "dynamic")`,
    });
  }

  // DASH-005: Dynamic MPD has @availabilityStartTime
  if (mpd.type === "dynamic" && !mpd.availabilityStartTime) {
    issues.push({
      id: "DASH-005",
      severity: "warning",
      category: "Manifest Structure",
      message: "Dynamic MPD missing @availabilityStartTime",
    });
  }

  // Per-Period, per-AdaptationSet, per-Representation checks
  for (let pi = 0; pi < mpd.periods.length; pi++) {
    const period = mpd.periods[pi];
    for (let ai = 0; ai < period.adaptationSets.length; ai++) {
      const as = period.adaptationSets[ai];
      const location = `Period[${pi}] > AdaptationSet[${ai}]`;
      const contentType = inferContentType(as);

      // DASH-102: AdaptationSet or Representation has @mimeType
      const hasMime = !!as.mimeType || as.representations.some((r) => !!r.mimeType);
      if (!hasMime) {
        issues.push({
          id: "DASH-102",
          severity: "warning",
          category: "Manifest Structure",
          message: "No @mimeType on AdaptationSet or its Representations",
          location,
        });
      }

      for (let ri = 0; ri < as.representations.length; ri++) {
        const rep = as.representations[ri];
        const repLoc = `${location} > Representation[${ri}]`;

        // DASH-103: Representation has @codecs
        if (!resolvedCodecs(as, rep)) {
          issues.push({
            id: "DASH-103",
            severity: "warning",
            category: "Manifest Structure",
            message: "Representation missing @codecs",
            location: repLoc,
          });
        }

        // DASH-104: Representation has @id
        if (!rep.id) {
          issues.push({
            id: "DASH-104",
            severity: "info",
            category: "Manifest Structure",
            message: "Representation missing @id",
            location: repLoc,
          });
        }

        // DASH-105: Representation has @bandwidth
        if (rep.bandwidth === undefined) {
          issues.push({
            id: "DASH-105",
            severity: "warning",
            category: "Manifest Structure",
            message: "Representation missing @bandwidth",
            location: repLoc,
          });
        }

        // DASH-106: Video Representation has @width/@height
        const repMime = resolvedMimeType(as, rep);
        const isVideo = contentType === "video" || repMime?.startsWith("video/");
        if (isVideo && (rep.width === undefined || rep.height === undefined)) {
          issues.push({
            id: "DASH-106",
            severity: "warning",
            category: "Manifest Structure",
            message: "Video Representation missing @width/@height",
            location: repLoc,
          });
        }
      }

      // DASH-112 & DASH-113: Frame rate checks (video AdaptationSets only)
      if (contentType === "video") {
        const frameRates: { fr: string; normalized: number; reps: MpdRepresentation[] }[] = [];
        let repsWithFR = 0;
        let repsWithoutFR = 0;

        for (const rep of as.representations) {
          const fr = resolvedFrameRate(as, rep);
          if (fr) {
            repsWithFR++;
            const normalized = normalizeFrameRate(fr);
            const existing = frameRates.find(
              (g) => !isNaN(g.normalized) && !isNaN(normalized) && frameRatesEqual(g.normalized, normalized),
            );
            if (existing) {
              existing.reps.push(rep);
            } else {
              frameRates.push({ fr, normalized, reps: [rep] });
            }
          } else {
            repsWithoutFR++;
          }
        }

        // DASH-112: Mixed frame rates in one AdaptationSet
        if (frameRates.length > 1) {
          const groupDescs = frameRates
            .map((g) => `${g.fr} (${g.reps.map(repLabel).join(", ")})`)
            .join("; ");
          issues.push({
            id: "DASH-112",
            severity: "error",
            category: "Manifest Structure",
            message: "Mixed frame rates in video AdaptationSet",
            detail: `Frame rate groups: ${groupDescs}. Mixing frame rates in a single AdaptationSet causes A/V desync during ABR switches due to CTO differences.`,
            location,
            specRef: "DASH-IF IOP \u00a73.2.4",
          });
        }

        // DASH-113: Some but not all reps have @frameRate
        if (repsWithFR > 0 && repsWithoutFR > 0) {
          issues.push({
            id: "DASH-113",
            severity: "warning",
            category: "Manifest Structure",
            message: `${repsWithoutFR} of ${as.representations.length} Representations missing @frameRate`,
            location,
          });
        }
      }
    }
  }

  return issues;
}
