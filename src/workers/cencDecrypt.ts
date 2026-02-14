/**
 * CENC (Common Encryption Scheme) decryption utilities for ClearKey DRM.
 *
 * Handles AES-128-CTR decryption of CENC-encrypted MP4 segments using
 * the Web Crypto API. Parses tenc/schm boxes from mp4box's parsed tree
 * and senc boxes from raw segment bytes (mp4box's senc parser is disabled).
 */

export interface TencInfo {
  defaultPerSampleIVSize: number;
  defaultKID: Uint8Array;
  defaultConstantIV: Uint8Array | null;
}

export interface SencSample {
  iv: Uint8Array;
  subsamples: { clearBytes: number; encryptedBytes: number }[] | null;
}

/**
 * Convert a 32-char hex string to a 16-byte AES-CTR CryptoKey.
 */
export async function importClearKey(hexKey: string): Promise<CryptoKey> {
  if (hexKey.length !== 32) {
    throw new Error(`Invalid key length: expected 32 hex chars, got ${hexKey.length}`);
  }
  const keyBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    keyBytes[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, ["decrypt"]);
}

/**
 * Extract the protection scheme type from sinf.schm.scheme_type.
 * Returns the 4-char scheme string (e.g. "cenc", "cbcs") or null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractScheme(mp4: any, trackId: number): string | null {
  const trak = mp4.getTrackById(trackId);
  if (!trak) return null;

  const entries = trak.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries || entries.length === 0) return null;

  const entry = entries[0];
  const sinf = entry.sinf ?? entry.sinfs?.[0];
  if (!sinf) return null;

  const schm = sinf.schm;
  if (!schm) return null;

  return schm.scheme_type ?? null;
}

/**
 * Extract tenc (Track Encryption) box data from the mp4box parsed tree.
 * Path: trak.mdia.minf.stbl.stsd.entries[0].sinf.schi.tenc
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractTenc(mp4: any, trackId: number): TencInfo | null {
  const trak = mp4.getTrackById(trackId);
  if (!trak) return null;

  const entries = trak.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries || entries.length === 0) return null;

  const entry = entries[0];
  const sinf = entry.sinf ?? entry.sinfs?.[0];
  if (!sinf) return null;

  const tenc = sinf.schi?.tenc;
  if (!tenc) return null;

  return {
    defaultPerSampleIVSize: tenc.default_Per_Sample_IV_Size ?? tenc.default_perSampleIVSize ?? 0,
    defaultKID: tenc.default_KID ?? new Uint8Array(16),
    defaultConstantIV: tenc.default_constant_IV ?? tenc.default_constantIV ?? null,
  };
}

// Container box types that we descend into when searching for a target box
const CONTAINER_TYPES = new Set(["moof", "traf"]);

/**
 * Recursively scan raw MP4 bytes for a box with the given fourCC,
 * descending into known container types (moof, traf).
 * Returns the box's content bytes (after the 8-byte header) or null.
 */
export function findBoxData(data: Uint8Array, fourcc: string): Uint8Array | null {
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

    // Handle box size edge cases
    if (boxSize === 0) {
      // Box extends to end of data
      boxSize = data.length - offset;
    } else if (boxSize === 1) {
      // 64-bit extended size — skip for now (rare in DASH segments)
      if (offset + 16 > data.length) break;
      // Read high 32 bits — if non-zero, box is too large
      const hi = view.getUint32(offset + 8);
      if (hi > 0) break;
      boxSize = view.getUint32(offset + 12);
    }

    if (boxSize < 8 || offset + boxSize > data.length) break;

    if (boxType === fourcc) {
      return data.subarray(offset + 8, offset + boxSize);
    }

    if (CONTAINER_TYPES.has(boxType)) {
      const inner = data.subarray(offset + 8, offset + boxSize);
      const found = findBoxData(inner, fourcc);
      if (found) return found;
    }

    offset += boxSize;
  }

  return null;
}

/**
 * Parse the senc (Sample Encryption) box from raw segment bytes.
 * mp4box's senc parser is commented out, so we parse manually.
 *
 * senc is a FullBox inside moof/traf with per-sample IVs and optional
 * subsample encryption ranges.
 */
