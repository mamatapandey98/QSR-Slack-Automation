import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, summarize } from "../src/classify.ts";
import { isEmpty, readPath } from "../src/rules.ts";
import type { Project, QsrEntry } from "../src/vyaguta.ts";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "1",
    name: "Alpha",
    status: "Active",
    inProduction: true,
    ownerEmail: "owner@lftechnology.com",
    ownerName: "Owner",
    raw: {},
    ...overrides,
  };
}

function entry(overrides: Partial<QsrEntry> = {}): QsrEntry {
  return {
    projectId: "1",
    projectName: "Alpha",
    submittedBy: "owner@lftechnology.com",
    submittedAt: "2026-09-01",
    raw: {},
    ...overrides,
  };
}

test("project with a QSR entry is FILLED", () => {
  const results = classify([{ name: "Alpha" }], [project()], [entry()]);
  assert.equal(results[0]?.evaluation.status, "FILLED");
  assert.equal(results[0]?.needsReminder, false);
});

test("project with no QSR entry is MISSING and needs a reminder", () => {
  const results = classify([{ name: "Alpha" }], [project()], []);
  assert.equal(results[0]?.evaluation.status, "MISSING");
  assert.equal(results[0]?.needsReminder, true);
  assert.equal(results[0]?.ownerEmail, "owner@lftechnology.com");
});

test("configured project absent from Vyaguta is UNKNOWN, not compliant", () => {
  const results = classify([{ name: "Ghost" }], [project()], []);
  assert.equal(results[0]?.evaluation.status, "UNKNOWN");
  assert.match(results[0]?.evaluation.issues[0] ?? "", /not found/);
});

test("matches by id even when the name differs", () => {
  const results = classify([{ name: "Old Name", id: 1 }], [project({ name: "New Name" })], [entry()]);
  assert.equal(results[0]?.project?.name, "New Name");
  assert.equal(results[0]?.evaluation.status, "FILLED");
});

test("matches by name case- and whitespace-insensitively", () => {
  const results = classify([{ name: "  alpha  " }], [project()], [entry()]);
  assert.equal(results[0]?.evaluation.status, "FILLED");
});

test("config ownerEmail overrides the Vyaguta owner", () => {
  const results = classify(
    [{ name: "Alpha", ownerEmail: "override@lftechnology.com" }],
    [project()],
    [],
  );
  assert.equal(results[0]?.ownerEmail, "override@lftechnology.com");
});

test("summarize counts each status", () => {
  const results = classify(
    [{ name: "Alpha" }, { name: "Ghost" }],
    [project()],
    [],
  );
  const counts = summarize(results);
  assert.equal(counts["MISSING"], 1);
  assert.equal(counts["UNKNOWN"], 1);
});

test("isEmpty treats blank strings and empty collections as empty", () => {
  assert.equal(isEmpty(""), true);
  assert.equal(isEmpty("   "), true);
  assert.equal(isEmpty([]), true);
  assert.equal(isEmpty({}), true);
  assert.equal(isEmpty(null), true);
  assert.equal(isEmpty(undefined), true);
  assert.equal(isEmpty("filled"), false);
  assert.equal(isEmpty(0), false);
  assert.equal(isEmpty(false), false);
});

test("readPath walks dotted paths and tolerates gaps", () => {
  const record = { a: { b: { c: "deep" } } };
  assert.equal(readPath(record, "a.b.c"), "deep");
  assert.equal(readPath(record, "a.x.c"), undefined);
  assert.equal(readPath(record, "nope"), undefined);
});
