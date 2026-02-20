import shaka from "shaka-player";

declare const __CORS_PROXY_URL__: string;
declare const __CORS_PROXY_HMAC_KEY__: string;

/** Whether a CORS proxy fallback is configured (build-time constants). */
export const proxyConfigured = Boolean(__CORS_PROXY_URL__ && __CORS_PROXY_HMAC_KEY__);

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

export async function buildProxyUrl(targetUrl: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const w = Math.floor(t / 300);
  const sig = await computeHmac(`${w}:${targetUrl}`, __CORS_PROXY_HMAC_KEY__);
  return `${__CORS_PROXY_URL__}/proxy?url=${encodeURIComponent(targetUrl)}&t=${t}&sig=${sig}`;
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
