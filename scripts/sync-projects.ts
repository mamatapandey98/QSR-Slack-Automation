#!/usr/bin/env node
/**
 * Converts a downloaded CSV (from Google Sheets) into config/projects.json.
 *
 * Usage:
 *   node --experimental-strip-types scripts/sync-projects.ts [path/to/file.csv]
 *
 * If no CSV path is given, defaults to config/projects.csv.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CSV_PATH = process.argv[2] ?? resolve(REPO_ROOT, "config/projects.csv");
const OUT_PATH = resolve(REPO_ROOT, "config/projects.json");

type RequiredSection = "Engineering" | "Code Quality" | "QA";

interface Project {
  name: string;
  id?: number;
  leaderForReference?: string;
  inProduction?: boolean;
  skip?: boolean;
  requiredSections?: RequiredSection[];
}

function parseCSV(content: string): Project[] {
  const lines = content.trim().split("\n");
  const headers = parseRow(lines[0]);
  const projects: Project[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] ?? "").trim();
    });

    const project: Project = { name: row.name };

    if (row.id) project.id = Number(row.id);
    if (row.leaderForReference) project.leaderForReference = row.leaderForReference;
    if (row.inProduction === "true") project.inProduction = true;
    if (row.skip === "true") project.skip = true;
    if (row.requiredSections) {
      const sections = row.requiredSections
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as RequiredSection[];
      if (sections.length > 0) project.requiredSections = sections;
    }

    projects.push(project);
  }

  return projects;
}

// Handles quoted fields with commas inside them.
function parseRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

const csv = readFileSync(CSV_PATH, "utf8");
const projects = parseCSV(csv);

const output = {
  _comment: [
    "Auto-generated from CSV. Do not edit by hand — re-run scripts/sync-projects.ts instead.",
  ],
  projects,
};

writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(`✓ Wrote ${projects.length} projects to ${OUT_PATH}`);
