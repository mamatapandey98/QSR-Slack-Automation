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
  INVALID: "needs correction",
  UNKNOWN: "could not be verified",
};

export function renderMessage(recipient: Recipient, month: string): string {
  const lines: string[] = [
    `Hi! A quick nudge about the *${month}* QSR report.`,
    "",
    `The following ${recipient.results.length === 1 ? "project needs" : "projects need"} your attention:`,
    "",
  ];

  for (const result of recipient.results) {
    const label = STATUS_LABEL[result.evaluation.status] ?? result.evaluation.status;
    const prodTag = result.inProduction ? " _(in production)_" : "";
    lines.push(`• *${result.project?.name ?? result.configuredName}* — ${label}${prodTag}`);
    for (const field of result.evaluation.missingFields) {
      lines.push(`    ◦ Missing: ${field}`);
    }
    for (const issue of result.evaluation.issues) {
      lines.push(`    ◦ ${issue}`);
    }
  }

  lines.push("", `Fill it in here: ${BASE_URL}/teams/projects/list`);
  lines.push("_Automated reminder. Reply here if something looks wrong._");
  return lines.join("\n");
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
  for (const status of ["MISSING", "PARTIAL", "INVALID", "UNKNOWN"]) {
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
