/**
 * Fallback audio metering hook for Safari where MediaElementAudioSourceNode
 * returns silence for MSE-backed media (WebKit bugs #266922, #180696).
 *
 * Instead of routing audio through Web Audio's AnalyserNode, this hook:
 * 1. Extracts the audio stream init segment URL from Shaka's manifest
 * 2. Fetches + extracts raw AAC samples via mp4box
 * 3. Wraps samples in ADTS headers and decodes via OfflineAudioContext
 * 4. Computes metering data (RMS, K-weighted, TruePeak) per 2048-sample block
 * 5. Caches MeterBlock[] indexed by time
 * 6. On each readLevels()/readLoudness() call, looks up the block closest
 *    to video.currentTime and returns pre-computed data
 *
 * This provides the same interface as useAudioAnalyser + useLoudnessMeter
 * so AudioLevels.tsx can swap transparently.
 */

import { useEffect, useRef, useCallback } from "react";
import { createFile, MP4BoxBuffer } from "mp4box";
import type { Sample } from "mp4box";
import shaka from "shaka-player";
import type { ChannelLevel } from "./useAudioAnalyser";
import type { LoudnessData } from "./useLoudnessMeter";
import type { MeterBlock } from "../workers/audioMeterWorker";
import { findBoxData, extractTrackIdFromTfhd } from "../workers/cencDecrypt";
import { extractInitSegmentUrl } from "../utils/extractInitSegmentUrl";
import { getKWeightCoeffs } from "../utils/kWeighting";
import { createBiquadState, applyKWeighting, type BiquadState } from "../utils/biquadProcess";
import { blockMeanSquare } from "../utils/loudnessCompute";
import { createTruePeakState, processTruePeak, type TruePeakState } from "../utils/truePeakFilter";
import {
  windowedLufs,
  createGatingState,
  addGatingBlock,
  computeIntegratedLoudness,
  resetGatingState,
  createLraState,
  addLraBlock,
  computeLra,
  resetLraState,
  type GatingState,
  type LraState,
} from "../utils/loudnessCompute";

const CHANNEL_LABELS: Record<number, string[]> = {
  1: ["M"],
  2: ["L", "R"],
  6: ["FL", "FR", "C", "LFE", "SL", "SR"],
};

/** Evict blocks more than ±30s from playback position */
const EVICTION_WINDOW = 30;

/** Block size matching AnalyserNode FFT size (~42ms at 48kHz) */
const BLOCK_SIZE = 2048;

