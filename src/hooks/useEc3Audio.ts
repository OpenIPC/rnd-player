/**
 * Orchestrates EC-3 software decode playback:
 * 1. Fetches EC-3 segments independently from the manifest
 * 2. Sends to audioMeterWorker for decode (via OfflineAudioContext or WASM)
 * 3. Feeds decoded PCM to useAudioPlayback for AudioBufferSourceNode playback
 * 4. Provides metering data from the same decoded PCM
 *
 * Lifecycle:
 * - Activate when an EC-3 track is selected
 * - Deactivate when switching to a native track
 * - On seek: flush buffers, re-fetch from new position
 * - Prefetch: buffer ~10-15s ahead of playback
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type { Ec3TrackInfo } from "../utils/dashAudioParser";
import { resolveSegmentUrls } from "../utils/dashAudioParser";
import { corsFetch } from "../utils/corsProxy";
import { useAudioPlayback } from "./useAudioPlayback";
import type { ChannelLevel } from "./useAudioAnalyser";
import type { LoudnessData } from "./useLoudnessMeter";
import type {
  MeterBlock,
  Ec3DecodeResponse,
  AudioMeterError,
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
  type GatingState,
  type LraState,
} from "../utils/loudnessCompute";

const PREFETCH_AHEAD = 15; // seconds
const PREFETCH_INTERVAL = 2000; // ms between prefetch checks
const EVICTION_WINDOW = 30; // seconds
const BLOCK_SIZE = 2048;

const CHANNEL_LABELS: Record<number, string[]> = {
  1: ["M"],
  2: ["L", "R"],
  6: ["FL", "FR", "C", "LFE", "SL", "SR"],
};

export interface UseEc3AudioResult {
  /** Whether EC-3 playback is active */
  active: boolean;
  /** ID of the currently active EC-3 track, or null */
  activeTrackId: string | null;
  /** Activate EC-3 playback for a track */
  activate: (track: Ec3TrackInfo) => void;
  /** Deactivate EC-3 playback (back to native audio) */
  deactivate: () => void;
  /** Read pre-computed metering blocks for current position */
  readMeterBlocks: () => MeterBlock | null;
  /** Read levels in same format as useAudioAnalyser */
  readLevels: () => { levels: ChannelLevel[]; error: string | null };
  /** Read loudness in same format as useLoudnessMeter */
  readLoudness: () => LoudnessData | null;
  /** Reset integrated loudness counters */
  resetIntegrated: () => void;
  /** Error message if something went wrong */
  error: string | null;
}

