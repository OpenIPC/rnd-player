/**
 * useProResPlayback — Main-thread fetch pipeline + worker decode pool.
 *
 * Architecture:
 *   - Main thread fetches frame data via sequential Range requests on a
 *     single persistent HTTP connection (connection reuse = low TTFB).
 *   - Compressed frame data is transferred to decode workers (round-robin).
 *   - Workers run WASM ProRes decode and transfer YUV planes back.
 *   - rAF loop displays frames from the ring buffer.
 *
 * This avoids the Chrome Web Worker connection pool issue where each worker
 * opens its own TCP connection (no reuse, high TTFB per request).
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
}

/** Max total decoded frame memory in bytes (500 MB). */
const MAX_BUFFER_MEMORY = 500 * 1024 * 1024;
/** Decode workers (CPU-only, no network). */
const MAX_WORKERS = 3;
/** Frames per Range request from the main-thread fetch pipeline. */
const BATCH_SIZE = 10;
/** Minimum buffered frames before playback starts. */
const MIN_BUFFER_BEFORE_PLAY = 15;

interface RingEntry {
  frameIndex: number;
  frame: DecodedFrame;
}

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
  renderFrameRef: React.RefObject<((frame: DecodedFrame) => void) | null>,
  wasmModule: WebAssembly.Module | null,
): ProResPlaybackHandle {
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [bufferHealth, setBufferHealth] = useState(0);

  const frameIndexRef = useRef(0);
  const playingRef = useRef(false);
  const playbackRateRef = useRef(1);
  const rafRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const requestIdRef = useRef(0);

  const workersRef = useRef<Worker[]>([]);
  const ringRef = useRef<Map<number, RingEntry>>(new Map());
  const ringMemoryRef = useRef(0);
  const dispatchedFramesRef = useRef<Set<number>>(new Set());
  const workersReadyRef = useRef(false);
  const lastHealthUpdateRef = useRef(0);
  const playPendingRef = useRef(false);

  // Main-thread fetch pipeline abort controller
  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchRunningRef = useRef(false);

  const sampleTableRef = useRef(sampleTable);
  sampleTableRef.current = sampleTable;

  const totalFrames = sampleTable?.length ?? 0;
  const duration = sampleTable && fps > 0 ? totalFrames / fps : 0;
  const currentTime = fps > 0 ? frameIndex / fps : 0;

  const workerCount = Math.min(
    navigator.hardwareConcurrency || 4,
    MAX_WORKERS,
  );

  const estimatedFrameBytes = width * height * 2 +
    (is444 ? width : (width + 1) >> 1) * height * 2 * 2;

  const maxBufferFrames = Math.max(
    workerCount,
    Math.floor(MAX_BUFFER_MEMORY / Math.max(estimatedFrameBytes, 1)),
  );

  // --- Worker pool (decode-only) ---

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
        handleWorkerMessage(e.data);
      };

      w.postMessage({
        type: "init",
        url,
        sampleTable,
        fourcc,
        is444,
        width,
        height,
        ...(wasmModule ? { wasmModule } : {}),
      });

      workers.push(w);
    }

    workersRef.current = workers;

    function handleWorkerMessage(msg: ProResWorkerResponse) {
      switch (msg.type) {
        case "ready":
          readyCount++;
          if (readyCount === workerCount) {
            workersReadyRef.current = true;
            startFetchPipeline(frameIndexRef.current);
          }
          break;

        case "frame": {
          const entry: RingEntry = {
            frameIndex: msg.frameIndex,
            frame: msg.frame,
          };
          ringRef.current.set(msg.frameIndex, entry);
          ringMemoryRef.current += frameMemory(msg.frame);

          // Throttle buffer health UI updates
          const now = performance.now();
          if (now - lastHealthUpdateRef.current > 250) {
            setBufferHealth(ringRef.current.size);
            lastHealthUpdateRef.current = now;
          }

          // Render if this is the current frame
          if (msg.frameIndex === frameIndexRef.current) {
            renderFrameRef.current?.(msg.frame);
          }

          // Pre-buffer: start playback once enough consecutive frames arrive
          if (playPendingRef.current) {
            let buffered = 0;
            const total = sampleTableRef.current?.length ?? 0;
            for (let i = frameIndexRef.current; i < total && buffered < MIN_BUFFER_BEFORE_PLAY; i++) {
              if (ringRef.current.has(i)) buffered++;
              else break;
            }
            if (buffered >= MIN_BUFFER_BEFORE_PLAY) {
              playPendingRef.current = false;
              setPlaying(true);
              playingRef.current = true;
            }
          }
          break;
        }

        case "pipelineDone":
        case "error":
          break;
      }
    }

    const ring = ringRef.current;
    const dispatched = dispatchedFramesRef.current;

    return () => {
      fetchAbortRef.current?.abort();
      fetchRunningRef.current = false;
      for (const w of workers) w.terminate();
      workersRef.current = [];
      workersReadyRef.current = false;
      ring.clear();
      ringMemoryRef.current = 0;
      dispatched.clear();
      playPendingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, sampleTable, workerCount, fourcc, is444, width, height, wasmModule]);

  // --- Main-thread streaming fetch pipeline ---

  /**
   * Stream a single large Range request covering all frames in the prefetch
   * window. Reads the response body as a stream, extracts frames at known
   * sample-table boundaries, and dispatches each to a decode worker.
   *
   * Single TCP connection → one TTFB cost, full bandwidth, no slow-start
   * penalty per frame.
   */
  const startFetchPipeline = useCallback(
    async (startFrame: number) => {
      if (!url || !workersReadyRef.current) return;
      if (fetchRunningRef.current) return;

      const table = sampleTableRef.current;
      if (!table || table.length === 0) return;

      fetchAbortRef.current?.abort();
      const abort = new AbortController();
      fetchAbortRef.current = abort;
      fetchRunningRef.current = true;

      const total = table.length;
      const endFrame = Math.min(startFrame + maxBufferFrames, total);

      // Skip already dispatched/buffered frames
      let fi = startFrame;
      while (fi < endFrame && (dispatchedFramesRef.current.has(fi) || ringRef.current.has(fi))) {
        fi++;
      }
      if (fi >= endFrame) {
        fetchRunningRef.current = false;
        return;
      }

      const firstEntry = table[fi];
      const lastEntry = table[endFrame - 1];
      const rangeStart = firstEntry.offset;
      const rangeEnd = lastEntry.offset + lastEntry.size - 1;

      // Mark all frames as dispatched upfront
      for (let i = fi; i < endFrame; i++) {
        dispatchedFramesRef.current.add(i);
      }

      try {
        const response = await fetch(url, {
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
          signal: abort.signal,
        });

        if (!response.ok && response.status !== 206) {
          fetchRunningRef.current = false;
          return;
        }

        // Single arrayBuffer() call — browser downloads at full speed internally
        // without per-chunk JS callback overhead competing with the event loop.
        const allData = new Uint8Array(await response.arrayBuffer());
        if (abort.signal.aborted) return;

        // Extract and dispatch all frames in one fast loop
        for (let i = fi; i < endFrame; i++) {
          if (abort.signal.aborted) return;
          if (ringMemoryRef.current >= MAX_BUFFER_MEMORY) break;

          const entry = table[i];
          const relOffset = entry.offset - rangeStart;
          const frameData = allData.slice(relOffset, relOffset + entry.size);

          const wi = i % workersRef.current.length;
          const rid = ++requestIdRef.current;

          workersRef.current[wi].postMessage(
            { type: "decodeOnly", requestId: rid, frameIndex: i, frameData },
            [frameData.buffer],
          );
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      } finally {
        fetchRunningRef.current = false;
      }

      // Pipeline complete — check if playback advanced past this range
      if (!abort.signal.aborted) {
        const nextStart = frameIndexRef.current;
        if (nextStart + maxBufferFrames > endFrame) {
          startFetchPipeline(nextStart);
        }
      }
    },
    [url, maxBufferFrames, workerCount],
  );

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

  const cancelAll = useCallback(() => {
    fetchAbortRef.current?.abort();
    fetchRunningRef.current = false;
    dispatchedFramesRef.current.clear();
    ringRef.current.clear();
    ringMemoryRef.current = 0;
    playPendingRef.current = false;
    setBufferHealth(0);
  }, []);

  // --- rAF playback loop ---

  useEffect(() => {
    if (!playing) return;

    const tick = (now: number) => {
      if (!playingRef.current) return;

      const frameDuration = 1000 / (fps * playbackRateRef.current);
      const elapsed = now - lastFrameTimeRef.current;

      if (elapsed >= frameDuration) {
        const next = frameIndexRef.current + 1;
        if (next >= (sampleTableRef.current?.length ?? 0)) {
          setPlaying(false);
          playingRef.current = false;
          return;
        }

        if (!ringRef.current.has(next)) {
          // Buffer underrun — wait, keep rAF alive
          lastFrameTimeRef.current = now;
          // Ensure fetch pipeline is running
          if (!fetchRunningRef.current) {
            startFetchPipeline(next);
          }
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        lastFrameTimeRef.current = now - (elapsed % frameDuration);
        frameIndexRef.current = next;
        setFrameIndex(next);
        evictFrames(next);

        const entry = ringRef.current.get(next);
        if (entry) {
          renderFrameRef.current?.(entry.frame);
        }

        // Kick fetch pipeline if it's not running (consumed past its range)
        if (!fetchRunningRef.current) {
          startFetchPipeline(next);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    lastFrameTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [playing, fps, evictFrames, startFetchPipeline, renderFrameRef]);

  // --- Controls ---

  const play = useCallback(() => {
    if (frameIndexRef.current >= totalFrames - 1) {
      frameIndexRef.current = 0;
      setFrameIndex(0);
      cancelAll();
    }

    startFetchPipeline(frameIndexRef.current);

    let buffered = 0;
    for (let i = frameIndexRef.current; i < totalFrames && buffered < MIN_BUFFER_BEFORE_PLAY; i++) {
      if (ringRef.current.has(i)) buffered++;
      else break;
    }

    if (buffered >= MIN_BUFFER_BEFORE_PLAY) {
      setPlaying(true);
      playingRef.current = true;
    } else {
      playPendingRef.current = true;
    }
  }, [totalFrames, cancelAll, startFetchPipeline]);

  const pause = useCallback(() => {
    setPlaying(false);
    playingRef.current = false;
    playPendingRef.current = false;
  }, []);

  const togglePlay = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [play, pause]);

  const seek = useCallback(
    (fi: number) => {
      const clamped = Math.max(0, Math.min(fi, totalFrames - 1));
      frameIndexRef.current = clamped;
      setFrameIndex(clamped);

      if (ringRef.current.has(clamped)) {
        renderFrameRef.current?.(ringRef.current.get(clamped)!.frame);
        evictFrames(clamped);
        if (!fetchRunningRef.current) {
          startFetchPipeline(clamped);
        }
        return;
      }

      cancelAll();
      startFetchPipeline(clamped);
    },
    [totalFrames, cancelAll, evictFrames, startFetchPipeline, renderFrameRef],
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
  };
}