export function useAudioMeterFallback(
  videoEl: HTMLVideoElement | null,
  player: shaka.Player | null,
  enabled: boolean,
): {
  readLevels: () => { levels: ChannelLevel[]; error: string | null };
  readLoudness: () => LoudnessData | null;
  resetIntegrated: () => void;
} {
  const blocksRef = useRef<MeterBlock[]>([]);
  const lastBlockIdxRef = useRef(0);
  const channelCountRef = useRef(2);

  // Audio track init data cache: trackId → init bytes
  const audioTrackIdsRef = useRef<Set<number>>(new Set());
  const initDataRef = useRef<Map<number, ArrayBuffer>>(new Map());
  const timescaleRef = useRef<Map<number, number>>(new Map());

  // Cached audio track config per track (extracted from init segment)
  const audioConfigRef = useRef<Map<number, AudioTrackConfig>>(new Map());

  // Presentation time offset: tfdt media time minus Shaka presentation time.
  // DASH segments use an internal media timeline that differs from the
  // presentation timeline by a fixed offset (presentationTimeOffset).
  const ptoRef = useRef<number | null>(null);

  // LUFS ring buffers (same structure as useLoudnessMeter)
  const momentaryRingRef = useRef<number[][]>([]);
  const shortTermRingRef = useRef<number[][]>([]);
  const momentaryIdxRef = useRef(0);
  const shortTermIdxRef = useRef(0);
  const momentaryCountRef = useRef(0);
  const shortTermCountRef = useRef(0);
  const momentaryCapRef = useRef(10);
  const shortTermCapRef = useRef(71);
  const gatingRef = useRef<GatingState | null>(null);
  const lraRef = useRef<LraState | null>(null);
  const blockCounterRef = useRef(0);

  // Track which segments we've already processed
  const processedSegmentsRef = useRef<Set<string>>(new Set());

  // Response filter reference for cleanup
  const filterRef = useRef<shaka.extern.ResponseFilter | null>(null);

  useEffect(() => {
    if (!enabled || !videoEl || !player) {
      if (filterRef.current && player) {
        const net = player.getNetworkingEngine();
        if (net) {
          net.unregisterResponseFilter(filterRef.current);
        }
        filterRef.current = null;
      }
      blocksRef.current = [];
      lastBlockIdxRef.current = 0;
      audioTrackIdsRef.current.clear();
      initDataRef.current.clear();
      timescaleRef.current.clear();
      audioConfigRef.current.clear();
      processedSegmentsRef.current.clear();
      ptoRef.current = null;
      return;
    }

    // Initialize LUFS state (48kHz default, adjusted on first block)
    const sampleRate = 48000;
    const blocksPerSec = sampleRate / BLOCK_SIZE;
    const mCap = Math.ceil(0.4 * blocksPerSec);
    const sCap = Math.ceil(3.0 * blocksPerSec);
    momentaryCapRef.current = mCap;
    shortTermCapRef.current = sCap;
    momentaryRingRef.current = new Array(mCap).fill(null).map(() => new Array(2).fill(0));
    shortTermRingRef.current = new Array(sCap).fill(null).map(() => new Array(2).fill(0));
    momentaryIdxRef.current = 0;
    shortTermIdxRef.current = 0;
    momentaryCountRef.current = 0;
    shortTermCountRef.current = 0;
    blockCounterRef.current = 0;
    gatingRef.current = createGatingState(2);
    lraRef.current = createLraState(2);

    let destroyed = false;

    // Proactively fetch the init segment from the manifest — by the time
    // AudioLevels opens, Shaka has already fetched it via its own pipeline.
    bootstrapFromManifest(player).catch(() => { /* non-critical */ });

    // Register response filter to intercept ongoing media segments
    const responseFilter: shaka.extern.ResponseFilter = async (
      type: shaka.net.NetworkingEngine.RequestType,
      response: shaka.extern.Response,
    ) => {
      if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT) return;
      if (destroyed) return;

      const rawData: ArrayBuffer = ArrayBuffer.isView(response.data)
        ? (response.data.buffer.slice(
            response.data.byteOffset,
            response.data.byteOffset + response.data.byteLength,
          ) as ArrayBuffer)
        : (response.data as ArrayBuffer);

      const data = new Uint8Array(rawData);
      const hasMoov = findBoxData(data, "moov") !== null;
      const hasMoof = findBoxData(data, "moof") !== null;

      if (hasMoov) {
        parseAndCacheInitSegment(rawData);
        return;
      }

      if (hasMoof && !hasMoov) {
        await decodeAndMeterSegment(data, rawData);
      }
    };

    const net = player.getNetworkingEngine();
    if (net) {
      net.registerResponseFilter(responseFilter);
      filterRef.current = responseFilter;
    }

    return () => {
      destroyed = true;
      if (filterRef.current) {
        const n = player.getNetworkingEngine();
        if (n) {
          n.unregisterResponseFilter(filterRef.current);
        }
        filterRef.current = null;
      }
      blocksRef.current = [];
      lastBlockIdxRef.current = 0;
      audioTrackIdsRef.current.clear();
      initDataRef.current.clear();
      timescaleRef.current.clear();
      audioConfigRef.current.clear();
      processedSegmentsRef.current.clear();
      ptoRef.current = null;
    };
  }, [enabled, videoEl, player]);

  // ── Internal helpers (closures over refs) ──

  function parseAndCacheInitSegment(rawData: ArrayBuffer): void {
    try {
      const mp4 = createFile();
      const initCopy = rawData.slice(0);
      mp4.onReady = (info) => {
        for (const track of info.audioTracks) {
          audioTrackIdsRef.current.add(track.id);
          initDataRef.current.set(track.id, initCopy);
          timescaleRef.current.set(track.id, track.timescale ?? 48000);

          const config = extractAudioTrackConfig(track);
          if (config) {
            audioConfigRef.current.set(track.id, config);
          }
        }
      };
      const buf = MP4BoxBuffer.fromArrayBuffer(rawData.slice(0), 0);
      mp4.appendBuffer(buf);
      mp4.flush();
      mp4.stop();
    } catch {
      // Non-critical
    }
  }

  /**
   * Decode a media segment and compute metering blocks.
   * Extracts raw AAC samples via mp4box, wraps in ADTS headers,
   * decodes via OfflineAudioContext, then computes per-block metering.
   */
  async function decodeAndMeterSegment(
    data: Uint8Array,
    rawData: ArrayBuffer,
  ): Promise<void> {
    const trackId = extractTrackIdFromTfhd(data);
    if (trackId === null) return;
    if (!audioTrackIdsRef.current.has(trackId)) return;

    const initData = initDataRef.current.get(trackId);
    if (!initData) return;

    const timescale = timescaleRef.current.get(trackId) ?? 48000;
    const mediaTime = extractTfdt(data, timescale);
    const segmentStartTime = ptoRef.current !== null ? mediaTime - ptoRef.current : mediaTime;

    const segKey = `${trackId}:${mediaTime.toFixed(4)}`;
    if (processedSegmentsRef.current.has(segKey)) return;
    processedSegmentsRef.current.add(segKey);

    const config = audioConfigRef.current.get(trackId);
    if (!config) return;

    try {
      const samples = await extractAudioSamples(initData, rawData, trackId);
      if (samples.length === 0) return;

      const pcm = await decodeAudioSamples(
        samples,
        config.codec,
        config.sampleRate,
        config.numberOfChannels,
      );
      if (!pcm || pcm.channels.length === 0 || pcm.channels[0].length === 0) return;

      const blocks = computeMeterBlocksFromPcm(
        pcm.channels,
        pcm.sampleRate,
        segmentStartTime,
      );
      if (blocks.length === 0) return;

      // Update channel count if needed
      const chCount = blocks[0].levels.length;
      if (chCount !== channelCountRef.current) {
        channelCountRef.current = chCount;
        momentaryRingRef.current = new Array(momentaryCapRef.current).fill(null).map(() => new Array(chCount).fill(0));
        shortTermRingRef.current = new Array(shortTermCapRef.current).fill(null).map(() => new Array(chCount).fill(0));
        momentaryIdxRef.current = 0;
        shortTermIdxRef.current = 0;
        momentaryCountRef.current = 0;
        shortTermCountRef.current = 0;
        blockCounterRef.current = 0;
        gatingRef.current = createGatingState(chCount);
        lraRef.current = createLraState(chCount);
      }

      // Insert blocks in sorted order
      const existing = blocksRef.current;
      const insertIdx = binarySearchInsertIdx(existing, blocks[0].time);
      existing.splice(insertIdx, 0, ...blocks);

      // Evict old blocks
      if (videoEl) {
        evictBlocks(existing, videoEl.currentTime);
      }
    } catch (err) {
      console.warn("[audioMeterFallback] Decode error:", err);
    }
  }

  async function bootstrapFromManifest(shakaPlayer: shaka.Player): Promise<void> {
    const manifest = shakaPlayer.getManifest();
    if (!manifest?.variants?.length) return;

    // Find the active audio stream
    const activeVariant = shakaPlayer.getVariantTracks().find((t) => t.active);
    let audioStream: shaka.extern.Stream | null = null;

    for (const variant of manifest.variants) {
      if (variant.audio) {
        if (activeVariant && variant.audio.id === activeVariant.audioId) {
          audioStream = variant.audio;
          break;
        }
        if (!audioStream) audioStream = variant.audio;
      }
    }
    if (!audioStream) return;

    // Build segment index
    await audioStream.createSegmentIndex();
    const segmentIndex = audioStream.segmentIndex;
    if (!segmentIndex) return;

    // Extract init segment URL from the first reference
    const iter = segmentIndex[Symbol.iterator]();
    const firstResult = iter.next();
    if (firstResult.done || !firstResult.value) return;

    const initUrl = extractInitSegmentUrl(firstResult.value);
    if (!initUrl) return;

    // Fetch and parse the init segment
    try {
      const resp = await fetch(initUrl);
      if (!resp.ok) return;
      const initBytes = await resp.arrayBuffer();
      parseAndCacheInitSegment(initBytes);
    } catch {
      return;
    }

    if (audioTrackIdsRef.current.size === 0) return;

    // Collect media segment references around current playback position
    const currentTime = videoEl?.currentTime ?? 0;
    const ahead = 10;
    const refs: shaka.media.SegmentReference[] = [];
    for (const ref of segmentIndex) {
      if (!ref) continue;
      if (ref.getEndTime() < currentTime - 2) continue;
      if (ref.getStartTime() > currentTime + ahead) break;
      refs.push(ref);
    }

    // Compute presentation time offset from the first segment:
    // PTO = tfdt_media_time - shaka_presentation_time
    if (ptoRef.current === null && refs.length > 0) {
      const firstRef = refs[0];
      const firstUris = firstRef.getUris();
      if (firstUris.length > 0) {
        try {
          const resp = await fetch(firstUris[0]);
          if (resp.ok) {
            const mediaBytes = await resp.arrayBuffer();
            const data = new Uint8Array(mediaBytes);
            const firstTrackId = [...audioTrackIdsRef.current][0];
            const ts = timescaleRef.current.get(firstTrackId) ?? 48000;
            const mediaTime = extractTfdt(data, ts);
            ptoRef.current = mediaTime - firstRef.getStartTime();
            // Decode this first segment (already fetched)
            await decodeAndMeterSegment(data, mediaBytes);
          }
        } catch {
          // PTO stays null — times will be raw media time
        }
      }
    }

    // Fetch + decode remaining segments
    await Promise.all(
      refs.map(async (ref) => {
        const uris = ref.getUris();
        if (uris.length === 0) return;
        if (ptoRef.current !== null && ref === refs[0]) return;
        try {
          const resp = await fetch(uris[0]);
          if (!resp.ok) return;
          const mediaBytes = await resp.arrayBuffer();
          const data = new Uint8Array(mediaBytes);
          await decodeAndMeterSegment(data, mediaBytes);
        } catch {
          // Non-critical
        }
      }),
    );
  }

  const readLevels = useCallback((): { levels: ChannelLevel[]; error: string | null } => {
    if (!enabled || !videoEl) {
      return { levels: [], error: null };
    }

    const blocks = blocksRef.current;
    if (blocks.length === 0) {
      return { levels: [], error: null };
    }

    const currentTime = videoEl.currentTime;
    const idx = findClosestBlock(blocks, currentTime, lastBlockIdxRef.current);
    lastBlockIdxRef.current = idx;

    const block = blocks[idx];
    if (Math.abs(block.time - currentTime) > 0.15) {
      return { levels: [], error: null };
    }

    const chCount = block.levels.length;
    const labels = CHANNEL_LABELS[chCount] ?? Array.from({ length: chCount }, (_, i) => `${i + 1}`);

    const levels: ChannelLevel[] = block.levels.map((l, i) => ({
      rms: l.rms,
      peak: l.peak,
      dB: l.dB,
      label: labels[i] ?? `${i + 1}`,
    }));

    return { levels, error: null };
  }, [enabled, videoEl]);

  const readLoudness = useCallback((): LoudnessData | null => {
    if (!enabled || !videoEl) return null;

    const blocks = blocksRef.current;
    if (blocks.length === 0) return null;

    const currentTime = videoEl.currentTime;
    const idx = findClosestBlock(blocks, currentTime, lastBlockIdxRef.current);
    const block = blocks[idx];

    if (Math.abs(block.time - currentTime) > 0.15) return null;

    const chCount = block.kMeanSq.length;

    const mCap = momentaryCapRef.current;
    const mIdx = momentaryIdxRef.current;
    momentaryRingRef.current[mIdx] = [...block.kMeanSq];
    momentaryIdxRef.current = (mIdx + 1) % mCap;
    momentaryCountRef.current = Math.min(momentaryCountRef.current + 1, mCap);

    const sCap = shortTermCapRef.current;
    const sIdx = shortTermIdxRef.current;
    shortTermRingRef.current[sIdx] = [...block.kMeanSq];
    shortTermIdxRef.current = (sIdx + 1) % sCap;
    shortTermCountRef.current = Math.min(shortTermCountRef.current + 1, sCap);

    const momentary = windowedLufs(momentaryRingRef.current, momentaryCountRef.current, chCount);
    const shortTerm = windowedLufs(shortTermRingRef.current, shortTermCountRef.current, chCount);

    blockCounterRef.current++;
    if (blockCounterRef.current >= mCap && gatingRef.current) {
      const avgPerCh = new Array<number>(chCount).fill(0);
      const count = momentaryCountRef.current;
      for (let b = 0; b < count; b++) {
        const blk = momentaryRingRef.current[b];
        for (let ch = 0; ch < chCount; ch++) {
          avgPerCh[ch] += blk[ch];
        }
      }
      for (let ch = 0; ch < chCount; ch++) {
        avgPerCh[ch] /= count;
      }
      addGatingBlock(gatingRef.current, avgPerCh);
      blockCounterRef.current = 0;

      if (lraRef.current && shortTermCountRef.current >= shortTermCapRef.current) {
        addLraBlock(lraRef.current, shortTerm);
      }
    }

    const integrated = gatingRef.current ? computeIntegratedLoudness(gatingRef.current) : -Infinity;
    const loudnessRange = lraRef.current ? computeLra(lraRef.current) : 0;

    const truePeakPerChannel = block.truePeaks;
    const truePeak = Math.max(...truePeakPerChannel);

    const momentaryPerChannel = block.kMeanSq.map((ms) =>
      ms > 0 ? 10 * Math.log10(ms) : -Infinity,
    );

    return {
      momentary,
      shortTerm,
      integrated,
      truePeak,
      truePeakPerChannel,
      loudnessRange,
      momentaryPerChannel,
    };
  }, [enabled, videoEl]);

  const resetIntegrated = useCallback(() => {
    if (gatingRef.current) resetGatingState(gatingRef.current);
    if (lraRef.current) resetLraState(lraRef.current);
    momentaryIdxRef.current = 0;
    shortTermIdxRef.current = 0;
    momentaryCountRef.current = 0;
    shortTermCountRef.current = 0;
    blockCounterRef.current = 0;
  }, []);

  return { readLevels, readLoudness, resetIntegrated };
}

