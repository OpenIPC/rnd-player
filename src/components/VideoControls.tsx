import { useEffect, useState, useRef, useCallback, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
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
  AudioIcon,
  SubtitleIcon,
  PipIcon,
  CopyLinkIcon,
  StatsNerdIcon,
  AudioLevelsIcon,
  FilmstripIcon,
  InPointIcon,
  OutPointIcon,
  ClearMarkersIcon,
  FrameModeIcon,
} from "./icons";
const StatsPanel = lazy(() => import("./StatsPanel"));
const AudioLevels = lazy(() => import("./AudioLevels"));
import { formatTimecode } from "../utils/formatTime";
import type { TimecodeMode } from "../utils/formatTime";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

interface VideoControlsProps {
  videoEl: HTMLVideoElement;
  containerEl: HTMLDivElement;
  player: shaka.Player;
  src: string;
  clearKey?: string;
  showFilmstrip?: boolean;
  onToggleFilmstrip?: () => void;
  inPoint: number | null;
  outPoint: number | null;
  onInPointChange: (time: number | null) => void;
  onOutPointChange: (time: number | null) => void;
}

interface QualityOption {
  id: number;
  height: number;
  bandwidth: number;
}

interface AudioOption {
  index: number;
  language: string;
  label: string;
}

interface TextOption {
  id: number;
  language: string;
  label: string;
}

