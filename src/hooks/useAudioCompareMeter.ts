/**
 * Independent metering for a non-playing audio track (Track B in AudioCompare).
 *
 * Modeled on useEc3Audio but without playback — meter only.
 * Fetches segments independently, decodes via audioMeterWorker,
 * and provides the same readLevels()/readLoudness() interface.
 *
 * Routes by codec:
 * - AAC (mp4a.*): sends "decode" message (OfflineAudioContext path)
 * - EC-3/AC-3: sends "decodeEc3" message (OfflineAudioContext → WASM fallback)
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type { Ec3TrackInfo } from "../utils/dashAudioParser";
import { resolveSegmentUrls } from "../utils/dashAudioParser";
import { corsFetch } from "../utils/corsProxy";
import type { ChannelLevel } from "./useAudioAnalyser";
import type { LoudnessData } from "./useLoudnessMeter";
import type {
  MeterBlock,
  Ec3DecodeResponse,
  AudioMeterError,
  NeedsMainDecodeResponse,
} from "../workers/audioMeterWorker";
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
  blockMeanSquare,
  type GatingState,
  type LraState,
} from "../utils/loudnessCompute";
import { getKWeightCoeffs } from "../utils/kWeighting";
import {
  createBiquadState,
  applyKWeighting,
} from "../utils/biquadProcess";
import {
  createTruePeakState,
  processTruePeak,
} from "../utils/truePeakFilter";

const PREFETCH_AHEAD = 15;
const PREFETCH_INTERVAL = 2000;
const EVICTION_WINDOW = 30;
const BLOCK_SIZE = 2048;

const CHANNEL_LABELS: Record<number, string[]> = {
  1: ["M"],
  2: ["L", "R"],
  6: ["FL", "FR", "C", "LFE", "SL", "SR"],
};

export interface UseAudioCompareMeterResult {
  active: boolean;
  activate: (track: Ec3TrackInfo) => void;
  deactivate: () => void;
  readLevels: () => { levels: ChannelLevel[]; error: string | null };
  readLoudness: () => LoudnessData | null;
  resetIntegrated: () => void;
  channelCount: number;
  error: string | null;
}

export function useAudioCompareMeter(
  videoEl: HTMLVideoElement | null,
): UseAudioCompareMeterResult {
  const [active, setActive] = useState(false);
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channelCount, setChannelCount] = useState(2);
  const activeTrackRef = useRef<Ec3TrackInfo | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const fetchedSegmentsRef = useRef<Set<string>>(new Set());
  const meterBlocksRef = useRef<MeterBlock[]>([]);
  const lastBlockIdxRef = useRef(0);
  const prefetchTimerRef = useRef(0);
  const initCacheRef = useRef<ArrayBuffer | null>(null);

  // LUFS ring buffers
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

  // Spawn worker on activation
  useEffect(() => {
    if (!active || !videoEl) {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      fetchedSegmentsRef.current.clear();
      meterBlocksRef.current = [];
      lastBlockIdxRef.current = 0;
      initCacheRef.current = null;
      if (prefetchTimerRef.current) {
        clearInterval(prefetchTimerRef.current);
        prefetchTimerRef.current = 0;
      }
      return;
    }

    // Initialize LUFS state
    const track = activeTrackRef.current;
    if (!track) return;

    const sampleRate = track.sampleRate ?? 48000;
    const chCount = track.channelCount ?? 2;
    setChannelCount(chCount);
    const blocksPerSec = sampleRate / BLOCK_SIZE;
    const mCap = Math.ceil(0.4 * blocksPerSec);
    const sCap = Math.ceil(3.0 * blocksPerSec);
    momentaryCapRef.current = mCap;
    shortTermCapRef.current = sCap;
    momentaryRingRef.current = new Array(mCap).fill(null).map(() => new Array(chCount).fill(0));
    shortTermRingRef.current = new Array(sCap).fill(null).map(() => new Array(chCount).fill(0));
    momentaryIdxRef.current = 0;
    shortTermIdxRef.current = 0;
    momentaryCountRef.current = 0;
    shortTermCountRef.current = 0;
    blockCounterRef.current = 0;
    gatingRef.current = createGatingState(chCount);
    lraRef.current = createLraState(chCount);

    const worker = new Worker(
      new URL("../workers/audioMeterWorker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    worker.onmessage = async (e: MessageEvent<Ec3DecodeResponse | AudioMeterError | NeedsMainDecodeResponse>) => {
      if (e.data.type === "ec3Decoded") {
        const { blocks, segmentStartTime } = e.data;

        // Store metering blocks
        const existing = meterBlocksRef.current;
        const insertIdx = binarySearchInsertIdx(existing, blocks[0]?.time ?? segmentStartTime);
        existing.splice(insertIdx, 0, ...blocks);

        // Evict old blocks
        if (videoEl) {
          evictBlocks(existing, videoEl.currentTime);
        }

        setError(null);
      } else if (e.data.type === "needsMainDecode") {
        // Worker doesn't have OfflineAudioContext — decode ADTS on main thread
        const { adtsData, segmentStartTime, channels: ch, sampleRate: sr } = e.data;
        try {
          const duration = Math.max(30, adtsData.byteLength / (sr * 2) + 1);
          const ctx = new OfflineAudioContext(ch, Math.ceil(duration * sr), sr);
          const audioBuffer = await ctx.decodeAudioData(adtsData);

          const pcmChannels: Float32Array[] = [];
          for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
            pcmChannels.push(audioBuffer.getChannelData(c));
          }

          const blocks = computeMainThreadMeterBlocks(pcmChannels, audioBuffer.sampleRate, segmentStartTime);
          const existing = meterBlocksRef.current;
          const insertIdx = binarySearchInsertIdx(existing, blocks[0]?.time ?? segmentStartTime);
          existing.splice(insertIdx, 0, ...blocks);

          if (videoEl) {
            evictBlocks(existing, videoEl.currentTime);
          }
          setError(null);
        } catch (err) {
          console.warn("[useAudioCompareMeter] Main thread ADTS decode failed:", err);
          setError(err instanceof Error ? err.message : String(err));
        }
      } else if (e.data.type === "error") {
        console.warn("[useAudioCompareMeter] Decode error:", e.data.message);
        setError(e.data.message);
      }
    };

    // Start prefetching
    fetchSegments(videoEl.currentTime);

    prefetchTimerRef.current = window.setInterval(() => {
      if (videoEl && !videoEl.paused) {
        fetchSegments(videoEl.currentTime);
      }
    }, PREFETCH_INTERVAL);

    // Handle seek
    const onSeeked = () => {
      fetchedSegmentsRef.current.clear();
      meterBlocksRef.current = [];
      lastBlockIdxRef.current = 0;
      if (videoEl) fetchSegments(videoEl.currentTime);
    };

    videoEl.addEventListener("seeked", onSeeked);

    return () => {
      videoEl.removeEventListener("seeked", onSeeked);
      worker.terminate();
      workerRef.current = null;
      if (prefetchTimerRef.current) {
        clearInterval(prefetchTimerRef.current);
        prefetchTimerRef.current = 0;
      }
      fetchedSegmentsRef.current.clear();
      meterBlocksRef.current = [];
      initCacheRef.current = null;
    };
  }, [active, activeTrackId, videoEl]);

  const fetchSegments = useCallback(async (currentTime: number) => {
    const track = activeTrackRef.current;
    const worker = workerRef.current;
    if (!track || !worker) return;

    const { segments: segInfo } = track;

    // Fetch init segment if not cached
    if (!initCacheRef.current && segInfo.initUrl) {
      try {
        const resp = await corsFetch(segInfo.initUrl);
        if (resp.ok) {
          initCacheRef.current = await resp.arrayBuffer();
        }
      } catch (err) {
        console.warn("[useAudioCompareMeter] Failed to fetch init segment:", err);
        return;
      }
    }

    const initData = initCacheRef.current;
    if (!initData) return;

    // Resolve segment URLs for the prefetch window
    const endTime = currentTime + PREFETCH_AHEAD;
    const segmentUrls = resolveSegmentUrls(segInfo, currentTime - 1, endTime);

    for (const seg of segmentUrls) {
      const key = `${seg.startTime.toFixed(4)}`;
      if (fetchedSegmentsRef.current.has(key)) continue;
      fetchedSegmentsRef.current.add(key);

      corsFetch(seg.url)
        .then((resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.arrayBuffer();
        })
        .then((mediaData) => {
          if (!workerRef.current) return;

          // Always use "decodeEc3" — it has a 3-stage fallback:
          // 1. OfflineAudioContext on raw fMP4 (Safari)
          // 2. mp4box demux → ADTS wrap → OfflineAudioContext (AAC in all browsers)
          // 3. mp4box demux → WASM decoder (EC-3/AC-3)
          workerRef.current.postMessage({
            type: "decodeEc3",
            initData: initData.slice(0),
            mediaData,
            segmentStartTime: seg.startTime,
            channels: track.channelCount,
            sampleRate: track.sampleRate,
          });
        })
        .catch((err) => {
          console.warn("[useAudioCompareMeter] Segment fetch failed:", seg.url, err);
          fetchedSegmentsRef.current.delete(key);
        });
    }
  }, []);

  const activate = useCallback((track: Ec3TrackInfo) => {
    activeTrackRef.current = track;
    setActive(true);
    setActiveTrackId(track.id);
    setError(null);
    // Clear previous state
    fetchedSegmentsRef.current.clear();
    meterBlocksRef.current = [];
    lastBlockIdxRef.current = 0;
    initCacheRef.current = null;
  }, []);

  const deactivate = useCallback(() => {
    activeTrackRef.current = null;
    setActive(false);
    setActiveTrackId(null);
    setError(null);
  }, []);

  const readLevels = useCallback((): { levels: ChannelLevel[]; error: string | null } => {
    if (!active || !videoEl) {
      return { levels: [], error: null };
    }

    const block = findBlock(meterBlocksRef.current, videoEl.currentTime, lastBlockIdxRef);
    if (!block) {
      return { levels: [], error };
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
  }, [active, videoEl, error]);

  const readLoudness = useCallback((): LoudnessData | null => {
    if (!active || !videoEl) return null;

    const block = findBlock(meterBlocksRef.current, videoEl.currentTime, lastBlockIdxRef);
    if (!block) return null;

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
      addGatingBlock(gatingRef.current, block.kMeanSq);
    }
    if (lraRef.current && shortTermCountRef.current >= shortTermCapRef.current) {
      addLraBlock(lraRef.current, shortTerm);
    }

    const integrated = gatingRef.current
      ? computeIntegratedLoudness(gatingRef.current)
      : -Infinity;
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
  }, [active, videoEl]);

  const resetIntegrated = useCallback(() => {
    if (gatingRef.current) resetGatingState(gatingRef.current);
    if (lraRef.current) resetLraState(lraRef.current);
    momentaryIdxRef.current = 0;
    shortTermIdxRef.current = 0;
    momentaryCountRef.current = 0;
    shortTermCountRef.current = 0;
    blockCounterRef.current = 0;
  }, []);

  return {
    active,
    activate,
    deactivate,
    readLevels,
    readLoudness,
    resetIntegrated,
    channelCount,
    error,
  };
}

// ── Helpers ──

const METER_BLOCK_SIZE = 2048;

/** Compute metering blocks from PCM on the main thread (when worker lacks OfflineAudioContext) */
function computeMainThreadMeterBlocks(
  channels: Float32Array[],
  sampleRate: number,
  segmentStartTime: number,
): MeterBlock[] {
  const channelCount = channels.length;
  const totalSamples = channels[0]?.length ?? 0;
  const kCoeffs = getKWeightCoeffs(sampleRate);

  const shelfStates = Array.from({ length: channelCount }, () => createBiquadState());
  const hpfStates = Array.from({ length: channelCount }, () => createBiquadState());
  const tpStates = Array.from({ length: channelCount }, () => createTruePeakState());

  const blocks: MeterBlock[] = [];

  for (let offset = 0; offset + METER_BLOCK_SIZE <= totalSamples; offset += METER_BLOCK_SIZE) {
    const time = segmentStartTime + (offset / sampleRate);
    const levels: { rms: number; peak: number; dB: number }[] = [];
    const kMeanSq: number[] = [];
    const truePeaks: number[] = [];

    for (let ch = 0; ch < channelCount; ch++) {
      const samples = channels[ch].subarray(offset, offset + METER_BLOCK_SIZE);

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
      truePeaks.push(processTruePeak(tpStates[ch], samples));
    }

    blocks.push({ time, levels, kMeanSq, truePeaks });
  }

  return blocks;
}

function findBlock(
  blocks: MeterBlock[],
  time: number,
  hintRef: React.MutableRefObject<number>,
): MeterBlock | null {
  if (blocks.length === 0) return null;

  const hint = hintRef.current;
  if (hint >= 0 && hint < blocks.length) {
    if (Math.abs(blocks[hint].time - time) < 0.1) {
      return blocks[hint];
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
    lo = lo - 1;
  }
  hintRef.current = lo;

  const block = blocks[lo];
  if (Math.abs(block.time - time) > 0.15) return null;
  return block;
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
