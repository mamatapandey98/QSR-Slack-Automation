import { chromium, type BrowserContext, type Request } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BASE_URL, PROFILE_DIR, SESSION_PATH } from "./config.ts";

/**
 * Credentials lifted from a real authenticated browser session.
 *
 * Vyaguta is Google-SSO only, so there is no password to automate. It is also a single-page
 * app, which means the browser already holds whatever the API needs and replays it on every
 * XHR. We let a human complete SSO in a visible browser, then read the credential back off an
 * outgoing request. No password is ever entered or stored by this code.
 */
export type VyagutaSession = {
  /** Contents of the `Authorization` header, e.g. "Bearer eyJ...". Absent if auth is cookie-only. */
  authorization: string | undefined;
  /** Serialized cookie header for the Vyaguta origin. */
  cookie: string;
  /** Other headers seen on API calls that may be required (e.g. x-tenant-id). */
  extraHeaders: Record<string, string>;
  /** When the bearer token expires, if it is a JWT and says so. ISO string. */
  expiresAt: string | undefined;
  /** When this session was captured. ISO string. */
  capturedAt: string;
  /** URL of the request the credentials were captured from. Useful for debugging. */
  capturedFrom: string;
};

/** Connection- or browser-specific headers that must not be replayed. */
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

/** Headers worth carrying over, if Vyaguta sends them. */
const INTERESTING_HEADER_PREFIXES = ["x-", "accept"];

function isApiRequest(req: Request): boolean {
  if (!req.url().startsWith(BASE_URL)) return false;
  const type = req.resourceType();
  return type === "xhr" || type === "fetch";
}

/** Reads `exp` out of a JWT without verifying it — we only want the expiry for cache logic. */
function jwtExpiry(authorization: string | undefined): Date | undefined {
  if (!authorization) return undefined;
  const parts = authorization.replace(/^Bearer\s+/i, "").split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === "number" ? new Date(exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

export function saveSession(session: VyagutaSession): void {
  mkdirSync(dirname(SESSION_PATH), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), "utf8");
}

/** Returns the cached session only if it is still usable. */
export function loadCachedSession(): VyagutaSession | null {
  if (!existsSync(SESSION_PATH)) return null;
  try {
    const session = JSON.parse(readFileSync(SESSION_PATH, "utf8")) as VyagutaSession;
    if (session.expiresAt) {
      // 2-minute skew so we never hand out a token that dies mid-run.
      if (new Date(session.expiresAt).getTime() - Date.now() < 120_000) return null;
      return session;
    }
    // No expiry claim (cookie auth, or an opaque token). Trust it for an hour, then re-capture.
    return Date.now() - new Date(session.capturedAt).getTime() < 3_600_000 ? session : null;
  } catch {
    return null;
  }
}

export function describeSession(session: VyagutaSession): string {
  const kind = session.authorization ? "bearer token" : "cookie-only session";
  if (!session.expiresAt) return `${kind}, no expiry claim`;
  const minutes = Math.round((new Date(session.expiresAt).getTime() - Date.now()) / 60_000);
  return minutes > 0 ? `${kind}, expires in ${minutes} min` : `${kind}, expired`;
}

/**
 * Opens the saved browser profile.
 *
 * A persistent profile (a real Chrome user-data dir) rather than a serialized storageState:
 * it keeps cookies, localStorage, IndexedDB and service-worker state, which is what makes a
 * Google SSO session actually survive between runs.
 *
 * Defaults to real Chrome, because Google routinely refuses SSO in Playwright's bundled
 * Chromium with "this browser or app may not be secure".
 */
export async function openProfile(options: { headless: boolean }): Promise<BrowserContext> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const launch = (channel?: string) =>
    chromium.launchPersistentContext(PROFILE_DIR, {
      headless: options.headless,
      channel,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
    });

  try {
    return await launch("chrome");
  } catch {
    console.warn("  Real Chrome unavailable, falling back to bundled Chromium.");
    console.warn("  If Google blocks the login, install Chrome and retry.");
    return await launch();
  }
}

/**
 * Watches a context for the first credential-bearing API request.
 * Resolves `null` on timeout rather than rejecting, so callers decide what happens next.
 */
export function captureCredentials(
  context: BrowserContext,
  timeoutMs: number,
): Promise<VyagutaSession | null> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = async (req: Request | null): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.off("request", onRequest);
      if (!req) return resolve(null);

      let headers: Record<string, string>;
      try {
        headers = await req.allHeaders();
      } catch {
        return resolve(null); // Browser closed mid-capture.
      }

      const extraHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (IGNORED_HEADERS.has(lower)) continue;
        if (!INTERESTING_HEADER_PREFIXES.some((p) => lower.startsWith(p))) continue;
        extraHeaders[lower] = value;
      }

      const authorization = headers["authorization"];
      const cookies = await context.cookies(BASE_URL).catch(() => []);
      resolve({
        authorization,
        cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        extraHeaders,
        expiresAt: jwtExpiry(authorization)?.toISOString(),
        capturedAt: new Date().toISOString(),
        capturedFrom: req.url(),
      });
    };

    const onRequest = (req: Request): void => {
      if (isApiRequest(req) && req.headers()["authorization"]) void finish(req);
    };

    const timer = setTimeout(() => void finish(null), timeoutMs);
    context.on("request", onRequest);
    // If the human closes the window, stop waiting instead of hanging to the full timeout.
    context.once("close", () => void finish(null));
  });
}

