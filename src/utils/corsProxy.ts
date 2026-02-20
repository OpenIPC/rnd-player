import shaka from "shaka-player";

/**
 * Origins known to need CORS workaround (credentials: "omit", cache bypass).
 * Populated on first CORS failure per origin so subsequent requests skip
 * the failed default attempt.
 */
const corsWorkaroundOrigins = new Set<string>();

/**
 * Stable per-page-load random value appended as a query param to cross-origin
 * Shaka requests. Prevents the browser from serving stale HTTP-cached
 * responses with wrong Access-Control-Allow-Origin (CDNs that return
 * max-age without Vary: Origin). Same value reused within a session so
 * browser-side caching still works within one page load.
 */
const corsSessionId = Math.random().toString(36).slice(2, 10);

function addCacheBuster(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("_cbust", corsSessionId);
    return u.toString();
  } catch {
    return url;
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
 * origin (e.g. manifest on strm.yandex.ru, segments on strm-m9-*.yandex.net).
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

      let origin: string;
      try {
        origin = new URL(uri).origin;
      } catch {
        origin = "";
      }

      // Only add cache buster to cross-origin requests — same-origin
      // requests don't have CORS issues.
      const isCrossOrigin = origin !== pageOrigin;
      const fetchUri = isCrossOrigin ? addCacheBuster(uri) : uri;
      let res: Response;

      if (corsWorkaroundOrigins.has(origin)) {
        // Known CORS-failing origin — use full workaround directly
        res = await fetch(fetchUri, {
          ...baseFetchInit,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
        });
      } else {
        try {
          res = await fetch(fetchUri, baseFetchInit);
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          // CORS failure — remember origin, retry with full workaround
          corsWorkaroundOrigins.add(origin);
          res = await fetch(fetchUri, {
            ...baseFetchInit,
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
          });
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
  const priority = shaka.net.NetworkingEngine.PluginPriority.PREFERRED;
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
