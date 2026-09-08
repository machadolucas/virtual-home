/**
 * Notification payloads, the tag scheme, and the `Done`-vs-`Complete…` decision (§4.6).
 *
 * The tag (`vh:occ:<occurrenceId>:<recipientUserId>`) is stable for the whole life of an
 * occurrence, which is what makes week 3's reminder *replace* week 2's on the phone instead of
 * stacking, and what makes a `clear` command idempotent.
 *
 * `allowQuickDone` is evaluated **at send time** and the result is frozen into
 * `reminder_slot.offered_actions_json`, so an inbound action is validated against what was
 * actually offered rather than against what the rules would say today.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { assetConsumable } from "@/db/schema/assets";
import { part, partLot, partStock } from "@/db/schema/inventory";
import { maintenancePlan, planMaterial } from "@/db/schema/maintenance";
import { procedureChecklistItem, procedureMaterial } from "@/db/schema/procedures";
import type { OccurrenceRow } from "../occurrence";
import { daysBetweenLocal, type LocalDate } from "../time";
import type { RecipientStateRow, ReminderSlotRow } from "./recipients";

export const NOTIFY_GROUP = "virtual-home-maintenance";
export const NOTIFY_THREAD_ID = "virtual-home";

export const ACTION_SNOOZE = "vh_snooze";
export const ACTION_DONE = "vh_done";
export const ACTION_URI = "URI";

export interface HaNotifyAction {
  action: string;
  title: string;
  uri?: string;
}

export interface HaNotifyActionData {
  v: 1;
  occurrenceId: string;
  recipientUserId: string;
  slotId: string;
  nonce: string;
}

export interface HaNotifyPayload {
  title: string;
  message: string;
  data: {
    tag: string;
    url: string;
    group: string;
    push: { "thread-id": string };
    actions: HaNotifyAction[];
    action_data: HaNotifyActionData;
  };
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `'2027-01-04'` → `'4 Jan'`. Notification bodies are read at a glance, not parsed. */
export function shortDate(d: LocalDate): string {
  const [, month, day] = d.split("-");
  const monthIndex = Number(month) - 1;
  return `${Number(day)} ${MONTH_ABBR[monthIndex] ?? month}`;
}

/**
 * Body wording (§4.5 rule 8): "Due today" for slot 0, "Overdue by N days" for later slots, and
 * the consolidated wording when one send stands for several missed reminders.
 */
