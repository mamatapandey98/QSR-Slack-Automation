import type { ProjectConfig } from "./config.ts";
import { ALL_SECTIONS, personName, type Project, type Qsr } from "./vyaguta.ts";
import { evaluate, needsReminder, type Evaluation } from "./rules.ts";

export type ProjectResult = {
  configuredName: string;
  project: Project | undefined;
  entry: Qsr | undefined;
  evaluation: Evaluation;
  /** From config only — Vyaguta has no production field. Undefined means "not recorded". */
  inProduction: boolean | undefined;
  /** Sections this project is expected to report on. */
  requiredSections: readonly string[];
  /** Who to nudge: config override first, then the project leader. */
  ownerEmail: string | undefined;
  ownerName: string | undefined;
  needsReminder: boolean;
};

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Matches a configured project to a Vyaguta project by ID first, then by normalized name. */
export function findProject(
  configured: ProjectConfig,
  projects: Project[],
): Project | undefined {
  if (configured.id !== undefined) {
    const byId = projects.find((p) => p.id === Number(configured.id));
    if (byId) return byId;
  }
  return projects.find((p) => normalize(p.name) === normalize(configured.name));
}

export function classify(
  configured: ProjectConfig[],
  projects: Project[],
  qsrsByProject: Map<number, Qsr | undefined>,
): ProjectResult[] {
  return configured.map((cfg) => {
    const project = findProject(cfg, projects);
    const entry = project ? qsrsByProject.get(project.id) : undefined;

    // A configured project missing from Vyaguta is a config problem, not compliance data.
    // Surface it as UNKNOWN so it is visible rather than silently passing.
    const evaluation: Evaluation = project
      ? evaluate(entry, cfg.requiredSections ?? ALL_SECTIONS, cfg.inProduction)
      : {
          status: "UNKNOWN",
          reason: "NOT_FOUND",
          missingFields: [],
          pendingSections: [],
          issues: [
            `Project "${cfg.name}" was not found in Vyaguta — check the name in config/projects.json`,
          ],
        };

    return {
      configuredName: cfg.name,
      project,
      entry,
      evaluation,
      inProduction: cfg.inProduction,
      requiredSections: cfg.requiredSections ?? ALL_SECTIONS,
      ownerEmail: cfg.ownerEmail ?? project?.projectLeader?.email,
      ownerName: personName(project?.projectLeader),
      needsReminder: project !== undefined && needsReminder(evaluation.status),
    };
  });
}

export function summarize(results: ProjectResult[]): Record<string, number> {
  const counts: Record<string, number> = { FILLED: 0, PARTIAL: 0, MISSING: 0, UNKNOWN: 0 };
  for (const result of results) {
    counts[result.evaluation.status] = (counts[result.evaluation.status] ?? 0) + 1;
  }
  return counts;
}
