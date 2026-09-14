import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT_DIR } from "./config.ts";
import type { ProjectResult } from "./classify.ts";
import type { Recipient } from "./slack.ts";

export function printTable(results: ProjectResult[]): void {
  const rows = results.map((r) => ({
    Project: (r.project?.name ?? r.configuredName).slice(0, 40),
    Status: r.evaluation.status,
    Prod: r.inProduction === undefined ? "?" : r.inProduction ? "yes" : "no",
    Owner: r.ownerEmail ?? "—",
    Gaps: [...r.evaluation.missingFields, ...r.evaluation.issues].length || "",
  }));
  console.table(rows);
}

/**
 * Writes the full dry-run artifact: every message that would be sent, to whom, plus the
 * unresolved recipients. This is the thing to read before ever letting it send for real.
 */
export function writeDryRun(options: {
  month: string;
  results: ProjectResult[];
  recipients: Recipient[];
  unassignedResults: ProjectResult[];
  digest: string | null;
  renderMessage: (recipient: Recipient) => string;
}): string {
  const { month, results, recipients, unassignedResults, digest, renderMessage } = options;
  const lines: string[] = [
    `# QSR dry run — ${month}`,
    "",
    `Generated ${new Date().toISOString()}`,
    "",
    `**Nothing was sent to Slack.**`,
    "",
    "## Compliance",
    "",
    "| Project | Status | In prod | Owner |",
    "| --- | --- | --- | --- |",
  ];

  for (const r of results) {
    lines.push(
      `| ${r.project?.name ?? r.configuredName} | ${r.evaluation.status} | ` +
        `${r.inProduction === undefined ? "?" : r.inProduction ? "yes" : "no"} | ` +
        `${r.ownerEmail ?? "—"} |`,
    );
  }

  const unresolved = recipients.filter((r) => !r.slackId);
  lines.push("", "## Recipients", "");
  if (recipients.length === 0) {
    lines.push("_No reminders needed._");
  } else {
    lines.push("| Email | Slack ID | Projects |", "| --- | --- | --- |");
    for (const r of recipients) {
      lines.push(
        `| ${r.email} | ${r.slackId ?? "**UNRESOLVED**"} | ${r.results.length} |`,
      );
    }
  }

  if (unresolved.length > 0) {
    lines.push(
      "",
      `> ${unresolved.length} recipient(s) could not be matched to a Slack account.`,
      "> Patch them by hand in `out/slack-users.json` before sending for real.",
    );
  }

  if (unassignedResults.length > 0) {
    lines.push("", "## Projects with no owner to remind", "");
    for (const r of unassignedResults) {
      lines.push(`- ${r.project?.name ?? r.configuredName} (${r.evaluation.status})`);
    }
    lines.push("", "> These need manual follow-up, or an `ownerEmail` in `config/projects.json`.");
  }

  lines.push("", "## Messages that would be sent", "");
  for (const recipient of recipients) {
    lines.push(`### To: ${recipient.email} (${recipient.slackId ?? "UNRESOLVED"})`, "", "```");
    lines.push(renderMessage(recipient));
    lines.push("```", "");
  }

  if (digest) {
    lines.push("## Channel digest", "", "```", digest, "```", "");
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const path = resolve(OUT_DIR, `dry-run-${month}.md`);
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}
