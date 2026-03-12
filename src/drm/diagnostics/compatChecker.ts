import { hasClearKeySupport } from "../../utils/softwareDecrypt";

export interface CompatResult {
  id: string;
  label: string;
  keySystem: string;
  supported: boolean;
  robustness?: string;
}

export interface CompatReport {
  results: CompatResult[];
  emeAvailable: boolean;
  secureContext: boolean;
  softwareDecryptAvailable: boolean;
  timestamp: number;
}

interface ProbeSpec {
  id: string;
  label: string;
  keySystem: string;
  robustnessLevels?: string[];
}

const PROBE_SPECS: ProbeSpec[] = [
  {
    id: "widevine",
    label: "Widevine",
    keySystem: "com.widevine.alpha",
    robustnessLevels: [
      "HW_SECURE_ALL",
      "HW_SECURE_DECODE",
      "HW_SECURE_CRYPTO",
      "SW_SECURE_DECODE",
      "SW_SECURE_CRYPTO",
    ],
  },
  {
    id: "playready",
    label: "PlayReady",
    keySystem: "com.microsoft.playready",
    robustnessLevels: ["3000", "2000", "150"],
  },
  {
    id: "fairplay",
    label: "FairPlay",
    keySystem: "com.apple.fps",
  },
  {
    id: "clearkey",
    label: "ClearKey",
    keySystem: "org.w3.clearkey",
  },
];

const VIDEO_CAPABILITY = { contentType: 'video/mp4; codecs="avc1.640028"' };

async function probeSystem(spec: ProbeSpec): Promise<CompatResult> {
  if (!navigator.requestMediaKeySystemAccess) {
    return { id: spec.id, label: spec.label, keySystem: spec.keySystem, supported: false };
  }

  if (spec.robustnessLevels) {
    // Try from highest to lowest robustness
    for (const robustness of spec.robustnessLevels) {
      try {
        await navigator.requestMediaKeySystemAccess(spec.keySystem, [
          { initDataTypes: ["cenc"], videoCapabilities: [{ ...VIDEO_CAPABILITY, robustness }] },
        ]);
        return {
          id: spec.id,
          label: spec.label,
          keySystem: spec.keySystem,
          supported: true,
          robustness,
        };
      } catch {
        // Try next level
      }
    }
    // Try without robustness
    try {
      await navigator.requestMediaKeySystemAccess(spec.keySystem, [
        { initDataTypes: ["cenc"], videoCapabilities: [VIDEO_CAPABILITY] },
      ]);
      return { id: spec.id, label: spec.label, keySystem: spec.keySystem, supported: true };
    } catch {
      return { id: spec.id, label: spec.label, keySystem: spec.keySystem, supported: false };
    }
  }

  // No robustness levels — simple probe
  try {
    await navigator.requestMediaKeySystemAccess(spec.keySystem, [
      { initDataTypes: ["cenc"], videoCapabilities: [VIDEO_CAPABILITY] },
    ]);
    return { id: spec.id, label: spec.label, keySystem: spec.keySystem, supported: true };
  } catch {
    return { id: spec.id, label: spec.label, keySystem: spec.keySystem, supported: false };
  }
}

let cachedReport: CompatReport | null = null;

export async function probeCompatibility(): Promise<CompatReport> {
  if (cachedReport) return cachedReport;

  const emeAvailable = !!navigator.requestMediaKeySystemAccess;
  const secureContext = typeof window !== "undefined" ? !!window.isSecureContext : false;

  // Probe all systems in parallel
  const results = await Promise.all(PROBE_SPECS.map(probeSystem));

  // Reuse hasClearKeySupport() for ClearKey entry (avoids redundant probing)
  const clearKeyResult = results.find((r) => r.id === "clearkey");
  if (clearKeyResult && !clearKeyResult.supported) {
    try {
      const ckSupported = await hasClearKeySupport();
      if (ckSupported) {
        clearKeyResult.supported = true;
      }
    } catch {
      // Ignore — already probed
    }
  }

  let softwareDecryptAvailable = false;
  try {
    softwareDecryptAvailable = typeof crypto !== "undefined" && !!crypto.subtle;
  } catch {
    // Restricted context
  }

  const report: CompatReport = {
    results,
    emeAvailable,
    secureContext,
    softwareDecryptAvailable,
    timestamp: performance.now(),
  };

  cachedReport = report;
  return report;
}

/** Reset cached report (for testing). */
export function resetCompatCache(): void {
  cachedReport = null;
}
