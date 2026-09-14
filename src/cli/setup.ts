/**
 * One-time (and occasional re-run) login.
 *
 *   npm run setup
 *
 * Opens a real browser, waits for you to sign in to Vyaguta with Google, then captures the
 * credential the app uses for its API calls and saves both the browser profile and the token.
 *
 * Nothing about the login is automated: you type your own password and 2FA into a real Chrome
 * window. This script only watches for the moment the app starts making authenticated calls.
 */
import { rmSync, existsSync } from "node:fs";
import {
  captureCredentials,
  describeSession,
  openProfile,
  primeSession,
  saveSession,
} from "../auth.ts";
import { BASE_URL, PROFILE_DIR, SESSION_PATH } from "../config.ts";
import { runCli } from "./shared.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  if (reset && existsSync(PROFILE_DIR)) {
    rmSync(PROFILE_DIR, { recursive: true, force: true });
    rmSync(SESSION_PATH, { force: true });
    console.log("Cleared the saved browser profile.\n");
  }

  console.log(`Opening a browser for ${BASE_URL}`);
  console.log("Sign in with Google. This window will close by itself once you're in.\n");

  const context = await openProfile({ headless: false });
  const capture = captureCredentials(context, LOGIN_TIMEOUT_MS);

  const landedOn = await primeSession(context);
  if (!landedOn.includes("accounts.google.com")) {
    console.log("  (If you were already signed in, this will finish in a moment.)\n");
  }

  const session = await capture;

  if (!session) {
    await context.close().catch(() => {});
    console.error(
      "\nDidn't capture an authenticated request.\n\n" +
        "Most likely causes:\n" +
        "  • the browser window was closed before signing in\n" +
        "  • login didn't complete within 10 minutes\n" +
        "  • Google blocked the sign-in as insecure — in that case make sure real Chrome is\n" +
        "    installed, and try `npm run setup -- --reset`\n",
    );
    process.exitCode = 1;
    return;
  }

  saveSession(session);
  await context.close().catch(() => {});

  console.log("\nSigned in.\n");
  console.log(`  Credential   ${describeSession(session)}`);
  console.log(`  Captured on  ${session.capturedFrom}`);
  console.log(`  Profile      ${PROFILE_DIR}`);
  console.log(`  Token cache  ${SESSION_PATH}`);

  if (!session.authorization) {
    console.log(
      "\n  Note: no Authorization header was seen, so Vyaguta appears to authenticate by\n" +
        "  cookie. That works the same way here — the cookies were saved.",
    );
  }

  console.log("\nBoth are gitignored. Never commit .auth/ — it is a live login.");
  console.log("\nNext:  npm run discover    (map the QSR API endpoints)");
}

await runCli(main);
