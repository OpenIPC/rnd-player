import { describe, it, expect, beforeEach, vi } from "vitest";
import { probeCompatibility, resetCompatCache } from "./compatChecker";

// Mock hasClearKeySupport
vi.mock("../../utils/softwareDecrypt", () => ({
  hasClearKeySupport: vi.fn().mockResolvedValue(false),
}));

describe("compatChecker", () => {
  beforeEach(() => {
    resetCompatCache();
    vi.restoreAllMocks();
  });

  it("returns supported:true when requestMediaKeySystemAccess resolves", async () => {
    const mockAccess = { createMediaKeys: vi.fn() };
    vi.stubGlobal("navigator", {
      ...navigator,
      requestMediaKeySystemAccess: vi.fn().mockResolvedValue(mockAccess),
    });

    const report = await probeCompatibility();
    expect(report.emeAvailable).toBe(true);
    expect(report.results.length).toBe(4);

    const widevine = report.results.find((r) => r.id === "widevine");
    expect(widevine?.supported).toBe(true);
    // Should have the highest robustness
    expect(widevine?.robustness).toBe("HW_SECURE_ALL");

    const clearkey = report.results.find((r) => r.id === "clearkey");
    expect(clearkey?.supported).toBe(true);

    vi.unstubAllGlobals();
  });

  it("returns supported:false when probe rejects", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      requestMediaKeySystemAccess: vi.fn().mockRejectedValue(new Error("not supported")),
    });

    const report = await probeCompatibility();
    for (const result of report.results) {
      expect(result.supported).toBe(false);
    }

    vi.unstubAllGlobals();
  });

  it("caches results — second call returns same reference", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      requestMediaKeySystemAccess: vi.fn().mockRejectedValue(new Error("nope")),
    });

    const r1 = await probeCompatibility();
    const r2 = await probeCompatibility();
    expect(r1).toBe(r2);

    vi.unstubAllGlobals();
  });

  it("includes secureContext and softwareDecryptAvailable flags", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      requestMediaKeySystemAccess: vi.fn().mockRejectedValue(new Error("nope")),
    });

    const report = await probeCompatibility();
    expect(typeof report.secureContext).toBe("boolean");
    expect(typeof report.softwareDecryptAvailable).toBe("boolean");
    expect(typeof report.emeAvailable).toBe("boolean");
    expect(typeof report.timestamp).toBe("number");

    vi.unstubAllGlobals();
  });

  it("reports correct key system strings", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      requestMediaKeySystemAccess: vi.fn().mockRejectedValue(new Error("nope")),
    });

    const report = await probeCompatibility();
    const systems = report.results.map((r) => r.keySystem);
    expect(systems).toContain("com.widevine.alpha");
    expect(systems).toContain("com.microsoft.playready");
    expect(systems).toContain("com.apple.fps");
    expect(systems).toContain("org.w3.clearkey");

    vi.unstubAllGlobals();
  });

  it("falls back to lower robustness when higher fails", async () => {
    let callCount = 0;
    vi.stubGlobal("navigator", {
      ...navigator,
      requestMediaKeySystemAccess: vi.fn().mockImplementation((_ks: string, configs: MediaKeySystemConfiguration[]) => {
        callCount++;
        const robustness = configs[0]?.videoCapabilities?.[0]?.robustness;
        // Only accept SW_SECURE_CRYPTO for Widevine
        if (robustness === "SW_SECURE_CRYPTO") return Promise.resolve({ createMediaKeys: vi.fn() });
        // Accept ClearKey always (no robustness)
        if (!robustness) return Promise.resolve({ createMediaKeys: vi.fn() });
        return Promise.reject(new Error("not supported"));
      }),
    });

    const report = await probeCompatibility();
    const widevine = report.results.find((r) => r.id === "widevine");
    expect(widevine?.supported).toBe(true);
    expect(widevine?.robustness).toBe("SW_SECURE_CRYPTO");
    expect(callCount).toBeGreaterThan(1);

    vi.unstubAllGlobals();
  });
});
