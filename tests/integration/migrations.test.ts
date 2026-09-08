/**
 * The migrations themselves: they apply to an empty database, re-applying is a no-op, the pragma
 * set is what `src/db/client.ts` promises, and the resulting schema is snapshotted so an
 * accidental schema change shows up in a diff instead of in production.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type DbHandle } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { HOUSEHOLD_SETTING_ID } from "@/db/schema";
import { testDb } from "../helpers/db";

interface SchemaRow {
  type: string;
  name: string;
  sql: string | null;
}

function schemaObjects(handle: DbHandle): SchemaRow[] {
  return handle.sqlite
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'
        ORDER BY type, name`,
    )
    .all() as SchemaRow[];
}

describe("migrations", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = testDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("applies to an empty database", () => {
    const fresh = openDatabase(":memory:");
    try {
      const before = fresh.sqlite
        .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
        .get() as { n: number };
      expect(before.n).toBe(0);

      const result = runMigrations(fresh);
      expect(result.newlyApplied).toBeGreaterThan(0);
      expect(result.applied).toBe(result.newlyApplied);
      expect(schemaObjects(fresh).length).toBeGreaterThan(100);
    } finally {
      fresh.close();
    }
  });

  it("seeds the singletons exactly once", () => {
    const settings = handle.sqlite.prepare(`SELECT id, timezone FROM household_setting`).all() as {
      id: string;
      timezone: string;
    }[];
    expect(settings).toEqual([{ id: HOUSEHOLD_SETTING_ID, timezone: "Europe/Helsinki" }]);

    expect(handle.sqlite.prepare(`SELECT id, seq FROM event_cursor`).all()).toEqual([
      { id: 1, seq: 0 },
    ]);
    expect(handle.sqlite.prepare(`SELECT id FROM ha_connection_state`).all()).toEqual([
      { id: "ha" },
    ]);
    expect(handle.sqlite.prepare(`SELECT id, state FROM integration_status`).all()).toEqual([
      { id: "ha", state: "disconnected" },
    ]);
  });

  it("is a no-op when re-run", () => {
    const schemaBefore = schemaObjects(handle);
    const countsBefore = {
      migrations: (
        handle.sqlite.prepare(`SELECT count(*) AS n FROM __drizzle_migrations`).get() as {
          n: number;
        }
      ).n,
      settings: (
        handle.sqlite.prepare(`SELECT count(*) AS n FROM household_setting`).get() as { n: number }
      ).n,
    };

    const again = runMigrations(handle);
    expect(again.newlyApplied).toBe(0);
    expect(again.applied).toBe(countsBefore.migrations);
    expect(schemaObjects(handle)).toEqual(schemaBefore);
    expect(
      (handle.sqlite.prepare(`SELECT count(*) AS n FROM household_setting`).get() as { n: number })
        .n,
    ).toBe(countsBefore.settings);
  });

  it("applies the connection pragmas, including WAL on a file database", () => {
    // WAL is meaningless for ':memory:' (it reports "memory"), so this one needs a real file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-migrate-"));
    const file = openDatabase(path.join(dir, "db", "app.db"));
    try {
      runMigrations(file);
      expect(file.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(file.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(file.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(file.sqlite.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
    } finally {
      file.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enables foreign keys on the in-memory handle too", () => {
    expect(handle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("produces the expected schema", () => {
    expect(schemaObjects(handle)).toMatchSnapshot();
  });
});
