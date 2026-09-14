import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const REPO_ROOT = resolve(import.meta.dirname, "..");

export const BASE_URL = (
  process.env.VYAGUTA_BASE_URL ?? "https://vyaguta.lftechnology.com"
).replace(/\/$/, "");

/** Where the authenticated browser session is cached. Gitignored — it is a live credential. */
export const STORAGE_STATE_PATH = resolve(REPO_ROOT, ".auth/storageState.json");

/** Generated artifacts: dry-run reports, discovery captures. Gitignored. */
export const OUT_DIR = resolve(REPO_ROOT, "out");

/**
 * One project we care about. `id` is optional because you may only know names up front;
 * once discovery confirms the ID field, filling it in makes matching exact instead of fuzzy.
 */
const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  id: z.union([z.string(), z.number()]).optional(),
  /**
   * Email of the person responsible for filing this project's QSR. Optional: if omitted we
   * fall back to whatever owner field Vyaguta exposes on the project record.
   */
  ownerEmail: z.string().email().optional(),
  /** Set true to skip this project without deleting it from the list. */
  skip: z.boolean().optional(),
});

const ProjectsFileSchema = z.object({
  projects: z.array(ProjectConfigSchema),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

const PROJECTS_PATH = resolve(REPO_ROOT, "config/projects.json");

export function loadProjects(): ProjectConfig[] {
  if (!existsSync(PROJECTS_PATH)) {
    throw new Error(
      `Missing ${PROJECTS_PATH}. Copy config/projects.example.json and fill in your project list.`,
    );
  }
  const raw: unknown = JSON.parse(readFileSync(PROJECTS_PATH, "utf8"));
  const parsed = ProjectsFileSchema.parse(raw);
  const active = parsed.projects.filter((p) => !p.skip);
  if (active.length === 0) {
    throw new Error(
      `No active projects in ${PROJECTS_PATH}. Refusing to run — an empty project list would ` +
        `look like "everyone is compliant".`,
    );
  }
  return active;
}
