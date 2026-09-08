/**
 * Recipient states and clearing (§4.1, §4.8).
 *
 * Two operations live here because both are called from *inside* other transactions (the worker
 * tick, completion, skip, cancel, postpone, reopen) and must never open one of their own:
 *
 *  - `ensureRecipientStates` — materialise one `notification_recipient_state` per (occurrence,
 *    recipient), with the stable tag that makes clears idempotent;
 *  - `clearRecipients` — stop reminding, right now, for **every** recipient of an occurrence
 *    regardless of who acted, and enqueue one `clear` command per active device so the phone's
 *    notification disappears even if HA is currently unreachable.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { newId } from "@/db/ids";
import { user } from "@/db/schema/auth";
import { userNotifyDevice } from "@/db/schema/household";
import {
  SLOT_OPEN_STATES,
  haNotifyCommand,
  notificationRecipientState,
  reminderSlot,
  type ClearReason,
} from "@/db/schema/notifications";
import type { DomainCtx, OccurrenceRow } from "../occurrence";

export type RecipientStateRow = typeof notificationRecipientState.$inferSelect;
export type ReminderSlotRow = typeof reminderSlot.$inferSelect;
export type NotifyCommandRow = typeof haNotifyCommand.$inferSelect;
export type NotifyDeviceRow = typeof userNotifyDevice.$inferSelect;

/**
 * Recipient states that are still live. `snoozed` is live — a snooze changes *when* the next
 * reminder fires, never *whether* the task is still open.
 */
export const LIVE_RECIPIENT_STATES = ["active", "snoozed"] as const;

/**
 * Reasons that close the occurrence for good; the recipient state becomes `cleared`.
 * `postponed` and `reopened` clear the *phone* but re-arm the series instead.
 */
const TERMINAL_CLEAR_REASONS: readonly ClearReason[] = ["completed", "skipped", "cancelled"];

/** `vh:occ:<occurrenceId>:<recipientUserId>` — stable for the lifetime of the occurrence. */
export function tagFor(occurrenceId: string, recipientUserId: string): string {
  return `vh:occ:${occurrenceId}:${recipientUserId}`;
}

/** `vh:digest:<userId>` */
export function digestTagFor(userId: string): string {
  return `vh:digest:${userId}`;
}

/** Every user who can be notified. The household has no "inactive" flag beyond Better Auth's ban. */
export function activeUserIds(tx: Db): string[] {
  return tx
    .select({ id: user.id })
    .from(user)
    .all()
    .filter((row) => row.id !== null)
    .map((row) => row.id);
}

/** The users an occurrence notifies: its assignee, or the whole household when shared. */
export function recipientsFor(tx: Db, occ: OccurrenceRow): string[] {
  if (occ.assignmentMode === "user" && occ.assigneeUserId !== null) return [occ.assigneeUserId];
  return activeUserIds(tx);
}

/** Active `notify.mobile_app_*` services for a user. */
export function activeDevices(tx: Db, userId: string): NotifyDeviceRow[] {
  return tx
    .select()
    .from(userNotifyDevice)
    .where(and(eq(userNotifyDevice.userId, userId), eq(userNotifyDevice.isActive, true)))
    .all();
}

export function recipientStatesOf(tx: Db, occurrenceId: string): RecipientStateRow[] {
  return tx
    .select()
    .from(notificationRecipientState)
    .where(eq(notificationRecipientState.occurrenceId, occurrenceId))
    .all();
}

export function openSlotOf(tx: Db, recipientStateId: string): ReminderSlotRow | null {
  return (
    tx
      .select()
      .from(reminderSlot)
      .where(
        and(
          eq(reminderSlot.recipientStateId, recipientStateId),
          inArray(reminderSlot.state, [...SLOT_OPEN_STATES]),
        ),
      )
      .all()[0] ?? null
  );
}

/**
 * Create the missing `notification_recipient_state` rows for an open occurrence, re-activate any
 * that were suppressed by an assignment change, and re-anchor a state whose `anchor_date` no
 * longer matches the occurrence's due date (self-healing after a postpone).
 *
 * Idempotent: safe to call on every tick and from every transition.
 */
