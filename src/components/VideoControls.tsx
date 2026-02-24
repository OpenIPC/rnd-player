import { useEffect, useLayoutEffect, useState, useRef, useCallback, lazy, Suspense } from "react";
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
  SettingsIcon,
  FrameModeIcon,
} from "./icons";
import { useSegmentExport } from "../hooks/useSegmentExport";
import { extractInitSegmentUrl } from "../utils/extractInitSegmentUrl";
import { formatBitrate } from "../utils/formatBitrate";
import { useMultiSubtitles, type TextTrackInfo } from "../hooks/useMultiSubtitles";
import SubtitleOverlay from "./SubtitleOverlay";
import ContextMenu from "./ContextMenu";
import ExportPicker from "./ExportPicker";
const StatsPanel = lazy(() => import("./StatsPanel"));
const AudioLevels = lazy(() => import("./AudioLevels"));
const SettingsModal = lazy(() => import("./SettingsModal"));
import AdaptationToast from "./AdaptationToast";
import { formatTimecode } from "../utils/formatTime";
import type { TimecodeMode } from "../utils/formatTime";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useSleepWakeRecovery } from "../hooks/useSleepWakeRecovery";
import { loadSettings } from "../hooks/useSettings";
import type { CompareViewState } from "./ShakaPlayer";
import type { PlayerModuleConfig } from "../types/moduleConfig";
import type { SceneData } from "../types/sceneData";
import type { DeviceProfile } from "../utils/detectCapabilities";
import type { BoundaryPreview, RequestBoundaryPreviewFn } from "../hooks/useBoundaryPreviews";

