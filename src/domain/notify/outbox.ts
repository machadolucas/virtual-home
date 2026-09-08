/**
 * The transport outbox drain (§4.4, §4.8). Runs every 5 s, guarded by the `outbox_drain` lease.
 *
 * Why an outbox at all: **a clear must survive an HA outage.** If a task is completed while Home
 * Assistant is down, the "stop reminding" command cannot be dropped — so clears are rows, they
 * drain **before** notifies, and they retry with backoff until HA takes them.
 *
 * `sent` means HA accepted the service call. It is never "delivered" (§4.9) — HA → APNs → phone is
 * not observable to us, and nothing in the scheduling logic depends on it.
 */
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import {
  deliveryAttempt,
  haNotifyCommand,
  reminderSlot,
  type DeliveryOutcome,
} from "@/db/schema/notifications";
import { loadHousehold, type DomainCtx, type HouseholdSettings } from "../occurrence";
import type { Clock } from "../time";
import { raiseAppAlert } from "./alerts";
import { DEFAULT_LEASE_TTL_MS, LEASE_OUTBOX_DRAIN, acquireLease, holdsLease } from "./lease";
import type { NotifyCommandRow } from "./recipients";
import { advanceSeriesAfterSend } from "./series";

/** What a sender may report back. Anything else is a bug in the sender. */
export type SendOutcome = "accepted" | "ha_unavailable" | "ha_error" | "timeout";

/** 30 s, 1 m, 2 m, 5 m, 15 m, 30 m, then constant 30 m. */
export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000] as const;

/** After this many failed attempts a command is abandoned and the owner is alerted. */
export const MAX_ATTEMPTS = 200;

