/**
 * `action()`'s replay store.
 *
 * A replay is a write that silently does not happen: the caller gets `{ok: true}` and a stored
 * payload, and nothing in the database changed. That is exactly right for a double-clicked button
 * and exactly wrong for anybody else's key, so the lookup is scoped to the signed-in user and to a
 * replay window rather than trusting the key to be unique on its own — the column is a bare primary
 * key, and a caller that derives a key from its own data (as the registry browser's bulk import
 * once did, from the first ~5 device ids) can collide across people and across days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ userId: { current: null as string | null } }));

// `server-only` is a build-time guard for the Next bundler; under Vitest its client entry throws.
vi.mock("server-only", () => ({}));

vi.mock("@/server/auth/session", () => {
  class UnauthorizedError extends Error {
    readonly status = 401 as const;
  }
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (mocks.userId.current === null) throw new UnauthorizedError();
      return { user: { id: mocks.userId.current }, session: { id: "test-session" } };
    },
  };
});

import { setDbForTests, writeTx, type DbHandle } from "@/db/client";
import { idempotencyKey } from "@/db/schema";
import { action } from "@/server/api/action";
import { seedUser, testDb } from "../../../helpers/db";

const input = z.object({ idempotencyKey: z.string().optional() });

let handle: DbHandle;
let lucas: string;
let anni: string;
/** How many times the wrapped body actually ran. A replay must not increment it. */
let runs: number;

const countingAction = action(input, () => {
  runs += 1;
  return { runs };
});

beforeEach(() => {
  handle = testDb();
  setDbForTests(handle);
  lucas = seedUser(handle, { username: "lucas", name: "Lucas" }).id;
  anni = seedUser(handle, { username: "anni", name: "Anni" }).id;
  runs = 0;
});

afterEach(() => {
  mocks.userId.current = null;
  handle.close();
});

describe("action() idempotency", () => {
  it("replays the same user's stored result instead of running twice", async () => {
    mocks.userId.current = lucas;

    const first = await countingAction({ idempotencyKey: "same-key" });
    const second = await countingAction({ idempotencyKey: "same-key" });

    expect(first).toEqual({ ok: true, data: { runs: 1 } });
    expect(second).toEqual(first);
    expect(runs).toBe(1);
  });

  it("does not answer one person's request with another person's stored result", async () => {
    mocks.userId.current = lucas;
    await countingAction({ idempotencyKey: "collides" });
    expect(runs).toBe(1);

    mocks.userId.current = anni;
    const result = await countingAction({ idempotencyKey: "collides" });

    // Before the scoping, this returned Lucas's stored `{runs: 1}` and Anni's mutation never ran —
    // reporting a success for a write that did not happen.
    expect(result).toEqual({ ok: true, data: { runs: 2 } });
    expect(runs).toBe(2);
  });

  it("stops replaying once the key is older than the replay window", async () => {
    mocks.userId.current = lucas;
    await countingAction({ idempotencyKey: "stale-key" });
    expect(runs).toBe(1);

    // The worker's housekeeping pass deletes these, but it only runs while the worker runs. Age the
    // row past the window to prove the wrapper does not depend on that pass.
    writeTx(handle.db, (tx) => {
      tx.update(idempotencyKey).set({ createdAtMs: Date.now() - 2 * 86_400_000 }).run();
    });

    const result = await countingAction({ idempotencyKey: "stale-key" });
    expect(result).toEqual({ ok: true, data: { runs: 2 } });
    expect(runs).toBe(2);
  });

  it("runs every time when no key is supplied", async () => {
    mocks.userId.current = lucas;
    await countingAction({});
    await countingAction({});
    expect(runs).toBe(2);
  });

  it("records the key against the user who used it", async () => {
    mocks.userId.current = anni;
    await countingAction({ idempotencyKey: "anni-key" });

    const stored = handle.db.select().from(idempotencyKey).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.userId).toBe(anni);
  });
});
