import "server-only";
import fs from "node:fs";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { loadEnv } from "@/env";
import {
  appAlert,
  backupRun,
  haNotifyCommand,
  haSyncRun,
  processMetric,
  user,
  type AppAlertKind,
  type AppAlertSeverity,
  type NotifyCommandState,
} from "@/db/schema";
import { readIntegrationStatus, workerAlive, type IntegrationStatusRow } from "@/server/ha/status";
import type { MetricSample } from "@/features/settings/format";

/**
 * A size the filesystem either gave us, told us does not exist, or refused.
 *
 * The three are different sentences on screen. A `null` that means both "there is no WAL" and
 * "the stat failed" turns an unreadable file into a confident "None", which is the same class of
 * bug as rendering `unavailable` as a value.
 */
export type FileSize =
  | { kind: "bytes"; bytes: number }
  | { kind: "absent" }
  | { kind: "unreadable" };

export interface StorageFigures {
  dbBytes: FileSize;
  walBytes: FileSize;
  /** `null` when the attachments directory could not be read at all. */
  attachmentsBytes: number | null;
  dbPath: string;
}

/**
 * Database and attachment sizes straight off the filesystem.
 *
 * WAL size is separate from the database size because a large WAL is its own signal: it means
 * checkpoints are not keeping up, which SQLite will not tell you any other way.
 */
export function readStorage(): StorageFigures {
  const env = loadEnv();
  return {
    dbPath: env.dbPath,
    dbBytes: fileSize(env.dbPath),
    walBytes: fileSize(`${env.dbPath}-wal`),
    attachmentsBytes: dirSize(env.attachDir),
  };
}

/**
 * `ENOENT` is "there is no such file", which is a fact. Anything else is "we could not look",
 * which is not — and the two must not collapse into one `null`.
 */
function fileSize(filePath: string): FileSize {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { kind: "bytes", bytes: stat.size } : { kind: "absent" };
  } catch (err) {
    return isNotFound(err) ? { kind: "absent" } : { kind: "unreadable" };
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/** Byte count for the recursive walk, where "could not stat this one child" simply contributes 0. */
function statSize(filePath: string): number | null {
  const size = fileSize(filePath);
  return size.kind === "bytes" ? size.bytes : null;
}

/**
 * Recursive directory size. Bounded by the attachments tree, which is a few thousand files at
 * most; a household's photo library is not a data-warehouse scan.
 */
function dirSize(dir: string): number | null {
  let total = 0;
  let sawSomething = false;
  const walk = (current: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    sawSomething = true;
    for (const entry of entries) {
      const child = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child, depth + 1);
      } else if (entry.isFile()) {
        const size = statSize(child);
        if (size !== null) total += size;
      }
    }
  };
  walk(dir, 0);
  return sawSomething ? total : null;
}

export interface AlertRow {
  id: string;
  kind: AppAlertKind;
  severity: AppAlertSeverity;
  title: string;
  body: string | null;
  entityTable: string | null;
  entityId: string | null;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  seenCount: number;
  acknowledgedAtMs: number | null;
  acknowledgedByName: string | null;
}

export interface SystemHealth {
  integration: IntegrationStatusRow | null;
  workerAlive: boolean;
  heartbeatPeriodMs: number;
  storage: StorageFigures;
  /** The newest run, whatever its outcome. Never the newest *successful* one — see below. */
  lastBackup: typeof backupRun.$inferSelect | null;
  /** The newest run that succeeded, which may be much older than `lastBackup`, or absent. */
  lastSuccessfulBackup: typeof backupRun.$inferSelect | null;
  recentBackups: (typeof backupRun.$inferSelect)[];
  lastSyncRun: typeof haSyncRun.$inferSelect | null;
  webMetrics: MetricSample[];
  workerMetrics: MetricSample[];
  notifyStateCounts: Record<NotifyCommandState, number>;
  /** Notify commands that ended badly: `failed` *and* `abandoned`, matching the headline count. */
  notifyFailures: {
    id: string;
    notifyService: string;
    kind: string;
    state: NotifyCommandState;
    attemptCount: number;
    lastError: string | null;
    createdAtMs: number;
  }[];
  alerts: AlertRow[];
  nowMs: number;
}

const DAY_MS = 86_400_000;

/**
 * Everything `/settings/system` renders.
 *
 * Every figure here is either measured or absent. There is no "healthy" derived from the absence
 * of a problem: `workerAlive` is a heartbeat comparison, and a missing `backup_run` row renders as
 * "no backup recorded", which is the alert rather than a blank.
 */
