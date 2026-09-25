/**
 * "Sign out other devices" must reach every other session, not just the first 100.
 *
 * Better Auth's `revokeOtherSessions` lists sessions through `findMany` with the adapter's default
 * limit of 100, so on its own it leaves the 101st and later sessions signed in — usually the
 * newest device. `buildAuthOptions()` finishes the job in an after-hook; this drives the real
 * endpoint with a real signed cookie against a user holding more than 100 sessions.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => {
    throw new Error("`cookies` was called outside a request scope.");
  },
}));

import { eq } from "drizzle-orm";
import { setDbForTests, writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import { session, user } from "@/db/schema";
import { testDb } from "../../helpers/db";

const BASE = "http://localhost:3010"; // must match VH_BASE_URL in tests/setup.ts
const PASSWORD = "correct-horse-battery-staple";

let handle: DbHandle;
let auth: { handler(request: Request): Promise<Response> };

async function post(endpoint: string, body: unknown, ip: string, cookie?: string): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "x-forwarded-for": ip,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function signIn(username: string, ip: string): Promise<{ cookie: string; token: string }> {
  const res = await post("/sign-in/username", { username, password: PASSWORD }, ip);
  expect(res.status).toBe(200);
  const pairs = res.headers.getSetCookie().map((c) => c.split(";")[0]!);
  const body = (await res.json()) as { token: string };
  return { cookie: pairs.join("; "), token: body.token };
}

function sessionTokens(userId: string): string[] {
  return handle.db.select({ token: session.token }).from(session).where(eq(session.userId, userId)).all().map((r) => r.token);
}

beforeAll(async () => {
  handle = testDb();
  setDbForTests(handle);
  const { getAuth } = await import("@/server/auth/auth");
  auth = getAuth() as unknown as typeof auth;
  const provisioning = await import("@/server/auth/provisioning");
  await provisioning.createUser({ username: "lucas", name: "Lucas", password: PASSWORD });
  await provisioning.createUser({ username: "marja", name: "Marja", password: PASSWORD });
});

afterAll(() => {
  setDbForTests(null);
  handle.close();
});

describe("revoke-other-sessions", () => {
  it("signs out every other session of the user, beyond the adapter's 100-row default", async () => {
    const lucasId = handle.db.select({ id: user.id }).from(user).where(eq(user.username, "lucas")).get()!.id;
    const marjaId = handle.db.select({ id: user.id }).from(user).where(eq(user.username, "marja")).get()!.id;

    // The device that will press the button signs in first, so it is inside the first 100 rows…
    const current = await signIn("lucas", "10.1.0.1");
    // …then 150 older-looking devices, and finally the newest real sign-in, row 152.
    const expiresAt = new Date(Date.now() + 86_400_000);
    writeTx(handle.db, (tx) => {
      for (let i = 0; i < 150; i++) {
        tx.insert(session).values({ id: newId(), userId: lucasId, token: `backlog-${i}`, expiresAt }).run();
      }
    });
    const newest = await signIn("lucas", "10.1.0.2");
    const otherUser = await signIn("marja", "10.1.0.3");
    expect(sessionTokens(lucasId)).toHaveLength(152);

    const res = await post("/revoke-other-sessions", {}, "10.1.0.1", current.cookie);
    expect(res.status).toBe(200);

    expect(sessionTokens(lucasId)).toEqual([current.token]);
    expect(sessionTokens(lucasId)).not.toContain(newest.token);
    // Another user's sessions are untouched.
    expect(sessionTokens(marjaId)).toEqual([otherUser.token]);
  });
});
