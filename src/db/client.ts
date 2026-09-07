/**
 * SQLite access shared by the web and worker processes.
 *
 * HARD RULES (see CLAUDE.md):
 *  - Open with the pragma set below on EVERY connection (foreign_keys is per-connection).
 *  - Every transaction that writes uses `writeTx` (BEGIN IMMEDIATE). A deferred transaction that
 *    reads first and writes later can fail with SQLITE_BUSY_SNAPSHOT mid-transaction and
 *    busy_timeout cannot rescue it.
 *  - Keep transactions short. Bulk work is chunked (≤ 500 rows per transaction).
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;
export type Sqlite = Database.Database;

export interface DbHandle {
  sqlite: Sqlite;
  db: Db;
  close(): void;
}

export function applyPragmas(sqlite: Sqlite): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("wal_autocheckpoint = 1000");
  sqlite.pragma("temp_store = MEMORY");
}

/** Open (and create if needed) the database file. Use ':memory:' in tests. */
export function openDatabase(filePath: string): DbHandle {
  if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  applyPragmas(sqlite);
  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    close() {
      sqlite.close();
    },
  };
}

const BUSY_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

function isBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT" || code === "SQLITE_LOCKED";
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Run `fn` inside BEGIN IMMEDIATE. Retries a bounded number of times on SQLITE_BUSY with jittered
 * backoff (two processes share the file). The callback must be synchronous (better-sqlite3).
 */
export function writeTx<T>(db: Db, fn: (tx: Db) => T): T {
  let attempt = 0;
  for (;;) {
    try {
      return db.transaction((tx) => fn(tx as unknown as Db), { behavior: "immediate" });
    } catch (err) {
      if (!isBusy(err) || attempt >= BUSY_RETRY_DELAYS_MS.length) throw err;
      const base = BUSY_RETRY_DELAYS_MS[attempt++]!;
      sleepSync(base + Math.floor(Math.random() * base * 0.5));
    }
  }
}

/** Read-only transaction (deferred). Use for multi-statement consistent reads. */
export function readTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db), { behavior: "deferred" });
}

let shared: DbHandle | null = null;

/** Process-wide handle for the configured database file (web + worker). */
export function getDb(): DbHandle {
  if (shared) return shared;
  // Lazy import keeps env loading out of module scope for tests that use openDatabase directly.
  const { loadEnv } = require("@/env") as typeof import("@/env");
  shared = openDatabase(loadEnv().dbPath);
  return shared;
}

/** Tests: swap the shared handle. */
export function setDbForTests(handle: DbHandle | null): void {
  shared = handle;
}
