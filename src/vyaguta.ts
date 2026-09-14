import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { BASE_URL, REPO_ROOT } from "./config.ts";
import { sessionHeaders, type VyagutaSession } from "./auth.ts";

const EndpointSchema = z.object({
  path: z.string(),
  query: z.record(z.string()).default({}),
  fields: z.record(z.array(z.string())).default({}),
});

const EndpointsFileSchema = z.object({
  projects: EndpointSchema,
  qsr: EndpointSchema,
});

export type EndpointConfig = z.infer<typeof EndpointSchema>;

export function loadEndpoints(): z.infer<typeof EndpointsFileSchema> {
  const path = resolve(REPO_ROOT, "config/endpoints.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return EndpointsFileSchema.parse(raw);
}

/** A project as we care about it, normalized away from whatever Vyaguta calls its fields. */
export type Project = {
  id: string | undefined;
  name: string;
  status: string | undefined;
  inProduction: boolean | undefined;
  ownerEmail: string | undefined;
  ownerName: string | undefined;
  raw: Record<string, unknown>;
};

/** A QSR submission, normalized. `raw` is what the rules module actually inspects. */
export type QsrEntry = {
  projectId: string | undefined;
  projectName: string | undefined;
  submittedBy: string | undefined;
  submittedAt: string | undefined;
  raw: Record<string, unknown>;
};

/** Reads a dotted path like "owner.email" out of a record. */
function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** First candidate key that yields a non-empty value. */
function pick(record: Record<string, unknown>, candidates: string[] | undefined): unknown {
  for (const candidate of candidates ?? []) {
    const value = readPath(record, candidate);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Some APIs nest the human-readable value one level down, e.g. { id, name }.
  if (typeof value === "object") {
    const nested = (value as Record<string, unknown>)["name"];
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["true", "yes", "y", "1", "production", "prod", "live"].includes(lower)) return true;
    if (["false", "no", "n", "0"].includes(lower)) return false;
  }
  return undefined;
}

/**
 * Vyaguta-style APIs usually wrap payloads. Unwrap the common envelopes and return the array
 * we actually want. Throws loudly rather than returning [] — an empty result silently read as
 * "everyone is compliant" is the worst way this tool could fail.
 */
function unwrapList(body: unknown, context: string): Record<string, unknown>[] {
  const envelopes = ["data", "results", "content", "items", "rows"];
  let current = body;

  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(current)) {
      return current.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === "object",
      );
    }
    if (current === null || typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    const next = envelopes.map((key) => record[key]).find((v) => v !== undefined);
    if (next === undefined) break;
    current = next;
  }

  throw new Error(
    `Could not find a list in the ${context} response. Got: ` +
      `${JSON.stringify(body).slice(0, 400)}\n` +
      `Update config/endpoints.json, or the response envelope changed.`,
  );
}

function buildUrl(endpoint: EndpointConfig, vars: Record<string, string>): string {
  const substitute = (value: string): string =>
    value.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);

  const url = new URL(substitute(endpoint.path), BASE_URL);
  for (const [key, value] of Object.entries(endpoint.query)) {
    url.searchParams.set(key, substitute(value));
  }
  return url.toString();
}

async function apiGet(
  session: VyagutaSession,
  url: string,
  context: string,
): Promise<unknown> {
  const res = await fetch(url, { headers: sessionHeaders(session) });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Vyaguta rejected the session (${res.status}) on ${context}. The cached session likely ` +
        `expired — re-run with --force-login.`,
    );
  }
  if (!res.ok) {
    throw new Error(`${context} failed: ${res.status} ${res.statusText} for ${url}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    // Almost always means we were bounced to an HTML login page.
    throw new Error(
      `${context} returned ${contentType || "an unknown content type"} instead of JSON. ` +
        `This usually means the request was redirected to a login page. Try --force-login.`,
    );
  }
  return res.json();
}

export async function fetchProjects(session: VyagutaSession): Promise<Project[]> {
  const endpoint = loadEndpoints().projects;
  const url = buildUrl(endpoint, {});
  const body = await apiGet(session, url, "project list");
  const rows = unwrapList(body, "project list");

  if (rows.length === 0) {
    throw new Error(
      "Vyaguta returned zero projects. Refusing to continue — this would look like full " +
        "compliance. Check config/endpoints.json query filters.",
    );
  }

  return rows.map((row) => ({
    id: asString(pick(row, endpoint.fields["id"])),
    name: asString(pick(row, endpoint.fields["name"])) ?? "<unnamed>",
    status: asString(pick(row, endpoint.fields["status"])),
    inProduction: asBoolean(pick(row, endpoint.fields["inProduction"])),
    ownerEmail: asString(pick(row, endpoint.fields["ownerEmail"])),
    ownerName: asString(pick(row, endpoint.fields["ownerName"])),
    raw: row,
  }));
}

/** `month` is `YYYY-MM`. */
export async function fetchQsrEntries(
  session: VyagutaSession,
  month: string,
): Promise<QsrEntry[]> {
  const endpoint = loadEndpoints().qsr;
  const [year, monthPart] = month.split("-");
  const url = buildUrl(endpoint, {
    month: monthPart ?? "",
    year: year ?? "",
    yearMonth: month,
  });
  const body = await apiGet(session, url, `QSR entries for ${month}`);
  const rows = unwrapList(body, `QSR entries for ${month}`);

  return rows.map((row) => ({
    projectId: asString(pick(row, endpoint.fields["projectId"])),
    projectName: asString(pick(row, endpoint.fields["projectName"])),
    submittedBy: asString(pick(row, endpoint.fields["submittedBy"])),
    submittedAt: asString(pick(row, endpoint.fields["submittedAt"])),
    raw: row,
  }));
}
