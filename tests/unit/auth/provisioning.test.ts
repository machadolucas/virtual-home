/**
 * The provisioning contract test (`docs/design-notes/auth-security-operations.md` §4.2).
 *
 * This is the test that makes the recovery design *safe*. `scripts/vh-admin.ts` creates accounts
 * and resets passwords through Better Auth's public endpoints, driven by a variant auth instance;
 * if a version bump ever changes how sign-up, the reset token, or session revocation behave, the
 * household would be locked out of its own house with no way back in short of editing the
 * database by hand. `better-auth` is pinned to an exact version and this test runs in CI, so such
 * a bump fails the build instead.
 *
 * Every assertion below is a promise the CLI makes to its user.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `server-only` is a build-time guard for the Next bundler; under Vitest its client entry throws.
vi.mock("server-only", () => ({}));

import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { setDbForTests, type DbHandle } from "@/db/client";
import { session, user } from "@/db/schema";
import { testDb } from "../../helpers/db";

const OLD_PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "a-different-long-passphrase";

let handle: DbHandle;
let provisioning: typeof import("@/server/auth/provisioning");
let web: ReturnType<typeof betterAuth>;

interface SignInResult {
  token?: string | null;
  user?: { username?: string | null } | null;
}

type SignInUsername = (args: {
  body: { username: string; password: string };
}) => Promise<SignInResult | null>;

/**
 * `/sign-in/username` through the typed API.
 *
 * `buildAuthOptions()` is annotated as the widened `BetterAuthOptions`, which is what keeps the
 * options factory readable and shareable — but it also erases the username plugin's endpoints from
 * the inferred `api` type. They exist at runtime (that is what the assertions below prove), so
 * this is the one place that says so, rather than a cast per call site.
 */
function signInUsername(instance: ReturnType<typeof betterAuth>): SignInUsername {
  const api = instance.api as unknown as { signInUsername: SignInUsername };
  return (args) => api.signInUsername(args);
}

beforeAll(async () => {
  handle = testDb();
  // `buildAuthOptions()` resolves `getDb()` eagerly, so the handle must be in place before any
  // auth instance is built — including the one `provisioning` builds per call.
  setDbForTests(handle);
  provisioning = await import("@/server/auth/provisioning");
  const { buildAuthOptions } = await import("@/server/auth/auth");
  // The *web* configuration: sign-up disabled, reset tokens dropped. Used to prove the variant
  // overrides never leak out of the CLI's process.
  web = betterAuth(buildAuthOptions());
});

afterAll(() => {
  setDbForTests(null);
  handle.close();
});

