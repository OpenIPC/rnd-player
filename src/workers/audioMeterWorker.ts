/**
 * Web Worker that decodes audio segments to PCM and computes metering data.
 *
 * Two modes:
 * 1. Safari fallback ("decode"): decodes fMP4 audio via OfflineAudioContext.decodeAudioData()
 * 2. EC-3 software decode ("decodeEc3"): tries OfflineAudioContext first (Safari),
 *    then falls back to WASM EC-3 decoder (Chrome/Firefox) with mp4box demuxing
 *
 * Flow (Safari fallback):
 * 1. Main thread intercepts audio init + media segments via Shaka response filter
 * 2. Posts init + media ArrayBuffers to this worker
 * 3. Worker concatenates init + media, decodes via OfflineAudioContext.decodeAudioData()
 * 4. Divides PCM into 2048-sample blocks, computes per-channel levels/K-weighting/TruePeak
 * 5. Posts back MeterBlock[] with precise timestamps
 *
 * Flow (EC-3 decode):
 * 1. Main thread fetches EC-3 segments independently
 * 2. Posts init + media ArrayBuffers to this worker
 * 3. Worker tries OfflineAudioContext (Safari), falls back to mp4box demux + WASM decode
 * 4. Computes metering from decoded PCM
 * 5. Posts back MeterBlock[] + per-channel PCM Float32Arrays (transferable)
 */

import { createFile, type MP4BoxBuffer } from "mp4box";
import type { Sample } from "mp4box";
import { createEc3Decoder, type Ec3DecoderInstance } from "../wasm/ec3Decoder";
import { getKWeightCoeffs } from "../utils/kWeighting";
import {
  createBiquadState,
  applyKWeighting,
  type BiquadState,
} from "../utils/biquadProcess";
import { blockMeanSquare } from "../utils/loudnessCompute";
import {
  createTruePeakState,
  processTruePeak,
  type TruePeakState,
} from "../utils/truePeakFilter";

// ── Message types ──

export interface MeterBlock {
  time: number;
  levels: { rms: number; peak: number; dB: number }[];
  kMeanSq: number[];
  truePeaks: number[];
}

export interface AudioMeterRequest {
  type: "decode";
  initData: ArrayBuffer;
  mediaData: ArrayBuffer;
  segmentStartTime: number;
  trackId: number;
}

export interface Ec3DecodeRequest {
  type: "decodeEc3";
  initData: ArrayBuffer;
  mediaData: ArrayBuffer;
  segmentStartTime: number;
  channels: number;
  sampleRate: number;
}

export interface AudioMeterResponse {
  type: "meterBlocks";
  blocks: MeterBlock[];
  segmentStartTime: number;
  trackId: number;
}

export interface Ec3DecodeResponse {
  type: "ec3Decoded";
  /** Per-channel PCM data (transferable) */
  pcmChannels: Float32Array[];
  /** Metering blocks computed from the decoded PCM */
  blocks: MeterBlock[];
  segmentStartTime: number;
  duration: number;
  sampleRate: number;
}

export interface AudioMeterError {
  type: "error";
  message: string;
  segmentStartTime: number;
}

type InMessage = AudioMeterRequest | Ec3DecodeRequest;
type OutMessage = AudioMeterResponse | Ec3DecodeResponse | AudioMeterError;

const BLOCK_SIZE = 2048;

function post(msg: OutMessage) {
  self.postMessage(msg);
}

// Cached WASM decoder instance (reused across segments)
let wasmDecoder: Ec3DecoderInstance | null = null;
let wasmDecoderPromise: Promise<Ec3DecoderInstance | null> | null = null;

self.onmessage = async (e: MessageEvent<InMessage>) => {
  const msg = e.data;

  if (msg.type === "decode") {
    await handleDecode(msg);
  } else if (msg.type === "decodeEc3") {
    await handleDecodeEc3(msg);
  }
};

// ── Safari fallback: decode fMP4 via OfflineAudioContext ──

async function handleDecode(msg: AudioMeterRequest): Promise<void> {
  const { initData, mediaData, segmentStartTime, trackId } = msg;

  try {
    const combined = new Uint8Array(initData.byteLength + mediaData.byteLength);
    combined.set(new Uint8Array(initData), 0);
    combined.set(new Uint8Array(mediaData), initData.byteLength);

    const audioBuffer = await decodeAudioBuffer(combined.buffer);
    const blocks = computeMeterBlocks(audioBuffer, segmentStartTime);

    post({
      type: "meterBlocks",
      blocks,
      segmentStartTime,
      trackId,
    });
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      segmentStartTime,
    });
  }
}

// ── EC-3 software decode ──

