export function formatTrackRes(
  width: number | null,
  height: number | null,
  frameRate: number | null
): string {
  if (width == null || height == null) return "N/A";
  const fps = frameRate ? `@${Math.round(frameRate)}` : "";
  return `${width}×${height}${fps}`;
}