describe("createUser", () => {
  it("creates an account whose password signs in", async () => {
    const created = await provisioning.createUser({
      username: "lucas",
      name: "Lucas",
      password: OLD_PASSWORD,
      displayColor: "#3b6ea5",
    });
    expect(created.email).toBe("lucas@virtual-home.local");

    const signedIn = await signInUsername(web)({
      body: { username: "lucas", password: OLD_PASSWORD },
    });
    expect(signedIn?.token).toBeTruthy();
    expect(signedIn?.user?.username).toBe("lucas");
  });

  it("writes the fields the app reads: display name, colour and synthetic email", () => {
    const row = handle.db.select().from(user).where(eq(user.username, "lucas")).get();
    expect(row?.name).toBe("Lucas");
    expect(row?.displayColor).toBe("#3b6ea5");
    expect(row?.email).toBe("lucas@virtual-home.local");
  });

  it("leaves no session behind: a CLI run must not mint a usable credential", async () => {
    await provisioning.createUser({ username: "marja", name: "Marja", password: OLD_PASSWORD });
    const row = handle.db.select().from(user).where(eq(user.username, "marja")).get();
    const rows = handle.db.select().from(session).where(eq(session.userId, row!.id)).all();
    expect(rows).toHaveLength(0);
  });

  it("is idempotent-safe: a second create for the same username is refused, not duplicated", async () => {
    await expect(
      provisioning.createUser({ username: "lucas", name: "Lucas", password: OLD_PASSWORD }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses a password shorter than the configured minimum", async () => {
    await expect(
      provisioning.createUser({ username: "shorty", name: "Shorty", password: "tooshort" }),
    ).rejects.toThrow(/at least 12/);
  });

  it("refuses a username the login page could not round-trip", async () => {
    await expect(
      provisioning.createUser({ username: "a b", name: "Spacey", password: OLD_PASSWORD }),
    ).rejects.toThrow(/invalid username/);
  });
});

describe("setPassword", () => {
  it("replaces the password: the old one stops working and the new one starts", async () => {
    const result = await provisioning.setPassword("lucas", NEW_PASSWORD);
    expect(result.username).toBe("lucas");

    await expect(
      signInUsername(web)({ body: { username: "lucas", password: OLD_PASSWORD } }),
    ).rejects.toMatchObject({ body: { code: "INVALID_USERNAME_OR_PASSWORD" } });

    const signedIn = await signInUsername(web)({
      body: { username: "lucas", password: NEW_PASSWORD },
    });
    expect(signedIn?.token).toBeTruthy();
  });

  it("revokes every session that user had — a reset is a recovery action", async () => {
    const row = handle.db.select().from(user).where(eq(user.username, "lucas")).get()!;
    // Two live sessions, as if both a phone and a laptop were signed in.
    await signInUsername(web)({ body: { username: "lucas", password: NEW_PASSWORD } });
    await signInUsername(web)({ body: { username: "lucas", password: NEW_PASSWORD } });
    const before = handle.db.select().from(session).where(eq(session.userId, row.id)).all();
    expect(before.length).toBeGreaterThanOrEqual(2);

    const result = await provisioning.setPassword("lucas", OLD_PASSWORD);
    expect(result.revokedSessions).toBe(before.length);
    expect(handle.db.select().from(session).where(eq(session.userId, row.id)).all()).toHaveLength(0);
  });

  it("reports an unknown user rather than silently doing nothing", async () => {
    await expect(provisioning.setPassword("nobody", NEW_PASSWORD)).rejects.toThrow(/no such user/);
  });
});

describe("sessions", () => {
  it("revokeSessions('*') clears the whole table", async () => {
    await signInUsername(web)({ body: { username: "lucas", password: OLD_PASSWORD } });
    await signInUsername(web)({ body: { username: "marja", password: OLD_PASSWORD } });
    expect(handle.db.select().from(session).all().length).toBeGreaterThan(0);

    const revoked = provisioning.revokeSessions("*");
    expect(revoked).toBeGreaterThan(0);
    expect(handle.db.select().from(session).all()).toHaveLength(0);
  });

  it("revokeSessions(username) touches only that user", async () => {
    await signInUsername(web)({ body: { username: "lucas", password: OLD_PASSWORD } });
    await signInUsername(web)({ body: { username: "marja", password: OLD_PASSWORD } });

    expect(provisioning.revokeSessions("MARJA")).toBe(1); // case-insensitive on purpose
    const left = handle.db.select().from(session).all();
    expect(left).toHaveLength(1);
    const lucas = handle.db.select().from(user).where(eq(user.username, "lucas")).get()!;
    expect(left[0]?.userId).toBe(lucas.id);
  });

  it("pruneExpiredSessions deletes only rows past their expiry", async () => {
    const before = handle.db.select().from(session).all();
    expect(before).toHaveLength(1);

    // Nothing has expired yet.
    expect(provisioning.pruneExpiredSessions()).toBe(0);
    // Thirty-one days on, a 30-day session has.
    expect(provisioning.pruneExpiredSessions(Date.now() + 31 * 86_400_000)).toBe(1);
    expect(handle.db.select().from(session).all()).toHaveLength(0);
  });

  it("listUsers reports both accounts with their session counts", async () => {
    const users = provisioning.listUsers();
    expect(users.map((u) => u.username)).toEqual(["lucas", "marja"]);
    expect(users.every((u) => u.activeSessions === 0)).toBe(true);
    expect(users[0]?.email).toBe("lucas@virtual-home.local");
  });
});

describe("the variant overrides do not leak", () => {
  it("the web instance still refuses /api/auth/sign-up/email", async () => {
    const res = await web.handler(
      new Request("http://localhost:3010/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3010" },
        body: JSON.stringify({
          email: "intruder@virtual-home.local",
          password: "a-perfectly-long-password",
          name: "Intruder",
          username: "intruder",
        }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
    expect(handle.db.select().from(user).where(eq(user.username, "intruder")).get()).toBeUndefined();
  });

  it("the web instance never hands a reset token to a caller", async () => {
    // `sendResetPassword` on the web instance only logs; the response is deliberately the same
    // whether or not the address exists, and carries nothing usable.
    const result = await web.api.requestPasswordReset({
      body: { email: "lucas@virtual-home.local", redirectTo: "/login" },
    });
    expect(JSON.stringify(result)).not.toMatch(/token/i);
  });
});
