/**
 * The worker process: everything that has to happen when nobody is looking at a browser tab.
 *
 * Design: `docs/architecture.md` (processes), `docs/design-notes/domain-scheduling-inventory.md`
 * §4.3–4.4 (lease, cadences), `docs/design-notes/auth-security-operations.md` §8 (HA transport)
 * and §11.4 (metrics). Operator documentation: `docs/worker.md`.
 *
 * What runs here and nowhere else:
 *  - the Home Assistant WebSocket and `HA_TOKEN` (§8.1 — the token never reaches the web process);
 *  - the scheduling tick and the outbox drain, guarded by separate leases;
 *  - inbound notification actions (a tap on a phone) and battery condition signals;
 *  - heartbeat, metrics, hourly housekeeping and the nightly integrity check.
 *
 * Startup rules, in order, because each one exists because of a specific failure:
 *  1. **Config is validated first and a bad config exits 78** (`EX_CONFIG`) with field names and
 *     no values — `HA_TOKEN` must never reach a log file.
 *  2. **The worker never migrates.** `pnpm db:migrate` (or `update.sh`) owns the schema; two
 *     processes racing to apply migrations at boot is how a database gets corrupted. If the
 *     journal has migrations the database has not recorded, this process says so and refuses to
 *     start rather than writing rows against a schema it does not understand.
 *  3. **HA is optional.** Scheduling is the point of this process; a household without
 *     `HA_URL`/`HA_TOKEN` still gets its ticks, and the missing integration is logged once and
 *     reflected in `integration_status`, not treated as a fatal error.
 *  4. **An unhandled rejection or exception exits 1.** launchd restarts us (ThrottleInterval 10 s),
 *     and every claim this process held expires on its own. A worker limping along in an unknown
 *     state is worse than a restart.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDb, type DbHandle } from "@/db/client";
import { resolveMigrationsFolder } from "@/db/migrate";
import { completeFromAction } from "@/domain/completion";
import { loadHousehold } from "@/domain/occurrence";
import { systemClock, type Clock } from "@/domain/time";
import { exitOnEnvError, loadEnv, type Env } from "@/env";
import { writeIntegrationStatus } from "@/server/ha/status";
import { log } from "@/server/log";
import { createNotifySender, startNotificationActionListener } from "@/worker/actions";
import { createBatterySignalHandler } from "@/worker/conditions";
import { createHaSocketFromEnv, type HaSocket } from "@/worker/ha/socket";
import { startHaBridge, type HaBridge } from "@/worker/haBridge";
import { startHeartbeatJob } from "@/worker/jobs/heartbeat";
import { startHousekeepingJob } from "@/worker/jobs/housekeeping";
import { startIntegrityJob } from "@/worker/jobs/integrity";
import { startMetricsJob } from "@/worker/jobs/metrics";
import type { Job } from "@/worker/jobs/interval";
import {
  DEFAULT_DRAIN_MS,
  DEFAULT_TICK_MS,
  startScheduler,
  type Scheduler,
} from "@/worker/scheduler";

/* ------------------------------------------------------------ migration guard */

const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface MigrationState {
  /** Migrations in `drizzle/meta/_journal.json`. */
  available: number;
  /** Migrations the database has recorded. */
  recorded: number;
  /** `available - recorded`, floored at 0. */
  pending: number;
}

interface JournalFile {
  entries?: unknown[];
}

/**
 * Compare the migration journal on disk with what the database has recorded.
 *
 * Deliberately *reads* rather than applies: see rule 2 in the module comment.
 */
