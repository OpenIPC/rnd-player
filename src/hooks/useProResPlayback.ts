/**
 * useProResPlayback — Worker pool, ring buffer, and playback scheduler.
 *
 * Manages N decode workers, dispatches frame requests, maintains an adaptive
 * ring buffer of decoded frames, and drives a rAF loop for playback.
 *
 * ProRes is intra-only: every frame is independently decodable, so workers
 * decode in parallel with zero inter-frame dependencies.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type {
  DecodedFrame,
  SampleTableEntry,
  ProResWorkerResponse,
  ProResFourCC,
} from "../types/proResWorker.types";

export interface ProResPlaybackState {
  frameIndex: number;
  playing: boolean;
  playbackRate: number;
  bufferHealth: number;
  totalFrames: number;
  fps: number;
  currentTime: number;
  duration: number;
}

export interface ProResPlaybackHandle {
  state: ProResPlaybackState;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (frameIndex: number) => void;
  stepForward: () => void;
  stepBackward: () => void;
  setPlaybackRate: (rate: number) => void;
  currentFrame: DecodedFrame | null;
}

/** Max total decoded frame memory in bytes (500 MB). */
const MAX_BUFFER_MEMORY = 500 * 1024 * 1024;
/** Max worker count. */
const MAX_WORKERS = 16;

interface RingEntry {
  frameIndex: number;
  frame: DecodedFrame;
}

/** Approximate memory of a decoded frame in bytes. */
function frameMemory(frame: DecodedFrame): number {
  let bytes = frame.yPlane.byteLength + frame.cbPlane.byteLength + frame.crPlane.byteLength;
  if (frame.alphaPlane) bytes += frame.alphaPlane.byteLength;
  return bytes;
}

