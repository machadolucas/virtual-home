/**
 * The authentication boundary (`docs/design-notes/auth-security-operations.md` §12.3, §3.4).
 *
 * `src/proxy.ts` only checks that a session cookie *exists*; the real boundary is
 * `requireSession()` inside `authed()` and every page. These tests exercise that boundary the way
 * an attacker would — by handing the handler headers, not by trusting a helper.
 *
 * `next/headers` is mocked because `requireSession()` reads the request headers from Next's async
 * store; the headers it returns are the ones a *real* sign-in through `auth.handler` produced, so
 * the cookies under test are genuine signed values rather than fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** Swapped per test; the `next/headers` mock reads this. */
let requestHeaders = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
  // `nextCookies()` mirrors set-cookie into Next's mutable cookie store after every endpoint.
  // Outside a request scope real Next throws exactly this, and Better Auth treats it as "no store
  // to write to" — so reproducing the message keeps the plugin on its documented path.
  cookies: async () => {
    throw new Error("`cookies` was called outside a request scope.");
  },
}));

import { betterAuth } from "better-auth";
import { desc, eq } from "drizzle-orm";
import { setDbForTests, type DbHandle } from "@/db/client";
import { session } from "@/db/schema";
import { testDb } from "../../helpers/db";

const BASE = "http://localhost:3010"; // must match VH_BASE_URL in tests/setup.ts
const PASSWORD = "correct-horse-battery-staple";

let handle: DbHandle;
let auth: Awaited<ReturnType<typeof getAuthModule>>;
/**
 * The same options with the origin check forced on.
 *
 * Better Auth 1.7.3 defaults `advanced.disableOriginCheck` to **true whenever `NODE_ENV === 'test'`**
 * (`context/create-context.mjs`), so the production behaviour cannot be observed through the plain
 * instance under Vitest. `buildAuthOptions()` deliberately never sets that flag, which is exactly
 * what keeps the check enabled in production — asserted below.
 */
let originAuth: AuthHandler;
let sessionModule: typeof import("@/server/auth/session");
let handlerModule: typeof import("@/server/api/handler");

async function getAuthModule() {
  const { getAuth } = await import("@/server/auth/auth");
  return getAuth();
}

/**
 * All these tests need of an auth instance is its HTTP handler.
 *
 * `buildAuthOptions()` is annotated as the widened `BetterAuthOptions`, so an instance built from
 * it loses the plugin-contributed shapes at the *type* level — `/sign-in/username`, the `username`
 * field on the session user — even though they are all there at runtime. The app reads those
 * fields defensively for the same reason (`src/app/(app)/layout.tsx`), and these two helpers are
 * where this test file says it once instead of casting in a dozen places.
 */
interface AuthHandler {
  handler(request: Request): Promise<Response>;
}

/** The username the session actually carries; the username plugin adds it. */
function usernameOf(user: unknown): string | null {
  if (typeof user !== "object" || user === null) return null;
  const value = (user as Record<string, unknown>)["username"];
  return typeof value === "string" ? value : null;
}

