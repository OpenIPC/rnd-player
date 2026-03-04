/**
 * PSSH (Protection System Specific Header) box parser.
 *
 * Parses raw PSSH box bytes per ISO 23001-7, identifies the DRM system
 * by UUID, and delegates to system-specific decoders for Widevine and PlayReady.
 */

import { DRM_SYSTEM_IDS, formatUuid, type PsshBox } from "./types";
import { decodeWidevinePssh } from "./psshWidevinePb";
import { decodePlayReadyPssh } from "./psshPlayready";

const WIDEVINE_SYSTEM_ID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
const PLAYREADY_SYSTEM_ID = "9a04f079-9840-4286-ab92-e65be0885f95";

/**
 * Parse a single PSSH box from its content bytes (after the 8-byte box header).
 * The input is the raw content of a 'pssh' box: FullBox header + SystemID + data.
 */
export function parsePsshBox(
  content: Uint8Array,
  source: "manifest" | "init-segment",
): PsshBox | null {
  if (content.length < 24) return null; // minimum: 4 (fullbox) + 16 (systemId) + 4 (dataSize)

  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  let pos = 0;

  // FullBox: version (1) + flags (3)
  const version = content[pos];
  pos += 4;

  // SystemID (16 bytes)
  const systemIdBytes = content.subarray(pos, pos + 16);
  const systemId = formatUuid(systemIdBytes);
  pos += 16;

  const systemName = DRM_SYSTEM_IDS[systemId] ?? "Unknown";

  // KIDs (version 1 only)
  const keyIds: string[] = [];
  if (version >= 1) {
    if (pos + 4 > content.length) return null;
    const kidCount = view.getUint32(pos);
    pos += 4;
    for (let i = 0; i < kidCount; i++) {
      if (pos + 16 > content.length) break;
      keyIds.push(formatUuid(content.subarray(pos, pos + 16)));
      pos += 16;
    }
  }

  // Data
  if (pos + 4 > content.length) return null;
  const dataSize = view.getUint32(pos);
  pos += 4;
  const data = content.subarray(pos, pos + dataSize);

  const box: PsshBox = { systemId, systemName, version, keyIds, data, source };

  // System-specific decoding
  if (systemId === WIDEVINE_SYSTEM_ID && data.length > 0) {
    box.decoded = decodeWidevinePssh(data);
  } else if (systemId === PLAYREADY_SYSTEM_ID && data.length > 0) {
    box.decoded = decodePlayReadyPssh(data);
  }

  return box;
}

/**
 * Find and parse all PSSH boxes from raw MP4 bytes (moov or full file).
 * Scans top-level boxes and descends into moov containers.
 */
export function findAllPsshBoxes(
  data: Uint8Array,
  source: "manifest" | "init-segment",
): PsshBox[] {
  const boxes: PsshBox[] = [];
  scanBoxes(data, source, boxes);
  return boxes;
}

const CONTAINER_TYPES = new Set(["moov", "moof", "traf"]);

function scanBoxes(
  data: Uint8Array,
  source: "manifest" | "init-segment",
  result: PsshBox[],
): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  while (offset + 8 <= data.length) {
    let boxSize = view.getUint32(offset);
    const boxType = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7],
    );

    if (boxSize === 0) {
      boxSize = data.length - offset;
    } else if (boxSize === 1) {
      if (offset + 16 > data.length) break;
      const hi = view.getUint32(offset + 8);
      if (hi > 0) break;
      boxSize = view.getUint32(offset + 12);
    }

    if (boxSize < 8 || offset + boxSize > data.length) break;

    if (boxType === "pssh") {
      const content = data.subarray(offset + 8, offset + boxSize);
      const box = parsePsshBox(content, source);
      if (box) result.push(box);
    } else if (CONTAINER_TYPES.has(boxType)) {
      scanBoxes(data.subarray(offset + 8, offset + boxSize), source, result);
    }

    offset += boxSize;
  }
}

/**
 * Decode a base64-encoded PSSH box (as found in <cenc:pssh> elements).
 * The base64 value encodes the full PSSH box including the 8-byte header.
 */
export function decodePsshBase64(
  base64: string,
  source: "manifest" | "init-segment",
): PsshBox | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    // PSSH base64 includes the full box: size(4) + 'pssh'(4) + content
    if (bytes.length < 8) return null;
    const content = bytes.subarray(8);
    return parsePsshBox(content, source);
  } catch {
    return null;
  }
}
