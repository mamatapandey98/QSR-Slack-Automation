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

function withoutSection(section: "Engineering" | "Code Quality" | "QA", base = qsr()): Qsr {
  const stripped = { ...base } as Record<string, unknown>;
  for (const field of SECTION_FIELDS[section]) stripped[field] = null;
  return stripped as Qsr;
}

const map = (entry: Qsr | undefined) => new Map([[344, entry]]);

test("when a report is published and all three sections are signed off, it is classified as FILLED and no reminder is sent", () => {
  const results = classify([{ name: "Addy X/Addy Healthcare" }], [project()], map(qsr()));
  assert.equal(results[0]?.evaluation.status, "FILLED");
  assert.equal(results[0]?.needsReminder, false);
});

test("when a report is still a draft, it is classified as PARTIAL even if every section has content", () => {
  const { status, issues } = evaluate(qsr({ status: "DRAFT", qaMarkedAsDone: false }));
  assert.equal(status, "PARTIAL");
  assert.match(issues[0] ?? "", /Still a draft/);
});

test("when a report is published but an entire expected section has no data, it is classified as PARTIAL with that section listed as missing", () => {
  const { status, missingFields } = evaluate(withoutSection("QA"));
  assert.equal(status, "PARTIAL");
  assert.deepEqual(missingFields, ["QA metrics"]);
});

test("when a published report has inconsistent QA numbers, it is classified as PARTIAL with reason QA_DATA_INVALID", () => {
  const badQsr = qsr({ postProductionBugCount: 2, bugSeverityTotalBugCount: 3 });
  const evalResult = evaluate(badQsr);
  assert.equal(evalResult.status, "PARTIAL");
  assert.equal(evalResult.reason, "QA_DATA_INVALID");
  assert.match(evalResult.issues[0] ?? "", /Post Production Bug Count/);
});

test("when sign-off flags are true but the metric fields are empty, the report is still PARTIAL because flags are not a completeness signal", () => {
  let entry = withoutSection("Engineering");
  entry = withoutSection("Code Quality", entry);
  assert.equal(entry.engineeringMarkedAsDone, true);
  assert.deepEqual(evaluate(entry).missingFields, ["Engineering metrics", "Code Quality metrics"]);
  assert.equal(evaluate(entry).status, "PARTIAL");
});

test("when a project is configured to report only QA and the QA section has content, it is classified as FILLED regardless of other empty sections", () => {
  let entry = withoutSection("Engineering");
  entry = withoutSection("Code Quality", entry);
  assert.equal(evaluate(entry, ["QA"]).status, "FILLED");
});

test("when a project is configured to report only QA but the QA section is also empty, it is still classified as PARTIAL", () => {
  assert.equal(evaluate(withoutSection("QA"), ["QA"]).status, "PARTIAL");
});

test("when no QSR has been submitted for the month, the project is classified as MISSING and a reminder is sent to the project leader", () => {
  const results = classify([{ name: "Addy X/Addy Healthcare" }], [project()], map(undefined));
  assert.equal(results[0]?.evaluation.status, "MISSING");
  assert.equal(results[0]?.needsReminder, true);
  assert.equal(results[0]?.ownerEmail, "shuvangijoshi@lftechnology.com");
});

test("when a configured project cannot be found in Vyaguta, it is classified as UNKNOWN and no reminder is sent because compliance cannot be confirmed", () => {
  const results = classify([{ name: "Ghost Project" }], [project()], new Map());
  assert.equal(results[0]?.evaluation.status, "UNKNOWN");
  assert.match(results[0]?.evaluation.issues[0] ?? "", /not found in Vyaguta/);
  assert.equal(results[0]?.needsReminder, false);
});

test("when a project has a stale name in config but the correct id, it is matched by id and the live Vyaguta name is used", () => {
  const results = classify([{ name: "Old Name", id: 344 }], [project()], map(qsr()));
  assert.equal(results[0]?.project?.name, "Addy X/Addy Healthcare");
  assert.equal(results[0]?.evaluation.status, "FILLED");
});

test("when the configured project name differs only in case or surrounding whitespace, it still matches the correct Vyaguta project", () => {
  const results = classify(
    [{ name: "  addy x/addy   healthcare " }],
    [project()],
    map(qsr()),
  );
  assert.equal(results[0]?.evaluation.status, "FILLED");
});

