import { useEffect, useRef, useCallback } from "react";

export interface ChannelLevel {
  rms: number;
  peak: number;
  dB: number;
  label: string;
}

const CHANNEL_LABELS: Record<number, string[]> = {
  1: ["M"],
  2: ["L", "R"],
  6: ["FL", "FR", "C", "LFE", "SL", "SR"],
};

import { getOrCreateAudioSource, ensureDestinationConnected } from "../utils/audioSourceCache";

const ZERO_FRAMES_THRESHOLD = 10;

export function useAudioAnalyser(videoEl: HTMLVideoElement | null, enabled: boolean) {
  const analysersRef = useRef<AnalyserNode[]>([]);
  const channelCountRef = useRef(2);
  const zeroFrameCountRef = useRef(0);
  const errorRef = useRef<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const videoElRef = useRef(videoEl);

  videoElRef.current = videoEl;

  useEffect(() => {
    if (!videoEl || !enabled) {
      // Suspend context when disabled to free resources
      if (contextRef.current && contextRef.current.state === "running") {
        contextRef.current.suspend();
      }
      analysersRef.current = [];
      zeroFrameCountRef.current = 0;
      errorRef.current = null;
      return;
    }

    const entry = getOrCreateAudioSource(videoEl);
    const { context, source } = entry;

    contextRef.current = context;

    // Resume context if suspended (autoplay policy)
    if (context.state === "suspended") {
      context.resume();
    }

    // Request multi-channel output so the browser doesn't downmix to stereo.
    // destination.maxChannelCount is the hardware limit (e.g. 6 for 5.1).
    const maxHw = context.destination.maxChannelCount;
    if (maxHw > 2) {
      context.destination.channelCount = maxHw;
      context.destination.channelInterpretation = "discrete";
    }

    // Tell the source to pass through all channels instead of downmixing
    source.channelCountMode = "max";
    source.channelInterpretation = "discrete";

    // Determine channel count from source (now reflects actual media channels)
    const chCount = Math.min(source.channelCount || 2, 6);
    channelCountRef.current = chCount;

    // Build signal chain: source → splitter → analysers, source → destination
    const splitter = context.createChannelSplitter(chCount);
    const analysers: AnalyserNode[] = [];

    for (let i = 0; i < chCount; i++) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      splitter.connect(analyser, i);
      analysers.push(analyser);
    }

    source.connect(splitter);
    ensureDestinationConnected(entry);

    analysersRef.current = analysers;
    zeroFrameCountRef.current = 0;
    errorRef.current = null;

    return () => {
      // Disconnect splitter and analysers, but keep source alive in cache
      for (const a of analysers) {
        try { a.disconnect(); } catch { /* already disconnected */ }
      }
      try { splitter.disconnect(); } catch { /* already disconnected */ }
      // Disconnect source from splitter but keep source→destination alive
      // source.disconnect() drops ALL connections, so reset the flag and reconnect
      try { source.disconnect(); } catch { /* already disconnected */ }
      entry.connectedToDestination = false;
      ensureDestinationConnected(entry);
      analysersRef.current = [];
    };
  }, [videoEl, enabled]);

  const readLevels = useCallback((): { levels: ChannelLevel[]; error: string | null } => {
    const analysers = analysersRef.current;
    if (analysers.length === 0) {
      return { levels: [], error: null };
    }

    const chCount = channelCountRef.current;
    const labels = CHANNEL_LABELS[chCount] ?? Array.from({ length: chCount }, (_, i) => `${i + 1}`);
    const levels: ChannelLevel[] = [];
    let allZero = true;

    for (let i = 0; i < analysers.length; i++) {
      const analyser = analysers[i];
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);

      let sumSq = 0;
      let peak = 0;
      for (let j = 0; j < data.length; j++) {
        const sample = data[j];
        sumSq += sample * sample;
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
        if (sample !== 0) allZero = false;
      }

      const rms = Math.sqrt(sumSq / data.length);
      const dB = rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;

      levels.push({ rms, peak, dB, label: labels[i] ?? `${i + 1}` });
    }

    // CORS detection: only count zero frames while video is actively playing
    const isPlaying = videoElRef.current != null && !videoElRef.current.paused;
    if (allZero && isPlaying) {
      zeroFrameCountRef.current++;
      if (zeroFrameCountRef.current >= ZERO_FRAMES_THRESHOLD) {
        errorRef.current = "Audio levels unavailable (cross-origin media)";
      }
    } else if (!allZero) {
      zeroFrameCountRef.current = 0;
      errorRef.current = null;
    }

    return { levels, error: errorRef.current };
  }, []);

  return { readLevels };
}
