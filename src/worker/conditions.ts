/**
 * The condition adapter: an HA battery reading, as the bridge observed it, becomes one
 * `evaluateBatterySignal` call.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §6.
 *
 * Thin on purpose. Everything that matters — `unknown`/`unavailable` is never a value (never 0 %),
 * the sustain timers, staleness, episode bookkeeping and task generation — belongs to
 * `src/domain/condition.ts`. This file exists only because the bridge must not import the domain
 * (see the note at the top of `src/worker/haBridge.ts`): it hands readings out through an injected
 * callback, and this is the callback.
 *
 * **Nothing here throws.** It runs inside an HA socket event handler; an entity that HA reports a
 * state for but whose registry row has not been cached yet is an ordinary, transient condition
 * (`NotFoundError`), not a reason to take the worker down.
 */
import type { DbHandle } from "@/db/client";
import { evaluateBatterySignal, type BatterySignalResult } from "@/domain/condition";
import { NotFoundError } from "@/domain/errors";
import type { Clock } from "@/domain/time";
import { log } from "@/server/log";

export interface BatterySignalAdapterOptions {
  handle: DbHandle;
  clock: Clock;
  /** Household time zone. `ctx.tz` — condition rules resolve local dates with it. */
  tz: string;
  logger?: Pick<typeof log, "debug" | "info" | "warn">;
}

/**
 * The `onBatterySignal` callback `startHaBridge` expects: `(entityRegistryId, rawState,
 * lastUpdatedMs)`. `lastChangedMs` is deliberately not passed — the domain carries the stored
 * value forward for an unchanged state, which is what makes "unavailable for three days"
 * measurable.
 */
export function createBatterySignalHandler(
  options: BatterySignalAdapterOptions,
): (entityRegistryId: string, rawState: string, lastUpdatedMs: number) => void {
  const logger = options.logger ?? log;

  return (entityRegistryId, rawState, lastUpdatedMs) => {
    const result = evaluateBatterySignalSafely(options, {
      entityRegistryId,
      rawState,
      lastUpdatedMs,
    });
    if (!result) return;
    // Only a transition is worth a line; a battery reporting 87 % every hour is not news.
    if (result.occurrenceId || result.episodeId || result.alertId) {
      logger.info(
        {
          entityRegistryId,
          rawState,
          occurrenceId: result.occurrenceId ?? null,
          episodeId: result.episodeId ?? null,
          alertId: result.alertId ?? null,
        },
        "battery signal evaluated",
      );
    }
  };
}

export interface BatterySignalRequest {
  entityRegistryId: string;
  rawState: string;
  lastUpdatedMs: number;
}

/** `evaluateBatterySignal` with every failure turned into a log line. Returns `null` on failure. */
export function evaluateBatterySignalSafely(
  options: BatterySignalAdapterOptions,
  input: BatterySignalRequest,
): BatterySignalResult | null {
  const logger = options.logger ?? log;
  try {
    return evaluateBatterySignal(
      options.handle,
      {
        clock: options.clock,
        tz: options.tz,
        actorUserId: null,
        actorKind: "ha",
      },
      input,
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      // HA sent a state for an entity the registry cache has not seen yet. The next snapshot
      // (or the hourly re-list) fixes it, and the reading will be re-observed then.
      logger.debug(
        { entityRegistryId: input.entityRegistryId },
        "battery signal for an unknown ha_entity, ignored",
      );
      return null;
    }
    logger.warn({ err, entityRegistryId: input.entityRegistryId }, "battery signal failed");
    return null;
  }
}
