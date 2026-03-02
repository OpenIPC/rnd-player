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

/** Worker can't decode AAC (no OfflineAudioContext) — sends ADTS back for main-thread decode */
export interface NeedsMainDecodeResponse {
  type: "needsMainDecode";
  adtsData: ArrayBuffer;
  segmentStartTime: number;
  channels: number;
  sampleRate: number;
}

type InMessage = AudioMeterRequest | Ec3DecodeRequest;
type OutMessage = AudioMeterResponse | Ec3DecodeResponse | AudioMeterError | NeedsMainDecodeResponse;

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
    // Stage 1: Try OfflineAudioContext on raw fMP4 (works in Safari for most codecs)
    const combined = new Uint8Array(initData.byteLength + mediaData.byteLength);
    combined.set(new Uint8Array(initData), 0);
    combined.set(new Uint8Array(mediaData), initData.byteLength);

    let audioBuffer: AudioBuffer | null = null;
    try {
      audioBuffer = await decodeAudioBuffer(combined.buffer, channels, sampleRate);
    } catch {
      // Expected in Chrome/Firefox — OfflineAudioContext not in worker or fMP4 not supported
    }

    if (audioBuffer) {
      sendEc3Result(audioBuffer, segmentStartTime);
      return;
    }

    // Stage 2: Demux fMP4 via mp4box — needed for both ADTS and WASM fallbacks
    let trackInfo: Fmp4TrackInfo;
    try {
      trackInfo = await extractSamplesWithInfo(initData, mediaData);
    } catch (extractErr) {
      post({
        type: "error",
        message: `mp4box extraction failed: ${(extractErr as Error).message}`,
        segmentStartTime,
      });
      return;
    }

    // Stage 2a: ADTS fallback — works for AAC in all browsers
    const adtsStream = buildAdtsStream(
      trackInfo.samples, trackInfo.codec, trackInfo.sampleRate, trackInfo.channelCount,
    );

    if (adtsStream) {
      if (typeof OfflineAudioContext !== "undefined") {
        // Decode in worker
        const adtsPcm = await decodeAdtsStream(
          adtsStream, trackInfo.samples.length, trackInfo.sampleRate, trackInfo.channelCount,
        );
        if (adtsPcm) {
          const blocks = computeMeterBlocksFromPcm(adtsPcm, trackInfo.sampleRate, segmentStartTime);
          const duration = (adtsPcm[0]?.length ?? 0) / trackInfo.sampleRate;
          const response: Ec3DecodeResponse = {
            type: "ec3Decoded",
            pcmChannels: adtsPcm,
            blocks,
            segmentStartTime,
            duration,
            sampleRate: trackInfo.sampleRate,
          };
          const transfer = adtsPcm.map((ch) => ch.buffer);
          self.postMessage(response, { transfer });
          return;
        }
      } else {
        // OfflineAudioContext not available in worker — send ADTS back to main thread
        const response: NeedsMainDecodeResponse = {
          type: "needsMainDecode",
          adtsData: adtsStream.buffer as ArrayBuffer,
          segmentStartTime,
          channels: trackInfo.channelCount,
          sampleRate: trackInfo.sampleRate,
        };
        self.postMessage(response, { transfer: [adtsStream.buffer as ArrayBuffer] });
        return;
      }
    }

    // Stage 3: WASM EC-3/AC-3 decoder fallback
    const decoder = await getWasmDecoder(channels, sampleRate);
    if (!decoder) {
      post({
        type: "error",
        message: "Audio decode failed: no ADTS or WASM decoder available for this codec",
        segmentStartTime,
      });
      return;
    }

    const samples = trackInfo.samples;
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
      wasmDecoder = dec;
      return dec;
    })
    .catch((err) => {
      console.warn("[audioMeterWorker] WASM EC-3 decoder init failed:", err);
      wasmDecoderPromise = null;
      return null;
    });

  return wasmDecoderPromise;
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
async function decodeAudioBuffer(data: ArrayBuffer, channels = 6, sampleRate = 48000): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(channels, sampleRate * 30, sampleRate);
  return ctx.decodeAudioData(data);
}

// ── ADTS-wrapped AAC decode (fallback for Chrome/Firefox where fMP4 decodeAudioData fails) ──

/** Sample rate → ADTS frequency index (ISO 14496-3 Table 1.18) */
const ADTS_FREQ_INDEX: Record<number, number> = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
  24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11, 7350: 12,
};

/** Extract AAC object type from codec string: "mp4a.40.2" → 2, "mp4a.40.5" → 5 */
function parseAacObjectType(codec: string): number {
  const match = codec.match(/mp4a\.40\.(\d+)/);
  if (match) return parseInt(match[1], 10);
  // Default to AAC-LC if codec is just "mp4a" or unrecognized
  if (codec.startsWith("mp4a")) return 2;
  return 0;
}

