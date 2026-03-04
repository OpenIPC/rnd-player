/**
 * Parse DRM metadata from manifest text (DASH MPD or HLS).
 *
 * Extracts ContentProtection elements from DASH and EXT-X-KEY/EXT-X-SESSION-KEY
 * tags from HLS manifests.
 */

import {
  DRM_SYSTEM_IDS,
  type ManifestDrmInfo,
  type ContentProtectionInfo,
  type HlsKeyInfo,
} from "./types";
import { decodePsshBase64 } from "./psshDecode";
import type { PsshBox } from "./types";

/** Map a schemeIdUri to a human-readable DRM system name. */
function systemNameFromUri(uri: string): string {
  // urn:uuid:XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
  const uuidMatch = uri.match(/urn:uuid:([0-9a-f-]+)/i);
  if (uuidMatch) {
    const uuid = uuidMatch[1].toLowerCase();
    return DRM_SYSTEM_IDS[uuid] ?? "Unknown";
  }
  if (uri === "urn:mpeg:dash:mp4protection:2011") return "CENC (mp4protection)";
  return "Unknown";
}

/** Fingerprint a ContentProtection entry for deduplication. */
function cpFingerprint(cp: ContentProtectionInfo): string {
  return `${cp.schemeIdUri}|${cp.defaultKid ?? ""}|${cp.psshBase64 ?? ""}|${cp.robustness ?? ""}|${cp.licenseUrl ?? ""}`;
}

/** Parse DASH MPD ContentProtection elements (deduplicated across AdaptationSets). */
function parseDashDrm(
  manifestText: string,
): { contentProtections: ContentProtectionInfo[]; psshBoxes: PsshBox[] } {
  const contentProtections: ContentProtectionInfo[] = [];
  const psshBoxes: PsshBox[] = [];
  const seen = new Set<string>();
  const seenPssh = new Set<string>();

  const doc = new DOMParser().parseFromString(manifestText, "text/xml");

  // Check for parse error (jsdom/browser returns parsererror on invalid XML)
  const parseError = doc.querySelector("parsererror");
  if (parseError) return { contentProtections, psshBoxes };

  // getElementsByTagName("*") + filter is the most reliable cross-environment
  // approach — querySelectorAll doesn't match namespaced elements in all environments.
  const allElements = doc.getElementsByTagName("*");
  const elements: Element[] = [];
  for (let i = 0; i < allElements.length; i++) {
    if (allElements[i].localName === "ContentProtection") {
      elements.push(allElements[i]);
    }
  }

  for (const cp of elements) {
    const schemeIdUri = cp.getAttribute("schemeIdUri") ?? "";
    const systemName = systemNameFromUri(schemeIdUri);

    const defaultKidRaw =
      cp.getAttribute("cenc:default_KID") ??
      cp.getAttributeNS("urn:mpeg:cenc:2013", "default_KID");
    const defaultKid = defaultKidRaw?.replaceAll("-", "").toLowerCase() ?? undefined;

    const robustness = cp.getAttribute("robustness") ?? undefined;

    // Look for license URL in various namespaces
    const msLaUrl = cp.getElementsByTagName("ms:laurl")[0]?.getAttribute("licenseUrl") ??
      cp.getElementsByTagName("ms:laurl")[0]?.textContent ?? undefined;
    const licenseUrl = msLaUrl ?? undefined;

    // Look for PSSH element
    let psshBase64: string | undefined;
    const psshEl =
      cp.getElementsByTagNameNS("urn:mpeg:cenc:2013", "pssh")[0] ??
      cp.getElementsByTagName("cenc:pssh")[0];
    if (psshEl?.textContent) {
      psshBase64 = psshEl.textContent.trim();
      // Deduplicate PSSH boxes by base64 content
      if (!seenPssh.has(psshBase64)) {
        seenPssh.add(psshBase64);
        const decoded = decodePsshBase64(psshBase64, "manifest");
        if (decoded) psshBoxes.push(decoded);
      }
    }

    const info: ContentProtectionInfo = {
      schemeIdUri,
      systemName,
      defaultKid,
      psshBase64,
      robustness,
      licenseUrl,
    };

    // Deduplicate identical ContentProtection entries across AdaptationSets
    const fp = cpFingerprint(info);
    if (!seen.has(fp)) {
      seen.add(fp);
      contentProtections.push(info);
    }
  }

  return { contentProtections, psshBoxes };
}

/** Parse HLS EXT-X-KEY and EXT-X-SESSION-KEY tags. */
function parseHlsKeys(manifestText: string): HlsKeyInfo[] {
  const keys: HlsKeyInfo[] = [];
  const regex = /#EXT-X-(?:SESSION-)?KEY:(.+)/g;
  let match;

  while ((match = regex.exec(manifestText)) !== null) {
    const attrs = match[1];
    const info: HlsKeyInfo = {
      method: extractAttr(attrs, "METHOD") ?? "NONE",
    };

    const uri = extractAttr(attrs, "URI");
    if (uri) info.uri = uri;

    const keyformat = extractAttr(attrs, "KEYFORMAT");
    if (keyformat) info.keyformat = keyformat;

    const versions = extractAttr(attrs, "KEYFORMATVERSIONS");
    if (versions) info.keyformatVersions = versions;

    const iv = extractAttr(attrs, "IV");
    if (iv) info.iv = iv;

    keys.push(info);
  }

  return keys;
}

/** Extract a named attribute value from an HLS tag attribute string. */
function extractAttr(attrs: string, name: string): string | null {
  // Handle quoted values: NAME="value"
  const quotedRe = new RegExp(`${name}="([^"]*)"`, "i");
  const quotedMatch = attrs.match(quotedRe);
  if (quotedMatch) return quotedMatch[1];

  // Handle unquoted values: NAME=value
  const unquotedRe = new RegExp(`${name}=([^,\\s]+)`, "i");
  const unquotedMatch = attrs.match(unquotedRe);
  if (unquotedMatch) return unquotedMatch[1];

  return null;
}

/**
 * Parse DRM metadata from a manifest string.
 * Auto-detects DASH (XML with <MPD>) vs HLS (starts with #EXTM3U).
 */
export function parseManifestDrm(manifestText: string): { info: ManifestDrmInfo; psshBoxes: PsshBox[] } {
  if (!manifestText) {
    return {
      info: { type: "unknown", contentProtections: [], hlsKeys: [] },
      psshBoxes: [],
    };
  }

  const trimmed = manifestText.trimStart();

  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<MPD")) {
    const { contentProtections, psshBoxes } = parseDashDrm(manifestText);
    return {
      info: { type: "dash", contentProtections, hlsKeys: [] },
      psshBoxes,
    };
  }

  if (trimmed.startsWith("#EXTM3U")) {
    return {
      info: { type: "hls", contentProtections: [], hlsKeys: parseHlsKeys(manifestText) },
      psshBoxes: [],
    };
  }

  return {
    info: { type: "unknown", contentProtections: [], hlsKeys: [] },
    psshBoxes: [],
  };
}
