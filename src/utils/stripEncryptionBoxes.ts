/**
 * Strip CENC encryption signaling from an fMP4 init segment so that
 * external tools (StreamEye, VLC, etc.) treat the file as clear content.
 *
 * - Reads sinf > frma to discover the original sample entry type (e.g. "avc1")
 * - Renames encv/enca back to the original format
 * - Removes sinf boxes from sample entries
 * - Removes pssh boxes from moov
 * - Recalculates all ancestor box sizes
 *
 * Returns the original data unchanged if no encryption boxes are found.
 */

// Box types whose children start immediately after the 8-byte box header
const PLAIN_CONTAINERS = new Set([
  "moov", "trak", "mdia", "minf", "stbl",
  "dinf", "edts", "mvex", "udta",
  "moof", "traf",
]);

/**
 * Get the byte offset where child boxes start for known container types.
 * Returns null for leaf (non-container) boxes.
 */
function childrenOffset(type: string): number | null {
  if (PLAIN_CONTAINERS.has(type)) return 8;
  // stsd: FullBox header (8 + version(1) + flags(3)) + entry_count(4) = 16
  if (type === "stsd") return 16;
  // VisualSampleEntry: 8 box + 78 sample entry fields = 86
  if (type === "encv") return 86;
  // AudioSampleEntry: 8 box + 28 sample entry fields = 36
  if (type === "enca") return 36;
  // sinf and schi are containers too (needed for frma lookup)
  if (type === "sinf" || type === "schi") return 8;
  return null;
}

function readFourCC(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
  );
}

function readBoxSize(view: DataView, data: Uint8Array, offset: number): number {
  let size = view.getUint32(offset);
  if (size === 1) {
    // 64-bit extended size
    if (offset + 16 > data.length) return 0;
    const hi = view.getUint32(offset + 8);
    if (hi > 0) return 0; // > 4 GB — out of range for our use
    size = view.getUint32(offset + 12);
  } else if (size === 0) {
    size = data.length - offset;
  }
  return size;
}

/**
 * Recursively search the box tree for a frma box and return its
 * 4-char data_format value (the original sample entry type).
 */
function findFrmaFormat(data: Uint8Array): string | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  while (offset + 8 <= data.length) {
    const boxSize = readBoxSize(view, data, offset);
    if (boxSize < 8 || offset + boxSize > data.length) break;

    const type = readFourCC(data, offset + 4);

    // frma box: 8-byte header + 4-byte data_format = 12 bytes
    if (type === "frma" && boxSize >= 12) {
      return readFourCC(data, offset + 8);
    }

    const hdrLen = childrenOffset(type);
    if (hdrLen !== null && hdrLen < boxSize) {
      const result = findFrmaFormat(data.subarray(offset + hdrLen, offset + boxSize));
      if (result) return result;
    }

    offset += boxSize;
  }

  return null;
}

/** Boxes to remove when stripping encryption signaling from init segments. */
const INIT_REMOVE = new Set(["sinf", "pssh"]);

/**
 * Recursively rebuild the box tree, skipping boxes in the remove set
 * and renaming encv/enca to the original format.
 */
function rebuildBoxTree(
  data: Uint8Array,
  originalFormat: string,
): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parts: Uint8Array[] = [];
  let offset = 0;

  while (offset + 8 <= data.length) {
    const boxSize = readBoxSize(view, data, offset);
    if (boxSize < 8 || offset + boxSize > data.length) break;

    const type = readFourCC(data, offset + 4);

    // Skip removed box types
    if (INIT_REMOVE.has(type)) {
      offset += boxSize;
      continue;
    }

    const hdrLen = childrenOffset(type);
    if (hdrLen !== null && hdrLen < boxSize) {
      // Container: copy header, recurse into children, recalculate size
      const header = data.slice(offset, offset + hdrLen);
      const childData = data.subarray(offset + hdrLen, offset + boxSize);
      const newChildren = rebuildBoxTree(childData, originalFormat);

      const newSize = hdrLen + newChildren.length;
      const newBox = new Uint8Array(newSize);
      newBox.set(header);
      newBox.set(newChildren, hdrLen);

      // Update box size
      new DataView(newBox.buffer, newBox.byteOffset, newBox.byteLength)
        .setUint32(0, newSize);

      // Rename encrypted sample entry to original format
      if (type === "encv" || type === "enca") {
        for (let i = 0; i < 4; i++) {
          newBox[4 + i] = originalFormat.charCodeAt(i);
        }
      }

      parts.push(newBox);
    } else {
      // Leaf box — copy as-is
      parts.push(data.slice(offset, offset + boxSize));
    }

    offset += boxSize;
  }

  // Concatenate all parts
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

export function stripInitEncryption(initData: ArrayBuffer): ArrayBuffer {
  const data = new Uint8Array(initData);
  const originalFormat = findFrmaFormat(data);
  if (!originalFormat) return initData; // not encrypted — return unchanged

  const result = rebuildBoxTree(data, originalFormat);
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
}