export function bodyFor(slot: ReminderSlotRow, state: RecipientStateRow): string {
  if (slot.consolidatedCount > 1) {
    return `Overdue since ${shortDate(state.anchorDate)} · ${slot.consolidatedCount} reminders while offline`;
  }
  if (slot.slotIndex === 0) return "Due today";
  const days = daysBetweenLocal(state.anchorDate, slot.scheduledLocalDate);
  return `Overdue by ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * `true` only when nothing needs to be recorded or chosen, so a one-tap `Done` cannot lose
 * information:
 *  - no required material line, or every required line is an unambiguous, sufficiently stocked
 *    part (`plan_material` ∪ `procedure_material` ∪ `asset_consumable`);
 *  - no checklist item that requires a value;
 *  - the plan does not require a professional.
 *
 * Availability comes from the `part_stock` view's `on_hand_milli`, not `effective_milli`:
 * `effective_milli` is relative to the real wall clock, and every scheduling decision here must be
 * reproducible under an injected clock.
 */
export function allowQuickDone(tx: Db, occ: OccurrenceRow): boolean {
  if (occ.planId !== null) {
    const plan = tx.select().from(maintenancePlan).where(eq(maintenancePlan.id, occ.planId)).all()[0];
    if (plan?.requiresProfessional) return false;
  }

  if (occ.procedureVersionId !== null) {
    const checklist = tx
      .select({ requiresValue: procedureChecklistItem.requiresValue })
      .from(procedureChecklistItem)
      .where(eq(procedureChecklistItem.versionId, occ.procedureVersionId))
      .all();
    if (checklist.some((item) => item.requiresValue !== null)) return false;
  }

  // Required material lines, plan winning on a conflicting part.
  const required = new Map<string, number>();
  if (occ.procedureVersionId !== null) {
    for (const row of tx
      .select()
      .from(procedureMaterial)
      .where(eq(procedureMaterial.versionId, occ.procedureVersionId))
      .all()) {
      if (row.isRequired) required.set(row.partId, row.qtyMilli);
    }
  }
  if (occ.assetId !== null) {
    for (const row of tx
      .select()
      .from(assetConsumable)
      .where(eq(assetConsumable.assetId, occ.assetId))
      .all()) {
      required.set(row.partId, (required.get(row.partId) ?? 0) + row.qtyMilli);
    }
  }
  if (occ.planId !== null) {
    for (const row of tx.select().from(planMaterial).where(eq(planMaterial.planId, occ.planId)).all()) {
      if (row.isRequired) required.set(row.partId, row.qtyMilli);
      else required.delete(row.partId);
    }
  }
  if (required.size === 0) return true;

  const partIds = [...required.keys()];
  const parts = tx.select().from(part).where(inArray(part.id, partIds)).all();
  const stock = tx.select().from(partStock).where(inArray(partStock.partId, partIds)).all();
  const onHand = new Map(stock.map((row) => [row.partId, row.onHandMilli]));

  for (const partId of partIds) {
    const partRow = parts.find((p) => p.id === partId);
    // Unknown, kit or not-stocked parts all need a human decision before anything is consumed.
    if (!partRow || partRow.isKit || partRow.stockMode !== "stocked") return false;
    if (partRow.tracksLots) {
      const lots = tx
        .select({ id: partLot.id })
        .from(partLot)
        .where(and(eq(partLot.partId, partId), eq(partLot.isOpen, true)))
        .all();
      if (lots.length !== 1) return false; // no lot, or a choice to make
    }
    if ((onHand.get(partId) ?? 0) < (required.get(partId) ?? 0)) return false;
  }
  return true;
}

/** The actions offered on a notification, in the order the phone shows them. */
export function decideActions(occ: OccurrenceRow, baseUrl: string, quickDone: boolean): HaNotifyAction[] {
  const actions: HaNotifyAction[] = [
    { action: ACTION_URI, title: "Open", uri: `${baseUrl}/tasks/${occ.id}` },
    { action: ACTION_SNOOZE, title: "Snooze 1 day" },
  ];
  actions.push(
    quickDone
      ? { action: ACTION_DONE, title: "Done" }
      : { action: ACTION_URI, title: "Complete…", uri: `${baseUrl}/tasks/${occ.id}/complete` },
  );
  return actions;
}

/** The action ids stored in `reminder_slot.offered_actions_json`. */
export function offeredActionIds(actions: HaNotifyAction[]): string[] {
  return [...new Set(actions.map((a) => a.action))];
}

/** The exact HA service data for one reminder. */
export function buildNotifyPayload(
  slot: ReminderSlotRow,
  state: RecipientStateRow,
  occ: OccurrenceRow,
  baseUrl: string,
  actions: HaNotifyAction[],
): HaNotifyPayload {
  return {
    title: occ.title,
    message: bodyFor(slot, state),
    data: {
      tag: state.tag,
      url: `${baseUrl}/tasks/${occ.id}`,
      group: NOTIFY_GROUP,
      push: { "thread-id": NOTIFY_THREAD_ID },
      actions,
      action_data: {
        v: 1,
        occurrenceId: occ.id,
        recipientUserId: state.recipientUserId,
        slotId: slot.id,
        nonce: slot.nonce,
      },
    },
  };
}

/** `{ message: 'clear_notification', data: { tag } }` — the only payload a clear needs. */
export function buildClearPayload(tag: string): { message: string; data: { tag: string } } {
  return { message: "clear_notification", data: { tag } };
}

/**
 * The catch-up digest (§4.5 rule 5): after an outage, one push saying "5 tasks are overdue" beats
 * five separate ones. Every underlying slot is still advanced, so the weekly rhythm continues.
 */
export function buildDigestPayload(
  userId: string,
  count: number,
  baseUrl: string,
): { title: string; message: string; data: Record<string, unknown> } {
  return {
    title: "Maintenance catch-up",
    message: `${count} ${count === 1 ? "task is" : "tasks are"} overdue`,
    data: {
      tag: `vh:digest:${userId}`,
      url: `${baseUrl}/tasks`,
      group: NOTIFY_GROUP,
      push: { "thread-id": NOTIFY_THREAD_ID },
      actions: [{ action: ACTION_URI, title: "Open", uri: `${baseUrl}/tasks` }],
    },
  };
}
