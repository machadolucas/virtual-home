/**
 * The scheduling tick (§4.4). Runs every minute, guarded by the `notification_tick` lease.
 *
 * Eight phases, **each in its own short `writeTx`** (CLAUDE.md rule 3): one long transaction over
 * every open occurrence would hold the single WAL writer for the whole tick and starve the web
 * process. Every phase is idempotent, so a crash between phases costs nothing but a repeat.
 *
 *   1. materialise `notification_recipient_state` for open occurrences
 *   2. `pending → due` at `instantOf(due_date, delivery_time, tz)`, and slot 0
 *   3. heal a live state that has no open slot
 *   4. fast-forward a late slot to `nStar` (one send, never a replay)
 *   5. hold a late slot that would land outside the send window
 *   6. per-recipient digest decision
 *   7. claim + enqueue one `ha_notify_command` per active device
 *   8. heartbeat, so the next start can tell an outage happened
 */
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import {
  OCCURRENCE_OPEN_STATUSES,
  maintenanceOccurrence,
  type OccurrenceStatus,
} from "@/db/schema/maintenance";
import {
  SLOT_OPEN_STATES,
  haNotifyCommand,
  notificationRecipientState,
  reminderSlot,
  workerHeartbeat,
} from "@/db/schema/notifications";
import {
  loadHousehold,
  newNonce,
  writeOccurrenceEvent,
  type DomainCtx,
  type HouseholdSettings,
  type OccurrenceRow,
} from "../occurrence";
import { instantOf, localDateOf, type Clock } from "../time";
import { raiseAppAlert } from "./alerts";
import { DEFAULT_LEASE_TTL_MS, LEASE_NOTIFICATION_TICK, acquireLease } from "./lease";
import {
  allowQuickDone,
  buildDigestPayload,
  buildNotifyPayload,
  decideActions,
  offeredActionIds,
} from "./payload";
import {
  LIVE_RECIPIENT_STATES,
  activeDevices,
  digestTagFor,
  ensureRecipientStates,
  type RecipientStateRow,
  type ReminderSlotRow,
} from "./recipients";
import { advanceSeriesAfterSend } from "./series";
import { isInSendWindow, nStar, nextSendWindowOpen, slotInstant, slotLocalDate } from "./slots";

/** A claim is good for two minutes; a worker killed mid-send loses it and the next tick retries. */
export const CLAIM_TTL_MS = 120_000;

export interface RunTickInput {
  handle: DbHandle;
  clock: Clock;
  workerId: string;
  /** Override for tests and for settings the schema has no column for (e.g. `appBaseUrl`). */
  settings?: Partial<HouseholdSettings>;
  /** Lease TTL; defaults to 90 s. */
  leaseTtlMs?: number;
}

export interface TickResult {
  /** `false` when another worker holds the lease — the whole tick is a no-op. */
  ran: boolean;
  fence: number | null;
  inCatchUp: boolean;
  outageMs: number;
  /** Slots whose claim had expired (worker killed mid-send) and were returned to `pending`. */
  slotsReclaimed: number;
  becameDue: string[];
  slotsCreated: number;
  slotsHealed: number;
  slotsFastForwarded: number;
  slotsHeld: number;
  slotsClaimed: number;
  slotsFailed: number;
  commandsQueued: number;
  digestsSent: number;
}

interface ReadySlot {
  slot: ReminderSlotRow;
  state: RecipientStateRow;
  occ: OccurrenceRow;
}

function ctxFor(clock: Clock, settings: HouseholdSettings): DomainCtx {
  return { clock, tz: settings.timezone, actorUserId: null, actorKind: "worker" };
}

function openOccurrences(tx: Db): OccurrenceRow[] {
  return tx
    .select()
    .from(maintenanceOccurrence)
    .where(inArray(maintenanceOccurrence.status, [...OCCURRENCE_OPEN_STATUSES]))
    .all();
}

/** Pending slots that are due to fire and not parked outside the send window. */
function readySlots(tx: Db, now: number): ReadySlot[] {
  const rows = tx
    .select({ slot: reminderSlot, state: notificationRecipientState, occ: maintenanceOccurrence })
    .from(reminderSlot)
    .innerJoin(
      notificationRecipientState,
      eq(notificationRecipientState.id, reminderSlot.recipientStateId),
    )
    .innerJoin(
      maintenanceOccurrence,
      eq(maintenanceOccurrence.id, notificationRecipientState.occurrenceId),
    )
    .where(
      and(
        eq(reminderSlot.state, "pending"),
        lte(reminderSlot.scheduledAtMs, now),
        or(isNull(reminderSlot.heldUntilMs), lte(reminderSlot.heldUntilMs, now)),
        inArray(notificationRecipientState.state, [...LIVE_RECIPIENT_STATES]),
        inArray(maintenanceOccurrence.status, [...OCCURRENCE_OPEN_STATUSES]),
      ),
    )
    .all();
  return rows;
}

