/**
 * Web Worker for extracting per-block QP values from H.264/H.265 fMP4 segments.
 *
 * Pipeline:
 *   1. mp4box.js extracts NAL units from the fMP4 media segment
 *   2. Finds the target frame (closest to targetTime)
 *   3. Builds Annex B buffer (param sets + slices with start codes) and feeds
 *      to the appropriate reference decoder WASM (JM for H.264, HM for H.265)
 *   4. Reads QP map via copyQps, computes min/max
 *   5. Transfers Uint8Array back to main thread
 */

import { createFile, MP4BoxBuffer } from "mp4box";
import type { Sample } from "mp4box";
import { createJm264QpDecoder } from "../wasm/jm264Decoder";
import { createHm265QpDecoder } from "../wasm/hm265Decoder";
import { createDav1dQpDecoder } from "../wasm/dav1dDecoder";
import {
  importClearKey,
  parseSencFromSegment,
  decryptSample,
  extractTenc,
} from "./cencDecrypt";
import type { QpMapWorkerRequest, QpMapWorkerResponse, PerFrameQp, QpMapSegmentResult } from "../types/qpMapWorker.types";

/** 4-byte Annex B start code. */
const START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

/**
 * Fresh decoder per request — JM/HM accumulate internal state (DPB, frame_num
 * counters) that corrupts subsequent decodes when segments jump in time.
 * WASM module is cached at the loader level so re-instantiation is cheap.
 */

/**
 * Extract ALL samples from a media segment using the init segment.
 */
