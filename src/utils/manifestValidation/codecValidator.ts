/**
 * Codec string validation — cross-reference manifest codec declarations
 * against actual init segment sample entry box types.
 */

import type { ValidationIssue } from "./types";

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

interface CodecStreamInfo {
  label: string;
  type: "video" | "audio";
  codecs: string;
  encrypted: boolean;
  manifestType: string;
  initSegmentUrl: string | null;
}

/**
 * Validate codec strings against init segment sample entries.
 */
export async function validateCodecs(
  streams: CodecStreamInfo[],
  fetchFn: (url: string) => Promise<ArrayBuffer>,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const MP4Box = await getMp4box();

  // Deduplicate by init URL
  const byUrl = new Map<string, CodecStreamInfo[]>();
  for (const s of streams) {
    if (!s.initSegmentUrl) continue;
    const list = byUrl.get(s.initSegmentUrl) ?? [];
    list.push(s);
    byUrl.set(s.initSegmentUrl, list);
  }

  for (const [url, streamsForUrl] of byUrl) {
    let data: ArrayBuffer;
    try {
      data = await fetchFn(url);
    } catch {
      continue; // BMFF validator already reports fetch failures
    }

    let mp4: Mp4boxFile;
    try {
      mp4 = MP4Box.createFile();
      const buf = data.slice(0) as ArrayBuffer & { fileStart: number };
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
      mp4.flush();
    } catch {
      continue; // BMFF validator already reports parse failures
    }

    if (!mp4.moov?.traks) continue;

    for (const trak of mp4.moov.traks) {
      const trackId = trak.tkhd?.track_id;
      if (!trackId) continue;

      const stream = streamsForUrl.find((s) => {
        // Try matching by Shaka's stream id — may not align with mp4box track id
        // Fall back to first stream of matching type
        const tkhdType = trak.mdia?.hdlr?.handler_type;
        if (tkhdType === "vide" && s.type === "video") return true;
        if (tkhdType === "soun" && s.type === "audio") return true;
        return false;
      }) ?? streamsForUrl[0];
      if (!stream) continue;

      const entries = trak.mdia?.minf?.stbl?.stsd?.entries;
      if (!entries || entries.length === 0) continue;

      const entry = entries[0];
      const sampleType: string = entry.type ?? "";

      // CS-003: Codec string in manifest matches sample entry box type
      if (stream.codecs && sampleType) {
        const codecBase = stream.codecs.split(".")[0].toLowerCase();
        const sampleBase = sampleType.toLowerCase();

        // Encrypted content uses encv/enca wrappers
        if (sampleBase === "encv" || sampleBase === "enca") {
          // CS-007: encrypted content should have sinf box
          const sinf = entry.sinf ?? entry.sinfs?.[0];
          if (!sinf) {
            issues.push({
              id: "CS-007",
              severity: "error",
              category: "Codec & Tags",
              message: `Encrypted sample entry "${sampleType}" missing sinf box`,
              detail: stream.label,
              specRef: "ISO 14496-12",
            });
          } else {
            // Check the original format inside sinf.frma
            const originalFormat = sinf.frma?.data_format ?? sinf.original_format?.data_format;
            if (originalFormat) {
              checkCodecMatch(issues, stream, originalFormat.toLowerCase(), codecBase);
            }
          }
        } else {
          checkCodecMatch(issues, stream, sampleBase, codecBase);
        }
      }

      // CS-001: hvc1 vs hev1 for HLS
      if (stream.manifestType === "HLS" && stream.type === "video") {
        const codecBase = stream.codecs.split(".")[0].toLowerCase();
        if (codecBase === "hev1") {
          issues.push({
            id: "CS-001",
            severity: "error",
            category: "Codec & Tags",
            message: `HLS uses "hev1" codec — Apple requires "hvc1"`,
            detail: `${stream.label}: codec="${stream.codecs}". Safari rejects hev1. Use hvc1 (parameter sets in sample entry, not in-band).`,
            specRef: "Apple HLS Authoring Spec §1.10",
          });
        }
      }
    }
  }

  return issues;
}

function checkCodecMatch(
  issues: ValidationIssue[],
  stream: CodecStreamInfo,
  sampleType: string,
  codecBase: string,
): void {
  // Common equivalent pairs
  const equivalents: Record<string, string[]> = {
    avc1: ["avc1", "avc3"],
    avc3: ["avc1", "avc3"],
    hvc1: ["hvc1", "hev1"],
    hev1: ["hvc1", "hev1"],
    mp4a: ["mp4a"],
    ac_3: ["ac-3", "ac_3"],
    ec_3: ["ec-3", "ec_3"],
    av01: ["av01"],
    vp09: ["vp09"],
    opus: ["opus"],
    flac: ["flac"],
  };

  const codecEquivs = equivalents[codecBase] ?? [codecBase];
  const matches = codecEquivs.some((eq) => eq === sampleType);

  if (!matches) {
    issues.push({
      id: "CS-003",
      severity: "error",
      category: "Codec & Tags",
      message: `Codec mismatch: manifest="${codecBase}", init segment="${sampleType}"`,
      detail: `${stream.label}: manifest codecs="${stream.codecs}"`,
      specRef: "DASH-IF IOP / RFC 8216",
    });
  }
}
