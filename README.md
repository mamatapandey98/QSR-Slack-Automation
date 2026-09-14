# QSR Slack Automation

Checks who has filled the monthly QSR report in Vyaguta and reminds the people who haven't.
Can be run by hand or scheduled via launchd to run automatically on reminder days.

## Why the browser opens

Vyaguta is Google-SSO only, so there is no password to put in a config file. Vyaguta is also a
single-page app, which means the browser is already holding a credential and replaying it on
every API call — and anything the browser can send, a script can send.

So: Playwright opens a **visible** browser, you complete Google SSO yourself, and the script
reads the credential back off a real request. No password is stored and no Google login is
automated — this only watches for the moment the app starts making authenticated calls.

Two things get saved in `.auth/`:

- `profile/` — a real Chrome user-data directory. A full profile rather than a serialized
  `storageState` because it keeps cookies, localStorage, IndexedDB and service-worker state,
  which is what actually makes a Google SSO session survive between runs.
- `session.json` — the captured `Authorization` header and its JWT expiry, so a re-run inside
  the token's lifetime skips the browser entirely.

It defaults to **real Chrome**, not Playwright's bundled Chromium, because Google frequently
refuses SSO in the latter with "this browser or app may not be secure".

This is a workaround and should be treated as one. It depends on undocumented internal
endpoints, and it runs under your personal identity. Tell the Vyaguta/platform team, and ask
whether a read-only service token exists — if one does, switch to it and this whole layer goes
away.

## Setup

```bash
npm install
cp .env.example .env                                   # add SLACK_BOT_TOKEN when you have one
cp config/projects.example.json config/projects.json   # add your projects
```

Real Chrome is used if installed (it is, on this machine). If it isn't, run
`npx playwright install chromium` for the fallback.

Slack bot scopes needed: `chat:write`, `users:read`, `users:read.email`, and `im:write` if you
DM people.

## Step 1 — Log in (once)

```bash
npm run setup
```

A Chrome window opens on Vyaguta. Sign in with Google. The window closes by itself the moment
an authenticated API call is observed, and prints what it captured.

```bash
npm run setup -- --reset    # wipe the profile and start over
```

Check or refresh the credential any time without doing a full run:

```bash
npm run session             # is it still valid, and for how long
npm run session -- --refresh
npm run session -- --print  # print the bearer token, for curl/Postman poking
```

Normal runs never prompt: they use the cached token, and fall back to loading the saved
profile headlessly. You only re-run `setup` when the profile itself goes stale — realistically
every few weeks.

## Step 2 — Discover the API (once)

```bash
npm run discover
```

The saved profile opens in a browser. Click through: the filtered project list, the current month's
QSR report, one project that *is* filled and one that *isn't*, and a project detail page.
Press Enter in the terminal when done.

Writes `out/api-discovery.json` — every JSON endpoint the app called, with request headers
(tokens redacted) and response shapes. The endpoints and schemas are integrated directly in
[`src/vyaguta.ts`](src/vyaguta.ts). You only need to re-run discovery if Vyaguta updates its API
in the future.

If discovery captures nothing, the QSR screen isn't an SPA calling JSON APIs and the data layer
needs reworking as DOM scraping.

## Step 3 — Completeness rules

Already written, in [`src/rules.ts`](src/rules.ts). A QSR counts as done when it is
`PUBLISHED` **and** all three sign-offs are true: `engineeringMarkedAsDone`,
`codeQualityMarkedAsDone`, `qaMarkedAsDone`. Anything else is `PARTIAL`, and the reminder names
the specific sections outstanding. No QSR for the month at all is `MISSING`.

## Step 4 — Dry run

```bash
npm start                        # defaults to LAST month — the one now due
npm start -- --month 2026-08
npm start -- --only "Laudio"
```

**On which month:** a month's QSR is filled during the first week of the *following* month, so
runs default to the previous month. Running on 14 Sep targets August. Checking September on
14 Sep would flag all 47 projects as missing a report that isn't due yet.

Dry run is the default. Writes `out/dry-run-<month>.md` with the compliance table, every
recipient and their resolved Slack ID, and the exact text of every message that *would* be
sent. Nothing reaches Slack.

**Verify accuracy by hand before going further.** Pick five projects spanning filled, partial,
and missing, and compare against the Vyaguta UI.

## Step 5 — Send

```bash
npm start -- --only "Your Own Project" --send    # test on yourself first
npm start -- --send                              # then the real thing
```

`--send` refuses to run if any recipient has no Slack account resolved. Patch those by hand in
`out/slack-users.json` (email → Slack user ID) and re-run.

Set `SLACK_SUMMARY_CHANNEL` in `.env` to also post a compliance digest to a channel.

## Reminder schedule

Three rounds per month, all at 10:00 NPT. They chase the *previous* month's QSR.

| Round | Day | Goes to | Content |
|---|---|---|---|
| 1 | 1st | `SLACK_REMINDER_CHANNEL` | Announcement that the QSR is due. Names nobody. |
| 2 | 5th | Personal DMs | Only people still outstanding, with their specific gap. |
| 3 | 10th | Personal DMs | Same, marked as the final reminder. |

If a date falls on a Saturday or Sunday it moves **forward to the next working day** — a round
due Sat 1 Aug goes out Mon 3 Aug. Nothing is skipped, and rounds can never overtake each other.

Round 1 deliberately names no one: on the 1st the month has only just ended and almost nothing
is filled, so a public roster would list nearly everyone. Naming starts at round 2, in private.

Run a round by hand:

```bash
npm start -- --reminder 1 --month 2026-08     # dry run of the announcement
npm start -- --reminder 3 --month 2026-08     # dry run of the final DMs
npm start -- --reminder 2 --send              # actually send round 2
```

### Automating it

```bash
./scripts/install-scheduler.sh
```

Installs a launchd job that runs **daily** at 10:00 local (the machine is on +0545, so that is
10:00 NPT). It passes `--if-due`, so the script itself decides whether today is a reminder day
and which round; on any other day it exits in seconds having done nothing. This keeps the
weekend rule in one place — launchd cannot express "next working day".

Caveat: this only fires when the laptop is awake and online. Logs go to `out/scheduler.log`.

```bash
launchctl list | grep qsr                 # check it is loaded
./scripts/install-scheduler.sh --uninstall
```

## Other flags

- `--force-login` — ignore the cached token and re-capture from the saved profile.
- `--debug` — show full stack traces instead of a one-line message.
- `--if-due` — do nothing unless today is a scheduled reminder day; used by the scheduler.
- `--reminder 1|2|3` — run a specific round.

## Failure modes this guards against

The worst outcome here is a silent "everyone is compliant" when really the API changed. So:

- An empty project list from Vyaguta is a hard error, never an empty report.
- A configured project not found in Vyaguta is `UNKNOWN`, never `FILLED`.
- An HTML response where JSON was expected (i.e. bounced to login) is a hard error.
- Projects needing a nudge but having no owner are reported separately, never dropped.

## Never commit

`.auth/`, `.env`, and `out/` are gitignored. `.auth/` is a live login — treat it like a
password. `out/` holds real names and project data.
