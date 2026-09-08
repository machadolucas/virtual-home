/**
 * Inbound HA notification actions (§4.7).
 *
 * Every event is recorded, accepted or not — `notification_action_event` is both the forensic log
 * and the replay guard. Nothing is trusted from the payload: the nonce identifies the slot, and
 * every field the phone asserts (`occurrenceId`, `recipientUserId`, `slotId`) is checked against
 * what the database says about that slot.
 *
 * Replay protection is two-layered and both layers matter:
 *  1. `ux_action_replay` — the *second* accepted `(nonce, action)` write fails at the database, and
 *     the handler turns that failure into `validation='duplicate'`, `applied_effect='noop'`;
 *  2. `completion.request_id = 'act:' + nonce` — even if layer 1 were bypassed by a race, the
 *     completion transaction returns the existing completion and deducts no stock twice.
 */
import { and, eq } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import { userNotifyDevice } from "@/db/schema/household";
import { maintenanceOccurrence } from "@/db/schema/maintenance";
import {
  notificationActionEvent,
  notificationRecipientState,
  reminderSlot,
  type ActionEffect,
  type ActionValidation,
} from "@/db/schema/notifications";
import {
  loadHousehold,
  snooze,
  type DomainCtx,
  type HouseholdSettings,
} from "../occurrence";
import { addDaysLocal, instantOf, localDateOf, type Clock } from "../time";
import { ACTION_DONE, ACTION_SNOOZE } from "./payload";

/** The `mobile_app_notification_action` event, already unwrapped by the HA listener. */
export interface NotificationActionEvent {
  /** `'vh_snooze'`, `'vh_done'`, … — exactly what HA reported. */
  action: string;
  /** The echoed `action_data`; untrusted, validated field by field. */
  actionData?: unknown;
  /** `event.data.device_name`, used only to detect the other user's phone. */
  deviceName?: string | null;
  haContextId?: string | null;
  /** The whole event, stored verbatim for forensics. */
  raw?: unknown;
}

export interface CompleteFromActionInput {
  occurrenceId: string;
  recipientUserId: string;
  /** `'act:' + nonce` — the idempotency key that makes a doubled tap one completion. */
  requestId: string;
}

/**
 * Whatever the completion module hands back. Deliberately structural and permissive: this file
 * only needs the id of the completion to link it from `notification_action_event`, and must not
 * import the completion module (which owns the stock ledger and would make the dependency
 * circular).
 */
export type CompleteFromActionOutcome =
  | { completionId?: string | null; completion?: { id: string } | null }
  | void
  | null;

export interface ActionDeps {
  /**
   * Performs the quick completion. Implemented by the completion module (it owns the stock ledger
   * and the idempotency probe); injected here so this file stays about validation.
   */
  completeFromAction?: (input: CompleteFromActionInput) => CompleteFromActionOutcome;
}

export interface HandleActionInput {
  handle: DbHandle;
  clock: Clock;
  event: NotificationActionEvent;
  deps?: ActionDeps;
  settings?: Partial<HouseholdSettings>;
}

export interface HandleActionResult {
  eventId: string;
  validation: ActionValidation;
  appliedEffect: ActionEffect | null;
  completionId: string | null;
}

interface ParsedActionData {
  v?: unknown;
  occurrenceId?: unknown;
  recipientUserId?: unknown;
  slotId?: unknown;
  nonce?: unknown;
}

function parseActionData(value: unknown): ParsedActionData {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as ParsedActionData;
    } catch {
      return {};
    }
  }
  if (value !== null && typeof value === "object") return value as ParsedActionData;
  return {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("UNIQUE constraint failed");
}

/** Sentinel: the replay gate rejected this event, so the transaction must roll back. */
const DUPLICATE = Symbol("duplicate-action");

/**
 * Validate and apply one inbound action.
 *
 * `vh_snooze` is applied inside the gating transaction (it is cheap and purely additive).
 * `vh_done` is delegated *after* the gate commits, because the completion transaction owns the
 * stock ledger and carries its own idempotency key.
 */
export function handleNotificationAction(input: HandleActionInput): HandleActionResult {
  const { handle, clock, event } = input;
  const db = handle.db;
  const stored = writeTx(db, (tx) => loadHousehold(tx));
  const settings: HouseholdSettings = { ...stored, ...input.settings };

  const data = parseActionData(event.actionData);
  const nonce = asString(data.nonce);
  const eventId = newId();

  // Pessimistic default: the row exists before anything is trusted.
  writeTx(db, (tx) => {
    tx.insert(notificationActionEvent)
      .values({
        id: eventId,
        receivedAtMs: clock.now(),
        haContextId: event.haContextId ?? null,
        nonce,
        action: event.action,
        rawJson: JSON.stringify(event.raw ?? event),
        claimedOccurrenceId: asString(data.occurrenceId),
        claimedRecipientUserId: asString(data.recipientUserId),
        claimedSlotId: asString(data.slotId),
        sourceDeviceName: event.deviceName ?? null,
        validation: "malformed",
      })
      .run();
  });

  const finish = (validation: ActionValidation, effect: ActionEffect | null): HandleActionResult => {
    writeTx(db, (tx) => {
      tx.update(notificationActionEvent)
        .set({ validation, appliedEffect: effect, processedAtMs: clock.now() })
        .where(eq(notificationActionEvent.id, eventId))
        .run();
    });
    return { eventId, validation, appliedEffect: effect, completionId: null };
  };

  let outcome: { validation: ActionValidation; effect: ActionEffect | null; done?: { occurrenceId: string; recipientUserId: string; nonce: string } };
  try {
    outcome = writeTx(db, (tx) =>
      validateAndApply(tx, { clock, settings }, eventId, event, data, nonce),
    );
  } catch (err) {
    if (err === DUPLICATE) return finish("duplicate", "noop");
    throw err;
  }

  if (outcome.validation !== "accepted") return finish(outcome.validation, outcome.effect);

  if (outcome.done) {
    const completed = input.deps?.completeFromAction?.({
      occurrenceId: outcome.done.occurrenceId,
      recipientUserId: outcome.done.recipientUserId,
      requestId: `act:${outcome.done.nonce}`,
    });
    // Either spelling is accepted (`{ completion }` is what `completeOccurrence` returns).
    const completionId = completed ? (completed.completion?.id ?? completed.completionId ?? null) : null;
    writeTx(db, (tx) => {
      tx.update(notificationActionEvent)
        .set({ appliedEffect: "completed", completionId, processedAtMs: clock.now() })
        .where(eq(notificationActionEvent.id, eventId))
        .run();
    });
    return { eventId, validation: "accepted", appliedEffect: "completed", completionId };
  }

  return { eventId, validation: "accepted", appliedEffect: outcome.effect, completionId: null };
}