async function handleDecodeEc3(msg: Ec3DecodeRequest): Promise<void> {
  const { initData, mediaData, segmentStartTime, channels, sampleRate } = msg;

  try {
    // Try OfflineAudioContext first (works in Safari for EC-3)
    const combined = new Uint8Array(initData.byteLength + mediaData.byteLength);
    combined.set(new Uint8Array(initData), 0);
    combined.set(new Uint8Array(mediaData), initData.byteLength);

    let audioBuffer: AudioBuffer | null = null;
    try {
      audioBuffer = await decodeAudioBuffer(combined.buffer);
    } catch {
      // OfflineAudioContext can't decode EC-3 — fall back to WASM
      console.log("[ec3-worker] OfflineAudioContext failed, trying WASM decoder");
    }

    if (audioBuffer) {
      sendEc3Result(audioBuffer, segmentStartTime);
      return;
    }

    // WASM fallback: demux fMP4 with mp4box, decode EC-3 frames
    const decoder = await getWasmDecoder(channels, sampleRate);
    if (!decoder) {
      post({
        type: "error",
        message: "EC-3 WASM decoder not available. Build with: cd wasm && ./build-ec3.sh",
        segmentStartTime,
      });
      return;
    }

    console.log("[ec3-worker] WASM decoder ready, demuxing fMP4...");
    const samples = await extractSamplesFromFmp4(initData, mediaData);
    console.log(`[ec3-worker] extracted ${samples.length} EC-3 frames`);
    if (samples.length === 0) {
      post({
        type: "error",
        message: "No audio samples found in EC-3 segment",
        segmentStartTime,
      });
      return;
    }

    // Decode each EC-3 frame and collect PCM
    const decodedFrames: Float32Array[][] = [];
    for (const sample of samples) {
      try {
        if (!sample.data) continue;
        const sampleData = sample.data instanceof Uint8Array
          ? sample.data
          : new Uint8Array(sample.data as unknown as ArrayBuffer);
        const pcm = decoder.decode(sampleData);
        if (pcm.length > 0 && pcm[0].length > 0) {
          decodedFrames.push(pcm);
        }
      } catch {
        // Skip corrupt frames
      }
    }

    if (decodedFrames.length === 0) {
      post({
        type: "error",
        message: "All EC-3 frames failed to decode",
        segmentStartTime,
      });
      return;
    }

    // Concatenate decoded frames into continuous per-channel arrays
    const chCount = decodedFrames[0].length;
    const totalSamples = decodedFrames.reduce((sum, f) => sum + f[0].length, 0);
    const pcmChannels: Float32Array[] = [];
    for (let ch = 0; ch < chCount; ch++) {
      const channelData = new Float32Array(totalSamples);
      let offset = 0;
      for (const frame of decodedFrames) {
        if (ch < frame.length) {
          channelData.set(frame[ch], offset);
          offset += frame[ch].length;
        }
      }
      pcmChannels.push(channelData);
    }

    // Compute metering from raw PCM
    const blocks = computeMeterBlocksFromPcm(pcmChannels, sampleRate, segmentStartTime);
    const duration = totalSamples / sampleRate;

    const response: Ec3DecodeResponse = {
      type: "ec3Decoded",
      pcmChannels,
      blocks,
      segmentStartTime,
      duration,
      sampleRate,
    };

    const transfer = pcmChannels.map((ch) => ch.buffer);
    self.postMessage(response, { transfer });
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      segmentStartTime,
    });
  }
}

function sendEc3Result(audioBuffer: AudioBuffer, segmentStartTime: number): void {
  const channelCount = audioBuffer.numberOfChannels;
  const totalSamples = audioBuffer.length;

  const pcmChannels: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch++) {
    pcmChannels.push(new Float32Array(audioBuffer.getChannelData(ch)));
  }

  const blocks = computeMeterBlocks(audioBuffer, segmentStartTime);
  const duration = totalSamples / audioBuffer.sampleRate;

  const response: Ec3DecodeResponse = {
    type: "ec3Decoded",
    pcmChannels,
    blocks,
    segmentStartTime,
    duration,
    sampleRate: audioBuffer.sampleRate,
  };

  const transfer = pcmChannels.map((ch) => ch.buffer);
  self.postMessage(response, { transfer });
}

// ── WASM decoder management ──

