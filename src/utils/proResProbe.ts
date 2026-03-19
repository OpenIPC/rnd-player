/**
 * Probe a MOV URL via HTTP Range requests to detect ProRes tracks.
 *
 * Parses the moov atom directly (no mp4box.js dependency) to extract:
 *   - Track codec, dimensions, timescale, frame count
 *   - Sample table (stsz sizes, stco/co64 offsets, stsc chunk mapping, stts durations)
 *
 * Pipeline:
 *   1. HEAD → confirm Accept-Ranges, get Content-Length
 *   2. Range-fetch first 64 KB → scan for ftyp + moov
 *   3. If moov not at start, Range-fetch last 64 KB → scan for moov
 *   4. If moov extends beyond fetched range, Range-fetch the full moov
 *   5. Parse moov → trak → stbl → extract sample table
 */

import type { ProResTrackInfo, ProResFourCC, SampleTableEntry } from "../types/proResWorker.types";

const PROBE_CHUNK = 64 * 1024;

const PRORES_FOURCCS = new Set<string>(["apch", "apcn", "apcs", "apco", "ap4h", "ap4x"]);

const FOURCC_NAMES: Record<string, string> = {
  apch: "ProRes 422 HQ",
  apcn: "ProRes 422",
  apcs: "ProRes 422 LT",
  apco: "ProRes 422 Proxy",
  ap4h: "ProRes 4444",
  ap4x: "ProRes 4444 XQ",
};

/** Container box types that should be recursed into. */
const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "udta", "edts"]);

export function isMovUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".mov");
  } catch {
    return false;
  }
}

export interface ProbeResult {
  tracks: ProResTrackInfo[];
  fileSize: number;
}

// ── Top-level box scanner ──

interface BoxLocation {
  offset: number; // absolute file offset
  size: number;
}

function scanTopLevelBoxes(
  buf: ArrayBuffer,
  fileOffset: number,
): Map<string, BoxLocation> {
  const view = new DataView(buf);
  const boxes = new Map<string, BoxLocation>();
  let pos = 0;

  while (pos + 8 <= buf.byteLength) {
    let boxSize = view.getUint32(pos);
    const boxType = readFourCC(view, pos + 4);

    if (boxSize === 1 && pos + 16 <= buf.byteLength) {
      const hi = view.getUint32(pos + 8);
      const lo = view.getUint32(pos + 12);
      boxSize = hi * 0x100000000 + lo;
    }
    if (boxSize < 8) break;

    boxes.set(boxType, { offset: fileOffset + pos, size: boxSize });
    pos += boxSize;
    if (pos > buf.byteLength) break;
  }

  return boxes;
}

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Search a buffer for a box with a specific FourCC by scanning for the
 * type signature. Used when the buffer starts mid-box (e.g. end-of-file
 * chunk that begins inside mdat).
 *
 * For each candidate, validates that the box size is sane (>= 8 and the
 * box would fit within the remaining file).
 */
function searchForBox(
  buf: ArrayBuffer,
  type: string,
  fileOffset: number,
  fileSize: number,
): BoxLocation | null {
  const view = new DataView(buf);
  const target = [
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ];

  // Scan every 4-byte aligned position looking for the FourCC at offset+4
  // (box layout: [4 bytes size][4 bytes type][payload...])
  for (let pos = 0; pos + 8 <= buf.byteLength; pos++) {
    if (
      view.getUint8(pos + 4) === target[0] &&
      view.getUint8(pos + 5) === target[1] &&
      view.getUint8(pos + 6) === target[2] &&
      view.getUint8(pos + 7) === target[3]
    ) {
      let boxSize = view.getUint32(pos);
      if (boxSize === 1 && pos + 16 <= buf.byteLength) {
        const hi = view.getUint32(pos + 8);
        const lo = view.getUint32(pos + 12);
        boxSize = hi * 0x100000000 + lo;
      }
      const absOffset = fileOffset + pos;
      // Validate: size >= 8, and box fits within the file
      if (boxSize >= 8 && absOffset + boxSize <= fileSize) {
        return { offset: absOffset, size: boxSize };
      }
    }
  }
  return null;
}

