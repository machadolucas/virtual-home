/**
 * The hourly reaper: four short deletes and a WAL checkpoint.
 *
 * Design: `docs/design-notes/auth-security-operations.md` §7.2 (outbox retention), §3.5
 * (idempotency keys), §10 (operational hygiene).
 *
 * Everything here is *transport or cache*, never household data. Nothing in this file may delete
 * anything a human entered:
 *
 *  - `event_outbox` older than 10 min — a transport, not a log. The cursor is deliberately left
 *    alone (`pruneOutbox`): rewinding it would make every connected browser resync.
 *  - `idempotency_key` older than 24 h — the replay window the client's per-form key needs.
 *  - terminal `ha_control_command` rows older than 7 days — short-lived transport receipts.
 *  - `session` rows past `expiresAt` — Better Auth checks expiry on read, so these are dead
 *    weight, and a table full of them makes the security page unreadable.
 *  - `PRAGMA wal_checkpoint(PASSIVE)` — PASSIVE, not TRUNCATE: it never blocks the web process's
 *    readers, and a checkpoint that cannot run right now runs on the next pass.
 */
import { and, inArray, lt } from "drizzle-orm";
import { writeTx, type DbHandle } from "@/db/client";
import { session } from "@/db/schema/auth";
import { haControlCommand } from "@/db/schema/ha";
import { idempotencyKey } from "@/db/schema/system";
import type { Clock } from "@/domain/time";
import { pruneOutbox } from "@/server/events/outbox";
import { log } from "@/server/log";
import { startIntervalJob, type Job } from "./interval";

/** The outbox is a transport; the SSE hub replays at most a few minutes. */
export const OUTBOX_RETENTION_MS = 600_000;
/** §3.5: a stored server-action result is replayable for a day. */
export const IDEMPOTENCY_RETENTION_MS = 86_400_000;
export const HA_CONTROL_RETENTION_MS = 7 * 86_400_000;
export const HOUSEKEEPING_INTERVAL_MS = 3_600_000;

export interface HousekeepingInput {
  handle: DbHandle;
  clock: Clock;
  outboxRetentionMs?: number;
  idempotencyRetentionMs?: number;
  haControlRetentionMs?: number;
  /** Skip the checkpoint (tests on `:memory:`, where there is no WAL). */
  checkpoint?: boolean;
}

export interface HousekeepingResult {
  outboxDeleted: number;
  idempotencyDeleted: number;
  haControlsDeleted: number;
  sessionsDeleted: number;
  /** `true` when the checkpoint ran without error. */
  checkpointed: boolean;
}

/**
 * One housekeeping pass. Each delete is its own short `writeTx` (CLAUDE.md rule 3) so the single
 * WAL writer is never held for the whole pass.
 */
export function runHousekeeping(input: HousekeepingInput): HousekeepingResult {
  const { handle, clock } = input;
  const now = clock.now();
  const outboxRetentionMs = input.outboxRetentionMs ?? OUTBOX_RETENTION_MS;
  const idempotencyRetentionMs = input.idempotencyRetentionMs ?? IDEMPOTENCY_RETENTION_MS;
  const haControlRetentionMs = input.haControlRetentionMs ?? HA_CONTROL_RETENTION_MS;

  const outboxDeleted = writeTx(handle.db, (tx) => pruneOutbox(tx, now - outboxRetentionMs));

  const idempotencyDeleted = writeTx(handle.db, (tx) => {
    const result = tx
      .delete(idempotencyKey)
      .where(lt(idempotencyKey.createdAtMs, now - idempotencyRetentionMs))
      .run();
    return Number(result.changes ?? 0);
  });

  const sessionsDeleted = writeTx(handle.db, (tx) => {
    // `expiresAt` is a `timestamp_ms` column, so the bound value is a Date, not a number.
    const result = tx.delete(session).where(lt(session.expiresAt, new Date(now))).run();
    return Number(result.changes ?? 0);
  });

  const haControlsDeleted = writeTx(handle.db, (tx) => {
    const result = tx
      .delete(haControlCommand)
      .where(
        and(
          inArray(haControlCommand.state, ["sent", "failed", "expired"]),
          lt(haControlCommand.createdAtMs, now - haControlRetentionMs),
        ),
      )
      .run();
    return Number(result.changes ?? 0);
  });

  let checkpointed = false;
  if (input.checkpoint !== false) {
    try {
      handle.sqlite.pragma("wal_checkpoint(PASSIVE)");
      checkpointed = true;
    } catch (err) {
      // A busy checkpoint is normal, not an incident: the next pass takes it.
      log.debug({ err }, "wal checkpoint skipped");
    }
  }

  return { outboxDeleted, idempotencyDeleted, haControlsDeleted, sessionsDeleted, checkpointed };
}

export interface HousekeepingJobOptions extends HousekeepingInput {
  intervalMs?: number;
  logger?: Pick<typeof log, "debug" | "info" | "warn">;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export function startHousekeepingJob(options: HousekeepingJobOptions): Job {
  const logger = options.logger ?? log;
  return startIntervalJob({
    name: "housekeeping",
    intervalMs: options.intervalMs ?? HOUSEKEEPING_INTERVAL_MS,
    run: () => {
      const result = runHousekeeping(options);
      if (
        result.outboxDeleted +
          result.idempotencyDeleted +
          result.haControlsDeleted +
          result.sessionsDeleted >
        0
      ) {
        logger.debug({ ...result }, "housekeeping");
      }
    },
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
    ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
  });
}
