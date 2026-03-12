/** DRM system UUID → human-readable name mapping. */
export const DRM_SYSTEM_IDS: Record<string, string> = {
  "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": "Widevine",
  "9a04f079-9840-4286-ab92-e65be0885f95": "PlayReady",
  "94ce86fb-07ff-4f43-adb8-93d2fa968ca2": "FairPlay",
  "1077efec-c0b2-4d02-ace3-3c1e52e2fb4b": "ClearKey (W3C)",
  "e2719d58-a985-b3c9-781a-b030af78d30e": "ClearKey (DASH-IF)",
};

/** Format a 16-byte Uint8Array as UUID string (8-4-4-4-12). */
export function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Format a Uint8Array as hex string. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- PSSH types ---

/** Widevine-specific decoded PSSH data. */
export interface WidevinePssh {
  algorithm?: string;
  keyIds: string[];
  provider?: string;
  contentId?: string;
  contentIdUtf8?: string;
  policy?: string;
  protectionScheme?: string;
}

/** PlayReady-specific decoded PSSH data. */
export interface PlayReadyPssh {
  kid?: string;
  laUrl?: string;
  luiUrl?: string;
  customAttributes?: string;
}

/** Parsed PSSH box. */
export interface PsshBox {
  systemId: string;
  systemName: string;
  version: number;
  keyIds: string[];
  data: Uint8Array;
  decoded?: WidevinePssh | PlayReadyPssh;
  source: "manifest" | "init-segment";
}

// --- Manifest DRM metadata ---

/** A single ContentProtection element from a DASH MPD. */
export interface ContentProtectionInfo {
  schemeIdUri: string;
  systemName: string;
  defaultKid?: string;
  psshBase64?: string;
  robustness?: string;
  licenseUrl?: string;
}

/** HLS key tag info. */
export interface HlsKeyInfo {
  method: string;
  uri?: string;
  keyformat?: string;
  keyformatVersions?: string;
  iv?: string;
}

/** All DRM info extracted from a manifest. */
export interface ManifestDrmInfo {
  type: "dash" | "hls" | "unknown";
  contentProtections: ContentProtectionInfo[];
  hlsKeys: HlsKeyInfo[];
}

// --- Init segment DRM metadata ---

/** Encryption info for a single track in an init segment. */
export interface TrackEncryptionInfo {
  trackId: number;
  scheme: string | null;
  defaultKid: string;
  defaultIvSize: number;
  defaultConstantIv: string | null;
}

/** All DRM info extracted from an init segment. */
export interface InitSegmentDrmInfo {
  tracks: TrackEncryptionInfo[];
  psshBoxes: PsshBox[];
}

/** Combined diagnostics state. */
export interface DrmDiagnosticsState {
  manifest: ManifestDrmInfo | null;
  manifestPsshBoxes?: PsshBox[];
  initSegment: InitSegmentDrmInfo | null;
  emeEvents?: readonly import("./emeCapture").EmeEvent[];
  licenseExchanges?: readonly import("./licenseCapture").LicenseExchange[];
  diagnostics?: readonly import("./silentFailures").DiagnosticResult[];
  compatibility?: import("./compatChecker").CompatReport;
}
