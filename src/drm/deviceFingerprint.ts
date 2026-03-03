let cached: string | null = null;

/** Compute a SHA-256 hex fingerprint from browser signals. Result is cached at module level. */
export async function computeDeviceFingerprint(): Promise<string> {
  if (cached) return cached;

  const signals = [
    navigator.userAgent,
    navigator.language,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    String(navigator.hardwareConcurrency || 0),
  ].join("|");

  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signals));
  cached = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return cached;
}