export function parseSencFromSegment(rawData: ArrayBuffer, ivSize: number): SencSample[] {
  const data = new Uint8Array(rawData);
  const sencContent = findBoxData(data, "senc");
  if (!sencContent) return [];

  const view = new DataView(sencContent.buffer, sencContent.byteOffset, sencContent.byteLength);
  let pos = 0;

  // FullBox header: version (1 byte) + flags (3 bytes)
  if (pos + 4 > sencContent.length) return [];
  const flags = (sencContent[pos + 1] << 16) | (sencContent[pos + 2] << 8) | sencContent[pos + 3];
  pos += 4;

  // sample_count
  if (pos + 4 > sencContent.length) return [];
  const sampleCount = view.getUint32(pos);
  pos += 4;

  const useSubsamples = !!(flags & 0x2);
  const samples: SencSample[] = [];

  for (let i = 0; i < sampleCount; i++) {
    // Per-sample IV
    if (pos + ivSize > sencContent.length) break;
    const iv = sencContent.slice(pos, pos + ivSize);
    pos += ivSize;

    let subsamples: { clearBytes: number; encryptedBytes: number }[] | null = null;

    if (useSubsamples) {
      if (pos + 2 > sencContent.length) break;
      const subCount = view.getUint16(pos);
      pos += 2;

      subsamples = [];
      for (let j = 0; j < subCount; j++) {
        if (pos + 6 > sencContent.length) break;
        const clearBytes = view.getUint16(pos);
        pos += 2;
        const encryptedBytes = view.getUint32(pos);
        pos += 4;
        subsamples.push({ clearBytes, encryptedBytes });
      }
    }

    samples.push({ iv, subsamples });
  }

  return samples;
}

/**
 * Decrypt a single sample using AES-128-CTR.
 *
 * CENC spec: IV is right-padded with zeros to 16 bytes.
 * Without subsamples: decrypt the entire sample.
 * With subsamples: only encrypted byte ranges are decrypted; clear bytes pass through.
 */
export async function decryptSample(
  cryptoKey: CryptoKey,
  iv: Uint8Array,
  sampleData: Uint8Array,
  subsamples?: { clearBytes: number; encryptedBytes: number }[] | null,
): Promise<Uint8Array> {
  // Pad IV to 16 bytes (CENC spec: right-pad with zeros)
  const counter = new Uint8Array(16);
  counter.set(iv.subarray(0, Math.min(iv.length, 16)));

  const algo: AesCtrParams = { name: "AES-CTR", counter, length: 128 };

  if (!subsamples || subsamples.length === 0) {
    // No subsamples — decrypt entire buffer
    const buf = new Uint8Array(sampleData).buffer as ArrayBuffer;
    const decrypted = await crypto.subtle.decrypt(algo, cryptoKey, buf);
    return new Uint8Array(decrypted);
  }

  // With subsamples: collect encrypted ranges, decrypt in one call, re-interleave
  let totalEncrypted = 0;
  for (const ss of subsamples) {
    totalEncrypted += ss.encryptedBytes;
  }

  if (totalEncrypted === 0) {
    return sampleData; // All clear, nothing to decrypt
  }

  // Collect encrypted byte ranges into a single buffer
  const encryptedBuf = new Uint8Array(totalEncrypted);
  let encOffset = 0;
  let sampleOffset = 0;

  for (const ss of subsamples) {
    sampleOffset += ss.clearBytes;
    if (ss.encryptedBytes > 0) {
      encryptedBuf.set(sampleData.subarray(sampleOffset, sampleOffset + ss.encryptedBytes), encOffset);
      encOffset += ss.encryptedBytes;
    }
    sampleOffset += ss.encryptedBytes;
  }

  // Single AES-CTR decrypt call for all encrypted bytes
  const encBuf = new Uint8Array(encryptedBuf).buffer as ArrayBuffer;
  const decryptedBuf = new Uint8Array(await crypto.subtle.decrypt(algo, cryptoKey, encBuf));

  // Re-interleave: clear bytes stay, encrypted bytes are replaced with decrypted
  const result = new Uint8Array(sampleData.length);
  let rOffset = 0;
  let dOffset = 0;
  sampleOffset = 0;

  for (const ss of subsamples) {
    // Copy clear bytes
    if (ss.clearBytes > 0) {
      result.set(sampleData.subarray(sampleOffset, sampleOffset + ss.clearBytes), rOffset);
      rOffset += ss.clearBytes;
      sampleOffset += ss.clearBytes;
    }
    // Copy decrypted bytes
    if (ss.encryptedBytes > 0) {
      result.set(decryptedBuf.subarray(dOffset, dOffset + ss.encryptedBytes), rOffset);
      rOffset += ss.encryptedBytes;
      dOffset += ss.encryptedBytes;
      sampleOffset += ss.encryptedBytes;
    }
  }

  // Copy any remaining bytes after the last subsample
  if (sampleOffset < sampleData.length) {
    result.set(sampleData.subarray(sampleOffset), rOffset);
  }

  return result;
}
