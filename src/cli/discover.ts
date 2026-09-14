/**
 * Endpoint discovery.
 *
 * Opens a visible browser, waits for you to sign in and click through to a QSR report, and
 * records every API call the app makes. Output is a sanitized JSON catalogue plus sample
 * response bodies — the spec from which src/vyaguta.ts gets written.
 *
 *   npm run discover
 *
 * Tokens are redacted before anything is written to disk, but out/ is gitignored anyway
 * because the captured responses still contain real names and project data.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import type { Response } from "playwright";
import { BASE_URL, OUT_DIR, PROFILE_DIR } from "../config.ts";
import { captureCredentials, openProfile, primeSession, saveSession } from "../auth.ts";
import { runCli } from "./shared.ts";

type CapturedCall = {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  status: number;
  requestHeaders: Record<string, string>;
  /** Shape summary of the response, so you can scan structure without reading everything. */
  responseShape: unknown;
  responseSample: unknown;
};

const SENSITIVE_HEADERS = ["authorization", "cookie", "x-csrf-token", "x-xsrf-token"];

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.includes(key.toLowerCase()) ? "<redacted>" : value;
  }
  return out;
}

/**
 * Collapses a JSON value into a description of its structure: objects keep their keys but
 * swap values for type names, arrays collapse to a single representative element. Makes a
 * 400-row response readable at a glance.
 */
function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeOf(value[0], depth + 1), `…${value.length} items`];
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = shapeOf(inner, depth + 1);
    }
    return out;
  }
  return typeof value;
}

/** Keeps a sample small enough to read: first 2 elements of any array. */
function trimSample(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.slice(0, 2).map((v) => trimSample(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = trimSample(inner, depth + 1);
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  const calls: CapturedCall[] = [];
  const seen = new Set<string>();

  if (!existsSync(PROFILE_DIR)) {
    throw new Error("No saved browser profile. Run `npm run setup` first.");
  }

  // Visible browser, using the already-signed-in profile: you click, we record.
  const context = await openProfile({ headless: false });

  const onResponse = async (res: Response): Promise<void> => {
    const req = res.request();
    const url = res.url();
    if (!url.startsWith(BASE_URL)) return;
    const type = req.resourceType();
    if (type !== "xhr" && type !== "fetch") return;

    const contentType = (await res.headerValue("content-type").catch(() => "")) ?? "";
    if (!contentType.includes("json")) return;

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return; // Body already consumed or not parseable — nothing useful to record.
    }

    const parsed = new URL(url);
    // Dedupe on method + path so clicking through 10 projects does not yield 10 entries.
    const key = `${req.method()} ${parsed.pathname}`;
    if (seen.has(key)) return;
    seen.add(key);

    calls.push({
      method: req.method(),
      url,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      status: res.status(),
      requestHeaders: redactHeaders(await req.allHeaders().catch(() => ({}))),
      responseShape: shapeOf(body),
      responseSample: trimSample(body),
    });
    console.log(`  captured  ${key}`);
  };

  context.on("response", (res) => void onResponse(res));

  // Opportunistically refresh the cached token while we are here.
  const capture = captureCredentials(context, 60_000);
  await primeSession(context);
  void capture.then((session) => {
    if (session) saveSession(session);
  });

  console.log("Recording API calls. In the browser window, please:");
  console.log("  1. Open the projects list you filter by (statusIds=4,5).");
  console.log("  2. Open the QSR report for the current month.");
  console.log("  3. Open one project that IS filled, and one that is NOT.");
  console.log("  4. Open a project detail page so we can see the owner/manager fields.\n");

  // Finish on whichever comes first: Enter in the terminal, or the browser window being
  // closed. The close path matters when this runs without an attached TTY.
  const closed = new Promise<void>((resolve) => context.once("close", () => resolve()));

  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("Close the browser window when you're done (or press Enter here).\n");
    await Promise.race([rl.question(""), closed]);
    rl.close();
  } else {
    console.log("Close the browser window when you're done clicking around.\n");
    await closed;
  }

  await context.close().catch(() => {});

  mkdirSync(OUT_DIR, { recursive: true });
  const target = resolve(OUT_DIR, "api-discovery.json");
  writeFileSync(target, JSON.stringify({ baseUrl: BASE_URL, calls }, null, 2), "utf8");

  console.log(`\nCaptured ${calls.length} distinct endpoints -> ${target}`);
  if (calls.length === 0) {
    console.log(
      "\nNothing captured. If the QSR screen is server-rendered rather than an SPA calling\n" +
        "JSON APIs, we fall back to DOM scraping — say so and I'll rework the data layer.",
    );
  }
}

await runCli(main);
