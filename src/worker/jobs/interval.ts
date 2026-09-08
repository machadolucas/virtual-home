/**
 * The one timer shape every background job in this folder uses.
 *
 * A self-rescheduling `setTimeout` chain rather than `setInterval`: a job that takes longer than
 * its period must not queue up behind itself, and a run that throws must not kill the chain.
 *
 * The timer is deliberately **not** `unref()`d — an unref'd worker with HA disabled would have
 * nothing holding its event loop open and would exit a millisecond after starting. `stop()`
 * clears it, which is what lets the process exit on SIGTERM.
 *
 * `setTimeout`/`clearTimeout` are looked up on `globalThis` at call time, so a test that installs
 * fake timers after this module was imported still controls the job.
 */
import { log } from "@/server/log";

export interface Job {
  /** Idempotent. Cancels the timer; a run already in flight is allowed to finish. */
  stop(): void;
  /** Run one iteration out of band (shutdown, tests). Errors are logged, never thrown. */
  runNow(): void;
}

export interface IntervalJobOptions {
  /** Appears in every log line from this job. */
  name: string;
  intervalMs: number;
  run: () => void;
  /** Run once immediately instead of waiting out the first period. Default `false`. */
  immediate?: boolean;
  logger?: Pick<typeof log, "debug" | "warn">;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export function startIntervalJob(options: IntervalJobOptions): Job {
  const logger = options.logger ?? log;
  const setTimeoutFn =
    options.setTimeoutFn ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ??
    ((handleRef) => {
      globalThis.clearTimeout(handleRef as ReturnType<typeof globalThis.setTimeout>);
    });

  let timer: unknown = null;
  let stopped = false;

  const runOnce = (): void => {
    try {
      options.run();
    } catch (err) {
      // A failing housekeeping pass is not worth the process. The next period retries.
      logger.warn({ job: options.name, err }, "worker job failed");
    }
  };

  const arm = (): void => {
    if (stopped) return;
    timer = setTimeoutFn(() => {
      timer = null;
      runOnce();
      arm();
    }, options.intervalMs);
  };

  if (options.immediate) runOnce();
  arm();

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },
    runNow: runOnce,
  };
}
