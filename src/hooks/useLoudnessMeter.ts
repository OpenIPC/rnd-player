import { useEffect, useRef, useCallback } from "react";
import { getOrCreateAudioSource, ensureDestinationConnected } from "../utils/audioSourceCache";
import { getKWeightCoeffs } from "../utils/kWeighting";
import {
  blockMeanSquare,
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
import {
  createTruePeakState,
  processTruePeak,
  resetTruePeak,
  type TruePeakState,
} from "../utils/truePeakFilter";

export interface LoudnessData {
  momentary: number;            // LUFS (M) — 400ms window
  shortTerm: number;            // LUFS (S) — 3s window
  integrated: number;           // LUFS (I) — gated
  truePeak: number;             // dBTP — max across channels
  truePeakPerChannel: number[];
  loudnessRange: number;        // LU (LRA)
  momentaryPerChannel: number[]; // per-channel K-weighted dB (for bar display)
}

const FFT_SIZE = 2048;

export function useLoudnessMeter(
  videoEl: HTMLVideoElement | null,
  enabled: boolean,
): {
  readLoudness: () => LoudnessData | null;
  resetIntegrated: () => void;
} {
  // K-weighted analysers (for LUFS)
  const kAnalysersRef = useRef<AnalyserNode[]>([]);
  // Raw analysers (for True Peak)
  const rawAnalysersRef = useRef<AnalyserNode[]>([]);
  const channelCountRef = useRef(2);
  const contextRef = useRef<AudioContext | null>(null);

  // Ring buffers for momentary (400ms) and short-term (3s) windows
  const momentaryRingRef = useRef<number[][]>([]);
  const shortTermRingRef = useRef<number[][]>([]);
  const momentaryIdxRef = useRef(0);
  const shortTermIdxRef = useRef(0);
  const momentaryCountRef = useRef(0);
  const shortTermCountRef = useRef(0);
  const momentaryCapRef = useRef(10); // Will be recomputed based on sample rate
  const shortTermCapRef = useRef(71);

  // Gating + LRA state
  const gatingRef = useRef<GatingState | null>(null);
  const lraRef = useRef<LraState | null>(null);

  // True peak state per channel
  const truePeakRef = useRef<TruePeakState[]>([]);

  // Block counter for gating (add a gating block every ~400ms = momentaryCap blocks)
  const blockCounterRef = useRef(0);

  useEffect(() => {
    if (!videoEl || !enabled) {
      if (contextRef.current && contextRef.current.state === "running") {
        contextRef.current.suspend();
      }
      kAnalysersRef.current = [];
      rawAnalysersRef.current = [];
      return;
    }

    const entry = getOrCreateAudioSource(videoEl);
    const { context, source } = entry;
    contextRef.current = context;

    if (context.state === "suspended") {
      context.resume();
    }

    const chCount = Math.min(source.channelCount || 2, 6);
    channelCountRef.current = chCount;

    // Compute ring buffer capacities based on actual sample rate
    const blocksPerSec = context.sampleRate / FFT_SIZE;
    momentaryCapRef.current = Math.ceil(0.4 * blocksPerSec);
    shortTermCapRef.current = Math.ceil(3.0 * blocksPerSec);

    // Initialize ring buffers
    momentaryRingRef.current = new Array(momentaryCapRef.current).fill(null).map(() => new Array(chCount).fill(0));
    shortTermRingRef.current = new Array(shortTermCapRef.current).fill(null).map(() => new Array(chCount).fill(0));
    momentaryIdxRef.current = 0;
    shortTermIdxRef.current = 0;
    momentaryCountRef.current = 0;
    shortTermCountRef.current = 0;
    blockCounterRef.current = 0;

    // Initialize gating + LRA state
    gatingRef.current = createGatingState(chCount);
    lraRef.current = createLraState(chCount);

    // Build K-weighted signal chain
    const coeffs = getKWeightCoeffs(context.sampleRate);
    const splitter = context.createChannelSplitter(chCount);
    const kAnalysers: AnalyserNode[] = [];
    const rawAnalysers: AnalyserNode[] = [];
    const truePeakStates: TruePeakState[] = [];

    for (let i = 0; i < chCount; i++) {
      // K-weighting chain: shelf → HPF → analyser
      const shelf = context.createIIRFilter(coeffs.shelf.b, coeffs.shelf.a);
      const hpf = context.createIIRFilter(coeffs.highpass.b, coeffs.highpass.a);
      const kAnalyser = context.createAnalyser();
      kAnalyser.fftSize = FFT_SIZE;
      kAnalyser.smoothingTimeConstant = 0;

      splitter.connect(shelf, i);
      shelf.connect(hpf);
      hpf.connect(kAnalyser);
      kAnalysers.push(kAnalyser);

      // Raw analyser for true peak
      const rawAnalyser = context.createAnalyser();
      rawAnalyser.fftSize = FFT_SIZE;
      rawAnalyser.smoothingTimeConstant = 0;
      splitter.connect(rawAnalyser, i);
      rawAnalysers.push(rawAnalyser);

      truePeakStates.push(createTruePeakState());
    }

    source.connect(splitter);
    ensureDestinationConnected(entry);

    kAnalysersRef.current = kAnalysers;
    rawAnalysersRef.current = rawAnalysers;
    truePeakRef.current = truePeakStates;

    return () => {
      for (const a of kAnalysers) {
        try { a.disconnect(); } catch { /* */ }
      }
      for (const a of rawAnalysers) {
        try { a.disconnect(); } catch { /* */ }
      }
      try { splitter.disconnect(); } catch { /* */ }
      // Don't call source.disconnect(splitter) — Safari's selective disconnect
      // severs ALL source connections, breaking the audio graph on reconnect.
      kAnalysersRef.current = [];
      rawAnalysersRef.current = [];
    };
  }, [videoEl, enabled]);

  const readLoudness = useCallback((): LoudnessData | null => {
    const kAnalysers = kAnalysersRef.current;
    const rawAnalysers = rawAnalysersRef.current;
    if (kAnalysers.length === 0) return null;

    const chCount = channelCountRef.current;
    const perChMeanSq: number[] = [];
    const momentaryPerChannel: number[] = [];

    // Read K-weighted data for LUFS computation
    for (let i = 0; i < kAnalysers.length; i++) {
      const data = new Float32Array(FFT_SIZE);
      kAnalysers[i].getFloatTimeDomainData(data);
      const ms = blockMeanSquare(data);
      perChMeanSq.push(ms);

      // Per-channel K-weighted dB (for individual bar display)
      momentaryPerChannel.push(ms > 0 ? 10 * Math.log10(ms) : -Infinity);
    }

    // Update momentary ring buffer
    const mCap = momentaryCapRef.current;
    const mIdx = momentaryIdxRef.current;
    momentaryRingRef.current[mIdx] = [...perChMeanSq];
    momentaryIdxRef.current = (mIdx + 1) % mCap;
    momentaryCountRef.current = Math.min(momentaryCountRef.current + 1, mCap);

    // Update short-term ring buffer
    const sCap = shortTermCapRef.current;
    const sIdx = shortTermIdxRef.current;
    shortTermRingRef.current[sIdx] = [...perChMeanSq];
    shortTermIdxRef.current = (sIdx + 1) % sCap;
    shortTermCountRef.current = Math.min(shortTermCountRef.current + 1, sCap);

    // Compute momentary and short-term loudness
    const momentary = windowedLufs(momentaryRingRef.current, momentaryCountRef.current, chCount);
    const shortTerm = windowedLufs(shortTermRingRef.current, shortTermCountRef.current, chCount);

    // Gating: add a block every momentaryCap reads (~400ms)
    blockCounterRef.current++;
    if (blockCounterRef.current >= mCap && gatingRef.current) {
      // Compute the average per-channel mean-square over the last 400ms
      const avgPerCh = new Array<number>(chCount).fill(0);
      const count = momentaryCountRef.current;
      for (let b = 0; b < count; b++) {
        const block = momentaryRingRef.current[b];
        for (let ch = 0; ch < chCount; ch++) {
          avgPerCh[ch] += block[ch];
        }
      }
      for (let ch = 0; ch < chCount; ch++) {
        avgPerCh[ch] /= count;
      }

      addGatingBlock(gatingRef.current, avgPerCh);
      blockCounterRef.current = 0;

      // Also add short-term loudness to LRA
      if (lraRef.current && shortTermCountRef.current >= shortTermCapRef.current) {
        addLraBlock(lraRef.current, shortTerm);
      }
    }

    const integrated = gatingRef.current ? computeIntegratedLoudness(gatingRef.current) : -Infinity;
    const loudnessRange = lraRef.current ? computeLra(lraRef.current) : 0;

    // True Peak from raw analysers
    const truePeakPerChannel: number[] = [];
    let maxTp = -Infinity;
    for (let i = 0; i < rawAnalysers.length; i++) {
      const data = new Float32Array(FFT_SIZE);
      rawAnalysers[i].getFloatTimeDomainData(data);
      const tp = processTruePeak(truePeakRef.current[i], data);
      truePeakPerChannel.push(tp);
      if (tp > maxTp) maxTp = tp;
    }

    return {
      momentary,
      shortTerm,
      integrated,
      truePeak: maxTp,
      truePeakPerChannel,
      loudnessRange,
      momentaryPerChannel,
    };
  }, []);

  const resetIntegrated = useCallback(() => {
    if (gatingRef.current) resetGatingState(gatingRef.current);
    if (lraRef.current) resetLraState(lraRef.current);
    for (const tp of truePeakRef.current) resetTruePeak(tp);
  }, []);

  return { readLoudness, resetIntegrated };
}
