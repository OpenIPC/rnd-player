export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export type TimecodeMode = "milliseconds" | "frames" | "totalFrames";

export function formatTimecode(
  seconds: number,
  mode: TimecodeMode,
  fps: number = 30,
): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const hh = String(h);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");

  // Use floor with a tiny epsilon so the entire duration of frame N
  // (from N/fps up to but not including (N+1)/fps) displays as frame N.
  // The epsilon handles floating-point imprecision at exact boundaries.
  const FRAME_EPS = 1e-6;

  if (mode === "totalFrames") {
    return String(Math.floor(seconds * fps + FRAME_EPS));
  }

  if (mode === "frames") {
    const ff = String(Math.floor((seconds % 1) * fps + FRAME_EPS) % fps).padStart(2, "0");
    return `${hh}:${mm}:${ss}:${ff}`;
  }

  // Work in integer milliseconds to avoid floating-point carry issues
  // (e.g. 2.9999... would otherwise decompose as 2s + 1000ms → "02.000")
  const totalMs = Math.round(seconds * 1000);
  const msH = Math.floor(totalMs / 3600000);
  const msM = Math.floor((totalMs % 3600000) / 60000);
  const msS = Math.floor((totalMs % 60000) / 1000);
  const msFrac = totalMs % 1000;
  return `${msH}:${String(msM).padStart(2, "0")}:${String(msS).padStart(2, "0")}.${String(msFrac).padStart(3, "0")}`;
}
