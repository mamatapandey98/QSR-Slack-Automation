import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMessage, type Recipient } from "../src/slack.ts";
import type { ProjectResult } from "../src/classify.ts";
import type { Evaluation, Reason } from "../src/rules.ts";

function result(
  name: string,
  reason: Reason,
  extra: Partial<Evaluation> = {},
  inProduction?: boolean,
): ProjectResult {
  const status = reason === "NOT_STARTED" ? "MISSING" : "PARTIAL";
  return {
    configuredName: name,
    project: { id: 1, name } as ProjectResult["project"],
    entry: undefined,
    evaluation: {
      status,
      reason,
      missingFields: [],
      pendingSections: [],
      issues: [],
      ...extra,
    },
    inProduction,
    requiredSections: ["Engineering", "Code Quality", "QA"],
    ownerEmail: "someone@lftechnology.com",
    ownerName: "Someone",
    needsReminder: true,
  };
}

const to = (results: ProjectResult[]): Recipient => ({
  email: "someone@lftechnology.com",
  slackId: "U123",
  results,
});

test("not-started message asks for the report to be created", () => {
  const text = renderMessage(to([result("Inpart Nexus", "NOT_STARTED")]), "2026-08");
  assert.match(text, /August 2026/);
  assert.match(text, /\*Inpart Nexus\* is not started/);
  assert.match(text, /create and publish/);
  // Should not accuse someone of a half-done job when they never started.
  assert.doesNotMatch(text, /draft/i);
});

test("draft-with-everything-ticked message only asks for publishing", () => {
  const text = renderMessage(to([result("Colla Health", "DRAFT_UNPUBLISHED")]), "2026-08");
  assert.match(text, /draft, not published/);
  assert.match(text, /just needs publishing/);
});

test("draft-with-pending-sections names those sections", () => {
  const text = renderMessage(
    to([
      result("Second Look (Mend.AI)", "DRAFT_SECTIONS_PENDING", {
        pendingSections: ["Engineering", "Code Quality"],
      }),
    ]),
    "2026-08",
  );
  assert.match(text, /still a draft/);
  assert.match(text, /Still to be marked done: Engineering, Code Quality/);
});

test("published-but-empty message names the empty metrics", () => {
  const text = renderMessage(
    to([
      result("Laudio", "PUBLISHED_DATA_MISSING", { missingFields: ["Engineering metrics"] }),
    ]),
    "2026-08",
  );
  assert.match(text, /published, but some metrics are empty/);
  assert.match(text, /Empty: Engineering metrics/);
});

test("several projects for one person are grouped into a single message", () => {
  const text = renderMessage(
    to([
      result("Colla Health", "DRAFT_UNPUBLISHED"),
      result("Buddica", "NOT_STARTED"),
    ]),
    "2026-08",
  );
  assert.match(text, /A few things on the \*August 2026\* QSR/);
  assert.match(text, /\*Colla Health\* — draft, not published/);
  assert.match(text, /\*Buddica\* — not started/);
  // One message, not two greetings.
  assert.equal(text.match(/Hi!/g)?.length, 1);
});

test("in-production projects are tagged", () => {
  const text = renderMessage(to([result("Laudio", "NOT_STARTED", {}, true)]), "2026-08");
  assert.match(text, /\*Laudio\* \(in production\)/);
});

test("messages never contain blank-line runs", () => {
  const text = renderMessage(
    to([result("A", "NOT_STARTED"), result("B", "DRAFT_UNPUBLISHED")]),
    "2026-08",
  );
  assert.doesNotMatch(text, /\n{3,}/);
});
