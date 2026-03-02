/**
 * Unified Track A metering hook.
 *
 * Wraps all three metering backends (Web Audio, Safari fallback, EC-3 SW)
 * and selects the active reader based on runtime conditions. This allows
 * both AudioLevels and AudioCompare to share the same metering pipeline
 * without instantiating duplicate Web Audio nodes.
 */

import shaka from "shaka-player";
import { useAudioAnalyser } from "./useAudioAnalyser";
import type { ChannelLevel } from "./useAudioAnalyser";
import { useLoudnessMeter } from "./useLoudnessMeter";
import type { LoudnessData } from "./useLoudnessMeter";
import { useAudioMeterFallback } from "./useAudioMeterFallback";
import type { UseEc3AudioResult } from "./useEc3Audio";

export interface TrackAMeterResult {
  readLevels: () => { levels: ChannelLevel[]; error: string | null };
  readLoudness: () => LoudnessData | null;
  resetIntegrated: () => void;
}

export function useTrackAMeter(
  videoEl: HTMLVideoElement | null,
  player: shaka.Player | null,
  safariMSE: boolean,
  ec3Audio: UseEc3AudioResult | undefined,
  preferPrecomputed?: boolean,
): TrackAMeterResult {
  // All three hooks are always called (React rules of hooks).
  // Web Audio stays enabled even when fallback output is selected — disabling
  // it would suspend the AudioContext and kill the video's audio routing
  // through MediaElementAudioSourceNode.
  const ec3Active = !!ec3Audio?.active;
  const useFallbackOutput = safariMSE || (!!preferPrecomputed && !ec3Active);
  const webAudio = useAudioAnalyser(videoEl, !safariMSE && !ec3Active);
  const webLoudness = useLoudnessMeter(videoEl, !safariMSE && !ec3Active);
  // Fallback always runs (when not EC-3) so pre-computed blocks are ready
  // when AudioCompare opens — avoids a cold-start bootstrap delay.
  const fallback = useAudioMeterFallback(videoEl, player, !ec3Active);

  if (ec3Active && ec3Audio) {
    return {
      readLevels: ec3Audio.readLevels,
      readLoudness: ec3Audio.readLoudness,
      resetIntegrated: ec3Audio.resetIntegrated,
    };
  }

  if (useFallbackOutput) {
    return {
      readLevels: fallback.readLevels,
      readLoudness: fallback.readLoudness,
      resetIntegrated: fallback.resetIntegrated,
    };
  }

  return {
    readLevels: webAudio.readLevels,
    readLoudness: webLoudness.readLoudness,
    resetIntegrated: webLoudness.resetIntegrated,
  };
}
