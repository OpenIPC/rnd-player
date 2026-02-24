/**
 * Copy text to clipboard with fallback for non-secure contexts.
 *
 * navigator.clipboard is undefined on plain HTTP (non-localhost) origins.
 * Falls back to a temporary textarea + execCommand("copy").
 */
export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  // Fallback: textarea + execCommand for non-secure contexts
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    // Best-effort — no clipboard API available at all
  }
  document.body.removeChild(ta);
  return Promise.resolve();
}
