import { chromium, type Browser, type BrowserContext, type Request } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BASE_URL, STORAGE_STATE_PATH } from "./config.ts";

/**
 * Credentials lifted from a real authenticated browser session.
 *
 * Vyaguta is an SPA, so the browser is already holding whatever the API needs and replaying it
 * on every XHR. We let a human complete Google SSO in a visible browser, then read the
 * credential back off an outgoing request. Nothing here guesses at or stores a password.
 */
export type VyagutaSession = {
  /** Contents of the `Authorization` header, e.g. "Bearer eyJ...". Absent if cookie-only auth. */
  authorization: string | undefined;
  /** Serialized cookie header for the Vyaguta origin. */
  cookie: string;
  /** Extra headers observed on API calls that may be required (e.g. x-tenant-id). */
  extraHeaders: Record<string, string>;
};

/** Headers we never want to replay — they are connection- or browser-specific. */
const IGNORED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "cookie",
  "authorization",
  "user-agent",
  "referer",
  "origin",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  ":authority",
  ":method",
  ":path",
  ":scheme",
]);

/** Headers worth carrying over, if Vyaguta sends them. Discovery will reveal any others. */
const INTERESTING_HEADER_PREFIXES = ["x-", "accept"];

function isApiRequest(req: Request): boolean {
  const url = req.url();
  if (!url.startsWith(BASE_URL)) return false;
  const type = req.resourceType();
  return type === "xhr" || type === "fetch";
}

function onLoginPage(url: string): boolean {
  return (
    url.includes("accounts.google.com") ||
    url.includes("/login") ||
    url.includes("/signin") ||
    url.includes("/auth")
  );
}

/**
 * Watches a context for the first API request carrying credentials and resolves with them.
 * Never rejects — resolves `null` on timeout so the caller can decide what to do next.
 */
function captureCredentials(
  context: BrowserContext,
  timeoutMs: number,
): Promise<VyagutaSession | null> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = async (req: Request | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.off("request", onRequest);

      if (!req) return resolve(null);

      const headers = await req.allHeaders();
      const extraHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (IGNORED_HEADERS.has(lower)) continue;
        if (!INTERESTING_HEADER_PREFIXES.some((p) => lower.startsWith(p))) continue;
        extraHeaders[lower] = value;
      }

      const cookies = await context.cookies(BASE_URL);
      resolve({
        authorization: headers["authorization"],
        cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        extraHeaders,
      });
    };

    const onRequest = (req: Request) => {
      if (!isApiRequest(req)) return;
      void finish(req);
    };

    const timer = setTimeout(() => void finish(null), timeoutMs);
    context.on("request", onRequest);
  });
}

async function saveState(context: BrowserContext): Promise<void> {
  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  await context.storageState({ path: STORAGE_STATE_PATH });
}

/**
 * Returns a usable Vyaguta session, prompting for an interactive Google login only when the
 * cached session has expired.
 *
 * Pass an already-open context via `onContext` if the caller wants to keep driving the browser
 * (the discover command does this); otherwise the browser is closed before returning.
 */
export async function getSession(options: {
  /** Force the visible-browser login flow even if a cached session exists. */
  forceLogin?: boolean;
  /** How long to wait for the human to finish Google SSO. */
  loginTimeoutMs?: number;
  /** Called with the authenticated context. If provided, the caller owns closing the browser. */
  onContext?: (context: BrowserContext, browser: Browser) => Promise<void>;
} = {}): Promise<VyagutaSession> {
  const { forceLogin = false, loginTimeoutMs = 5 * 60_000, onContext } = options;
  const hasCachedState = existsSync(STORAGE_STATE_PATH) && !forceLogin;

  // First attempt: reuse the cached session headlessly. Cheap, and the common case for a
  // re-run within the session's lifetime.
  if (hasCachedState) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/teams/projects/list`, { waitUntil: "domcontentloaded" });
      const session = await captureCredentials(context, 20_000);
      if (session && !onLoginPage(page.url())) {
        await saveState(context);
        if (onContext) {
          await onContext(context, browser);
        } else {
          await browser.close();
        }
        return session;
      }
      console.log("Cached Vyaguta session is stale — opening a browser for login.");
    } finally {
      if (!onContext) await browser.close().catch(() => {});
    }
  }

  // Interactive path: a visible browser, a real human, real Google SSO. No automation of the
  // credential entry itself — that is what keeps this both reliable and above board.
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(
    hasCachedState ? { storageState: STORAGE_STATE_PATH } : {},
  );

  const page = await context.newPage();
  const capture = captureCredentials(context, loginTimeoutMs);

  await page.goto(`${BASE_URL}/teams/projects/list`, { waitUntil: "domcontentloaded" });

  console.log("\n  A browser window has opened.");
  console.log("  Sign in to Vyaguta with Google, then wait — this will continue by itself.\n");

  const session = await capture;
  if (!session) {
    await browser.close().catch(() => {});
    throw new Error(
      `Timed out after ${Math.round(loginTimeoutMs / 1000)}s waiting for an authenticated ` +
        `Vyaguta request. Did the login complete?`,
    );
  }

  await saveState(context);
  console.log(`  Signed in. Session cached at ${STORAGE_STATE_PATH}\n`);

  if (onContext) {
    await onContext(context, browser);
  } else {
    await browser.close().catch(() => {});
  }
  return session;
}

/** Builds the header set to replay on plain `fetch` calls against the Vyaguta API. */
export function sessionHeaders(session: VyagutaSession): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...session.extraHeaders,
  };
  if (session.authorization) headers["authorization"] = session.authorization;
  if (session.cookie) headers["cookie"] = session.cookie;
  return headers;
}
