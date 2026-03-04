/**
 * PlayReady PSSH data decoder.
 *
 * PlayReady PSSH data contains a PlayReady Object Header:
 *   - Total length (uint32 LE)
 *   - Record count (uint16 LE)
 *   - Records: type (uint16 LE) + length (uint16 LE) + data
 *
 * Record Type 1 = Rights Management Header (UTF-16LE XML).
 * The XML contains <KID>, <LA_URL>, <LUI_URL>, <CUSTOMATTRIBUTES>.
 */

import type { PlayReadyPssh } from "./types";

/**
 * Decode a base64-encoded PlayReady KID to UUID format.
 * PlayReady KIDs are base64-encoded GUIDs in little-endian byte order.
 */
function decodePlayReadyKid(b64: string): string | null {
  try {
    const raw = atob(b64);
    if (raw.length !== 16) return null;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = raw.charCodeAt(i);

    // PlayReady GUID byte order: first 3 groups are LE
    const hex = (b: number) => b.toString(16).padStart(2, "0");
    return [
      hex(bytes[3]), hex(bytes[2]), hex(bytes[1]), hex(bytes[0]),
      "-",
      hex(bytes[5]), hex(bytes[4]),
      "-",
      hex(bytes[7]), hex(bytes[6]),
      "-",
      hex(bytes[8]), hex(bytes[9]),
      "-",
      hex(bytes[10]), hex(bytes[11]), hex(bytes[12]),
      hex(bytes[13]), hex(bytes[14]), hex(bytes[15]),
    ].join("");
  } catch {
    return null;
  }
}

/** Extract text content of an XML element by tag name. */
function getXmlText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** Decode PlayReady Object Header from PSSH data bytes. */
export function decodePlayReadyPssh(data: Uint8Array): PlayReadyPssh {
  const result: PlayReadyPssh = {};

  if (data.length < 6) return result;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // const totalLength = view.getUint32(0, true);
  const recordCount = view.getUint16(4, true);
  let pos = 6;

  for (let i = 0; i < recordCount && pos + 4 <= data.length; i++) {
    const recordType = view.getUint16(pos, true);
    const recordLength = view.getUint16(pos + 2, true);
    pos += 4;

    if (pos + recordLength > data.length) break;

    if (recordType === 1) {
      // Rights Management Header — UTF-16LE XML
      const xmlBytes = data.subarray(pos, pos + recordLength);
      const xml = decodeUtf16Le(xmlBytes);

      const kidB64 = getXmlText(xml, "KID");
      if (kidB64) {
        result.kid = decodePlayReadyKid(kidB64) ?? kidB64;
      }

      result.laUrl = getXmlText(xml, "LA_URL") ?? undefined;
      result.luiUrl = getXmlText(xml, "LUI_URL") ?? undefined;

      // Custom attributes — extract raw XML block
      const caMatch = xml.match(/<CUSTOMATTRIBUTES>([\s\S]*?)<\/CUSTOMATTRIBUTES>/i);
      if (caMatch) {
        result.customAttributes = caMatch[1].trim();
      }
    }

    pos += recordLength;
  }

  return result;
}

function decodeUtf16Le(bytes: Uint8Array): string {
  const codeUnits: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    codeUnits.push(bytes[i] | (bytes[i + 1] << 8));
  }
  return String.fromCharCode(...codeUnits);
}
