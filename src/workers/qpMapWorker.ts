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
import { createJm264QpDecoder, type Jm264QpInstance } from "../wasm/jm264Decoder";
import { createHm265QpDecoder, type Hm265QpInstance } from "../wasm/hm265Decoder";
import type { QpMapWorkerRequest, QpMapWorkerResponse } from "../types/qpMapWorker.types";

/** 4-byte Annex B start code. */
const START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

/**
 * Cached decoder instances — reused across decode requests to avoid
 * repeatedly allocating a new 64MB WASM instance.
 * Nulled after WasiExit (decoder destroyed); recreated on next request.
 */
let cachedJmDecoder: Jm264QpInstance | null = null;
let cachedHmDecoder: Hm265QpInstance | null = null;

async function getJmDecoder(): Promise<Jm264QpInstance> {
  if (cachedJmDecoder) return cachedJmDecoder;
  cachedJmDecoder = await createJm264QpDecoder();
  return cachedJmDecoder;
}

async function getHmDecoder(): Promise<Hm265QpInstance> {
  if (cachedHmDecoder) return cachedHmDecoder;
  cachedHmDecoder = await createHm265QpDecoder();
  return cachedHmDecoder;
}

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
 * Convert mp4box sample data (which contains length-prefixed NALUs) to
 * individual NAL units.
 */
function sampleToNalUnits(sample: Sample): Uint8Array[] {
  if (!sample.data) return [];
  const data = new Uint8Array(sample.data);
  const nalus: Uint8Array[] = [];
  let offset = 0;
  const naluLengthSize = 4; // Standard for avcC

  while (offset + naluLengthSize <= data.length) {
    const len =
      (data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3];
    offset += naluLengthSize;
    if (len > 0 && offset + len <= data.length) {
      nalus.push(data.subarray(offset, offset + len));
    }
    offset += len;
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

async function handleDecode(msg: QpMapWorkerRequest & { type: "decode" }) {
  const { initSegment, mediaSegment, targetTime, codec } = msg;
  console.log("[QP worker] handleDecode: codec=%s targetTime=%f, init=%d bytes, media=%d bytes",
    codec, targetTime, initSegment.byteLength, mediaSegment.byteLength);

  // 1. Extract parameter sets from init segment (avcC for H.264, hvcC for H.265)
  const paramSets = codec === "h265"
    ? extractParameterSetsHEVC(initSegment)
    : extractParameterSets(initSegment);
  console.log("[QP worker] paramSets: %d NALUs", paramSets.length);

  // 2. Extract all samples from media segment
  const samples = await extractAllSamples(initSegment, mediaSegment);
  console.log("[QP worker] samples: %d", samples.length);
  if (samples.length === 0) {
    const response: QpMapWorkerResponse = { type: "error", message: "No video samples found in segment" };
    self.postMessage(response);
    return;
  }

  // 3. Find the target frame — closest to targetTime
  const timescale = samples[0].timescale;
  const targetCts = targetTime * timescale;

  // Sort samples by CTS (composition/display order)
  const sortedByCts = [...samples].sort((a, b) => a.cts - b.cts);

  let targetSampleIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < sortedByCts.length; i++) {
    const dist = Math.abs(sortedByCts[i].cts - targetCts);
    if (dist < minDist) {
      minDist = dist;
      targetSampleIdx = i;
    }
  }

  // 4. Feed NALUs from the most recent IDR up to and including the target frame
  let idrIdx = targetSampleIdx;
  while (idrIdx > 0 && !sortedByCts[idrIdx].is_sync) {
    idrIdx--;
  }

  // Feed from IDR through target + a few extra samples to trigger frame output
  const feedEnd = Math.min(sortedByCts.length, targetSampleIdx + 4);
  const samplesToFeed = sortedByCts.slice(idrIdx, feedEnd);
  // Re-sort by DTS for feeding to decoder (decode order)
  samplesToFeed.sort((a, b) => a.dts - b.dts);

  console.log("[QP worker] feeding %d samples (IDR at %d, target at %d, feedEnd at %d)",
    samplesToFeed.length, idrIdx, targetSampleIdx, feedEnd);

  // 5. Build a single Annex B buffer with SPS+PPS+all slice NALUs
  const allNalus: Uint8Array[] = [];
  for (const sample of samplesToFeed) {
    const nalus = sampleToNalUnits(sample);
    for (const nalu of nalus) {
      allNalus.push(nalu);
    }
  }

  const annexB = buildAnnexB(paramSets, allNalus);
  console.log("[QP worker] Annex B buffer: %d bytes (%d param sets + %d sample NALUs)",
    annexB.length, paramSets.length, allNalus.length);

  // 6. Get (or create) decoder and decode
  const isH265 = codec === "h265";
  let widthMbs: number;
  let heightMbs: number;
  let qpValues: Uint8Array;
  let count: number;

  if (isH265) {
    let decoder;
    try {
      decoder = await getHmDecoder();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[QP worker] HM decoder creation failed:", errMsg);
      const response: QpMapWorkerResponse = { type: "error", message: `Decoder init failed: ${errMsg}` };
      self.postMessage(response);
      return;
    }

    console.log("[QP worker] calling HM decodeFrame (%d bytes)...", annexB.length);
    const t0 = performance.now();
    const frameReady = decoder.decodeFrame(annexB);
    console.log("[QP worker] HM decodeFrame → %s, widthBlocks=%d, heightBlocks=%d (%.0fms)",
      frameReady, decoder.getWidthBlocks(), decoder.getHeightBlocks(), performance.now() - t0);

    let hasFrame = frameReady;
    if (!hasFrame) {
      const flushed = decoder.flush();
      console.log("[QP worker] HM flush → %s", flushed);
      if (flushed) hasFrame = true;
    }

    if (decoder.destroyed) {
      cachedHmDecoder = null;
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
  } else {
    let decoder;
    try {
      decoder = await getJmDecoder();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[QP worker] JM decoder creation failed:", errMsg);
      const response: QpMapWorkerResponse = { type: "error", message: `Decoder init failed: ${errMsg}` };
      self.postMessage(response);
      return;
    }

    console.log("[QP worker] calling JM decodeFrame (%d bytes)...", annexB.length);
    const t0 = performance.now();
    const frameReady = decoder.decodeFrame(annexB);
    console.log("[QP worker] JM decodeFrame → %s, widthMbs=%d, heightMbs=%d (%.0fms)",
      frameReady, decoder.getWidthMbs(), decoder.getHeightMbs(), performance.now() - t0);

    let hasFrame = frameReady;
    if (!hasFrame) {
      const flushed = decoder.flush();
      console.log("[QP worker] JM flush → %s", flushed);
      if (flushed) hasFrame = true;
    }

    if (decoder.destroyed) {
      cachedJmDecoder = null;
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
    blockSize: isH265 ? 8 : 16,
    minQp,
    maxQp,
  };
  self.postMessage(response, { transfer: [qpValues.buffer] });
}

self.onmessage = async (e: MessageEvent<QpMapWorkerRequest>) => {
  try {
    if (e.data.type === "decode") {
      await handleDecode(e.data);
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error("[QP worker] uncaught error:", msg);
    if (err instanceof Error && err.stack) {
      console.error("[QP worker] stack:", err.stack);
    }
    const response: QpMapWorkerResponse = {
      type: "error",
      message: msg,
    };
    self.postMessage(response);
  }
};
