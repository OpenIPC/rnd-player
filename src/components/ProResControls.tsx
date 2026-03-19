/**
 * ProResControls — Playback controls for the ProRes viewer.
 *
 * Play/pause, frame step, scrubber, frame counter, timecode, metadata badge,
 * buffer health, and playback speed selector.
 */

import { useCallback, useRef } from "react";
import type { ProResPlaybackState, ProResPlaybackHandle } from "../hooks/useProResPlayback";
import type { ProResTrackInfo } from "../types/proResWorker.types";

interface ProResControlsProps {
  state: ProResPlaybackState;
  handle: ProResPlaybackHandle;
  trackInfo: ProResTrackInfo | null;
}

function formatTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  const parts = [
    String(m).padStart(2, "0"),
    String(s).padStart(2, "0"),
  ];
  if (h > 0) parts.unshift(String(h).padStart(2, "0"));
  return parts.join(":") + "." + String(ms).padStart(3, "0");
}

const SPEEDS = [0.25, 0.5, 1, 2];

export default function ProResControls({
  state,
  handle,
  trackInfo,
}: ProResControlsProps) {
  const scrubberRef = useRef<HTMLDivElement>(null);

  const handleScrubberClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = scrubberRef.current?.getBoundingClientRect();
      if (!rect || state.totalFrames === 0) return;
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const frameIdx = Math.round(ratio * (state.totalFrames - 1));
      handle.seek(frameIdx);
    },
    [state.totalFrames, handle],
  );

  const progress =
    state.totalFrames > 1
      ? (state.frameIndex / (state.totalFrames - 1)) * 100
      : 0;

  return (
    <div className="vp-prores-controls">
      {/* Scrubber bar */}
      <div
        ref={scrubberRef}
        className="vp-prores-scrubber"
        onClick={handleScrubberClick}
      >
        <div
          className="vp-prores-scrubber-fill"
          style={{ width: `${progress}%` }}
        />
        <div
          className="vp-prores-scrubber-buffer"
          style={{
            left: `${progress}%`,
            width: state.totalFrames > 0
              ? `${(state.bufferHealth / state.totalFrames) * 100}%`
              : "0%",
          }}
        />
      </div>

      <div className="vp-prores-toolbar">
        {/* Play/Pause */}
        <button
          className="vp-prores-btn"
          onClick={handle.togglePlay}
          title={state.playing ? "Pause" : "Play"}
        >
          {state.playing ? "\u23F8" : "\u25B6"}
        </button>

        {/* Frame step */}
        <button
          className="vp-prores-btn"
          onClick={handle.stepBackward}
          title="Previous frame"
          disabled={state.frameIndex === 0}
        >
          {"\u23EE"}
        </button>
        <button
          className="vp-prores-btn"
          onClick={handle.stepForward}
          title="Next frame"
          disabled={state.frameIndex >= state.totalFrames - 1}
        >
          {"\u23ED"}
        </button>

        {/* Timecode + frame counter */}
        <span className="vp-prores-time">
          {formatTimecode(state.currentTime)} / {formatTimecode(state.duration)}
        </span>
        <span className="vp-prores-frame-counter">
          Frame {state.frameIndex + 1} / {state.totalFrames}
        </span>

        <div className="vp-prores-spacer" />

        {/* Buffer health */}
        <span className="vp-prores-buffer" title="Buffered frames ahead">
          Buf: {state.bufferHealth}
        </span>

        {/* Speed selector */}
        <select
          className="vp-prores-speed"
          value={state.playbackRate}
          onChange={(e) => handle.setPlaybackRate(parseFloat(e.target.value))}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>

        {/* Metadata badge */}
        {trackInfo && (
          <span className="vp-prores-badge">
            {trackInfo.profileName} · {trackInfo.width}×{trackInfo.height} ·{" "}
            {trackInfo.bitDepth}-bit {trackInfo.chroma}
          </span>
        )}
      </div>
    </div>
  );
}
