/**
 * QSR completeness rules.
 *
 * ============================ THIS IS THE FILE YOU EDIT ============================
 * Right now this only distinguishes "an entry exists" from "it doesn't". When you paste the
 * real completeness criteria, express them as entries in REQUIRED_FIELDS and CROSS_CHECKS
 * below — nothing else in the codebase should need to change.
 * ==================================================================================
 */
import type { Project, QsrEntry } from "./vyaguta.ts";

export type QsrStatus =
  /** Entry exists and passes every rule. */
  | "FILLED"
  /** Entry exists but required fields are empty. */
  | "PARTIAL"
  /** Entry exists, fields are populated, but a consistency rule failed. */
  | "INVALID"
  /** No entry at all for this project/month. */
  | "MISSING"
  /** We could not tell. Never treated as compliant. */
  | "UNKNOWN";

export type Evaluation = {
  status: QsrStatus;
  missingFields: string[];
  issues: string[];
};

/**
 * Fields that must be present and non-empty on a QSR entry.
 * `key` is looked up on the raw entry (dotted paths allowed); `label` is what the person sees
 * in their Slack reminder, so write it the way the Vyaguta form labels it.
 *
 * TODO: replace with the real required-field list.
 */
const REQUIRED_FIELDS: { key: string; label: string }[] = [
  // { key: "overallStatus", label: "Overall status" },
  // { key: "risks",         label: "Risks & mitigation" },
  // { key: "clientFeedback", label: "Client feedback" },
];

/**
 * Consistency rules that look at the entry and the project together. Return a human-readable
 * problem string, or null if the rule passes.
 *
 * TODO: add the real cross-checks. The in-production example is a placeholder showing shape.
 */
const CROSS_CHECKS: { name: string; check: (entry: QsrEntry, project: Project) => string | null }[] =
  [
    // {
    //   name: "prod-requires-release-notes",
    //   check: (entry, project) =>
    //     project.inProduction && isEmpty(readPath(entry.raw, "releaseNotes"))
    //       ? "Project is in production but 'Release notes' is empty"
    //       : null,
    // },
  ];

export function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function evaluate(entry: QsrEntry | undefined, project: Project): Evaluation {
  if (!entry) {
    return { status: "MISSING", missingFields: [], issues: [] };
  }

  const missingFields = REQUIRED_FIELDS.filter(({ key }) => isEmpty(readPath(entry.raw, key))).map(
    ({ label }) => label,
  );

  const issues = CROSS_CHECKS.map(({ check }) => check(entry, project)).filter(
    (issue): issue is string => issue !== null,
  );

  if (missingFields.length > 0) return { status: "PARTIAL", missingFields, issues };
  if (issues.length > 0) return { status: "INVALID", missingFields, issues };
  return { status: "FILLED", missingFields: [], issues: [] };
}

/** True when the project owner should be nudged. */
export function needsReminder(status: QsrStatus): boolean {
  return status !== "FILLED";
}

/** Whether any real completeness rules are configured yet. */
export function rulesConfigured(): boolean {
  return REQUIRED_FIELDS.length > 0 || CROSS_CHECKS.length > 0;
}
