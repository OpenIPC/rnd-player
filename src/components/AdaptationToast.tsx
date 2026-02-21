import { useEffect, useState, useRef, useCallback } from "react";
import shaka from "shaka-player";
import { formatBitrate } from "../utils/formatBitrate";

interface VariantSnapshot {
  height: number;
  bandwidth: number;
  videoCodec: string;
  audioCodec: string;
  channelsCount?: number;
}

interface ToastData {
  from: VariantSnapshot;
  to: VariantSnapshot;
  key: number;
}

function friendlyCodec(codec: string): string {
  if (!codec) return "";
  const c = codec.toLowerCase();
  if (c.startsWith("avc1") || c.startsWith("avc3")) return "H.264";
  if (c.startsWith("hvc1") || c.startsWith("hev1")) return "HEVC";
  if (c.startsWith("av01")) return "AV1";
  if (c.startsWith("vp9") || c.startsWith("vp09")) return "VP9";
  if (c.startsWith("mp4a.40")) return "AAC";
  if (c.startsWith("ac-3")) return "AC-3";
  if (c.startsWith("ec-3")) return "E-AC-3";
  if (c.startsWith("opus")) return "Opus";
  if (c.startsWith("flac")) return "FLAC";
  return codec.split(".")[0].toUpperCase();
}

function channelLabel(count?: number): string {
  if (!count) return "";
  switch (count) {
    case 1: return "mono";
    case 2: return "stereo";
    case 6: return "5.1";
    case 8: return "7.1";
    default: return `${count}ch`;
  }
}

/** Seconds of video buffered ahead of the current playback position. */
function getBufferedAhead(video: HTMLVideoElement): number {
  const ct = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    // Small epsilon so a currentTime sitting right on a range start isn't missed
    if (video.buffered.start(i) <= ct + 0.1 && video.buffered.end(i) > ct) {
      return video.buffered.end(i) - ct;
    }
  }
  return 0;
}

interface AdaptationToastProps {
  player: shaka.Player;
  videoEl: HTMLVideoElement;
}

