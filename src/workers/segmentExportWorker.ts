import { createFile, MP4BoxBuffer } from "mp4box";
import type { Sample } from "mp4box";
import type { ExportWorkerRequest, ExportWorkerResponse } from "../types/segmentExportWorker.types";
import {
  importClearKey,
  extractScheme,
  extractTenc,
  parseSencFromSegment,
  decryptSample,
  findBoxData,
  type TencInfo,
} from "./cencDecrypt";
import { stripInitEncryption } from "../utils/stripEncryptionBoxes";

function post(msg: ExportWorkerResponse, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer: transfer ?? [] });
}

let aborted = false;

/**
 * Synchronously parse the init segment with mp4box to extract tenc info.
 * Returns null if not encrypted or scheme is unsupported.
 */
function parseInitTenc(initData: ArrayBuffer): TencInfo | null {
  let result: TencInfo | null = null;
  const mp4 = createFile();
  const buf = MP4BoxBuffer.fromArrayBuffer(initData.slice(0), 0);
  mp4.onReady = (info) => {
    const vt = info.videoTracks[0];
    if (!vt) return;
    const scheme = extractScheme(mp4, vt.id);
    if (scheme && scheme !== "cenc") {
      post({ type: "error", message: `Unsupported encryption scheme: ${scheme}` });
      return;
    }
    result = extractTenc(mp4, vt.id);
  };
  mp4.appendBuffer(buf);
  mp4.flush();
  mp4.stop();
  return result;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${url}`);
  return resp.arrayBuffer();
}

/**
 * Extract ALL samples from a media segment using the cached init segment.
 * Unlike the thumbnail worker which only needs sync samples, we need every
 * sample to perform in-place mdat decryption.
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
      mp4.setExtractionOptions(vt.id, null, { nbSamples: 100_000 });
      mp4.start();
    };

    mp4.onSamples = (_id: number, _ref: unknown, samples: Sample[]) => {
      for (const s of samples) {
        allSamples.push(s);
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

async function handleExport(msg: Extract<ExportWorkerRequest, { type: "export" }>) {
  const { initSegmentUrl, segments, clearKeyHex } = msg;
  const total = segments.length;

  // 1. Fetch init segment
  const initData = await fetchBuffer(initSegmentUrl);
  if (aborted) return;

  // 2. If encrypted, parse init with mp4box to get tenc info + import key
  let cryptoKey: CryptoKey | null = null;
  let tencInfo: TencInfo | null = null;

  if (clearKeyHex) {
    tencInfo = parseInitTenc(initData);
    if (tencInfo) {
      cryptoKey = await importClearKey(clearKeyHex);
    }
    if (aborted) return;
  }

  // 3. Fetch and optionally decrypt each media segment
  // If decrypting, strip encryption signaling (encv→avc1, remove sinf/pssh)
  // so external tools treat the output as clear content
  const cleanInit = cryptoKey && tencInfo ? stripInitEncryption(initData) : initData;
  const chunks: ArrayBuffer[] = [cleanInit];

  for (let i = 0; i < segments.length; i++) {
    if (aborted) return;

    const segRaw = await fetchBuffer(segments[i].url);
    if (aborted) return;

    if (cryptoKey && tencInfo) {
      // Capture for stable reference across awaits
      const ti = tencInfo;
      const ck = cryptoKey;

      // In-place mdat decryption
      const segBytes = new Uint8Array(segRaw);
      const mdatContent = findBoxData(segBytes, "mdat");

      if (mdatContent) {
        const mdatDataStart = mdatContent.byteOffset - segBytes.byteOffset;
        const ivSize = ti.defaultPerSampleIVSize;
        const sencSamples = parseSencFromSegment(segRaw, ivSize);

        const allSamples = await extractAllSamples(initData, segRaw);
        if (aborted) return;

        let cumulativeOffset = 0;
        for (let j = 0; j < allSamples.length; j++) {
          const sample = allSamples[j];
          const sencEntry = sencSamples[j];

          if (sencEntry) {
            const iv =
              sencEntry.iv.length > 0
                ? sencEntry.iv
                : ti.defaultConstantIV;
            if (iv && iv.length > 0) {
              const sampleData = segBytes.subarray(
                mdatDataStart + cumulativeOffset,
                mdatDataStart + cumulativeOffset + sample.size,
              );
              const decrypted = await decryptSample(
                ck,
                iv,
                sampleData,
                sencEntry.subsamples,
              );
              segBytes.set(decrypted, mdatDataStart + cumulativeOffset);
            }
          }
          cumulativeOffset += sample.size;
        }
      }
    }

    chunks.push(segRaw);
    post({ type: "progress", loaded: i + 1, total });
  }

  // 4. Concatenate init + all media segments
  let totalSize = 0;
  for (const c of chunks) totalSize += c.byteLength;
  const result = new ArrayBuffer(totalSize);
  const resultView = new Uint8Array(result);
  let offset = 0;
  for (const c of chunks) {
    resultView.set(new Uint8Array(c), offset);
    offset += c.byteLength;
  }

  // 5. Post result with transfer
  post({ type: "done", data: result }, [result]);
}

self.onmessage = (e: MessageEvent<ExportWorkerRequest>) => {
  const msg = e.data;

  if (msg.type === "abort") {
    aborted = true;
    return;
  }

  if (msg.type === "export") {
    aborted = false;
    handleExport(msg).catch((err) => {
      if (!aborted) {
        post({ type: "error", message: `${err}` });
      }
    });
  }
};
