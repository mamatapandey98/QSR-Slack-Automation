/**
 * Inspect or refresh the saved Vyaguta credential, without running a full compliance check.
 *
 *   npm run session              # show what's cached
 *   npm run session -- --refresh # force a re-capture from the saved browser profile
 *   npm run session -- --print   # print the Authorization header (for curl/Postman)
 */
import { existsSync } from "node:fs";
import { PROFILE_DIR, SESSION_PATH } from "../config.ts";
import { describeSession, getSession, loadCachedSession } from "../auth.ts";
import { runCli } from "./shared.ts";

async function main(): Promise<void> {
  const refresh = process.argv.includes("--refresh");
  const print = process.argv.includes("--print");

  const profileState = existsSync(PROFILE_DIR) ? PROFILE_DIR : "none — run: npm run setup";
  console.log(`Profile      ${profileState}`);
  console.log(`Token cache  ${existsSync(SESSION_PATH) ? SESSION_PATH : "empty"}`);

  const cached = loadCachedSession();
  if (cached && !refresh) {
    console.log(`Status       valid (${describeSession(cached)})`);
    console.log(`Captured     ${cached.capturedAt}`);
    if (print && cached.authorization) console.log(`\n${cached.authorization}`);
    return;
  }

  if (!refresh) console.log("Status       stale or missing — refreshing…\n");

  const session = await getSession({ forceLogin: true });
  console.log(`Status       refreshed (${describeSession(session)})`);
  if (print && session.authorization) console.log(`\n${session.authorization}`);
}

await runCli(main);