/** Navigates to a page that reliably triggers API calls, ignoring nav errors. */
export async function primeSession(context: BrowserContext): Promise<string> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page
    .goto(`${BASE_URL}/teams/projects/list`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    .catch(() => {});
  return page.url();
}

/** Calls the Vyaguta refresh endpoint and returns a new access token, or null on failure. */
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/core/auth/access-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { accessToken?: string } };
    return body?.data?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds a session from VYAGUTA_ACCESS_TOKEN / VYAGUTA_REFRESH_TOKEN env vars.
 * If the access token is expired, uses the refresh token to obtain a new one automatically.
 * This is the preferred path: no browser, no Google login required.
 */
async function sessionFromEnvCookies(): Promise<VyagutaSession | null> {
  const accessToken = process.env.VYAGUTA_ACCESS_TOKEN?.trim();
  const refreshToken = process.env.VYAGUTA_REFRESH_TOKEN?.trim();
  if (!accessToken && !refreshToken) return null;

  let resolvedAccessToken = accessToken ?? "";
  const expiry = accessToken ? jwtExpiry(`Bearer ${accessToken}`) : undefined;
  const isExpired = !expiry || expiry.getTime() - Date.now() < 120_000;

  if (isExpired && refreshToken) {
    console.log("Access token expired — refreshing using VYAGUTA_REFRESH_TOKEN…");
    const newToken = await refreshAccessToken(refreshToken);
    if (newToken) {
      resolvedAccessToken = newToken;
      console.log("Access token refreshed successfully.");
    } else {
      console.warn(
        "Failed to refresh access token. Re-paste both tokens from DevTools and update .env.",
      );
      return null;
    }
  } else if (isExpired) {
    console.warn(
      "VYAGUTA_ACCESS_TOKEN is expired and no VYAGUTA_REFRESH_TOKEN is set.\n" +
        "Re-paste both tokens from DevTools (Application tab → Cookies) and update .env.",
    );
    return null;
  }

  const resolvedExpiry = jwtExpiry(`Bearer ${resolvedAccessToken}`);
  const cookieParts = [`access_token=${resolvedAccessToken}`];
  if (refreshToken) cookieParts.push(`refresh_token=${refreshToken}`);

  return {
    authorization: undefined,
    cookie: cookieParts.join("; "),
    extraHeaders: {},
    expiresAt: resolvedExpiry?.toISOString(),
    capturedAt: new Date().toISOString(),
    capturedFrom: "env:VYAGUTA_ACCESS_TOKEN",
  };
}

/**
 * Returns usable credentials, in order of preference:
 *   1. VYAGUTA_ACCESS_TOKEN / VYAGUTA_REFRESH_TOKEN env vars — no browser at all
 *   2. the cached token, if still valid — no browser at all
 *   3. a headless load of the saved profile — no interaction
 *   4. an error telling you to run `npm run setup`
 */
export async function getSession(
  options: { forceLogin?: boolean } = {},
): Promise<VyagutaSession> {
  const envSession = await sessionFromEnvCookies();
  if (envSession) {
    console.log(`Using cookie credentials from env (${describeSession(envSession)}).`);
    return envSession;
  }

  if (!options.forceLogin) {
    const cached = loadCachedSession();
    if (cached) {
      console.log(`Using cached session (${describeSession(cached)}).`);
      return cached;
    }
  }

  if (!existsSync(PROFILE_DIR)) {
    throw new Error(
      "No VYAGUTA_ACCESS_TOKEN in .env and no saved browser profile.\n" +
        "Either set VYAGUTA_ACCESS_TOKEN + VYAGUTA_REFRESH_TOKEN (see .env.example) or run `npm run setup`.",
    );
  }

  console.log("Cached token is stale — refreshing from the saved browser profile…");
  const context = await openProfile({ headless: true });
  try {
    const capture = captureCredentials(context, 30_000);
    await primeSession(context);
    const session = await capture;
    if (!session) {
      throw new Error(
        "The saved browser profile is no longer signed in to Vyaguta.\n" +
          "Either set VYAGUTA_ACCESS_TOKEN + VYAGUTA_REFRESH_TOKEN (see .env.example) or run `npm run setup` to sign in again.",
      );
    }
    saveSession(session);
    console.log(`Session refreshed (${describeSession(session)}).`);
    return session;
  } finally {
    await context.close().catch(() => {});
  }
}

/** Builds the header set to replay on plain `fetch` calls against the Vyaguta API. */
export function sessionHeaders(session: VyagutaSession): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", ...session.extraHeaders };
  if (session.authorization) headers["authorization"] = session.authorization;
  if (session.cookie) headers["cookie"] = session.cookie;
  return headers;
}