/** POST to a Better Auth endpoint with a distinct client IP so rate-limit buckets never collide. */
async function post(
  endpoint: string,
  body: unknown,
  extra: Record<string, string> = {},
  ip = "10.0.0.1",
  instance?: AuthHandler,
): Promise<Response> {
  return (instance ?? auth).handler(
    new Request(`${BASE}/api/auth${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "x-forwarded-for": ip,
        ...extra,
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Sign in for real and return the `Cookie` header a browser would send back. */
async function signInCookies(ip = "10.0.0.2"): Promise<{ all: string; tokenOnly: string }> {
  const res = await post("/sign-in/username", { username: "lucas", password: PASSWORD }, {}, ip);
  expect(res.status).toBe(200);
  const pairs = res.headers.getSetCookie().map((c) => c.split(";")[0]!);
  const tokenPair = pairs.find((p) => p.startsWith("vh.session_token="));
  expect(tokenPair).toBeDefined();
  return { all: pairs.join("; "), tokenOnly: tokenPair! };
}

beforeAll(async () => {
  handle = testDb();
  setDbForTests(handle);
  auth = await getAuthModule();
  sessionModule = await import("@/server/auth/session");
  handlerModule = await import("@/server/api/handler");
  const provisioning = await import("@/server/auth/provisioning");
  await provisioning.createUser({ username: "lucas", name: "Lucas", password: PASSWORD });

  const { buildAuthOptions } = await import("@/server/auth/auth");
  const options = buildAuthOptions();
  expect(options.advanced?.disableOriginCheck).toBeUndefined();
  originAuth = betterAuth({
    ...options,
    advanced: { ...options.advanced, disableOriginCheck: false },
  });
});

afterAll(() => {
  setDbForTests(null);
  handle.close();
});

beforeEach(() => {
  requestHeaders = new Headers();
});

/** A minimal protected route, wrapped exactly the way every real handler is. */
function protectedRoute() {
  return handlerModule.authed<undefined>(async (s) =>
    Response.json({ user: usernameOf(s.user) }, { status: 200 }),
  );
}

/** The same, but for a destructive operation: no cookie cache, ever. */
function freshRoute(): (req: Request) => Promise<Response> {
  return async () => {
    try {
      const s = await sessionModule.requireFreshSession();
      return Response.json({ user: usernameOf(s.user) }, { status: 200 });
    } catch (err) {
      if (err instanceof sessionModule.UnauthorizedError) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      throw err;
    }
  };
}

describe("authed()", () => {
  it("rejects a request with no cookie at all — 401 JSON, never a redirect", async () => {
    const res = await protectedRoute()(new Request(`${BASE}/api/thing`), undefined);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("accepts a genuine session cookie", async () => {
    const { all } = await signInCookies("10.0.0.3");
    requestHeaders = new Headers({ cookie: all });
    const res = await protectedRoute()(new Request(`${BASE}/api/thing`), undefined);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ user: "lucas" });
  });

  it("rejects a forged cookie — proving proxy.ts is not the boundary", async () => {
    // `getSessionCookie()` in proxy.ts would happily let this through: it checks presence only.
    requestHeaders = new Headers({ cookie: "vh.session_token=not-a-real-token.not-a-signature" });
    const res = await protectedRoute()(new Request(`${BASE}/api/thing`), undefined);
    expect(res.status).toBe(401);
  });

  it("rejects a session whose row has expired", async () => {
    const { tokenOnly } = await signInCookies("10.0.0.4");
    const row = handle.db.select().from(session).orderBy(desc(session.createdAt)).limit(1).get()!;
    handle.db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(session.id, row.id))
      .run();

    // Only the token cookie: the cached copy would otherwise answer from the cookie itself.
    requestHeaders = new Headers({ cookie: tokenOnly });
    const res = await protectedRoute()(new Request(`${BASE}/api/thing`), undefined);
    expect(res.status).toBe(401);
  });

  it("rejects a revoked session, and requireFreshSession does so without waiting for the cookie cache", async () => {
    const { all, tokenOnly } = await signInCookies("10.0.0.5");
    const row = handle.db.select().from(session).orderBy(desc(session.createdAt)).limit(1).get()!;
    handle.db.delete(session).where(eq(session.id, row.id)).run();

    // The whole cookie set includes the 60 s signed snapshot, which is exactly the documented
    // staleness window — so this is asserted as behaviour, not wished away.
    requestHeaders = new Headers({ cookie: all });
    expect(await freshRoute()(new Request(`${BASE}/api/danger`))).toMatchObject({ status: 401 });

    // Without the snapshot cookie there is nothing to be stale about: 401 immediately.
    requestHeaders = new Headers({ cookie: tokenOnly });
    const res = await protectedRoute()(new Request(`${BASE}/api/thing`), undefined);
    expect(res.status).toBe(401);
  });
});

describe("sign-in hardening", () => {
  it("rate-limits the sixth wrong password within the window", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await post(
        "/sign-in/username",
        { username: "lucas", password: "definitely-the-wrong-one" },
        {},
        "10.0.0.66", // one bucket, six attempts
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it("rejects a cross-origin sign-in that carries a cookie", async () => {
    const res = await post(
      "/sign-in/username",
      { username: "lucas", password: PASSWORD },
      { origin: "https://evil.example", cookie: "vh.session_token=whatever" },
      "10.0.0.7",
      originAuth,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "INVALID_ORIGIN" });
  });

  it("rejects a cross-origin sign-in on the email endpoint even without a cookie", async () => {
    const res = await post(
      "/sign-in/email",
      { email: "lucas@virtual-home.local", password: PASSWORD },
      { origin: "https://evil.example" },
      "10.0.0.8",
      originAuth,
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "INVALID_ORIGIN" });
  });

  it("accepts a same-origin sign-in with the origin check on", async () => {
    const res = await post(
      "/sign-in/username",
      { username: "lucas", password: PASSWORD },
      { origin: BASE, cookie: "vh.session_token=whatever" },
      "10.0.0.10",
      originAuth,
    );
    expect(res.status).toBe(200);
  });

  /**
   * Documented Better Auth 1.7.3 behaviour, asserted so a future version bump surfaces the change
   * rather than hiding it: the username plugin's `/sign-in/username` is covered by
   * `originCheckMiddleware`, which validates the `Origin` header **only when the request carries a
   * cookie**. `/sign-in/email` additionally has `formCsrfMiddleware`, which validates
   * unconditionally. In a browser the gap is closed by CORS (the attacker cannot read the
   * response) and by `sameSite: 'lax'` (the returned cookie is not attached to the attacker's
   * later cross-site requests), so no credential is obtained — but the asymmetry is real.
   */
  it("still accepts a cookie-less cross-origin call on /sign-in/username (upstream asymmetry)", async () => {
    const res = await post(
      "/sign-in/username",
      { username: "lucas", password: PASSWORD },
      { origin: "https://evil.example" },
      "10.0.0.9",
      originAuth,
    );
    expect(res.status).toBe(200);
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin relative paths", () => {
    expect(sessionModule.safeNextPath("/thing/123")).toBe("/thing/123");
    expect(sessionModule.safeNextPath("/settings/security?tab=sessions")).toBe(
      "/settings/security?tab=sessions",
    );
  });

  it("refuses protocol-relative and absolute URLs — the open-redirect vector in an HA link", () => {
    expect(sessionModule.safeNextPath("//evil.com")).toBe("/today");
    expect(sessionModule.safeNextPath("https://evil.com")).toBe("/today");
    expect(sessionModule.safeNextPath("http://localhost:3010/today")).toBe("/today");
    expect(sessionModule.safeNextPath("/\\evil.com")).toBe("/today");
    expect(sessionModule.safeNextPath("/x\r\nSet-Cookie: a=b")).toBe("/today");
    expect(sessionModule.safeNextPath(null)).toBe("/today");
    expect(sessionModule.safeNextPath("")).toBe("/today");
  });
});