/**
 * One scheduling pass. Returns a summary the worker logs and the tests assert on.
 *
 * Never throws for ordinary trouble (a recipient without a device, a slot someone else claimed):
 * those become `app_alert` rows and `failed` slots, because a tick that dies takes every other
 * task's reminder with it.
 */
export function runNotificationTick(input: RunTickInput): TickResult {
  const { handle, clock, workerId } = input;
  const db = handle.db;
  const now = clock.now();

  const stored = writeTx(db, (tx) => loadHousehold(tx));
  const settings: HouseholdSettings = { ...stored, ...input.settings };
  const ctx = ctxFor(clock, settings);

  const result: TickResult = {
    ran: false,
    fence: null,
    inCatchUp: false,
    outageMs: 0,
    slotsReclaimed: 0,
    becameDue: [],
    slotsCreated: 0,
    slotsHealed: 0,
    slotsFastForwarded: 0,
    slotsHeld: 0,
    slotsClaimed: 0,
    slotsFailed: 0,
    commandsQueued: 0,
    digestsSent: 0,
  };

  // ---- lease + outage detection -------------------------------------------------------------
  const fence = writeTx(db, (tx) =>
    acquireLease(tx, LEASE_NOTIFICATION_TICK, workerId, input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, now),
  );
  if (fence === null) return result;
  result.ran = true;
  result.fence = fence;

  const heartbeat = db
    .select()
    .from(workerHeartbeat)
    .where(eq(workerHeartbeat.name, LEASE_NOTIFICATION_TICK))
    .all()[0];
  result.outageMs = heartbeat?.lastOkMs ? now - heartbeat.lastOkMs : 0;
  result.inCatchUp = result.outageMs > settings.catchupGapMinutes * 60_000;

  // A worker killed between claiming a slot and finishing the send left the slot `claimed`. Its
  // claim has an expiry precisely so the next tick can take it back; re-enqueueing is harmless
  // because `notify:<slotId>:<service>` is the command's dedupe key.
  result.slotsReclaimed = reclaimExpiredSlots(handle, now);

  writeTx(db, (tx) => {
    tx.insert(workerHeartbeat)
      .values({
        name: LEASE_NOTIFICATION_TICK,
        workerId,
        lastTickStartedMs: now,
        tickCount: 0,
      })
      .onConflictDoUpdate({
        target: workerHeartbeat.name,
        set: { workerId, lastTickStartedMs: now },
      })
      .run();
  });

  // ---- PHASE 1: materialise recipient states ------------------------------------------------
  for (const occ of writeTx(db, (tx) => openOccurrences(tx))) {
    writeTx(db, (tx) => {
      const fresh = tx
        .select()
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.id, occ.id))
        .all()[0];
      if (!fresh || (fresh.status !== "pending" && fresh.status !== "due")) return;
      ensureRecipientStates(tx, ctx, fresh);
    });
  }

  // ---- PHASE 2: pending -> due, and slot 0 --------------------------------------------------
  const pending = db
    .select()
    .from(maintenanceOccurrence)
    .where(eq(maintenanceOccurrence.status, "pending"))
    .all();
  for (const occ of pending) {
    // Not one tick earlier: the boundary is the delivery-time instant on the due date.
    if (now < instantOf(occ.dueDate, settings.deliveryTime, settings.timezone)) continue;
    writeTx(db, (tx) => {
      const fresh = tx
        .select()
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.id, occ.id))
        .all()[0];
      if (!fresh || fresh.status !== "pending") return;
      tx.update(maintenanceOccurrence)
        .set({ status: "due" satisfies OccurrenceStatus, becameDueAtMs: now, updatedAtMs: now })
        .where(eq(maintenanceOccurrence.id, fresh.id))
        .run();
      writeOccurrenceEvent(tx, ctx, {
        occurrenceId: fresh.id,
        kind: "became_due",
        fromStatus: "pending",
        toStatus: "due",
        toDueDate: fresh.dueDate,
      });
      result.becameDue.push(fresh.id);
      result.slotsCreated += createMissingSlots(tx, settings, fresh.id, now);
    });
  }

  // ---- PHASE 3: heal missing slots ----------------------------------------------------------
  const dueOccurrences = db
    .select({ id: maintenanceOccurrence.id })
    .from(maintenanceOccurrence)
    .where(eq(maintenanceOccurrence.status, "due"))
    .all();
  for (const { id } of dueOccurrences) {
    result.slotsHealed += writeTx(db, (tx) => createMissingSlots(tx, settings, id, now));
  }

  // ---- PHASE 4: fast-forward (catch-up consolidation) ---------------------------------------
  for (const { slot, state } of readySlots(db, now)) {
    // A snooze fire is never consolidated: it fires once and hands back to the anchored series.
    if (slot.isSnooze) continue;
    const target = nStar(
      state.anchorDate,
      slot.slotIndex,
      settings.reminderIntervalDays,
      settings.deliveryTime,
      settings.timezone,
      now,
    );
    if (target <= slot.slotIndex) continue;
    const from = slot.consolidatedFromIndex ?? slot.slotIndex;
    const changed = writeTx(db, (tx) =>
      tx
        .update(reminderSlot)
        .set({
          slotIndex: target,
          scheduledAtMs: slotInstant(
            state.anchorDate,
            target,
            settings.reminderIntervalDays,
            settings.deliveryTime,
            settings.timezone,
          ),
          scheduledLocalDate: slotLocalDate(state.anchorDate, target, settings.reminderIntervalDays),
          consolidatedFromIndex: from,
          consolidatedCount: target - from + 1,
        })
        .where(and(eq(reminderSlot.id, slot.id), eq(reminderSlot.state, "pending")))
        .run(),
    );
    result.slotsFastForwarded += changed.changes;
  }

  // ---- PHASE 5: send-window guard -----------------------------------------------------------
  const graceMs = settings.slotGraceMinutes * 60_000;
  for (const { slot } of readySlots(db, now)) {
    const lateBy = now - slot.scheduledAtMs;
    if (lateBy <= graceMs) continue; // on time always sends, even at 06:00
    if (isInSendWindow(now, settings.timezone, settings.sendWindowStart, settings.sendWindowEnd)) {
      continue;
    }
    const holdUntil = nextSendWindowOpen(
      now,
      settings.timezone,
      settings.sendWindowStart,
      settings.sendWindowEnd,
      localDateOf(now, settings.timezone),
    );
    const changed = writeTx(db, (tx) =>
      tx
        .update(reminderSlot)
        .set({ heldUntilMs: holdUntil })
        .where(and(eq(reminderSlot.id, slot.id), eq(reminderSlot.state, "pending")))
        .run(),
    );
    result.slotsHeld += changed.changes;
  }

  // ---- PHASE 6: digest decision, per recipient ----------------------------------------------
  const ready = readySlots(db, now);
  const byRecipient = new Map<string, ReadySlot[]>();
  for (const entry of ready) {
    const list = byRecipient.get(entry.state.recipientUserId) ?? [];
    list.push(entry);
    byRecipient.set(entry.state.recipientUserId, list);
  }

  for (const [userId, entries] of byRecipient) {
    const devices = writeTx(db, (tx) => activeDevices(tx, userId));
    const digest = result.inCatchUp && entries.length > settings.catchupDigestThreshold && devices.length > 0;
    if (digest) {
      writeTx(db, (tx) => {
        const commandIds: string[] = [];
        for (const device of devices) {
          const id = newId();
          const inserted = tx
            .insert(haNotifyCommand)
            .values({
              id,
              kind: "notify",
              notifyService: device.notifyService,
              payloadJson: JSON.stringify(
                buildDigestPayload(userId, entries.length, settings.appBaseUrl),
              ),
              tag: digestTagFor(userId),
              slotId: null,
              recipientStateId: null,
              dedupeKey: `notify:digest:${userId}:${now}:${device.notifyService}`,
              state: "queued",
              createdAtMs: now,
            })
            .onConflictDoNothing()
            .run();
          if (inserted.changes === 1) commandIds.push(id);
        }
        result.commandsQueued += commandIds.length;
        result.digestsSent += 1;
        // Each underlying slot is still advanced, so the weekly rhythm continues and nothing is
        // lost. `reminder_slot` has no `sent_via` column: the digest is recorded on the
        // `occurrence_event('notified')` detail instead.
        for (const entry of entries) {
          const claimed = claimSlot(tx, entry.slot.id, workerId, fence, now, null);
          if (!claimed) continue;
          advanceSeriesAfterSend(tx, ctx, settings, entry.slot.id, "digest");
        }
      });
      continue;
    }

    for (const entry of entries) {
      writeTx(db, (tx) => {
        const quickDone = allowQuickDone(tx, entry.occ);
        const actions = decideActions(entry.occ, settings.appBaseUrl, quickDone);
        const claimed = claimSlot(
          tx,
          entry.slot.id,
          workerId,
          fence,
          now,
          JSON.stringify(offeredActionIds(actions)),
        );
        if (!claimed) return; // someone else took it — `changes !== 1` is the whole guard
        result.slotsClaimed += 1;

        if (devices.length === 0) {
          tx.update(reminderSlot)
            .set({ state: "failed", cancelReason: "no_device" })
            .where(eq(reminderSlot.id, entry.slot.id))
            .run();
          result.slotsFailed += 1;
          result.slotsClaimed -= 1;
          raiseAppAlert(tx, ctx, {
            kind: "notify_device_missing",
            severity: "warning",
            title: "No notification device",
            body: `No active notify service for the recipient of "${entry.occ.title}"`,
            dedupeKey: `notify_device_missing:${userId}`,
            entityTable: "user",
            entityId: userId,
          });
          return;
        }

        for (const device of devices) {
          const inserted = tx
            .insert(haNotifyCommand)
            .values({
              id: newId(),
              kind: "notify",
              notifyService: device.notifyService,
              payloadJson: JSON.stringify(
                buildNotifyPayload(
                  { ...entry.slot, offeredActionsJson: JSON.stringify(offeredActionIds(actions)) },
                  entry.state,
                  entry.occ,
                  settings.appBaseUrl,
                  actions,
                ),
              ),
              tag: entry.state.tag,
              slotId: entry.slot.id,
              recipientStateId: entry.state.id,
              dedupeKey: `notify:${entry.slot.id}:${device.notifyService}`,
              state: "queued",
              createdAtMs: now,
            })
            .onConflictDoNothing()
            .run();
          result.commandsQueued += inserted.changes;
        }
      });
    }
  }

  // ---- PHASE 8: heartbeat -------------------------------------------------------------------
  const finishedAt = clock.now();
  writeTx(db, (tx) => {
    tx.update(workerHeartbeat)
      .set({
        lastTickFinishedMs: finishedAt,
        lastOkMs: finishedAt,
        tickCount: sql`${workerHeartbeat.tickCount} + 1`,
        lastError: null,
      })
      .where(eq(workerHeartbeat.name, LEASE_NOTIFICATION_TICK))
      .run();
  });

  return result;
}

