/**
 * Schema migration + singleton seeding. The only place migrations are applied.
 *
 * `drizzle-kit` only *generates* SQL (see `drizzle.config.ts`); applying it lives here so we
 * control the pragma set, the transaction behaviour and the pre-migration backup.
 *
 * Run directly with `pnpm db:migrate`.
 */
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, writeTx, type DbHandle } from "./client";
import { nowMs } from "./ids";
// Relative, not `@/env`: this module is bundled by esbuild for the worker, where `@/` is not mapped.
import { exitOnEnvError, loadEnv } from "../env";
import { HOUSEHOLD_SETTING_ID, householdSetting } from "./schema/household";
import { EVENT_CURSOR_ID, eventCursor } from "./schema/system";
import {
  HA_CONNECTION_STATE_ID,
  INTEGRATION_STATUS_HA_ID,
  haConnectionState,
  integrationStatus,
} from "./schema/ha";

const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * Candidate `drizzle/` locations, most specific first. The same code has to work from three very
 * different roots:
 *  - `tsx src/db/migrate.ts` and Vitest — `__dirname` is `<repo>/src/db`;
 *  - the esbuild worker bundle — `__dirname` is `<repo>/dist/worker` (and does not exist at all in
 *    ESM output, which is why every read of it is guarded by `typeof`);
 *  - Next's server bundle — `__dirname` is somewhere under `.next/`, so only `process.cwd()` helps.
 *
 * `VH_MIGRATIONS_DIR` is the escape hatch for a deployment layout none of these cover.
 */
function candidateFolders(): string[] {
  const out: string[] = [];
  const push = (p: string | undefined | null): void => {
    if (p && !out.includes(p)) out.push(p);
  };
  push(process.env.VH_MIGRATIONS_DIR);
  const here = typeof __dirname === "string" ? __dirname : null;
  if (here) {
    push(path.resolve(here, "../../drizzle"));
    push(path.resolve(here, "../drizzle"));
    push(path.resolve(here, "drizzle"));
  }
  push(path.resolve(process.cwd(), "drizzle"));
  push(path.resolve(process.cwd(), "../drizzle"));
  return out;
}

/** The `drizzle/` folder for this process, identified by its `meta/_journal.json`. */
export function resolveMigrationsFolder(): string {
  const candidates = candidateFolders();
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "meta", "_journal.json"))) return dir;
  }
  throw new Error(
    `migrations folder not found; looked in:\n  ${candidates.join("\n  ")}\n` +
      "Set VH_MIGRATIONS_DIR to the directory holding meta/_journal.json.",
  );
}

/** How many migrations the database has recorded so far (0 before the first run). */
function recordedCount(handle: DbHandle): number {
  const table = handle.sqlite
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(MIGRATIONS_TABLE) as { n: number } | undefined;
  if (!table || table.n === 0) return 0;
  const rows = handle.sqlite.prepare(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`).get() as
    | { n: number }
    | undefined;
  return rows?.n ?? 0;
}

/**
 * Seed the rows that must exist for the app to boot at all. Idempotent (`onConflictDoNothing`), so
 * re-running never overwrites a setting a human has since changed.
 *
 * `display_name` and `current_model_id` are neutral placeholders: real household values are
 * private data and never live in this repository. Setup and the model import replace them.
 */
function seedSingletons(handle: DbHandle): void {
  const env = loadEnv();
  const at = nowMs();

  writeTx(handle.db, (tx) => {
    tx.insert(householdSetting)
      .values({
        id: HOUSEHOLD_SETTING_ID,
        displayName: "Home",
        timezone: env.VH_HOUSEHOLD_TZ,
        deliveryTime: env.VH_DELIVERY_TIME,
        currentModelId: "unset",
        createdAtMs: at,
        updatedAtMs: at,
      })
      .onConflictDoNothing()
      .run();

    tx.insert(eventCursor).values({ id: EVENT_CURSOR_ID, seq: 0 }).onConflictDoNothing().run();

    tx.insert(haConnectionState)
      .values({
        id: HA_CONNECTION_STATE_ID,
        connected: false,
        reconnectAttempts: 0,
        updatedAtMs: at,
      })
      .onConflictDoNothing()
      .run();

    tx.insert(integrationStatus)
      .values({
        id: INTEGRATION_STATUS_HA_ID,
        state: "disconnected",
        heartbeatAtMs: at,
        updatedAtMs: at,
      })
      .onConflictDoNothing()
      .run();
  });
}

export interface MigrationResult {
  /** Total migrations recorded in `__drizzle_migrations` after this run. */
  applied: number;
  /** How many of those were applied by *this* call — 0 on an up-to-date database. */
  newlyApplied: number;
}

/**
 * Apply every pending migration to `handle`, then seed the singletons. Safe to call on every
 * start: on an up-to-date database it applies nothing and changes nothing.
 */
export function runMigrations(handle: DbHandle): MigrationResult {
  const migrationsFolder = resolveMigrationsFolder();
  const before = recordedCount(handle);
  migrate(handle.db, { migrationsFolder });
  const after = recordedCount(handle);
  seedSingletons(handle);
  return { applied: after, newlyApplied: after - before };
}

function main(): void {
  let dbPath: string;
  try {
    dbPath = loadEnv("cli").dbPath;
  } catch (err) {
    exitOnEnvError(err);
  }
  const handle = openDatabase(dbPath);
  try {
    const { applied, newlyApplied } = runMigrations(handle);
    const journal = handle.sqlite.pragma("journal_mode", { simple: true });
    console.log(
      `[db:migrate] ok — ${newlyApplied} applied, ${applied} total, ` +
        `journal_mode=${String(journal)}, db=${dbPath}`,
    );
    process.exitCode = 0;
  } catch (err) {
    console.error("[db:migrate] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    handle.close();
  }
}

// Executed directly (`pnpm db:migrate`)? `require.main` covers the CJS path tsx uses; when this
// module is imported as a library (web, worker, tests) neither branch fires.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main();
}
