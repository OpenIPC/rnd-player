/**
 * Widevine PSSH protobuf decoder.
 *
 * Decodes the `WidevineCencHeader` protobuf message using wire-format
 * parsing only (no .proto file needed). Handles the subset of fields
 * defined in the Widevine CENC header specification.
 *
 * Field numbers:
 *   1: algorithm (enum)    — UNENCRYPTED(0), AESCTR(1)
 *   2: key_id (bytes, repeated)
 *   3: provider (string)
 *   4: content_id (bytes)
 *   6: policy (string)
 *   7: crypto_period_index (uint32)
 *   8: grouped_license (bytes)
 *   9: protection_scheme (uint32) — FourCC: cenc/cbc1/cens/cbcs
 */

import { formatUuid, toHex, type WidevinePssh } from "./types";

// Protobuf wire types
const VARINT = 0;
const FIXED64 = 1;
const LENGTH_DELIMITED = 2;
const FIXED32 = 5;

function readVarint(data: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < data.length) {
    const byte = data[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 35) break; // overflow protection
  }
  return [result, pos];
}

function fourccFromUint32(val: number): string {
  return String.fromCharCode(
    (val >>> 24) & 0xff,
    (val >>> 16) & 0xff,
    (val >>> 8) & 0xff,
    val & 0xff,
  );
}

const ALGORITHM_NAMES: Record<number, string> = {
  0: "UNENCRYPTED",
  1: "AESCTR",
};

/** Decode Widevine CENC header protobuf data. */
export function decodeWidevinePssh(data: Uint8Array): WidevinePssh {
  const result: WidevinePssh = { keyIds: [] };
  let pos = 0;

  while (pos < data.length) {
    const [tag, newPos] = readVarint(data, pos);
    pos = newPos;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    switch (wireType) {
      case VARINT: {
        const [value, nextPos] = readVarint(data, pos);
        pos = nextPos;
        if (fieldNumber === 1) {
          result.algorithm = ALGORITHM_NAMES[value] ?? String(value);
        } else if (fieldNumber === 7) {
          // crypto_period_index — not exposed in our type currently
        }
        break;
      }
      case FIXED64: {
        pos += 8;
        break;
      }
      case LENGTH_DELIMITED: {
        const [length, dataPos] = readVarint(data, pos);
        pos = dataPos;
        const fieldData = data.subarray(pos, pos + length);
        pos += length;

        if (fieldNumber === 2) {
          // key_id (bytes, repeated) — can be 16 raw bytes or 32-char hex string
          if (fieldData.length === 16) {
            result.keyIds.push(formatUuid(fieldData));
          } else if (fieldData.length === 32) {
            // Some packagers store the KID as a 32-char hex ASCII string
            const asText = new TextDecoder().decode(fieldData);
            if (/^[0-9a-f]{32}$/i.test(asText)) {
              const kid = asText.toLowerCase();
              result.keyIds.push(
                `${kid.slice(0, 8)}-${kid.slice(8, 12)}-${kid.slice(12, 16)}-${kid.slice(16, 20)}-${kid.slice(20, 32)}`,
              );
            } else {
              result.keyIds.push(toHex(fieldData));
            }
          } else {
            result.keyIds.push(toHex(fieldData));
          }
        } else if (fieldNumber === 3) {
          result.provider = new TextDecoder().decode(fieldData);
        } else if (fieldNumber === 4) {
          result.contentId = toHex(fieldData);
          try {
            const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(fieldData);
            // Only set if it looks like readable text
            if (/^[\x20-\x7e]+$/.test(utf8)) {
              result.contentIdUtf8 = utf8;
            }
          } catch {
            // not valid UTF-8
          }
        } else if (fieldNumber === 6) {
          result.policy = new TextDecoder().decode(fieldData);
        }
        break;
      }
      case FIXED32: {
        if (pos + 4 > data.length) return result;
        const view = new DataView(data.buffer, data.byteOffset + pos, 4);
        const value = view.getUint32(0);
        pos += 4;
        if (fieldNumber === 9) {
          result.protectionScheme = fourccFromUint32(value);
        }
        break;
      }
      default:
        // Unknown wire type — cannot continue safely
        return result;
    }
  }

  return result;
}