export function useEc3Audio(
  videoEl: HTMLVideoElement | null,
): UseEc3AudioResult {
  const [active, setActive] = useState(false);
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeTrackRef = useRef<Ec3TrackInfo | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const fetchedSegmentsRef = useRef<Set<string>>(new Set());
  const meterBlocksRef = useRef<MeterBlock[]>([]);
  const lastBlockIdxRef = useRef(0);
  const prefetchTimerRef = useRef(0);
  const initCacheRef = useRef<ArrayBuffer | null>(null);

  // LUFS ring buffers (same structure as useLoudnessMeter / useAudioMeterFallback)
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

  // Audio playback hook for PCM output
  const {
    enqueueChunk,
    flush: flushPlayback,
  } = useAudioPlayback(videoEl, active);

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
    const sampleRate = track?.sampleRate ?? 48000;
    const chCount = track?.channelCount ?? 2;
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

    worker.onmessage = (e: MessageEvent<Ec3DecodeResponse | AudioMeterError>) => {
      if (e.data.type === "ec3Decoded") {
        const { pcmChannels, blocks, segmentStartTime, duration, sampleRate } = e.data;

        // Enqueue PCM for playback
        enqueueChunk({
          channels: pcmChannels,
          time: segmentStartTime,
          duration,
          sampleRate,
        });

        // Store metering blocks
        const existing = meterBlocksRef.current;
        const insertIdx = binarySearchInsertIdx(existing, blocks[0]?.time ?? segmentStartTime);
        existing.splice(insertIdx, 0, ...blocks);

        // Evict old blocks
        evictBlocks(existing, videoEl.currentTime);

        setError(null);
      } else if (e.data.type === "error") {
        console.warn("[useEc3Audio] Decode error:", e.data.message);
        setError(e.data.message);
      }
    };

    // Start prefetching
    fetchSegments(videoEl.currentTime);

    prefetchTimerRef.current = window.setInterval(() => {
      if (!videoEl.paused) {
        fetchSegments(videoEl.currentTime);
      }
    }, PREFETCH_INTERVAL);

    // Handle seek
    const onSeeked = () => {
      flushPlayback();
      fetchedSegmentsRef.current.clear();
      meterBlocksRef.current = [];
      lastBlockIdxRef.current = 0;
      fetchSegments(videoEl.currentTime);
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
  }, [active, videoEl, enqueueChunk, flushPlayback]);

  const fetchSegments = useCallback(async (currentTime: number) => {
    const track = activeTrackRef.current;
    const worker = workerRef.current;
    if (!track || !worker) return;

    const { segments: segInfo } = track;

    // Fetch init segment if not cached (via CORS-aware fetch)
    if (!initCacheRef.current && segInfo.initUrl) {
      try {
        const resp = await corsFetch(segInfo.initUrl);
        if (resp.ok) {
          initCacheRef.current = await resp.arrayBuffer();
        }
      } catch (err) {
        console.warn("[useEc3Audio] Failed to fetch init segment:", err);
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

      // Fetch in the background (don't await — allow parallel fetches)
      corsFetch(seg.url)
        .then((resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.arrayBuffer();
        })
        .then((mediaData) => {
          if (!workerRef.current) return;
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
          console.warn("[useEc3Audio] Segment fetch failed:", seg.url, err);
          // Remove from fetched so it can be retried
          fetchedSegmentsRef.current.delete(key);
        });
    }
  }, []);

  const activate = useCallback((track: Ec3TrackInfo) => {
    activeTrackRef.current = track;
    setActive(true);
    setActiveTrackId(track.id);
    setError(null);
  }, []);

  const deactivate = useCallback(() => {
    activeTrackRef.current = null;
    setActive(false);
    setActiveTrackId(null);
    setError(null);
    flushPlayback();
  }, [flushPlayback]);

  const readMeterBlocks = useCallback((): MeterBlock | null => {
    if (!videoEl || meterBlocksRef.current.length === 0) return null;

    const blocks = meterBlocksRef.current;
    const currentTime = videoEl.currentTime;
    const idx = findClosestBlock(blocks, currentTime, lastBlockIdxRef.current);
    lastBlockIdxRef.current = idx;

    const block = blocks[idx];
    if (Math.abs(block.time - currentTime) > 0.15) return null;
    return block;
  }, [videoEl]);

  const readLevels = useCallback((): { levels: ChannelLevel[]; error: string | null } => {
    if (!active || !videoEl) {
      return { levels: [], error: null };
    }

    const block = readMeterBlocks();
    if (!block) {
      return { levels: [], error: error };
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
  }, [active, videoEl, readMeterBlocks, error]);

  const readLoudness = useCallback((): LoudnessData | null => {
    if (!active || !videoEl) return null;

    const block = readMeterBlocks();
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
  }, [active, videoEl, readMeterBlocks]);

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
    activeTrackId,
    activate,
    deactivate,
    readMeterBlocks,
    readLevels,
    readLoudness,
    resetIntegrated,
    error,
  };
}

// ── Helpers ──

function findClosestBlock(blocks: MeterBlock[], time: number, hint: number): number {
  if (blocks.length === 0) return 0;
  if (hint >= 0 && hint < blocks.length) {
    if (Math.abs(blocks[hint].time - time) < 0.1) return hint;
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
