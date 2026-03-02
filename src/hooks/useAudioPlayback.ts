/**
 * Play decoded PCM audio through AudioContext → AudioBufferSourceNode,
 * synchronized to a video element's timeline.
 *
 * Scheduling strategy:
 * - Maintain a queue of decoded PCM chunks with timestamps
 * - Double-buffer: always have the next chunk ready before the current finishes
 * - Compute AudioContext start time from video's timeline offset
 * - Monitor drift via requestAnimationFrame, re-sync if > 50ms
 *
 * Event handling:
 * - play → audioCtx.resume(), start scheduling
 * - pause → audioCtx.suspend(), cancel pending sources
 * - seeked → cancel all sources, flush buffer, request new chunks
 * - ratechange → adjust playbackRate on scheduled nodes
 */

import { useEffect, useRef, useCallback } from "react";

export interface PcmChunk {
  /** Per-channel PCM Float32Array data */
  channels: Float32Array[];
  /** Presentation time in seconds (aligned to video timeline) */
  time: number;
  /** Duration in seconds */
  duration: number;
  /** Sample rate */
  sampleRate: number;
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  startTime: number; // AudioContext time when this source starts
  endTime: number;   // AudioContext time when this source ends
  pcmTime: number;   // Video timeline time of this chunk
}

const DRIFT_THRESHOLD = 0.05; // 50ms
const SCHEDULE_AHEAD = 0.3;   // Schedule 300ms ahead of current time

