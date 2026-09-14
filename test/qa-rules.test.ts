import { test } from "node:test";
import assert from "node:assert/strict";
import { validateQaMetrics } from "../src/qa-rules.ts";
import type { Qsr } from "../src/vyaguta.ts";

function baseQsr(overrides: Partial<Qsr> = {}): Qsr {
  return {
    id: 1,
    projectId: 100,
    status: "PUBLISHED",
    postProductionBugCount: 5,
    softwareDefectTotalBugCount: 100,
    defectRemovalEfficiency: 95,
    defectLeakageRatio: 5,
    criticalCount: 1,
    majorCount: 2,
    minorCount: 2,
    bugSeverityTotalBugCount: 5,
    bsi: 1.8, // (3*1 + 2*2 + 1*2) / 5 = 9 / 5 = 1.8
    ...overrides,
  } as Qsr;
}

test("valid QSR data passes with no issues", () => {
  const res = validateQaMetrics(baseQsr());
  assert.equal(res.valid, true);
  assert.equal(res.issues.length, 0);
});

test("Total Bugs Count (BSI section) must match Post Production Bug Count", () => {
  // Colla Health real regression case: postProd = 2, sevTotal = 3
  const res = validateQaMetrics(baseQsr({ postProductionBugCount: 2, bugSeverityTotalBugCount: 3 }));
  assert.equal(res.valid, false);
  assert.match(
    res.issues[0] ?? "",
    /Post Production Bug Count \(2\) does not match Total Bugs Count in severity section \(3\)/,
  );
});

test("Severity counts sum must equal Total Bugs Count", () => {
  // Inpart AI App real regression case: sevTotal = 3, but crit/maj/min are null (0)
  const res = validateQaMetrics(
    baseQsr({
      criticalCount: null,
      majorCount: null,
      minorCount: null,
      bugSeverityTotalBugCount: 3,
      postProductionBugCount: 3,
    }),
  );
  assert.equal(res.valid, false);
  assert.match(
    res.issues[0] ?? "",
    /Severity breakdown \(0 Critical \+ 0 Major \+ 0 Minor = 0\) does not equal Total Bugs Count \(3\)/,
  );
});

test("Total Bug Count cannot be less than Post Production Bug Count", () => {
  const res = validateQaMetrics(
    baseQsr({ softwareDefectTotalBugCount: 2, postProductionBugCount: 5 }),
  );
  assert.equal(res.valid, false);
  assert.match(
    res.issues.find((i) => i.includes("cannot be less than")) ?? "",
    /Total Bug Count \(2\) cannot be less than Post Production Bug Count \(5\)/,
  );
});

test("DRE + DLR must add up to 100%", () => {
  const res = validateQaMetrics(
    baseQsr({ defectRemovalEfficiency: 80, defectLeakageRatio: 10 }),
  );
  assert.equal(res.valid, false);
  assert.match(
    res.issues.find((i) => i.includes("must add up to 100%")) ?? "",
    /DRE \(80%\) and DLR \(10%\) must add up to 100% \(currently 90.0%\)/,
  );
});

test("Total Bug Count 0 requires DRE=100% and DLR=0%", () => {
  // SuperCare Health real regression case: 0 bugs, DRE=0%, DLR=0%
  const res = validateQaMetrics(
    baseQsr({
      softwareDefectTotalBugCount: 0,
      postProductionBugCount: 0,
      bugSeverityTotalBugCount: 0,
      criticalCount: 0,
      majorCount: 0,
      minorCount: 0,
      defectRemovalEfficiency: 0,
      defectLeakageRatio: 0,
      bsi: 0,
    }),
  );
  assert.equal(res.valid, false);
  assert.match(
    res.issues[0] ?? "",
    /Total Bug Count is 0: DRE should be 100% and DLR 0%/,
  );
});

test("DLR formula verification catches bad math", () => {
  // 5 post-prod / 100 total = 5%, entered 15%
  const res = validateQaMetrics(
    baseQsr({ defectRemovalEfficiency: 85, defectLeakageRatio: 15 }),
  );
  assert.equal(res.valid, false);
  assert.match(
    res.issues.find((i) => i.includes("DLR is entered as")) ?? "",
    /DLR is entered as 15%, but calculated is 5.0%/,
  );
});

test("DRE formula verification catches bad math", () => {
  // 95 pre-prod / 100 total = 95%, entered 85%
  const res = validateQaMetrics(
    baseQsr({ defectRemovalEfficiency: 85, defectLeakageRatio: 15 }),
  );
  assert.equal(res.valid, false);
  assert.match(
    res.issues.find((i) => i.includes("DRE is entered as")) ?? "",
    /DRE is entered as 85%, but calculated is 95.0%/,
  );
});

test("BSI formula verification catches bad calculation", () => {
  // 1 crit (3), 2 maj (4), 2 min (2) -> 9 / 5 = 1.8. Entered 2.5
  const res = validateQaMetrics(baseQsr({ bsi: 2.5 }));
  assert.equal(res.valid, false);
  assert.match(
    res.issues.find((i) => i.includes("BSI is entered as")) ?? "",
    /BSI is entered as 2.5, but calculated is 1.80/,
  );
});

test("BSI when 0 post-production bugs should be 0", () => {
  const res = validateQaMetrics(
    baseQsr({
      postProductionBugCount: 0,
      bugSeverityTotalBugCount: 0,
      criticalCount: 0,
      majorCount: 0,
      minorCount: 0,
      defectRemovalEfficiency: 100,
      defectLeakageRatio: 0,
      bsi: 1.5,
    }),
  );
  assert.equal(res.valid, false);
  assert.match(
    res.issues.find((i) => i.includes("BSI is entered as 1.5, but should be 0")) ?? "",
    /BSI is entered as 1.5, but should be 0/,
  );
});

test("Non-production project cannot have post-production bugs", () => {
  const res = validateQaMetrics(baseQsr({ postProductionBugCount: 2 }), false);
  assert.equal(res.valid, false);
  assert.match(
    res.issues.find((i) => i.includes("marked as NOT in production")) ?? "",
    /Project is marked as NOT in production, but reports 2 post-production bug\(s\)/,
  );
});

