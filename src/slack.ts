import { WebClient } from "@slack/web-api";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BASE_URL, OUT_DIR } from "./config.ts";
import type { ProjectResult } from "./classify.ts";

/**
 * Cached email -> Slack user ID map. Lets you hand-patch the people `users.lookupByEmail`
 * cannot resolve (contractors, differing emails) instead of fighting the API every run.
 */
const USER_MAP_PATH = resolve(OUT_DIR, "slack-users.json");

type UserMap = Record<string, string | null>;

function loadUserMap(): UserMap {
  if (!existsSync(USER_MAP_PATH)) return {};
  return JSON.parse(readFileSync(USER_MAP_PATH, "utf8")) as UserMap;
}

function saveUserMap(map: UserMap): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(USER_MAP_PATH, JSON.stringify(map, null, 2), "utf8");
}

export type Recipient = {
  email: string;
  slackId: string | null;
  results: ProjectResult[];
};

/** Groups reminder-worthy results by the person responsible. */
export function groupByOwner(results: ProjectResult[]): Map<string, ProjectResult[]> {
  const grouped = new Map<string, ProjectResult[]>();
  for (const result of results) {
    if (!result.needsReminder) continue;
    const email = result.ownerEmail;
    if (!email) continue; // Reported separately as unassigned — never silently dropped.
    const existing = grouped.get(email) ?? [];
    existing.push(result);
    grouped.set(email, existing);
  }
  return grouped;
}

/** Results that need a nudge but have nobody to nudge. These need manual follow-up. */
export function unassigned(results: ProjectResult[]): ProjectResult[] {
  return results.filter((r) => r.needsReminder && !r.ownerEmail);
}

export async function resolveRecipients(
  client: WebClient | null,
  grouped: Map<string, ProjectResult[]>,
): Promise<Recipient[]> {
  const map = loadUserMap();
  const recipients: Recipient[] = [];

  for (const [email, results] of grouped) {
    if (!(email in map) && client) {
      try {
        const res = await client.users.lookupByEmail({ email });
        map[email] = res.user?.id ?? null;
      } catch {
        // Most often users_not_found. Record the miss so it shows in the report and can be
        // fixed by hand in out/slack-users.json.
        map[email] = null;
      }
    }
    recipients.push({ email, slackId: map[email] ?? null, results });
  }

  saveUserMap(map);
  return recipients;
}

const STATUS_LABEL: Record<string, string> = {
  MISSING: "not filled",
  PARTIAL: "incomplete",
  UNKNOWN: "could not be verified",
};

/** "2026-08" -> "August 2026", which reads better in a message than an ISO month. */
function friendlyMonth(month: string): string {
  const [year, monthPart] = month.split("-");
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[Number(monthPart) - 1] ?? month} ${year}`;
}

/** Headline and follow-up detail for one project, chosen by why it is incomplete. */
function describe(result: ProjectResult): { headline: string; detail: string[] } {
  const { reason, pendingSections, missingFields } = result.evaluation;
  switch (reason) {
    case "NOT_STARTED":
      return { headline: "not started", detail: ["Could you create and publish it?"] };
    case "DRAFT_UNPUBLISHED":
      return {
        headline: "draft, not published",
        detail: ["Everything is marked done — it just needs publishing."],
      };
    case "DRAFT_SECTIONS_PENDING":
      return {
        headline: "still a draft",
        detail: [`Still to be marked done: ${pendingSections.join(", ")}`],
      };
    case "PUBLISHED_DATA_MISSING":
      return {
        headline: "published, but some metrics are empty",
        detail: [`Empty: ${missingFields.join(", ")}`],
      };
    default:
      return { headline: STATUS_LABEL[result.evaluation.status] ?? "needs attention", detail: [] };
  }
}

/**
 * Round 1: a channel announcement on the 1st.
 *
 * Deliberately names nobody. The month has only just ended and almost nothing is filled yet,
 * so a roster on day one would list nearly everyone and read as an accusation rather than a
 * heads-up. Naming starts at round 2, and only in private DMs.
 */
export function renderAnnouncement(
  month: string,
  projectCount: number,
  deadline: string,
): string {
  return [
    `:calendar: *${friendlyMonth(month)} QSR is now due.*`,
    "",
    `Please complete and *publish* the QSR for your project — ${projectCount} projects are ` +
      `expected this month.`,
    `Final reminder goes out on *${deadline}*.`,
    "",
    `${BASE_URL}/teams/projects/list`,
    "_Automated reminder. Reply here if something looks wrong._",
  ].join("\n");
}

export function renderMessage(
  recipient: Recipient,
  month: string,
  round?: 1 | 2 | 3,
): string {
  const when = friendlyMonth(month);
  const lines: string[] = [];

  if (recipient.results.length === 1) {
    // Single project reads better as a sentence than as a one-item bullet list.
    const result = recipient.results[0];
    if (!result) return "";
    const { headline, detail } = describe(result);
    const name = result.project?.name.trim() ?? result.configuredName;
    const prodTag = result.inProduction ? " (in production)" : "";
    lines.push(`Hi! The *${when}* QSR for *${name}*${prodTag} is ${headline}.`, "");
    lines.push(...detail);
  } else {
    lines.push(`Hi! A few things on the *${when}* QSR:`, "");
    for (const result of recipient.results) {
      const { headline, detail } = describe(result);
      const name = result.project?.name.trim() ?? result.configuredName;
      const prodTag = result.inProduction ? " (in production)" : "";
      lines.push(`*${name}*${prodTag} — ${headline}`);
      for (const line of detail) lines.push(`    ${line}`);
      lines.push("");
    }
  }

  // Round 3 is the last nudge before the window closes, so say so plainly.
  if (round === 3) {
    lines.push("", "_This is the final reminder for this month._");
  }

  lines.push("", `${BASE_URL}/teams/projects/list`);
  lines.push("_Automated reminder. Reply here if something looks wrong._");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function renderDigest(
  results: ProjectResult[],
  counts: Record<string, number>,
  month: string,
): string {
  const total = results.length;
  const lines = [
    `*QSR compliance — ${month}*`,
    `${counts["FILLED"] ?? 0}/${total} projects complete.`,
    "",
  ];
  for (const status of ["MISSING", "PARTIAL", "UNKNOWN"]) {
    const matching = results.filter((r) => r.evaluation.status === status);
    if (matching.length === 0) continue;
    lines.push(`*${STATUS_LABEL[status] ?? status}* (${matching.length}):`);
    for (const r of matching) {
      lines.push(`  • ${r.project?.name ?? r.configuredName}${r.ownerEmail ? ` — ${r.ownerEmail}` : " — _no owner found_"}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function createClient(): WebClient | null {
  const token = process.env["SLACK_BOT_TOKEN"];
  return token ? new WebClient(token) : null;
}

export async function sendDm(
  client: WebClient,
  slackId: string,
  text: string,
): Promise<void> {
  await client.chat.postMessage({ channel: slackId, text });
}

export async function postChannel(
  client: WebClient,
  channel: string,
  text: string,
): Promise<void> {
  await client.chat.postMessage({ channel, text });
}
