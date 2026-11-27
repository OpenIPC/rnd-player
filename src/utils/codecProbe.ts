/**
 * Codec probe for CONTENT_UNSUPPORTED_BY_BROWSER (Shaka 4032).
 *
 * Shaka drops every variant whose mimeType/codecs the browser rejects and
 * then fails with a bare 4032 that carries no data. This module re-reads the
 * raw manifest, checks each declared codec string against
 * MediaSource.isTypeSupported(), and flags malformed codec strings (e.g. AV1
 * "av01.0.08M.0", whose bit-depth field must be two digits).
 */

export type TypeSupportFn = (type: string) => boolean;

export interface DeclaredCodec {
  mimeType: string;
  codecs: string;
  /** Where it came from, e.g. "Representation 1" or "EXT-X-STREAM-INF #2" */
  source: string;
}

export interface CodecProbeResult extends DeclaredCodec {
  supported: boolean;
  /** Why the string looks malformed, if it does */
  malformed?: string;
  /** Corrected codec string, when one can be derived */
  suggestion?: string;
  suggestionSupported?: boolean;
}

const AUDIO_CODEC_RE = /^(mp4a|ac-3|ec-3|ac-4|opus|flac|fLaC|alac|dtsc|dtse|dtsh|dtsl|mhm1|mha1)/i;
const TEXT_CODEC_RE = /^(wvtt|stpp|tx3g|c608|c708)/i;

function isMediaMime(mime: string): boolean {
  return mime.startsWith("video/") || mime.startsWith("audio/");
}

/** Extract mimeType/codecs pairs from a DASH MPD. */
function extractDashCodecs(text: string): DeclaredCodec[] {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return [];
  const out: DeclaredCodec[] = [];
  const sets = Array.from(doc.getElementsByTagNameNS("*", "AdaptationSet"));
  sets.forEach((set, setIdx) => {
    const reps = Array.from(set.getElementsByTagNameNS("*", "Representation"));
    reps.forEach((rep, repIdx) => {
      const mimeType = rep.getAttribute("mimeType") ?? set.getAttribute("mimeType") ?? "";
      const codecs = rep.getAttribute("codecs") ?? set.getAttribute("codecs") ?? "";
      if (!isMediaMime(mimeType)) return;
      const id = rep.getAttribute("id");
      out.push({
        mimeType,
        codecs,
        source: id != null ? `Representation ${id}` : `AdaptationSet ${setIdx + 1} / Representation ${repIdx + 1}`,
      });
    });
  });
  return out;
}

/** Extract codecs from HLS multivariant EXT-X-STREAM-INF CODECS attributes. */
function extractHlsCodecs(text: string): DeclaredCodec[] {
  const out: DeclaredCodec[] = [];
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    n++;
    const m = /CODECS="([^"]*)"/.exec(line);
    if (!m) continue;
    for (const raw of m[1].split(",")) {
      const codec = raw.trim();
      if (!codec || TEXT_CODEC_RE.test(codec)) continue;
      out.push({
        mimeType: AUDIO_CODEC_RE.test(codec) ? "audio/mp4" : "video/mp4",
        codecs: codec,
        source: `EXT-X-STREAM-INF #${n}`,
      });
    }
  }
  return out;
}

/** Extract declared media codecs from a raw DASH or HLS manifest. */
export function extractDeclaredCodecs(manifest: string): DeclaredCodec[] {
  const head = manifest.trimStart();
  if (head.startsWith("#EXTM3U")) return extractHlsCodecs(manifest);
  if (/<MPD[\s>]/.test(manifest)) return extractDashCodecs(manifest);
  return [];
}

/**
 * Detect common codec-string syntax errors. Returns a reason and, where
 * possible, a corrected string.
 */
