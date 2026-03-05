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

const DRIFT_THRESHOLD = 0.15; // 150ms — below perceptible A/V sync threshold (~80ms ITU-R)
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
  // Grace period after resume — skip drift detection while ctx/video stabilize
  const resumeAtRef = useRef(0);

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
    if (scheduledRef.current.length > 0) console.log("[playback] cancelAll: %d sources", scheduledRef.current.length);
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
    console.log("[playback] flush: queue=%d scheduled=%d", queueRef.current.length, scheduledRef.current.length);
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
    const videoTime = videoEl.currentTime;
    let scheduleAt = lastScheduledEnd;
    while (queue.length > 0 && scheduleAt - now < SCHEDULE_AHEAD) {
      const chunk = queue.shift()!;
      const channelCount = chunk.channels.length;
      const samplesPerChannel = chunk.channels[0].length;

      if (samplesPerChannel === 0) continue;

      // How much of this chunk has already passed? Skip into it.
      const skipSeconds = Math.max(0, videoTime - chunk.time);
      const remainingDuration = chunk.duration - skipSeconds;

      // Fully stale — entire chunk is behind current playback
      if (remainingDuration <= 0) {
        console.log("[playback] skip stale chunk t=%.2f dur=%.2f (videoT=%.2f)", chunk.time, chunk.duration, videoTime);
        continue;
      }

      // Don't schedule chunks too far ahead — wait for closer ones to arrive
      const effectiveTime = chunk.time + skipSeconds;
      if (effectiveTime - videoTime > 1.5) {
        console.log("[playback] defer far-ahead chunk t=%.2f (videoT=%.2f, ahead=%.1f)", effectiveTime, videoTime, effectiveTime - videoTime);
        queue.unshift(chunk);
        break;
      }

      const audioBuffer = ctx.createBuffer(channelCount, samplesPerChannel, chunk.sampleRate);
      for (let ch = 0; ch < channelCount; ch++) {
        audioBuffer.copyToChannel(chunk.channels[ch] as Float32Array<ArrayBuffer>, ch);
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = videoEl.playbackRate;
      source.connect(ctx.destination);

      // Schedule from the effective position (skipping already-passed audio).
      // source.start(when, offset) skips into the buffer so audio aligns with video.
      const desiredCtxTime = now + (effectiveTime - videoTime);
      const startAt = Math.max(desiredCtxTime, scheduleAt);

      try {
        source.start(startAt, skipSeconds);
        console.log("[playback] scheduled: t=%.2f skip=%.2f startAt=%.3f ctxNow=%.3f videoT=%.2f", chunk.time, skipSeconds, startAt, now, videoTime);
      } catch (e) {
        console.log("[playback] skip chunk t=%.2f (start failed: %s)", chunk.time, e);
        continue;
      }

      // Muting is handled in tick() when a source is actually playing

      const endAt = startAt + remainingDuration / videoEl.playbackRate;
      scheduled.push({
        source,
        startTime: startAt,
        endTime: endAt,
        pcmTime: effectiveTime,
      });
      scheduleAt = endAt;
    }
  }, [videoEl]);

  // Drift detection + scheduling loop
  const tick = useCallback(() => {
    if (!enabledRef.current || !videoEl || !audioCtxRef.current) return;

    const ctx = audioCtxRef.current;
    const scheduled = scheduledRef.current;

    // Check for drift between video and audio (skip during 500ms grace after resume)
    const sinceResume = performance.now() - resumeAtRef.current;
    if (scheduled.length > 0 && !videoEl.paused && sinceResume > 500) {
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
          console.log("[playback] drift=%.3f, re-syncing (expected=%.2f actual=%.2f)", drift, expectedVideoTime, videoEl.currentTime);
          // Re-sync: cancel everything and let scheduleNext recompute
          cancelAllScheduled();
          // Unmute native audio so it fills the gap until a good chunk plays
          if (mutedByUsRef.current && videoEl) {
            console.log("[playback] drift: unmuting native audio during re-sync");
            videoEl.volume = prevVolumeRef.current;
            mutedByUsRef.current = false;
          }
        }
      }
    }

    scheduleNext();

    // Mute native audio only when an EC-3 source is actually producing audio
    // (not at schedule time — avoids premature mute before playback starts)
    if (!mutedByUsRef.current && videoEl && scheduledRef.current.length > 0) {
      const ctxNow = audioCtxRef.current!.currentTime;
      const playing = scheduledRef.current.find(
        (s) => s.startTime <= ctxNow && s.endTime > ctxNow,
      );
      if (playing) {
        console.log("[playback] muting native audio (source playing at ctx=%.3f)", ctxNow);
        videoEl.volume = 0;
        mutedByUsRef.current = true;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [videoEl, scheduleNext, cancelAllScheduled]);

  const enqueueChunk = useCallback((chunk: PcmChunk) => {
    console.log("[playback] enqueue: t=%.2f dur=%.2f ch=%d queueLen=%d", chunk.time, chunk.duration, chunk.channels.length, queueRef.current.length + 1);
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
        console.log("[playback] restoring volume to", prevVolumeRef.current);
        videoEl.volume = prevVolumeRef.current;
        mutedByUsRef.current = false;
      }
      isPlayingRef.current = false;
      return;
    }

    const ctx = getAudioContext();
    if (!ctx) return;

    console.log("[playback] setup: ctx.state=%s videoEl.paused=%s volume=%s", ctx.state, videoEl.paused, videoEl.volume);
    // Save current volume — muting is deferred until first chunk is scheduled
    // to avoid a silence gap while segments are being fetched and decoded
    prevVolumeRef.current = videoEl.volume;
    mutedByUsRef.current = false;

    const onPlay = () => {
      console.log("[playback] onPlay, ctx.state=%s", ctx.state);
      isPlayingRef.current = true;
      // Await resume before starting RAF — prevents drift detection from
      // firing while ctx.currentTime is still frozen but video has advanced
      resumeAtRef.current = performance.now();
      ctx.resume().then(() => {
        console.log("[playback] ctx resumed, starting RAF");
        if (isPlayingRef.current && enabledRef.current) {
          rafRef.current = requestAnimationFrame(tick);
        }
      });
    };

    const onPause = () => {
      console.log("[playback] onPause");
      isPlayingRef.current = false;
      cancelAnimationFrame(rafRef.current);
      // Only suspend context — don't cancel sources. ctx.suspend() freezes
      // AudioContext time so scheduled sources stay valid and resume seamlessly.
      ctx.suspend();
    };

    const onSeeked = () => {
      console.log("[playback] onSeeked, mutedByUs=%s", mutedByUsRef.current);
      flush();
      // Unmute native audio during seek recovery — deferred mute will
      // re-mute when the first new EC-3 chunk is scheduled for playback
      if (mutedByUsRef.current && videoEl) {
        console.log("[playback] onSeeked: restoring native volume during seek recovery");
        videoEl.volume = prevVolumeRef.current;
        mutedByUsRef.current = false;
      }
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
      console.log("[playback] effect cleanup (mutedByUs=%s)", mutedByUsRef.current);
      videoEl.removeEventListener("play", onPlay);
      videoEl.removeEventListener("pause", onPause);
      videoEl.removeEventListener("seeked", onSeeked);
      videoEl.removeEventListener("ratechange", onRateChange);
      cancelAnimationFrame(rafRef.current);
      cancelAllScheduled();

      // Restore video volume
      if (mutedByUsRef.current) {
        console.log("[playback] cleanup: restoring volume to", prevVolumeRef.current);
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
