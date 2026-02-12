import { useEffect, useRef, useState } from "react";
import shaka from "shaka-player";
import VideoControls from "./VideoControls";
import FilmstripTimeline from "./FilmstripTimeline";
import "./ShakaPlayer.css";

interface ShakaPlayerProps {
  src: string;
  autoPlay?: boolean;
  clearKey?: string;
  startTime?: number;
}

let polyfillsInstalled = false;

function ShakaPlayer({ src, autoPlay = false, clearKey, startTime }: ShakaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<shaka.Player | null>(null);
  const kidRef = useRef<string | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [activeKey, setActiveKey] = useState<string | undefined>(clearKey);
  const [showFilmstrip, setShowFilmstrip] = useState(false);

  useEffect(() => {
    if (!polyfillsInstalled) {
      shaka.polyfill.installAll();
      shaka.text.TextEngine.registerParser(
        "application/x-subrip",
        () => new shaka.text.SrtTextParser(),
      );
      polyfillsInstalled = true;
    }

    if (!shaka.Player.isBrowserSupported()) {
      console.error("Browser not supported by Shaka Player");
      return;
    }

    const video = videoRef.current!;
    const player = new shaka.Player();
    playerRef.current = player;
    let destroyed = false;

    player.attach(video).then(async () => {
      if (destroyed) return;

      player.addEventListener("error", (event) => {
        const detail = (event as CustomEvent).detail;
        console.error(
          "Shaka error: severity=%d category=%d code=%d",
          detail.severity,
          detail.category,
          detail.code,
          "data=",
          detail.data,
        );
        if (detail.severity === 2) {
          // severity 2 = CRITICAL
          if (detail.category === 6) {
            setError("DRM error: unable to decrypt content. Check that the decryption keys are correct.");
          } else if (detail.category === 3) {
            setError(
              kidRef.current
                ? "Media decode error: content could not be decrypted. The provided key may be incorrect."
                : "Media decode error: the video could not be played.",
            );
          } else if (detail.category === 1) {
            setError("Network error: could not load the video. Check your connection.");
          } else {
            setError(`Playback error (code ${detail.code}): the video could not be played.`);
          }
        }
      });

      // Read persisted state before loading so we can pass startTime to Shaka
      let savedState: { time: number; paused: boolean } | null = null;
      try {
        const raw = sessionStorage.getItem("vp_playback_state");
        if (raw) {
          savedState = JSON.parse(raw);
        }
      } catch {
        // sessionStorage unavailable
      }

      const loadStartTime =
        startTime != null && startTime > 0
          ? startTime
          : savedState && savedState.time > 0
            ? savedState.time
            : null;

      // Fetch manifest and extract cenc:default_KID for ClearKey DRM
      const response = await fetch(src);
      const xml = await response.text();
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      const cp = doc.querySelector("[*|default_KID]");
      const defaultKID =
        cp?.getAttribute("cenc:default_KID")?.replaceAll("-", "") ?? null;

      if (destroyed) return;

      kidRef.current = defaultKID;

      if (defaultKID && !clearKey) {
        setNeedsKey(true);
        return;
      }

      if (defaultKID && clearKey) {
        player.configure({
          drm: { clearKeys: { [defaultKID]: clearKey } },
        });
      }

      try {
        await player.load(src, loadStartTime);
        if (destroyed) return;
        setPlayerReady(true);

        if (savedState) {
          if (!savedState.paused) {
            video.play().catch(() => {});
          }
        } else if (autoPlay) {
          video.play().catch(() => {
            // Browser may block autoplay without user interaction
          });
        }
      } catch (e: unknown) {
        if (destroyed) return;
        if (e instanceof shaka.util.Error) {
          console.error("Error loading manifest:", e.code, e.message);
          setError(`Failed to load video (code ${e.code}).`);
        } else {
          setError("Failed to load video.");
        }
      }
    });

    return () => {
      destroyed = true;
      setPlayerReady(false);
      kidRef.current = null;
      player.destroy();
      playerRef.current = null;
    };
  }, [src, autoPlay, clearKey, startTime]);

  const handleKeySubmit = async (key: string) => {
    setNeedsKey(false);
    setActiveKey(key);

    const player = playerRef.current;
    const kid = kidRef.current;
    if (!player || !kid) return;

    player.configure({ drm: { clearKeys: { [kid]: key } } });

    try {
      await player.load(src);
      setPlayerReady(true);
      videoRef.current?.play().catch(() => {});
    } catch (e: unknown) {
      if (e instanceof shaka.util.Error) {
        console.error("Error loading manifest:", e.code, e.message);
        setError(`Failed to load video (code ${e.code}).`);
      } else {
        setError("Failed to load video.");
      }
    }
  };

  return (
    <div ref={containerRef} className={`vp-container${needsKey ? " vp-awaiting-key" : ""}`}>
      <div className="vp-video-area">
        <video ref={videoRef} />
        {needsKey && (
          <div className="vp-key-overlay">
            <form
              className="vp-key-form"
              onSubmit={(e) => {
                e.preventDefault();
                const value = new FormData(e.currentTarget).get("key") as string;
                if (value?.trim()) handleKeySubmit(value.trim());
              }}
            >
              <div className="vp-key-title">Encrypted content</div>
              <div className="vp-key-desc">Enter decryption key to play</div>
              <input
                name="key"
                className="vp-key-input"
                type="password"
                placeholder="Decryption key (hex)"
                autoFocus
              />
              <button type="submit" className="vp-key-submit">
                Play
              </button>
            </form>
          </div>
        )}
        {error && (
          <div className="vp-error-overlay">
            <div className="vp-error-message">{error}</div>
          </div>
        )}
        {playerReady &&
          videoRef.current &&
          containerRef.current &&
          playerRef.current && (
            <VideoControls
              videoEl={videoRef.current}
              containerEl={containerRef.current}
              player={playerRef.current}
              src={src}
              clearKey={activeKey}
              showFilmstrip={showFilmstrip}
              onToggleFilmstrip={() => setShowFilmstrip((s) => !s)}
            />
          )}
      </div>
      {showFilmstrip &&
        playerReady &&
        videoRef.current &&
        playerRef.current && (
          <FilmstripTimeline
            videoEl={videoRef.current}
            player={playerRef.current}
            onClose={() => setShowFilmstrip(false)}
          />
        )}
    </div>
  );
}

export default ShakaPlayer;
