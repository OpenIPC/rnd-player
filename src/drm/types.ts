/** DRM config passed from App to ShakaPlayer when license/token/asset URL params are present. */
export interface DrmConfig {
  licenseUrl: string;
  sessionToken: string;
  assetId: string;
}

/** POST /license request body. */
export interface LicenseRequest {
  session_token: string;
  asset_id: string;
  device_fingerprint: string;
  client_public_key?: JsonWebKey; // Phase 3: ECDH ephemeral public key
}

/** Single key entry in license response. */
export interface LicenseKey {
  kid: string;
  key: string; // base64
  type: string;
}

/** Policy constraints from license response. */
export interface LicensePolicy {
  expiry: string;
  renewal_interval_s: number;
  max_resolution: number;
  allow_offline: boolean;
}

/** Phase 3: ECDH-ES+A256KW transport key parameters from server. */
export interface TransportKeyParams {
  algorithm: string; // "ECDH-ES+A256KW"
  epk: JsonWebKey; // Server's ephemeral public key
}

/** Phase 4: Forensic watermark token from license response. */
export interface WatermarkToken {
  user_hash: string;     // sha256(userId)[:8] hex
  session_short: string; // base36(sessionId)[:4] uppercase
  opacity: number;       // ~0.03
}

/** POST /license response body. */
export interface LicenseResponse {
  session_id: string;
  keys: LicenseKey[];
  policy: LicensePolicy;
  transport_key_params?: TransportKeyParams; // Phase 3: present when CEKs are wrapped
  watermark?: WatermarkToken; // Phase 4: forensic watermark config
}

/** POST /license/widevine response body. */
export interface WidevineLicenseResponse {
  session_id: string;
  license: string; // base64-encoded Widevine license bytes
  policy: LicensePolicy;
  evicted_sessions?: string[];
  watermark?: WatermarkToken;
}

/** POST /session/heartbeat request body. */
export interface HeartbeatRequest {
  session_id: string;
  position_s: number;
  buffer_health_s: number;
  rendition: string;
  timestamp: string;
}

/** POST /session/heartbeat response body. */
export interface HeartbeatResponse {
  status: "active" | "revoke";
  next_heartbeat_s: number;
}

/** POST /session/end request body. */
export interface SessionEndRequest {
  session_id: string;
  position_s: number;
  reason: string;
}

/** POST /session/end response body. */
export interface SessionEndResponse {
  status: string;
}