interface Fmp4TrackInfo {
  samples: Sample[];
  codec: string;
  sampleRate: number;
  channelCount: number;
}

/**
 * Extract audio samples from fMP4, returning track metadata alongside samples.
 */
function extractSamplesWithInfo(
  initData: ArrayBuffer,
  mediaData: ArrayBuffer,
): Promise<Fmp4TrackInfo> {
  return new Promise((resolve, reject) => {
    const mp4 = createFile();
    const samples: Sample[] = [];
    let trackCodec = "";
    let trackSampleRate = 48000;
    let trackChannelCount = 2;

    mp4.onReady = (info) => {
      const audioTrack = info.audioTracks[0];
      if (!audioTrack) {
        reject(new Error("No audio track in fMP4"));
        return;
      }
      trackCodec = (audioTrack as { codec?: string }).codec ?? "";
      trackSampleRate = (audioTrack as { audio?: { sample_rate?: number } }).audio?.sample_rate ?? 48000;
      trackChannelCount = (audioTrack as { audio?: { channel_count?: number } }).audio?.channel_count ?? 2;
      mp4.setExtractionOptions(audioTrack.id, null, { nbSamples: Infinity });
      mp4.start();
    };

    mp4.onSamples = (_trackId: number, _user: unknown, sampleArr: Sample[]) => {
      for (const s of sampleArr) {
        if (!s.data) continue;
        const src = s.data instanceof Uint8Array ? s.data : new Uint8Array(s.data as ArrayBuffer);
        const copy = new Uint8Array(s.size);
        copy.set(src.subarray(0, s.size));
        samples.push({ ...s, data: copy });
      }
    };

    mp4.onError = (e: string) => reject(new Error(e));

    try {
      const initBuf = initData.slice(0) as MP4BoxBuffer;
      initBuf.fileStart = 0;
      mp4.appendBuffer(initBuf);

      const mediaBuf = mediaData.slice(0) as MP4BoxBuffer;
      mediaBuf.fileStart = initData.byteLength;
      mp4.appendBuffer(mediaBuf);

      mp4.flush();
      resolve({ samples, codec: trackCodec, sampleRate: trackSampleRate, channelCount: trackChannelCount });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Build an ADTS-wrapped byte stream from raw AAC samples.
 * Returns null if the codec isn't AAC or sample rate isn't recognized.
 */
function buildAdtsStream(
  samples: Sample[],
  codec: string,
  sampleRate: number,
  channelCount: number,
): Uint8Array | null {
  if (samples.length === 0) return null;

  const objectType = parseAacObjectType(codec);
  if (objectType === 0) return null;

  const freqIdx = ADTS_FREQ_INDEX[sampleRate];
  if (freqIdx === undefined) return null;

  const profile = Math.min(objectType - 1, 3);
  const chanConfig = Math.min(channelCount, 7);

  let totalSize = 0;
  for (const s of samples) {
    if (s.data) totalSize += 7 + s.data.byteLength;
  }

  const adtsStream = new Uint8Array(totalSize);
  let offset = 0;

  for (const s of samples) {
    if (!s.data) continue;
    const frameLen = 7 + s.data.byteLength;

    adtsStream[offset + 0] = 0xFF;
    adtsStream[offset + 1] = 0xF1;
    adtsStream[offset + 2] = ((profile << 6) | (freqIdx << 2) | (chanConfig >> 2)) & 0xFF;
    adtsStream[offset + 3] = (((chanConfig & 3) << 6) | ((frameLen >> 11) & 3)) & 0xFF;
    adtsStream[offset + 4] = ((frameLen >> 3) & 0xFF);
    adtsStream[offset + 5] = (((frameLen & 7) << 5) | 0x1F) & 0xFF;
    adtsStream[offset + 6] = 0xFC;

    const src = s.data instanceof Uint8Array ? s.data : new Uint8Array(s.data as ArrayBuffer);
    adtsStream.set(src.subarray(0, s.data.byteLength), offset + 7);
    offset += frameLen;
  }

  return adtsStream;
}

/**
 * Decode an ADTS byte stream via OfflineAudioContext.
 * Only works when OfflineAudioContext is available (Safari workers, main thread).
 */
async function decodeAdtsStream(
  adtsStream: Uint8Array,
  frameCount: number,
  sampleRate: number,
  channelCount: number,
): Promise<Float32Array[] | null> {
  try {
    const duration = Math.max(30, frameCount * 1024 / sampleRate + 1);
    const ctx = new OfflineAudioContext(channelCount, Math.ceil(duration * sampleRate), sampleRate);
    const audioBuffer = await ctx.decodeAudioData(adtsStream.buffer as ArrayBuffer);

    const channels: Float32Array[] = [];
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      channels.push(new Float32Array(audioBuffer.getChannelData(ch)));
    }
    return channels;
  } catch {
    return null;
  }
}
