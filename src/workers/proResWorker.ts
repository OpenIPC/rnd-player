/**
 * Web Worker for ProRes frame decoding via Range requests + WASM.
 *
 * Each worker instance holds:
 *   - Its own WASM ProRes decoder
 *   - The sample table for byte-offset lookups
 *   - An AbortController per active request for cancellation
 *
 * Messages:
 *   init → store URL + sample table, instantiate decoder
 *   decodeFrame → Range-fetch + WASM decode → transfer YUV planes back
 *   cancel → abort fetch for a given requestId
 */

import { createProResDecoder } from "../wasm/proresDecoder";
import type { ProResDecoderInstance } from "../wasm/proresDecoder";
import type {
  ProResWorkerRequest,
  ProResWorkerResponse,
  SampleTableEntry,
} from "../types/proResWorker.types";

let decoder: ProResDecoderInstance | null = null;
let url = "";
let sampleTable: SampleTableEntry[] = [];
let fourcc = "apcn"; // default, overridden by init
let is444 = false;
let videoWidth = 0;
let videoHeight = 0;

const pendingAborts = new Map<number, AbortController>();

function post(msg: ProResWorkerResponse, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

async function handleInit(
  initUrl: string,
  initSampleTable: SampleTableEntry[],
  initFourcc: string,
  initIs444: boolean,
  initWidth: number,
  initHeight: number,
  wasmModule?: WebAssembly.Module,
) {
  url = initUrl;
  sampleTable = initSampleTable;
  fourcc = initFourcc;
  is444 = initIs444;
  videoWidth = initWidth;
  videoHeight = initHeight;

  try {
    decoder = await createProResDecoder(fourcc, wasmModule);
    post({ type: "ready" });
  } catch (e) {
    post({
      type: "error",
      requestId: -1,
      message: `Failed to init decoder: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function handleDecodeFrame(requestId: number, frameIndex: number) {
  if (!decoder) {
    post({ type: "error", requestId, message: "Decoder not initialized" });
    return;
  }

  if (frameIndex < 0 || frameIndex >= sampleTable.length) {
    post({
      type: "error",
      requestId,
      message: `Frame index ${frameIndex} out of range [0, ${sampleTable.length})`,
    });
    return;
  }

  const entry = sampleTable[frameIndex];
  const abort = new AbortController();
  pendingAborts.set(requestId, abort);

  try {
    const rangeEnd = entry.offset + entry.size - 1;
    const response = await fetch(url, {
      headers: { Range: `bytes=${entry.offset}-${rangeEnd}` },
      signal: abort.signal,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} fetching frame ${frameIndex}`);
    }

    const frameData = new Uint8Array(await response.arrayBuffer());

    const frame = decoder.decode(frameData, videoWidth, videoHeight, is444);

    // Transfer the typed array buffers (zero-copy)
    const transfer: Transferable[] = [
      frame.yPlane.buffer,
      frame.cbPlane.buffer,
      frame.crPlane.buffer,
    ];
    if (frame.alphaPlane) {
      transfer.push(frame.alphaPlane.buffer);
    }

    post({ type: "frame", requestId, frameIndex, frame }, transfer);
  } catch (e) {
    if ((e as Error).name === "AbortError") return; // cancelled
    post({
      type: "error",
      requestId,
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    pendingAborts.delete(requestId);
  }
}

async function handleDecodeBatch(requestId: number, startFrame: number, count: number) {
  if (!decoder) {
    post({ type: "error", requestId, message: "Decoder not initialized" });
    return;
  }

  const endFrame = Math.min(startFrame + count, sampleTable.length);
  if (startFrame < 0 || startFrame >= sampleTable.length || endFrame <= startFrame) {
    post({ type: "error", requestId, message: `Batch range [${startFrame}, ${endFrame}) invalid` });
    return;
  }

  const abort = new AbortController();
  pendingAborts.set(requestId, abort);

  try {
    // Single Range request covering all frames in the batch
    const firstEntry = sampleTable[startFrame];
    const lastEntry = sampleTable[endFrame - 1];
    const rangeStart = firstEntry.offset;
    const rangeEnd = lastEntry.offset + lastEntry.size - 1;

    const response = await fetch(url, {
      headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
      signal: abort.signal,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} fetching batch [${startFrame}, ${endFrame})`);
    }

    const allData = new Uint8Array(await response.arrayBuffer());

    // Decode each frame from the contiguous buffer
    for (let i = startFrame; i < endFrame; i++) {
      if (abort.signal.aborted) return;

      const entry = sampleTable[i];
      const relOffset = entry.offset - rangeStart;
      const frameData = allData.subarray(relOffset, relOffset + entry.size);

      const frame = decoder.decode(frameData, videoWidth, videoHeight, is444);

      const transfer: Transferable[] = [
        frame.yPlane.buffer,
        frame.cbPlane.buffer,
        frame.crPlane.buffer,
      ];
      if (frame.alphaPlane) {
        transfer.push(frame.alphaPlane.buffer);
      }

      post({ type: "frame", requestId, frameIndex: i, frame }, transfer);
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    post({
      type: "error",
      requestId,
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    pendingAborts.delete(requestId);
  }
}

async function handleDecodePipeline(
  requestId: number,
  startFrame: number,
  endFrame: number,
  batchSize: number,
) {
  if (!decoder) {
    post({ type: "error", requestId, message: "Decoder not initialized" });
    return;
  }

  const clampedEnd = Math.min(endFrame, sampleTable.length);
  if (startFrame < 0 || startFrame >= sampleTable.length || clampedEnd <= startFrame) {
    post({ type: "error", requestId, message: `Pipeline range [${startFrame}, ${endFrame}) invalid` });
    return;
  }

  const abort = new AbortController();
  pendingAborts.set(requestId, abort);

  try {
    for (let batchStart = startFrame; batchStart < clampedEnd; batchStart += batchSize) {
      if (abort.signal.aborted) return;

      const batchEnd = Math.min(batchStart + batchSize, clampedEnd);
      const firstEntry = sampleTable[batchStart];
      const lastEntry = sampleTable[batchEnd - 1];
      const rangeStart = firstEntry.offset;
      const rangeEnd = lastEntry.offset + lastEntry.size - 1;

      const response = await fetch(url, {
        headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
        signal: abort.signal,
      });

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status} fetching pipeline batch [${batchStart}, ${batchEnd})`);
      }

      const allData = new Uint8Array(await response.arrayBuffer());

      for (let i = batchStart; i < batchEnd; i++) {
        if (abort.signal.aborted) return;

        const entry = sampleTable[i];
        const relOffset = entry.offset - rangeStart;
        const frameData = allData.subarray(relOffset, relOffset + entry.size);

        const frame = decoder.decode(frameData, videoWidth, videoHeight, is444);

        const transfer: Transferable[] = [
          frame.yPlane.buffer,
          frame.cbPlane.buffer,
          frame.crPlane.buffer,
        ];
        if (frame.alphaPlane) {
          transfer.push(frame.alphaPlane.buffer);
        }

        post({ type: "frame", requestId, frameIndex: i, frame }, transfer);
      }
    }

    post({ type: "pipelineDone", requestId });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    post({
      type: "error",
      requestId,
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    pendingAborts.delete(requestId);
  }
}

function handleDecodeOnly(requestId: number, frameIndex: number, frameData: Uint8Array) {
  if (!decoder) {
    post({ type: "error", requestId, message: "Decoder not initialized" });
    return;
  }

  try {
    const frame = decoder.decode(frameData, videoWidth, videoHeight, is444);

    const transfer: Transferable[] = [
      frame.yPlane.buffer,
      frame.cbPlane.buffer,
      frame.crPlane.buffer,
    ];
    if (frame.alphaPlane) {
      transfer.push(frame.alphaPlane.buffer);
    }

    post({ type: "frame", requestId, frameIndex, frame }, transfer);
  } catch (e) {
    post({
      type: "error",
      requestId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

self.onmessage = (e: MessageEvent<ProResWorkerRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      handleInit(msg.url, msg.sampleTable, msg.fourcc, msg.is444, msg.width, msg.height, msg.wasmModule);
      break;
    case "decodeFrame":
      handleDecodeFrame(msg.requestId, msg.frameIndex);
      break;
    case "decodeBatch":
      handleDecodeBatch(msg.requestId, msg.startFrame, msg.count);
      break;
    case "decodePipeline":
      handleDecodePipeline(msg.requestId, msg.startFrame, msg.endFrame, msg.batchSize);
      break;
    case "decodeOnly":
      handleDecodeOnly(msg.requestId, msg.frameIndex, msg.frameData);
      break;
    case "cancel": {
      const ctrl = pendingAborts.get(msg.requestId);
      if (ctrl) {
        ctrl.abort();
        pendingAborts.delete(msg.requestId);
      }
      break;
    }
  }
};
