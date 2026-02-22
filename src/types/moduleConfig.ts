export interface PlayerModuleConfig {
  filmstrip: boolean;
  qualityCompare: boolean;
  statsPanel: boolean;
  audioLevels: boolean;
  segmentExport: boolean;
  subtitles: boolean;
  adaptationToast: boolean;
  keyboardShortcuts: boolean;
  sleepWakeRecovery: boolean;
}

export const MODULE_DEFAULTS: PlayerModuleConfig = {
  filmstrip: true,
  qualityCompare: true,
  statsPanel: true,
  audioLevels: true,
  segmentExport: true,
  subtitles: true,
  adaptationToast: true,
  keyboardShortcuts: true,
  sleepWakeRecovery: true,
};