export function useProResPlayback(
  sampleTable: SampleTableEntry[] | null,
  url: string | null,
  fps: number,
  fourcc: ProResFourCC,
  is444: boolean,
  width: number,
  height: number,
): ProResPlaybackHandle {
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [bufferHealth, setBufferHealth] = useState(0);
  const [currentFrame, setCurrentFrame] = useState<DecodedFrame | null>(null);

  const frameIndexRef = useRef(0);
  const playingRef = useRef(false);
  const playbackRateRef = useRef(1);
  const rafRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const requestIdRef = useRef(0);

  const workersRef = useRef<Worker[]>([]);
  const workerBusyRef = useRef<Set<number>>(new Set());
  const ringRef = useRef<Map<number, RingEntry>>(new Map());
  const ringMemoryRef = useRef(0);
  const pendingRequestsRef = useRef<Map<number, number>>(new Map()); // requestId → frameIndex
  const dispatchedFramesRef = useRef<Set<number>>(new Set());

  const sampleTableRef = useRef(sampleTable);
  sampleTableRef.current = sampleTable;

  const totalFrames = sampleTable?.length ?? 0;

  // Compute duration from sample table
  const duration = sampleTable && fps > 0 ? totalFrames / fps : 0;
  const currentTime = fps > 0 ? frameIndex / fps : 0;

  const workerCount = Math.min(
    navigator.hardwareConcurrency || 4,
    MAX_WORKERS,
  );

  // Per-frame memory estimate for buffer sizing
  const estimatedFrameBytes = width * height * 2 + // Y plane (16-bit)
    (is444 ? width : (width + 1) >> 1) * height * 2 * 2; // Cb + Cr

  const maxBufferFrames = Math.max(
    workerCount,
    Math.min(
      Math.floor(fps), // up to 1 second
      Math.floor(MAX_BUFFER_MEMORY / Math.max(estimatedFrameBytes, 1)),
    ),
  );

  // Spawn / destroy worker pool
  useEffect(() => {
    if (!url || !sampleTable || sampleTable.length === 0) return;

    const workers: Worker[] = [];
    let readyCount = 0;

    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(
        new URL("../workers/proResWorker.ts", import.meta.url),
        { type: "module" },
      );

      w.onmessage = (e: MessageEvent<ProResWorkerResponse>) => {
        handleWorkerMessage(i, e.data);
      };

      // Init worker with URL + sample table
      w.postMessage({
        type: "init",
        url,
        sampleTable,
        fourcc,
        is444,
        width,
        height,
      });

      workers.push(w);
    }

    workersRef.current = workers;

    function handleWorkerMessage(workerIdx: number, msg: ProResWorkerResponse) {
      switch (msg.type) {
        case "ready":
          readyCount++;
          if (readyCount === workerCount) {
            // All workers ready — prefetch initial frames
            prefetchFrames(0);
          }
          break;

        case "frame": {
          workerBusyRef.current.delete(workerIdx);
          pendingRequestsRef.current.delete(msg.requestId);

          const entry: RingEntry = {
            frameIndex: msg.frameIndex,
            frame: msg.frame,
          };
          ringRef.current.set(msg.frameIndex, entry);
          ringMemoryRef.current += frameMemory(msg.frame);

          setBufferHealth(ringRef.current.size);

          // If this is the frame we're waiting to display
          if (msg.frameIndex === frameIndexRef.current) {
            setCurrentFrame(msg.frame);
          }

          // Continue prefetching
          schedulePrefetch();
          break;
        }

        case "error":
          workerBusyRef.current.delete(workerIdx);
          pendingRequestsRef.current.delete(msg.requestId);
          dispatchedFramesRef.current.delete(
            [...pendingRequestsRef.current.entries()].find(
              ([rid]) => rid === msg.requestId,
            )?.[1] ?? -1,
          );
          schedulePrefetch();
          break;
      }
    }

    const busy = workerBusyRef.current;
    const ring = ringRef.current;
    const pending = pendingRequestsRef.current;
    const dispatched = dispatchedFramesRef.current;

    return () => {
      for (const w of workers) w.terminate();
      workersRef.current = [];
      busy.clear();
      ring.clear();
      ringMemoryRef.current = 0;
      pending.clear();
      dispatched.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, sampleTable, workerCount, fourcc, is444, width, height]);

  /** Find an idle worker index, or -1 if all busy. */
  const findIdleWorker = useCallback((): number => {
    for (let i = 0; i < workersRef.current.length; i++) {
      if (!workerBusyRef.current.has(i)) return i;
    }
    return -1;
  }, []);

  /** Dispatch a single frame decode request. */
  const dispatchFrame = useCallback(
    (fi: number) => {
      if (dispatchedFramesRef.current.has(fi)) return;
      if (ringRef.current.has(fi)) return;

      const wi = findIdleWorker();
      if (wi < 0) return;

      const rid = ++requestIdRef.current;
      workerBusyRef.current.add(wi);
      pendingRequestsRef.current.set(rid, fi);
      dispatchedFramesRef.current.add(fi);

      workersRef.current[wi].postMessage({
        type: "decodeFrame",
        requestId: rid,
        frameIndex: fi,
      });
    },
    [findIdleWorker],
  );

  /** Prefetch frames starting from a given index. */
  const prefetchFrames = useCallback(
    (startFrame: number) => {
      const total = sampleTableRef.current?.length ?? 0;
      for (let i = 0; i < maxBufferFrames && startFrame + i < total; i++) {
        const fi = startFrame + i;
        if (ringMemoryRef.current >= MAX_BUFFER_MEMORY) break;
        dispatchFrame(fi);
      }
    },
    [maxBufferFrames, dispatchFrame],
  );

  /** Continue prefetching from current position. */
  const schedulePrefetch = useCallback(() => {
    prefetchFrames(frameIndexRef.current);
  }, [prefetchFrames]);

  /** Evict frames outside the prefetch window. */
  const evictFrames = useCallback(
    (center: number) => {
      const keepMin = Math.max(0, center - 2);
      const keepMax = Math.min((sampleTableRef.current?.length ?? 0) - 1, center + maxBufferFrames);

      for (const [fi, entry] of ringRef.current) {
        if (fi < keepMin || fi > keepMax) {
          ringMemoryRef.current -= frameMemory(entry.frame);
          ringRef.current.delete(fi);
          dispatchedFramesRef.current.delete(fi);
        }
      }
    },
    [maxBufferFrames],
  );

  /** Cancel all pending requests and flush buffer. */
  const cancelAll = useCallback(() => {
    for (const [rid] of pendingRequestsRef.current) {
      for (const w of workersRef.current) {
        w.postMessage({ type: "cancel", requestId: rid });
      }
    }
    pendingRequestsRef.current.clear();
    workerBusyRef.current.clear();
    dispatchedFramesRef.current.clear();
    ringRef.current.clear();
    ringMemoryRef.current = 0;
    setBufferHealth(0);
  }, []);

  /** Display a specific frame (from ring buffer or trigger decode). */
  const showFrame = useCallback(
    (fi: number) => {
      const entry = ringRef.current.get(fi);
      if (entry) {
        setCurrentFrame(entry.frame);
      } else {
        // Frame not in buffer — dispatch with priority
        setCurrentFrame(null);
        dispatchFrame(fi);
      }
    },
    [dispatchFrame],
  );

  // rAF playback loop
  useEffect(() => {
    if (!playing) return;

    const frameDuration = 1000 / (fps * playbackRateRef.current);

    const tick = (now: number) => {
      if (!playingRef.current) return;

      const elapsed = now - lastFrameTimeRef.current;
      if (elapsed >= frameDuration) {
        lastFrameTimeRef.current = now - (elapsed % frameDuration);

        const next = frameIndexRef.current + 1;
        if (next >= (sampleTableRef.current?.length ?? 0)) {
          // End of file
          setPlaying(false);
          playingRef.current = false;
          return;
        }

        frameIndexRef.current = next;
        setFrameIndex(next);
        evictFrames(next);
        showFrame(next);
        prefetchFrames(next);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    lastFrameTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [playing, fps, evictFrames, showFrame, prefetchFrames]);

  const play = useCallback(() => {
    if (frameIndexRef.current >= totalFrames - 1) {
      // At end — restart from beginning
      frameIndexRef.current = 0;
      setFrameIndex(0);
      cancelAll();
    }
    setPlaying(true);
    playingRef.current = true;
    prefetchFrames(frameIndexRef.current);
  }, [totalFrames, cancelAll, prefetchFrames]);

  const pause = useCallback(() => {
    setPlaying(false);
    playingRef.current = false;
  }, []);

  const togglePlay = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [play, pause]);

  const seek = useCallback(
    (fi: number) => {
      const clamped = Math.max(0, Math.min(fi, totalFrames - 1));
      cancelAll();
      frameIndexRef.current = clamped;
      setFrameIndex(clamped);
      showFrame(clamped);
      prefetchFrames(clamped);
    },
    [totalFrames, cancelAll, showFrame, prefetchFrames],
  );

  const stepForward = useCallback(() => {
    if (frameIndexRef.current < totalFrames - 1) {
      seek(frameIndexRef.current + 1);
    }
  }, [totalFrames, seek]);

  const stepBackward = useCallback(() => {
    if (frameIndexRef.current > 0) {
      seek(frameIndexRef.current - 1);
    }
  }, [seek]);

  const setPlaybackRate = useCallback((rate: number) => {
    setPlaybackRateState(rate);
    playbackRateRef.current = rate;
  }, []);

  return {
    state: {
      frameIndex,
      playing,
      playbackRate,
      bufferHealth,
      totalFrames,
      fps,
      currentTime,
      duration,
    },
    play,
    pause,
    togglePlay,
    seek,
    stepForward,
    stepBackward,
    setPlaybackRate,
    currentFrame,
  };
}