function extractAllSamples(
  initBuf: ArrayBuffer,
  mediaData: ArrayBuffer,
): Promise<Sample[]> {
  return new Promise((resolve, reject) => {
    const allSamples: Sample[] = [];
    const mp4 = createFile();

    mp4.onReady = (info) => {
      const vt = info.videoTracks[0];
      if (!vt) {
        resolve([]);
        return;
      }
      mp4.setExtractionOptions(vt.id, null, { nbSamples: 10000 });
      mp4.start();
    };

    mp4.onSamples = (_id: number, _ref: unknown, samples: Sample[]) => {
      for (const s of samples) {
        if (s.data) allSamples.push(s);
      }
    };

    mp4.onError = (_mod: string, msg: string) => reject(new Error(msg));

    try {
      const initSlice = MP4BoxBuffer.fromArrayBuffer(initBuf.slice(0), 0);
      const offset1 = mp4.appendBuffer(initSlice);
      const mediaBuf = MP4BoxBuffer.fromArrayBuffer(mediaData.slice(0), offset1);
      mp4.appendBuffer(mediaBuf);
      mp4.flush();
      mp4.stop();
      resolve(allSamples);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Extract parameter sets (SPS/PPS) from the init segment's avcC box.
 * Parses raw bytes directly — more reliable than navigating mp4box's object tree.
 */
function extractParameterSets(initBuf: ArrayBuffer): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  const data = new Uint8Array(initBuf);

  // Search for avcC box: [4 bytes size][4 bytes 'avcC'][payload...]
  // 0x61='a', 0x76='v', 0x63='c', 0x43='C'
  for (let i = 0; i + 8 < data.length; i++) {
    if (data[i + 4] !== 0x61 || data[i + 5] !== 0x76 ||
        data[i + 6] !== 0x63 || data[i + 7] !== 0x43) continue;

    const boxSize = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    if (boxSize < 15 || i + boxSize > data.length) continue;

    let off = i + 8; // skip size + type
    // configurationVersion(1) + profile(1) + compat(1) + level(1) + lengthSizeMinusOne(1)
    off += 5;

    // numSPS (lower 5 bits)
    const numSPS = data[off] & 0x1f;
    off++;
    for (let s = 0; s < numSPS && off + 2 <= data.length; s++) {
      const spsLen = (data[off] << 8) | data[off + 1];
      off += 2;
      if (off + spsLen > data.length) break;
      nalus.push(data.slice(off, off + spsLen));
      off += spsLen;
    }

    // numPPS
    if (off >= data.length) break;
    const numPPS = data[off];
    off++;
    for (let p = 0; p < numPPS && off + 2 <= data.length; p++) {
      const ppsLen = (data[off] << 8) | data[off + 1];
      off += 2;
      if (off + ppsLen > data.length) break;
      nalus.push(data.slice(off, off + ppsLen));
      off += ppsLen;
    }

    break; // found avcC
  }

  return nalus;
}

/**
 * Extract parameter sets (VPS/SPS/PPS) from the init segment's hvcC box.
 * Parses raw bytes directly — same approach as extractParameterSets for avcC.
 *
 * hvcC structure:
 *   [22 bytes config] + numOfArrays(1) + array entries
 *   Each array: arrayCompleteness+naluType(1) + numNalus(2) + [naluLength(2) + naluData]...
 */
function extractParameterSetsHEVC(initBuf: ArrayBuffer): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  const data = new Uint8Array(initBuf);

  // Search for hvcC box: [4 bytes size][4 bytes 'hvcC'][payload...]
  // 0x68='h', 0x76='v', 0x63='c', 0x43='C'
  for (let i = 0; i + 8 < data.length; i++) {
    if (data[i + 4] !== 0x68 || data[i + 5] !== 0x76 ||
        data[i + 6] !== 0x63 || data[i + 7] !== 0x43) continue;

    const boxSize = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    if (boxSize < 27 || i + boxSize > data.length) continue;

    // Skip to numOfArrays — offset 22 bytes into the hvcC payload
    // configurationVersion(1) + general_profile_space...(12) + min/max spatial...(6)
    // + constantFrameRate/numTemporalLayers/...(3) = 22 bytes after box header
    let off = i + 8 + 22;

    if (off >= data.length) break;
    const numArrays = data[off];
    off++;

    for (let a = 0; a < numArrays && off + 3 <= data.length; a++) {
      // arrayCompleteness(1 bit) + reserved(1 bit) + naluType(6 bits)
      off++; // skip type byte
      const numNalus = (data[off] << 8) | data[off + 1];
      off += 2;

      for (let n = 0; n < numNalus && off + 2 <= data.length; n++) {
        const naluLen = (data[off] << 8) | data[off + 1];
        off += 2;
        if (off + naluLen > data.length) break;
        nalus.push(data.slice(off, off + naluLen));
        off += naluLen;
      }
    }

    break; // found hvcC
  }

  return nalus;
}


/**
 * Build a single Annex B buffer from parameter sets and sample NALUs.
 * Each NALU is prefixed with a 4-byte start code (00 00 00 01).
 */
function buildAnnexB(paramSets: Uint8Array[], sampleNalus: Uint8Array[]): Uint8Array {
  // Calculate total size
  let totalSize = 0;
  for (const ps of paramSets) {
    totalSize += START_CODE.length + ps.length;
  }
  for (const nalu of sampleNalus) {
    totalSize += START_CODE.length + nalu.length;
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;

  // Write parameter sets first (SPS, PPS)
  for (const ps of paramSets) {
    result.set(START_CODE, offset);
    offset += START_CODE.length;
    result.set(ps, offset);
    offset += ps.length;
  }

  // Write sample NALUs
  for (const nalu of sampleNalus) {
    result.set(START_CODE, offset);
    offset += START_CODE.length;
    result.set(nalu, offset);
    offset += nalu.length;
  }

  return result;
}

/**
 * Extract config OBUs (sequence header) from the init segment's av1C box.
 *
 * av1C structure: [4 bytes size][4 bytes 'av1C'][4 bytes config header][configOBUs...]
 * The 4-byte config header contains: marker(1bit), version(7bits), seq_profile(3bits),
 * seq_level_idx_0(5bits), seq_tier_0(1bit), high_bitdepth(1bit), twelve_bit(1bit),
 * monochrome(1bit), chroma_subsampling_x(1bit), chroma_subsampling_y(1bit),
 * chroma_sample_position(2bits), initial_presentation_delay stuff(8bits).
 * After the 4 header bytes: raw OBUs (typically just the sequence header OBU).
 */
function extractConfigOBUsAV1(initBuf: ArrayBuffer): Uint8Array | null {
  const data = new Uint8Array(initBuf);

  // Search for av1C box: [4 bytes size][4 bytes 'av1C'][payload...]
  // 0x61='a', 0x76='v', 0x31='1', 0x43='C'
  for (let i = 0; i + 8 < data.length; i++) {
    if (data[i + 4] !== 0x61 || data[i + 5] !== 0x76 ||
        data[i + 6] !== 0x31 || data[i + 7] !== 0x43) continue;

    const boxSize = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    if (boxSize < 12 || i + boxSize > data.length) continue;

    // Skip box header (8 bytes) + config header (4 bytes) = 12 bytes
    const obuStart = i + 12;
    const obuEnd = i + boxSize;
    if (obuStart >= obuEnd) return null;

    return data.slice(obuStart, obuEnd);
  }
  return null;
}

/**
 * Build OBU buffer for dav1d: sequence header OBUs + sample data.
 * AV1 in fMP4: samples contain self-delimiting OBUs (each has internal size field).
 * No length-prefix parsing needed — just concatenate.
 */
function buildObuBuffer(configObus: Uint8Array, sampleData: Uint8Array): Uint8Array {
  const result = new Uint8Array(configObus.length + sampleData.length);
  result.set(configObus, 0);
  result.set(sampleData, configObus.length);
  return result;
}

// ── Direct trun/mdat sample extraction (bypasses mp4box.js) ──

function findBox(data: Uint8Array, type: string, start: number, end: number): { offset: number; size: number } | null {
  const t = (type.charCodeAt(0) << 24 | type.charCodeAt(1) << 16 | type.charCodeAt(2) << 8 | type.charCodeAt(3)) >>> 0;
  let pos = start;
  while (pos + 8 <= end) {
    const size = ((data[pos] << 24) | (data[pos+1] << 16) | (data[pos+2] << 8) | data[pos+3]) >>> 0;
    const btype = ((data[pos+4] << 24) | (data[pos+5] << 16) | (data[pos+6] << 8) | data[pos+7]) >>> 0;
    if (size < 8) break;
    if (btype === t) return { offset: pos, size };
    pos += size;
  }
  return null;
}

function findBoxPath(data: Uint8Array, path: string[]): { offset: number; size: number } | null {
  let start = 0;
  let end = data.length;
  for (let i = 0; i < path.length; i++) {
    const box = findBox(data, path[i], start, end);
    if (!box) return null;
    if (i === path.length - 1) return box;
    // Determine content offset based on box type
    let headerSize = 8;
    if (path[i] === 'stsd') headerSize = 16;
    else if (['avc1','avc3','encv'].includes(path[i])) headerSize = 86;
    start = box.offset + headerSize;
    end = box.offset + box.size;
  }
  return null;
}

/** Parse trun sample sizes from a media segment. */
function parseTrunSizes(mediaData: Uint8Array): number[] {
  const trunBox = findBoxPath(mediaData, ['moof', 'traf', 'trun']);
  if (!trunBox) throw new Error("No trun box");

  const d = mediaData.subarray(trunBox.offset + 8, trunBox.offset + trunBox.size);
  const flags = (d[1] << 16 | d[2] << 8 | d[3]);
  const count = ((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]) >>> 0;

  let pos = 8;
  if (flags & 0x1) pos += 4; // data offset
  if (flags & 0x4) pos += 4; // first sample flags

  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    let size = 0;
    if (flags & 0x100) pos += 4; // duration
    if (flags & 0x200) { size = ((d[pos]<<24)|(d[pos+1]<<16)|(d[pos+2]<<8)|d[pos+3]) >>> 0; pos += 4; }
    if (flags & 0x400) pos += 4; // flags
    if (flags & 0x800) pos += 4; // composition time offset
    sizes.push(size);
  }
  return sizes;
}

/** Extract VCL NALUs from a single (decrypted) sample's raw bytes. */
function extractNalusFromSample(
  sampleBytes: Uint8Array,
  naluLengthSize: number,
  isHevc: boolean,
): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  let nPos = 0;
  while (nPos + naluLengthSize <= sampleBytes.length) {
    let len = 0;
    for (let j = 0; j < naluLengthSize; j++) len = (len << 8) | sampleBytes[nPos + j];
    nPos += naluLengthSize;
    if (len <= 0 || nPos + len > sampleBytes.length) break;
    if (isHevc) {
      const naluType = (sampleBytes[nPos] >> 1) & 0x3f;
      if (naluType <= 31) nalus.push(sampleBytes.slice(nPos, nPos + len));
    } else {
      const naluType = sampleBytes[nPos] & 0x1f;
      if (naluType >= 1 && naluType <= 5) nalus.push(sampleBytes.slice(nPos, nPos + len));
    }
    nPos += len;
  }
  return nalus;
}

/**
 * Determine per-sample prediction mode from HEVC NALU types.
 * Returns 0=intra for I-slices (IDR/CRA/BLA), 1=inter for P/B-slices.
 * Reads only the first VCL NALU of each sample (doesn't need decryption for type byte).
 */
function extractPerSampleModesHEVC(
  mediaData: Uint8Array,
  naluLengthSize: number,
): Uint8Array {
  const sizes = parseTrunSizes(mediaData);
  const mdatBox = findBox(mediaData, 'mdat', 0, mediaData.length);
  if (!mdatBox) return new Uint8Array(0);

  const modes = new Uint8Array(sizes.length);
  modes.fill(1); // default: inter
  let dataPos = mdatBox.offset + 8;
  for (let i = 0; i < sizes.length; i++) {
    // Scan NALUs within the sample to find the first VCL NALU (type <= 31)
    let nPos = dataPos;
    const sampleEnd = dataPos + sizes[i];
    while (nPos + naluLengthSize < sampleEnd) {
      let len = 0;
      for (let j = 0; j < naluLengthSize; j++) len = (len << 8) | mediaData[nPos + j];
      nPos += naluLengthSize;
      if (len <= 0 || nPos + len > sampleEnd) break;
      const naluType = (mediaData[nPos] >> 1) & 0x3f;
      if (naluType <= 31) {
        // VCL NALU found — classify by type
        // HEVC: 16-23 = IRAP (BLA, IDR, CRA) → intra; 0-15 = trailing/etc → inter
        modes[i] = (naluType >= 16 && naluType <= 23) ? 0 : 1;
        break;
      }
      nPos += len;
    }
    dataPos += sizes[i];
  }
  return modes;
}

/**
 * Determine per-sample prediction mode from H.264 NALU types.
 * Returns 0=intra for IDR slices (type 5), 1=inter for non-IDR (types 1-4).
 */
function extractPerSampleModesH264(
  mediaData: Uint8Array,
  naluLengthSize: number,
): Uint8Array {
  const sizes = parseTrunSizes(mediaData);
  const mdatBox = findBox(mediaData, 'mdat', 0, mediaData.length);
  if (!mdatBox) return new Uint8Array(0);

  const modes = new Uint8Array(sizes.length);
  modes.fill(1); // default: inter
  let dataPos = mdatBox.offset + 8;
  for (let i = 0; i < sizes.length; i++) {
    // Scan NALUs within the sample to find the first VCL NALU (types 1-5)
    let nPos = dataPos;
    const sampleEnd = dataPos + sizes[i];
    while (nPos + naluLengthSize < sampleEnd) {
      let len = 0;
      for (let j = 0; j < naluLengthSize; j++) len = (len << 8) | mediaData[nPos + j];
      nPos += naluLengthSize;
      if (len <= 0 || nPos + len > sampleEnd) break;
      const naluType = mediaData[nPos] & 0x1f;
      if (naluType >= 1 && naluType <= 5) {
        // H.264: type 5 = IDR slice → intra, types 1-4 = non-IDR → inter
        modes[i] = (naluType === 5) ? 0 : 1;
        break;
      }
      nPos += len;
    }
    dataPos += sizes[i];
  }
  return modes;
}

/** Extract VCL NALUs directly from trun + mdat, with optional CENC decryption. */
async function extractSamplesDirectly(
  mediaData: Uint8Array,
  naluLengthSize: number,
  isHevc: boolean,
  cryptoKey?: CryptoKey,
  sencSamples?: import("./cencDecrypt").SencSample[],
): Promise<Uint8Array[]> {
  const sizes = parseTrunSizes(mediaData);
  const mdatBox = findBox(mediaData, 'mdat', 0, mediaData.length);
  if (!mdatBox) throw new Error("No mdat box");

  const nalus: Uint8Array[] = [];
  let dataPos = mdatBox.offset + 8;
  for (let i = 0; i < sizes.length; i++) {
    let sampleBytes = mediaData.slice(dataPos, dataPos + sizes[i]);

    // Decrypt if CENC encryption is present
    if (cryptoKey && sencSamples && i < sencSamples.length) {
      sampleBytes = new Uint8Array(await decryptSample(
        cryptoKey, sencSamples[i].iv, sampleBytes, sencSamples[i].subsamples,
      ));
    }

    nalus.push(...extractNalusFromSample(sampleBytes, naluLengthSize, isHevc));
    dataPos += sizes[i];
  }
  return nalus;
}

async function handleDecode(msg: QpMapWorkerRequest & { type: "decode" }) {
  const { initSegment, mediaSegment, codec, clearKeyHex } = msg;

  let widthMbs: number;
  let heightMbs: number;
  let qpValues: Uint8Array;
  let count: number;
  let blockSize: number;

  if (codec === "av1") {
    // AV1 path: uses mp4box.js for sample extraction (no decode-order dependency)
    const samples = await extractAllSamples(initSegment, mediaSegment);
    if (samples.length === 0) {
      const response: QpMapWorkerResponse = { type: "error", message: "No video samples found in segment" };
      self.postMessage(response);
      return;
    }
    const samplesToFeed = [...samples].sort((a, b) => a.dts - b.dts);

    const configObus = extractConfigOBUsAV1(initSegment);
    if (!configObus || configObus.length === 0) {
      const response: QpMapWorkerResponse = { type: "error", message: "No av1C config OBUs found in init segment" };
      self.postMessage(response);
      return;
    }
    // AV1 samples contain raw OBUs — concatenate all sample data
    let totalSampleSize = 0;
    for (const sample of samplesToFeed) {
      if (sample.data) totalSampleSize += sample.data.byteLength;
    }
    const sampleData = new Uint8Array(totalSampleSize);
    let offset = 0;
    for (const sample of samplesToFeed) {
      if (sample.data) {
        sampleData.set(new Uint8Array(sample.data), offset);
        offset += sample.data.byteLength;
      }
    }

    const obuBuffer = buildObuBuffer(configObus, sampleData);

    let decoder;
    try {
      decoder = await createDav1dQpDecoder();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const response: QpMapWorkerResponse = { type: "error", message: `Decoder init failed: ${errMsg}` };
      self.postMessage(response);
      return;
    }

    try {
      const frameReady = decoder.decodeFrame(obuBuffer);

      let hasFrame = frameReady;
      if (!hasFrame) {
        if (decoder.flush()) hasFrame = true;
      }

      if (!hasFrame) {
        const response: QpMapWorkerResponse = { type: "error", message: "No frame decoded from segment" };
        self.postMessage(response);
        return;
      }

      const result = decoder.copyQps();
      qpValues = result.qpValues;
      count = result.count;
      widthMbs = decoder.getWidthBlocks();
      heightMbs = decoder.getHeightBlocks();
      blockSize = 8;
    } finally {
      if (!decoder.destroyed) decoder.destroy();
    }
  } else {
    // H.264/H.265 path: Annex B with NALU parsing
    const isHevc = codec === "h265";
    const paramSets = isHevc
      ? extractParameterSetsHEVC(initSegment)
      : extractParameterSets(initSegment);

    const mediaData = new Uint8Array(mediaSegment);

    // Set up CENC decryption if clearKey is provided
    let cryptoKey: CryptoKey | undefined;
    let sencSamples: import("./cencDecrypt").SencSample[] | undefined;
    if (clearKeyHex) {
      // Parse tenc from init segment via mp4box to get IV size
      const mp4Init = createFile();
      let ivSize = 8; // default
      mp4Init.onReady = (info) => {
        const vt = info.videoTracks[0];
        if (vt) {
          const tencInfo = extractTenc(mp4Init, vt.id);
          if (tencInfo) ivSize = tencInfo.defaultPerSampleIVSize || 8;
        }
      };
      const initSlice = MP4BoxBuffer.fromArrayBuffer(initSegment.slice(0), 0);
      mp4Init.appendBuffer(initSlice);
      mp4Init.flush();

      sencSamples = parseSencFromSegment(mediaSegment, ivSize);
      if (sencSamples.length > 0) {
        cryptoKey = await importClearKey(clearKeyHex);
      }
    }

    // Extract VCL NALUs directly from trun/mdat (bypasses mp4box.js which
    // reorders samples by CTS, breaking the decode-order requirement).
    const allNalus = await extractSamplesDirectly(mediaData, 4, isHevc, cryptoKey, sencSamples);

    const annexB = buildAnnexB(paramSets, allNalus);

    const isH265 = codec === "h265";

    if (isH265) {
      let decoder;
      try {
        decoder = await createHm265QpDecoder();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const response: QpMapWorkerResponse = { type: "error", message: `Decoder init failed: ${errMsg}` };
        self.postMessage(response);
        return;
      }

      try {
        const frameReady = decoder.decodeFrame(annexB);

        let hasFrame = frameReady;
        if (!hasFrame) {
          if (decoder.flush()) hasFrame = true;
        }

        if (!hasFrame) {
          const response: QpMapWorkerResponse = { type: "error", message: "No frame decoded from segment" };
          self.postMessage(response);
          return;
        }

        const result = decoder.copyQps();
        qpValues = result.qpValues;
        count = result.count;
        widthMbs = decoder.getWidthBlocks();
        heightMbs = decoder.getHeightBlocks();
      } finally {
        if (!decoder.destroyed) decoder.destroy();
      }
    } else {
      let decoder;
      try {
        decoder = await createJm264QpDecoder();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const response: QpMapWorkerResponse = { type: "error", message: `Decoder init failed: ${errMsg}` };
        self.postMessage(response);
        return;
      }

      try {
        const frameReady = decoder.decodeFrame(annexB);

        let hasFrame = frameReady;
        if (!hasFrame) {
          if (decoder.flush()) hasFrame = true;
        }

        if (!hasFrame) {
          const response: QpMapWorkerResponse = { type: "error", message: "No frame decoded from segment" };
          self.postMessage(response);
          return;
        }

        const result = decoder.copyQps();
        qpValues = result.qpValues;
        count = result.count;
        widthMbs = decoder.getWidthMbs();
        heightMbs = decoder.getHeightMbs();
      } finally {
        if (!decoder.destroyed) decoder.destroy();
      }
    }

    blockSize = isHevc ? 8 : 16;
  }

  if (count === 0 || widthMbs === 0 || heightMbs === 0) {
    const response: QpMapWorkerResponse = { type: "error", message: "Empty QP map" };
    self.postMessage(response);
    return;
  }

  // Compute min/max QP
  let minQp = 255;
  let maxQp = 0;
  for (let i = 0; i < count; i++) {
    if (qpValues[i] < minQp) minQp = qpValues[i];
    if (qpValues[i] > maxQp) maxQp = qpValues[i];
  }

  const response: QpMapWorkerResponse = {
    type: "qpMap",
    qpValues,
    widthMbs,
    heightMbs,
    blockSize,
    minQp,
    maxQp,
  };
  self.postMessage(response, { transfer: [qpValues.buffer] });
}

async function handleDecodeSegmentQp(msg: QpMapWorkerRequest & { type: "decodeSegmentQp" }) {
  const { initSegment, mediaSegment, codec, clearKeyHex } = msg;

  let widthMbs: number;
  let heightMbs: number;
  let blockSize: number;
  let frameCount: number;

  if (codec === "av1") {
    const samples = await extractAllSamples(initSegment, mediaSegment);
    if (samples.length === 0) {
      const response: QpMapWorkerResponse = { type: "error", message: "No video samples found in segment" };
      self.postMessage(response);
      return;
    }
    const samplesToFeed = [...samples].sort((a, b) => a.dts - b.dts);

    const configObus = extractConfigOBUsAV1(initSegment);
    if (!configObus || configObus.length === 0) {
      const response: QpMapWorkerResponse = { type: "error", message: "No av1C config OBUs found in init segment" };
      self.postMessage(response);
      return;
    }

    let totalSampleSize = 0;
    for (const sample of samplesToFeed) {
      if (sample.data) totalSampleSize += sample.data.byteLength;
    }
    const sampleData = new Uint8Array(totalSampleSize);
    let offset = 0;
    for (const sample of samplesToFeed) {
      if (sample.data) {
        sampleData.set(new Uint8Array(sample.data), offset);
        offset += sample.data.byteLength;
      }
    }

    const obuBuffer = buildObuBuffer(configObus, sampleData);

    let decoder;
    try {
      decoder = await createDav1dQpDecoder();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const response: QpMapWorkerResponse = { type: "error", message: `Decoder init failed: ${errMsg}` };
      self.postMessage(response);
      return;
    }

    try {
      decoder.setMultiFrame(true);
      decoder.decodeFrame(obuBuffer);
      if (!decoder.destroyed) decoder.flush();

      frameCount = decoder.getFrameCount();
      widthMbs = decoder.getWidthBlocks();
      heightMbs = decoder.getHeightBlocks();
      blockSize = 8;

      if (frameCount === 0) {
        const response: QpMapWorkerResponse = { type: "error", message: "No frames decoded from segment" };
        self.postMessage(response);
        return;
      }

      const frames: PerFrameQp[] = [];
      const transferables: ArrayBuffer[] = [];
      let globalMinQp = 255;
      let globalMaxQp = 0;

      let hasModes = false;
      for (let i = 0; i < frameCount; i++) {
        const { qpValues, count } = decoder.copyFrameQps(i);
        const { modeValues } = decoder.copyFrameModes(i);
        let minQp = 255, maxQp = 0, sum = 0;
        for (let j = 0; j < count; j++) {
          if (qpValues[j] < minQp) minQp = qpValues[j];
          if (qpValues[j] > maxQp) maxQp = qpValues[j];
          sum += qpValues[j];
        }
        if (minQp < globalMinQp) globalMinQp = minQp;
        if (maxQp > globalMaxQp) globalMaxQp = maxQp;

        const frame: PerFrameQp = { qpValues, avgQp: count > 0 ? sum / count : 0, minQp, maxQp };
        if (modeValues.length > 0) {
          frame.modeValues = modeValues;
          hasModes = true;
          transferables.push(modeValues.buffer as ArrayBuffer);
        }
        frames.push(frame);
        transferables.push(qpValues.buffer as ArrayBuffer);
      }

      const response: QpMapSegmentResult = {
        type: "qpSegment",
        frames,
        widthMbs,
        heightMbs,
        blockSize,
        globalMinQp,
        globalMaxQp,
        hasModes,
      };
      self.postMessage(response, { transfer: transferables });
    } finally {
      if (!decoder.destroyed) decoder.destroy();
    }
  } else {
    // H.264/H.265 path
    const isHevc = codec === "h265";
    const paramSets = isHevc
      ? extractParameterSetsHEVC(initSegment)
      : extractParameterSets(initSegment);

    const mediaData = new Uint8Array(mediaSegment);

    // Set up CENC decryption if needed
    let cryptoKey: CryptoKey | undefined;
    let sencSamples: import("./cencDecrypt").SencSample[] | undefined;
    if (clearKeyHex) {
      const mp4Init = createFile();
      let ivSize = 8;
      mp4Init.onReady = (info) => {
        const vt = info.videoTracks[0];
        if (vt) {
          const tencInfo = extractTenc(mp4Init, vt.id);
          if (tencInfo) ivSize = tencInfo.defaultPerSampleIVSize || 8;
        }
      };
      const initSlice = MP4BoxBuffer.fromArrayBuffer(initSegment.slice(0), 0);
      mp4Init.appendBuffer(initSlice);
      mp4Init.flush();

      sencSamples = parseSencFromSegment(mediaSegment, ivSize);
      if (sencSamples.length > 0) {
        cryptoKey = await importClearKey(clearKeyHex);
      }
    }

    const allNalus = await extractSamplesDirectly(mediaData, 4, isHevc, cryptoKey, sencSamples);
    const annexB = buildAnnexB(paramSets, allNalus);

    if (isHevc) {
      let decoder;
      try {
        decoder = await createHm265QpDecoder();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const response: QpMapWorkerResponse = { type: "error", message: `Decoder init failed: ${errMsg}` };
        self.postMessage(response);
        return;
      }

      try {
        decoder.setMultiFrame(true);
        decoder.decodeFrame(annexB);
        if (!decoder.destroyed) decoder.flush();

        frameCount = decoder.getFrameCount();
        widthMbs = decoder.getWidthBlocks();
        heightMbs = decoder.getHeightBlocks();
        blockSize = 8;
      } catch {
        frameCount = decoder.getFrameCount();
        widthMbs = decoder.getWidthBlocks();
        heightMbs = decoder.getHeightBlocks();
        blockSize = 8;
      }

      if (frameCount === 0) {
        if (!decoder.destroyed) decoder.destroy();
        const response: QpMapWorkerResponse = { type: "error", message: "No frames decoded from segment" };
        self.postMessage(response);
        return;
      }

      // Get QP data from HM (limited to ~3 frames from IDR)
      const hmFrames: Array<{ qpValues: Uint8Array; count: number; minQp: number; maxQp: number; sum: number }> = [];
      let globalMinQp = 255;
      let globalMaxQp = 0;
      for (let i = 0; i < frameCount; i++) {
        const { qpValues, count } = decoder.copyFrameQps(i);
        let minQp = 255, maxQp = 0, sum = 0;
        for (let j = 0; j < count; j++) {
          if (qpValues[j] < minQp) minQp = qpValues[j];
          if (qpValues[j] > maxQp) maxQp = qpValues[j];
          sum += qpValues[j];
        }
        if (minQp < globalMinQp) globalMinQp = minQp;
        if (maxQp > globalMaxQp) globalMaxQp = maxQp;
        hmFrames.push({ qpValues, count, minQp, maxQp, sum });
      }

      if (!decoder.destroyed) decoder.destroy();

      // Per-sample prediction mode from NALU types (frame-level: intra/inter).
      // HM only decodes ~3 frames from a DASH segment, so we expand to match
      // the actual sample count and use NALU types for accurate mode classification.
      const sampleModes = extractPerSampleModesHEVC(mediaData, 4);
      const sampleCount = sampleModes.length;
      const totalBlocks = widthMbs * heightMbs;
      const outputCount = sampleCount > 0 ? sampleCount : frameCount;

      const frames: PerFrameQp[] = [];
      const transferables: ArrayBuffer[] = [];

      for (let i = 0; i < outputCount; i++) {
        // QP: pick from nearest HM frame
        const hmIdx = frameCount > 0
          ? Math.min(frameCount - 1, Math.floor((i / outputCount) * frameCount))
          : 0;
        const hm = hmFrames[hmIdx];
        const qpValues = hm ? new Uint8Array(hm.qpValues) : new Uint8Array(totalBlocks);

        const frame: PerFrameQp = {
          qpValues,
          avgQp: hm ? (hm.count > 0 ? hm.sum / hm.count : 0) : 0,
          minQp: hm ? hm.minQp : 0,
          maxQp: hm ? hm.maxQp : 0,
        };

        // Mode: frame-level from NALU type
        if (i < sampleCount) {
          const modeValues = new Uint8Array(totalBlocks);
          modeValues.fill(sampleModes[i]);
          frame.modeValues = modeValues;
          transferables.push(modeValues.buffer as ArrayBuffer);
        }
        frames.push(frame);
        transferables.push(qpValues.buffer as ArrayBuffer);
      }

      const hasModes = sampleCount > 0;

      const response: QpMapSegmentResult = {
        type: "qpSegment",
        frames,
        widthMbs,
        heightMbs,
        blockSize,
        globalMinQp,
        globalMaxQp,
        hasModes,
      };
      self.postMessage(response, { transfer: transferables });
    } else {
      // H.264
      let decoder;
      try {
        decoder = await createJm264QpDecoder();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const response: QpMapWorkerResponse = { type: "error", message: `Decoder init failed: ${errMsg}` };
        self.postMessage(response);
        return;
      }

      try {
        decoder.setMultiFrame(true);
        decoder.decodeFrame(annexB);
        if (!decoder.destroyed) decoder.flush();

        frameCount = decoder.getFrameCount();
        widthMbs = decoder.getWidthMbs();
        heightMbs = decoder.getHeightMbs();
        blockSize = 16;
      } catch {
        frameCount = decoder.getFrameCount();
        widthMbs = decoder.getWidthMbs();
        heightMbs = decoder.getHeightMbs();
        blockSize = 16;
      }

      if (frameCount === 0) {
        if (!decoder.destroyed) decoder.destroy();
        const response: QpMapWorkerResponse = { type: "error", message: "No frames decoded from segment" };
        self.postMessage(response);
        return;
      }

      // NALU-based per-sample modes as fallback
      const sampleModesH264 = extractPerSampleModesH264(mediaData, 4);

      const frames: PerFrameQp[] = [];
      const transferables: ArrayBuffer[] = [];
      let globalMinQp = 255;
      let globalMaxQp = 0;
      let hasModes = false;

      for (let i = 0; i < frameCount; i++) {
        const { qpValues, count } = decoder.copyFrameQps(i);
        const { modeValues } = decoder.copyFrameModes(i);
        let minQp = 255, maxQp = 0, sum = 0;
        for (let j = 0; j < count; j++) {
          if (qpValues[j] < minQp) minQp = qpValues[j];
          if (qpValues[j] > maxQp) maxQp = qpValues[j];
          sum += qpValues[j];
        }
        if (minQp < globalMinQp) globalMinQp = minQp;
        if (maxQp > globalMaxQp) globalMaxQp = maxQp;

        const frame: PerFrameQp = { qpValues, avgQp: count > 0 ? sum / count : 0, minQp, maxQp };
        if (modeValues.length > 0) {
          // JM provides per-MB modes — use them
          frame.modeValues = modeValues;
          hasModes = true;
          transferables.push(modeValues.buffer as ArrayBuffer);
        } else if (i < sampleModesH264.length) {
          // Fallback: frame-level mode from NALU type
          const fallbackModes = new Uint8Array(count);
          fallbackModes.fill(sampleModesH264[i]);
          frame.modeValues = fallbackModes;
          hasModes = true;
          transferables.push(fallbackModes.buffer as ArrayBuffer);
        }
        frames.push(frame);
        transferables.push(qpValues.buffer as ArrayBuffer);
      }

      if (!decoder.destroyed) decoder.destroy();

      const response: QpMapSegmentResult = {
        type: "qpSegment",
        frames,
        widthMbs,
        heightMbs,
        blockSize,
        globalMinQp,
        globalMaxQp,
        hasModes,
      };
      self.postMessage(response, { transfer: transferables });
    }
  }
}

self.onmessage = async (e: MessageEvent<QpMapWorkerRequest>) => {
  try {
    if (e.data.type === "decode") {
      await handleDecode(e.data);
    } else if (e.data.type === "decodeSegmentQp") {
      await handleDecodeSegmentQp(e.data);
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const response: QpMapWorkerResponse = {
      type: "error",
      message: msg,
    };
    self.postMessage(response);
  }
};