export function checkCodecSyntax(codec: string): { reason: string; suggestion?: string } | null {
  if (codec === "") return { reason: "codecs attribute is missing or empty" };

  // AV1: av01.P.LLT.DD[.M.CCC.TCC.MCC.F]
  if (/^av01\./.test(codec)) {
    if (/^av01\.[0-2]\.\d{2}[MH]\.(08|10|12)(\.|$)/.test(codec)) return null;
    const m = /^av01\.([0-2])\.(\d{1,2})([MH])\.(\d{1,2})(\..*)?$/.exec(codec);
    if (m) {
      const [, profile, level, tier, depth, rest = ""] = m;
      const fixed = `av01.${profile}.${level.padStart(2, "0")}${tier}.${depth.padStart(2, "0")}${rest}`;
      if (["08", "10", "12"].includes(depth.padStart(2, "0"))) {
        return { reason: "AV1 level and bit depth must be two digits (av01.P.LLT.DD)", suggestion: fixed };
      }
      if (depth === "0") {
        // Bit depth "0" is the most common packager bug: "08" truncated.
        return {
          reason: "AV1 bit depth must be two digits: 08, 10 or 12 (av01.P.LLT.DD)",
          suggestion: `av01.${profile}.${level.padStart(2, "0")}${tier}.08${rest}`,
        };
      }
    }
    return { reason: "AV1 codec string does not match av01.P.LLT.DD" };
  }

  // H.264: avc1/avc3 + 6 hex digits (profile, constraints, level)
  if (/^avc[13]\b/.test(codec) && !/^avc[13]\.[0-9A-Fa-f]{6}$/.test(codec)) {
    return { reason: "H.264 codec string must be avc1.PPCCLL (6 hex digits)" };
  }

  return null;
}

/** Probe every declared codec against the browser's MSE support. */
export function probeCodecs(declared: DeclaredCodec[], isTypeSupported: TypeSupportFn): CodecProbeResult[] {
  const seen = new Set<string>();
  const results: CodecProbeResult[] = [];
  for (const d of declared) {
    const key = `${d.mimeType}|${d.codecs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const type = d.codecs ? `${d.mimeType}; codecs="${d.codecs}"` : d.mimeType;
    const result: CodecProbeResult = { ...d, supported: safeSupported(isTypeSupported, type) };
    const syntax = checkCodecSyntax(d.codecs);
    if (syntax) {
      result.malformed = syntax.reason;
      if (syntax.suggestion) {
        result.suggestion = syntax.suggestion;
        result.suggestionSupported = safeSupported(
          isTypeSupported,
          `${d.mimeType}; codecs="${syntax.suggestion}"`,
        );
      }
    }
    results.push(result);
  }
  return results;
}

function safeSupported(fn: TypeSupportFn, type: string): boolean {
  try {
    return fn(type);
  } catch {
    return false;
  }
}

/** Human-readable diagnosis built from probe results. */
export function describeCodecProbe(results: CodecProbeResult[]): { summary?: string; details: string[] } {
  if (results.length === 0) return { details: [] };

  const details = ["Codec probe (MediaSource.isTypeSupported):"];
  for (const r of results) {
    const type = `${r.mimeType}; codecs="${r.codecs}"`;
    let line = `${r.supported ? "✓ supported" : "✗ rejected"}: ${type} (${r.source})`;
    if (r.malformed) {
      line += ` — malformed: ${r.malformed}`;
      if (r.suggestion) {
        line += `; expected "${r.suggestion}"` +
          (r.suggestionSupported ? " (supported by this browser)" : " (also not supported by this browser)");
      }
    }
    details.push(line);
  }

  const rejected = results.filter((r) => !r.supported);
  const malformed = rejected.find((r) => r.malformed);
  let summary: string | undefined;
  if (malformed) {
    summary = `No playable streams: malformed codec string "${malformed.codecs}" in manifest`;
  } else if (rejected.length > 0) {
    const list = [...new Set(rejected.map((r) => r.codecs || r.mimeType))].join(", ");
    summary = `No playable streams: ${list} not supported by this browser`;
  }
  return { summary, details };
}

/** Default type-support check: MediaSource (or ManagedMediaSource on iOS). */
export function defaultTypeSupport(): TypeSupportFn | undefined {
  const g = globalThis as unknown as {
    MediaSource?: { isTypeSupported(t: string): boolean };
    ManagedMediaSource?: { isTypeSupported(t: string): boolean };
  };
  const ms = g.MediaSource ?? g.ManagedMediaSource;
  return ms ? (t) => ms.isTypeSupported(t) : undefined;
}
