import type { DrmDiagnosticsState } from "./types";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface DiagnosticResult {
  id: string;
  severity: DiagnosticSeverity;
  title: string;
  detail: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface DiagnosticContext {
  state: DrmDiagnosticsState;
  playerInfo?: {
    keySystem?: string;
    keyStatuses?: string[];
  };
  lastError?: { category: number; code: number; data?: unknown[] };
  emeAvailable: boolean;
  clearKeySupported?: boolean;
  secureContext: boolean;
}

// --- Individual check functions ---

/** SF-001: EME API absent. */
export function checkEmeAbsent(ctx: DiagnosticContext): DiagnosticResult | null {
  if (ctx.emeAvailable) return null;
  return {
    id: "SF-001",
    severity: "warning",
    title: "EME API not available",
    detail:
      "navigator.requestMediaKeySystemAccess is not present. " +
      "DRM-protected content cannot be played natively. " +
      "This may occur in insecure contexts, older browsers, or embedded WebViews.",
    timestamp: performance.now(),
  };
}

/** SF-002: Secure context required but missing. */
export function checkSecureContext(ctx: DiagnosticContext): DiagnosticResult | null {
  if (ctx.secureContext) return null;
  // localhost is always secure
  if (
    typeof location !== "undefined" &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  )
    return null;
  return {
    id: "SF-002",
    severity: "error",
    title: "Not a secure context",
    detail:
      "EME requires a secure context (HTTPS or localhost). " +
      "The page is loaded over HTTP, so DRM key system access will be denied by the browser.",
    timestamp: performance.now(),
  };
}

/** SF-003: KID mismatch between manifest and init segment. */
export function checkKidMismatch(ctx: DiagnosticContext): DiagnosticResult | null {
  const manifestKids = new Set<string>();
  if (ctx.state.manifest) {
    for (const cp of ctx.state.manifest.contentProtections) {
      if (cp.defaultKid) manifestKids.add(cp.defaultKid.toLowerCase().replaceAll("-", ""));
    }
  }
  if (manifestKids.size === 0) return null;

  const initKids = new Set<string>();
  if (ctx.state.initSegment) {
    for (const track of ctx.state.initSegment.tracks) {
      if (track.defaultKid) initKids.add(track.defaultKid.toLowerCase().replaceAll("-", ""));
    }
  }
  if (initKids.size === 0) return null;

  // Check if there's any overlap
  let hasOverlap = false;
  for (const kid of manifestKids) {
    if (initKids.has(kid)) { hasOverlap = true; break; }
  }
  if (hasOverlap) return null;

  return {
    id: "SF-003",
    severity: "error",
    title: "KID mismatch: manifest vs init segment",
    detail:
      `Manifest default_KID (${[...manifestKids].join(", ")}) does not match ` +
      `init segment tenc KID (${[...initKids].join(", ")}). ` +
      "The player will request a key for the wrong KID, causing silent decryption failure.",
    timestamp: performance.now(),
    data: { manifestKids: [...manifestKids], initKids: [...initKids] },
  };
}

/** SF-004: PSSH missing for declared DRM systems. */
export function checkPsshMissing(ctx: DiagnosticContext): DiagnosticResult | null {
  if (!ctx.state.manifest) return null;
  const cpSystems = ctx.state.manifest.contentProtections
    .filter((cp) => cp.schemeIdUri !== "urn:mpeg:dash:mp4protection:2011")
    .map((cp) => cp.systemName);
  if (cpSystems.length === 0) return null;

  const hasPssh =
    (ctx.state.manifestPsshBoxes && ctx.state.manifestPsshBoxes.length > 0) ||
    (ctx.state.initSegment?.psshBoxes && ctx.state.initSegment.psshBoxes.length > 0) ||
    ctx.state.manifest.contentProtections.some((cp) => cp.psshBase64);

  if (hasPssh) return null;

  return {
    id: "SF-004",
    severity: "warning",
    title: "No PSSH boxes found",
    detail:
      `ContentProtection declares ${cpSystems.join(", ")} but no PSSH box was found ` +
      "in the manifest or init segment. Some CDMs require PSSH to initiate a license request.",
    timestamp: performance.now(),
    data: { systems: cpSystems },
  };
}

/** SF-005: Key status output-restricted. */
export function checkKeyOutputRestricted(ctx: DiagnosticContext): DiagnosticResult | null {
  if (!ctx.playerInfo?.keyStatuses?.includes("output-restricted")) return null;
  return {
    id: "SF-005",
    severity: "error",
    title: "Key status: output-restricted",
    detail:
      "The CDM reports output-restricted — the display or output path does not meet " +
      "the content's HDCP requirements. Video will be black or not render.",
    timestamp: performance.now(),
  };
}

/** SF-006: Key status expired. */
export function checkKeyExpired(ctx: DiagnosticContext): DiagnosticResult | null {
  if (!ctx.playerInfo?.keyStatuses?.includes("expired")) return null;
  return {
    id: "SF-006",
    severity: "error",
    title: "Key status: expired",
    detail:
      "The license has expired. The CDM will no longer decrypt content. " +
      "A new license request is needed.",
    timestamp: performance.now(),
  };
}

/** SF-007: Key status internal-error. */
export function checkKeyInternalError(ctx: DiagnosticContext): DiagnosticResult | null {
  if (!ctx.playerInfo?.keyStatuses?.includes("internal-error")) return null;
  return {
    id: "SF-007",
    severity: "error",
    title: "Key status: internal-error",
    detail:
      "The CDM encountered an internal error processing the key. " +
      "This is typically a platform-level issue (driver, TEE, or CDM crash).",
    timestamp: performance.now(),
  };
}

/** SF-008: Key status output-downscaled. */
export function checkKeyOutputDownscaled(ctx: DiagnosticContext): DiagnosticResult | null {
  if (!ctx.playerInfo?.keyStatuses?.includes("output-downscaled")) return null;
  return {
    id: "SF-008",
    severity: "warning",
    title: "Key status: output-downscaled",
    detail:
      "The CDM is downscaling output resolution because the display does not meet " +
      "HDCP requirements for the requested resolution. Content will play at lower quality.",
    timestamp: performance.now(),
  };
}

/** SF-009: Multiple DRM systems in manifest but none supported. */
export function checkNoDrmSystemSupported(ctx: DiagnosticContext): DiagnosticResult | null {
  if (!ctx.state.manifest) return null;
  const systems = ctx.state.manifest.contentProtections
    .filter((cp) => cp.schemeIdUri !== "urn:mpeg:dash:mp4protection:2011");
  if (systems.length < 2) return null;
  // If a key system was negotiated, at least one is supported
  if (ctx.playerInfo?.keySystem) return null;
  return {
    id: "SF-009",
    severity: "error",
    title: "No DRM system supported",
    detail:
      `Manifest declares ${systems.length} DRM systems (${systems.map((s) => s.systemName).join(", ")}) ` +
      "but the browser did not negotiate any key system. None of the declared systems are available.",
    timestamp: performance.now(),
    data: { systems: systems.map((s) => s.systemName) },
  };
}

/** SF-010: License server unreachable (network error). */
export function checkLicenseNetworkError(ctx: DiagnosticContext): DiagnosticResult | null {
  if (!ctx.lastError) return null;
  // Shaka category 6 = DRM, code 6007 = LICENSE_REQUEST_FAILED
  if (ctx.lastError.category === 6 && ctx.lastError.code === 6007) {
    return {
      id: "SF-010",
      severity: "error",
      title: "License server unreachable",
      detail:
        "The license request failed with a network error. " +
        "The license server may be down, blocked by CORS, or unreachable from this network.",
      timestamp: performance.now(),
      data: { code: ctx.lastError.code, data: ctx.lastError.data },
    };
  }
  return null;
}

/** SF-011: License server HTTP error. */
export function checkLicenseHttpError(ctx: DiagnosticContext): DiagnosticResult | null {
  if (!ctx.lastError) return null;
  // Shaka category 6 = DRM, code 6008 = LICENSE_RESPONSE_REJECTED
  if (ctx.lastError.category === 6 && ctx.lastError.code === 6008) {
    return {
      id: "SF-011",
      severity: "error",
      title: "License server rejected request",
      detail:
        "The license server returned an error response (4xx/5xx). " +
        "Check authentication tokens, device certificates, or content entitlements.",
      timestamp: performance.now(),
      data: { code: ctx.lastError.code, data: ctx.lastError.data },
    };
  }
  return null;
}

/** SF-012: Encryption scheme mismatch hint (cenc vs cbcs). */
export function checkEncryptionSchemeMismatch(ctx: DiagnosticContext): DiagnosticResult | null {
  if (!ctx.lastError) return null;
  if (!ctx.state.manifest || !ctx.state.initSegment) return null;

  // Only trigger on DRM or media errors
  if (ctx.lastError.category !== 6 && ctx.lastError.category !== 3) return null;

  // Check if manifest and init segment declare different schemes
  const manifestSchemes = new Set<string>();
  for (const cp of ctx.state.manifest.contentProtections) {
    // Look for cenc:EncryptionScheme in the PSSH/CP attributes
    if (cp.schemeIdUri === "urn:mpeg:dash:mp4protection:2011") {
      // This is usually where the scheme is declared (value attribute = cenc or cbcs)
      continue; // scheme info is on the track level
    }
  }

  const initSchemes = new Set<string>();
  for (const track of ctx.state.initSegment.tracks) {
    if (track.scheme) initSchemes.add(track.scheme.toLowerCase());
  }

  if (initSchemes.size === 0) return null;

  // Look for scheme in manifest PSSH decoded data (Widevine protectionScheme)
  if (ctx.state.manifestPsshBoxes) {
    for (const box of ctx.state.manifestPsshBoxes) {
      if (box.decoded && "protectionScheme" in box.decoded) {
        const ps = (box.decoded as { protectionScheme?: string }).protectionScheme;
        if (ps) manifestSchemes.add(ps.toLowerCase());
      }
    }
  }

  if (manifestSchemes.size === 0 || initSchemes.size === 0) return null;

  let mismatch = false;
  for (const ms of manifestSchemes) {
    for (const is_ of initSchemes) {
      if (ms !== is_) mismatch = true;
    }
  }

  if (!mismatch) return null;

  return {
    id: "SF-012",
    severity: "warning",
    title: "Encryption scheme mismatch",
    detail:
      `Manifest declares ${[...manifestSchemes].join("/")} but init segment uses ` +
      `${[...initSchemes].join("/")}. Scheme mismatch can cause silent decryption failure ` +
      "on platforms that don't support the init segment's scheme.",
    timestamp: performance.now(),
    data: { manifestSchemes: [...manifestSchemes], initSchemes: [...initSchemes] },
  };
}

// --- Runners ---

const PRE_LOAD_CHECKS = [checkEmeAbsent, checkSecureContext] as const;
const POST_LOAD_CHECKS = [
  checkKidMismatch,
  checkPsshMissing,
  checkKeyOutputRestricted,
  checkKeyExpired,
  checkKeyInternalError,
  checkKeyOutputDownscaled,
  checkNoDrmSystemSupported,
] as const;
const ON_ERROR_CHECKS = [
  checkLicenseNetworkError,
  checkLicenseHttpError,
  checkEncryptionSchemeMismatch,
] as const;

function runChecks(
  checks: readonly ((ctx: DiagnosticContext) => DiagnosticResult | null)[],
  ctx: DiagnosticContext,
): DiagnosticResult[] {
  const results: DiagnosticResult[] = [];
  for (const check of checks) {
    const result = check(ctx);
    if (result) results.push(result);
  }
  return results;
}

export function runPreLoadChecks(ctx: DiagnosticContext): DiagnosticResult[] {
  return runChecks(PRE_LOAD_CHECKS, ctx);
}

export function runPostLoadChecks(ctx: DiagnosticContext): DiagnosticResult[] {
  return runChecks(POST_LOAD_CHECKS, ctx);
}

export function runOnErrorChecks(ctx: DiagnosticContext): DiagnosticResult[] {
  return runChecks(ON_ERROR_CHECKS, ctx);
}