function langDisplayName(code: string, fallback: string): string {
  if (!code || code === "und") return fallback;
  try {
    return new Intl.DisplayNames([navigator.language], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_DELAY = 3000;
const STORAGE_KEY = "vp_playback_state";

export default function VideoControls({
  videoEl,
  containerEl,
  player,
  src,
  clearKey,
  showFilmstrip,
  onToggleFilmstrip,
  inPoint,
  outPoint,
  onInPointChange,
  onOutPointChange,
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
  const [audioTracks, setAudioTracks] = useState<AudioOption[]>([]);
  const [activeAudioIndex, setActiveAudioIndex] = useState(-1);
  const [textTracks, setTextTracks] = useState<TextOption[]>([]);
  const [activeTextId, setActiveTextId] = useState<number | null>(null);
  const [textVisible, setTextVisible] = useState(false);

  // UI state
  const [popup, setPopup] = useState<"quality" | "speed" | "audio" | "subtitles" | null>(null);
  const [visible, setVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showAudioLevels, setShowAudioLevels] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [timecodeMode, setTimecodeMode] = useState<TimecodeMode>("milliseconds");
  const [detectedFps, setDetectedFps] = useState<number | null>(null);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as never);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ── Track last-known-good state for sleep/wake recovery ──
  const lastTimeRef = useRef(videoEl.currentTime);
  const wasPausedRef = useRef(videoEl.paused);
  const guardUntilRef = useRef(0);

  // ── Video event listeners ──
  useEffect(() => {
    const isGuarding = () => Date.now() < guardUntilRef.current;

    const saveState = (time: number, paused: boolean) => {
      try {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ time, paused })
        );
      } catch {
        // sessionStorage may be unavailable (private browsing, quota, etc.)
      }
    };

    let lastSaveMs = 0;

    const onPlay = () => {
      if (isGuarding() && wasPausedRef.current) {
        // Unwanted play triggered by Shaka recovery after sleep — suppress it
        videoEl.pause();
        return;
      }
      wasPausedRef.current = false;
      setPlaying(true);
      saveState(videoEl.currentTime, false);
    };
    const onPause = () => {
      if (!isGuarding()) {
        wasPausedRef.current = true;
      }
      setPlaying(false);
      saveState(videoEl.currentTime, true);
    };
    const onTimeUpdate = () => {
      const now = videoEl.currentTime;
      if (isGuarding()) {
        // During guard window, if position jumped far from saved position
        // (e.g. Shaka reloaded and reset to 0), re-seek to saved position
        if (
          lastTimeRef.current > 5 &&
          Math.abs(now - lastTimeRef.current) > 5
        ) {
          videoEl.currentTime = lastTimeRef.current;
          return;
        }
      }
      lastTimeRef.current = now;
      setCurrentTime(now);

      // Throttled persist (~1 s)
      const ts = Date.now();
      if (ts - lastSaveMs >= 1000) {
        lastSaveMs = ts;
        saveState(now, videoEl.paused);
      }
    };
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
    const variantTracks = player.getVariantTracks();

    // Quality – deduplicate by height, keeping highest bandwidth per height
    const byHeight = new Map<number, QualityOption>();
    for (const t of variantTracks) {
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
    setQualities(
      Array.from(byHeight.values()).sort((a, b) => b.height - a.height)
    );
    const activeVariant = variantTracks.find((t) => t.active);
    if (activeVariant?.height != null) {
      setActiveHeight(activeVariant.height);
    }
    if (activeVariant?.frameRate != null && activeVariant.frameRate > 0) {
      setDetectedFps(activeVariant.frameRate);
    }

    // Audio tracks
    const audios = player.getAudioTracks();
    setAudioTracks(
      audios.map((t, i) => ({
        index: i,
        language: t.language,
        label: t.label || "",
      }))
    );
    const activeAudioIdx = audios.findIndex((t) => t.active);
    if (activeAudioIdx >= 0) {
      setActiveAudioIndex(activeAudioIdx);
    }

    // Text / subtitle tracks
    const texts = player.getTextTracks();
    setTextTracks(
      texts.map((t) => ({
        id: t.id,
        language: t.language,
        label: t.label || "",
      }))
    );
    const activeText = texts.find((t) => t.active);
    setTextVisible(activeText != null);
    if (activeText) {
      setActiveTextId(activeText.id);
    }
  }, [player]);

  useEffect(() => {
    updateTracks();

    const onTracksChanged = () => updateTracks();
    const onVariantChanged = () => updateTracks();
    const onAdaptation = () => updateTracks();

    player.addEventListener("trackschanged", onTracksChanged);
    player.addEventListener("variantchanged", onVariantChanged);
    player.addEventListener("adaptation", onAdaptation);
    player.addEventListener("textchanged", onTracksChanged);

    return () => {
      player.removeEventListener("trackschanged", onTracksChanged);
      player.removeEventListener("variantchanged", onVariantChanged);
      player.removeEventListener("adaptation", onAdaptation);
      player.removeEventListener("textchanged", onTracksChanged);
    };
  }, [player, updateTracks]);

  // ── Sleep/wake recovery ──
  // Uses both visibilitychange and a timer-gap detector so we catch real
  // system-sleep even when visibilitychange fires too early or not at all.
  const GUARD_DURATION = 5_000; // ms – how long to intercept unwanted play/seek after wake

  const startGuard = useCallback(() => {
    guardUntilRef.current = Date.now() + GUARD_DURATION;
    videoEl.currentTime = lastTimeRef.current;
    if (wasPausedRef.current) {
      videoEl.pause();
    }
  }, [videoEl]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) {
        // Waking up — restore state and start guard window
        startGuard();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [startGuard]);

  // Timer-gap sleep detector: if a 1 s interval takes ≥ 4 s, the system slept
  useEffect(() => {
    let lastTick = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      if (now - lastTick >= 4_000) {
        startGuard();
      }
      lastTick = now;
    }, 1_000);
    return () => clearInterval(id);
  }, [startGuard]);

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
      if (target.closest(".vp-bottom-bar") || target.closest(".vp-popup") || target.closest(".vp-stats-panel") || target.closest(".vp-context-menu") || target.closest(".vp-audio-levels") || target.closest(".vp-filmstrip-panel")) return;
      guardUntilRef.current = 0; // user intent — disable sleep/wake guard
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
      const target = e.target as Node;
      if (
        wrapperRef.current &&
        !wrapperRef.current
          .querySelector(".vp-popup-anchor .vp-popup")
          ?.contains(target) &&
        !(e.target as HTMLElement).closest?.(".vp-popup-anchor")
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

  // ── Context menu (right-click) ──
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const rect = containerEl.getBoundingClientRect();
      setContextMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    const dismissContextMenu = () => setContextMenu(null);

    containerEl.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("click", dismissContextMenu);
    return () => {
      containerEl.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("click", dismissContextMenu);
    };
  }, [containerEl]);

  // ── Handlers ──
  const togglePlay = () => {
    guardUntilRef.current = 0; // user intent — disable sleep/wake guard
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

  const selectAudio = (audio: AudioOption) => {
    const tracks = player.getAudioTracks();
    if (tracks[audio.index]) {
      player.selectAudioTrack(tracks[audio.index]);
    }
    setActiveAudioIndex(audio.index);
    setPopup(null);
  };

  const selectSubtitle = (text: TextOption | "off") => {
    if (text === "off") {
      player.selectTextTrack(null);
      setTextVisible(false);
      setActiveTextId(null);
    } else {
      const tracks = player.getTextTracks();
      const track = tracks.find((t) => t.id === text.id);
      if (track) {
        player.selectTextTrack(track);
        setTextVisible(true);
        setActiveTextId(text.id);
      }
    }
    setPopup(null);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerEl.requestFullscreen();
    }
  };

  const fps = detectedFps ?? 30;

  const { shuttleSpeed, shuttleDirection } = useKeyboardShortcuts({
    videoEl,
    containerEl,
    fps,
    onTogglePlay: togglePlay,
    onToggleMute: toggleMute,
    onToggleFullscreen: toggleFullscreen,
    onInPointSet: onInPointChange,
    onOutPointSet: onOutPointChange,
  });

  const togglePip = async () => {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await videoEl.requestPictureInPicture();
    }
  };

  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as never);

  const buildShareUrl = (withTime: boolean) => {
    const base = `${window.location.origin}${window.location.pathname}`;
    const params = new URLSearchParams();
    params.set("v", src);
    if (withTime) {
      params.set("t", `${Math.floor(videoEl.currentTime)}s`);
    }
    if (clearKey) {
      params.set("key", clearKey);
    }
    return `${base}?${params.toString()}`;
  };

  const copyVideoUrl = (withTime: boolean) => {
    const url = buildShareUrl(withTime);
    navigator.clipboard.writeText(url).then(() => {
      setCopiedMsg(withTime ? "URL with time copied" : "URL copied");
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedMsg(null), 2000);
    });
    setContextMenu(null);
  };

  const qualityLabel = activeHeight ? `${activeHeight}p` : "";
  const speedLabel = playbackRate === 1 ? "1x" : `${playbackRate}x`;
  const activeAudio = audioTracks[activeAudioIndex];
  const audioLabel = activeAudio
    ? (activeAudio.label || langDisplayName(activeAudio.language, `Track ${activeAudio.index + 1}`))
    : "";
  const activeTextTrack = textTracks.find((t) => t.id === activeTextId);
  const subtitleLabel =
    textVisible && activeTextTrack
      ? (activeTextTrack.label || langDisplayName(activeTextTrack.language, ""))
      : textTracks.length > 0 ? "Off" : "";
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
            {inPoint != null && outPoint != null && duration > 0 && (
              <div
                className="vp-marker-region"
                style={{
                  left: `${(inPoint / duration) * 100}%`,
                  width: `${((outPoint - inPoint) / duration) * 100}%`,
                }}
              />
            )}
            {inPoint != null && duration > 0 && (
              <div
                className="vp-marker vp-marker-in"
                style={{ left: `${(inPoint / duration) * 100}%` }}
              />
            )}
            {outPoint != null && duration > 0 && (
              <div
                className="vp-marker vp-marker-out"
                style={{ left: `${(outPoint / duration) * 100}%` }}
              />
            )}
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
            <button className="vp-btn vp-btn-play" onClick={togglePlay}>
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>

            <button
              className="vp-timecode"
              onClick={() =>
                setTimecodeMode((m) =>
                  m === "milliseconds"
                    ? "frames"
                    : m === "frames"
                      ? "totalFrames"
                      : "milliseconds",
                )
              }
              title="Click to toggle timecode format"
            >
              {(timecodeMode === "frames" || timecodeMode === "totalFrames") && <FrameModeIcon />}
              {formatTimecode(currentTime, timecodeMode, fps)}
              {" / "}
              {formatTimecode(duration, timecodeMode, fps)}
            </button>
            {shuttleDirection !== 0 && (
              <span className="vp-shuttle-indicator">
                {shuttleDirection === -1
                  ? `${"◀".repeat(Math.min(shuttleSpeed, 4))} ${shuttleSpeed}x`
                  : `${"▶".repeat(Math.min(shuttleSpeed, 4))} ${shuttleSpeed}x`}
              </span>
            )}
          </div>

          <div className="vp-controls-right">
            {qualities.length > 0 && (
              <div className="vp-popup-anchor">
                <button
                  className="vp-btn"
                  onClick={() =>
                    setPopup((p) => (p === "quality" ? null : "quality"))
                  }
                >
                  <MonitorIcon />
                  <span className="vp-btn-label">{qualityLabel}</span>
                </button>
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
              </div>
            )}

            <div className="vp-popup-anchor">
              <button
                className="vp-btn"
                onClick={() =>
                  setPopup((p) => (p === "speed" ? null : "speed"))
                }
              >
                <SpeedIcon />
                <span className="vp-btn-label">{speedLabel}</span>
              </button>
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

            {audioTracks.length > 1 && (
              <div className="vp-popup-anchor">
                <button
                  className="vp-btn"
                  onClick={() =>
                    setPopup((p) => (p === "audio" ? null : "audio"))
                  }
                >
                  <AudioIcon />
                  {audioLabel && <span className="vp-btn-label">{audioLabel}</span>}
                </button>
                {popup === "audio" && (
                  <div className="vp-popup">
                    <div className="vp-popup-header">Audio</div>
                    {audioTracks.map((a) => (
                      <div
                        key={a.index}
                        className={`vp-popup-item${
                          activeAudioIndex === a.index ? " vp-active" : ""
                        }`}
                        onClick={() => selectAudio(a)}
                      >
                        {a.label || langDisplayName(a.language, `Track ${a.index + 1}`)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {textTracks.length > 0 && (
              <div className="vp-popup-anchor">
                <button
                  className="vp-btn"
                  onClick={() =>
                    setPopup((p) => (p === "subtitles" ? null : "subtitles"))
                  }
                >
                  <SubtitleIcon />
                  {subtitleLabel && <span className="vp-btn-label">{subtitleLabel}</span>}
                </button>
                {popup === "subtitles" && (
                  <div className="vp-popup">
                    <div className="vp-popup-header">Subtitles</div>
                    <div
                      className={`vp-popup-item${!textVisible ? " vp-active" : ""}`}
                      onClick={() => selectSubtitle("off")}
                    >
                      Off
                    </div>
                    {textTracks.map((t, i) => (
                      <div
                        key={t.id}
                        className={`vp-popup-item${
                          textVisible && activeTextId === t.id ? " vp-active" : ""
                        }`}
                        onClick={() => selectSubtitle(t)}
                      >
                        {t.label || langDisplayName(t.language, `Track ${i + 1}`)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

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
                  style={{ '--vp-vol': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
                />
              </div>
            </div>

            <button className="vp-btn" onClick={togglePip}>
              <PipIcon />
            </button>

            <button className="vp-btn" onClick={toggleFullscreen}>
              {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
            </button>
          </div>
        </div>
      </div>

      {/* Context menu (right-click) — portaled so it stays above controls */}
      {contextMenu &&
        createPortal(
          <div
            className="vp-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="vp-context-menu-item"
              onClick={() => copyVideoUrl(false)}
            >
              <CopyLinkIcon />
              Copy video URL
            </div>
            <div
              className="vp-context-menu-item"
              onClick={() => copyVideoUrl(true)}
            >
              <CopyLinkIcon />
              Copy video URL at current time
            </div>
            <div className="vp-context-menu-separator" />
            <div
              className="vp-context-menu-item"
              onClick={() => {
                onInPointChange(videoEl.currentTime);
                setContextMenu(null);
              }}
            >
              <InPointIcon />
              Set in-point (I)
            </div>
            <div
              className="vp-context-menu-item"
              onClick={() => {
                onOutPointChange(videoEl.currentTime);
                setContextMenu(null);
              }}
            >
              <OutPointIcon />
              Set out-point (O)
            </div>
            {(inPoint != null || outPoint != null) && (
              <div
                className="vp-context-menu-item"
                onClick={() => {
                  onInPointChange(null);
                  onOutPointChange(null);
                  setContextMenu(null);
                }}
              >
                <ClearMarkersIcon />
                Clear in/out points
              </div>
            )}
            <div className="vp-context-menu-separator" />
            <div
              className="vp-context-menu-item"
              onClick={() => {
                setShowStats((s) => !s);
                setContextMenu(null);
              }}
            >
              <StatsNerdIcon />
              {showStats ? "Hide stats for nerds" : "Stats for nerds"}
            </div>
            <div
              className="vp-context-menu-item"
              onClick={() => {
                setShowAudioLevels((s) => !s);
                setContextMenu(null);
              }}
            >
              <AudioLevelsIcon />
              {showAudioLevels ? "Hide audio levels" : "Audio levels"}
            </div>
            {onToggleFilmstrip && (
              <div
                className="vp-context-menu-item"
                onClick={() => {
                  onToggleFilmstrip();
                  setContextMenu(null);
                }}
              >
                <FilmstripIcon />
                {showFilmstrip ? "Hide filmstrip" : "Filmstrip timeline"}
              </div>
            )}
          </div>,
          containerEl
        )}

      {/* Copied toast */}
      {copiedMsg &&
        createPortal(
          <div className="vp-copied-toast">{copiedMsg}</div>,
          containerEl
        )}

      {/* Stats for nerds panel — portaled into containerEl so it stays visible when controls auto-hide */}
      {showStats &&
        createPortal(
          <Suspense fallback={null}>
            <StatsPanel
              player={player}
              videoEl={videoEl}
              onClose={() => setShowStats(false)}
            />
          </Suspense>,
          containerEl
        )}

      {/* Audio level meters — portaled into containerEl so they stay visible when controls auto-hide */}
      {showAudioLevels && (
        <Suspense fallback={null}>
          <AudioLevels
            videoEl={videoEl}
            containerEl={containerEl}
            onClose={() => setShowAudioLevels(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
