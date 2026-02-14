/**
 * Probe a Shaka SegmentReference's init segment sub-object to find the
 * init segment URL. Works with mangled Closure-compiled Shaka builds.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractInitSegmentUrl(firstRef: any): string | null {
  for (const key of Object.keys(firstRef)) {
    const val = firstRef[key];
    if (!val || typeof val !== "object" || Array.isArray(val) || val === firstRef) continue;

    const fnNames = new Set<string>();
    for (const k of Object.keys(val)) {
      if (typeof val[k] === "function") fnNames.add(k);
    }
    let proto = Object.getPrototypeOf(val);
    while (proto && proto !== Object.prototype) {
      for (const m of Object.getOwnPropertyNames(proto)) {
        if (m !== "constructor" && typeof val[m] === "function") fnNames.add(m);
      }
      proto = Object.getPrototypeOf(proto);
    }

    if (fnNames.size === 0) continue;

    for (const fn of fnNames) {
      try {
        const result = val[fn]();
        if (
          Array.isArray(result) &&
          result.length > 0 &&
          typeof result[0] === "string" &&
          (result[0].startsWith("http") || result[0].startsWith("/"))
        ) {
          return result[0];
        }
      } catch {
        // method needs args or threw — skip
      }
    }
  }
  return null;
}
