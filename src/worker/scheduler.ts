/**
 * The worker's two timed loops: the scheduling tick (60 s) and the transport outbox drain (5 s).
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §4.3–4.4.
 *
 * This module owns *timing only*. Every decision lives in `src/domain/notify` and every byte on
 * the wire belongs to the injected `sender`, which is what makes the whole loop testable with a
 * fake clock and no socket.
 *
 * Three properties it exists to guarantee:
 *
 *  1. **Never two runs of the same loop at once.** Each loop is a self-rescheduling `setTimeout`
 *     chain (the next run is armed only after the previous one settled) *and* carries a `busy`
 *     flag, so an out-of-band `runTickNow()` during a scheduled run is skipped rather than
 *     interleaved. Two overlapping ticks would fight over the same slot claims; the lease makes
 *     that safe across processes, but inside one process it is simply a bug.
 *  2. **A failing run never stops the loop.** Anything thrown is logged at `warn` and the next
 *     run is armed as usual. A tick that dies for good would take every reminder in the household
 *     with it.
 *  3. **A jittered first run.** Two workers started by the same `update.sh` (or a developer's
 *     `pnpm worker:dev` beside launchd's) do not have to discover each other through a thundering
 *     herd on the lease row.
 */
import { writeTx, type DbHandle } from "@/db/client";
import {
  drainOutbox,
  type DrainOutboxInput,
  type DrainOutboxResult,
  type SendOutcome,
} from "@/domain/notify/outbox";
import {
  LEASE_NOTIFICATION_TICK,
  LEASE_OUTBOX_DRAIN,
  releaseLease,
} from "@/domain/notify/lease";
import type { NotifyCommandRow } from "@/domain/notify/recipients";
import { runNotificationTick, type RunTickInput, type TickResult } from "@/domain/notify/tick";
import type { Clock } from "@/domain/time";
import { log } from "@/server/log";

/** Performs one HA service call. See `createNotifySender` in `src/worker/actions.ts`. */
export type NotifySender = (command: NotifyCommandRow) => Promise<SendOutcome>;

/** The slice of the logger the scheduler uses. `pino` satisfies it as-is. */
export interface SchedulerLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Scheduling tick cadence (§4.4). */
export const DEFAULT_TICK_MS = 60_000;
/** Outbox drain cadence (§4.4). */
export const DEFAULT_DRAIN_MS = 5_000;
/** Commands attempted per drain. */
export const DEFAULT_DRAIN_LIMIT = 20;
/** Upper bound on the random delay before the first run of each loop. */
export const MAX_FIRST_RUN_JITTER_MS = 5_000;

export type TimerHandle = unknown;

export interface SchedulerDeps {
  /** Injected so tests can make a "slow tick" without a database. */
  runTick?: (input: RunTickInput) => TickResult | Promise<TickResult>;
  drain?: (input: DrainOutboxInput) => Promise<DrainOutboxResult>;
  setTimeout?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  random?: () => number;
  logger?: SchedulerLogger;
}

export interface StartSchedulerOptions {
  handle: DbHandle;
  clock: Clock;
  workerId: string;
  sender: NotifySender;
  tickMs?: number;
  drainMs?: number;
  drainLimit?: number;
  /**
   * Hand both leases back on `stop()` so a restarting worker takes over without waiting out the
   * 90 s TTL. Skipped while a run is still in flight.
   */
  releaseLeasesOnStop?: boolean;
  deps?: SchedulerDeps;
}

export interface SchedulerStats {
  ticks: number;
  tickErrors: number;
  tickSkips: number;
  drains: number;
  drainErrors: number;
  drainSkips: number;
}

export interface Scheduler {
  /** Idempotent. Cancels both timers; in-flight runs are allowed to finish. */
  stop(): void;
  /** Run the tick out of band. Returns `null` when a run was already in flight. */
  runTickNow(): Promise<TickResult | null>;
  /** Run the drain out of band. Returns `null` when a run was already in flight. */
  runDrainNow(): Promise<DrainOutboxResult | null>;
  readonly stats: SchedulerStats;
  readonly busy: { tick: boolean; drain: boolean };
}

/**
 * A short random delay, so two workers starting together do not hit the lease row in lockstep.
 * Deliberately *not* a full interval: after a restart the household wants the catch-up tick now,
 * not in 60 s.
 */
export function firstRunDelayMs(intervalMs: number, random: () => number): number {
  return Math.floor(random() * Math.min(intervalMs, MAX_FIRST_RUN_JITTER_MS));
}

interface Loop<T> {
  runNow(): Promise<T | null>;
  stop(): void;
  readonly busy: boolean;
}

interface LoopOptions<T> {
  name: string;
  intervalMs: number;
  run: () => Promise<T>;
  onResult: (result: T) => void;
  onError: () => void;
  onSkip: () => void;
  setTimeoutFn: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutFn: (handle: TimerHandle) => void;
  random: () => number;
  logger: SchedulerLogger;
}

