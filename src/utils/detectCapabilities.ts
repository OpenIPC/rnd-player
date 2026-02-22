export type PerformanceTier = "low" | "mid" | "high";

export interface DeviceProfile {
  cpuCores: number;
  deviceMemoryGB: number;
  webCodecs: boolean;
  webGL2: boolean;
  webAudio: boolean;
  workers: boolean;
  offscreenCanvas: boolean;
  performanceTier: PerformanceTier;
}

let cached: DeviceProfile | null = null;

function probeWebGL2(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    return gl != null;
  } catch {
    return false;
  }
}

function classifyTier(
  cores: number,
  mem: number,
  webCodecs: boolean,
  webGL2: boolean,
): PerformanceTier {
  if (cores <= 2 || mem <= 2) return "low";
  if (cores >= 8 && mem >= 8 && webCodecs && webGL2) return "high";
  return "mid";
}

export async function detectCapabilities(): Promise<DeviceProfile> {
  if (cached) return cached;

  const cpuCores = navigator.hardwareConcurrency ?? 4;
  const deviceMemoryGB =
    (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const webCodecs = typeof VideoDecoder !== "undefined";
  const webGL2 = probeWebGL2();
  const webAudio =
    typeof AudioContext !== "undefined" ||
    typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined";
  const workers = typeof Worker !== "undefined";
  const offscreenCanvas = typeof OffscreenCanvas !== "undefined";
  const performanceTier = classifyTier(cpuCores, deviceMemoryGB, webCodecs, webGL2);

  cached = {
    cpuCores,
    deviceMemoryGB,
    webCodecs,
    webGL2,
    webAudio,
    workers,
    offscreenCanvas,
    performanceTier,
  };
  return cached;
}
