import type { Av1anSceneJson, SceneData } from "../types/sceneData";

export function parseSceneData(json: unknown, fps: number): SceneData | null {
  if (fps <= 0 || !Number.isFinite(fps)) return null;
  if (json == null || typeof json !== "object") return null;

  const obj = json as Record<string, unknown>;
  if (typeof obj.frames !== "number" || !Array.isArray(obj.scenes)) return null;

  const raw = obj as unknown as Av1anSceneJson;
  if (raw.scenes.length === 0) return null;

  const boundarySet = new Set<number>();

  for (const scene of raw.scenes) {
    if (
      typeof scene.start_frame !== "number" ||
      typeof scene.end_frame !== "number"
    ) {
      return null;
    }
    if (scene.start_frame > 0) {
      boundarySet.add(scene.start_frame / fps);
    }
  }

  const boundaries = Array.from(boundarySet).sort((a, b) => a - b);

  return {
    totalFrames: raw.frames,
    boundaries,
    fps,
  };
}
