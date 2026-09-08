/**
 * The worker's startup guard.
 *
 * **The worker never migrates.** `pnpm db:migrate` (production: `scripts/update.sh`) owns the
 * schema, because two processes racing to apply migrations at boot is how a database gets
 * corrupted. So the worker's only job here is to notice that the journal on disk is ahead of the
 * database and refuse to start — writing rows against a schema it does not understand is worse
 * than being down, and being down is visible on `/settings/system`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "@/db/client";
import { resolveMigrationsFolder } from "@/db/migrate";
import {
  PendingMigrationsError,
  assertSchemaUpToDate,
  createWorkerId,
  migrationState,
} from "@/worker/index";
import { testDb } from "../../helpers/db";

let handles: DbHandle[] = [];
let tempDirs: string[] = [];

afterEach(() => {
  for (const handle of handles) handle.close();
  handles = [];
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function keep(handle: DbHandle): DbHandle {
  handles.push(handle);
  return handle;
}

/** A `drizzle/`-shaped folder whose journal claims `entries` migrations. */
function journalWith(entries: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-journal-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: Array.from({ length: entries }, (_, idx) => ({
        idx,
        version: "6",
        when: 1_700_000_000_000 + idx,
        tag: `000${idx}_fake`,
        breakpoints: true,
      })),
    }),
  );
  return dir;
}

describe("migrationState", () => {
  it("reports the journal length as pending on a database that has never been migrated", () => {
    const handle = keep(openDatabase(":memory:"));
    const state = migrationState(handle, resolveMigrationsFolder());

    expect(state.recorded).toBe(0);
    expect(state.available).toBeGreaterThan(0);
    expect(state.pending).toBe(state.available);
  });

  it("reports nothing pending on a database built by the real migrations", () => {
    const handle = keep(testDb());
    const state = migrationState(handle, resolveMigrationsFolder());

    expect(state.recorded).toBe(state.available);
    expect(state.pending).toBe(0);
  });
});

describe("assertSchemaUpToDate", () => {
  it("passes on an up-to-date database", () => {
    const handle = keep(testDb());
    expect(() => assertSchemaUpToDate(handle, resolveMigrationsFolder())).not.toThrow();
  });

  it("refuses to start when the journal is ahead — the 'pulled new code, forgot to migrate' case", () => {
    const handle = keep(testDb());
    const recorded = migrationState(handle, resolveMigrationsFolder()).recorded;
    // One migration more than the database has recorded.
    const folder = journalWith(recorded + 1);

    expect(migrationState(handle, folder).pending).toBe(1);
    expect(() => assertSchemaUpToDate(handle, folder)).toThrow(PendingMigrationsError);
    // The message has to tell the operator what to do; this is the only thing they will see.
    expect(() => assertSchemaUpToDate(handle, folder)).toThrow(/pnpm db:migrate/);
  });

  it("refuses to start on an empty database rather than creating the schema itself", () => {
    const handle = keep(openDatabase(":memory:"));
    let caught: unknown = null;
    try {
      assertSchemaUpToDate(handle, resolveMigrationsFolder());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PendingMigrationsError);
    expect((caught as PendingMigrationsError).state.recorded).toBe(0);
    // And nothing was applied on the way past.
    expect(migrationState(handle, resolveMigrationsFolder()).recorded).toBe(0);
  });
});

describe("createWorkerId", () => {
  it("carries the hostname and pid, and is unique per call", () => {
    const first = createWorkerId();
    const second = createWorkerId();

    expect(first).toContain(os.hostname());
    expect(first).toContain(String(process.pid));
    // The random suffix is what stops a reused pid from inheriting a dead worker's lease.
    expect(first).not.toBe(second);
  });
});