function validateAndApply(
  tx: Db,
  env: { clock: Clock; settings: HouseholdSettings },
  eventId: string,
  event: NotificationActionEvent,
  data: ParsedActionData,
  nonce: string | null,
): {
  validation: ActionValidation;
  effect: ActionEffect | null;
  done?: { occurrenceId: string; recipientUserId: string; nonce: string };
} {
  const { clock, settings } = env;
  const now = clock.now();
  const reject = (validation: ActionValidation) => ({ validation, effect: "noop" as ActionEffect });

  if (nonce === null || data.v !== 1) return reject("malformed");

  const slot = tx.select().from(reminderSlot).where(eq(reminderSlot.nonce, nonce)).all()[0];
  if (!slot) return reject("unknown_nonce");

  const state = tx
    .select()
    .from(notificationRecipientState)
    .where(eq(notificationRecipientState.id, slot.recipientStateId))
    .all()[0];
  if (!state) return reject("unknown_nonce");

  if (state.recipientUserId !== asString(data.recipientUserId)) return reject("wrong_recipient");
  if (state.occurrenceId !== asString(data.occurrenceId)) return reject("wrong_recipient");
  if (slot.id !== asString(data.slotId)) return reject("malformed");

  if (now - slot.createdAtMs > settings.actionTtlDays * 86_400_000) return reject("expired");

  const offered: unknown = JSON.parse(slot.offeredActionsJson ?? "[]");
  const offeredIds = Array.isArray(offered) ? offered.map((id) => String(id)) : [];
  if (!offeredIds.includes(event.action)) return reject("action_not_offered");

  // A tap arriving from the *other* user's phone is logged and ignored, never acted on.
  if (event.deviceName) {
    const device = tx
      .select()
      .from(userNotifyDevice)
      .where(eq(userNotifyDevice.haDeviceName, event.deviceName))
      .all()[0];
    if (device && device.userId !== state.recipientUserId) return reject("device_mismatch");
  }

  const occ = tx
    .select()
    .from(maintenanceOccurrence)
    .where(eq(maintenanceOccurrence.id, state.occurrenceId))
    .all()[0];
  if (!occ) return reject("occurrence_closed");
  // A stale tap after somebody already completed the task is a no-op, which is the correct
  // failure mode for a notification that could not be cleared while HA was down.
  if (occ.status !== "pending" && occ.status !== "due") return reject("occurrence_closed");

  // ---- the replay gate. This UPDATE is the atomic guard; a UNIQUE failure rolls everything back.
  try {
    tx.update(notificationActionEvent)
      .set({ validation: "accepted", processedAtMs: now })
      .where(eq(notificationActionEvent.id, eventId))
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw DUPLICATE;
    throw err;
  }

  const ctx: DomainCtx = {
    clock,
    tz: settings.timezone,
    actorUserId: state.recipientUserId,
    actorKind: "ha",
  };

  // The closest thing to "delivered" we ever observe.
  tx.update(notificationRecipientState)
    .set({ interactedAtMs: state.interactedAtMs ?? now, updatedAtMs: now })
    .where(eq(notificationRecipientState.id, state.id))
    .run();

  if (event.action === ACTION_SNOOZE) {
    const until = instantOf(
      addDaysLocal(localDateOf(now, settings.timezone), 1),
      settings.deliveryTime,
      settings.timezone,
    );
    snooze(tx, ctx, occ.id, state.recipientUserId, until);
    tx.update(notificationActionEvent)
      .set({ appliedEffect: "snoozed" })
      .where(eq(notificationActionEvent.id, eventId))
      .run();
    return { validation: "accepted", effect: "snoozed" };
  }

  if (event.action === ACTION_DONE) {
    return {
      validation: "accepted",
      effect: null,
      done: { occurrenceId: occ.id, recipientUserId: state.recipientUserId, nonce },
    };
  }

  return { validation: "accepted", effect: "noop" };
}

/** Has this `(nonce, action)` already been accepted? Cheap pre-check for the HA listener. */
export function alreadyAccepted(handle: DbHandle, nonce: string, action: string): boolean {
  return (
    handle.db
      .select({ id: notificationActionEvent.id })
      .from(notificationActionEvent)
      .where(
        and(
          eq(notificationActionEvent.nonce, nonce),
          eq(notificationActionEvent.action, action),
          eq(notificationActionEvent.validation, "accepted"),
        ),
      )
      .all().length > 0
  );
}