// ── Moov parser ──

interface ParsedBox {
  type: string;
  offset: number; // offset within the moov buffer
  size: number;
  children?: ParsedBox[];
}

function parseBoxTree(buf: ArrayBuffer, start: number, end: number): ParsedBox[] {
  const view = new DataView(buf);
  const boxes: ParsedBox[] = [];
  let pos = start;

  while (pos + 8 <= end) {
    let boxSize = view.getUint32(pos);
    const boxType = readFourCC(view, pos + 4);
    let headerSize = 8;

    if (boxSize === 1 && pos + 16 <= end) {
      const hi = view.getUint32(pos + 8);
      const lo = view.getUint32(pos + 12);
      boxSize = hi * 0x100000000 + lo;
      headerSize = 16;
    }
    if (boxSize < 8) break;

    const box: ParsedBox = { type: boxType, offset: pos, size: boxSize };

    if (CONTAINER_BOXES.has(boxType)) {
      box.children = parseBoxTree(buf, pos + headerSize, pos + boxSize);
    }

    boxes.push(box);
    pos += boxSize;
  }

  return boxes;
}

function findAllTracks(boxes: ParsedBox[]): ParsedBox[] {
  const traks: ParsedBox[] = [];
  for (const b of boxes) {
    if (b.type === "trak") traks.push(b);
    if (b.children) traks.push(...findAllTracks(b.children));
  }
  return traks;
}

interface StblData {
  codecFourCC: string;
  width: number;
  height: number;
  sampleSizes: number[];
  chunkOffsets: number[];
  samplesPerChunk: { firstChunk: number; samplesPerChunk: number }[];
  sampleDurations: { count: number; delta: number }[];
  timescale: number;
}

function parseTrack(buf: ArrayBuffer, trak: ParsedBox): StblData | null {
  const view = new DataView(buf);
  const children = trak.children ?? [];

  // Find mdhd for timescale
  const mdia = children.find((b) => b.type === "mdia");
  if (!mdia?.children) return null;

  const mdhd = mdia.children.find((b) => b.type === "mdhd");
  let timescale = 0;
  if (mdhd) {
    const mdhdData = mdhd.offset + 8;
    const version = view.getUint8(mdhdData);
    if (version === 0) {
      timescale = view.getUint32(mdhdData + 4 + 8); // skip version(1)+flags(3)+creation(4)+modification(4)
    } else {
      timescale = view.getUint32(mdhdData + 4 + 16); // v1: creation(8)+modification(8)
    }
  }

  // Find stbl
  const minf = mdia.children.find((b) => b.type === "minf");
  if (!minf?.children) return null;

  const stbl = minf.children.find((b) => b.type === "stbl");
  if (!stbl?.children) return null;

  // Parse stsd — sample description (codec FourCC + dimensions)
  const stsd = stbl.children.find((b) => b.type === "stsd");
  if (!stsd) return null;

  const stsdData = stsd.offset + 8; // box header
  // fullbox: version(1) + flags(3) + entry_count(4) = 8 bytes
  const entryStart = stsdData + 8;
  if (entryStart + 40 > buf.byteLength) return null;

  const codecFourCC = readFourCC(view, entryStart + 4);
  // Video sample entry layout: size(4) + fourcc(4) + reserved(6) + data_ref_idx(2) + reserved(16) + width(2) + height(2)
  const width = view.getUint16(entryStart + 32);
  const height = view.getUint16(entryStart + 34);

  // Parse stsz — sample sizes
  const stsz = stbl.children.find((b) => b.type === "stsz");
  const sampleSizes: number[] = [];
  if (stsz) {
    const d = stsz.offset + 8; // box header
    // fullbox: version(1)+flags(3) = 4, then sample_size(4) + sample_count(4)
    const uniformSize = view.getUint32(d + 4);
    const sampleCount = view.getUint32(d + 8);
    if (uniformSize === 0) {
      for (let i = 0; i < sampleCount; i++) {
        sampleSizes.push(view.getUint32(d + 12 + i * 4));
      }
    } else {
      for (let i = 0; i < sampleCount; i++) {
        sampleSizes.push(uniformSize);
      }
    }
  }

  // Parse stco / co64 — chunk offsets
  const stco = stbl.children.find((b) => b.type === "stco");
  const co64 = stbl.children.find((b) => b.type === "co64");
  const chunkOffsets: number[] = [];

  if (stco) {
    const d = stco.offset + 8;
    const count = view.getUint32(d + 4);
    for (let i = 0; i < count; i++) {
      chunkOffsets.push(view.getUint32(d + 8 + i * 4));
    }
  } else if (co64) {
    const d = co64.offset + 8;
    const count = view.getUint32(d + 4);
    for (let i = 0; i < count; i++) {
      const hi = view.getUint32(d + 8 + i * 8);
      const lo = view.getUint32(d + 8 + i * 8 + 4);
      chunkOffsets.push(hi * 0x100000000 + lo);
    }
  }

  // Parse stsc — sample-to-chunk mapping
  const stsc = stbl.children.find((b) => b.type === "stsc");
  const samplesPerChunk: { firstChunk: number; samplesPerChunk: number }[] = [];
  if (stsc) {
    const d = stsc.offset + 8;
    const count = view.getUint32(d + 4);
    for (let i = 0; i < count; i++) {
      const firstChunk = view.getUint32(d + 8 + i * 12);
      const spc = view.getUint32(d + 8 + i * 12 + 4);
      // skip sample_description_index (4 bytes)
      samplesPerChunk.push({ firstChunk, samplesPerChunk: spc });
    }
  }

  // Parse stts — time-to-sample (durations)
  const stts = stbl.children.find((b) => b.type === "stts");
  const sampleDurations: { count: number; delta: number }[] = [];
  if (stts) {
    const d = stts.offset + 8;
    const count = view.getUint32(d + 4);
    for (let i = 0; i < count; i++) {
      sampleDurations.push({
        count: view.getUint32(d + 8 + i * 8),
        delta: view.getUint32(d + 8 + i * 8 + 4),
      });
    }
  }

  return {
    codecFourCC,
    width,
    height,
    sampleSizes,
    chunkOffsets,
    samplesPerChunk,
    sampleDurations,
    timescale,
  };
}

