import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, summarize } from "../src/classify.ts";
import { evaluate } from "../src/rules.ts";
import {
  SECTION_FIELDS,
  findQsrForMonth,
  parseMonth,
  type Project,
  type Qsr,
} from "../src/vyaguta.ts";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 344,
    name: "Addy X/Addy Healthcare",
    status: "In Progress",
    projectLeader: { id: 1065, email: "shuvangijoshi@lftechnology.com", fullname: "Shuvangi Joshi" },
    ...overrides,
  } as Project;
}

/**
 * A published QSR with content in all three sections. Flags are all true because Vyaguta
 * refuses to publish otherwise — which is exactly why they are not a completeness signal.
 */
function qsr(overrides: Partial<Qsr> & Record<string, unknown> = {}): Qsr {
  return {
    id: 1,
    projectId: 344,
    status: "PUBLISHED",
    month: "September",
    year: 2026,
    engineeringMarkedAsDone: true,
    codeQualityMarkedAsDone: true,
    qaMarkedAsDone: true,
    prSize: 12,
    cycleTime: 3,
    testCoverage: 81,
    codeSmells: 4,
    postProductionBugCount: 2,
    softwareDefectTotalBugCount: 10,
    defectRemovalEfficiency: 80,
    defectLeakageRatio: 20,
    criticalCount: 0,
    majorCount: 0,
    minorCount: 2,
    bugSeverityTotalBugCount: 2,
    bsi: 1,
    ...overrides,
  } as Qsr;
}

/** Strips every metric in a section, mimicking a team that does not report it. */
function withoutSection(section: "Engineering" | "Code Quality" | "QA", base = qsr()): Qsr {
  const stripped = { ...base } as Record<string, unknown>;
  for (const field of SECTION_FIELDS[section]) stripped[field] = null;
  return stripped as Qsr;
}

const map = (entry: Qsr | undefined) => new Map([[344, entry]]);

test("published with all three sign-offs is FILLED", () => {
  const results = classify([{ name: "Addy X/Addy Healthcare" }], [project()], map(qsr()));
  assert.equal(results[0]?.evaluation.status, "FILLED");
  assert.equal(results[0]?.needsReminder, false);
});

test("DRAFT is PARTIAL even with content in every section", () => {
  const { status, issues } = evaluate(qsr({ status: "DRAFT", qaMarkedAsDone: false }));
  assert.equal(status, "PARTIAL");
  assert.match(issues[0] ?? "", /Still a draft/);
});

test("a published report with an empty expected section is PARTIAL", () => {
  const { status, missingFields } = evaluate(withoutSection("QA"));
  assert.equal(status, "PARTIAL");
  assert.deepEqual(missingFields, ["QA metrics"]);
});

test("a published report with QA calculation errors is PARTIAL with reason QA_DATA_INVALID", () => {
  const badQsr = qsr({ postProductionBugCount: 2, bugSeverityTotalBugCount: 3 });
  const evalResult = evaluate(badQsr);
  assert.equal(evalResult.status, "PARTIAL");
  assert.equal(evalResult.reason, "QA_DATA_INVALID");
  assert.match(evalResult.issues[0] ?? "", /Post Production Bug Count/);
});

test("sign-off flags alone never make a report complete (the Laudio case)", () => {
  // Every flag true, but engineering and code-quality metrics are all null.
  let entry = withoutSection("Engineering");
  entry = withoutSection("Code Quality", entry);
  assert.equal(entry.engineeringMarkedAsDone, true);
  assert.deepEqual(evaluate(entry).missingFields, ["Engineering metrics", "Code Quality metrics"]);
  assert.equal(evaluate(entry).status, "PARTIAL");
});

test("a project that only reports QA is FILLED when QA has content", () => {
  let entry = withoutSection("Engineering");
  entry = withoutSection("Code Quality", entry);
  assert.equal(evaluate(entry, ["QA"]).status, "FILLED");
});

test("a QA-only project is still PARTIAL when QA itself is empty", () => {
  assert.equal(evaluate(withoutSection("QA"), ["QA"]).status, "PARTIAL");
});

test("no QSR for the month is MISSING and needs a reminder", () => {
  const results = classify([{ name: "Addy X/Addy Healthcare" }], [project()], map(undefined));
  assert.equal(results[0]?.evaluation.status, "MISSING");
  assert.equal(results[0]?.needsReminder, true);
  assert.equal(results[0]?.ownerEmail, "shuvangijoshi@lftechnology.com");
});

test("a configured project absent from Vyaguta is UNKNOWN, not compliant", () => {
  const results = classify([{ name: "Ghost Project" }], [project()], new Map());
  assert.equal(results[0]?.evaluation.status, "UNKNOWN");
  assert.match(results[0]?.evaluation.issues[0] ?? "", /not found in Vyaguta/);
  // Nothing to remind about, because we cannot say whether it is really non-compliant.
  assert.equal(results[0]?.needsReminder, false);
});

