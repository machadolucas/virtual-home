/**
 * Test database helpers.
 *
 * Every integration test builds its schema with the **real migrations** (never a hand-rolled
 * CREATE TABLE), so a test that passes is evidence the migration is correct too.
 */
import { openDatabase, writeTx, type DbHandle } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newId, nowMs } from "@/db/ids";
import { user } from "@/db/schema";

/**
 * Same domain as `SYNTHETIC_EMAIL_DOMAIN` in `src/server/auth/auth.ts`, duplicated on purpose:
 * importing that module would drag Better Auth and `server-only` into every test process.
 */
export const TEST_EMAIL_DOMAIN = "virtual-home.local";

/**
 * A fresh in-memory database with all migrations applied and the singletons seeded.
 *
 * Caller closes it (`handle.close()`), usually from `afterEach`.
 */
export function testDb(): DbHandle {
  const handle = openDatabase(":memory:");
  runMigrations(handle);
  return handle;
}

export interface SeedUserInput {
  id?: string;
  username: string;
  name: string;
}

export interface SeededUser {
  id: string;
  username: string;
  name: string;
  email: string;
}

/**
 * Insert a row straight into Better Auth's `user` table. Deliberately not going through Better
 * Auth: these tests are about the schema, and the household has no real email addresses — the
 * synthetic `<username>@virtual-home.local` matches what `vh-admin` creates.
 */
export function seedUser(handle: DbHandle, input: SeedUserInput): SeededUser {
  const row: SeededUser = {
    id: input.id ?? newId(),
    username: input.username,
    name: input.name,
    email: `${input.username}@${TEST_EMAIL_DOMAIN}`,
  };
  const at = new Date(nowMs());
  writeTx(handle.db, (tx) => {
    tx.insert(user)
      .values({
        id: row.id,
        name: row.name,
        email: row.email,
        emailVerified: true,
        username: row.username,
        displayUsername: row.username,
        createdAt: at,
        updatedAt: at,
      })
      .run();
  });
  return row;
}

/**
 * Run `fn` with `Date.now()` pinned to `atMs`. The callback receives an `advance` function so a
 * test can move the clock forward without nesting.
 *
 * A plain `Date.now` swap rather than `vi.useFakeTimers()`: better-sqlite3 is synchronous, so
 * there are no timers to fake, and faking them would only risk interfering with Vitest itself.
 * Domain code that needs a testable clock takes an injected `Clock` instead (`src/domain/time.ts`).
 */
export function withFakeNow<T>(atMs: number, fn: (advance: (deltaMs: number) => void) => T): T {
  const realNow = Date.now;
  let current = atMs;
  Date.now = () => current;
  try {
    return fn((deltaMs) => {
      current += deltaMs;
    });
  } finally {
    Date.now = realNow;
  }
}