/**
 * Build the flat sample table (offset + size for every sample) from
 * stco/co64 + stsc + stsz.
 */
function buildSampleTable(data: StblData): SampleTableEntry[] {
  const { sampleSizes, chunkOffsets, samplesPerChunk, sampleDurations } = data;
  if (sampleSizes.length === 0 || chunkOffsets.length === 0) return [];

  // Build per-sample durations
  const durations: number[] = [];
  for (const entry of sampleDurations) {
    for (let i = 0; i < entry.count; i++) {
      durations.push(entry.delta);
    }
  }

  // Expand stsc: for each chunk, determine how many samples it contains
  const table: SampleTableEntry[] = [];
  let sampleIdx = 0;

  for (let chunkIdx = 0; chunkIdx < chunkOffsets.length; chunkIdx++) {
    // Find the stsc entry for this chunk (1-based chunk numbering in stsc)
    const chunkNum = chunkIdx + 1;
    let spc = 1; // default samples-per-chunk
    for (let i = samplesPerChunk.length - 1; i >= 0; i--) {
      if (chunkNum >= samplesPerChunk[i].firstChunk) {
        spc = samplesPerChunk[i].samplesPerChunk;
        break;
      }
    }

    let offset = chunkOffsets[chunkIdx];
    for (let s = 0; s < spc && sampleIdx < sampleSizes.length; s++) {
      table.push({
        offset,
        size: sampleSizes[sampleIdx],
        duration: durations[sampleIdx] ?? durations[durations.length - 1] ?? 1,
      });
      offset += sampleSizes[sampleIdx];
      sampleIdx++;
    }
  }

  return table;
}

// ── Public API ──

