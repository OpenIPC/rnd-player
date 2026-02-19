import shaka from "shaka-player";

/**
 * Fetch with CORS retry. Tries a normal fetch first; on TypeError (CORS/network
 * error), retries with credentials omitted and no referrer to work around
 * servers that reject credentialed or referred requests.
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
      const res = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      return { text: await res.text(), corsWorkaround: true };
    } catch {
      // Both attempts failed — return null so the caller can still try
      // player.load() (Shaka may have its own retry/fallback logic).
      return { text: null, corsWorkaround: false };
    }
  }
}

/**
 * Register a custom HTTP/HTTPS scheme plugin that fetches with
 * credentials omitted and no referrer. Registered at APPLICATION priority
 * so it overrides Shaka's default HttpFetchPlugin.
 */
export function installCorsSchemePlugin(): void {
  const plugin: shaka.extern.SchemePlugin = (
    uri,
    request,
    requestType,
    progressUpdated,
    headersReceived,
  ) => {
    const controller = new AbortController();

    const promise = (async (): Promise<shaka.extern.Response> => {
      const fetchInit: RequestInit = {
        method: request.method || "GET",
        body: request.body as BodyInit | null,
        headers: request.headers as HeadersInit,
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      };

      const res = await fetch(uri, fetchInit);
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
        uri: res.url || uri,
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
 * Re-register Shaka's default HttpFetchPlugin at PREFERRED priority,
 * restoring original behavior.
 */
export function uninstallCorsSchemePlugin(): void {
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
