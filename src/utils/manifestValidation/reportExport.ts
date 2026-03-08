/**
 * Export manifest validation results as plain text (clipboard) or styled HTML (print-to-PDF).
 */

import type { ValidationResult, ValidationIssue, ValidationCategory } from "./types";

const SEVERITY_ICON: Record<string, string> = {
  error: "\u25CF",   // ●
  warning: "\u25B2", // ▲
  info: "\u25CB",    // ○
};

const CATEGORY_ORDER: ValidationCategory[] = [
  "Timeline",
  "Container",
  "Manifest Structure",
  "Codec & Tags",
  "Compatibility",
];

// ── Plain text report (for clipboard) ──

export function formatTextReport(result: ValidationResult, deepScanSummary?: string): string {
  const lines: string[] = [];
  lines.push("Manifest Validation Report");
  lines.push("=".repeat(40));
  lines.push(`URL: ${result.manifestUrl}`);
  lines.push(`Type: ${result.manifestType}`);
  lines.push(`Date: ${new Date(result.timestamp).toISOString()}`);
  lines.push(`Scan duration: ${result.duration.toFixed(0)}ms`);
  lines.push("");

  const { errors, warnings, info } = result.summary;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors !== 1 ? "s" : ""}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? "s" : ""}`);
  if (info > 0) parts.push(`${info} info`);
  lines.push(parts.length > 0 ? `Summary: ${parts.join(", ")}` : "Summary: No issues found");

  if (deepScanSummary) {
    lines.push(deepScanSummary);
  }
  lines.push("");

  const grouped = groupByCategory(result.issues);
  for (const cat of CATEGORY_ORDER) {
    const issues = grouped.get(cat);
    if (!issues || issues.length === 0) continue;

    lines.push(`── ${cat} ──`);
    for (const issue of issues) {
      lines.push(`  ${SEVERITY_ICON[issue.severity]} ${issue.id}  ${issue.message}`);
      if (issue.detail) {
        for (const detailLine of issue.detail.split("\n")) {
          lines.push(`      ${detailLine}`);
        }
      }
      if (issue.specRef) {
        lines.push(`      Spec: ${issue.specRef}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function copyReport(result: ValidationResult, deepScanSummary?: string): Promise<void> {
  const text = formatTextReport(result, deepScanSummary);
  await navigator.clipboard.writeText(text);
}

// ── HTML report (for print-to-PDF) ──

const SEVERITY_COLOR: Record<string, string> = {
  error: "#d32f2f",
  warning: "#f9a825",
  info: "#1976d2",
};

export function openPrintReport(result: ValidationResult, deepScanSummary?: string): void {
  const html = buildHtmlReport(result, deepScanSummary);
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  // Delay print to let styles render
  win.addEventListener("load", () => {
    win.focus();
    win.print();
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildHtmlReport(result: ValidationResult, deepScanSummary?: string): string {
  const { errors, warnings, info } = result.summary;
  const grouped = groupByCategory(result.issues);

  let categoriesHtml = "";
  for (const cat of CATEGORY_ORDER) {
    const issues = grouped.get(cat);
    if (!issues || issues.length === 0) continue;

    const catErrors = issues.filter((i) => i.severity === "error").length;
    const catWarns = issues.filter((i) => i.severity === "warning").length;
    const catInfos = issues.filter((i) => i.severity === "info").length;
    const countParts: string[] = [];
    if (catErrors > 0) countParts.push(`${catErrors} error${catErrors !== 1 ? "s" : ""}`);
    if (catWarns > 0) countParts.push(`${catWarns} warning${catWarns !== 1 ? "s" : ""}`);
    if (catInfos > 0) countParts.push(`${catInfos} info`);

    let issuesHtml = "";
    for (const issue of issues) {
      const color = SEVERITY_COLOR[issue.severity];
      issuesHtml += `<tr>
        <td style="color:${color};width:16px;vertical-align:top;padding:2px 4px 2px 0">${esc(SEVERITY_ICON[issue.severity])}</td>
        <td style="color:#666;white-space:nowrap;vertical-align:top;padding:2px 8px 2px 0;font-size:11px">${esc(issue.id)}</td>
        <td style="vertical-align:top;padding:2px 0">${esc(issue.message)}${
          issue.detail ? `<div style="color:#666;font-size:11px;margin:2px 0 4px;white-space:pre-wrap">${esc(issue.detail)}</div>` : ""
        }${
          issue.specRef ? `<div style="color:#999;font-size:10px;font-style:italic">Spec: ${esc(issue.specRef)}</div>` : ""
        }</td>
      </tr>`;
    }

    categoriesHtml += `
      <div style="margin-bottom:16px">
        <h3 style="font-size:13px;margin:0 0 4px;border-bottom:1px solid #ddd;padding-bottom:2px">
          ${esc(cat)} <span style="font-weight:normal;color:#888;font-size:11px">(${countParts.join(", ")})</span>
        </h3>
        <table style="border-collapse:collapse;width:100%;font-size:12px">${issuesHtml}</table>
      </div>`;
  }

  const summaryParts: string[] = [];
  if (errors > 0) summaryParts.push(`<span style="color:${SEVERITY_COLOR.error}">${SEVERITY_ICON.error} ${errors} error${errors !== 1 ? "s" : ""}</span>`);
  if (warnings > 0) summaryParts.push(`<span style="color:${SEVERITY_COLOR.warning}">${SEVERITY_ICON.warning} ${warnings} warning${warnings !== 1 ? "s" : ""}</span>`);
  if (info > 0) summaryParts.push(`<span style="color:${SEVERITY_COLOR.info}">${SEVERITY_ICON.info} ${info} info</span>`);
  const summaryLine = summaryParts.length > 0 ? summaryParts.join(" &nbsp; ") : '<span style="color:#4caf50">No issues found</span>';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Manifest Validation Report</title>
<style>
  @media print {
    body { margin: 12mm; }
    .no-print { display: none; }
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; color: #222; max-width: 720px; margin: 20px auto; line-height: 1.5; }
  .header { margin-bottom: 16px; }
  .meta { color: #666; font-size: 11px; margin: 2px 0; }
  .meta-url { font-family: monospace; font-size: 11px; word-break: break-all; color: #444; }
  .summary { font-size: 14px; margin: 8px 0 12px; padding: 6px 0; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; }
</style>
</head>
<body>
  <div class="header">
    <h1 style="font-size:18px;margin:0 0 4px">Manifest Validation Report</h1>
    <div class="meta-url">${esc(result.manifestUrl)}</div>
    <div class="meta">Type: ${esc(result.manifestType)} &nbsp;|&nbsp; Scan: ${result.duration.toFixed(0)}ms &nbsp;|&nbsp; ${esc(new Date(result.timestamp).toLocaleString())}</div>
    ${deepScanSummary ? `<div class="meta">${esc(deepScanSummary)}</div>` : ""}
  </div>
  <div class="summary">${summaryLine}</div>
  ${categoriesHtml}
  <div class="no-print" style="margin-top:24px;text-align:center;color:#999;font-size:11px">
    Use Ctrl+P / Cmd+P to save as PDF
  </div>
</body>
</html>`;
}

// ── Helpers ──

function groupByCategory(issues: ValidationIssue[]): Map<ValidationCategory, ValidationIssue[]> {
  const grouped = new Map<ValidationCategory, ValidationIssue[]>();
  for (const issue of issues) {
    const list = grouped.get(issue.category) ?? [];
    list.push(issue);
    grouped.set(issue.category, list);
  }
  return grouped;
}