export async function probeMovUrl(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<ProbeResult> {
  // 1. Probe via Range request for first chunk.
  // Also extracts Content-Length from Content-Range header (more reliable
  // than HEAD, which some servers/proxies don't handle well).
  const startRes = await fetchRange(url, 0, PROBE_CHUNK, fetchFn);

  // Extract total file size from Content-Range: bytes 0-65535/1117533
  let contentLength = 0;
  const contentRange = startRes.headers.get("Content-Range");
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/);
    if (match) contentLength = parseInt(match[1], 10);
  }
  if (contentLength === 0) {
    // Fallback: try Content-Length from a HEAD request
    const headRes = await fetchFn(url, { method: "HEAD" });
    contentLength = parseInt(headRes.headers.get("Content-Length") ?? "0", 10);
  }
  if (contentLength === 0) {
    throw new Error("Cannot determine file size");
  }

  // 2. Scan first chunk for ftyp + moov
  const startBuf = await startRes.arrayBuffer();
  const startBoxes = scanTopLevelBoxes(startBuf, 0);

  if (!startBoxes.has("ftyp")) {
    throw new Error("Not a QuickTime/MOV file (no ftyp box)");
  }

  let moovBuf: ArrayBuffer;

  if (startBoxes.has("moov")) {
    const moovLoc = startBoxes.get("moov")!;
    if (moovLoc.offset + moovLoc.size <= startBuf.byteLength) {
      // Entire moov in first chunk
      moovBuf = startBuf.slice(moovLoc.offset, moovLoc.offset + moovLoc.size);
    } else {
      // moov starts in first chunk but extends beyond
      const full = await fetchRange(url, moovLoc.offset, moovLoc.size, fetchFn);
      moovBuf = await full.arrayBuffer();
    }
  } else {
    // 3. moov not at start — try end of file.
    // The end chunk likely starts mid-mdat, so we can't parse boxes
    // sequentially. Instead, search for the "moov" FourCC signature.
    const endOffset = Math.max(0, contentLength - PROBE_CHUNK);
    const endRes = await fetchRange(url, endOffset, contentLength - endOffset, fetchFn);
    const endBuf = await endRes.arrayBuffer();
    const moovLoc = searchForBox(endBuf, "moov", endOffset, contentLength);

    if (!moovLoc) {
      throw new Error("Cannot locate moov atom in MOV file");
    }

    const localStart = moovLoc.offset - endOffset;
    if (localStart >= 0 && localStart + moovLoc.size <= endBuf.byteLength) {
      moovBuf = endBuf.slice(localStart, localStart + moovLoc.size);
    } else {
      const full = await fetchRange(url, moovLoc.offset, moovLoc.size, fetchFn);
      moovBuf = await full.arrayBuffer();
    }
  }

  // 4. Parse moov
  const moovBoxes = parseBoxTree(moovBuf, 8, moovBuf.byteLength); // skip moov box header (8 bytes)
  const traks = findAllTracks(moovBoxes);

  const tracks: ProResTrackInfo[] = [];

  for (const trak of traks) {
    const data = parseTrack(moovBuf, trak);
    if (!data) continue;
    if (!PRORES_FOURCCS.has(data.codecFourCC)) continue;

    const sampleTable = buildSampleTable(data);
    if (sampleTable.length === 0) continue;

    const is444 = data.codecFourCC === "ap4h" || data.codecFourCC === "ap4x";
    const totalDuration = data.timescale > 0
      ? sampleTable.reduce((sum, s) => sum + s.duration, 0) / data.timescale
      : 0;
    const fps = totalDuration > 0 ? sampleTable.length / totalDuration : 24;

    tracks.push({
      fourcc: data.codecFourCC as ProResFourCC,
      profileName: FOURCC_NAMES[data.codecFourCC] ?? data.codecFourCC,
      width: data.width,
      height: data.height,
      frameCount: sampleTable.length,
      fps,
      timescale: data.timescale,
      duration: totalDuration,
      bitDepth: 10,
      chroma: is444 ? "4:4:4" : "4:2:2",
      sampleTable,
    });
  }

  return { tracks, fileSize: contentLength };
}

async function fetchRange(
  url: string,
  offset: number,
  length: number,
  fetchFn: typeof fetch,
): Promise<Response> {
  const end = offset + length - 1;
  const res = await fetchFn(url, {
    headers: { Range: `bytes=${offset}-${end}` },
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Range request failed: HTTP ${res.status}`);
  }
  return res;
}
