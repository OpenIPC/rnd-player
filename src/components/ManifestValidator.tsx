import { useEffect, useState, useRef } from "react";
import shaka from "shaka-player";
import type { ValidationResult, ValidationIssue, ValidationCategory, Severity } from "../utils/manifestValidation/types";
import { runValidation } from "../utils/manifestValidation/runValidation";

interface ManifestValidatorProps {
  player: shaka.Player;
  onClose: () => void;
}

const SEVERITY_ICON: Record<Severity, string> = {
  error: "●",
  warning: "▲",
  info: "○",
};

const CATEGORY_ORDER: ValidationCategory[] = [
  "Timeline",
  "Container",
  "Manifest Structure",
  "Codec & Tags",
  "Compatibility",
];

export default function ManifestValidator({
  player,
  onClose,
}: ManifestValidatorProps) {
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedIssues, setExpandedIssues] = useState<Set<string>>(new Set());
  const runCount = useRef(0);

  const autoExpand = (issues: ValidationIssue[]) => {
    const cats = new Set<string>();
    for (const issue of issues) {
      if (issue.severity === "error") cats.add(issue.category);
    }
    if (cats.size === 0) {
      for (const issue of issues) {
        if (issue.severity === "warning") cats.add(issue.category);
      }
    }
    if (cats.size === 0 && issues.length > 0) {
      cats.add(issues[0].category);
    }
    setExpandedCategories(cats);
  };

  const scan = () => {
    const id = ++runCount.current;
    setRunning(true);
    runValidation(player, (progressIssues) => {
      // Stage 1 timeline results arrive immediately
      if (id !== runCount.current) return;
      setResult({
        manifestType: player.getManifestType() ?? "unknown",
        manifestUrl: player.getAssetUri() ?? "",
        timestamp: Date.now(),
        duration: 0,
        issues: progressIssues,
        summary: {
          errors: progressIssues.filter((i) => i.severity === "error").length,
          warnings: progressIssues.filter((i) => i.severity === "warning").length,
          info: progressIssues.filter((i) => i.severity === "info").length,
        },
      });
      autoExpand(progressIssues);
    }).then((r) => {
      if (id !== runCount.current) return;
      setResult(r);
      setRunning(false);
      autoExpand(r.issues);
    });
  };

  // Run on mount
  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleIssue = (key: string) => {
    setExpandedIssues((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Group issues by category
  const grouped = new Map<ValidationCategory, ValidationIssue[]>();
  if (result) {
    for (const issue of result.issues) {
      const list = grouped.get(issue.category) ?? [];
      list.push(issue);
      grouped.set(issue.category, list);
    }
  }

  return (
    <div className="vp-mv-panel" onClick={(e) => e.stopPropagation()}>
      <button className="vp-mv-close" onClick={onClose}>
        ×
      </button>

      <div className="vp-mv-title">Manifest Validator</div>

      {/* Summary bar */}
      {result && (
        <div className="vp-mv-summary">
          <span className="vp-mv-summary-counts">
            {result.summary.errors > 0 && (
              <span className="vp-mv-count-error">
                {SEVERITY_ICON.error} {result.summary.errors} error{result.summary.errors !== 1 ? "s" : ""}
              </span>
            )}
            {result.summary.warnings > 0 && (
              <span className="vp-mv-count-warning">
                {SEVERITY_ICON.warning} {result.summary.warnings} warning{result.summary.warnings !== 1 ? "s" : ""}
              </span>
            )}
            {result.summary.info > 0 && (
              <span className="vp-mv-count-info">
                {SEVERITY_ICON.info} {result.summary.info} info
              </span>
            )}
            {result.issues.length === 0 && (
              <span className="vp-mv-count-ok">No issues found</span>
            )}
          </span>
          <button
            className="vp-mv-rescan"
            onClick={scan}
            disabled={running}
          >
            {running ? "Scanning..." : "Re-scan"}
          </button>
        </div>
      )}

      {/* Issue categories */}
      {result && (
        <div className="vp-mv-categories">
          {CATEGORY_ORDER.map((cat) => {
            const issues = grouped.get(cat);
            if (!issues || issues.length === 0) return null;
            const expanded = expandedCategories.has(cat);
            const errors = issues.filter((i) => i.severity === "error").length;
            const warnings = issues.filter((i) => i.severity === "warning").length;
            const infos = issues.filter((i) => i.severity === "info").length;

            return (
              <div key={cat} className="vp-mv-category">
                <div
                  className="vp-mv-category-header"
                  onClick={() => toggleCategory(cat)}
                >
                  <span className="vp-mv-chevron">{expanded ? "▼" : "▶"}</span>
                  <span className="vp-mv-category-name">{cat}</span>
                  <span className="vp-mv-category-counts">
                    ({formatCategoryCounts(errors, warnings, infos)})
                  </span>
                </div>
                {expanded && (
                  <div className="vp-mv-issues">
                    {issues.map((issue, idx) => {
                      const issueKey = `${issue.id}-${idx}`;
                      const isExpanded = expandedIssues.has(issueKey);
                      return (
                        <div key={issueKey} className="vp-mv-issue">
                          <div
                            className="vp-mv-issue-row"
                            onClick={issue.detail ? () => toggleIssue(issueKey) : undefined}
                          >
                            <span className={`vp-mv-severity vp-mv-severity-${issue.severity}`}>
                              {SEVERITY_ICON[issue.severity]}
                            </span>
                            <span className="vp-mv-issue-id">{issue.id}</span>
                            <span className="vp-mv-issue-message">{issue.message}</span>
                          </div>
                          {isExpanded && issue.detail && (
                            <div className="vp-mv-issue-detail">
                              {issue.detail}
                              {issue.specRef && (
                                <div className="vp-mv-spec-ref">Spec: {issue.specRef}</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Running state */}
      {running && !result && (
        <div className="vp-mv-running">Scanning manifest...</div>
      )}

      {/* Footer */}
      {result && (
        <div className="vp-mv-footer">
          <span className="vp-mv-timing">
            {result.duration.toFixed(0)}ms · {result.manifestType}
          </span>
        </div>
      )}
    </div>
  );
}

function formatCategoryCounts(errors: number, warnings: number, infos: number): string {
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors !== 1 ? "s" : ""}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? "s" : ""}`);
  if (infos > 0) parts.push(`${infos} info`);
  return parts.join(", ");
}
