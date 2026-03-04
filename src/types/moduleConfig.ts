export interface PlayerModuleConfig {
  filmstrip: boolean;
  qualityCompare: boolean;
  statsPanel: boolean;
  audioLevels: boolean;
  audioCompare: boolean;
  segmentExport: boolean;
  subtitles: boolean;
  adaptationToast: boolean;
  keyboardShortcuts: boolean;
  sleepWakeRecovery: boolean;
  sceneMarkers: boolean;
  qpHeatmap: boolean;
  watermark: boolean;
  drmDiagnostics: boolean;
}

export const MODULE_DEFAULTS: PlayerModuleConfig = {
  filmstrip: true,
  qualityCompare: true,
  statsPanel: true,
  audioLevels: true,
  audioCompare: true,
  segmentExport: true,
  subtitles: true,
  adaptationToast: true,
  keyboardShortcuts: true,
  sleepWakeRecovery: true,
  sceneMarkers: true,
  qpHeatmap: true,
  watermark: true,
  drmDiagnostics: true,
};
