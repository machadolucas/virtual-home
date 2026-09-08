/**
 * Process metrics: one `process_metric` row per `VH_METRICS_INTERVAL_MS` (60 s) from
 * `process.memoryUsage()` + `process.uptime()`, pruned to 14 days hourly.
 *
 * Design: `docs/design-notes/auth-security-operations.md` §11.4.
 *
 * Why persist them at all: the memory budget in §11.5 is an *observed* number, and "the worker's
 * RSS is 1.6× its p95" is the only alert that catches a slow leak on a machine nobody watches. At
 * 60 s that is ~40 k rows steady state, which is negligible next to the state cache.
 */
import { lt } from "drizzle-orm";
import { writeTx, type DbHandle } from "@/db/client";
import { processMetric, type ProcessMetricRole } from "@/db/schema/system";
import type { Clock } from "@/domain/time";
import { log } from "@/server/log";
import { startIntervalJob, type Job } from "./interval";

/** Rows older than this are pruned. */
export const METRIC_RETENTION_MS = 14 * 86_400_000;
/** How often the pruning runs. */
export const METRIC_PRUNE_INTERVAL_MS = 3_600_000;

export interface WriteProcessMetricOptions {
  handle: DbHandle;
  role: ProcessMetricRole;
  atMs: number;
  /** Injected in tests; defaults to this process's real numbers. */
  sample?: () => { rss: number; heapUsed: number; external: number; uptimeS: number };
}

function realSample(): { rss: number; heapUsed: number; external: number; uptimeS: number } {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    uptimeS: Math.round(process.uptime()),
  };
}

/** Append one sample. */
export function writeProcessMetric(options: WriteProcessMetricOptions): void {
  const sample = (options.sample ?? realSample)();
  writeTx(options.handle.db, (tx) => {
    tx.insert(processMetric)
      .values({
        role: options.role,
        pid: process.pid,
        rssBytes: sample.rss,
        heapUsedBytes: sample.heapUsed,
        externalBytes: sample.external,
        uptimeS: sample.uptimeS,
        atMs: options.atMs,
      })
      .run();
  });
}

/** Delete samples older than `cutoffMs`. Returns the number of rows deleted. */
export function pruneProcessMetrics(handle: DbHandle, cutoffMs: number): number {
  return writeTx(handle.db, (tx) => {
    const result = tx.delete(processMetric).where(lt(processMetric.atMs, cutoffMs)).run();
    return Number(result.changes ?? 0);
  });
}

export interface MetricsJobOptions {
  handle: DbHandle;
  clock: Clock;
  /** `VH_METRICS_INTERVAL_MS`. */
  intervalMs: number;
  role?: ProcessMetricRole;
  retentionMs?: number;
  pruneIntervalMs?: number;
  sample?: WriteProcessMetricOptions["sample"];
  logger?: Pick<typeof log, "debug" | "warn">;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/** The sampler and the reaper, as one handle to stop. */
export interface MetricsJob extends Job {
  /** Run the pruning pass out of band. */
  pruneNow(): void;
}

export function startMetricsJob(options: MetricsJobOptions): MetricsJob {
  const logger = options.logger ?? log;
  const role: ProcessMetricRole = options.role ?? "worker";
  const retentionMs = options.retentionMs ?? METRIC_RETENTION_MS;
  const timers = {
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
    ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
  };

  const sampler = startIntervalJob({
    name: "metrics",
    intervalMs: options.intervalMs,
    immediate: true,
    run: () => {
      writeProcessMetric({
        handle: options.handle,
        role,
        atMs: options.clock.now(),
        ...(options.sample ? { sample: options.sample } : {}),
      });
    },
    ...timers,
  });

  const prune = (): void => {
    const deleted = pruneProcessMetrics(options.handle, options.clock.now() - retentionMs);
    if (deleted > 0) logger.debug({ deleted, retentionMs }, "process metrics pruned");
  };

  const reaper = startIntervalJob({
    name: "metrics-prune",
    intervalMs: options.pruneIntervalMs ?? METRIC_PRUNE_INTERVAL_MS,
    run: prune,
    ...timers,
  });

  return {
    stop() {
      sampler.stop();
      reaper.stop();
    },
    runNow: sampler.runNow,
    pruneNow: reaper.runNow,
  };
}
