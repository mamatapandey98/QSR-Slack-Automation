/**
 * QSR completeness rules.
 *
 * Two facts about Vyaguta drive the whole design:
 *
 *  1. A report cannot be published until all three `*MarkedAsDone` flags are ticked. So every
 *     PUBLISHED record has all three true by construction — the flags carry no information
 *     about whether anything was actually filled in.
 *  2. Teams tick the box for sections they do not report on. Laudio publishes monthly with
 *     every engineering and code-quality metric null.
 *
 * Completeness is therefore judged on real metric values, and only for the sections a given
 * project is expected to report (derived from its own published history — see
 * `requiredSections` in config/projects.json).
 */
import { ALL_SECTIONS, sectionHasContent, type Qsr, type SectionName } from "./vyaguta.ts";
import { validateQaMetrics } from "./qa-rules.ts";

export type QsrStatus =
  /** Published, with content in every section this project is expected to report. */
  | "FILLED"
  /** Exists but unpublished, or published with an expected section left empty. */
  | "PARTIAL"
  /** No QSR at all for this project/month. */
  | "MISSING"
  /** We could not tell. Never treated as compliant. */
  | "UNKNOWN";

/**
 * Why a QSR is not complete. Distinguishes cases that need materially different reminders:
 * "you haven't started" reads very differently from "you're done, just hit publish".
 */
export type Reason =
  | "NOT_STARTED"
  /** Draft, with sections still to be ticked. */
  | "DRAFT_SECTIONS_PENDING"
  /** Draft, everything ticked, just not published. */
  | "DRAFT_UNPUBLISHED"
  /** Published, but an expected section has no data. */
  | "PUBLISHED_DATA_MISSING"
  /** Published, but QA defect metrics have mathematical or logical errors. */
  | "QA_DATA_INVALID"
  | "COMPLETE"
  | "NOT_FOUND";

export type Evaluation = {
  status: QsrStatus;
  reason: Reason;
  /** Expected sections with no data, named as they appear on the form. */
  missingFields: string[];
  /** Sections not yet marked done (only meaningful for drafts). */
  pendingSections: string[];
  issues: string[];
};

export function evaluate(
  entry: Qsr | undefined,
  requiredSections: SectionName[] = ALL_SECTIONS,
  inProduction?: boolean,
): Evaluation {
  if (!entry) {
    return {
      status: "MISSING",
      reason: "NOT_STARTED",
      missingFields: [],
      pendingSections: [],
      issues: [],
    };
  }

  const isPublished = entry.status?.toUpperCase() === "PUBLISHED";
  const issues: string[] = [];

  const qaValidation =
    requiredSections.includes("QA") && sectionHasContent(entry, "QA")
      ? validateQaMetrics(entry, inProduction)
      : { valid: true, issues: [] };

  if (!isPublished) {
    // Unpublished is incomplete regardless of content. Report which sections are still
    // unticked, since that is what actually blocks publishing.
    const unticked = ALL_SECTIONS.filter((section) => !isMarkedDone(entry, section));
    if (unticked.length > 0) {
      issues.push(`Still a draft — not yet marked done: ${unticked.join(", ")}`);
    } else {
      issues.push("All sections are marked done, but the report has not been published yet");
    }
    if (!qaValidation.valid) {
      issues.push(...qaValidation.issues);
    }
    return {
      status: "PARTIAL",
      reason: unticked.length > 0 ? "DRAFT_SECTIONS_PENDING" : "DRAFT_UNPUBLISHED",
      missingFields: [],
      pendingSections: unticked,
      issues,
    };
  }

  const missingFields = requiredSections
    .filter((section) => !sectionHasContent(entry, section))
    .map((section) => `${section} metrics`);

  if (missingFields.length > 0) {
    return {
      status: "PARTIAL",
      reason: "PUBLISHED_DATA_MISSING",
      missingFields,
      pendingSections: [],
      issues,
    };
  }

  if (!qaValidation.valid) {
    return {
      status: "PARTIAL",
      reason: "QA_DATA_INVALID",
      missingFields: [],
      pendingSections: [],
      issues: qaValidation.issues,
    };
  }

  return {
    status: "FILLED",
    reason: "COMPLETE",
    missingFields: [],
    pendingSections: [],
    issues: [],
  };
}

function isMarkedDone(entry: Qsr, section: SectionName): boolean {
  const key = {
    Engineering: "engineeringMarkedAsDone",
    "Code Quality": "codeQualityMarkedAsDone",
    QA: "qaMarkedAsDone",
  }[section];
  return (entry as Record<string, unknown>)[key] === true;
}

/** True when the project owner should be nudged. */
export function needsReminder(status: QsrStatus): boolean {
  return status !== "FILLED";
}