export function migrationState(handle: DbHandle, migrationsFolder?: string): MigrationState {
  const folder = migrationsFolder ?? resolveMigrationsFolder();
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as JournalFile;
  const available = Array.isArray(journal.entries) ? journal.entries.length : 0;

  const table = handle.sqlite
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(MIGRATIONS_TABLE) as { n: number } | undefined;
  const recorded =
    !table || table.n === 0
      ? 0
      : ((handle.sqlite.prepare(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`).get() as
          | { n: number }
          | undefined)?.n ?? 0);

  return { available, recorded, pending: Math.max(available - recorded, 0) };
}

export class PendingMigrationsError extends Error {
  constructor(readonly state: MigrationState) {
    super(
      `database schema is ${state.pending} migration(s) behind ` +
        `(${state.recorded} recorded, ${state.available} in the journal). ` +
        "The worker never migrates: run `pnpm db:migrate` (production: scripts/update.sh) and start it again.",
    );
    this.name = "PendingMigrationsError";
  }
}

/** Throws `PendingMigrationsError` when the schema is behind. */
export function assertSchemaUpToDate(handle: DbHandle, migrationsFolder?: string): MigrationState {
  const state = migrationState(handle, migrationsFolder);
  if (state.pending > 0) throw new PendingMigrationsError(state);
  return state;
}

/* ------------------------------------------------------------------ worker id */

/**
 * `<hostname>/<pid>/<random>` — hostname and pid so a log line identifies the process a human can
 * kill, and the random suffix so a pid reused after a crash cannot inherit the dead worker's
 * lease (`holder_id === workerId` is what "renew" is decided on).
 */
export function createWorkerId(): string {
  return `${os.hostname()}/${process.pid}/${randomBytes(4).toString("hex")}`;
}

/* -------------------------------------------------------------------- runtime */

export interface WorkerRuntime {
  workerId: string;
  handle: DbHandle;
  scheduler: Scheduler;
  socket: HaSocket | null;
  bridge: HaBridge | null;
  jobs: Job[];
  /** Idempotent. Stops every timer, closes the socket, checkpoints and closes the database. */
  shutdown(reason: string): void;
}

export interface StartWorkerOptions {
  env: Env;
  handle: DbHandle;
  clock?: Clock;
  workerId?: string;
}

/**
 * Wire everything up. Split out of `main()` so the composition is inspectable (and so a future
 * integration test can drive a whole worker against an in-memory database).
 */
export function startWorker(options: StartWorkerOptions): WorkerRuntime {
  const { env, handle } = options;
  const clock = options.clock ?? systemClock;
  const workerId = options.workerId ?? createWorkerId();

  // The household's time zone, not the machine's: every local date in the domain resolves with it.
  const tz = loadHousehold(handle.db).timezone;

  let socket: HaSocket | null = null;
  let bridge: HaBridge | null = null;
  let unsubscribeActions: (() => void) | null = null;
  let haLastConnectedMs: number | null = null;

  if (env.haWsUrl && env.HA_TOKEN) {
    socket = createHaSocketFromEnv(env, {
      deps: {
        logger: {
          debug: (obj, msg) => log.debug(obj, msg),
          info: (obj, msg) => log.info(obj, msg),
          warn: (obj, msg) => log.warn(obj, msg),
          error: (obj, msg) => log.error(obj, msg),
        },
      },
    });
  }

  if (socket) {
    const haSocket = socket;
    haSocket.on("state", (status) => {
      if (status.state === "subscribed") haLastConnectedMs = status.at;
    });
    // Battery readings reach the domain through this callback rather than an import, so the
    // bridge stays free of `src/domain` (see the note at the top of `haBridge.ts`).
    bridge = startHaBridge({
      handle,
      socket: haSocket,
      onBatterySignal: createBatterySignalHandler({ handle, clock, tz }),
      token: env.HA_TOKEN ?? null,
    });
    unsubscribeActions = startNotificationActionListener({
      handle,
      clock,
      socket: haSocket,
      completeFromAction: completeFromAction({ handle, clock, tz }),
    });
    haSocket.start();
    log.info({ url: env.haWsUrl }, "ha integration enabled");
  } else {
    // Once, at info: scheduling is unaffected, and a household without HA should not be nagged.
    log.info(
      {},
      "ha integration disabled (HA_URL/HA_TOKEN not set) — scheduling runs, notifications stay queued",
    );
    try {
      writeIntegrationStatus(
        handle,
        { state: "disconnected", lastError: "not configured", atMs: clock.now() },
        null,
      );
    } catch (err) {
      log.warn({ err }, "could not record the disabled HA integration");
    }
  }

  const scheduler = startScheduler({
    handle,
    clock,
    workerId,
    sender: createNotifySender({ socket: () => socket }),
  });

  const jobs: Job[] = [
    startHeartbeatJob({
      handle,
      clock,
      workerId,
      intervalMs: env.VH_WORKER_HEARTBEAT_MS,
      haStatus: () => ({
        connected: socket?.state === "subscribed",
        lastConnectedMs: haLastConnectedMs,
      }),
    }),
    startMetricsJob({ handle, clock, intervalMs: env.VH_METRICS_INTERVAL_MS, role: "worker" }),
    startHousekeepingJob({ handle, clock }),
    startIntegrityJob({ handle, clock, tz, attachDir: env.attachDir }),
  ];

  let stopped = false;
  const shutdown = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    log.info({ reason, workerId }, "worker shutting down");
    for (const job of jobs) {
      try {
        job.stop();
      } catch (err) {
        log.warn({ err }, "job stop failed");
      }
    }
    try {
      scheduler.stop();
    } catch (err) {
      log.warn({ err }, "scheduler stop failed");
    }
    try {
      // Flush the 250 ms coalescing buffer before the socket goes: those state rows are already
      // observed, and dropping them would leave the UI showing a stale value until HA re-sends.
      bridge?.flush();
      bridge?.stop();
      unsubscribeActions?.();
      socket?.stop();
    } catch (err) {
      log.warn({ err }, "ha shutdown failed");
    }
    try {
      // TRUNCATE, not PASSIVE: this is the one moment we can afford to wait, and it leaves the
      // WAL small for the nightly backup.
      handle.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      log.warn({ err }, "wal checkpoint on shutdown failed");
    }
    try {
      handle.close();
    } catch (err) {
      log.warn({ err }, "database close failed");
    }
  };

  return { workerId, handle, scheduler, socket, bridge, jobs, shutdown };
}

/* ----------------------------------------------------------------------- main */

function main(): void {
  let env: Env;
  try {
    env = loadEnv("worker");
  } catch (err) {
    exitOnEnvError(err);
  }

  const handle = getDb();

  try {
    const state = assertSchemaUpToDate(handle);
    log.debug({ migrations: state.recorded }, "database schema is up to date");
  } catch (err) {
    if (err instanceof PendingMigrationsError) {
      log.fatal({ ...err.state }, err.message);
    } else {
      log.fatal({ err }, "could not verify the database schema; refusing to start");
    }
    handle.close();
    // EX_CONFIG: the fix is an operator action, not a retry.
    process.exit(78);
  }

  let runtime: WorkerRuntime | null = null;
  const panic = (reason: string, err: unknown): void => {
    log.fatal({ err }, `${reason}; exiting`);
    try {
      runtime?.shutdown(reason);
    } finally {
      process.exit(1);
    }
  };
  // Installed before anything is started, so a failure *during* wiring is handled the same way.
  process.on("unhandledRejection", (reason) => panic("unhandled rejection", reason));
  process.on("uncaughtException", (err) => panic("uncaught exception", err));

  try {
    runtime = startWorker({ env, handle });
  } catch (err) {
    panic("worker failed to start", err);
    return;
  }

  log.info(
    {
      workerId: runtime.workerId,
      db: env.dbPath,
      ha: runtime.socket ? "enabled" : "disabled",
      tickMs: DEFAULT_TICK_MS,
      drainMs: DEFAULT_DRAIN_MS,
      heartbeatMs: env.VH_WORKER_HEARTBEAT_MS,
      metricsMs: env.VH_METRICS_INTERVAL_MS,
    },
    "worker started",
  );

  let exiting = false;
  const started = runtime;
  const stop = (signal: string): void => {
    if (exiting) return;
    exiting = true;
    started.shutdown(signal);
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

/**
 * Run `main()` only when this file is the process entry point, so a test (or a future tool) can
 * import `assertSchemaUpToDate`/`startWorker` without starting a worker.
 */
function isEntryPoint(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
