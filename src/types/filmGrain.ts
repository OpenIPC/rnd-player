export type GrainSize = "fine" | "medium" | "coarse";
export type GrainBlendMode = "additive" | "multiplicative";

export interface FilmGrainParams {
  intensity: number; // 0-100, maps to sigma 0.0-0.15
  size: GrainSize; // AR lag: fine=0, medium=1, coarse=2
  chromatic: boolean; // false = monochromatic, true = independent per-channel grain
  blendMode: GrainBlendMode;
}

export const FILM_GRAIN_DEFAULTS: FilmGrainParams = {
  intensity: 50,
  size: "medium",
  chromatic: false,
  blendMode: "additive",
};

const STORAGE_KEY = "vp_film_grain_params";

export function loadFilmGrainParams(): FilmGrainParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...FILM_GRAIN_DEFAULTS };
    return { ...FILM_GRAIN_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...FILM_GRAIN_DEFAULTS };
  }
}

export function saveFilmGrainParams(params: FilmGrainParams): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch { /* quota exceeded — ignore */ }
}