interface VideoControlsProps {
  videoEl: HTMLVideoElement;
  containerEl: HTMLDivElement;
  player: shaka.Player;
  src: string;
  clearKey?: string;
  showFilmstrip?: boolean;
  onToggleFilmstrip?: () => void;
  showCompare?: boolean;
  onToggleCompare?: () => void;
  compareSrc?: string;
  compareHeightA?: number | null;
  compareHeightB?: number | null;
  compareViewRef?: React.RefObject<CompareViewState | null>;
  clearSleepGuardRef?: React.MutableRefObject<() => void>;
  inPoint: number | null;
  outPoint: number | null;
  onInPointChange: (time: number | null) => void;
  onOutPointChange: (time: number | null) => void;
  startOffset?: number;
  moduleConfig: PlayerModuleConfig;
  deviceProfile: DeviceProfile;
  onModuleConfigChange: (config: PlayerModuleConfig) => void;
  sceneData?: SceneData | null;
  onSceneDataChange?: (data: SceneData | null) => void;
  onLoadSceneFile?: (file: File) => void;
  scenesUrl?: string | null;
  boundaryPreviews?: Map<number, BoundaryPreview>;
  requestBoundaryPreview?: RequestBoundaryPreviewFn;
  clearBoundaryPreviews?: () => void;
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
  mimeType: string;
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

/** Small canvas that draws a single ImageBitmap scaled to a target width */
function BoundaryCanvas({ bitmap, width }: { bitmap: ImageBitmap | null; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const height = bitmap ? Math.round(width * (bitmap.height / bitmap.width)) : 56;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(bitmap, 0, 0, width, height);
  }, [bitmap, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="vp-boundary-frame"
      width={width}
      height={height}
      style={{ width, height }}
    />
  );
}

export default function VideoControls({
  videoEl,
  containerEl,
  player,
  src,
  clearKey,
  showFilmstrip,
  onToggleFilmstrip,
  showCompare,
  onToggleCompare,
  compareSrc,
  compareHeightA,
  compareHeightB,
  compareViewRef,
  clearSleepGuardRef,
  inPoint,
  outPoint,
  onInPointChange,
  onOutPointChange,
  startOffset = 0,
  moduleConfig,
  deviceProfile,
  onModuleConfigChange,
  sceneData,
  onSceneDataChange,
  onLoadSceneFile,
  scenesUrl,
  boundaryPreviews,
  requestBoundaryPreview,
  clearBoundaryPreviews,
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
  const [activeQualityId, setActiveQualityId] = useState<number | null>(null);
  const [isAutoQuality, setIsAutoQuality] = useState(true);
  const [audioTracks, setAudioTracks] = useState<AudioOption[]>([]);
  const [activeAudioIndex, setActiveAudioIndex] = useState(-1);
  const [textTracks, setTextTracks] = useState<TextOption[]>([]);
  const [activeTextIds, setActiveTextIds] = useState<Set<number>>(new Set());
  const [trackOrder, setTrackOrder] = useState<number[]>([]);

  // UI state
  const [popup, setPopup] = useState<"quality" | "speed" | "audio" | "subtitles" | null>(null);
  const [visible, setVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showAudioLevels, setShowAudioLevels] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [timecodeMode, setTimecodeMode] = useState<TimecodeMode>("milliseconds");
  const [detectedFps, setDetectedFps] = useState<number | null>(null);
  const [showExportPicker, setShowExportPicker] = useState(false);
  const [subtitleResetSignal, setSubtitleResetSignal] = useState(0);
  const [translateSetupSignal, setTranslateSetupSignal] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as never);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { startExport, exporting, progress, cancel: cancelExport } = useSegmentExport(
    player,
    inPoint,
    outPoint,
    clearKey,
  );

  // ── Sleep/wake recovery (extracted hook) ──
  const { lastTimeRef, wasPausedRef, guardUntilRef } = useSleepWakeRecovery(
    videoEl,
    moduleConfig.sleepWakeRecovery,
  );

  // Expose guard-clearing to sibling components (e.g. QualityCompare)
  if (clearSleepGuardRef) {
    clearSleepGuardRef.current = () => { guardUntilRef.current = 0; };
  }

  // ── Scene data: FPS + PTS offset correction ──
  // Corrects two independent errors when av1an scene data (frame-based)
  // is mapped to the DASH player's presentation timeline:
  // 1. FPS mismatch: initial fps guess may differ from detected fps
  // 2. PTS offset: B-frame CTO shifts the video start (e.g. +93ms for HEVC)
  // Recomputes from originalFrames every time to avoid cumulative drift.
  useEffect(() => {
    if (!sceneData || !onSceneDataChange || !sceneData.originalFrames) return;

    const targetFps = detectedFps ?? sceneData.fps;
    if (targetFps <= 0) return;

    const fpsChanged = Math.abs(targetFps - sceneData.fps) >= 0.01;
    const ptsChanged = Math.abs(startOffset - (sceneData.ptsOffset ?? 0)) >= 0.001;
    if (!fpsChanged && !ptsChanged) return;

    // Always recompute from raw frame numbers — no cumulative corrections
    const newBoundaries = sceneData.originalFrames.map(
      (f) => f / targetFps + startOffset,
    );

    onSceneDataChange({
      ...sceneData,
      boundaries: newBoundaries,
      fps: targetFps,
      ptsOffset: startOffset,
    });
  }, [detectedFps, startOffset, sceneData, onSceneDataChange]);

  // ── Scene navigation ──
  const SCENE_EPSILON = 0.05;

  const goToNextScene = useCallback(() => {
    if (!sceneData || sceneData.boundaries.length === 0) return;
    const t = videoEl.currentTime;
    const next = sceneData.boundaries.find((b) => b > t + SCENE_EPSILON);
    if (next != null) videoEl.currentTime = next;
  }, [sceneData, videoEl]);

  const goToPrevScene = useCallback(() => {
    if (!sceneData || sceneData.boundaries.length === 0) return;
    const t = videoEl.currentTime;
    const boundaries = sceneData.boundaries;
    let prev: number | undefined;
    for (let i = boundaries.length - 1; i >= 0; i--) {
      if (boundaries[i] < t - SCENE_EPSILON) {
        prev = boundaries[i];
        break;
      }
    }
    if (prev != null) videoEl.currentTime = prev;
    else videoEl.currentTime = startOffset;
  }, [sceneData, videoEl, startOffset]);

  // ── Drag-and-drop scene JSON onto player ──
  useEffect(() => {
    if (!moduleConfig.sceneMarkers || !onLoadSceneFile) return;
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file || !file.name.endsWith(".json")) return;
      onLoadSceneFile(file);
    };
    containerEl.addEventListener("dragover", onDragOver);
    containerEl.addEventListener("drop", onDrop);
    return () => {
      containerEl.removeEventListener("dragover", onDragOver);
      containerEl.removeEventListener("drop", onDrop);
    };
  }, [containerEl, moduleConfig.sceneMarkers, onLoadSceneFile]);

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
    let seekingFlag = false;

    const onSeeking = () => {
      seekingFlag = true;
    };
    const onSeeked = () => {
      seekingFlag = false;
      const now = videoEl.currentTime;
      lastTimeRef.current = now;
      setCurrentTime(now);
      saveState(now, videoEl.paused);
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
      // Skip intermediate updates while seeking to avoid frame counter flash
      if (seekingFlag) return;
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
    videoEl.addEventListener("seeking", onSeeking);
    videoEl.addEventListener("seeked", onSeeked);
    videoEl.addEventListener("timeupdate", onTimeUpdate);
    videoEl.addEventListener("durationchange", onDurationChange);
    videoEl.addEventListener("volumechange", onVolumeChange);
    videoEl.addEventListener("ratechange", onRateChange);
    videoEl.addEventListener("progress", onProgress);

    return () => {
      videoEl.removeEventListener("play", onPlay);
      videoEl.removeEventListener("pause", onPause);
      videoEl.removeEventListener("seeking", onSeeking);
      videoEl.removeEventListener("seeked", onSeeked);
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

    // Quality – keep all unique (height, videoBandwidth) pairs so multiple
    // bitrates at the same resolution each get their own menu item.
    // Use videoBandwidth (video-only) to avoid duplicates from audio-track
    // combinations inflating the total variant bandwidth.
    const seen = new Map<string, QualityOption>();
    for (const t of variantTracks) {
      if (t.height == null) continue;
      const vbw = t.videoBandwidth ?? t.bandwidth;
      const key = `${t.height}_${vbw}`;
      if (!seen.has(key)) {
        seen.set(key, {
          id: t.id,
          height: t.height,
          bandwidth: vbw,
        });
      }
    }
    setQualities(
      Array.from(seen.values()).sort(
        (a, b) => b.height - a.height || b.bandwidth - a.bandwidth
      )
    );
    const activeVariant = variantTracks.find((t) => t.active);
    if (activeVariant?.height != null) {
      setActiveHeight(activeVariant.height);
      setActiveQualityId(activeVariant.id);
    }
    if (activeVariant?.frameRate != null && activeVariant.frameRate > 0) {
      setDetectedFps(activeVariant.frameRate);
    }
    // Sync Auto state with actual ABR config — QualityCompare may
    // disable ABR on this player externally.
    const abrEnabled = player.getConfiguration().abr?.enabled !== false;
    if (!abrEnabled) setIsAutoQuality(false);

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
        mimeType: t.mimeType || "",
      }))
    );
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

  // ── Sync Auto quality with compare mode ──
  // QualityCompare disables ABR on the master player synchronously,
  // but no Shaka event fires for config changes. Force non-auto when
  // compare is active; restore auto when it closes (if ABR was re-enabled).
  useEffect(() => {
    if (showCompare) {
      setIsAutoQuality(false);
    } else {
      const abrEnabled = player.getConfiguration().abr?.enabled !== false;
      setIsAutoQuality(abrEnabled);
    }
  }, [showCompare, player]);

  // Compare mode while paused: hide controls so the frame comparison is unobstructed.
  const compareHidesControls = !!showCompare && !playing;

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

  // Listen on containerEl so mousemove works even when overlay has pointer-events:none.
  // Skip when compare mode is paused — controls stay hidden to keep the view clean.
  useEffect(() => {
    if (compareHidesControls) return;
    const onMouseMove = () => resetHideTimer();
    containerEl.addEventListener("mousemove", onMouseMove);
    return () => containerEl.removeEventListener("mousemove", onMouseMove);
  }, [containerEl, resetHideTimer, compareHidesControls]);

  useEffect(() => {
    resetHideTimer();
    return () => clearTimeout(hideTimerRef.current);
  }, [resetHideTimer]);

  // Always show when paused or popup open — but in compare mode while
  // paused, hide controls so the frame comparison is unobstructed.
  useEffect(() => {
    if (compareHidesControls) {
      clearTimeout(hideTimerRef.current);
      setVisible(false);
    } else if (!playing || popup !== null) {
      clearTimeout(hideTimerRef.current);
      setVisible(true);
    } else {
      resetHideTimer();
    }
  }, [playing, popup, resetHideTimer, compareHidesControls]);

  // ── Click on video area to toggle play/pause ──
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Only primary (left) button toggles play/pause
      if (e.button !== 0) return;
      // Skip if a context menu action was just clicked — the menu portal
      // is removed before this handler runs, so closest() can't match it.
      if (contextMenuDismissedRef.current) {
        contextMenuDismissedRef.current = false;
        return;
      }
      const target = e.target as HTMLElement;
      // Skip programmatic .click() on file inputs (e.g. context menu "Load scene data...")
      if (target.tagName === "INPUT" && (target as HTMLInputElement).type === "file") return;
      // Ignore clicks on control bar or popups
      if (target.closest(".vp-bottom-bar") || target.closest(".vp-popup") || target.closest(".vp-stats-panel") || target.closest(".vp-context-menu") || target.closest(".vp-audio-levels") || target.closest(".vp-filmstrip-panel") || target.closest(".vp-compare-overlay") || target.closest(".vp-compare-modal-overlay") || target.closest(".vp-debug-panel") || target.closest(".vp-export-picker") || target.closest(".vp-export-progress") || target.closest(".vp-subtitle-track") || target.closest(".vp-translate-backdrop") || target.closest(".vp-adaptation-toast")) return;
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
  // Track when a context menu click just dismissed the menu, so the
  // play/pause click handler can ignore the same click event.
  const contextMenuDismissedRef = useRef(false);
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY });
    };
    const dismissContextMenu = () => {
      if (contextMenu) contextMenuDismissedRef.current = true;
      setContextMenu(null);
    };

    containerEl.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("click", dismissContextMenu);
    return () => {
      containerEl.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("click", dismissContextMenu);
    };
  }, [containerEl, contextMenu]);

  // ── Handlers ──
  const togglePlay = () => {
    guardUntilRef.current = 0; // user intent — disable sleep/wake guard
    if (videoEl.paused) videoEl.play();
    else videoEl.pause();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    videoEl.currentTime = Math.max(startOffset, Number(e.target.value));
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

  const toggleSubtitle = (text: TextOption | "off") => {
    if (text === "off") {
      setActiveTextIds(new Set());
      setTrackOrder([]);
    } else {
      const id = text.id;
      const wasActive = activeTextIds.has(id);
      setActiveTextIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      // Must be outside the setActiveTextIds updater — React StrictMode
      // double-invokes updaters, and nested setState calls would fire twice.
      if (wasActive) {
        setTrackOrder((order) => order.filter((x) => x !== id));
      } else {
        setTrackOrder((order) => [...order, id]);
      }
    }
    // Do NOT close popup — let user toggle multiple tracks
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerEl.requestFullscreen();
    }
  };

  const fps = detectedFps ?? 30;

  const toggleSubtitleRef = useRef(toggleSubtitle);
  toggleSubtitleRef.current = toggleSubtitle;

  const toggleSubtitleByIndex = useCallback(
    (index: number) => {
      if (index < textTracks.length) {
        toggleSubtitleRef.current(textTracks[index]);
      }
    },
    [textTracks],
  );

  // Remember which tracks were active before 'c' toggled them off
  const lastActiveSubsRef = useRef<{ ids: Set<number>; order: number[] }>({ ids: new Set(), order: [] });

  const toggleAllSubtitles = useCallback(() => {
    if (textTracks.length === 0) return;
    if (activeTextIds.size > 0) {
      // Save current state and turn all off
      lastActiveSubsRef.current = { ids: new Set(activeTextIds), order: [...trackOrder] };
      setActiveTextIds(new Set());
      setTrackOrder([]);
    } else {
      // Restore previous state, or enable all if no previous state
      const prev = lastActiveSubsRef.current;
      if (prev.ids.size > 0) {
        setActiveTextIds(new Set(prev.ids));
        setTrackOrder([...prev.order]);
      } else {
        const allIds = new Set(textTracks.map((t) => t.id));
        setActiveTextIds(allIds);
        setTrackOrder(textTracks.map((t) => t.id));
      }
    }
  }, [textTracks, activeTextIds, trackOrder]);

  const toggleAllSubtitlesRef = useRef(toggleAllSubtitles);
  toggleAllSubtitlesRef.current = toggleAllSubtitles;

  const stableToggleAllSubtitles = useCallback(() => {
    toggleAllSubtitlesRef.current();
  }, []);

  const { shuttleSpeed, shuttleDirection } = useKeyboardShortcuts({
    videoEl,
    fps,
    onTogglePlay: togglePlay,
    onToggleMute: toggleMute,
    onToggleFullscreen: toggleFullscreen,
    onInPointSet: onInPointChange,
    onOutPointSet: onOutPointChange,
    onToggleSubtitleByIndex: toggleSubtitleByIndex,
    onToggleAllSubtitles: stableToggleAllSubtitles,
    onToggleHelp: useCallback(() => setShowHelp((s) => !s), []),
    onNextScene: sceneData ? goToNextScene : undefined,
    onPrevScene: sceneData ? goToPrevScene : undefined,
    enabled: moduleConfig.keyboardShortcuts,
  });

  // Multi-subtitle hook: fetches, parses, and filters active cues
  const textTrackInfos: TextTrackInfo[] = textTracks;
  const { activeCues, getContextCues } = useMultiSubtitles(player, videoEl, activeTextIds, textTrackInfos);

  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as never);

  const showCopiedToast = useCallback((msg: string) => {
    setCopiedMsg(msg);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedMsg(null), 2000);
  }, []);

  const handleSubtitleCopy = useCallback((text: string, toast?: string) => {
    navigator.clipboard.writeText(text).then(() => showCopiedToast(toast ?? "Subtitle copied"));
  }, [showCopiedToast]);

  // ── Ctrl+C / Cmd+C copies visible subtitle text ──
  const activeCuesRef = useRef(activeCues);
  activeCuesRef.current = activeCues;
  const trackOrderRef = useRef(trackOrder);
  trackOrderRef.current = trackOrder;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "c") return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return; // user selected text — let browser handle
      const cues = activeCuesRef.current;
      const order = trackOrderRef.current;
      if (cues.size === 0) return;
      const texts: string[] = [];
      for (const trackId of order) {
        const trackCues = cues.get(trackId);
        if (trackCues) {
          texts.push(trackCues.map((c) => c.text).join("\n"));
        }
      }
      if (texts.length === 0) return;
      e.preventDefault();
      navigator.clipboard.writeText(texts.join("\n\n")).then(() => showCopiedToast("Subtitle copied"));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showCopiedToast]);

  const togglePip = async () => {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await videoEl.requestPictureInPicture();
    }
  };

  const copyVideoUrl = () => {
    const base = `${window.location.origin}${window.location.pathname}`;
    const params = new URLSearchParams();
    params.set("v", src);
    params.set("t", `${parseFloat(videoEl.currentTime.toFixed(3))}s`);
    if (clearKey) params.set("key", clearKey);
    if (scenesUrl) params.set("scenes", scenesUrl);
    if (compareSrc) params.set("compare", compareSrc);
    if (compareHeightA) params.set("qa", String(compareHeightA));
    if (compareHeightB) params.set("qb", String(compareHeightB));
    const cv = compareViewRef?.current;
    if (cv) {
      if (cv.zoom > 1) {
        params.set("zoom", cv.zoom.toFixed(2));
        params.set("px", cv.panXFrac.toFixed(4));
        params.set("py", cv.panYFrac.toFixed(4));
      }
      if (Math.round(cv.sliderPct) !== 50) {
        params.set("split", String(Math.round(cv.sliderPct)));
      }
      if (cv.highlightX != null && cv.highlightY != null && cv.highlightW != null && cv.highlightH != null) {
        params.set("hx", cv.highlightX.toFixed(4));
        params.set("hy", cv.highlightY.toFixed(4));
        params.set("hw", cv.highlightW.toFixed(4));
        params.set("hh", cv.highlightH.toFixed(4));
      }
      if (cv.cmode && cv.cmode !== "split") {
        params.set("cmode", cv.cmode);
      }
      if (cv.cmode === "toggle" && cv.flickerInterval && cv.flickerInterval !== 500) {
        params.set("cfi", String(cv.flickerInterval));
      }
      if (cv.cmode === "diff" && cv.amplification && cv.amplification !== 1) {
        params.set("amp", String(cv.amplification));
      }
      if (cv.cmode === "diff" && cv.palette && cv.palette !== "ssim") {
        params.set("pal", cv.palette);
      }
      if (cv.cmode === "diff" && cv.palette === "vmaf" && cv.vmafModel && cv.vmafModel !== "hd") {
        params.set("vmodel", cv.vmafModel);
      }
    }
    navigator.clipboard.writeText(`${base}?${params.toString()}`).then(() => {
      showCopiedToast("URL copied");
    });
    setContextMenu(null);
  };

  const copyDownloadScript = async () => {
    const manifest = player.getManifest();
    if (!manifest?.variants?.length) return;

    const activeTrack = player.getVariantTracks().find((t) => t.active);
    if (!activeTrack) return;

    // Find matching video stream
    let stream: shaka.extern.Stream | null = null;
    for (const v of manifest.variants) {
      if (
        v.video &&
        v.video.width === activeTrack.width &&
        v.video.height === activeTrack.height &&
        v.video.codecs === activeTrack.videoCodec
      ) {
        stream = v.video;
        break;
      }
    }
    if (!stream) return;

    await stream.createSegmentIndex();
    if (!stream.segmentIndex) return;

    const iter = stream.segmentIndex[Symbol.iterator]();
    const firstResult = iter.next();
    if (firstResult.done) return;

    const initUrl = extractInitSegmentUrl(firstResult.value);
    if (!initUrl) return;

    const segmentUrls: string[] = [];
    for (const ref of stream.segmentIndex) {
      if (!ref) continue;
      const uris = ref.getUris();
      if (uris.length > 0) segmentUrls.push(uris[0]);
    }
    if (segmentUrls.length === 0) return;

    const height = activeTrack.height ?? 0;
    const codec = activeTrack.videoCodec ?? "unknown";
    const bw = activeTrack.videoBandwidth ?? 0;
    const bwStr =
      bw > 1_000_000
        ? `${(bw / 1_000_000).toFixed(1)} Mbps`
        : `${Math.round(bw / 1000)} kbps`;

    const lines: string[] = [
      `#!/bin/bash`,
      `# Stream download — ${height}p ${codec} ${bwStr} (${segmentUrls.length} segments)`,
      `# Generated by R&D Player`,
      `set -e`,
      ``,
      `DIR="stream_${height}p"`,
      `mkdir -p "$DIR"`,
      ``,
      `INIT='${initUrl}'`,
      `SEGS=(`,
    ];

    for (const url of segmentUrls) {
      lines.push(`  '${url}'`);
    }

    lines.push(
      `)`,
      ``,
      `echo "Downloading init segment..."`,
      `curl -sS -o "$DIR/init.m4s" "$INIT"`,
      ``,
      `echo "Downloading \${#SEGS[@]} media segments..."`,
      `for i in "\${!SEGS[@]}"; do`,
      `  n=$((i + 1))`,
      `  printf "\\r  %d/%d" "$n" "\${#SEGS[@]}"`,
      `  curl -sS -o "$DIR/seg_$(printf '%05d' "$n").m4s" "\${SEGS[$i]}"`,
      `done`,
      `echo ""`,
      ``,
      `echo "Concatenating into fragmented MP4..."`,
      `cat "$DIR/init.m4s" "$DIR"/seg_*.m4s > "$DIR/stream.fmp4"`,
      ``,
      `echo "Remuxing to regular MP4..."`,
      `ffmpeg -y -i "$DIR/stream.fmp4" -codec copy "$DIR/stream.mp4"`,
      ``,
      `echo "Done: $DIR/stream.mp4"`,
      `echo ""`,
      `echo "# Scene detection:"`,
      `echo "# av1an --sc-only -i $DIR/stream.mp4 --scenes $DIR/scenes.json -x 0"`,
      ``,
    );

    const script = lines.join("\n");
    await navigator.clipboard.writeText(script);
    showCopiedToast("Download script copied");
    setContextMenu(null);
  };

  const hasMultipleBitratesPerHeight = qualities.some(
    (q, i) => qualities.findIndex((r) => r.height === q.height) !== i
  );
  const alwaysShowBitrate = loadSettings().alwaysShowBitrate;
  const showBitrate = hasMultipleBitratesPerHeight || alwaysShowBitrate;
  const qualityLabel = isAutoQuality
    ? `Auto${activeHeight ? ` (${activeHeight}p)` : ""}`
    : activeHeight
      ? showBitrate
        ? `${activeHeight}p ${formatBitrate(qualities.find((q) => q.id === activeQualityId)?.bandwidth ?? 0)}`
        : `${activeHeight}p`
      : "";
  const speedLabel = playbackRate === 1 ? "1x" : `${playbackRate}x`;
  const activeAudio = audioTracks[activeAudioIndex];
  const audioLabel = activeAudio
    ? (activeAudio.label || langDisplayName(activeAudio.language, `Track ${activeAudio.index + 1}`))
    : "";
  const subtitleLabel = (() => {
    if (activeTextIds.size === 0) return textTracks.length > 0 ? "Off" : "";
    if (activeTextIds.size === 1) {
      const t = textTracks.find((t) => activeTextIds.has(t.id));
      return t ? (t.label || langDisplayName(t.language, "")) : "";
    }
    return String(activeTextIds.size);
  })();
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  // ── Progress bar hover tooltip ──
  const [hoverInfo, setHoverInfo] = useState<{ pct: number; time: number } | null>(null);
  const progressRowRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const onProgressMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const row = progressRowRef.current;
      if (!row || !duration) return;
      // When the interactive tooltip is open, ignore moves above the track
      // so diagonal cursor travel toward the tooltip doesn't shift the scene
      if (tooltipRef.current) {
        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) return;
      }
      const rect = row.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setHoverInfo({ pct: pct * 100, time: pct * duration });
    },
    [duration],
  );

  const onProgressMouseLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Don't dismiss if cursor moved into the tooltip (boundary preview click targets)
    const related = e.relatedTarget as Node | null;
    if (related && tooltipRef.current?.contains(related)) return;
    setHoverInfo(null);
  }, []);

  const onTooltipMouseLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Dismiss unless cursor moved back into the progress row
    const related = e.relatedTarget as Node | null;
    if (related && progressRowRef.current?.contains(related)) return;
    setHoverInfo(null);
  }, []);

  // ── Boundary previews: request on hover ──
  useEffect(() => {
    if (!hoverInfo || !sceneData || !moduleConfig.sceneMarkers || !requestBoundaryPreview) return;
    if (sceneData.boundaries.length === 0 || !sceneData.originalFrames) return;

    let sceneNum = 1;
    for (const b of sceneData.boundaries) {
      if (hoverInfo.time >= b) sceneNum++;
      else break;
    }

    // Left boundary: entry into current scene (boundary between scene N-1 and N)
    if (sceneNum >= 2) {
      const idx = sceneNum - 2;
      requestBoundaryPreview(sceneData.boundaries[idx], sceneData.originalFrames[idx]);
    }
    // Right boundary: exit from current scene (boundary between scene N and N+1)
    if (sceneNum - 1 < sceneData.boundaries.length) {
      const idx = sceneNum - 1;
      requestBoundaryPreview(sceneData.boundaries[idx], sceneData.originalFrames[idx]);
    }
  }, [hoverInfo, sceneData, moduleConfig.sceneMarkers, requestBoundaryPreview]);

  // ── Clear boundary previews when sceneData changes (FPS correction) ──
  useEffect(() => {
    if (clearBoundaryPreviews) clearBoundaryPreviews();
  }, [sceneData, clearBoundaryPreviews]);

  // ── Clamp tooltip so it doesn't overflow the container edges ──
  useLayoutEffect(() => {
    const tip = tooltipRef.current;
    const row = progressRowRef.current;
    if (!tip || !row || !hoverInfo) return;
    // Reset to default centered position to measure natural placement
    tip.style.left = `${hoverInfo.pct}%`;
    tip.style.transform = "translateX(-50%)";
    const tipRect = tip.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    const overflowLeft = containerRect.left - tipRect.left;
    const overflowRight = tipRect.right - containerRect.right;
    if (overflowLeft > 0) {
      // Pin left edge of tooltip to container left edge
      const rowRect = row.getBoundingClientRect();
      tip.style.transform = "none";
      tip.style.left = `${containerRect.left - rowRect.left}px`;
    } else if (overflowRight > 0) {
      // Pin right edge of tooltip to container right edge
      const rowRect = row.getBoundingClientRect();
      tip.style.transform = "none";
      tip.style.left = `${containerRect.right - rowRect.left - tipRect.width}px`;
    }
  }, [hoverInfo, containerEl]);

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
        <div
          className="vp-progress-row"
          ref={progressRowRef}
          onMouseMove={onProgressMouseMove}
          onMouseLeave={onProgressMouseLeave}
        >
          {hoverInfo && (() => {
            // Pre-compute boundary preview data to determine interactivity
            let sceneNum = 0;
            let leftPreview: BoundaryPreview | undefined;
            let rightPreview: BoundaryPreview | undefined;
            let leftIdx = -1;
            let rightIdx = -1;
            if (moduleConfig.sceneMarkers && sceneData && sceneData.boundaries.length > 0 && boundaryPreviews) {
              sceneNum = 1;
              for (const b of sceneData.boundaries) {
                if (hoverInfo.time >= b) sceneNum++;
                else break;
              }
              leftIdx = sceneNum >= 2 ? sceneNum - 2 : -1;
              rightIdx = sceneNum - 1 < sceneData.boundaries.length ? sceneNum - 1 : -1;
              leftPreview = leftIdx >= 0 ? boundaryPreviews.get(sceneData.boundaries[leftIdx]) : undefined;
              rightPreview = rightIdx >= 0 ? boundaryPreviews.get(sceneData.boundaries[rightIdx]) : undefined;
            }
            const hasPreviewImages = !!(leftPreview || rightPreview);

            const seekToBoundary = (boundaryTime: number) => (e: React.MouseEvent) => {
              e.stopPropagation();
              videoEl.currentTime = boundaryTime;
              setHoverInfo(null);
            };

            return (
            <div
              ref={tooltipRef}
              className={`vp-progress-tooltip${hasPreviewImages ? " vp-progress-tooltip-interactive" : ""}`}
              style={{ left: `${hoverInfo.pct}%` }}
              onMouseMove={hasPreviewImages ? e => e.stopPropagation() : undefined}
              onMouseLeave={onTooltipMouseLeave}
            >
              <div className="vp-progress-tooltip-text">
                {formatTimecode(Math.max(0, hoverInfo.time - startOffset), timecodeMode, fps)}
                {sceneNum > 0 && ` \u00b7 Scene ${sceneNum}`}
              </div>
              {hasPreviewImages && sceneData && (
                  <div className="vp-progress-boundary-row">
                    {leftPreview && (
                      <div
                        className="vp-progress-boundary-pair"
                        onClick={seekToBoundary(sceneData.boundaries[leftIdx])}
                      >
                        <div className="vp-progress-boundary-label">S{sceneNum - 1} → S{sceneNum}</div>
                        <div className="vp-boundary-frames">
                          <BoundaryCanvas bitmap={leftPreview.before} width={100} />
                          <div className="vp-boundary-divider" style={{ height: leftPreview.before ? Math.round(100 * (leftPreview.before.height / leftPreview.before.width)) : 56 }} />
                          <BoundaryCanvas bitmap={leftPreview.after} width={100} />
                        </div>
                      </div>
                    )}
                    {rightPreview && (
                      <div
                        className="vp-progress-boundary-pair"
                        onClick={seekToBoundary(sceneData.boundaries[rightIdx])}
                      >
                        <div className="vp-progress-boundary-label">S{sceneNum} → S{sceneNum + 1}</div>
                        <div className="vp-boundary-frames">
                          <BoundaryCanvas bitmap={rightPreview.before} width={100} />
                          <div className="vp-boundary-divider" style={{ height: rightPreview.before ? Math.round(100 * (rightPreview.before.height / rightPreview.before.width)) : 56 }} />
                          <BoundaryCanvas bitmap={rightPreview.after} width={100} />
                        </div>
                      </div>
                    )}
                  </div>
              )}
            </div>
            );
          })()}
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
            {moduleConfig.sceneMarkers && sceneData && duration > 0 &&
              sceneData.boundaries.map((t, i) => (
                <div
                  key={i}
                  className="vp-scene-tick"
                  style={{ left: `${(t / duration) * 100}%` }}
                />
              ))}
          </div>
          <input
            className="vp-progress-input"
            type="range"
            min={0}
            max={duration || 0}
            step="any"
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
              {formatTimecode(Math.max(0, currentTime - startOffset), timecodeMode, fps)}
              {" / "}
              {formatTimecode(Math.max(0, duration - startOffset), timecodeMode, fps)}
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
            {qualities.length > 0 && !showCompare && (
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
                        key={q.id}
                        className={`vp-popup-item${
                          !isAutoQuality && activeQualityId === q.id ? " vp-active" : ""
                        }`}
                        onClick={() => selectQuality(q)}
                      >
                        {q.height}p
                        {(alwaysShowBitrate ||
                          (hasMultipleBitratesPerHeight &&
                            qualities.filter((r) => r.height === q.height).length > 1)) &&
                          ` ${formatBitrate(q.bandwidth)}`}
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
                      className={`vp-popup-item${activeTextIds.size === 0 ? " vp-active" : ""}`}
                      onClick={() => toggleSubtitle("off")}
                    >
                      Off
                    </div>
                    {textTracks.map((t, i) => (
                      <div
                        key={t.id}
                        className={`vp-popup-item vp-checkbox${
                          activeTextIds.has(t.id) ? " vp-checked" : ""
                        }`}
                        onClick={() => toggleSubtitle(t)}
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

            <button className="vp-btn" onClick={() => setShowSettings(true)} title="Settings">
              <SettingsIcon />
            </button>

            <button className="vp-btn" onClick={toggleFullscreen}>
              {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
            </button>
          </div>
        </div>
      </div>

      {/* Context menu (right-click) — portaled so it stays above controls */}
      {contextMenu && (
        <ContextMenu
          position={contextMenu}
          containerEl={containerEl}
          moduleConfig={moduleConfig}
          onCopyUrl={copyVideoUrl}
          onCopyDownloadScript={copyDownloadScript}
          onSetInPoint={() => {
            onInPointChange(videoEl.currentTime);
            setContextMenu(null);
          }}
          onSetOutPoint={() => {
            onOutPointChange(videoEl.currentTime);
            setContextMenu(null);
          }}
          onClearMarkers={() => {
            onInPointChange(null);
            onOutPointChange(null);
            setContextMenu(null);
          }}
          onExportMp4={() => {
            setShowExportPicker(true);
            setContextMenu(null);
          }}
          onResetSubtitlePositions={() => {
            setSubtitleResetSignal((s) => s + 1);
            setContextMenu(null);
          }}
          onTranslationSettings={() => {
            setTranslateSetupSignal((s) => s + 1);
            setContextMenu(null);
          }}
          onToggleStats={() => {
            setShowStats((s) => !s);
            setContextMenu(null);
          }}
          onToggleAudioLevels={() => {
            setShowAudioLevels((s) => !s);
            setContextMenu(null);
          }}
          onToggleCompare={onToggleCompare ? () => {
            onToggleCompare();
            setContextMenu(null);
          } : undefined}
          onToggleFilmstrip={onToggleFilmstrip ? () => {
            onToggleFilmstrip();
            setContextMenu(null);
          } : undefined}
          hasMarkers={inPoint != null || outPoint != null}
          hasInOutPoints={inPoint != null && outPoint != null}
          hasActiveSubtitles={activeTextIds.size > 0}
          hasSubtitlePositions={(() => { try { const raw = localStorage.getItem("vp_subtitle_positions"); return !!(raw && Object.keys(JSON.parse(raw)).length > 0); } catch { return false; } })()}
          hasTranslateConfig={(() => { try { const raw = localStorage.getItem("vp_translate_settings"); if (!raw) return false; const s = JSON.parse(raw); return !!(s.apiKey || s.endpoint); } catch { return false; } })()}
          showStats={showStats}
          showAudioLevels={showAudioLevels}
          showCompare={!!showCompare}
          showFilmstrip={!!showFilmstrip}
        />
      )}

      {/* Copied toast */}
      {copiedMsg &&
        createPortal(
          <div className="vp-copied-toast">{copiedMsg}</div>,
          containerEl
        )}

      {/* ABR adaptation toast — only in Auto quality mode */}
      {moduleConfig.adaptationToast && isAutoQuality &&
        createPortal(
          <AdaptationToast player={player} videoEl={videoEl} />,
          containerEl
        )}

      {/* Export rendition picker */}
      {showExportPicker && (
        <ExportPicker
          player={player}
          containerEl={containerEl}
          onSelect={(r) => {
            setShowExportPicker(false);
            startExport(r);
          }}
          onClose={() => setShowExportPicker(false)}
        />
      )}

      {/* Export progress toast */}
      {exporting &&
        progress &&
        createPortal(
          <div className="vp-export-progress" onClick={cancelExport}>
            Exporting: {progress.loaded}/{progress.total} segments...
          </div>,
          containerEl
        )}

      {/* Subtitle overlay — portaled so it stays visible when controls auto-hide */}
      {createPortal(
        <SubtitleOverlay activeCues={moduleConfig.subtitles ? activeCues : new Map()} trackOrder={moduleConfig.subtitles ? trackOrder : []} controlsVisible={visible} textTracks={textTracks} resetSignal={subtitleResetSignal} translateSetupSignal={translateSetupSignal} onCopyText={handleSubtitleCopy} getContextCues={getContextCues} videoEl={videoEl} />,
        containerEl
      )}

      {/* Stats for nerds panel — portaled into containerEl so it stays visible when controls auto-hide */}
      {moduleConfig.statsPanel && showStats &&
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
      {moduleConfig.audioLevels && showAudioLevels && (
        <Suspense fallback={null}>
          <AudioLevels
            videoEl={videoEl}
            containerEl={containerEl}
            onClose={() => setShowAudioLevels(false)}
          />
        </Suspense>
      )}

      {/* Help modal — portaled to body */}
      {showHelp && createPortal(
        <div className="vp-help-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowHelp(false); }} onKeyDown={(e) => { if (e.key === "Escape") setShowHelp(false); }}>
          <div className="vp-help-modal">
            <div className="vp-help-header">
              <h3 className="vp-help-title">Keyboard Shortcuts</h3>
              <button className="vp-help-close" onClick={() => setShowHelp(false)}>&times;</button>
            </div>
            <div className="vp-help-body">
              <div className="vp-help-section">
                <h4 className="vp-help-section-title">Playback</h4>
                <div className="vp-help-row"><kbd>Space</kbd><span>Play / Pause</span></div>
                <div className="vp-help-row"><kbd>K</kbd><span>Pause</span></div>
                <div className="vp-help-row"><kbd>L</kbd><span>Play forward / increase speed</span></div>
                <div className="vp-help-row"><kbd>J</kbd><span>Play reverse / increase speed</span></div>
              </div>
              <div className="vp-help-section">
                <h4 className="vp-help-section-title">Navigation</h4>
                <div className="vp-help-row"><kbd>&larr;</kbd> <kbd>,</kbd><span>Previous frame</span></div>
                <div className="vp-help-row"><kbd>&rarr;</kbd> <kbd>.</kbd><span>Next frame</span></div>
                <div className="vp-help-row"><kbd>Shift+&uarr;</kbd><span>Forward 1 second</span></div>
                <div className="vp-help-row"><kbd>Shift+&darr;</kbd><span>Back 1 second</span></div>
                <div className="vp-help-row"><kbd>Home</kbd><span>Go to beginning</span></div>
                <div className="vp-help-row"><kbd>End</kbd><span>Go to end</span></div>
                <div className="vp-help-row"><kbd>PgDn</kbd><span>Next scene boundary</span></div>
                <div className="vp-help-row"><kbd>PgUp</kbd><span>Previous scene boundary</span></div>
              </div>
              <div className="vp-help-section">
                <h4 className="vp-help-section-title">Audio</h4>
                <div className="vp-help-row"><kbd>M</kbd><span>Mute / Unmute</span></div>
                <div className="vp-help-row"><kbd>&uarr;</kbd><span>Volume up</span></div>
                <div className="vp-help-row"><kbd>&darr;</kbd><span>Volume down</span></div>
              </div>
              <div className="vp-help-section">
                <h4 className="vp-help-section-title">Subtitles</h4>
                <div className="vp-help-row"><kbd>C</kbd><span>Toggle all subtitles</span></div>
                <div className="vp-help-row"><kbd>1</kbd>&ndash;<kbd>9</kbd><span>Toggle subtitle track N</span></div>
              </div>
              <div className="vp-help-section">
                <h4 className="vp-help-section-title">Editing</h4>
                <div className="vp-help-row"><kbd>I</kbd><span>Set in-point</span></div>
                <div className="vp-help-row"><kbd>O</kbd><span>Set out-point</span></div>
              </div>
              <div className="vp-help-section">
                <h4 className="vp-help-section-title">View</h4>
                <div className="vp-help-row"><kbd>F</kbd><span>Toggle fullscreen</span></div>
                <div className="vp-help-row"><kbd>+</kbd> <kbd>=</kbd><span>Filmstrip zoom in</span></div>
                <div className="vp-help-row"><kbd>-</kbd><span>Filmstrip zoom out</span></div>
                <div className="vp-help-row"><kbd>H</kbd> <kbd>?</kbd><span>This help</span></div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Settings modal — portaled to body */}
      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            onClose={() => setShowSettings(false)}
            moduleConfig={moduleConfig}
            deviceProfile={deviceProfile}
            onModuleConfigChange={onModuleConfigChange}
          />
        </Suspense>
      )}
    </div>
  );
}