export function readSystemHealth(tx: Db, nowMs = Date.now()): SystemHealth {
  const env = loadEnv();
  const integration = readIntegrationStatus(tx);
  const since = nowMs - DAY_MS;

  const metricsFor = (role: "web" | "worker"): MetricSample[] =>
    tx
      .select({ atMs: processMetric.atMs, rssBytes: processMetric.rssBytes })
      .from(processMetric)
      .where(and(eq(processMetric.role, role), gte(processMetric.atMs, since)))
      .orderBy(asc(processMetric.atMs))
      .all();

  const notifyStateCounts: Record<NotifyCommandState, number> = {
    queued: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    abandoned: 0,
  };
  for (const row of tx
    .select({ state: haNotifyCommand.state, n: sql<number>`count(*)` })
    .from(haNotifyCommand)
    .groupBy(haNotifyCommand.state)
    .all()) {
    notifyStateCounts[row.state] = row.n;
  }

  const notifyFailures = tx
    .select({
      id: haNotifyCommand.id,
      notifyService: haNotifyCommand.notifyService,
      kind: haNotifyCommand.kind,
      state: haNotifyCommand.state,
      attemptCount: haNotifyCommand.attemptCount,
      lastError: haNotifyCommand.lastError,
      createdAtMs: haNotifyCommand.createdAtMs,
    })
    .from(haNotifyCommand)
    // Both terminal failure states, because the headline counts both. Querying only `failed` left
    // "Failed or given up: 1" sitting above an empty list — and nothing in the codebase ever
    // writes `failed` on this table, so the list was empty whatever the count said.
    .where(inArray(haNotifyCommand.state, ["failed", "abandoned"]))
    .orderBy(desc(haNotifyCommand.createdAtMs))
    .limit(10)
    .all();

  const recentBackups = tx
    .select()
    .from(backupRun)
    .orderBy(desc(backupRun.createdAtMs))
    .limit(5)
    .all();

  // The newest run, outcome included — not the newest run that happened to work. Showing the last
  // success under the heading "Last backup" let a green tick sit directly above three newer failed
  // rows, which is the one thing this page promises not to do. The last success is a real and
  // useful figure, so it is reported as itself, next to it.
  const lastBackup = recentBackups[0] ?? null;
  const lastSuccessfulBackup =
    tx
      .select()
      .from(backupRun)
      .where(eq(backupRun.ok, true))
      .orderBy(desc(backupRun.createdAtMs))
      .limit(1)
      .get() ?? null;

  return {
    integration,
    workerAlive: workerAlive(integration, nowMs, env.VH_WORKER_HEARTBEAT_MS),
    heartbeatPeriodMs: env.VH_WORKER_HEARTBEAT_MS,
    storage: readStorage(),
    lastBackup,
    lastSuccessfulBackup,
    recentBackups,
    lastSyncRun:
      tx.select().from(haSyncRun).orderBy(desc(haSyncRun.startedAtMs)).limit(1).get() ?? null,
    webMetrics: metricsFor("web"),
    workerMetrics: metricsFor("worker"),
    notifyStateCounts,
    notifyFailures,
    alerts: readAlerts(tx),
    nowMs,
  };
}

/** Unresolved alerts, worst and freshest first. */
export function readAlerts(tx: Db, limit = 25, options: { offset?: number; unseenOnly?: boolean } = {}): AlertRow[] {
  const severityRank = sql`CASE ${appAlert.severity} WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`;
  return tx
    .select({
      id: appAlert.id,
      kind: appAlert.kind,
      severity: appAlert.severity,
      title: appAlert.title,
      body: appAlert.body,
      entityTable: appAlert.entityTable,
      entityId: appAlert.entityId,
      firstSeenAtMs: appAlert.firstSeenAtMs,
      lastSeenAtMs: appAlert.lastSeenAtMs,
      seenCount: appAlert.seenCount,
      acknowledgedAtMs: appAlert.acknowledgedAtMs,
      acknowledgedByName: user.name,
    })
    .from(appAlert)
    .leftJoin(user, eq(user.id, appAlert.acknowledgedBy))
    .where(and(isNull(appAlert.resolvedAtMs), options.unseenOnly ? isNull(appAlert.acknowledgedAtMs) : undefined))
    .orderBy(severityRank, desc(appAlert.lastSeenAtMs), asc(appAlert.id))
    .limit(limit)
    .offset(options.offset ?? 0)
    .all();
}

/** Convenience for pages that only need the health block. */
export function systemHealth(): SystemHealth {
  return readSystemHealth(getDb().db);
}