// ── Audio config extraction ──

interface AudioTrackConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAudioTrackConfig(track: any): AudioTrackConfig | null {
  try {
    const codec = track.codec as string;
    const sampleRate = track.audio?.sample_rate ?? 48000;
    const numberOfChannels = track.audio?.channel_count ?? 2;
    return { codec, sampleRate, numberOfChannels };
  } catch {
    return null;
  }
}

// ── Audio sample extraction via mp4box ──

function extractAudioSamples(
  initBuf: ArrayBuffer,
  mediaData: ArrayBuffer,
  trackId: number,
): Promise<Sample[]> {
  return new Promise((resolve, reject) => {
    const allSamples: Sample[] = [];
    const mp4 = createFile();

    mp4.onReady = () => {
      mp4.setExtractionOptions(trackId, null, { nbSamples: 100_000 });
      mp4.start();
    };

    mp4.onSamples = (_id: number, _ref: unknown, samples: Sample[]) => {
      for (const s of samples) {
        if (s.data) {
          // Copy data eagerly — mp4box may reuse internal buffers after flush/stop
          const copy = new Uint8Array(s.data.byteLength);
          copy.set(new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength));
          allSamples.push({ ...s, data: copy });
        } else {
          allSamples.push(s);
        }
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

// ── ADTS-wrapped AAC decode via OfflineAudioContext ──
// Safari's WebCodecs AudioDecoder crashes the renderer for AAC (WebKit bug).
// Wrapping raw AAC frames in ADTS headers produces a valid audio stream
// that OfflineAudioContext.decodeAudioData() handles reliably.

interface DecodedPcm {
  channels: Float32Array[];
  sampleRate: number;
}

/** Sample rate → ADTS frequency index (ISO 14496-3 Table 1.18) */
const ADTS_FREQ_INDEX: Record<number, number> = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
  24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11, 7350: 12,
};

async function decodeAudioSamples(
  samples: Sample[],
  codec: string,
  sampleRate: number,
  channelCount: number,
): Promise<DecodedPcm | null> {
  if (samples.length === 0) return null;

  // Parse AAC profile from codec string: "mp4a.40.2" → objectType 2 → AAC-LC
  const objectType = parseAacObjectType(codec);
  if (objectType === 0) return null;

  const freqIdx = ADTS_FREQ_INDEX[sampleRate];
  if (freqIdx === undefined) return null;

  // ADTS profile = objectType - 1 (AAC-LC=2 → profile=1)
  const profile = Math.min(objectType - 1, 3);
  const chanConfig = Math.min(channelCount, 7);

  // Build ADTS stream: prepend 7-byte header to each raw AAC frame
  let totalSize = 0;
  for (const s of samples) {
    if (s.data) totalSize += 7 + s.data.byteLength;
  }

  const adtsStream = new Uint8Array(totalSize);
  let offset = 0;

  for (const s of samples) {
    if (!s.data) continue;
    const frameLen = 7 + s.data.byteLength;

    // ADTS fixed header (7 bytes, no CRC)
    adtsStream[offset + 0] = 0xFF;
    adtsStream[offset + 1] = 0xF1; // syncword + MPEG-4 + Layer 0 + no CRC
    adtsStream[offset + 2] = ((profile << 6) | (freqIdx << 2) | (chanConfig >> 2)) & 0xFF;
    adtsStream[offset + 3] = (((chanConfig & 3) << 6) | ((frameLen >> 11) & 3)) & 0xFF;
    adtsStream[offset + 4] = ((frameLen >> 3) & 0xFF);
    adtsStream[offset + 5] = (((frameLen & 7) << 5) | 0x1F) & 0xFF;
    adtsStream[offset + 6] = 0xFC;

    const src = new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength);
    adtsStream.set(src, offset + 7);
    offset += frameLen;
  }

  try {
    const duration = Math.max(30, samples.length * 1024 / sampleRate + 1);
    const ctx = new OfflineAudioContext(channelCount, Math.ceil(duration * sampleRate), sampleRate);
    const audioBuffer = await ctx.decodeAudioData(adtsStream.buffer);

    const channels: Float32Array[] = [];
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      // Copy — getChannelData returns a view into internal storage
      channels.push(new Float32Array(audioBuffer.getChannelData(ch)));
    }

    return { channels, sampleRate: audioBuffer.sampleRate };
  } catch (err) {
    console.warn("[audioMeterFallback] ADTS decodeAudioData failed:", err);
    return null;
  }
}

/** Extract AAC object type from codec string: "mp4a.40.2" → 2, "mp4a.40.5" → 5 */
function parseAacObjectType(codec: string): number {
  const match = codec.match(/mp4a\.40\.(\d+)/);
  if (match) return parseInt(match[1], 10);
  if (codec.startsWith("mp4a")) return 2; // Assume AAC-LC
  return 0;
}

// ── Metering computation from PCM ──

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

// ── Helpers ──

function findClosestBlock(blocks: MeterBlock[], time: number, hint: number): number {
  if (blocks.length === 0) return 0;

  if (hint >= 0 && hint < blocks.length) {
    if (
      Math.abs(blocks[hint].time - time) < 0.1 ||
      (hint + 1 < blocks.length && blocks[hint].time <= time && blocks[hint + 1].time > time)
    ) {
      return hint;
    }
  }

  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].time < time) lo = mid + 1;
    else hi = mid;
  }

  if (lo > 0 && Math.abs(blocks[lo - 1].time - time) < Math.abs(blocks[lo].time - time)) {
    return lo - 1;
  }
  return lo;
}

function binarySearchInsertIdx(blocks: MeterBlock[], time: number): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function evictBlocks(blocks: MeterBlock[], currentTime: number): void {
  const minTime = currentTime - EVICTION_WINDOW;
  const maxTime = currentTime + EVICTION_WINDOW;

  let startCut = 0;
  while (startCut < blocks.length && blocks[startCut].time < minTime) startCut++;
  if (startCut > 0) blocks.splice(0, startCut);

  let endCut = blocks.length;
  while (endCut > 0 && blocks[endCut - 1].time > maxTime) endCut--;
  if (endCut < blocks.length) blocks.splice(endCut);
}

function extractTfdt(segmentData: Uint8Array, timescale: number): number {
  const tfdtContent = findBoxData(segmentData, "tfdt");
  if (!tfdtContent || tfdtContent.length < 8) return 0;

  const view = new DataView(tfdtContent.buffer, tfdtContent.byteOffset, tfdtContent.byteLength);
  const version = view.getUint8(0);

  if (version === 1 && tfdtContent.length >= 12) {
    const hi = view.getUint32(4);
    const lo = view.getUint32(8);
    return (hi * 0x100000000 + lo) / timescale;
  }

  return view.getUint32(4) / timescale;
}
