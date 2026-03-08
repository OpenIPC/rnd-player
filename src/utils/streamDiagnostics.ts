/**
 * Stream diagnostics — structured error reporting for Shaka Player errors.
 *
 * Replaces cryptic one-line Shaka errors with actionable diagnostics:
 * failed URL, HTTP status, request type, and pattern-based root cause hints.
 */

export interface StreamError {
  summary: string;
  details: string[];
  url?: string;
  httpStatus?: number;
}

const REQUEST_TYPE_LABELS: Record<number, string> = {
  0: "Manifest",
  1: "Media segment",
  2: "License",
  3: "App",
  4: "Timing",
  5: "Server certificate",
};

function requestTypeLabel(type: number | undefined): string {
  return type != null ? REQUEST_TYPE_LABELS[type] ?? `Request type ${type}` : "Unknown request";
}

/** Shorten a URL for display: show host + last path segment. */
function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last3 = parts.slice(-3).join("/");
    return `${u.host}/.../${last3}${u.search ? "?" + u.search.slice(1, 40) + (u.search.length > 41 ? "..." : "") : ""}`;
  } catch {
    // Not a valid URL, truncate directly
    return url.length > 80 ? url.slice(0, 40) + "..." + url.slice(-37) : url;
  }
}

/** Detect ISM/Smooth Streaming URL pattern: .ism + Q()/F() segment addressing. */
function isIsmSegmentUrl(url: string): boolean {
  return /\.ism\b/i.test(url) && (/\/Q\(/i.test(url) || /\/F\(/i.test(url));
}

/** Detect ISM manifest URL. */
function isIsmManifestUrl(url: string): boolean {
  return /\.ism\/manifest/i.test(url) || /\.ism\/\.mpd/i.test(url) || /\.ism\b/i.test(url);
}

interface ShakaErrorLike {
  code: number;
  category?: number;
  data?: unknown[];
}

interface DiagnosticContext {
  segmentSuccessCount: number;
  manifestUrl: string;
}

/**
 * Produce a structured StreamError from a Shaka error + runtime context.
 *
 * Shaka error code 1001 (BAD_HTTP_STATUS):
 *   data = [uri, httpStatus, responseText, headers, requestType]
 *
 * Shaka error code 1002 (HTTP_ERROR):
 *   data = [uri, ...]
 *
 * Shaka error code 1003 (TIMEOUT):
 *   data = [uri, requestType]
 */
export function diagnoseNetworkError(
  error: ShakaErrorLike,
  context: DiagnosticContext,
): StreamError {
  const uri = typeof error.data?.[0] === "string" ? error.data[0] : undefined;
  const httpStatus = typeof error.data?.[1] === "number" ? error.data[1] : undefined;
  const requestType = typeof error.data?.[4] === "number" ? error.data[4] : undefined;

  // --- Timeout (code 1003) ---
  if (error.code === 1003) {
    return {
      summary: `${requestTypeLabel(requestType)} request timed out`,
      details: [
        "The server did not respond in time.",
        ...(uri ? [`URL: ${shortenUrl(uri)}`] : []),
      ],
      url: uri,
    };
  }

  // --- HTTP_ERROR (code 1002): fetch/XHR failed at network level ---
  if (error.code === 1002) {
    const typeName = requestTypeLabel(requestType);
    const shortUrl = uri ? shortenUrl(uri) : undefined;
    const details: string[] = [];

    details.push(
      `${typeName} request failed — the server connection was interrupted before the full response was received.`,
    );
    if (context.segmentSuccessCount > 0) {
      details.push(`${context.segmentSuccessCount} segment(s) loaded successfully before the failure.`);
    }
    if (shortUrl) details.push(`Failed URL: ${shortUrl}`);

    // Extract nested error message if available (e.g. TypeError from fetch)
    const nestedMsg = extractNestedMessage(error);
    if (nestedMsg) {
      details.push(`Browser error: ${nestedMsg}`);
    }

    const isIsm = (uri && isIsmSegmentUrl(uri)) || isIsmManifestUrl(context.manifestUrl);
    if (isIsm && requestType === 1) {
      details.push(
        "Pattern: ISM origin interrupted the response mid-transfer. " +
        "This can happen when the AES repackaging filter encounters a " +
        "segment with mismatched senc/trun byte counts (Content-Length " +
        "mismatch). Run the Manifest Validator deep scan to check for " +
        "senc/trun issues.",
      );
    }

    return {
      summary: `${typeName} transfer interrupted (network error)`,
      details,
      url: uri,
    };
  }

  // --- Other non-1001 network errors ---
  if (error.code !== 1001) {
    return {
      summary: `Network error (code ${error.code})`,
      details: [
        ...(uri ? [`URL: ${shortenUrl(uri)}`] : []),
        "A network request failed. Check that the stream URL is accessible.",
      ],
      url: uri,
    };
  }

  // --- BAD_HTTP_STATUS (1001) ---
  const typeName = requestTypeLabel(requestType);
  const isSegment = requestType === 1;
  const isManifest = requestType === 0;
  const shortUrl = uri ? shortenUrl(uri) : undefined;

  // Manifest-level errors
  if (isManifest || (!isSegment && context.segmentSuccessCount === 0)) {
    return diagnoseManifestError(httpStatus, uri, shortUrl);
  }

  // Segment-level errors
  return diagnoseSegmentError(httpStatus, uri, shortUrl, typeName, context);
}

function diagnoseManifestError(
  httpStatus: number | undefined,
  uri: string | undefined,
  shortUrl: string | undefined,
): StreamError {
  const details: string[] = [];

  if (httpStatus === 404) {
    return {
      summary: "Manifest not found (HTTP 404)",
      details: [
        "The manifest URL returned 404. The stream may have been removed or the URL is incorrect.",
        ...(shortUrl ? [`URL: ${shortUrl}`] : []),
      ],
      url: uri,
      httpStatus,
    };
  }
  if (httpStatus === 403) {
    return {
      summary: "Access denied (HTTP 403)",
      details: [
        "The manifest URL returned 403. The stream URL may have expired or requires authentication.",
        ...(shortUrl ? [`URL: ${shortUrl}`] : []),
      ],
      url: uri,
      httpStatus,
    };
  }
  if (httpStatus === 410) {
    return {
      summary: "Stream expired (HTTP 410)",
      details: [
        "The stream has expired. Try obtaining a fresh CDN link.",
        ...(shortUrl ? [`URL: ${shortUrl}`] : []),
      ],
      url: uri,
      httpStatus,
    };
  }

  details.push(
    `The server returned HTTP ${httpStatus ?? "error"} for the manifest request.`,
  );
  if (shortUrl) details.push(`URL: ${shortUrl}`);
  if (httpStatus && httpStatus >= 500) {
    details.push("This is a server-side error. The origin may be misconfigured or temporarily unavailable.");
  }

  return {
    summary: `Failed to load manifest (HTTP ${httpStatus ?? "error"})`,
    details,
    url: uri,
    httpStatus,
  };
}

function diagnoseSegmentError(
  httpStatus: number | undefined,
  uri: string | undefined,
  shortUrl: string | undefined,
  typeName: string,
  context: DiagnosticContext,
): StreamError {
  const details: string[] = [];
  const isIsm = (uri && isIsmSegmentUrl(uri)) || isIsmManifestUrl(context.manifestUrl);
  const successInfo = context.segmentSuccessCount > 0
    ? `${context.segmentSuccessCount} segment(s) loaded successfully before the failure.`
    : "The first segment request failed.";

  // HTTP 404 on segment
  if (httpStatus === 404) {
    details.push(
      `${typeName} request returned HTTP 404 — the manifest loaded successfully but the origin server could not find the requested segment.`,
    );
    details.push(successInfo);
    if (shortUrl) details.push(`Failed URL: ${shortUrl}`);

    if (isIsm && context.segmentSuccessCount > 0) {
      details.push(
        "Pattern: ISM origin returning 404 after initial segments succeeded. " +
        "This typically indicates cross-track segment time mismatches in the " +
        "source file — the DASH SegmentTimeline uses one track's fragment " +
        "times, but other tracks have slightly different TFRA times, causing " +
        "exact-match lookups to fail.",
      );
    } else if (context.segmentSuccessCount > 0) {
      details.push(
        "The manifest loaded and some segments were served, but subsequent " +
        "segments returned 404. This may indicate a packaging issue at the " +
        "origin server.",
      );
    }

    return {
      summary: "Segment not found (HTTP 404)",
      details,
      url: uri,
      httpStatus,
    };
  }

  // HTTP 410 on segment
  if (httpStatus === 410) {
    details.push("A segment has expired (HTTP 410). The CDN link may have a short TTL.");
    details.push(successInfo);
    if (shortUrl) details.push(`Failed URL: ${shortUrl}`);
    return {
      summary: "Segment expired (HTTP 410)",
      details,
      url: uri,
      httpStatus,
    };
  }

  // HTTP 403 on segment
  if (httpStatus === 403) {
    details.push(
      "A segment request was denied (HTTP 403). CDN token/signature may have expired mid-playback.",
    );
    details.push(successInfo);
    if (shortUrl) details.push(`Failed URL: ${shortUrl}`);
    return {
      summary: "Segment access denied (HTTP 403)",
      details,
      url: uri,
      httpStatus,
    };
  }

  // HTTP 5xx on segment
  if (httpStatus && httpStatus >= 500) {
    details.push(
      `${typeName} request returned HTTP ${httpStatus} — the origin server encountered an internal error while serving the segment.`,
    );
    details.push(successInfo);
    if (shortUrl) details.push(`Failed URL: ${shortUrl}`);

    if (isIsm) {
      details.push(
        "The stream uses an ISM origin. Server errors on segment requests " +
        "may indicate a problem with the ISM remuxer/repackager — check the " +
        "origin server logs for the failing segment time/track.",
      );
    } else {
      details.push(
        "This is a server-side error. Check the origin server/CDN logs for the root cause.",
      );
    }

    return {
      summary: `Segment server error (HTTP ${httpStatus})`,
      details,
      url: uri,
      httpStatus,
    };
  }

  // Generic segment error
  details.push(
    `${typeName} request failed with HTTP ${httpStatus ?? "error"}.`,
  );
  details.push(successInfo);
  if (shortUrl) details.push(`Failed URL: ${shortUrl}`);

  return {
    summary: `Segment fetch failed (HTTP ${httpStatus ?? "error"})`,
    details,
    url: uri,
    httpStatus,
  };
}

/**
 * Detect PlayReady OPM (Output Protection Management) failure.
 *
 * PlayReady CDM on Windows requires OPM to query the display driver's HDCP
 * status. Over Remote Desktop (RDP), OPM is unavailable — the display driver
 * is a virtual device that doesn't support output protection queries.
 *
 * The failure chain:
 *   Windows Media Foundation → "The driver does not support OPM (0xC0262500)"
 *   → video element MEDIA_ERR_DECODE
 *   → Shaka wraps as error 3014 (category 3) or 6008 (category 6)
 *   → player shows cryptic "media decode error"
 *
 * The license exchange succeeds (key status = "usable"), but decryption is
 * blocked at the MF renderer level. The same failure affects ALL PlayReady
 * content on the machine — including Microsoft's own test streams.
 */
export function diagnoseDrmPlaybackError(
  error: ShakaErrorLike,
): StreamError | null {
  // Serialize error data to search for OPM-related strings
  const errStr = JSON.stringify(error.data ?? []);
  const isOpmPattern =
    error.code === 6008 ||
    (error.code === 3014 && error.category === 3) ||
    /output.?protect/i.test(errStr) ||
    /\bOPM\b/.test(errStr) ||
    /0xC0262500/i.test(errStr);

  if (!isOpmPattern) return null;

  return {
    summary: "PlayReady DRM: display does not support Output Protection (OPM)",
    details: [
      "PlayReady requires Output Protection Management (OPM) to verify the " +
        "display connection supports HDCP. This check fails over Remote Desktop " +
        "(RDP) because the virtual display driver does not support OPM.",
      "This is a Windows system-level restriction — all PlayReady content " +
        "will fail on this machine, including Microsoft's own test streams.",
      "The DRM license was accepted (key status \"usable\"), but decryption " +
        "is blocked at the Windows Media Foundation renderer level.",
      "To fix: connect a real display (HDMI/DisplayPort) and test without " +
        "Remote Desktop. Alternatively, use ClearKey DRM which does not " +
        "require output protection.",
    ],
  };
}

/**
 * Extract a human-readable message from Shaka error data array.
 * Shaka often nests the original Error/TypeError in data[1] or data[0].
 */
function extractNestedMessage(error: ShakaErrorLike): string | undefined {
  if (!error.data) return undefined;
  for (const item of error.data) {
    if (item instanceof Error) return item.message;
    if (typeof item === "object" && item !== null && "message" in item) {
      return String((item as { message: unknown }).message);
    }
  }
  return undefined;
}

/**
 * Produce a diagnostic error for unrecognized Shaka error categories.
 * Extracts whatever useful info is available from the error detail and
 * the video element's MediaError.
 */
export function diagnoseFallbackError(
  error: ShakaErrorLike,
  videoError: MediaError | null | undefined,
  manifestUrl?: string,
): StreamError {
  const details: string[] = [];

  // Extract info from Shaka error
  const nestedMsg = extractNestedMessage(error);
  if (nestedMsg) {
    details.push(nestedMsg);
  }

  // Include the Shaka error code/category if available
  if (error.code != null || error.category != null) {
    details.push(`Shaka error: category=${error.category ?? "?"} code=${error.code ?? "?"}`);
  }

  // Dump Shaka data array — often contains the only clue
  if (error.data && error.data.length > 0) {
    const dataDump = error.data.map((item) => {
      if (item instanceof Error) return item.message;
      if (typeof item === "string") return item;
      if (typeof item === "number") return String(item);
      try { return JSON.stringify(item); } catch { return String(item); }
    }).join(" | ");
    details.push(`Error data: ${dataDump}`);
  }

  // Try to extract message from .message property (shaka.util.Error extends Error)
  const errObj = error as Record<string, unknown>;
  if (typeof errObj.message === "string" && errObj.message) {
    details.push(errObj.message);
  }

  // Extract info from video element's MediaError
  if (videoError) {
    const mediaErrorLabels: Record<number, string> = {
      1: "MEDIA_ERR_ABORTED",
      2: "MEDIA_ERR_NETWORK",
      3: "MEDIA_ERR_DECODE",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
    };
    const label = mediaErrorLabels[videoError.code] ?? `code ${videoError.code}`;
    details.push(`Video element error: ${label}`);
    if (videoError.message) {
      details.push(videoError.message);
    }
  }

  // Detect fetch/network failure pattern — browser only exposes generic
  // "Failed to fetch" for ERR_CONTENT_LENGTH_MISMATCH and similar errors
  const allText = [nestedMsg, errObj.message, ...(error.data ?? []).map(String)].join(" ");
  const isFetchFailure = /failed to fetch|networkerror|network\s*error|load failed/i.test(allText);

  if (isFetchFailure && manifestUrl && isIsmManifestUrl(manifestUrl)) {
    details.push(
      "Pattern: ISM origin interrupted the response (browser reports \"Failed to fetch\" " +
      "which can indicate a Content-Length mismatch). This happens when the AES " +
      "repackaging filter encounters a segment with mismatched senc/trun byte counts. " +
      "Run the Manifest Validator deep scan to check.",
    );
  }

  // Build summary from the best available info
  let summary: string;
  if (isFetchFailure) {
    summary = "Network error: a media request was interrupted mid-transfer";
  } else if (videoError?.code === 2) {
    summary = "Network error: the video transfer was interrupted";
  } else if (videoError?.code === 3) {
    summary = "Media decode error: the video data could not be decoded";
  } else if (videoError?.code === 4) {
    summary = "The video format is not supported by this browser";
  } else if (error.code != null) {
    summary = `Playback error (code ${error.code}): the video could not be played`;
  } else if (nestedMsg) {
    summary = `Playback error: ${nestedMsg}`;
  } else {
    summary = "Playback error: the video could not be played";
  }

  return { summary, details };
}

/** Convert a plain string error message to a StreamError. */
export function simpleError(message: string): StreamError {
  return { summary: message, details: [] };
}
