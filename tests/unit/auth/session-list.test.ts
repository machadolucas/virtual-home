/**
 * Settings -> Security lists every active session, not just the first 100.
 *
 * Better Auth 1.7.5's `listSessions` reads through `findMany` with the adapter's default limit of
 * 100, so the page used to show a user with more sessions only the oldest 100, usually without the
 * device in hand. The page now reads `listActiveSessions`; this holds it to the same filters the
 * endpoint applied (unexpired, not impersonated, own user) with more than 100 rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import { session } from "@/db/schema";
import { listActiveSessions } from "@/server/queries/settings/sessions";
import { seedUser, testDb } from "../../helpers/db";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const DAY = 86_400_000;

let handle: DbHandle;

beforeEach(() => {
  handle = testDb();
});

afterEach(() => {
  handle.close();
});

function addSession(
  userId: string,
  token: string,
  createdMs: number,
  extra: { expiresMs?: number; impersonatedBy?: string; userAgent?: string } = {},
): void {
  writeTx(handle.db, (tx) =>
    tx
      .insert(session)
      .values({
        id: newId(),
        userId,
        token,
        createdAt: new Date(createdMs),
        updatedAt: new Date(createdMs),
        expiresAt: new Date(extra.expiresMs ?? createdMs + 30 * DAY),
        userAgent: extra.userAgent ?? null,
        impersonatedBy: extra.impersonatedBy ?? null,
      })
      .run(),
  );
}

describe("listActiveSessions", () => {
  it("returns every active session past the adapter's 100-row default, current first then newest", () => {
    const lucas = seedUser(handle, { username: "lucas", name: "Lucas" });
    const marja = seedUser(handle, { username: "marja", name: "Marja" });

    // The device in hand is the oldest row, so a "first 100 by rowid" read would put it last of
    // 152 — and a "newest 100" read would drop it.
    addSession(lucas.id, "current", NOW - 20 * DAY);
    for (let i = 0; i < 150; i++) addSession(lucas.id, `backlog-${i}`, NOW - 10 * DAY + i * 60_000);
    addSession(lucas.id, "newest", NOW - 1000, { userAgent: "Mozilla/5.0 (iPhone)" });
    // None of these belong in the list.
    addSession(lucas.id, "expired", NOW - 40 * DAY, { expiresMs: NOW - 1 });
    addSession(lucas.id, "impersonation", NOW - 500, { impersonatedBy: marja.id });
    addSession(marja.id, "other-user", NOW - 100);

    const rows = listActiveSessions(handle.db, lucas.id, "current", NOW);

    expect(rows).toHaveLength(152);
    expect(rows[0]).toMatchObject({ token: "current", current: true });
    expect(rows[1]).toMatchObject({ token: "newest", current: false, userAgent: "Mozilla/5.0 (iPhone)" });
    expect(rows.at(-1)?.token).toBe("backlog-0");
    expect(rows.filter((row) => row.current)).toHaveLength(1);

    const rest = rows.slice(1).map((row) => row.createdMs);
    expect(rest).toEqual([...rest].sort((a, b) => b - a));

    const tokens = new Set(rows.map((row) => row.token));
    expect(tokens.has("expired")).toBe(false);
    expect(tokens.has("impersonation")).toBe(false);
    expect(tokens.has("other-user")).toBe(false);
  });

  it("treats a session expiring exactly now as gone", () => {
    const lucas = seedUser(handle, { username: "lucas", name: "Lucas" });
    addSession(lucas.id, "current", NOW - DAY);
    addSession(lucas.id, "edge", NOW - DAY, { expiresMs: NOW });

    expect(listActiveSessions(handle.db, lucas.id, "current", NOW).map((row) => row.token)).toEqual(["current"]);
  });
});
