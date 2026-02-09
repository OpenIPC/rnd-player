import { useEffect, useState, useRef, useCallback } from "react";
import shaka from "shaka-player";
import {
  PlayIcon,
  PauseIcon,
  VolumeHighIcon,
  VolumeMuteIcon,
  MonitorIcon,
  SpeedIcon,
  FullscreenIcon,
  ExitFullscreenIcon,
} from "./icons";

interface VideoControlsProps {
  videoEl: HTMLVideoElement;
  containerEl: HTMLDivElement;
  player: shaka.Player;
}

interface QualityOption {
  id: number;
  height: number;
  bandwidth: number;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_DELAY = 3000;

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default function VideoControls({
  videoEl,
  containerEl,
  player,
}: VideoControlsProps) {
  // Video state
  const [playing, setPlaying] = useState(!videoEl.paused);
  const [currentTime, setCurrentTime] = useState(videoEl.currentTime);
  const [duration, setDuration] = useState(videoEl.duration || 0);
  const [volume, setVolume] = useState(videoEl.volume);
  const [muted, setMuted] = useState(videoEl.muted);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(videoEl.playbackRate);

  // Shaka track state
  const [qualities, setQualities] = useState<QualityOption[]>([]);
  const [activeHeight, setActiveHeight] = useState<number | null>(null);
  const [isAutoQuality, setIsAutoQuality] = useState(true);

  // UI state
  const [popup, setPopup] = useState<"quality" | "speed" | null>(null);
  const [visible, setVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as never);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ── Video event listeners ──
  useEffect(() => {
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => setCurrentTime(videoEl.currentTime);
    const onDurationChange = () => setDuration(videoEl.duration || 0);
    const onVolumeChange = () => {
      setVolume(videoEl.volume);
      setMuted(videoEl.muted);
    };
    const onRateChange = () => setPlaybackRate(videoEl.playbackRate);
    const onProgress = () => {
      if (videoEl.buffered.length > 0) {
        setBufferedEnd(videoEl.buffered.end(videoEl.buffered.length - 1));
      }
    };

    videoEl.addEventListener("play", onPlay);
    videoEl.addEventListener("pause", onPause);
    videoEl.addEventListener("timeupdate", onTimeUpdate);
    videoEl.addEventListener("durationchange", onDurationChange);
    videoEl.addEventListener("volumechange", onVolumeChange);
    videoEl.addEventListener("ratechange", onRateChange);
    videoEl.addEventListener("progress", onProgress);

    return () => {
      videoEl.removeEventListener("play", onPlay);
      videoEl.removeEventListener("pause", onPause);
      videoEl.removeEventListener("timeupdate", onTimeUpdate);
      videoEl.removeEventListener("durationchange", onDurationChange);
      videoEl.removeEventListener("volumechange", onVolumeChange);
      videoEl.removeEventListener("ratechange", onRateChange);
      videoEl.removeEventListener("progress", onProgress);
    };
  }, [videoEl]);

  // ── Shaka track management ──
  const updateTracks = useCallback(() => {
    const tracks = player.getVariantTracks();
    // Deduplicate by height, keeping highest bandwidth per height
    const byHeight = new Map<number, QualityOption>();
    for (const t of tracks) {
      if (t.height == null) continue;
      const existing = byHeight.get(t.height);
      if (!existing || t.bandwidth > existing.bandwidth) {
        byHeight.set(t.height, {
          id: t.id,
          height: t.height,
          bandwidth: t.bandwidth,
        });
      }
    }
    const sorted = Array.from(byHeight.values()).sort(
      (a, b) => b.height - a.height
    );
    setQualities(sorted);

    // Find the active track's height
    const active = tracks.find((t) => t.active);
    if (active?.height != null) {
      setActiveHeight(active.height);
    }
  }, [player]);

  useEffect(() => {
    updateTracks();

    const onTracksChanged = () => updateTracks();
    const onVariantChanged = () => updateTracks();

    player.addEventListener("trackschanged", onTracksChanged);
    player.addEventListener("variantchanged", onVariantChanged);

    return () => {
      player.removeEventListener("trackschanged", onTracksChanged);
      player.removeEventListener("variantchanged", onVariantChanged);
    };
  }, [player, updateTracks]);

  // ── Auto-hide controls ──
  const resetHideTimer = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    setVisible(true);
    hideTimerRef.current = setTimeout(() => {
      if (!videoEl.paused && popup === null) {
        setVisible(false);
      }
    }, HIDE_DELAY);
  }, [videoEl, popup]);

  // Listen on containerEl so mousemove works even when overlay has pointer-events:none
  useEffect(() => {
    const onMouseMove = () => resetHideTimer();
    containerEl.addEventListener("mousemove", onMouseMove);
    return () => containerEl.removeEventListener("mousemove", onMouseMove);
  }, [containerEl, resetHideTimer]);

  useEffect(() => {
    resetHideTimer();
    return () => clearTimeout(hideTimerRef.current);
  }, [resetHideTimer]);

  // Always show when paused or popup open
  useEffect(() => {
    if (!playing || popup !== null) {
      clearTimeout(hideTimerRef.current);
      setVisible(true);
    } else {
      resetHideTimer();
    }
  }, [playing, popup, resetHideTimer]);

  // ── Click on video area to toggle play/pause ──
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Ignore clicks on control bar or popups
      if (target.closest(".vp-bottom-bar") || target.closest(".vp-popup")) return;
      if (videoEl.paused) videoEl.play();
      else videoEl.pause();
    };
    containerEl.addEventListener("click", onClick);
    return () => containerEl.removeEventListener("click", onClick);
  }, [containerEl, videoEl]);

  // ── Click outside to close popup ──
  useEffect(() => {
    if (popup === null) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current
          .querySelector(".vp-popup")
          ?.contains(e.target as Node)
      ) {
        setPopup(null);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [popup]);

  // ── Fullscreen change listener ──
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === containerEl);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [containerEl]);

  // ── Handlers ──
  const togglePlay = () => {
    if (videoEl.paused) videoEl.play();
    else videoEl.pause();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    videoEl.currentTime = Number(e.target.value);
  };

  const toggleMute = () => {
    videoEl.muted = !videoEl.muted;
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    videoEl.volume = v;
    if (v > 0 && videoEl.muted) videoEl.muted = false;
  };

  const selectQuality = (quality: QualityOption | "auto") => {
    if (quality === "auto") {
      player.configure("abr.enabled", true);
      setIsAutoQuality(true);
    } else {
      player.configure("abr.enabled", false);
      const tracks = player.getVariantTracks();
      const track = tracks.find((t) => t.id === quality.id);
      if (track) {
        player.selectVariantTrack(track, true);
      }
      setIsAutoQuality(false);
    }
    setPopup(null);
  };

  const selectSpeed = (rate: number) => {
    videoEl.playbackRate = rate;
    setPopup(null);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerEl.requestFullscreen();
    }
  };

  const qualityLabel = activeHeight ? `${activeHeight}p` : "";
  const speedLabel = playbackRate === 1 ? "1x" : `${playbackRate}x`;
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  return (
    <div
      ref={wrapperRef}
      className={`vp-controls-wrapper${visible ? "" : " vp-hidden"}`}
    >
      {/* Spacer that pushes controls to bottom (click passes through to video) */}
      <div className="vp-click-area" />

      {/* Bottom gradient */}
      <div className="vp-gradient" />

      {/* Bottom bar */}
      <div className="vp-bottom-bar">
        {/* Progress bar */}
        <div className="vp-progress-row">
          <div className="vp-progress-track">
            <div
              className="vp-progress-buffered"
              style={{ width: `${bufferedPct}%` }}
            />
            <div
              className="vp-progress-played"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <input
            className="vp-progress-input"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
          />
        </div>

        {/* Controls row */}
        <div className="vp-controls-row">
          <div className="vp-controls-left">
            <button className="vp-btn" onClick={togglePlay}>
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>

            <div className="vp-volume-group">
              <button className="vp-btn" onClick={toggleMute}>
                {muted || volume === 0 ? <VolumeMuteIcon /> : <VolumeHighIcon />}
              </button>
              <div className="vp-volume-slider-wrap">
                <input
                  className="vp-volume-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={muted ? 0 : volume}
                  onChange={handleVolumeChange}
                />
              </div>
            </div>

            <span className="vp-time">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="vp-controls-right">
            {qualities.length > 0 && (
              <button
                className="vp-btn"
                onClick={() =>
                  setPopup((p) => (p === "quality" ? null : "quality"))
                }
              >
                <MonitorIcon />
                <span className="vp-btn-label">{qualityLabel}</span>
              </button>
            )}

            <button
              className="vp-btn"
              onClick={() =>
                setPopup((p) => (p === "speed" ? null : "speed"))
              }
            >
              <SpeedIcon />
              <span className="vp-btn-label">{speedLabel}</span>
            </button>

            <button className="vp-btn" onClick={toggleFullscreen}>
              {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
            </button>
          </div>
        </div>
      </div>

      {/* Quality popup */}
      {popup === "quality" && (
        <div className="vp-popup">
          <div className="vp-popup-header">Quality</div>
          <div
            className={`vp-popup-item${isAutoQuality ? " vp-active" : ""}`}
            onClick={() => selectQuality("auto")}
          >
            Auto{activeHeight ? ` (${activeHeight}p)` : ""}
          </div>
          {qualities.map((q) => (
            <div
              key={q.height}
              className={`vp-popup-item${
                !isAutoQuality && activeHeight === q.height ? " vp-active" : ""
              }`}
              onClick={() => selectQuality(q)}
            >
              {q.height}p
            </div>
          ))}
        </div>
      )}

      {/* Speed popup */}
      {popup === "speed" && (
        <div className="vp-popup">
          <div className="vp-popup-header">Speed</div>
          {SPEED_OPTIONS.map((rate) => (
            <div
              key={rate}
              className={`vp-popup-item${
                playbackRate === rate ? " vp-active" : ""
              }`}
              onClick={() => selectSpeed(rate)}
            >
              {rate}x
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