async function getWasmDecoder(channels: number, sampleRate: number): Promise<Ec3DecoderInstance | null> {
  if (wasmDecoder) {
    // Reuse if same config, otherwise recreate
    if (wasmDecoder.channels === channels && wasmDecoder.sampleRate === sampleRate) {
      return wasmDecoder;
    }
    wasmDecoder.destroy();
    wasmDecoder = null;
    wasmDecoderPromise = null;
  }

  if (wasmDecoderPromise) return wasmDecoderPromise;

  wasmDecoderPromise = createEc3Decoder(channels, sampleRate)
    .then((dec) => {
      console.log("[ec3-worker] WASM decoder created successfully");
      wasmDecoder = dec;
      return dec;
    })
    .catch((err) => {
      console.error("[ec3-worker] WASM decoder init failed:", err);
      wasmDecoderPromise = null;
      return null;
    });

  return wasmDecoderPromise;
}

// ── fMP4 demuxing via mp4box ──

function extractSamplesFromFmp4(
  initData: ArrayBuffer,
  mediaData: ArrayBuffer,
): Promise<Sample[]> {
  return new Promise((resolve, reject) => {
    const mp4 = createFile();
    const samples: Sample[] = [];

    mp4.onReady = (info) => {
      const audioTrack = info.audioTracks[0];
      if (!audioTrack) {
        reject(new Error("No audio track in fMP4"));
        return;
      }
      mp4.setExtractionOptions(audioTrack.id, null, {
        nbSamples: Infinity,
      });
      mp4.start();
    };

    mp4.onSamples = (_trackId: number, _user: unknown, sampleArr: Sample[]) => {
      for (const s of sampleArr) {
        if (!s.data) continue;
        // Eagerly copy sample data — mp4box reuses internal buffers
        const src = s.data instanceof Uint8Array ? s.data : new Uint8Array(s.data as ArrayBuffer);
        const copy = new Uint8Array(s.size);
        copy.set(src.subarray(0, s.size));
        samples.push({ ...s, data: copy });
      }
    };

    mp4.onError = (e: string) => reject(new Error(e));

    try {
      // Feed init segment
      const initBuf = initData.slice(0) as MP4BoxBuffer;
      initBuf.fileStart = 0;
      mp4.appendBuffer(initBuf);

      // Feed media segment
      const mediaBuf = mediaData.slice(0) as MP4BoxBuffer;
      mediaBuf.fileStart = initData.byteLength;
      mp4.appendBuffer(mediaBuf);

      mp4.flush();

      // Resolve with collected samples
      resolve(samples);
    } catch (err) {
      reject(err);
    }
  });
}

// ── Shared metering computation ──

function computeMeterBlocks(audioBuffer: AudioBuffer, segmentStartTime: number): MeterBlock[] {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  return computeMeterBlocksFromPcm(channels, audioBuffer.sampleRate, segmentStartTime);
}

function computeMeterBlocksFromPcm(
  channels: Float32Array[],
  sampleRate: number,
  segmentStartTime: number,
): MeterBlock[] {
  const channelCount = channels.length;
  const totalSamples = channels[0]?.length ?? 0;

  const kCoeffs = getKWeightCoeffs(sampleRate);

  const shelfStates: BiquadState[] = [];
  const hpfStates: BiquadState[] = [];
  const truePeakStates: TruePeakState[] = [];
  for (let ch = 0; ch < channelCount; ch++) {
    shelfStates.push(createBiquadState());
    hpfStates.push(createBiquadState());
    truePeakStates.push(createTruePeakState());
  }

  const blocks: MeterBlock[] = [];

  for (let offset = 0; offset + BLOCK_SIZE <= totalSamples; offset += BLOCK_SIZE) {
    const time = segmentStartTime + (offset / sampleRate);
    const levels: { rms: number; peak: number; dB: number }[] = [];
    const kMeanSq: number[] = [];
    const truePeaks: number[] = [];

    for (let ch = 0; ch < channelCount; ch++) {
      const samples = channels[ch].subarray(offset, offset + BLOCK_SIZE);

      let sumSq = 0;
      let peak = 0;
      for (let j = 0; j < samples.length; j++) {
        const s = samples[j];
        sumSq += s * s;
        const abs = Math.abs(s);
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sumSq / samples.length);
      const dB = rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
      levels.push({ rms, peak, dB });

      const kWeighted = applyKWeighting(samples, kCoeffs, shelfStates[ch], hpfStates[ch]);
      kMeanSq.push(blockMeanSquare(kWeighted));

      truePeaks.push(processTruePeak(truePeakStates[ch], samples));
    }

    blocks.push({ time, levels, kMeanSq, truePeaks });
  }

  return blocks;
}

/**
 * Decode an ArrayBuffer containing audio (fMP4) to an AudioBuffer.
 * Uses OfflineAudioContext.decodeAudioData which supports fMP4 in Safari.
 */
async function decodeAudioBuffer(data: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, 48000 * 30, 48000);
  return ctx.decodeAudioData(data);
}
