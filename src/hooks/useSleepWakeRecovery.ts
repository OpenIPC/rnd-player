import { useEffect, useRef, useCallback } from "react";

const GUARD_DURATION = 5_000;

export function useSleepWakeRecovery(
  videoEl: HTMLVideoElement,
  enabled: boolean,
) {
  const lastTimeRef = useRef(videoEl.currentTime);
  const wasPausedRef = useRef(videoEl.paused);
  const guardUntilRef = useRef(0);

  const startGuard = useCallback(() => {
    guardUntilRef.current = Date.now() + GUARD_DURATION;
    videoEl.currentTime = lastTimeRef.current;
    if (wasPausedRef.current) {
      videoEl.pause();
    }
  }, [videoEl]);

  // Visibilitychange detector
  useEffect(() => {
    if (!enabled) return;
    const onVisibilityChange = () => {
      if (!document.hidden) {
        startGuard();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [startGuard, enabled]);

  // Timer-gap sleep detector: if a 1 s interval takes >= 4 s, the system slept
  useEffect(() => {
    if (!enabled) return;
    let lastTick = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      if (now - lastTick >= 4_000) {
        startGuard();
      }
      lastTick = now;
    }, 1_000);
    return () => clearInterval(id);
  }, [startGuard, enabled]);

  return { lastTimeRef, wasPausedRef, guardUntilRef };
}