export function useAudioPlayback(
  videoEl: HTMLVideoElement | null,
  enabled: boolean,
): {
  /** Enqueue a decoded PCM chunk for playback */
  enqueueChunk: (chunk: PcmChunk) => void;
  /** Flush all scheduled and pending chunks (e.g., on seek) */
  flush: () => void;
  /** Get the AudioContext (for connecting analysers, etc.) */
  getAudioContext: () => AudioContext | null;
  /** Whether audio is currently playing */
  isPlaying: boolean;
} {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const scheduledRef = useRef<ScheduledSource[]>([]);
  const queueRef = useRef<PcmChunk[]>([]);
  const rafRef = useRef(0);
  const isPlayingRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Mute native audio when EC-3 playback is active
  const prevVolumeRef = useRef(1);
  const mutedByUsRef = useRef(false);

  const getAudioContext = useCallback((): AudioContext | null => {
    if (!audioCtxRef.current && enabled) {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }, [enabled]);

  const cancelAllScheduled = useCallback(() => {
    for (const s of scheduledRef.current) {
      try {
        s.source.stop();
        s.source.disconnect();
      } catch {
        // Already stopped
      }
    }
    scheduledRef.current = [];
  }, []);

  const flush = useCallback(() => {
    cancelAllScheduled();
    queueRef.current = [];
  }, [cancelAllScheduled]);

  const scheduleNext = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx || !videoEl || !enabledRef.current) return;
    if (videoEl.paused) return;

    const queue = queueRef.current;
    const scheduled = scheduledRef.current;

    // Remove finished sources
    const now = ctx.currentTime;
    while (scheduled.length > 0 && scheduled[0].endTime < now) {
      const old = scheduled.shift()!;
      try { old.source.disconnect(); } catch { /* */ }
    }

    // How far ahead are we already scheduled?
    const lastScheduledEnd = scheduled.length > 0
      ? scheduled[scheduled.length - 1].endTime
      : now;

    // Schedule more chunks from the queue
    let scheduleAt = lastScheduledEnd;
    while (queue.length > 0 && scheduleAt - now < SCHEDULE_AHEAD) {
      const chunk = queue.shift()!;
      const channelCount = chunk.channels.length;
      const samplesPerChannel = chunk.channels[0].length;

      if (samplesPerChannel === 0) continue;

      const audioBuffer = ctx.createBuffer(channelCount, samplesPerChannel, chunk.sampleRate);
      for (let ch = 0; ch < channelCount; ch++) {
        audioBuffer.copyToChannel(chunk.channels[ch] as Float32Array<ArrayBuffer>, ch);
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = videoEl.playbackRate;
      source.connect(ctx.destination);

      // Compute when this chunk should play relative to AudioContext time.
      // The key mapping: audioCtxTime = audioCtx.currentTime + (chunkVideoTime - video.currentTime)
      const desiredCtxTime = now + (chunk.time - videoEl.currentTime);
      const startAt = Math.max(desiredCtxTime, scheduleAt);

      try {
        source.start(startAt);
      } catch {
        // If start time is in the past, skip this chunk
        continue;
      }

      const endAt = startAt + chunk.duration / videoEl.playbackRate;
      scheduled.push({
        source,
        startTime: startAt,
        endTime: endAt,
        pcmTime: chunk.time,
      });
      scheduleAt = endAt;
    }
  }, [videoEl]);

  // Drift detection + scheduling loop
  const tick = useCallback(() => {
    if (!enabledRef.current || !videoEl || !audioCtxRef.current) return;

    const ctx = audioCtxRef.current;
    const scheduled = scheduledRef.current;

    // Check for drift between video and audio
    if (scheduled.length > 0 && !videoEl.paused) {
      // Find the source that should be playing now
      const ctxNow = ctx.currentTime;
      const currentSource = scheduled.find(
        (s) => s.startTime <= ctxNow && s.endTime > ctxNow,
      );

      if (currentSource) {
        const expectedVideoTime =
          currentSource.pcmTime + (ctxNow - currentSource.startTime) * videoEl.playbackRate;
        const drift = Math.abs(expectedVideoTime - videoEl.currentTime);

        if (drift > DRIFT_THRESHOLD) {
          // Re-sync: cancel everything and let scheduleNext recompute
          cancelAllScheduled();
        }
      }
    }

    scheduleNext();
    rafRef.current = requestAnimationFrame(tick);
  }, [videoEl, scheduleNext, cancelAllScheduled]);

  const enqueueChunk = useCallback((chunk: PcmChunk) => {
    queueRef.current.push(chunk);
    // Sort by time to handle out-of-order arrivals
    queueRef.current.sort((a, b) => a.time - b.time);
  }, []);

  // Event handlers
  useEffect(() => {
    if (!videoEl || !enabled) {
      // Cleanup
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      cancelAllScheduled();
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      // Restore video volume
      if (mutedByUsRef.current && videoEl) {
        videoEl.volume = prevVolumeRef.current;
        mutedByUsRef.current = false;
      }
      isPlayingRef.current = false;
      return;
    }

    const ctx = getAudioContext();
    if (!ctx) return;

    // Mute native audio
    prevVolumeRef.current = videoEl.volume;
    videoEl.volume = 0;
    mutedByUsRef.current = true;

    const onPlay = () => {
      isPlayingRef.current = true;
      ctx.resume();
      rafRef.current = requestAnimationFrame(tick);
    };

    const onPause = () => {
      isPlayingRef.current = false;
      cancelAnimationFrame(rafRef.current);
      ctx.suspend();
      cancelAllScheduled();
    };

    const onSeeked = () => {
      flush();
      // New chunks will arrive from the EC-3 fetcher at the new position
    };

    const onRateChange = () => {
      // Update playbackRate on all scheduled sources
      for (const s of scheduledRef.current) {
        s.source.playbackRate.value = videoEl.playbackRate;
      }
    };

    videoEl.addEventListener("play", onPlay);
    videoEl.addEventListener("pause", onPause);
    videoEl.addEventListener("seeked", onSeeked);
    videoEl.addEventListener("ratechange", onRateChange);

    // Start scheduling if already playing
    if (!videoEl.paused) {
      onPlay();
    }

    return () => {
      videoEl.removeEventListener("play", onPlay);
      videoEl.removeEventListener("pause", onPause);
      videoEl.removeEventListener("seeked", onSeeked);
      videoEl.removeEventListener("ratechange", onRateChange);
      cancelAnimationFrame(rafRef.current);
      cancelAllScheduled();

      // Restore video volume
      if (mutedByUsRef.current) {
        videoEl.volume = prevVolumeRef.current;
        mutedByUsRef.current = false;
      }

      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      isPlayingRef.current = false;
    };
  }, [videoEl, enabled, getAudioContext, tick, cancelAllScheduled, flush]);

  return {
    enqueueChunk,
    flush,
    getAudioContext,
    isPlaying: isPlayingRef.current,
  };
}
