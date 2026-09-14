import type { ProjectConfig } from "./config.ts";
import type { Project, QsrEntry } from "./vyaguta.ts";
import { evaluate, needsReminder, type Evaluation } from "./rules.ts";

export type ProjectResult = {
  configuredName: string;
  project: Project | undefined;
  entry: QsrEntry | undefined;
  evaluation: Evaluation;
  inProduction: boolean | undefined;
  /** Who should be nudged. Config wins over whatever Vyaguta reports. */
  ownerEmail: string | undefined;
  ownerName: string | undefined;
  needsReminder: boolean;
};

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Matches a configured project to a Vyaguta project by ID first, then by normalized name. */
function findProject(
  configured: ProjectConfig,
  projects: Project[],
): Project | undefined {
  if (configured.id !== undefined) {
    const byId = projects.find((p) => p.id === String(configured.id));
    if (byId) return byId;
  }
  return projects.find((p) => normalize(p.name) === normalize(configured.name));
}

function findEntry(project: Project | undefined, entries: QsrEntry[]): QsrEntry | undefined {
  if (!project) return undefined;
  if (project.id !== undefined) {
    const byId = entries.find((e) => e.projectId === project.id);
    if (byId) return byId;
  }
  return entries.find(
    (e) => e.projectName !== undefined && normalize(e.projectName) === normalize(project.name),
  );
}

export function classify(
  configured: ProjectConfig[],
  projects: Project[],
  entries: QsrEntry[],
): ProjectResult[] {
  return configured.map((cfg) => {
    const project = findProject(cfg, projects);
    const entry = findEntry(project, entries);

    // A configured project we cannot find in Vyaguta is a config or endpoint problem, not
    // compliance data. Surface it as UNKNOWN so it shows up rather than passing silently.
    const evaluation: Evaluation = project
      ? evaluate(entry, project)
      : {
          status: "UNKNOWN",
          missingFields: [],
          issues: [`Project "${cfg.name}" was not found in the Vyaguta project list`],
        };

    return {
      configuredName: cfg.name,
      project,
      entry,
      evaluation,
      inProduction: project?.inProduction,
      ownerEmail: cfg.ownerEmail ?? project?.ownerEmail,
      ownerName: project?.ownerName,
      needsReminder: project !== undefined && needsReminder(evaluation.status),
    };
  });
}

export function summarize(results: ProjectResult[]): Record<string, number> {
  const counts: Record<string, number> = {
    FILLED: 0,
    PARTIAL: 0,
    INVALID: 0,
    MISSING: 0,
    UNKNOWN: 0,
  };
  for (const result of results) {
    counts[result.evaluation.status] = (counts[result.evaluation.status] ?? 0) + 1;
  }
  return counts;
}
