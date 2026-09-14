# QSR Slack Automation

Checks who has filled the monthly QSR report in Vyaguta and reminds the people who haven't.
Run by hand, once a month. Nothing is scheduled.

## Why the browser opens

Vyaguta is Google-SSO only, so there is no password to put in a config file. Vyaguta is also a
single-page app, which means the browser is already holding a credential and replaying it on
every API call — and anything the browser can send, a script can send.

So: Playwright opens a **visible** browser, you complete Google SSO yourself, and the script
reads the credential back off a real request. No password is stored, no Google login is
automated, and the authenticated session is cached in `.auth/` so repeat runs within its
lifetime don't prompt again.

This is a workaround and should be treated as one. It depends on undocumented internal
endpoints, and it runs under your personal identity. Tell the Vyaguta/platform team, and ask
whether a read-only service token exists — if one does, switch to it and this whole layer goes
away.

## Setup

```bash
npm install
npx playwright install chromium

cp .env.example .env                            # add SLACK_BOT_TOKEN when you have one
cp config/projects.example.json config/projects.json   # add your projects
```

Slack bot scopes needed: `chat:write`, `users:read`, `users:read.email`, and `im:write` if you
DM people.

## Step 1 — Discover the API (once)

```bash
npm run discover
```

A browser opens. Sign in, then click through: the filtered project list, the current month's
QSR report, one project that *is* filled and one that *isn't*, and a project detail page.
Press Enter in the terminal when done.

Writes `out/api-discovery.json` — every JSON endpoint the app called, with request headers
(tokens redacted) and response shapes. Use it to fill in `config/endpoints.json`: the real
paths, query params, and which field names hold project ID, name, production status, owner
email, and the QSR fields.

If discovery captures nothing, the QSR screen isn't an SPA calling JSON APIs and the data layer
needs reworking as DOM scraping.

## Step 2 — Write the completeness rules

Edit [`src/rules.ts`](src/rules.ts) — `REQUIRED_FIELDS` and `CROSS_CHECKS`. Until you do, the
script only distinguishes "an entry exists" from "it doesn't", and warns you on every run that
it's doing so.

## Step 3 — Dry run

```bash
npm start                        # current month
npm start -- --month 2026-09
npm start -- --only "Project Alpha"
```

Dry run is the default. Writes `out/dry-run-<month>.md` with the compliance table, every
recipient and their resolved Slack ID, and the exact text of every message that *would* be
sent. Nothing reaches Slack.

**Verify accuracy by hand before going further.** Pick five projects spanning filled, partial,
and missing, and compare against the Vyaguta UI.

## Step 4 — Send

```bash
npm start -- --only "Your Own Project" --send    # test on yourself first
npm start -- --send                              # then the real thing
```

`--send` refuses to run if any recipient has no Slack account resolved. Patch those by hand in
`out/slack-users.json` (email → Slack user ID) and re-run.

Set `SLACK_SUMMARY_CHANNEL` in `.env` to also post a compliance digest to a channel.

## Other flags

- `--force-login` — discard the cached Vyaguta session and sign in again.

## Failure modes this guards against

The worst outcome here is a silent "everyone is compliant" when really the API changed. So:

- An empty project list from Vyaguta is a hard error, never an empty report.
- A configured project not found in Vyaguta is `UNKNOWN`, never `FILLED`.
- An HTML response where JSON was expected (i.e. bounced to login) is a hard error.
- Projects needing a nudge but having no owner are reported separately, never dropped.

## Never commit

`.auth/`, `.env`, and `out/` are gitignored. `.auth/storageState.json` is a live credential and
`out/` holds real names and project data.
