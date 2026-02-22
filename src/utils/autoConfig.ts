import type { PlayerModuleConfig } from "../types/moduleConfig";
import { MODULE_DEFAULTS } from "../types/moduleConfig";
import type { DeviceProfile } from "./detectCapabilities";

export function autoConfig(
  profile: DeviceProfile,
  buildPreset?: Partial<PlayerModuleConfig>,
): PlayerModuleConfig {
  // Start from defaults, then apply build preset
  const config: PlayerModuleConfig = { ...MODULE_DEFAULTS, ...buildPreset };

  // Hard gates: disable features when required APIs are absent
  if (!profile.webCodecs || !profile.offscreenCanvas) {
    config.filmstrip = false;
  }
  if (!profile.webCodecs || !profile.webGL2) {
    config.qualityCompare = false;
  }
  if (!profile.webAudio) {
    config.audioLevels = false;
  }
  if (!profile.workers) {
    config.segmentExport = false;
  }

  // Soft gates: disable heavy features on low-tier devices
  if (profile.performanceTier === "low") {
    config.filmstrip = false;
    config.qualityCompare = false;
  }

  return config;
}
