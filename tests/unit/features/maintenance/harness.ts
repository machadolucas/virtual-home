/**
 * Harness for the maintenance server-action tests.
 *
 * The actions run for real — the `action()` wrapper, zod validation, the idempotency store,
 * `writeTx`, and the domain functions underneath — against an in-memory database built by the
 * **real migrations**. Only three things are faked, each for a structural reason:
 *
 *  - `server-only` and `next/cache`, which exist only inside Next's bundler;
 *  - `@/server/auth/session`, because `action()` reads the session through it and a real Better
 *    Auth sign-in would be testing a different module;
 *  - `Date.now`, which is what `systemClock` reads, so "today" is a fixed household-local date
 *    rather than whenever the suite happens to run.
 *
 * `vi.mock` factories are hoisted, so a test file declares its own three-line mock block and the
 * session factory reaches back into `currentUser()` here (a dynamic import inside a factory runs
 * after the module graph is registered, which is why this works and a helper that *calls*
 * `vi.mock` would not).
 */
import { setDbForTests, type DbHandle } from "@/db/client";

let currentUserId = "unset";

/** Who the mocked session belongs to for the next action call. */
export function signIn(userId: string): void {
  currentUserId = userId;
}

export function currentUser(): string {
  return currentUserId;
}

export interface FrozenClock {
  set(atMs: number): void;
  advance(deltaMs: number): void;
  restore(): void;
  now(): number;
}

/** Pin `Date.now` to a fixed instant. */
export function freezeClock(atMs: number): FrozenClock {
  const real = Date.now;
  let current = atMs;
  Date.now = () => current;
  return {
    set(next) {
      current = next;
    },
    advance(deltaMs) {
      current += deltaMs;
    },
    restore() {
      Date.now = real;
    },
    now: () => current,
  };
}

/** Point `getDb()` at the test database. */
export function useTestDb(handle: DbHandle): void {
  setDbForTests(handle);
}

export function clearTestDb(): void {
  setDbForTests(null);
}

export type ActionOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; details?: unknown };

/** Unwrap an `ActionResult`, failing loudly with the server's own error code. */
export function expectOk<T>(result: ActionOutcome<T>): T {
  if (!result.ok) {
    throw new Error(`action failed: ${result.error} ${JSON.stringify(result.details ?? null)}`);
  }
  return result.data;
}

/** Assert the action failed, and hand the failure back for further assertions. */
export function expectFail<T>(result: ActionOutcome<T>): { error: string; details?: unknown } {
  if (result.ok) throw new Error("expected the action to fail, but it succeeded");
  return result;
}
