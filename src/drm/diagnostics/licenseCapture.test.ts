import { describe, it, expect } from "vitest";
import {
  LicenseCapture,
  maskHeaders,
  maskClearKeyRequest,
  maskClearKeyResponse,
  maskWidevineResponse,
  maskFairPlayRequest,
  maskFairPlayResponse,
  decodeClearKeyResponse,
  decodeWidevineResponse,
  decodeFairPlayResponse,
} from "./licenseCapture";

describe("maskHeaders", () => {
  it("masks Authorization bearer token keeping last 4 chars", () => {
    const result = maskHeaders({ Authorization: "Bearer abcdef123456" });
    expect(result.Authorization).toBe("Bearer ****...3456");
  });

  it("passes non-sensitive headers unchanged", () => {
    const result = maskHeaders({ "Content-Type": "application/json", "X-Custom": "value" });
    expect(result["Content-Type"]).toBe("application/json");
    expect(result["X-Custom"]).toBe("value");
  });
});

describe("request body masking", () => {
  it("masks session_token, device_fingerprint, client_public_key, challenge", () => {
    const body = JSON.stringify({
      session_token: "tok_abcdef123456",
      device_fingerprint: "fp_abcdef1234567890",
      client_public_key: { kty: "EC", crv: "P-256", x: "abc", y: "def" },
      challenge: btoa("binary challenge data"),
      asset_id: "asset123",
    });
    const masked = maskClearKeyRequest(body);
    const parsed = JSON.parse(masked);
    expect(parsed.session_token).toBe("****...3456");
    expect(parsed.device_fingerprint).toBe("****...34567890");
    expect(parsed.client_public_key).toBe("[ECDH public key]");
    expect(parsed.challenge).toMatch(/^\[\d+ bytes\]$/);
    expect(parsed.asset_id).toBe("asset123");
  });

  it("masks spc in FairPlay requests", () => {
    const body = JSON.stringify({
      session_token: "tok_abcdef123456",
      spc: btoa("spc binary data"),
      asset_id: "asset123",
    });
    const masked = maskFairPlayRequest(body);
    const parsed = JSON.parse(masked);
    expect(parsed.spc).toMatch(/^\[\d+ bytes\]$/);
  });
});

describe("response body masking", () => {
  it("masks key values in ClearKey response", () => {
    const body = JSON.stringify({
      session_id: "sess123",
      keys: [{ kid: "kid1", key: "c2VjcmV0a2V5", type: "content" }],
      policy: { expiry: "2025-01-01", renewal_interval_s: 30, max_resolution: 1080, allow_offline: false },
    });
    const masked = maskClearKeyResponse(body);
    const parsed = JSON.parse(masked);
    expect(parsed.keys[0].key).toBe("[present]");
    expect(parsed.keys[0].kid).toBe("kid1");
  });

  it("masks license base64 in Widevine response", () => {
    const body = JSON.stringify({
      session_id: "sess123",
      license: btoa("widevine license bytes"),
      policy: { expiry: "2025-01-01", renewal_interval_s: 30, max_resolution: 1080, allow_offline: false },
    });
    const masked = maskWidevineResponse(body);
    const parsed = JSON.parse(masked);
    expect(parsed.license).toMatch(/^\[\d+ bytes\]$/);
  });

  it("masks ckc base64 in FairPlay response", () => {
    const body = JSON.stringify({
      session_id: "sess123",
      ckc: btoa("fairplay ckc data"),
      policy: { expiry: "2025-01-01", renewal_interval_s: 30, max_resolution: 1080, allow_offline: false },
    });
    const masked = maskFairPlayResponse(body);
    const parsed = JSON.parse(masked);
    expect(parsed.ckc).toMatch(/^\[\d+ bytes\]$/);
  });

  it("masks transport_key_params.epk", () => {
    const body = JSON.stringify({
      session_id: "sess123",
      keys: [{ kid: "kid1", key: "c2VjcmV0", type: "content" }],
      policy: { expiry: "2025-01-01", renewal_interval_s: 30, max_resolution: 1080, allow_offline: false },
      transport_key_params: { algorithm: "ECDH-ES+A256KW", epk: { kty: "EC", crv: "P-256" } },
    });
    const masked = maskClearKeyResponse(body);
    const parsed = JSON.parse(masked);
    expect(parsed.transport_key_params.epk).toBe("[ECDH server key]");
    expect(parsed.transport_key_params.algorithm).toBe("ECDH-ES+A256KW");
  });
});

describe("LicenseCapture", () => {
  it("record() stores with incrementing IDs", () => {
    const capture = new LicenseCapture();
    capture.record({ timestamp: 1, drmSystem: "clearkey", url: "/license", method: "POST", requestHeaders: {}, requestBody: "{}" });
    capture.record({ timestamp: 2, drmSystem: "widevine", url: "/license/widevine", method: "POST", requestHeaders: {}, requestBody: "{}" });
    const exchanges = capture.getExchanges();
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].id).toBe(1);
    expect(exchanges[1].id).toBe(2);
  });

  it("clear() resets", () => {
    const capture = new LicenseCapture();
    capture.record({ timestamp: 1, drmSystem: "clearkey", url: "/license", method: "POST", requestHeaders: {}, requestBody: "{}" });
    capture.clear();
    expect(capture.getExchanges()).toHaveLength(0);
  });

  it("toJSON() produces valid JSON", () => {
    const capture = new LicenseCapture();
    capture.record({ timestamp: 1, drmSystem: "clearkey", url: "/license", method: "POST", requestHeaders: {}, requestBody: "{}" });
    const json = capture.toJSON();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe(1);
  });
});

describe("decode helpers", () => {
  const policy = { expiry: "2025-01-01", renewal_interval_s: 30, max_resolution: 1080, allow_offline: false };

  it("decodeClearKeyResponse extracts structured view", () => {
    const decoded = decodeClearKeyResponse({
      session_id: "sess1",
      keys: [{ kid: "k1", key: "a2V5", type: "content" }],
      policy,
      transport_key_params: { algorithm: "ECDH-ES+A256KW" },
      watermark: { user_hash: "abc", session_short: "X1", opacity: 0.03 },
    });
    expect(decoded.type).toBe("clearkey");
    if (decoded.type === "clearkey") {
      expect(decoded.sessionId).toBe("sess1");
      expect(decoded.keyCount).toBe(1);
      expect(decoded.hasTransportKey).toBe(true);
      expect(decoded.hasWatermark).toBe(true);
    }
  });

  it("decodeWidevineResponse extracts structured view", () => {
    const license = btoa("widevine license data");
    const decoded = decodeWidevineResponse({ session_id: "sess2", license, policy });
    expect(decoded.type).toBe("widevine");
    if (decoded.type === "widevine") {
      expect(decoded.sessionId).toBe("sess2");
      expect(decoded.licenseSizeBytes).toBeGreaterThan(0);
      expect(decoded.hasWatermark).toBe(false);
    }
  });

  it("decodeFairPlayResponse extracts structured view", () => {
    const ckc = btoa("fairplay ckc data");
    const decoded = decodeFairPlayResponse({ session_id: "sess3", ckc, policy });
    expect(decoded.type).toBe("fairplay");
    if (decoded.type === "fairplay") {
      expect(decoded.sessionId).toBe("sess3");
      expect(decoded.ckcSizeBytes).toBeGreaterThan(0);
      expect(decoded.hasWatermark).toBe(false);
    }
  });
});
