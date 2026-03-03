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

/** POST /license response body. */
export interface LicenseResponse {
  session_id: string;
  keys: LicenseKey[];
  policy: LicensePolicy;
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
