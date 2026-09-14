/**
 * Monthly QSR compliance run.
 *
 *   npm start                                  # dry run, previous month (the one now due)
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
import {
  fetchProjects,
  fetchQsrDetails,
  fetchQsrsForProjects,
  findQsrForMonth,
  type Qsr,
} from "../vyaguta.ts";
import { classify, findProject, summarize } from "../classify.ts";
import {
  createClient,
  groupByOwner,
  postChannel,
  renderAnnouncement,
  renderDigest,
  renderMessage,
  resolveRecipients,
  sendDm,
  unassigned,
} from "../slack.ts";
import { printTable, writeDryRun } from "../report.ts";
import {
  ROUND_DELIVERY,
  formatDate,
  reminderDate,
  roundDueOn,
  targetMonthFor,
  todayInNepal,
  type ReminderRound,
} from "../schedule.ts";
import { runCli } from "./shared.ts";

/**
 * The month a run defaults to: the *previous* one.
 *
 * A month's QSR is filled during the first week of the following month, so running in early
 * October should chase September. Defaulting to the current month would flag everyone as
 * missing a report that isn't due yet.
 */
function defaultMonth(): string {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      month: { type: "string" },
      only: { type: "string", multiple: true },
      send: { type: "boolean", default: false },
      reminder: { type: "string" },
      "if-due": { type: "boolean", default: false },
      "force-login": { type: "boolean", default: false },
    },
  });

  // --if-due: only act when today is actually a scheduled reminder day (used by the scheduler).
  const today = todayInNepal();
  const due = roundDueOn(today);
  if (values["if-due"]) {
    if (!due) {
      console.log(`${formatDate(today)} is not a reminder day — nothing to do.`);
      return;
    }
    console.log(`${formatDate(today)} is reminder round ${due.round} for ${due.targetMonth}.\n`);
  }

  const round: ReminderRound | undefined = values["if-due"]
    ? due?.round
    : values.reminder
      ? (Number(values.reminder) as ReminderRound)
      : undefined;

  if (round !== undefined && ![1, 2, 3].includes(round)) {
    throw new Error(`--reminder must be 1, 2 or 3, got "${values.reminder}"`);
  }

  const month =
    values.month ?? (values["if-due"] && due ? due.targetMonth : defaultMonth());
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`--month must be YYYY-MM, got "${month}"`);
  }
  const dryRun = !values.send;

  let configured = loadProjects();
  if (values.only && values.only.length > 0) {
    const wanted = new Set(values.only.map((n) => n.trim().toLowerCase()));
    configured = configured.filter((p) => wanted.has(p.name.trim().toLowerCase()));
    if (configured.length === 0) {
      throw new Error(`--only matched none of the projects in config/projects.json`);
    }
  }

  console.log(`QSR check for ${month} — ${configured.length} project(s)`);
  if (round) {
    console.log(
      `Reminder round ${round} (${ROUND_DELIVERY[round] === "channel" ? "channel announcement" : "personal DMs"})`,
    );
  }
  console.log(dryRun ? "Mode: DRY RUN (nothing will be sent)\n" : "Mode: SENDING TO SLACK\n");

  const session = await getSession({ forceLogin: values["force-login"] });

  const projects = await fetchProjects(session);
  console.log(`Fetched ${projects.length} projects from Vyaguta.`);

  // QSRs are per-project (the endpoint takes a projectId), so only fetch the ones we track.
  const matched = configured
    .map((cfg) => findProject(cfg, projects))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);

  const qsrLists = await fetchQsrsForProjects(session, matched.map((p) => p.id));

  // The list endpoint returns only summaries; completeness is judged on the metric values,
  // which live on the per-QSR detail record.
  const selected = new Map<number, Qsr>();
  for (const [projectId, list] of qsrLists) {
    const match = findQsrForMonth(list, month);
    if (match) selected.set(projectId, match);
  }
  const details = await fetchQsrDetails(session, [...selected.values()].map((q) => q.id));

  const qsrsByProject = new Map<number, Qsr | undefined>();
  for (const [projectId, summary] of selected) {
    qsrsByProject.set(projectId, details.get(summary.id) ?? summary);
  }
  console.log(
    `Checked ${matched.length} project(s); fetched metrics for ${details.size} QSR(s).\n`,
  );

  const results = classify(configured, projects, qsrsByProject);
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

  const unassignedResults = unassigned(results);
  const channel = process.env["SLACK_REMINDER_CHANNEL"];

  // Round 1 is a channel announcement naming nobody, so it needs no recipient lookup.
  const isAnnouncement = round === 1;
  const recipients = isAnnouncement ? [] : await resolveRecipients(client, grouped);

  const announcement = isAnnouncement
    ? renderAnnouncement(month, configured.length, formatDate(reminderDate(month, 3)))
    : null;

  const summaryChannel = process.env["SLACK_SUMMARY_CHANNEL"];
  const digest = !isAnnouncement && summaryChannel ? renderDigest(results, counts, month) : null;

  if (dryRun) {
    if (announcement) {
      console.log(`\nChannel announcement -> ${channel ?? "(SLACK_REMINDER_CHANNEL unset)"}:\n`);
      console.log(announcement);
    }
    const path = writeDryRun({
      month,
      results,
      recipients,
      unassignedResults,
      digest: announcement ?? digest,
      renderMessage: (recipient) => renderMessage(recipient, month, round),
    });
    console.log(`\nDry-run report written to ${path}`);
    console.log("Review it, then re-run with --send when the output looks right.");
    return;
  }

  // Round 1: one channel post, then done.
  if (announcement) {
    if (!channel) {
      throw new Error(
        "SLACK_REMINDER_CHANNEL is not set — round 1 posts to a channel. Set it in .env.",
      );
    }
    if (!client) throw new Error("unreachable: client checked above");
    await postChannel(client, channel, announcement);
    console.log(`\nAnnouncement posted to ${channel}.`);
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
    await sendDm(client, recipient.slackId, renderMessage(recipient, month, round));
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

await runCli(main);