export function backoffFor(attemptCount: number): number {
  const index = Math.min(Math.max(attemptCount, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
}

export interface DrainOutboxInput {
  handle: DbHandle;
  clock: Clock;
  workerId: string;
  /** Performs the actual HA service call. Injected, so tests never need a socket. */
  sender: (command: NotifyCommandRow) => Promise<SendOutcome>;
  limit?: number;
  settings?: Partial<HouseholdSettings>;
  leaseTtlMs?: number;
}

export interface DrainOutboxResult {
  ran: boolean;
  fence: number | null;
  attempted: number;
  sent: number;
  requeued: number;
  abandoned: number;
  /** Commands whose claim had expired (worker killed mid-call) and were returned to `queued`. */
  reclaimed: number;
  /** Slots whose every sibling command is now `sent`, so the series advanced. */
  slotsSent: number;
  /** Command ids in the order they were attempted — clears first. */
  order: string[];
}

function ctxFor(clock: Clock, settings: HouseholdSettings): DomainCtx {
  return { clock, tz: settings.timezone, actorUserId: null, actorKind: "worker" };
}

/** Queued commands that are due for an attempt, clears first, then oldest first. */
function claimable(tx: Db, now: number, limit: number): NotifyCommandRow[] {
  return tx
    .select()
    .from(haNotifyCommand)
    .where(
      and(
        eq(haNotifyCommand.state, "queued"),
        or(isNull(haNotifyCommand.nextAttemptAtMs), lte(haNotifyCommand.nextAttemptAtMs, now)),
      ),
    )
    // Clears jump the queue: a stale "you still have a task" push is worse than a late reminder.
    .orderBy(sql`(${haNotifyCommand.kind} = 'clear') DESC`, asc(haNotifyCommand.createdAtMs))
    .limit(limit)
    .all();
}

export async function drainOutbox(input: DrainOutboxInput): Promise<DrainOutboxResult> {
  const { handle, clock, workerId, sender } = input;
  const db = handle.db;
  const limit = input.limit ?? 20;

  const stored = writeTx(db, (tx) => loadHousehold(tx));
  const settings: HouseholdSettings = { ...stored, ...input.settings };
  const ctx = ctxFor(clock, settings);

  const result: DrainOutboxResult = {
    ran: false,
    fence: null,
    attempted: 0,
    sent: 0,
    requeued: 0,
    abandoned: 0,
    reclaimed: 0,
    slotsSent: 0,
    order: [],
  };

  const fence = writeTx(db, (tx) =>
    acquireLease(
      tx,
      LEASE_OUTBOX_DRAIN,
      workerId,
      input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      clock.now(),
    ),
  );
  if (fence === null) return result;
  result.ran = true;
  result.fence = fence;

  // A worker killed between claiming a command and finishing the HA call left it `claimed`; the
  // claim expiry is what lets this drain pick it up again (one more `delivery_attempt`, never a
  // second command).
  result.reclaimed = reclaimExpiredCommands(handle, clock.now());

  const batch = writeTx(db, (tx) => claimable(tx, clock.now(), limit));

  for (const command of batch) {
    const now = clock.now();
    const attemptNo = command.attemptCount + 1;

    const claimed = writeTx(db, (tx) => {
      const changed = tx
        .update(haNotifyCommand)
        .set({
          state: "claimed",
          claimedBy: workerId,
          claimFence: fence,
          claimExpiresAtMs: now + 120_000,
          attemptCount: attemptNo,
        })
        .where(and(eq(haNotifyCommand.id, command.id), eq(haNotifyCommand.state, "queued")))
        .run();
      if (changed.changes !== 1) return false;
      tx.insert(deliveryAttempt)
        .values({
          id: newId(),
          commandId: command.id,
          attemptNo,
          startedAtMs: now,
          workerId,
        })
        .onConflictDoNothing()
        .run();
      return true;
    });
    if (!claimed) continue;

    result.attempted += 1;
    result.order.push(command.id);

    let outcome: SendOutcome;
    let error: string | null = null;
    try {
      outcome = await sender({ ...command, attemptCount: attemptNo });
    } catch (err) {
      outcome = "ha_error";
      error = err instanceof Error ? err.message : String(err);
    }

    const finishedAt = clock.now();
    writeTx(db, (tx) => {
      tx.update(deliveryAttempt)
        .set({ finishedAtMs: finishedAt, outcome: outcome satisfies DeliveryOutcome, error })
        .where(
          and(eq(deliveryAttempt.commandId, command.id), eq(deliveryAttempt.attemptNo, attemptNo)),
        )
        .run();

      // Fence check: a worker that lost the lease mid-flight must not write `sent`.
      if (!holdsLease(tx, LEASE_OUTBOX_DRAIN, workerId, fence)) {
        tx.update(haNotifyCommand)
          .set({ state: "queued", claimedBy: null, claimFence: null, claimExpiresAtMs: null })
          .where(eq(haNotifyCommand.id, command.id))
          .run();
        return;
      }

      if (outcome !== "accepted") {
        const abandon = attemptNo >= MAX_ATTEMPTS;
        tx.update(haNotifyCommand)
          .set({
            state: abandon ? "abandoned" : "queued",
            claimedBy: null,
            claimFence: null,
            claimExpiresAtMs: null,
            nextAttemptAtMs: abandon ? null : finishedAt + backoffFor(attemptNo),
            lastError: error ?? outcome,
          })
          .where(eq(haNotifyCommand.id, command.id))
          .run();
        if (abandon) {
          result.abandoned += 1;
          raiseAppAlert(tx, ctx, {
            kind: "worker_outage",
            severity: "error",
            title: "Notification could not be delivered",
            body: `Gave up on ${command.kind} command after ${attemptNo} attempts (${outcome})`,
            dedupeKey: `notify_abandoned:${command.id}`,
            entityTable: "ha_notify_command",
            entityId: command.id,
          });
        } else {
          result.requeued += 1;
        }
        return;
      }

      tx.update(haNotifyCommand)
        .set({
          state: "sent",
          sentAtMs: finishedAt,
          claimedBy: null,
          claimFence: null,
          claimExpiresAtMs: null,
          nextAttemptAtMs: null,
          lastError: null,
        })
        .where(eq(haNotifyCommand.id, command.id))
        .run();
      result.sent += 1;

      if (command.kind !== "notify" || command.slotId === null) return;
      // The slot is `sent` only once *every* device of the recipient has been told.
      const siblings = tx
        .select({ state: haNotifyCommand.state })
        .from(haNotifyCommand)
        .where(and(eq(haNotifyCommand.slotId, command.slotId), eq(haNotifyCommand.kind, "notify")))
        .all();
      if (siblings.some((row) => row.state !== "sent")) return;
      if (advanceSeriesAfterSend(tx, ctx, settings, command.slotId, "push") !== null) {
        result.slotsSent += 1;
      }
    });
  }

  return result;
}

/**
 * Requeue commands whose claim expired (worker killed between claim and send), so the next drain
 * retries them exactly once more.
 */
export function reclaimExpiredCommands(handle: DbHandle, now: number): number {
  return writeTx(handle.db, (tx) =>
    tx
      .update(haNotifyCommand)
      .set({ state: "queued", claimedBy: null, claimFence: null, claimExpiresAtMs: null })
      .where(and(eq(haNotifyCommand.state, "claimed"), lte(haNotifyCommand.claimExpiresAtMs, now)))
      .run(),
  ).changes;
}

/** Mark a slot failed — used by the worker's janitor when its commands were abandoned. */
export function markSlotFailed(handle: DbHandle, slotId: string, reason: string): void {
  writeTx(handle.db, (tx) => {
    tx.update(reminderSlot)
      .set({ state: "failed", cancelReason: reason })
      .where(eq(reminderSlot.id, slotId))
      .run();
  });
}
