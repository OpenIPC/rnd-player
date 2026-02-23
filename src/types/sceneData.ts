export interface Av1anScene {
  start_frame: number;
  end_frame: number;
  zone_overrides: unknown;
}

export interface Av1anSceneJson {
  frames: number;
  scenes: Av1anScene[];
  split_scenes?: unknown[];
}

export interface SceneData {
  totalFrames: number;
  boundaries: number[];
  fps: number;
  /** Applied PTS offset (from B-frame CTO); prevents double-application */
  ptsOffset: number;
  /** Original frame numbers from av1an — used to recompute boundaries from
   *  scratch when FPS or PTS offset changes, avoiding cumulative drift */
  originalFrames: number[];
}