// Mounted only when isAutoQuality is true (parent gates rendering).
// Unmounting naturally clears state when the user switches to manual quality.
export default function AdaptationToast({ player, videoEl }: AdaptationToastProps) {
  const [toast, setToast] = useState<ToastData | null>(null);
  const [pinned, setPinned] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const prevRef = useRef<VariantSnapshot | null>(null);
  const pinnedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(0 as never);
  const dismissRef = useRef<ReturnType<typeof setTimeout>>(0 as never);
  const exitRef = useRef<ReturnType<typeof setTimeout>>(0 as never);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as never);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const keyRef = useRef(0);

  const startExit = useCallback(() => {
    setExiting(true);
    clearTimeout(exitRef.current);
    exitRef.current = setTimeout(() => {
      setToast(null);
      setExiting(false);
      setPinned(false);
      setConfirmed(false);
      pinnedRef.current = false;
    }, 300);
  }, []);

  /** Mark the rendition switch as visually active and start the dismiss timer. */
  const confirmSwitch = useCallback(() => {
    setConfirmed(true);
    resizeCleanupRef.current?.();
    clearTimeout(confirmTimerRef.current);
    clearTimeout(dismissRef.current);
    dismissRef.current = setTimeout(() => {
      if (!pinnedRef.current) startExit();
    }, 4000);
  }, [startExit]);

  const getActiveVariant = useCallback((): VariantSnapshot | null => {
    const tracks = player.getVariantTracks();
    const active = tracks.find((t) => t.active);
    if (!active || active.height == null) return null;

    let channelsCount: number | undefined;
    try {
      const manifest = player.getManifest();
      if (manifest) {
        for (const v of manifest.variants) {
          if (v.video?.height === active.height && v.bandwidth === active.bandwidth) {
            channelsCount = v.audio?.channelsCount ?? undefined;
            break;
          }
        }
      }
    } catch { /* manifest may not be available */ }

    return {
      height: active.height,
      bandwidth: active.bandwidth,
      videoCodec: active.videoCodec ?? "",
      audioCodec: active.audioCodec ?? "",
      channelsCount,
    };
  }, [player]);

  useEffect(() => {
    // Capture current variant as baseline (no toast on initial load)
    const current = getActiveVariant();
    if (current) prevRef.current = current;

    const onAdaptation = () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const now = getActiveVariant();
        if (!now) return;

        const prev = prevRef.current;
        if (!prev) {
          prevRef.current = now;
          return;
        }

        const changed =
          prev.height !== now.height ||
          prev.bandwidth !== now.bandwidth ||
          prev.audioCodec !== now.audioCodec;

        if (changed) {
          keyRef.current += 1;
          pinnedRef.current = false;
          setPinned(false);
          setExiting(false);
          setConfirmed(false);
          setToast({ from: prev, to: now, key: keyRef.current });

          // Clean up previous confirmation state
          resizeCleanupRef.current?.();
          clearTimeout(confirmTimerRef.current);
          clearTimeout(dismissRef.current);
          clearTimeout(exitRef.current);

          const resolutionChanged = prev.height !== now.height;
          const bufferedAhead = getBufferedAhead(videoEl);
          const rate = videoEl.playbackRate || 1;
          const bufferDelay = Math.max(500, (bufferedAhead / rate) * 1000);

          if (resolutionChanged) {
            // Resolution changed — the exact moment is when videoHeight updates.
            // Check immediately in case resize already fired during debounce.
            if (videoEl.videoHeight === now.height) {
              confirmSwitch();
            } else {
              const onResize = () => {
                if (videoEl.videoHeight === now.height) {
                  confirmSwitch();
                }
              };
              videoEl.addEventListener("resize", onResize);
              resizeCleanupRef.current = () => {
                videoEl.removeEventListener("resize", onResize);
                resizeCleanupRef.current = null;
              };
              // Fallback: buffer-ahead heuristic + 1 s margin
              confirmTimerRef.current = setTimeout(() => {
                confirmSwitch();
              }, bufferDelay + 1000);
            }
          } else {
            // Same resolution, bitrate-only change — buffer-ahead heuristic
            confirmTimerRef.current = setTimeout(() => {
              confirmSwitch();
            }, bufferDelay);
          }
        }
        prevRef.current = now;
      }, 500);
    };

    player.addEventListener("adaptation", onAdaptation);
    return () => {
      player.removeEventListener("adaptation", onAdaptation);
      clearTimeout(debounceRef.current);
      clearTimeout(dismissRef.current);
      clearTimeout(exitRef.current);
      clearTimeout(confirmTimerRef.current);
      resizeCleanupRef.current?.();
    };
  }, [player, videoEl, getActiveVariant, confirmSwitch, startExit]);

  const handleMouseEnter = useCallback(() => {
    pinnedRef.current = true;
    setPinned(true);
    clearTimeout(dismissRef.current);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    clearTimeout(dismissRef.current);
    clearTimeout(confirmTimerRef.current);
    resizeCleanupRef.current?.();
    startExit();
  }, [startExit]);

  if (!toast) return null;

  const { from, to } = toast;
  const isUpgrade =
    to.height > from.height ||
    (to.height === from.height && to.bandwidth > from.bandwidth);

  const videoCodecChanged =
    friendlyCodec(from.videoCodec) !== friendlyCodec(to.videoCodec);

  const audioChanged =
    from.audioCodec !== to.audioCodec ||
    from.channelsCount !== to.channelsCount;

  const fmtVideo = (v: VariantSnapshot) => {
    const parts: string[] = [];
    if (videoCodecChanged) parts.push(friendlyCodec(v.videoCodec));
    parts.push(`${v.height}p`);
    parts.push(formatBitrate(v.bandwidth));
    return parts.join(" ");
  };

  const fmtAudio = (v: VariantSnapshot) => {
    const parts: string[] = [];
    parts.push(friendlyCodec(v.audioCodec));
    const ch = channelLabel(v.channelsCount);
    if (ch) parts.push(ch);
    return parts.join(" ");
  };

  const pending = !confirmed;

  const cls = [
    "vp-adaptation-toast",
    pending ? "vp-adaptation-pending" : "",
    pinned ? "vp-adaptation-pinned" : "",
    exiting ? "vp-adaptation-exiting" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={cls}
      key={toast.key}
      onMouseEnter={handleMouseEnter}
      onClick={handleClick}
    >
      <div className="vp-adaptation-line">
        <span className="vp-adaptation-from">{fmtVideo(from)}</span>
        <span className={`vp-adaptation-arrow ${isUpgrade ? "vp-up" : "vp-down"}`}>
          {confirmed ? "\u2713" : "\u2192"}
        </span>
        <span className="vp-adaptation-to">{fmtVideo(to)}</span>
      </div>
      {audioChanged && (
        <div className="vp-adaptation-line vp-adaptation-audio-line">
          <span className="vp-adaptation-from">{fmtAudio(from)}</span>
          <span className="vp-adaptation-arrow">
            {confirmed ? "\u2713" : "\u2192"}
          </span>
          <span className="vp-adaptation-to">{fmtAudio(to)}</span>
        </div>
      )}
    </div>
  );
}