test("matches by id even when the configured name is stale", () => {
  const results = classify([{ name: "Old Name", id: 344 }], [project()], map(qsr()));
  assert.equal(results[0]?.project?.name, "Addy X/Addy Healthcare");
  assert.equal(results[0]?.evaluation.status, "FILLED");
});

test("matches by name ignoring case and extra whitespace", () => {
  const results = classify(
    [{ name: "  addy x/addy   healthcare " }],
    [project()],
    map(qsr()),
  );
  assert.equal(results[0]?.evaluation.status, "FILLED");
});

test("config ownerEmail overrides the Vyaguta project leader", () => {
  const results = classify(
    [{ name: "Addy X/Addy Healthcare", ownerEmail: "override@lftechnology.com" }],
    [project()],
    map(undefined),
  );
  assert.equal(results[0]?.ownerEmail, "override@lftechnology.com");
});

test("inProduction comes from config, since Vyaguta does not record it", () => {
  const results = classify(
    [{ name: "Addy X/Addy Healthcare", inProduction: true }],
    [project()],
    map(undefined),
  );
  assert.equal(results[0]?.inProduction, true);
});

test("parseMonth converts YYYY-MM to Vyaguta's month name and year", () => {
  assert.deepEqual(parseMonth("2026-09"), { year: 2026, monthName: "September" });
  assert.deepEqual(parseMonth("2026-01"), { year: 2026, monthName: "January" });
  assert.deepEqual(parseMonth("2026-12"), { year: 2026, monthName: "December" });
  assert.throws(() => parseMonth("2026-13"));
});

test("findQsrForMonth picks the right month and year out of the full history", () => {
  const history = [
    qsr({ id: 1, month: "April", year: 2026 }),
    qsr({ id: 2, month: "September", year: 2025 }),
    qsr({ id: 3, month: "September", year: 2026 }),
  ];
  assert.equal(findQsrForMonth(history, "2026-09")?.id, 3);
  assert.equal(findQsrForMonth(history, "2025-09")?.id, 2);
  assert.equal(findQsrForMonth(history, "2026-07"), undefined);
});

test("summarize counts each status", () => {
  const results = classify(
    [{ name: "Addy X/Addy Healthcare" }, { name: "Ghost Project" }],
    [project()],
    map(undefined),
  );
  const counts = summarize(results);
  assert.equal(counts["MISSING"], 1);
  assert.equal(counts["UNKNOWN"], 1);
});

// Regression tests for duplicate QSR records in one month — observed in production.
test("a PUBLISHED record wins over a later empty DRAFT (SuperCare Health case)", () => {
  const history = [
    qsr({ id: 1280, status: "DRAFT", month: "August", engineeringMarkedAsDone: false,
          codeQualityMarkedAsDone: false, qaMarkedAsDone: false, createdAt: "2026-09-02T07:07:53.000Z" }),
    qsr({ id: 1257, status: "PUBLISHED", month: "August", createdAt: "2026-08-04T05:09:45.000Z" }),
  ];
  const found = findQsrForMonth(history, "2026-08");
  assert.equal(found?.id, 1257);
  assert.equal(evaluate(found).status, "FILLED");
});

test("between two drafts, the one with more sign-offs wins", () => {
  const history = [
    qsr({ id: 1, status: "DRAFT", month: "August", engineeringMarkedAsDone: false,
          codeQualityMarkedAsDone: false, qaMarkedAsDone: false }),
    qsr({ id: 2, status: "DRAFT", month: "August", engineeringMarkedAsDone: true,
          codeQualityMarkedAsDone: true, qaMarkedAsDone: false }),
  ];
  assert.equal(findQsrForMonth(history, "2026-08")?.id, 2);
});

test("identical drafts fall back to most recently touched (Colla Health case)", () => {
  const history = [
    qsr({ id: 1264, status: "DRAFT", month: "August", createdAt: "2026-08-07T09:47:03.000Z", updatedAt: null }),
    qsr({ id: 1266, status: "DRAFT", month: "August", createdAt: "2026-08-07T09:47:31.000Z", updatedAt: null }),
  ];
  assert.equal(findQsrForMonth(history, "2026-08")?.id, 1266);
});

test("duplicate resolution does not leak across months", () => {
  const history = [
    qsr({ id: 1, status: "PUBLISHED", month: "July" }),
    qsr({ id: 2, status: "DRAFT", month: "August", qaMarkedAsDone: false,
          engineeringMarkedAsDone: false, codeQualityMarkedAsDone: false }),
  ];
  assert.equal(findQsrForMonth(history, "2026-08")?.id, 2);
  assert.equal(findQsrForMonth(history, "2026-07")?.id, 1);
});