function makeLoop<T>(options: LoopOptions<T>): Loop<T> {
  const { name, intervalMs, run, onResult, onError, onSkip, logger } = options;
  let timer: TimerHandle = null;
  let busy = false;
  let stopped = false;

  const arm = (delayMs: number): void => {
    if (stopped) return;
    // Deliberately **not** `unref()`d: with HA disabled these two timers are the only thing
    // keeping the event loop alive, and an unref'd worker would exit a millisecond after start.
    // `stop()` clears them, which is what lets the process exit on SIGTERM.
    timer = options.setTimeoutFn(() => {
      timer = null;
      void fire();
    }, delayMs);
  };

  const once = async (): Promise<T | null> => {
    if (busy) {
      onSkip();
      logger.warn({ loop: name }, "worker loop overlap skipped");
      return null;
    }
    busy = true;
    const startedAt = Date.now();
    try {
      const result = await run();
      onResult(result);
      logger.debug(
        { loop: name, durationMs: Date.now() - startedAt, ...(result as object) },
        "worker loop ran",
      );
      return result;
    } catch (err) {
      onError();
      // Warn, never rethrow: the next run is the recovery path.
      logger.warn({ loop: name, err, durationMs: Date.now() - startedAt }, "worker loop failed");
      return null;
    } finally {
      busy = false;
    }
  };

  const fire = async (): Promise<void> => {
    if (stopped) return;
    await once();
    arm(intervalMs);
  };

  arm(firstRunDelayMs(intervalMs, options.random));

  return {
    runNow: once,
    stop() {
      stopped = true;
      if (timer !== null) {
        options.clearTimeoutFn(timer);
        timer = null;
      }
    },
    get busy() {
      return busy;
    },
  };
}

/**
 * Start both loops. Returns immediately; the first run of each happens after its jitter delay.
 */
export function startScheduler(options: StartSchedulerOptions): Scheduler {
  const { handle, clock, workerId, sender } = options;
  const deps = options.deps ?? {};
  const logger = deps.logger ?? log;
  const random = deps.random ?? Math.random;
  const setTimeoutFn = deps.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimeoutFn =
    deps.clearTimeout ??
    ((handleRef) => {
      globalThis.clearTimeout(handleRef as ReturnType<typeof globalThis.setTimeout>);
    });
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const drainLimit = options.drainLimit ?? DEFAULT_DRAIN_LIMIT;
  const runTick = deps.runTick ?? runNotificationTick;
  const runDrain = deps.drain ?? drainOutbox;

  const stats: SchedulerStats = {
    ticks: 0,
    tickErrors: 0,
    tickSkips: 0,
    drains: 0,
    drainErrors: 0,
    drainSkips: 0,
  };

  const tickLoop = makeLoop<TickResult>({
    name: "tick",
    intervalMs: tickMs,
    run: async () => runTick({ handle, clock, workerId }),
    onResult: (result) => {
      stats.ticks += 1;
      // One line a human would actually want to read, only when something happened.
      if (
        result.ran &&
        (result.becameDue.length > 0 ||
          result.commandsQueued > 0 ||
          result.slotsFailed > 0 ||
          result.slotsHeld > 0 ||
          result.digestsSent > 0 ||
          result.inCatchUp)
      ) {
        logger.info(
          {
            becameDue: result.becameDue.length,
            slotsCreated: result.slotsCreated,
            slotsHealed: result.slotsHealed,
            slotsFastForwarded: result.slotsFastForwarded,
            slotsHeld: result.slotsHeld,
            slotsClaimed: result.slotsClaimed,
            slotsFailed: result.slotsFailed,
            slotsReclaimed: result.slotsReclaimed,
            commandsQueued: result.commandsQueued,
            digestsSent: result.digestsSent,
            inCatchUp: result.inCatchUp,
            outageMs: result.outageMs,
            fence: result.fence,
          },
          "notification tick",
        );
      }
    },
    onError: () => {
      stats.tickErrors += 1;
    },
    onSkip: () => {
      stats.tickSkips += 1;
    },
    setTimeoutFn,
    clearTimeoutFn,
    random,
    logger,
  });

  const drainLoop = makeLoop<DrainOutboxResult>({
    name: "drain",
    intervalMs: drainMs,
    run: async () => runDrain({ handle, clock, workerId, sender, limit: drainLimit }),
    onResult: (result) => {
      stats.drains += 1;
      if (result.attempted > 0 || result.abandoned > 0 || result.reclaimed > 0) {
        logger.info(
          {
            attempted: result.attempted,
            sent: result.sent,
            requeued: result.requeued,
            abandoned: result.abandoned,
            reclaimed: result.reclaimed,
            slotsSent: result.slotsSent,
            fence: result.fence,
          },
          "outbox drain",
        );
      }
    },
    onError: () => {
      stats.drainErrors += 1;
    },
    onSkip: () => {
      stats.drainSkips += 1;
    },
    setTimeoutFn,
    clearTimeoutFn,
    random,
    logger,
  });

  let stopped = false;

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      tickLoop.stop();
      drainLoop.stop();
      if (options.releaseLeasesOnStop === false) return;
      if (tickLoop.busy || drainLoop.busy) {
        logger.debug({}, "worker leases kept: a run is still in flight");
        return;
      }
      try {
        const now = clock.now();
        writeTx(handle.db, (tx) => {
          releaseLease(tx, LEASE_NOTIFICATION_TICK, workerId, now);
          releaseLease(tx, LEASE_OUTBOX_DRAIN, workerId, now);
        });
      } catch (err) {
        logger.warn({ err }, "worker lease release failed");
      }
    },
    runTickNow: () => tickLoop.runNow(),
    runDrainNow: () => drainLoop.runNow(),
    stats,
    get busy() {
      return { tick: tickLoop.busy, drain: drainLoop.busy };
    },
  };
}