/**
 * Claim a pending slot for this worker. `changes !== 1` means a sibling worker got there first,
 * which is exactly how two workers end up sending once between them (§4.3).
 */
function claimSlot(
  tx: Db,
  slotId: string,
  workerId: string,
  fence: number,
  now: number,
  offeredActionsJson: string | null,
): boolean {
  const changed = tx
    .update(reminderSlot)
    .set({
      state: "claimed",
      claimedBy: workerId,
      claimFence: fence,
      claimExpiresAtMs: now + CLAIM_TTL_MS,
      attemptCount: sql`${reminderSlot.attemptCount} + 1`,
      ...(offeredActionsJson === null ? {} : { offeredActionsJson }),
    })
    .where(and(eq(reminderSlot.id, slotId), eq(reminderSlot.state, "pending")))
    .run();
  return changed.changes === 1;
}

/**
 * Insert the missing slot for every live recipient state of an occurrence that has none.
 * `ux_slot_one_open` makes a concurrent duplicate insert fail harmlessly.
 */
function createMissingSlots(
  tx: Db,
  settings: HouseholdSettings,
  occurrenceId: string,
  now: number,
): number {
  const states = tx
    .select()
    .from(notificationRecipientState)
    .where(
      and(
        eq(notificationRecipientState.occurrenceId, occurrenceId),
        inArray(notificationRecipientState.state, [...LIVE_RECIPIENT_STATES]),
      ),
    )
    .all();

  let created = 0;
  for (const state of states) {
    const open = tx
      .select({ id: reminderSlot.id })
      .from(reminderSlot)
      .where(
        and(
          eq(reminderSlot.recipientStateId, state.id),
          inArray(reminderSlot.state, [...SLOT_OPEN_STATES]),
        ),
      )
      .all();
    if (open.length > 0) continue;
    const index = state.nextSlotIndex;
    const inserted = tx
      .insert(reminderSlot)
      .values({
        id: newId(),
        recipientStateId: state.id,
        slotIndex: index,
        scheduledAtMs: slotInstant(
          state.anchorDate,
          index,
          settings.reminderIntervalDays,
          settings.deliveryTime,
          settings.timezone,
        ),
        scheduledLocalDate: slotLocalDate(state.anchorDate, index, settings.reminderIntervalDays),
        state: "pending",
        isSnooze: false,
        nonce: newNonce(),
        createdAtMs: now,
      })
      .onConflictDoNothing()
      .run();
    created += inserted.changes;
  }
  return created;
}

/**
 * Release claims whose `claim_expires_at_ms` has passed, so a worker killed between claiming and
 * sending does not park a reminder forever. Called at the start of a tick by the worker loop.
 */
export function reclaimExpiredSlots(handle: DbHandle, now: number): number {
  return writeTx(handle.db, (tx) =>
    tx
      .update(reminderSlot)
      .set({ state: "pending", claimedBy: null, claimFence: null, claimExpiresAtMs: null })
      .where(and(eq(reminderSlot.state, "claimed"), lte(reminderSlot.claimExpiresAtMs, now)))
      .run(),
  ).changes;
}
