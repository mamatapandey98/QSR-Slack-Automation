import { z } from "zod";
import { BASE_URL } from "./config.ts";
import { sessionHeaders, type VyagutaSession } from "./auth.ts";

/**
 * Vyaguta API client.
 *
 * Endpoints confirmed by live probing on 2026-09-14:
 *   GET /api/teams/projects?statusIds=4,5&size=40&page=N  -> { data: [...], meta: {page,pageSize,total} }
 *   GET /api/teams/qsrs?projectId=N                       -> { data: [...] }  (ALL months)
 *   GET /api/teams/status-types                           -> 4 = In Progress, 5 = Lead
 *   GET /api/core/users/:id                               -> { data: { email, ... } }
 *
 * Two quirks worth knowing:
 *  - `size` is capped at 40, so the project list must be paginated.
 *  - /api/teams/qsrs ignores year/month query params and returns every QSR for the project.
 *    Month filtering therefore happens here, not server-side.
 */

/** Project status IDs. The UI's default filter is In Progress + Lead. */
export const STATUS_IN_PROGRESS = 4;
export const STATUS_LEAD = 5;

const PersonSchema = z
  .object({
    id: z.number().optional(),
    email: z.string().optional(),
    empId: z.string().optional(),
    // The API is inconsistent: projects use `fullname`, QSR records use `fullName`.
    fullname: z.string().optional(),
    fullName: z.string().optional(),
  })
  .passthrough();

const ProjectSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    status: z.string().nullish(),
    projectLeader: PersonSchema.nullish(),
    accountManager: PersonSchema.nullish(),
    relationshipManager: PersonSchema.nullish(),
    latestPsr: z.object({ health: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const QsrSchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    /** "DRAFT" | "PUBLISHED" */
    status: z.string().nullish(),
    projectId: z.number(),
    /** English month name, e.g. "April". */
    month: z.string().nullish(),
    year: z.number().nullish(),
    createdBy: PersonSchema.nullish(),
    engineeringMarkedAsDone: z.boolean().nullish(),
    codeQualityMarkedAsDone: z.boolean().nullish(),
    qaMarkedAsDone: z.boolean().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
  })
  .passthrough();

export type Project = z.infer<typeof ProjectSchema>;
export type Qsr = z.infer<typeof QsrSchema>;

/**
 * The metric fields behind each section of the QSR form, from GET /api/teams/qsrs/:id.
 *
 * These matter because the `*MarkedAsDone` flags on the summary record are just checkboxes:
 * Laudio's August report has every flag true while every engineering and code-quality metric
 * is null. Completeness therefore has to be judged on actual values, not the flags.
 */
export const SECTION_FIELDS = {
  Engineering: [
    "prSize",
    "cycleTime",
    "codingTime",
    "pickupTime",
    "reviewTime",
    "deployFrequencyPerService",
    "deployFrequencyDetail",
    "leadTime",
    "engineeringNote",
  ],
  "Code Quality": [
    "testCoverage",
    "cyclomaticComplexity",
    "duplication",
    "codeSmells",
    "codeQualityNote",
  ],
  QA: [
    "postProductionBugCount",
    "softwareDefectTotalBugCount",
    "defectRemovalEfficiency",
    "defectLeakageRatio",
    "regressionCount",
    "criticalCount",
    "majorCount",
    "minorCount",
    "bugSeverityTotalBugCount",
    "bsi",
    "qaNote",
  ],
} as const;

export type SectionName = keyof typeof SECTION_FIELDS;

export const ALL_SECTIONS = Object.keys(SECTION_FIELDS) as SectionName[];

/** True when at least one metric in the section carries a real value. */
export function sectionHasContent(detail: Qsr, section: SectionName): boolean {
  const record = detail as Record<string, unknown>;
  return SECTION_FIELDS[section].some((field) => {
    const value = record[field];
    return value !== null && value !== undefined && value !== "";
  });
}

export function personName(person: z.infer<typeof PersonSchema> | null | undefined): string | undefined {
  return person?.fullname ?? person?.fullName;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09" -> { year: 2026, monthName: "September" } */
export function parseMonth(month: string): { year: number; monthName: string } {
  const [yearPart, monthPart] = month.split("-");
  const index = Number(monthPart) - 1;
  const monthName = MONTH_NAMES[index];
  if (!monthName || !yearPart) throw new Error(`Invalid month "${month}", expected YYYY-MM`);
  return { year: Number(yearPart), monthName };
}

async function apiGet(session: VyagutaSession, path: string, context: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: sessionHeaders(session) });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Vyaguta rejected the session (${res.status}) on ${context}.\n` +
        `The token likely expired. Run: npm run session -- --refresh`,
    );
  }
  if (!res.ok) {
    throw new Error(`${context} failed: ${res.status} ${res.statusText} — ${path}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    // Usually means the request was bounced to an HTML login page.
    throw new Error(
      `${context} returned ${contentType || "unknown content"} instead of JSON — likely a ` +
        `redirect to login. Run: npm run setup`,
    );
  }
  return res.json();
}

const PAGE_SIZE = 40; // Hard server-side cap; larger values 400.

