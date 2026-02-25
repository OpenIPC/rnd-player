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

/** Safari doesn't route MSE/HLS audio through createMediaElementSource
 *  (WebKit bugs #266922, #180696 — open since 2017). Detect early so we
 *  can show an accurate error instead of the misleading "cross-origin" one. */
const isSafariMSE = (videoEl: HTMLVideoElement): boolean => {
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  // MSE-backed video has no src attribute — Shaka sets MediaSource via srcObject/URL
  const isMSE = !videoEl.src || videoEl.src === "";
  return isSafari && isMSE;
};

export function useAudioAnalyser(videoEl: HTMLVideoElement | null, enabled: boolean) {
  const analysersRef = useRef<AnalyserNode[]>([]);
  const channelCountRef = useRef(2);
  const zeroFrameCountRef = useRef(0);
  const errorRef = useRef<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const videoElRef = useRef(videoEl);
  const safariMSERef = useRef(false);

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
      safariMSERef.current = false;
      return;
    }

    safariMSERef.current = isSafariMSE(videoEl);

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
      for (const a of analysers) {
        try { a.disconnect(); } catch { /* already disconnected */ }
      }
      try { splitter.disconnect(); } catch { /* already disconnected */ }
      // Don't call source.disconnect(splitter) — Safari's selective disconnect
      // severs ALL source connections (including source→destination), causing
      // the MediaElementAudioSourceNode to produce silence on reconnect.
      // The orphaned source→splitter link is harmless (dead-end, no processing).
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

    // Silence detection: count zero frames while video is actively playing
    const isPlaying = videoElRef.current != null && !videoElRef.current.paused;
    if (allZero && isPlaying) {
      zeroFrameCountRef.current++;
      if (zeroFrameCountRef.current >= ZERO_FRAMES_THRESHOLD) {
        // Safari doesn't route MSE/HLS audio into Web Audio graph
        // (WebKit bugs #266922, #180696). Show an accurate message.
        if (safariMSERef.current) {
          errorRef.current = "Audio metering unavailable in Safari with streaming";
        } else {
          errorRef.current = "Audio levels unavailable (cross-origin media)";
        }
      }
    } else if (!allZero) {
      zeroFrameCountRef.current = 0;
      errorRef.current = null;
    }

    return { levels, error: errorRef.current };
  }, []);

  return { readLevels };
}
