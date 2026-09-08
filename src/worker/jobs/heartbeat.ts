/**
 * The liveness job: "the background service is running", written every
 * `VH_WORKER_HEARTBEAT_MS` (15 s by default) **regardless of HA state**.
 *
 * Design: `docs/design-notes/auth-security-operations.md` §8.7.
 *
 * The distinction this job exists for: a stale heartbeat means *the worker* is down
 * ("Background service not running"), which is a different sentence from "Home Assistant is
 * unreachable". Blaming HA for a dead worker costs an hour of debugging the wrong box, so the
 * heartbeat is written on its own timer and never gated on the socket.
 *
 * Two rows are touched, on purpose:
 *  - `worker_heartbeat('worker')` — this process (its id, its last-ok stamp, whether HA is up);
 *  - `integration_status.heartbeat_at_ms` — what the web process reads to answer "is the worker
 *    alive" without joining another table (`workerAlive()` in `src/server/ha/status.ts`).
 *
 * `worker_heartbeat('notification_tick')` is a *different* row, owned by the tick itself: that one
 * is how a restarted worker discovers an outage happened. This job never writes it.
 */
import { eq, sql } from "drizzle-orm";
import { writeTx, type DbHandle } from "@/db/client";
import { workerHeartbeat } from "@/db/schema/notifications";
import type { Clock } from "@/domain/time";
import { heartbeat as bumpIntegrationHeartbeat } from "@/server/ha/status";
import { log } from "@/server/log";
import { startIntervalJob, type Job } from "./interval";

/** The `worker_heartbeat` row this job owns. */
export const WORKER_HEARTBEAT_NAME = "worker";

export interface WorkerHeartbeatInput {
  handle: DbHandle;
  workerId: string;
  atMs: number;
  /** Whether the HA socket is `subscribed` right now. Recorded, never gating. */
  haConnected?: boolean;
  /** When HA was last known good, so "down since 04:12" is answerable. */
  haLastConnectedMs?: number | null;
}

/** Write one heartbeat. Exported so the shutdown path and tests can call it directly. */
export function writeWorkerHeartbeat(input: WorkerHeartbeatInput): void {
  const { handle, workerId, atMs } = input;
  const haConnected = input.haConnected ?? false;
  writeTx(handle.db, (tx) => {
    tx.insert(workerHeartbeat)
      .values({
        name: WORKER_HEARTBEAT_NAME,
        workerId,
        lastTickStartedMs: atMs,
        lastTickFinishedMs: atMs,
        lastOkMs: atMs,
        tickCount: 1,
        lastError: null,
        haConnected,
        haLastConnectedMs: input.haLastConnectedMs ?? null,
      })
      .onConflictDoUpdate({
        target: workerHeartbeat.name,
        set: {
          workerId,
          lastTickFinishedMs: atMs,
          lastOkMs: atMs,
          tickCount: sql`${workerHeartbeat.tickCount} + 1`,
          lastError: null,
          haConnected,
          // Keep the last known-good stamp when HA is currently down.
          ...(input.haLastConnectedMs !== undefined && input.haLastConnectedMs !== null
            ? { haLastConnectedMs: input.haLastConnectedMs }
            : {}),
        },
      })
      .run();
  });
}

/** Record why this worker is unhealthy, without pretending it is alive. */
export function writeWorkerHeartbeatError(
  handle: DbHandle,
  workerId: string,
  atMs: number,
  error: string,
): void {
  writeTx(handle.db, (tx) => {
    tx.update(workerHeartbeat)
      .set({ workerId, lastError: error.slice(0, 400), lastTickFinishedMs: atMs })
      .where(eq(workerHeartbeat.name, WORKER_HEARTBEAT_NAME))
      .run();
  });
}

export interface HeartbeatJobOptions {
  handle: DbHandle;
  clock: Clock;
  workerId: string;
  /** `VH_WORKER_HEARTBEAT_MS`. */
  intervalMs: number;
  /** Sampled on every beat, so the row reflects the socket without this job knowing about it. */
  haStatus?: () => { connected: boolean; lastConnectedMs: number | null };
  logger?: Pick<typeof log, "debug" | "warn">;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Start the heartbeat loop. The first beat is written immediately: a worker that has just started
 * should not look dead for 15 s.
 */
export function startHeartbeatJob(options: HeartbeatJobOptions): Job {
  const beat = (): void => {
    const at = options.clock.now();
    const ha = options.haStatus?.() ?? { connected: false, lastConnectedMs: null };
    writeWorkerHeartbeat({
      handle: options.handle,
      workerId: options.workerId,
      atMs: at,
      haConnected: ha.connected,
      haLastConnectedMs: ha.lastConnectedMs,
    });
    bumpIntegrationHeartbeat(options.handle, at);
  };

  return startIntervalJob({
    name: "heartbeat",
    intervalMs: options.intervalMs,
    run: beat,
    immediate: true,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
    ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
  });
}
