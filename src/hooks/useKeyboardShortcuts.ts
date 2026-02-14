import { useEffect, useRef, useState, useCallback } from "react";

const SHUTTLE_SPEEDS = [1, 2, 4, 8, 16];
const VOLUME_STEP = 0.05;

interface UseKeyboardShortcutsOptions {
  videoEl: HTMLVideoElement;
  containerEl: HTMLDivElement;
  fps: number;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onInPointSet: (time: number) => void;
  onOutPointSet: (time: number) => void;
}

interface ShuttleState {
  shuttleSpeed: number;
  shuttleDirection: -1 | 0 | 1;
}

export function useKeyboardShortcuts({
  videoEl,
  containerEl,
  fps,
  onTogglePlay,
  onToggleMute,
  onToggleFullscreen,
  onInPointSet,
  onOutPointSet,
}: UseKeyboardShortcutsOptions): ShuttleState {
  const [shuttleSpeed, setShuttleSpeed] = useState(0);
  const [shuttleDirection, setShuttleDirection] = useState<-1 | 0 | 1>(0);

  const shuttleSpeedRef = useRef(0);
  const shuttleDirectionRef = useRef<-1 | 0 | 1>(0);
  const rafRef = useRef(0);
  const lastFrameTimeRef = useRef(0);

  const resetShuttle = useCallback(() => {
    shuttleSpeedRef.current = 0;
    shuttleDirectionRef.current = 0;
    setShuttleSpeed(0);
    setShuttleDirection(0);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  // Reverse shuttle loop via rAF (HTML5 video doesn't support negative playbackRate)
  const startReverseLoop = useCallback(() => {
    if (rafRef.current) return;
    lastFrameTimeRef.current = performance.now();

    const loop = (now: number) => {
      const elapsed = (now - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = now;
      const speed = shuttleSpeedRef.current;
      if (speed > 0 && shuttleDirectionRef.current === -1) {
        const newTime = videoEl.currentTime - elapsed * speed;
        videoEl.currentTime = Math.max(0, newTime);
        rafRef.current = requestAnimationFrame(loop);
      } else {
        rafRef.current = 0;
      }
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [videoEl]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing in form elements
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // Ignore if modifier keys are held (except shift for some keys)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case " ": {
          e.preventDefault();
          resetShuttle();
          videoEl.playbackRate = 1;
          onTogglePlay();
          break;
        }

        case "k":
        case "K": {
          e.preventDefault();
          resetShuttle();
          videoEl.playbackRate = 1;
          videoEl.pause();
          break;
        }

        case "l":
        case "L": {
          e.preventDefault();
          const dir = shuttleDirectionRef.current;
          const spd = shuttleSpeedRef.current;

          if (dir === -1) {
            // Was going reverse — stop reverse loop and reset
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
          }

          if (dir <= 0) {
            // Start forward at 1x
            shuttleDirectionRef.current = 1;
            shuttleSpeedRef.current = 1;
            videoEl.playbackRate = 1;
            videoEl.play();
          } else {
            // Increase speed
            const idx = SHUTTLE_SPEEDS.indexOf(spd);
            const nextIdx = Math.min(idx + 1, SHUTTLE_SPEEDS.length - 1);
            const nextSpeed = SHUTTLE_SPEEDS[nextIdx];
            shuttleSpeedRef.current = nextSpeed;
            videoEl.playbackRate = nextSpeed;
            videoEl.play();
          }

          setShuttleSpeed(shuttleSpeedRef.current);
          setShuttleDirection(shuttleDirectionRef.current);
          break;
        }

        case "j":
        case "J": {
          e.preventDefault();
          const dir = shuttleDirectionRef.current;
          const spd = shuttleSpeedRef.current;

          if (dir === 1) {
            // Was going forward — reset playbackRate
            videoEl.playbackRate = 1;
          }

          if (dir >= 0) {
            // Start reverse at 1x
            shuttleDirectionRef.current = -1;
            shuttleSpeedRef.current = 1;
            videoEl.pause();
            startReverseLoop();
          } else {
            // Increase reverse speed
            const idx = SHUTTLE_SPEEDS.indexOf(spd);
            const nextIdx = Math.min(idx + 1, SHUTTLE_SPEEDS.length - 1);
            shuttleSpeedRef.current = SHUTTLE_SPEEDS[nextIdx];
          }

          setShuttleSpeed(shuttleSpeedRef.current);
          setShuttleDirection(shuttleDirectionRef.current);
          break;
        }

        case "ArrowLeft":
        case ",": {
          e.preventDefault();
          resetShuttle();
          videoEl.playbackRate = 1;
          videoEl.pause();
          videoEl.currentTime = Math.max(0, videoEl.currentTime - 1 / fps);
          break;
        }

        case "ArrowRight":
        case ".": {
          e.preventDefault();
          resetShuttle();
          videoEl.playbackRate = 1;
          videoEl.pause();
          const dur = videoEl.duration || 0;
          videoEl.currentTime = Math.min(dur, videoEl.currentTime + 1 / fps);
          break;
        }

        case "ArrowUp": {
          e.preventDefault();
          const newVol = Math.min(1, videoEl.volume + VOLUME_STEP);
          videoEl.volume = newVol;
          if (newVol > 0 && videoEl.muted) videoEl.muted = false;
          break;
        }

        case "ArrowDown": {
          e.preventDefault();
          videoEl.volume = Math.max(0, videoEl.volume - VOLUME_STEP);
          break;
        }

        case "Home": {
          e.preventDefault();
          videoEl.currentTime = 0;
          break;
        }

        case "End": {
          e.preventDefault();
          videoEl.currentTime = videoEl.duration || 0;
          break;
        }

        case "i":
        case "I": {
          e.preventDefault();
          onInPointSet(videoEl.currentTime);
          break;
        }

        case "o":
        case "O": {
          e.preventDefault();
          onOutPointSet(videoEl.currentTime);
          break;
        }

        case "m":
        case "M": {
          e.preventDefault();
          onToggleMute();
          break;
        }

        case "f":
        case "F": {
          e.preventDefault();
          onToggleFullscreen();
          break;
        }
      }
    };

    containerEl.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      containerEl.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onKeyDown);
      cancelAnimationFrame(rafRef.current);
    };
  }, [
    videoEl,
    containerEl,
    fps,
    onTogglePlay,
    onToggleMute,
    onToggleFullscreen,
    onInPointSet,
    onOutPointSet,
    resetShuttle,
    startReverseLoop,
  ]);

  return {
    shuttleSpeed,
    shuttleDirection,
  };
}