export function ensureRecipientStates(tx: Db, ctx: DomainCtx, occ: OccurrenceRow): void {
  const now = ctx.clock.now();
  const wanted = recipientsFor(tx, occ);
  const existing = recipientStatesOf(tx, occ.id);
  const byUser = new Map(existing.map((row) => [row.recipientUserId, row]));

  for (const userId of wanted) {
    const current = byUser.get(userId);
    if (!current) {
      tx.insert(notificationRecipientState)
        .values({
          id: newId(),
          occurrenceId: occ.id,
          recipientUserId: userId,
          tag: tagFor(occ.id, userId),
          anchorDate: occ.dueDate,
          state: "active",
          nextSlotIndex: 0,
          createdAtMs: now,
          updatedAtMs: now,
        })
        .onConflictDoNothing()
        .run();
      continue;
    }
    if (current.state === "cleared") continue; // a closed/cleared occurrence is not re-armed here
    const reAnchor = current.anchorDate !== occ.dueDate;
    if (reAnchor) cancelOpenSlot(tx, current.id, "re_anchored");
    if (current.state === "suppressed" || reAnchor) {
      tx.update(notificationRecipientState)
        .set({
          state: "active",
          anchorDate: occ.dueDate,
          ...(reAnchor ? { nextSlotIndex: 0, snoozedUntilMs: null } : {}),
          updatedAtMs: now,
        })
        .where(eq(notificationRecipientState.id, current.id))
        .run();
    }
  }

  // Assignment changed after generation: stop reminding the people who are no longer recipients,
  // without destroying their history.
  for (const row of existing) {
    if (wanted.includes(row.recipientUserId)) continue;
    if (row.state === "cleared" || row.state === "suppressed") continue;
    cancelOpenSlot(tx, row.id, "not_a_recipient");
    tx.update(notificationRecipientState)
      .set({ state: "suppressed", updatedAtMs: now })
      .where(eq(notificationRecipientState.id, row.id))
      .run();
  }
}

/** Cancel the single open (pending/claimed) slot of a recipient state, if there is one. */
export function cancelOpenSlot(tx: Db, recipientStateId: string, reason: string): void {
  tx.update(reminderSlot)
    .set({ state: "cancelled", cancelReason: reason })
    .where(
      and(
        eq(reminderSlot.recipientStateId, recipientStateId),
        inArray(reminderSlot.state, [...SLOT_OPEN_STATES]),
      ),
    )
    .run();
}

/** Enqueue one `clear` command per active device of `userId`. Survives an HA outage. */
export function enqueueClearCommands(
  tx: Db,
  ctx: DomainCtx,
  state: RecipientStateRow,
): number {
  const now = ctx.clock.now();
  const devices = activeDevices(tx, state.recipientUserId);
  let queued = 0;
  for (const device of devices) {
    const result = tx
      .insert(haNotifyCommand)
      .values({
        id: newId(),
        kind: "clear",
        notifyService: device.notifyService,
        payloadJson: JSON.stringify({ message: "clear_notification", data: { tag: state.tag } }),
        tag: state.tag,
        slotId: null,
        recipientStateId: state.id,
        dedupeKey: `clear:${state.tag}:${now}`,
        state: "queued",
        createdAtMs: now,
      })
      .onConflictDoNothing()
      .run();
    queued += result.changes;
  }
  return queued;
}

/**
 * Stop reminding every recipient of `occurrenceId`.
 *
 * `completed` / `skipped` / `cancelled` — the occurrence is closed, so the state becomes `cleared`.
 * `postponed` / `reopened` — the "due now" push is no longer true, so it is cleared from the phone
 * and the slot series is re-armed from index 0 (the caller sets the new `anchor_date`).
 *
 * In both cases: cancel the pending slot, and enqueue one `clear` command per active device.
 */
export function clearRecipients(
  tx: Db,
  ctx: DomainCtx,
  occurrenceId: string,
  reason: ClearReason,
): void {
  const now = ctx.clock.now();
  const terminal = TERMINAL_CLEAR_REASONS.includes(reason);
  const states = recipientStatesOf(tx, occurrenceId);

  for (const state of states) {
    if (state.state === "cleared" && terminal) continue;
    cancelOpenSlot(tx, state.id, reason);
    enqueueClearCommands(tx, ctx, state);
    tx.update(notificationRecipientState)
      .set(
        terminal
          ? { state: "cleared", clearedAtMs: now, clearReason: reason, updatedAtMs: now }
          : {
              // Re-armed, not cleared: `cleared_at_ms` must stay NULL for the CHECK to hold.
              state: "active",
              clearedAtMs: null,
              clearReason: reason,
              nextSlotIndex: 0,
              snoozedUntilMs: null,
              updatedAtMs: now,
            },
      )
      .where(eq(notificationRecipientState.id, state.id))
      .run();
  }
}

/** Re-arm every non-suppressed recipient state of a reopened occurrence. */
export function rearmRecipientStates(
  tx: Db,
  ctx: DomainCtx,
  occ: OccurrenceRow,
  reason: ClearReason,
): void {
  const now = ctx.clock.now();
  tx.update(notificationRecipientState)
    .set({
      state: "active",
      anchorDate: occ.dueDate,
      nextSlotIndex: 0,
      snoozedUntilMs: null,
      clearedAtMs: null,
      clearReason: reason,
      updatedAtMs: now,
    })
    .where(
      and(
        eq(notificationRecipientState.occurrenceId, occ.id),
        ne(notificationRecipientState.state, "suppressed"),
      ),
    )
    .run();
  for (const state of recipientStatesOf(tx, occ.id)) {
    if (state.state === "suppressed") continue;
    cancelOpenSlot(tx, state.id, reason);
  }
  ensureRecipientStates(tx, ctx, occ);
}
