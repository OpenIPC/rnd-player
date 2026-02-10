import { useEffect, useRef, useState } from "react";
import shaka from "shaka-player";
import VideoControls from "./VideoControls";
import "./ShakaPlayer.css";

interface ShakaPlayerProps {
  src: string;
  autoPlay?: boolean;
}

let polyfillsInstalled = false;

function ShakaPlayer({ src, autoPlay = false }: ShakaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<shaka.Player | null>(null);
  const [playerReady, setPlayerReady] = useState(false);

  useEffect(() => {
    if (!polyfillsInstalled) {
      shaka.polyfill.installAll();
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

    player.attach(video).then(() => {
      if (destroyed) return;

      player.addEventListener("error", (event) => {
        const detail = (event as CustomEvent).detail;
        console.error("Shaka error:", detail);
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

      const startTime =
        savedState && savedState.time > 0 ? savedState.time : null;

      player
        .load(src, startTime)
        .then(() => {
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
        })
        .catch((error: unknown) => {
          if (destroyed) return;
          if (error instanceof shaka.util.Error) {
            console.error(
              "Error loading manifest:",
              error.code,
              error.message
            );
          }
        });
    });

    return () => {
      destroyed = true;
      setPlayerReady(false);
      player.destroy();
      playerRef.current = null;
    };
  }, [src, autoPlay]);

  return (
    <div ref={containerRef} className="vp-container">
      <video ref={videoRef} />
      {playerReady &&
        videoRef.current &&
        containerRef.current &&
        playerRef.current && (
          <VideoControls
            videoEl={videoRef.current}
            containerEl={containerRef.current}
            player={playerRef.current}
          />
        )}
    </div>
  );
}

export default ShakaPlayer;