test("when an ownerEmail is set in config, it overrides the Vyaguta project leader email for reminder delivery", () => {
  const results = classify(
    [{ name: "Addy X/Addy Healthcare", ownerEmail: "override@lftechnology.com" }],
    [project()],
    map(undefined),
  );
  assert.equal(results[0]?.ownerEmail, "override@lftechnology.com");
});

test("when inProduction is set in config, it is preserved on the result because Vyaguta does not track production status", () => {
  const results = classify(
    [{ name: "Addy X/Addy Healthcare", inProduction: true }],
    [project()],
    map(undefined),
  );
  assert.equal(results[0]?.inProduction, true);
});

test("when given a YYYY-MM string, parseMonth returns the full month name and year that Vyaguta expects", () => {
  assert.deepEqual(parseMonth("2026-09"), { year: 2026, monthName: "September" });
  assert.deepEqual(parseMonth("2026-01"), { year: 2026, monthName: "January" });
  assert.deepEqual(parseMonth("2026-12"), { year: 2026, monthName: "December" });
  assert.throws(() => parseMonth("2026-13"));
});

test("when searching a project's full QSR history, findQsrForMonth returns only the record matching the requested month and year", () => {
  const history = [
    qsr({ id: 1, month: "April", year: 2026 }),
    qsr({ id: 2, month: "September", year: 2025 }),
    qsr({ id: 3, month: "September", year: 2026 }),
  ];
  assert.equal(findQsrForMonth(history, "2026-09")?.id, 3);
  assert.equal(findQsrForMonth(history, "2025-09")?.id, 2);
  assert.equal(findQsrForMonth(history, "2026-07"), undefined);
});

test("when classify results include projects of different statuses, summarize returns the correct count per status", () => {
  const results = classify(
    [{ name: "Addy X/Addy Healthcare" }, { name: "Ghost Project" }],
    [project()],
    map(undefined),
  );
  const counts = summarize(results);
  assert.equal(counts["MISSING"], 1);
  assert.equal(counts["UNKNOWN"], 1);
});

test("when there are duplicate QSRs for the same month, a PUBLISHED record is preferred over a later empty DRAFT", () => {
  const history = [
    qsr({ id: 1280, status: "DRAFT", month: "August", engineeringMarkedAsDone: false,
          codeQualityMarkedAsDone: false, qaMarkedAsDone: false, createdAt: "2026-09-02T07:07:53.000Z" }),
    qsr({ id: 1257, status: "PUBLISHED", month: "August", createdAt: "2026-08-04T05:09:45.000Z" }),
  ];
  const found = findQsrForMonth(history, "2026-08");
  assert.equal(found?.id, 1257);
  assert.equal(evaluate(found).status, "FILLED");
});

test("when there are two duplicate drafts for the same month, the one with more sign-offs is selected", () => {
  const history = [
    qsr({ id: 1, status: "DRAFT", month: "August", engineeringMarkedAsDone: false,
          codeQualityMarkedAsDone: false, qaMarkedAsDone: false }),
    qsr({ id: 2, status: "DRAFT", month: "August", engineeringMarkedAsDone: true,
          codeQualityMarkedAsDone: true, qaMarkedAsDone: false }),
  ];
  assert.equal(findQsrForMonth(history, "2026-08")?.id, 2);
});

test("when two duplicate drafts have identical sign-offs, the most recently created one is selected as the tiebreaker", () => {
  const history = [
    qsr({ id: 1264, status: "DRAFT", month: "August", createdAt: "2026-08-07T09:47:03.000Z", updatedAt: null }),
    qsr({ id: 1266, status: "DRAFT", month: "August", createdAt: "2026-08-07T09:47:31.000Z", updatedAt: null }),
  ];
  assert.equal(findQsrForMonth(history, "2026-08")?.id, 1266);
});

test("when resolving duplicates for one month, the result does not affect the record returned for a different month", () => {
  const history = [
    qsr({ id: 1, status: "PUBLISHED", month: "July" }),
    qsr({ id: 2, status: "DRAFT", month: "August", qaMarkedAsDone: false,
          engineeringMarkedAsDone: false, codeQualityMarkedAsDone: false }),
  ];
  assert.equal(findQsrForMonth(history, "2026-08")?.id, 2);
  assert.equal(findQsrForMonth(history, "2026-07")?.id, 1);
});
