import "server-only";
import fs from "node:fs";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
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

export interface StorageFigures {
  /** `null` when the file cannot be stat'ed (an in-memory database, or a permissions problem). */
  dbBytes: number | null;
  walBytes: number | null;
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
    dbBytes: statSize(env.dbPath),
    walBytes: statSize(`${env.dbPath}-wal`),
    attachmentsBytes: dirSize(env.attachDir),
  };
}

function statSize(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
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
  lastBackup: typeof backupRun.$inferSelect | null;
  recentBackups: (typeof backupRun.$inferSelect)[];
  lastSyncRun: typeof haSyncRun.$inferSelect | null;
  webMetrics: MetricSample[];
  workerMetrics: MetricSample[];
  notifyStateCounts: Record<NotifyCommandState, number>;
  notifyFailures: {
    id: string;
    notifyService: string;
    kind: string;
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
      attemptCount: haNotifyCommand.attemptCount,
      lastError: haNotifyCommand.lastError,
      createdAtMs: haNotifyCommand.createdAtMs,
    })
    .from(haNotifyCommand)
    .where(eq(haNotifyCommand.state, "failed"))
    .orderBy(desc(haNotifyCommand.createdAtMs))
    .limit(10)
    .all();

  const recentBackups = tx
    .select()
    .from(backupRun)
    .orderBy(desc(backupRun.createdAtMs))
    .limit(5)
    .all();

  return {
    integration,
    workerAlive: workerAlive(integration, nowMs, env.VH_WORKER_HEARTBEAT_MS),
    heartbeatPeriodMs: env.VH_WORKER_HEARTBEAT_MS,
    storage: readStorage(),
    lastBackup: recentBackups.find((row) => row.ok) ?? recentBackups[0] ?? null,
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
export function readAlerts(tx: Db, limit = 25): AlertRow[] {
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
    .where(sql`${appAlert.resolvedAtMs} IS NULL`)
    .orderBy(severityRank, desc(appAlert.lastSeenAtMs))
    .limit(limit)
    .all();
}

/** Convenience for pages that only need the health block. */
export function systemHealth(): SystemHealth {
  return readSystemHealth(getDb().db);
}
