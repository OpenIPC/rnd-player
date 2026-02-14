export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export type TimecodeMode = "milliseconds" | "frames";

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

  if (mode === "frames") {
    const ff = String(Math.floor((seconds % 1) * fps)).padStart(2, "0");
    return `${hh}:${mm}:${ss}:${ff}`;
  }

  const ms = String(Math.round((seconds % 1) * 1000) % 1000).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
