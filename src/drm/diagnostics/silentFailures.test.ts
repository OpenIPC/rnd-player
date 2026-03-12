import { describe, it, expect, vi } from "vitest";
import {
  checkEmeAbsent,
  checkSecureContext,
  checkKidMismatch,
  checkPsshMissing,
  checkKeyOutputRestricted,
  checkKeyExpired,
  checkKeyInternalError,
  checkKeyOutputDownscaled,
  checkNoDrmSystemSupported,
  checkLicenseNetworkError,
  checkLicenseHttpError,
  runPreLoadChecks,
  runPostLoadChecks,
  type DiagnosticContext,
} from "./silentFailures";

function baseCtx(overrides?: Partial<DiagnosticContext>): DiagnosticContext {
  return {
    state: { manifest: null, initSegment: null },
    emeAvailable: true,
    secureContext: true,
    ...overrides,
  };
}

describe("Silent Failure Checks", () => {
  // SF-001
  it("SF-001: returns warning when EME absent", () => {
    const result = checkEmeAbsent(baseCtx({ emeAvailable: false }));
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-001");
    expect(result!.severity).toBe("warning");
  });

  it("SF-001: returns null when EME available", () => {
    expect(checkEmeAbsent(baseCtx())).toBeNull();
  });

  // SF-002
  it("SF-002: returns error when not secure context and not localhost", () => {
    // jsdom defaults to localhost; use a non-localhost URL
    vi.stubGlobal("location", { ...location, hostname: "example.com" });
    try {
      const result = checkSecureContext(baseCtx({ secureContext: false }));
      expect(result).not.toBeNull();
      expect(result!.id).toBe("SF-002");
      expect(result!.severity).toBe("error");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("SF-002: returns null on localhost even without secure context", () => {
    // jsdom's location.hostname is localhost by default
    expect(checkSecureContext(baseCtx({ secureContext: false }))).toBeNull();
  });

  it("SF-002: returns null when secure context", () => {
    expect(checkSecureContext(baseCtx())).toBeNull();
  });

  // SF-003
  it("SF-003: returns error when KIDs mismatch", () => {
    const ctx = baseCtx({
      state: {
        manifest: {
          type: "dash",
          contentProtections: [
            { schemeIdUri: "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", systemName: "Widevine", defaultKid: "aabb-ccdd-eeff-0011-2233-4455-6677-8899" },
          ],
          hlsKeys: [],
        },
        initSegment: {
          tracks: [{ trackId: 1, scheme: "cenc", defaultKid: "11223344556677889900aabbccddeeff", defaultIvSize: 8, defaultConstantIv: null }],
          psshBoxes: [],
        },
      },
    });
    const result = checkKidMismatch(ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-003");
    expect(result!.severity).toBe("error");
  });

  it("SF-003: returns null when KIDs match", () => {
    const kid = "aabbccddeeff00112233445566778899";
    const ctx = baseCtx({
      state: {
        manifest: {
          type: "dash",
          contentProtections: [
            { schemeIdUri: "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", systemName: "Widevine", defaultKid: kid },
          ],
          hlsKeys: [],
        },
        initSegment: {
          tracks: [{ trackId: 1, scheme: "cenc", defaultKid: kid, defaultIvSize: 8, defaultConstantIv: null }],
          psshBoxes: [],
        },
      },
    });
    expect(checkKidMismatch(ctx)).toBeNull();
  });

  // SF-004
  it("SF-004: returns warning when ContentProtection present but no PSSH", () => {
    const ctx = baseCtx({
      state: {
        manifest: {
          type: "dash",
          contentProtections: [
            { schemeIdUri: "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", systemName: "Widevine" },
          ],
          hlsKeys: [],
        },
        initSegment: { tracks: [], psshBoxes: [] },
      },
    });
    const result = checkPsshMissing(ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-004");
    expect(result!.severity).toBe("warning");
  });

  // SF-005
  it("SF-005: returns error for output-restricted", () => {
    const ctx = baseCtx({ playerInfo: { keyStatuses: ["usable", "output-restricted"] } });
    const result = checkKeyOutputRestricted(ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-005");
    expect(result!.severity).toBe("error");
  });

  // SF-006
  it("SF-006: returns error for expired", () => {
    const ctx = baseCtx({ playerInfo: { keyStatuses: ["expired"] } });
    const result = checkKeyExpired(ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-006");
  });

  // SF-007
  it("SF-007: returns error for internal-error", () => {
    const ctx = baseCtx({ playerInfo: { keyStatuses: ["internal-error"] } });
    const result = checkKeyInternalError(ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-007");
  });

  // SF-008
  it("SF-008: returns warning for output-downscaled", () => {
    const ctx = baseCtx({ playerInfo: { keyStatuses: ["output-downscaled"] } });
    const result = checkKeyOutputDownscaled(ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-008");
    expect(result!.severity).toBe("warning");
  });

  // SF-009
  it("SF-009: returns error when multiple DRM systems but none negotiated", () => {
    const ctx = baseCtx({
      state: {
        manifest: {
          type: "dash",
          contentProtections: [
            { schemeIdUri: "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", systemName: "Widevine" },
            { schemeIdUri: "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", systemName: "PlayReady" },
          ],
          hlsKeys: [],
        },
        initSegment: null,
      },
      playerInfo: { keySystem: undefined },
    });
    const result = checkNoDrmSystemSupported(ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-009");
  });

  // SF-010
  it("SF-010: returns error for license network error", () => {
    const ctx = baseCtx({ lastError: { category: 6, code: 6007 } });
    const result = checkLicenseNetworkError(ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-010");
  });

  // SF-011
  it("SF-011: returns error for license HTTP error", () => {
    const ctx = baseCtx({ lastError: { category: 6, code: 6008 } });
    const result = checkLicenseHttpError(ctx);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("SF-011");
  });

  // Runners
  it("runPreLoadChecks returns only pre-load checks", () => {
    vi.stubGlobal("location", { ...location, hostname: "example.com" });
    try {
      const results = runPreLoadChecks(baseCtx({ emeAvailable: false, secureContext: false }));
      const ids = results.map((r) => r.id);
      expect(ids).toContain("SF-001");
      expect(ids).toContain("SF-002");
      expect(ids).not.toContain("SF-003");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("runPostLoadChecks returns only post-load checks", () => {
    const ctx = baseCtx({
      playerInfo: { keyStatuses: ["output-restricted", "expired"] },
    });
    const results = runPostLoadChecks(ctx);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("SF-005");
    expect(ids).toContain("SF-006");
    expect(ids).not.toContain("SF-001");
  });

  it("checks return null for healthy context", () => {
    const ctx = baseCtx({
      playerInfo: { keySystem: "com.widevine.alpha", keyStatuses: ["usable"] },
    });
    expect(checkEmeAbsent(ctx)).toBeNull();
    expect(checkSecureContext(ctx)).toBeNull();
    expect(checkKeyOutputRestricted(ctx)).toBeNull();
    expect(checkKeyExpired(ctx)).toBeNull();
    expect(checkKeyInternalError(ctx)).toBeNull();
    expect(checkKeyOutputDownscaled(ctx)).toBeNull();
  });
});
