/**
 * Export DRM diagnostics as plain text (clipboard) or styled HTML (print-to-PDF).
 * Mirrors the pattern from src/utils/manifestValidation/reportExport.ts.
 */

import type { DrmDiagnosticsState, PsshBox, WidevinePssh } from "./types";
import type { EmeEventType } from "./emeCapture";
import type { DiagnosticSeverity } from "./silentFailures";

const EME_TYPE_LABELS: Record<EmeEventType, string> = {
  "access-request": "ACCESS?",
  "access-granted": "ACCESS+",
  "access-denied": "ACCESS-",
  "keys-created": "KEYS",
  "keys-set": "SET",
  "generate-request": "INIT",
  "message": "MSG",
  "update": "UPDATE",
  "key-status-change": "STATUS",
  "close": "CLOSE",
  "expiration-change": "EXPIRY",
  "error": "ERROR",
};

const SEVERITY_ICON: Record<DiagnosticSeverity, string> = {
  error: "\u25CF",   // ●
  warning: "\u25B2", // ▲
  info: "\u25CB",    // ○
};

// ── Plain text report (for clipboard) ──

function formatRelativeTime(ts: number, baseTs: number): string {
  const delta = ts - baseTs;
  const mins = Math.floor(delta / 60000);
  const secs = Math.floor((delta % 60000) / 1000);
  const ms = Math.floor(delta % 1000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function formatPsshSummary(box: PsshBox): string {
  const parts = [box.systemName, `v${box.version}`];
  if (box.keyIds.length > 0) {
    parts.push(`${box.keyIds.length} KID${box.keyIds.length !== 1 ? "s" : ""}`);
  }
  if (box.decoded && "keyIds" in box.decoded) {
    const wv = box.decoded as WidevinePssh;
    if (wv.provider) parts.push(`provider "${wv.provider}"`);
  }
  return parts.join(" \u2014 ");
}

export function formatTextReport(state: DrmDiagnosticsState, manifestUrl?: string): string {
  const lines: string[] = [];
  lines.push("DRM Diagnostics Report");
  lines.push("=".repeat(40));
  if (manifestUrl) lines.push(`URL: ${manifestUrl}`);
  if (state.manifest) lines.push(`Type: ${state.manifest.type.toUpperCase()}`);
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push("");

  // ── Encryption Metadata ──
  lines.push("\u2500\u2500 Encryption Metadata \u2500\u2500");

  const systemNames = new Set<string>();
  const defaultKids = new Set<string>();
  if (state.manifest) {
    for (const cp of state.manifest.contentProtections) {
      systemNames.add(cp.systemName);
      if (cp.defaultKid) defaultKids.add(cp.defaultKid);
    }
  }
  if (systemNames.size > 0) {
    lines.push(`  DRM Systems: ${Array.from(systemNames).join(", ")}`);
  }
  if (defaultKids.size > 0) {
    lines.push(`  Default KID: ${Array.from(defaultKids).join(", ")}`);
  }

  // Track encryption
  const tracks = state.initSegment?.tracks ?? [];
  if (tracks.length > 0) {
    lines.push("");
    for (const t of tracks) {
      const parts = [];
      if (t.scheme) parts.push(t.scheme);
      parts.push(`KID ${t.defaultKid}`);
      parts.push(`IV ${t.defaultIvSize} bytes`);
      lines.push(`  Track ${t.trackId}: ${parts.join(", ")}`);
    }
  }

  // PSSH boxes
  const allPssh: PsshBox[] = [
    ...(state.manifestPsshBoxes ?? []),
    ...(state.initSegment?.psshBoxes ?? []),
  ];
  if (allPssh.length > 0) {
    lines.push("");
    for (const box of allPssh) {
      lines.push(`  PSSH: ${formatPsshSummary(box)}`);
    }
  }

  // HLS keys
  const hlsKeys = state.manifest?.hlsKeys ?? [];
  if (hlsKeys.length > 0) {
    lines.push("");
    for (const hk of hlsKeys) {
      const parts = [hk.method];
      if (hk.keyformat) parts.push(hk.keyformat);
      if (hk.uri) parts.push(hk.uri);
      lines.push(`  HLS Key: ${parts.join(", ")}`);
    }
  }

  if (systemNames.size === 0 && tracks.length === 0 && hlsKeys.length === 0) {
    lines.push("  No DRM detected");
  }
  lines.push("");

  // ── EME Events ──
  const events = state.emeEvents ?? [];
  lines.push(`\u2500\u2500 EME Events (${events.length}) \u2500\u2500`);
  if (events.length > 0) {
    const baseTs = events[0].timestamp;
    for (const event of events) {
      const time = formatRelativeTime(event.timestamp, baseTs);
      const label = EME_TYPE_LABELS[event.type] ?? event.type;
      let line = `  ${time}  ${label.padEnd(8)}  ${event.detail}`;
      if (event.duration !== undefined) {
        line += `  (+${Math.round(event.duration)}ms)`;
      }
      lines.push(line);
    }
  } else {
    lines.push("  No events captured");
  }
  lines.push("");

  // ── License Exchanges ──
  const exchanges = state.licenseExchanges ?? [];
  lines.push(`\u2500\u2500 License Exchanges (${exchanges.length}) \u2500\u2500`);
  if (exchanges.length > 0) {
    for (const ex of exchanges) {
      const parts = [ex.drmSystem.toUpperCase(), ex.url];
      if (ex.responseStatus != null) parts.push(String(ex.responseStatus));
      if (ex.durationMs != null) parts.push(`${Math.round(ex.durationMs)}ms`);
      if (ex.error) parts.push(`ERROR: ${ex.error}`);
      lines.push(`  ${parts.join("  ")}`);
    }
  } else {
    lines.push("  No exchanges captured");
  }
  lines.push("");

  // ── Diagnostics ──
  const diagnostics = state.diagnostics ?? [];
  lines.push(`\u2500\u2500 Diagnostics \u2500\u2500`);
  if (diagnostics.length === 0) {
    lines.push("  \u2713 No issues detected");
  } else {
    for (const d of diagnostics) {
      lines.push(`  ${SEVERITY_ICON[d.severity]} ${d.id}  ${d.title}`);
      if (d.detail) {
        for (const dl of d.detail.split("\n")) {
          lines.push(`      ${dl}`);
        }
      }
    }
  }
  lines.push("");

  // ── Compatibility ──
  lines.push("\u2500\u2500 Compatibility \u2500\u2500");
  const compat = state.compatibility;
  if (compat) {
    for (const r of compat.results) {
      const status = r.supported ? "\u25CF Supported" : "\u25CB Not found";
      const robust = r.robustness ?? "\u2014";
      lines.push(`  ${r.label.padEnd(12)}  ${status.padEnd(15)}  ${robust.padEnd(20)}  ${r.keySystem}`);
    }
    lines.push("");
    const parts = [];
    parts.push(`EME: ${compat.emeAvailable ? "available" : "absent"}`);
    parts.push(`Secure context: ${compat.secureContext ? "yes" : "no"}`);
    parts.push(`SW decrypt: ${compat.softwareDecryptAvailable ? "available" : "absent"}`);
    lines.push(`  ${parts.join(" | ")}`);
  } else {
    lines.push("  Not probed");
  }

  return lines.join("\n");
}

export async function copyReport(state: DrmDiagnosticsState, manifestUrl?: string): Promise<void> {
  const text = formatTextReport(state, manifestUrl);
  await navigator.clipboard.writeText(text);
}

// ── HTML report (for print-to-PDF) ──

const SEVERITY_COLOR: Record<DiagnosticSeverity, string> = {
  error: "#d32f2f",
  warning: "#f9a825",
  info: "#1976d2",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildHtmlReport(state: DrmDiagnosticsState, manifestUrl?: string): string {
  const events = state.emeEvents ?? [];
  const exchanges = state.licenseExchanges ?? [];
  const diagnostics = state.diagnostics ?? [];
  const tracks = state.initSegment?.tracks ?? [];
  const allPssh: PsshBox[] = [...(state.manifestPsshBoxes ?? []), ...(state.initSegment?.psshBoxes ?? [])];
  const compat = state.compatibility;

  // Header
  const metaParts: string[] = [];
  if (state.manifest) metaParts.push(`Type: ${esc(state.manifest.type.toUpperCase())}`);
  metaParts.push(esc(new Date().toLocaleString()));

  // Metadata section
  let metadataHtml = "";
  const systemNames = new Set<string>();
  if (state.manifest) {
    for (const cp of state.manifest.contentProtections) systemNames.add(cp.systemName);
  }
  if (systemNames.size > 0) {
    metadataHtml += `<div style="margin:4px 0"><strong>DRM Systems:</strong> ${esc(Array.from(systemNames).join(", "))}</div>`;
  }
  if (tracks.length > 0) {
    for (const t of tracks) {
      metadataHtml += `<div style="font-size:11px;color:#555">Track ${t.trackId}: ${esc(t.scheme ?? "encrypted")}, KID <code>${esc(t.defaultKid)}</code>, IV ${t.defaultIvSize} bytes</div>`;
    }
  }
  if (allPssh.length > 0) {
    for (const box of allPssh) {
      metadataHtml += `<div style="font-size:11px;color:#555">PSSH: ${esc(formatPsshSummary(box))}</div>`;
    }
  }
  if (!metadataHtml) {
    metadataHtml = '<div style="color:#888">No DRM detected</div>';
  }

  // EME events
  let emeHtml = "";
  if (events.length > 0) {
    const baseTs = events[0].timestamp;
    for (const event of events) {
      const time = formatRelativeTime(event.timestamp, baseTs);
      const label = EME_TYPE_LABELS[event.type] ?? event.type;
      const color = event.success === false || event.type === "error" ? "#d32f2f"
        : event.type === "access-denied" ? "#f9a825"
        : event.success === true ? "#4caf50" : "#333";
      emeHtml += `<tr><td style="font-family:monospace;font-size:11px;padding:1px 6px 1px 0;color:#666">${esc(time)}</td>` +
        `<td style="font-family:monospace;font-size:11px;padding:1px 6px;color:${color};font-weight:600">${esc(label)}</td>` +
        `<td style="font-size:11px;padding:1px 0">${esc(event.detail)}${event.duration !== undefined ? ` <span style="color:#999">(+${Math.round(event.duration)}ms)</span>` : ""}</td></tr>`;
    }
  }

  // License exchanges
  let licenseHtml = "";
  if (exchanges.length > 0) {
    for (const ex of exchanges) {
      const statusColor = ex.error || !ex.responseStatus ? "#d32f2f" : (ex.responseStatus >= 200 && ex.responseStatus < 300) ? "#4caf50" : "#d32f2f";
      licenseHtml += `<tr>` +
        `<td style="font-size:11px;padding:2px 6px 2px 0;font-weight:600">${esc(ex.drmSystem.toUpperCase())}</td>` +
        `<td style="font-size:11px;font-family:monospace;padding:2px 6px;word-break:break-all">${esc(ex.url)}</td>` +
        `<td style="font-size:11px;padding:2px 6px;color:${statusColor}">${ex.responseStatus ?? (ex.error ? "ERR" : "")}</td>` +
        `<td style="font-size:11px;padding:2px 0;color:#666">${ex.durationMs != null ? `${Math.round(ex.durationMs)}ms` : ""}</td>` +
        `</tr>`;
    }
  }

  // Diagnostics
  let diagHtml = "";
  if (diagnostics.length === 0) {
    diagHtml = '<div style="color:#4caf50;font-size:12px">\u2713 No issues detected</div>';
  } else {
    for (const d of diagnostics) {
      const color = SEVERITY_COLOR[d.severity];
      diagHtml += `<div style="margin:4px 0;font-size:12px"><span style="color:${color}">${esc(SEVERITY_ICON[d.severity])}</span> <strong>${esc(d.id)}</strong> ${esc(d.title)}` +
        (d.detail ? `<div style="color:#666;font-size:11px;margin:2px 0 4px 16px;white-space:pre-wrap">${esc(d.detail)}</div>` : "") +
        `</div>`;
    }
  }

  // Compatibility
  let compatHtml = "";
  if (compat) {
    let rows = "";
    for (const r of compat.results) {
      const statusColor = r.supported ? "#4caf50" : "#999";
      rows += `<tr>` +
        `<td style="padding:2px 8px 2px 0;font-size:11px">${esc(r.label)}</td>` +
        `<td style="padding:2px 8px;font-size:11px;color:${statusColor}">${r.supported ? "\u25CF Supported" : "\u25CB Not found"}</td>` +
        `<td style="padding:2px 8px;font-size:11px;font-family:monospace;color:#666">${esc(r.robustness ?? "\u2014")}</td>` +
        `<td style="padding:2px 0;font-size:11px;font-family:monospace;color:#666">${esc(r.keySystem)}</td>` +
        `</tr>`;
    }
    compatHtml = `<table style="border-collapse:collapse;width:100%"><thead><tr>` +
      `<th style="text-align:left;font-size:11px;padding:2px 8px 2px 0;border-bottom:1px solid #ddd">DRM System</th>` +
      `<th style="text-align:left;font-size:11px;padding:2px 8px;border-bottom:1px solid #ddd">Status</th>` +
      `<th style="text-align:left;font-size:11px;padding:2px 8px;border-bottom:1px solid #ddd">Robustness</th>` +
      `<th style="text-align:left;font-size:11px;padding:2px 0;border-bottom:1px solid #ddd">Key System</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>` +
      `<div style="margin-top:6px;font-size:11px;color:#666">` +
      `EME: ${compat.emeAvailable ? '<span style="color:#4caf50">available</span>' : '<span style="color:#999">absent</span>'} | ` +
      `Secure context: ${compat.secureContext ? '<span style="color:#4caf50">yes</span>' : '<span style="color:#d32f2f">no</span>'} | ` +
      `SW decrypt: ${compat.softwareDecryptAvailable ? '<span style="color:#4caf50">available</span>' : '<span style="color:#999">absent</span>'}` +
      `</div>`;
  } else {
    compatHtml = '<div style="color:#888;font-size:12px">Not probed</div>';
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>DRM Diagnostics Report</title>
<style>
  @media print {
    body { margin: 12mm; }
    .no-print { display: none; }
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; color: #222; max-width: 720px; margin: 20px auto; line-height: 1.5; }
  .section { margin-bottom: 16px; }
  .section h3 { font-size: 13px; margin: 0 0 4px; border-bottom: 1px solid #ddd; padding-bottom: 2px; }
  .meta { color: #666; font-size: 11px; margin: 2px 0; }
  .meta-url { font-family: monospace; font-size: 11px; word-break: break-all; color: #444; }
</style>
</head>
<body>
  <div style="margin-bottom:16px">
    <h1 style="font-size:18px;margin:0 0 4px">DRM Diagnostics Report</h1>
    ${manifestUrl ? `<div class="meta-url">${esc(manifestUrl)}</div>` : ""}
    <div class="meta">${metaParts.join(" &nbsp;|&nbsp; ")}</div>
  </div>
  <div class="section">
    <h3>Encryption Metadata</h3>
    ${metadataHtml}
  </div>
  <div class="section">
    <h3>EME Events (${events.length})</h3>
    ${events.length > 0 ? `<table style="border-collapse:collapse;width:100%">${emeHtml}</table>` : '<div style="color:#888;font-size:12px">No events captured</div>'}
  </div>
  <div class="section">
    <h3>License Exchanges (${exchanges.length})</h3>
    ${exchanges.length > 0 ? `<table style="border-collapse:collapse;width:100%">${licenseHtml}</table>` : '<div style="color:#888;font-size:12px">No exchanges captured</div>'}
  </div>
  <div class="section">
    <h3>Diagnostics</h3>
    ${diagHtml}
  </div>
  <div class="section">
    <h3>Compatibility</h3>
    ${compatHtml}
  </div>
  <div class="no-print" style="margin-top:24px;text-align:center;color:#999;font-size:11px">
    Use Ctrl+P / Cmd+P to save as PDF
  </div>
</body>
</html>`;
}

export function openPrintReport(state: DrmDiagnosticsState, manifestUrl?: string): void {
  const html = buildHtmlReport(state, manifestUrl);
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.addEventListener("load", () => {
    win.focus();
    win.print();
  });
}
