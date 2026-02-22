import type { PlayerModuleConfig } from "../types/moduleConfig";

const STORAGE_KEY = "vp_settings";

export interface PlayerSettings {
  alwaysShowBitrate: boolean;
  moduleOverrides: Partial<PlayerModuleConfig>;
}

const DEFAULTS: PlayerSettings = {
  alwaysShowBitrate: false,
  moduleOverrides: {},
};

export function loadSettings(): PlayerSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PlayerSettings>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch { /* corrupt or unavailable */ }
  return { ...DEFAULTS };
}

export function saveSettings(settings: PlayerSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* localStorage unavailable */ }
}

export function loadModuleOverrides(): Partial<PlayerModuleConfig> {
  return loadSettings().moduleOverrides;
}
