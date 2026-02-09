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

    player.attach(video).then(() => {
      player.addEventListener("error", (event) => {
        const detail = (event as CustomEvent).detail;
        console.error("Shaka error:", detail);
      });

      player
        .load(src)
        .then(() => {
          setPlayerReady(true);
        })
        .catch((error: unknown) => {
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
      setPlayerReady(false);
      player.destroy();
      playerRef.current = null;
    };
  }, [src]);

  return (
    <div ref={containerRef} className="vp-container">
      <video ref={videoRef} autoPlay={autoPlay} />
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
