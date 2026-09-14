import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const REPO_ROOT = resolve(import.meta.dirname, "..");

export const BASE_URL = (
  process.env.VYAGUTA_BASE_URL ?? "https://vyaguta.lftechnology.com"
).replace(/\/$/, "");

/**
 * Persistent Chrome profile holding the signed-in Vyaguta session. Gitignored — this is a
 * live credential. A real user-data dir (not a serialized storageState) because that is what
 * keeps a Google SSO session alive across runs.
 */
export const PROFILE_DIR = resolve(REPO_ROOT, ".auth/profile");

/** Last captured API credentials, so a re-run inside the token's lifetime skips the browser. */
export const SESSION_PATH = resolve(REPO_ROOT, ".auth/session.json");

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
   * Who to remind. Optional — defaults to the project's `projectLeader` from Vyaguta.
   * Set this when the project leader isn't the right person to chase.
   */
  ownerEmail: z.string().email().optional(),
  /**
   * Whether this project is in production. Vyaguta has no such field, so it is recorded here
   * by hand. Purely informational: it appears in the report and reminders, and never affects
   * whether a QSR is required.
   */
  inProduction: z.boolean().optional(),
  /**
   * Sections this project is expected to report on, derived from its own published history.
   * Omit to expect all three. Vyaguta forces every section to be ticked before publishing, so
   * this is the only way to tell "didn't report engineering" from "doesn't report engineering".
   */
  requiredSections: z.array(z.enum(["Engineering", "Code Quality", "QA"])).optional(),
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
