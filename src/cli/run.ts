/**
 * Monthly QSR compliance run.
 *
 *   npm start                                  # dry run, current month
 *   npm start -- --month 2026-09               # dry run, specific month
 *   npm start -- --only "Project Alpha"        # single project
 *   npm start -- --send                        # actually post to Slack
 *   npm start -- --force-login                 # discard cached Vyaguta session
 *
 * Dry run is the default. Sending requires the explicit --send flag.
 */
import { parseArgs } from "node:util";
import { loadProjects } from "../config.ts";
import { getSession } from "../auth.ts";
import { fetchProjects, fetchQsrEntries } from "../vyaguta.ts";
import { classify, summarize } from "../classify.ts";
import { rulesConfigured } from "../rules.ts";
import {
  createClient,
  groupByOwner,
  postChannel,
  renderDigest,
  renderMessage,
  resolveRecipients,
  sendDm,
  unassigned,
} from "../slack.ts";
import { printTable, writeDryRun } from "../report.ts";

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      month: { type: "string" },
      only: { type: "string", multiple: true },
      send: { type: "boolean", default: false },
      "force-login": { type: "boolean", default: false },
    },
  });

  const month = values.month ?? currentMonth();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`--month must be YYYY-MM, got "${month}"`);
  }
  const dryRun = !values.send;

  if (!rulesConfigured()) {
    console.warn(
      "\n  WARNING: no completeness rules are configured in src/rules.ts.\n" +
        "  Every existing QSR entry will be treated as FILLED regardless of content.\n",
    );
  }

  let configured = loadProjects();
  if (values.only && values.only.length > 0) {
    const wanted = new Set(values.only.map((n) => n.trim().toLowerCase()));
    configured = configured.filter((p) => wanted.has(p.name.trim().toLowerCase()));
    if (configured.length === 0) {
      throw new Error(`--only matched none of the projects in config/projects.json`);
    }
  }

  console.log(`QSR check for ${month} — ${configured.length} project(s)`);
  console.log(dryRun ? "Mode: DRY RUN (nothing will be sent)\n" : "Mode: SENDING TO SLACK\n");

  const session = await getSession({ forceLogin: values["force-login"] });

  const [projects, entries] = await Promise.all([
    fetchProjects(session),
    fetchQsrEntries(session, month),
  ]);
  console.log(`Fetched ${projects.length} projects, ${entries.length} QSR entries.\n`);

  const results = classify(configured, projects, entries);
  const counts = summarize(results);
  printTable(results);
  console.log(
    `\n${counts["FILLED"] ?? 0}/${results.length} complete · ` +
      Object.entries(counts)
        .filter(([status, n]) => status !== "FILLED" && n > 0)
        .map(([status, n]) => `${n} ${status.toLowerCase()}`)
        .join(" · "),
  );

  const grouped = groupByOwner(results);
  const client = createClient();
  if (!client && !dryRun) {
    throw new Error("SLACK_BOT_TOKEN is not set — cannot send. Copy .env.example to .env.");
  }

  const recipients = await resolveRecipients(client, grouped);
  const unassignedResults = unassigned(results);
  const summaryChannel = process.env["SLACK_SUMMARY_CHANNEL"];
  const digest = summaryChannel ? renderDigest(results, counts, month) : null;

  if (dryRun) {
    const path = writeDryRun({
      month,
      results,
      recipients,
      unassignedResults,
      digest,
      renderMessage: (recipient) => renderMessage(recipient, month),
    });
    console.log(`\nDry-run report written to ${path}`);
    console.log("Review it, then re-run with --send when the output looks right.");
    return;
  }

  const unresolved = recipients.filter((r) => !r.slackId);
  if (unresolved.length > 0) {
    throw new Error(
      `${unresolved.length} recipient(s) have no Slack account resolved ` +
        `(${unresolved.map((r) => r.email).join(", ")}). ` +
        `Patch out/slack-users.json by hand, then re-run.`,
    );
  }

  if (!client) throw new Error("unreachable: client checked above");

  for (const recipient of recipients) {
    if (!recipient.slackId) continue;
    await sendDm(client, recipient.slackId, renderMessage(recipient, month));
    console.log(`  sent -> ${recipient.email}`);
  }

  if (digest && summaryChannel) {
    await postChannel(client, summaryChannel, digest);
    console.log(`  digest -> ${summaryChannel}`);
  }

  console.log(`\nDone. ${recipients.length} reminder(s) sent.`);
  if (unassignedResults.length > 0) {
    console.log(
      `${unassignedResults.length} project(s) had no owner and were NOT reminded: ` +
        unassignedResults.map((r) => r.project?.name ?? r.configuredName).join(", "),
    );
  }
}

await main();
