import type { LicensePolicy } from "../types";

export interface LicenseExchange {
  id: number;
  timestamp: number;
  drmSystem: "clearkey" | "widevine" | "fairplay";
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseStatus?: number;
  responseBody?: string;
  durationMs?: number;
  error?: string;
  decoded?: DecodedLicense;
}

export type DecodedLicense =
  | { type: "clearkey"; sessionId: string; keyCount: number; policy: LicensePolicy; hasTransportKey: boolean; hasWatermark: boolean }
  | { type: "widevine"; sessionId: string; licenseSizeBytes: number; policy: LicensePolicy; hasWatermark: boolean }
  | { type: "fairplay"; sessionId: string; ckcSizeBytes: number; policy: LicensePolicy; hasWatermark: boolean };

export type LicenseExchangeCallback = (exchange: Omit<LicenseExchange, "id">) => void;

export class LicenseCapture {
  private exchanges: LicenseExchange[] = [];
  private nextId = 1;

  record(exchange: Omit<LicenseExchange, "id">): void {
    this.exchanges.push({ ...exchange, id: this.nextId++ });
  }

  getExchanges(): readonly LicenseExchange[] {
    return this.exchanges;
  }

  clear(): void {
    this.exchanges = [];
    this.nextId = 1;
  }

  toJSON(): string {
    return JSON.stringify(this.exchanges, null, 2);
  }
}

// --- Masking helpers ---

export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization" && value.startsWith("Bearer ")) {
      const token = value.slice(7);
      const last4 = token.length > 4 ? token.slice(-4) : token;
      result[key] = `Bearer ****...${last4}`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function maskValue(value: string, visibleSuffix: number): string {
  if (value.length <= visibleSuffix) return value;
  return `****...${value.slice(-visibleSuffix)}`;
}

function byteLengthLabel(b64: string): string {
  try {
    return `[${Math.ceil(b64.length * 3 / 4)} bytes]`;
  } catch {
    return "[binary]";
  }
}

export function maskJsonBody(body: string, fieldsToMask: Record<string, (v: unknown) => unknown>): string {
  try {
    const parsed = JSON.parse(body);
    for (const [field, masker] of Object.entries(fieldsToMask)) {
      if (field in parsed) {
        parsed[field] = masker(parsed[field]);
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return body;
  }
}

const REQUEST_MASKERS: Record<string, (v: unknown) => unknown> = {
  session_token: (v) => typeof v === "string" ? maskValue(v, 4) : v,
  device_fingerprint: (v) => typeof v === "string" ? maskValue(v, 8) : v,
  client_public_key: () => "[ECDH public key]",
  challenge: (v) => typeof v === "string" ? byteLengthLabel(v) : v,
  spc: (v) => typeof v === "string" ? byteLengthLabel(v) : v,
};

const RESPONSE_KEY_MASKERS: Record<string, (v: unknown) => unknown> = {
  license: (v) => typeof v === "string" ? byteLengthLabel(v) : v,
  ckc: (v) => typeof v === "string" ? byteLengthLabel(v) : v,
};

function maskResponseKeys(body: string): string {
  try {
    const parsed = JSON.parse(body);
    // Mask key values in keys array
    if (Array.isArray(parsed.keys)) {
      parsed.keys = parsed.keys.map((k: Record<string, unknown>) => ({
        ...k,
        key: k.key ? "[present]" : k.key,
      }));
    }
    // Mask transport_key_params.epk
    if (parsed.transport_key_params?.epk) {
      parsed.transport_key_params = {
        ...parsed.transport_key_params,
        epk: "[ECDH server key]",
      };
    }
    for (const [field, masker] of Object.entries(RESPONSE_KEY_MASKERS)) {
      if (field in parsed) {
        parsed[field] = masker(parsed[field]);
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return body;
  }
}

export function maskClearKeyRequest(body: string): string {
  return maskJsonBody(body, REQUEST_MASKERS);
}

export function maskClearKeyResponse(body: string): string {
  return maskResponseKeys(body);
}

export function maskWidevineRequest(body: string): string {
  return maskJsonBody(body, REQUEST_MASKERS);
}

export function maskWidevineResponse(body: string): string {
  return maskResponseKeys(body);
}

export function maskFairPlayRequest(body: string): string {
  return maskJsonBody(body, REQUEST_MASKERS);
}

export function maskFairPlayResponse(body: string): string {
  return maskResponseKeys(body);
}

// --- Decode helpers ---

interface ClearKeyResponseShape {
  session_id: string;
  keys: unknown[];
  policy: LicensePolicy;
  transport_key_params?: { algorithm: string };
  watermark?: unknown;
}

interface WidevineResponseShape {
  session_id: string;
  license: string;
  policy: LicensePolicy;
  watermark?: unknown;
}

interface FairPlayResponseShape {
  session_id: string;
  ckc: string;
  policy: LicensePolicy;
  watermark?: unknown;
}

export function decodeClearKeyResponse(parsed: ClearKeyResponseShape): DecodedLicense {
  return {
    type: "clearkey",
    sessionId: parsed.session_id,
    keyCount: parsed.keys?.length ?? 0,
    policy: parsed.policy,
    hasTransportKey: !!parsed.transport_key_params,
    hasWatermark: !!parsed.watermark,
  };
}

export function decodeWidevineResponse(parsed: WidevineResponseShape): DecodedLicense {
  let licenseSizeBytes = 0;
  try {
    licenseSizeBytes = Math.ceil(parsed.license.length * 3 / 4);
  } catch { /* empty */ }
  return {
    type: "widevine",
    sessionId: parsed.session_id,
    licenseSizeBytes,
    policy: parsed.policy,
    hasWatermark: !!parsed.watermark,
  };
}

export function decodeFairPlayResponse(parsed: FairPlayResponseShape): DecodedLicense {
  let ckcSizeBytes = 0;
  try {
    ckcSizeBytes = Math.ceil(parsed.ckc.length * 3 / 4);
  } catch { /* empty */ }
  return {
    type: "fairplay",
    sessionId: parsed.session_id,
    ckcSizeBytes,
    policy: parsed.policy,
    hasWatermark: !!parsed.watermark,
  };
}
