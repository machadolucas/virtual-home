/**
 * Helpers shared by the notification-engine tests (§9 items 51–68).
 *
 * Nothing here reads the system clock or opens a socket: the tick and the drain both take an
 * injected `Clock`, and the drain takes an injected `sender`, so a "Home Assistant outage" is a
 * boolean on a fake object rather than a network condition.
 */
import { and, asc, eq } from "drizzle-orm";
import { appAlert } from "@/db/schema/inventory";
import { occurrenceEvent } from "@/db/schema/maintenance";
import {
  deliveryAttempt,
  haNotifyCommand,
  notificationActionEvent,
  notificationRecipientState,
  reminderSlot,
  workerLease,
} from "@/db/schema/notifications";
import type { HouseholdSettings } from "@/domain/occurrence";
import { drainOutbox, type DrainOutboxResult, type SendOutcome } from "@/domain/notify/outbox";
import { runNotificationTick, type TickResult } from "@/domain/notify/tick";
import type { NotifyCommandRow } from "@/domain/notify/recipients";
import type { TestWorld } from "./fixtures";

export type CommandRow = typeof haNotifyCommand.$inferSelect;
export type SlotRow = typeof reminderSlot.$inferSelect;
export type StateRow = typeof notificationRecipientState.$inferSelect;
export type AttemptRow = typeof deliveryAttempt.$inferSelect;

/** One scheduling pass. Defaults to worker `w1`, the only worker most tests need. */
export function tick(
  world: TestWorld,
  workerId = "w1",
  settings?: Partial<HouseholdSettings>,
): TickResult {
  return runNotificationTick({
    handle: world.handle,
    clock: world.clock,
    workerId,
    ...(settings ? { settings } : {}),
  });
}

export interface FakeHaSender {
  /** Flip to `false` to simulate an HA outage; every call then reports `ha_unavailable`. */
  connected: boolean;
  /** Every command the drain handed over, in order. */
  calls: NotifyCommandRow[];
  /** Called before each send; return an outcome to override, or `undefined` for the default. */
  onSend?: (command: NotifyCommandRow) => SendOutcome | undefined;
  sender(command: NotifyCommandRow): Promise<SendOutcome>;
}

/**
 * A stand-in for the HA service call. `connected = false` is the outage every retry/backoff test
 * needs; `onSend` is the hook the fence and crash tests use to interfere mid-flight.
 */
export function fakeHaSender(): FakeHaSender {
  const fake: FakeHaSender = {
    connected: true,
    calls: [],
    async sender(command) {
      const override = fake.onSend?.(command);
      if (override !== undefined) {
        if (override === "accepted") fake.calls.push(command);
        return override;
      }
      if (!fake.connected) return "ha_unavailable";
      fake.calls.push(command);
      return "accepted";
    },
  };
  return fake;
}

/** One outbox drain against `sender`. */
export function drain(
  world: TestWorld,
  sender: FakeHaSender,
  workerId = "w1",
  limit?: number,
): Promise<DrainOutboxResult> {
  return drainOutbox({
    handle: world.handle,
    clock: world.clock,
    workerId,
    sender: (command) => sender.sender(command),
    ...(limit === undefined ? {} : { limit }),
  });
}

/** Tick, then drain — what a minute of worker time does when HA is reachable. */
export async function tickAndDrain(
  world: TestWorld,
  sender: FakeHaSender,
  workerId = "w1",
): Promise<{ tick: TickResult; drain: DrainOutboxResult }> {
  const t = tick(world, workerId);
  const d = await drain(world, sender, workerId);
  return { tick: t, drain: d };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export function statesOf(world: TestWorld, occurrenceId: string): StateRow[] {
  return world.handle.db
    .select()
    .from(notificationRecipientState)
    .where(eq(notificationRecipientState.occurrenceId, occurrenceId))
    .all();
}

export function stateOf(world: TestWorld, occurrenceId: string, userId: string): StateRow {
  const row = world.handle.db
    .select()
    .from(notificationRecipientState)
    .where(
      and(
        eq(notificationRecipientState.occurrenceId, occurrenceId),
        eq(notificationRecipientState.recipientUserId, userId),
      ),
    )
    .all()[0];
  if (!row) throw new Error(`no recipient state for ${occurrenceId}/${userId}`);
  return row;
}

/** Every slot of a recipient state, oldest first. */
export function slotsOf(world: TestWorld, recipientStateId: string): SlotRow[] {
  return world.handle.db
    .select()
    .from(reminderSlot)
    .where(eq(reminderSlot.recipientStateId, recipientStateId))
    .orderBy(asc(reminderSlot.createdAtMs), asc(reminderSlot.slotIndex))
    .all();
}

export function openSlot(world: TestWorld, recipientStateId: string): SlotRow | undefined {
  return slotsOf(world, recipientStateId).find(
    (slot) => slot.state === "pending" || slot.state === "claimed",
  );
}

export function commands(world: TestWorld): CommandRow[] {
  return world.handle.db
    .select()
    .from(haNotifyCommand)
    .orderBy(asc(haNotifyCommand.createdAtMs), asc(haNotifyCommand.id))
    .all();
}

export function notifyCommands(world: TestWorld): CommandRow[] {
  return commands(world).filter((row) => row.kind === "notify");
}

export function clearCommands(world: TestWorld): CommandRow[] {
  return commands(world).filter((row) => row.kind === "clear");
}

export function attemptsOf(world: TestWorld, commandId: string): AttemptRow[] {
  return world.handle.db
    .select()
    .from(deliveryAttempt)
    .where(eq(deliveryAttempt.commandId, commandId))
    .orderBy(asc(deliveryAttempt.attemptNo))
    .all();
}

export function alerts(world: TestWorld) {
  return world.handle.db.select().from(appAlert).all();
}

export function actionEvents(world: TestWorld) {
  return world.handle.db
    .select()
    .from(notificationActionEvent)
    .orderBy(asc(notificationActionEvent.receivedAtMs))
    .all();
}

export interface NotifiedEvent {
  slotIndex: number;
  consolidatedCount: number;
  consolidatedFromIndex: number | null;
  isSnooze: boolean;
  via: string;
  recipientUserId: string;
}

/** The `occurrence_event('notified')` details — where the digest/consolidation record lives. */
export function notifiedEvents(world: TestWorld, occurrenceId: string): NotifiedEvent[] {
  return world.handle.db
    .select()
    .from(occurrenceEvent)
    .where(and(eq(occurrenceEvent.occurrenceId, occurrenceId), eq(occurrenceEvent.kind, "notified")))
    .orderBy(asc(occurrenceEvent.atMs))
    .all()
    .map((row) => JSON.parse(row.detailJson ?? "{}") as NotifiedEvent);
}

export function leaseOf(world: TestWorld, name: string) {
  return world.handle.db.select().from(workerLease).where(eq(workerLease.name, name)).all()[0];
}

/** The parsed `payload_json` of a command. */
export function payloadOf(command: CommandRow): {
  title: string;
  message: string;
  data: {
    tag: string;
    url: string;
    actions: Array<{ action: string; title: string; uri?: string }>;
    action_data?: { v: number; occurrenceId: string; recipientUserId: string; slotId: string; nonce: string };
  };
} {
  return JSON.parse(command.payloadJson);
}

/** `Date.parse`, but loud when the literal is wrong — a silent `NaN` would pass every assertion. */
export function at(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`unparseable instant: ${iso}`);
  return ms;
}
