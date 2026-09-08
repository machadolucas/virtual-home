/**
 * "This reminder went out — what happens next?"
 *
 * Shared by the digest path in the tick and by the outbox drain, because both finish a send and
 * both must advance the series identically:
 *  - the fired slot becomes `sent` (which is "HA accepted the call", never "delivered", §4.9);
 *  - the recipient state records `last_sent_*` and moves `next_slot_index` on by one;
 *  - the **next** slot is inserted at `t(index + 1)` computed from the state's original
 *    `anchor_date`, so an outage never shifts the weekly rhythm (§4.5 rule 3);
 *  - a snooze fire hands control back to the anchored series and the state returns to `active`.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { newId } from "@/db/ids";
import { notificationRecipientState, reminderSlot } from "@/db/schema/notifications";
import {
  newNonce,
  writeOccurrenceEvent,
  type DomainCtx,
  type HouseholdSettings,
} from "../occurrence";
import { localDateOf } from "../time";
import { slotInstant, slotLocalDate } from "./slots";

export type SendVia = "push" | "digest";

/**
 * Mark `slotId` sent and schedule its successor. Returns the id of the newly inserted slot, or
 * `null` when the slot was not in a claimable state any more (someone else finished it).
 */
export function advanceSeriesAfterSend(
  tx: Db,
  ctx: DomainCtx,
  settings: HouseholdSettings,
  slotId: string,
  via: SendVia,
): string | null {
  const now = ctx.clock.now();
  const slot = tx.select().from(reminderSlot).where(eq(reminderSlot.id, slotId)).all()[0];
  if (!slot) return null;
  if (slot.state !== "claimed" && slot.state !== "pending") return null;

  const state = tx
    .select()
    .from(notificationRecipientState)
    .where(eq(notificationRecipientState.id, slot.recipientStateId))
    .all()[0];
  if (!state) return null;

  tx.update(reminderSlot)
    .set({ state: "sent", sentAtMs: now })
    .where(eq(reminderSlot.id, slot.id))
    .run();

  tx.update(notificationRecipientState)
    .set({
      lastSentAtMs: now,
      lastSentSlotIndex: slot.slotIndex,
      nextSlotIndex: slot.slotIndex + 1,
      // A snooze fire is over; the anchored series takes back over.
      ...(slot.isSnooze ? { state: "active" as const, snoozedUntilMs: null } : {}),
      updatedAtMs: now,
    })
    .where(eq(notificationRecipientState.id, state.id))
    .run();

  const nextIndex = slot.slotIndex + 1;
  const nextId = newId();
  const inserted = tx
    .insert(reminderSlot)
    .values({
      id: nextId,
      recipientStateId: state.id,
      slotIndex: nextIndex,
      scheduledAtMs: slotInstant(
        state.anchorDate,
        nextIndex,
        settings.reminderIntervalDays,
        settings.deliveryTime,
        settings.timezone,
      ),
      scheduledLocalDate: slotLocalDate(state.anchorDate, nextIndex, settings.reminderIntervalDays),
      state: "pending",
      isSnooze: false,
      nonce: newNonce(),
      createdAtMs: now,
    })
    // `ux_slot_one_open` is the guard: if a slot is somehow already open, this insert is a no-op
    // rather than a crash.
    .onConflictDoNothing()
    .run();

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: state.occurrenceId,
    kind: "notified",
    detail: {
      recipientUserId: state.recipientUserId,
      slotIndex: slot.slotIndex,
      consolidatedCount: slot.consolidatedCount,
      consolidatedFromIndex: slot.consolidatedFromIndex,
      isSnooze: slot.isSnooze,
      via,
      sentLocalDate: localDateOf(now, settings.timezone),
    },
  });

  return inserted.changes === 1 ? nextId : null;
}
