const STORAGE_KEY = "vp_settings";

export interface PlayerSettings {
  alwaysShowBitrate: boolean;
}

const DEFAULTS: PlayerSettings = {
  alwaysShowBitrate: false,
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
