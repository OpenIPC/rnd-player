import shaka from "shaka-player";

// In production builds, Vite's `define` replaces __CORS_PROXY_URL__ / __CORS_PROXY_HMAC_KEY__
// at build time. In dev mode, `define` may not apply — fall back to import.meta.env.
// `typeof` on undeclared globals returns "undefined" without throwing ReferenceError.
const CORS_PROXY_URL: string =
  (typeof __CORS_PROXY_URL__ !== "undefined" && __CORS_PROXY_URL__) ||
  import.meta.env.VITE_CORS_PROXY_URL || "";
const CORS_PROXY_HMAC_KEY: string =
  (typeof __CORS_PROXY_HMAC_KEY__ !== "undefined" && __CORS_PROXY_HMAC_KEY__) ||
  import.meta.env.VITE_CORS_PROXY_HMAC_KEY || "";

/** Whether a CORS proxy fallback is configured (build-time or env). */
export const proxyConfigured = Boolean(CORS_PROXY_URL && CORS_PROXY_HMAC_KEY);

/**
 * Origins known to need CORS workaround (credentials: "omit", cache bypass).
 * Populated on first CORS failure per origin so subsequent requests skip
 * the failed default attempt.
 */
const corsWorkaroundOrigins = new Set<string>();

/**
 * Origins confirmed to fully block CORS (both standard and workaround
 * fetches failed with TypeError). Used by error handlers to show
 * specific messaging instead of generic network errors.
 */
const corsBlockedOrigins = new Set<string>();

/**
 * Stable per-page-load random value appended as a query param to cross-origin
 * Shaka requests. Prevents the browser from serving stale HTTP-cached
 * responses with wrong Access-Control-Allow-Origin (CDNs that return
 * max-age without Vary: Origin). Same value reused within a session so
 * browser-side caching still works within one page load.
 */
const corsSessionId = Math.random().toString(36).slice(2, 10);

