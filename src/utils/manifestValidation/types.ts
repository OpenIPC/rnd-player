export type Severity = "error" | "warning" | "info";

export type ValidationCategory =
  | "Timeline"
  | "Manifest Structure"
  | "Codec & Tags"
  | "Container"
  | "Compatibility";

export interface ValidationIssue {
  /** Rule ID, e.g. "TL-001", "DASH-105", "BMFF-S01" */
  id: string;
  severity: Severity;
  category: ValidationCategory;
  /** Human-readable summary */
  message: string;
  /** Expanded explanation with spec reference */
  detail?: string;
  /** Spec reference, e.g. "RFC 8216 §4.3.3.1" */
  specRef?: string;
  /** Location in manifest hierarchy, e.g. "Period[0] > AdaptationSet[1]" */
  location?: string;
}

export interface ValidationResult {
  manifestType: string;
  manifestUrl: string;
  timestamp: number;
  /** Milliseconds taken to run validation */
  duration: number;
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
}
