/**
 * Shared e2e helpers: the seeded household accounts and the sign-in flow.
 *
 * `tests/e2e/start-server.ts` imports the credentials from here and provisions exactly these two
 * accounts, so the passwords live in one place. Nothing here imports Playwright at runtime (only
 * its types), which is what lets the server bootstrap reuse this module.
 *
 * These are throwaway passwords for a throwaway data directory on 127.0.0.1. Real household
 * passwords never appear in this repository (CLAUDE.md rule 1).
 */
import { randomInt } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";

export interface E2eUser {
  username: string;
  name: string;
  password: string;
  /** `#rrggbb`; the login avatars use it. */
  displayColor: string;
}

export const E2E_USERS = {
  lucas: {
    username: "lucas",
    name: "Lucas",
    password: "e2e-lucas-passphrase",
    displayColor: "#3b6ea5",
  },
  marja: {
    username: "marja",
    name: "Marja",
    password: "e2e-marja-passphrase",
    displayColor: "#a5533b",
  },
} as const satisfies Record<string, E2eUser>;

export type E2eUserKey = keyof typeof E2E_USERS;

function resolveUser(who: E2eUserKey | E2eUser): E2eUser {
  return typeof who === "string" ? E2E_USERS[who] : who;
}

/**
 * A distinct, random client address per browser context.
 *
 * Sign-in is rate limited to 5 attempts per minute **per IP** (`buildAuthOptions`), and Better Auth
 * adds a default rule of its own — 3 requests per 10 s for `/sign-in`, `/sign-up`, `/change-password`
 * and `/change-email`, keyed by address **plus** path. Every request in this suite arrives from
 * 127.0.0.1, so without a per-context address a handful of tests would get 429s instead of
 * exercising what they are about. Better Auth reads the address from `x-forwarded-for`
 * (`advanced.ipAddress.ipAddressHeaders`), which is exactly what the reverse proxy sets in
 * production, so each context simply claims its own.
 *
 * Random, not a counter: Playwright runs each project in its own worker process, so a counter
 * restarts at 1 for the second project and hands out the very addresses the first one just used.
 * That is what made "changing the password retires the old one" fail on `phone` whenever both
 * projects ran in a single invocation — the two projects' four `/change-password` calls landed in
 * one 10 s window on one bucket (max 3), so the test's restore step was answered 429 and, this
 * file being `mode: "serial"`, the remaining tests never ran. Two runs a minute apart against a
 * reused server (`reuseExistingServer` is on outside CI) collided the same way.
 */
export function nextClientIp(): string {
  return `10.${randomInt(64, 128)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

/** Where `start-server.ts` put the app; the same expression `playwright.config.ts` uses. */
export function e2eBaseUrl(): string {
  return `http://127.0.0.1:${Number(process.env["VH_E2E_PORT"] ?? 3011)}`;
}

/**
 * A context with its own cookie jar and its own rate-limit bucket.
 *
 * `browser.newContext()` does not inherit the config's `use` options, so `baseURL` is passed
 * explicitly. That also means these contexts are viewport-neutral: the auth behaviour under test
 * is identical on both projects, and the phone project exercises the same assertions.
 */
export async function openContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: e2eBaseUrl(),
    extraHTTPHeaders: { "x-forwarded-for": nextClientIp() },
  });
}

export interface LoginOptions {
  /** Start at `/login?next=…` instead of `/login`, the way a deep link does. */
  next?: string;
  /** Where the app is expected to land afterwards. Defaults to `next ?? "/today"`. */
  expectPath?: string;
}

/**
 * Sign `who` in through the real login page: pick the avatar, type the password, submit.
 *
 * The avatar buttons are the primary path (`docs/design-notes/auth-security-operations.md` §3.7);
 * they set the hidden `username` field, which is why only the password is typed here.
 */
export async function login(
  page: Page,
  who: E2eUserKey | E2eUser,
  options: LoginOptions = {},
): Promise<void> {
  const user = resolveUser(who);
  const target = options.next
    ? `/login?next=${encodeURIComponent(options.next)}`
    : "/login";
  await page.goto(target);

  await page.getByRole("button", { name: user.name }).click();
  await page.locator('input[name="password"]').fill(user.password);
  // `exact`: the page also offers "Sign in as someone else".
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // The form does a full navigation on success, so the cookie is present on the very first
  // server render of the destination.
  const expected = options.expectPath ?? options.next ?? "/today";
  await page.waitForURL((url) => url.pathname === expected.split("?")[0], { timeout: 20_000 });
}

/** Sign in and hand back the page plus its context, for tests that need two live sessions. */
export async function loggedIn(
  browser: Browser,
  who: E2eUserKey | E2eUser,
  options: LoginOptions = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await openContext(browser);
  const page = await context.newPage();
  await login(page, who, options);
  return { context, page };
}