/** Fetches every project matching the given status IDs, following pagination. */
export async function fetchProjects(
  session: VyagutaSession,
  statusIds: number[] = [STATUS_IN_PROGRESS, STATUS_LEAD],
): Promise<Project[]> {
  const all: Project[] = [];
  let page = 1;
  let total = 0;

  for (;;) {
    const query =
      `statusIds=${statusIds.join(",")}&size=${PAGE_SIZE}&page=${page}` +
      `&sortBy=projectName&order=asc`;
    const body = await apiGet(session, `/api/teams/projects?${query}`, "project list");
    const parsed = z
      .object({
        data: z.array(ProjectSchema),
        meta: z.object({ total: z.number() }).passthrough().optional(),
      })
      .parse(body);

    total = parsed.meta?.total ?? parsed.data.length;
    all.push(...parsed.data);

    if (parsed.data.length === 0 || all.length >= total) break;
    page++;
    if (page > 50) break; // Paranoia: never loop forever on a misbehaving API.
  }

  if (all.length === 0) {
    throw new Error(
      "Vyaguta returned zero projects. Refusing to continue — an empty list would read as " +
        "full compliance.",
    );
  }
  return all;
}

/**
 * Fetches every QSR for a project. The endpoint ignores year/month filters, so callers filter
 * with `findQsrForMonth`.
 */
export async function fetchQsrs(session: VyagutaSession, projectId: number): Promise<Qsr[]> {
  const body = await apiGet(
    session,
    `/api/teams/qsrs?projectId=${projectId}`,
    `QSRs for project ${projectId}`,
  );
  return z.object({ data: z.array(QsrSchema) }).parse(body).data;
}

/** Number of sign-off flags set to true. */
function signOffCount(qsr: Qsr): number {
  return [qsr.engineeringMarkedAsDone, qsr.codeQualityMarkedAsDone, qsr.qaMarkedAsDone].filter(
    (flag) => flag === true,
  ).length;
}

function timestamp(qsr: Qsr): number {
  const raw = qsr.updatedAt ?? qsr.createdAt;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Finds the QSR for a month.
 *
 * A project can have several records for the same month — observed in production: SuperCare
 * Health has a PUBLISHED August report plus a later empty DRAFT, and Colla Health has two
 * near-identical drafts created a second apart. Taking the first match would report a
 * completed month as incomplete and nag someone who had already finished.
 *
 * So pick the most complete record: PUBLISHED beats DRAFT, then more sign-offs, then most
 * recently touched. This resolves ties toward "the work was done", which is the safe
 * direction — a missed reminder is recoverable, a false accusation is not.
 */
export function findQsrForMonth(qsrs: Qsr[], month: string): Qsr | undefined {
  const { year, monthName } = parseMonth(month);
  const candidates = qsrs.filter(
    (q) => q.year === year && q.month?.toLowerCase() === monthName.toLowerCase(),
  );
  if (candidates.length <= 1) return candidates[0];

  return candidates.reduce((best, candidate) => {
    const bestPublished = best.status?.toUpperCase() === "PUBLISHED";
    const candidatePublished = candidate.status?.toUpperCase() === "PUBLISHED";
    if (bestPublished !== candidatePublished) return candidatePublished ? candidate : best;

    const diff = signOffCount(candidate) - signOffCount(best);
    if (diff !== 0) return diff > 0 ? candidate : best;

    return timestamp(candidate) > timestamp(best) ? candidate : best;
  });
}

/** Fetches QSRs for many projects with bounded concurrency. */
export async function fetchQsrsForProjects(
  session: VyagutaSession,
  projectIds: number[],
  concurrency = 5,
): Promise<Map<number, Qsr[]>> {
  const result = new Map<number, Qsr[]>();
  const queue = [...projectIds];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      result.set(id, await fetchQsrs(session, id));
    }
  });

  await Promise.all(workers);
  return result;
}

/**
 * Fetches the full QSR record, including every metric field.
 *
 * The list endpoint returns only a summary; the per-section metrics that completeness is
 * actually judged on live here.
 */
export async function fetchQsrDetail(session: VyagutaSession, qsrId: number): Promise<Qsr> {
  const body = await apiGet(session, `/api/teams/qsrs/${qsrId}`, `QSR ${qsrId}`);
  // Unlike the list endpoints, this one returns the record unwrapped. Accept either shape so a
  // future change to add the envelope doesn't break the run.
  const unwrapped =
    body !== null && typeof body === "object" && "data" in body
      ? (body as { data: unknown }).data
      : body;
  return QsrSchema.parse(unwrapped);
}

/** Fetches details for many QSRs with bounded concurrency. */
export async function fetchQsrDetails(
  session: VyagutaSession,
  qsrIds: number[],
  concurrency = 5,
): Promise<Map<number, Qsr>> {
  const result = new Map<number, Qsr>();
  const queue = [...qsrIds];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      result.set(id, await fetchQsrDetail(session, id));
    }
  });
  await Promise.all(workers);
  return result;
}

/** Resolves a user's email from /api/core/users/:id. Only needed when a record lacks one. */
export async function fetchUserEmail(
  session: VyagutaSession,
  userId: number,
): Promise<string | undefined> {
  try {
    const body = await apiGet(session, `/api/core/users/${userId}`, `user ${userId}`);
    return z
      .object({ data: z.object({ email: z.string().optional() }).passthrough() })
      .parse(body).data.email;
  } catch {
    return undefined;
  }
}