export function addCacheBuster(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("_cbust", corsSessionId);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Check if a URL's origin has been confirmed to fully block CORS.
 * Returns the hostname for display, or null if not blocked.
 */
export function getCorsBlockedOrigin(url: string): string | null {
  try {
    const { origin, hostname } = new URL(url);
    return corsBlockedOrigins.has(origin) ? hostname : null;
  } catch {
    return null;
  }
}

// ── CORS proxy helpers (only used when proxyConfigured is true) ──

async function computeHmac(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();

  // crypto.subtle is only available in secure contexts (HTTPS, localhost).
  // On plain HTTP hosts, fall back to a JS HMAC implementation.
  if (!crypto.subtle) {
    return hmacSha256Fallback(enc.encode(key), enc.encode(message));
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Pure-JS HMAC-SHA256 for non-secure contexts where crypto.subtle is absent.
 * Uses the standard HMAC construction: H((K' ⊕ opad) ‖ H((K' ⊕ ipad) ‖ message))
 */
async function hmacSha256Fallback(
  key: Uint8Array,
  message: Uint8Array,
): Promise<string> {
  const BLOCK_SIZE = 64;
  let k = key;
  if (k.length > BLOCK_SIZE) {
    // Keys longer than block size are first hashed
    const hashed = await sha256(k);
    k = new Uint8Array(hashed);
  }
  // Pad key to block size
  const paddedKey = new Uint8Array(BLOCK_SIZE);
  paddedKey.set(k);

  const ipad = new Uint8Array(BLOCK_SIZE);
  const opad = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    ipad[i] = paddedKey[i] ^ 0x36;
    opad[i] = paddedKey[i] ^ 0x5c;
  }

  const inner = new Uint8Array(BLOCK_SIZE + message.length);
  inner.set(ipad);
  inner.set(message, BLOCK_SIZE);
  const innerHash = await sha256(inner);

  const outer = new Uint8Array(BLOCK_SIZE + innerHash.byteLength);
  outer.set(opad);
  outer.set(new Uint8Array(innerHash), BLOCK_SIZE);
  const sig = await sha256(outer);

  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Minimal SHA-256 using the platform. Prefers crypto.subtle, falls back to JS. */
async function sha256(data: Uint8Array): Promise<ArrayBuffer> {
  if (crypto.subtle) {
    return crypto.subtle.digest("SHA-256", data as ArrayBufferView<ArrayBuffer>);
  }
  return sha256js(data);
}

/**
 * Pure-JS SHA-256 implementation (FIPS 180-4).
 * Only used as a last resort on plain HTTP non-localhost origins.
 */
function sha256js(data: Uint8Array): ArrayBuffer {
  const K: number[] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f11f1b, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  // Pre-processing: padding
  const bitLen = data.length * 8;
  // message + 1 byte (0x80) + padding + 8 bytes (length)
  const totalLen = Math.ceil((data.length + 9) / 64) * 64;
  const buf = new Uint8Array(totalLen);
  buf.set(data);
  buf[data.length] = 0x80;
  // Big-endian 64-bit length (only lower 32 bits needed for our use case)
  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 4, bitLen, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Int32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getInt32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const result = new ArrayBuffer(32);
  const rv = new DataView(result);
  rv.setUint32(0, h0, false); rv.setUint32(4, h1, false);
  rv.setUint32(8, h2, false); rv.setUint32(12, h3, false);
  rv.setUint32(16, h4, false); rv.setUint32(20, h5, false);
  rv.setUint32(24, h6, false); rv.setUint32(28, h7, false);
  return result;
}

export async function buildProxyUrl(targetUrl: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const w = Math.floor(t / 300);
  const sig = await computeHmac(`${w}:${targetUrl}`, CORS_PROXY_HMAC_KEY);
  return `${CORS_PROXY_URL}/proxy?url=${encodeURIComponent(targetUrl)}&t=${t}&sig=${sig}`;
}

async function fetchViaProxy(
  targetUrl: string,
  init: RequestInit,
): Promise<Response> {
  const proxyUrl = await buildProxyUrl(targetUrl);
  return fetch(proxyUrl, {
    method: (init.method as string) || "GET",
    headers: init.headers,
    signal: init.signal,
  });
}

/**
 * Generic CORS-aware fetch that returns a Response. Uses the same three-layer
 * retry strategy as the Shaka scheme plugin: direct → workaround → proxy.
 * Throws on all failures (no silent null return).
 */
export async function corsFetch(url: string): Promise<Response> {
  const pageOrigin = window.location.origin;
  let origin = pageOrigin;
  try { origin = new URL(url).origin; } catch { /* treat as same-origin */ }
  const isCrossOrigin = origin !== pageOrigin;

  if (!isCrossOrigin) {
    return fetch(url);
  }

  // Fast path: known CORS-blocked origin — use proxy directly
  if (corsBlockedOrigins.has(origin) && proxyConfigured) {
    return fetchViaProxy(url, {});
  }

  // Known CORS-failing origin — use workaround directly
  if (corsWorkaroundOrigins.has(origin)) {
    try {
      return await fetch(addCacheBuster(url), {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
    } catch {
      corsBlockedOrigins.add(origin);
      if (proxyConfigured) return fetchViaProxy(url, {});
      throw new Error(`CORS blocked: ${origin}`);
    }
  }

  // Try direct fetch first
  try {
    return await fetch(addCacheBuster(url));
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    corsWorkaroundOrigins.add(origin);
    try {
      return await fetch(addCacheBuster(url), {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
    } catch {
      corsBlockedOrigins.add(origin);
      if (proxyConfigured) return fetchViaProxy(url, {});
      throw new Error(`CORS blocked: ${origin}`);
    }
  }
}

/**
 * Fetch with CORS retry. Tries a normal fetch first; on TypeError (CORS/network
 * error), retries with cache-busting param, credentials omitted, and browser
 * cache bypass.
 */
export async function fetchWithCorsRetry(
  url: string,
): Promise<{ text: string | null; corsWorkaround: boolean }> {
  // Fast path: known CORS-blocked origin — use proxy directly
  if (proxyConfigured) {
    try {
      if (corsBlockedOrigins.has(new URL(url).origin)) {
        const res = await fetch(await buildProxyUrl(url));
        return { text: await res.text(), corsWorkaround: true };
      }
    } catch {
      return { text: null, corsWorkaround: false };
    }
  }

  try {
    const res = await fetch(url);
    return { text: await res.text(), corsWorkaround: false };
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;

    try {
      const res = await fetch(addCacheBuster(url), {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      return { text: await res.text(), corsWorkaround: true };
    } catch {
      try { corsBlockedOrigins.add(new URL(url).origin); } catch { /* invalid URL */ }
      if (proxyConfigured) {
        try {
          const res = await fetch(await buildProxyUrl(url));
          return { text: await res.text(), corsWorkaround: true };
        } catch { /* proxy also failed */ }
      }
      return { text: null, corsWorkaround: false };
    }
  }
}

/**
 * Register a custom HTTP/HTTPS scheme plugin for Shaka Player that handles
 * CORS failures transparently. Appends a per-session cache-busting query
 * param to cross-origin requests to prevent browsers from serving stale
 * HTTP-cached responses with wrong Access-Control-Allow-Origin headers
 * (CDNs that return max-age without Vary: Origin).
 *
 * On CORS failure, retries with credentials: "omit" and cache: "no-store".
 * Per-origin: once an origin is known to fail, subsequent requests use the
 * workaround directly.
 *
 * Same-origin requests are passed through unmodified.
 *
 * Must be installed unconditionally before player.load() because CORS
 * failures may occur on segment CDN origins that differ from the manifest
 * origin (e.g. manifest and segment hosts differ).
 */
export function installCorsSchemePlugin(): void {
  const pageOrigin = window.location.origin;

  const plugin: shaka.extern.SchemePlugin = (
    uri,
    request,
    requestType,
    progressUpdated,
    headersReceived,
  ) => {
    const controller = new AbortController();

    const promise = (async (): Promise<shaka.extern.Response> => {
      const baseFetchInit: RequestInit = {
        method: request.method || "GET",
        body: request.body as BodyInit | null,
        headers: request.headers as HeadersInit,
        signal: controller.signal,
      };

      // Shaka's goog.Uri produces "http:/path" (single slash, no authority)
      // for relative paths with an inferred scheme. new URL() misparses
      // these as having a host (e.g. "http:/dash/file" → host "dash").
      // Only URIs with proper authority ("://") can be cross-origin.
      const hasAuthority = /^https?:\/\//.test(uri);
      let origin = pageOrigin;
      if (hasAuthority) {
        try {
          origin = new URL(uri).origin;
        } catch {
          // invalid URL → treat as same-origin
        }
      }

      const isCrossOrigin = origin !== pageOrigin;
      const fetchUri = isCrossOrigin ? addCacheBuster(uri) : uri;
      let res: Response;

      if (isCrossOrigin && corsBlockedOrigins.has(origin) && proxyConfigured) {
        // Known CORS-blocked origin with proxy — skip failed direct attempts
        res = await fetchViaProxy(uri, baseFetchInit);
      } else if (corsWorkaroundOrigins.has(origin)) {
        // Known CORS-failing origin — use full workaround directly
        try {
          res = await fetch(fetchUri, {
            ...baseFetchInit,
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
          });
        } catch (e) {
          corsBlockedOrigins.add(origin);
          if (proxyConfigured) {
            res = await fetchViaProxy(uri, baseFetchInit);
          } else {
            throw e;
          }
        }
      } else {
        try {
          res = await fetch(fetchUri, baseFetchInit);
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          // CORS failure — remember origin, retry with full workaround
          corsWorkaroundOrigins.add(origin);
          try {
            res = await fetch(fetchUri, {
              ...baseFetchInit,
              credentials: "omit",
              referrerPolicy: "no-referrer",
              cache: "no-store",
            });
          } catch (e2) {
            corsBlockedOrigins.add(origin);
            if (proxyConfigured) {
              res = await fetchViaProxy(uri, baseFetchInit);
            } else {
              throw e2;
            }
          }
        }
      }

      const hdrs = collectHeaders(res);

      if (headersReceived) {
        headersReceived(hdrs);
      }

      if (!res.ok) {
        throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.BAD_HTTP_STATUS,
          uri,
          res.status,
          null,
          hdrs,
          requestType,
        );
      }

      const data = await res.arrayBuffer();

      if (progressUpdated) {
        progressUpdated(0, data.byteLength, data.byteLength);
      }

      return {
        uri,
        originalUri: uri,
        originalRequest: request,
        data,
        status: res.status,
        headers: hdrs,
        fromCache: false,
      };
    })();

    return new shaka.util.AbortableOperation(promise, async () => {
      controller.abort();
    });
  };

  const priority = shaka.net.NetworkingEngine.PluginPriority.APPLICATION;
  shaka.net.NetworkingEngine.registerScheme("https", plugin, priority);
  shaka.net.NetworkingEngine.registerScheme("http", plugin, priority);
}

/**
 * Re-register Shaka's default HttpFetchPlugin, restoring original behavior.
 */
export function uninstallCorsSchemePlugin(): void {
  corsWorkaroundOrigins.clear();
  corsBlockedOrigins.clear();
  // Must use APPLICATION priority (same as install) because Shaka's
  // registerScheme only replaces if newPriority >= existingPriority.
  const priority = shaka.net.NetworkingEngine.PluginPriority.APPLICATION;
  shaka.net.NetworkingEngine.registerScheme(
    "https",
    shaka.net.HttpFetchPlugin.parse,
    priority,
  );
  shaka.net.NetworkingEngine.registerScheme(
    "http",
    shaka.net.HttpFetchPlugin.parse,
    priority,
  );
}

function collectHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}
