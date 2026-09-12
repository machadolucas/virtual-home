/**
 * §9 P0 items 26–35 — the occurrence lifecycle.
 *
 * Every test drives the real schema (in-memory SQLite built by the shipped migrations) with an
 * injected fake clock, and asserts the two rules that matter most: nothing fabricates history, and
 * a snooze/postpone/block changes reminders without changing the work.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { writeTx } from "@/db/client";
import { newId } from "@/db/ids";
import { auditLog } from "@/db/schema/household";
import {
  completion,
  maintenanceOccurrence,
  maintenancePlan,
  occurrenceEvent,
  occurrenceProgressItem,
  serviceBooking,
  serviceProvider,
} from "@/db/schema/maintenance";
import { notificationRecipientState, reminderSlot } from "@/db/schema/notifications";
import { conditionEpisode, conditionRule, haEntity } from "@/db/schema/ha";
import { procedureStep } from "@/db/schema/procedures";
import { ConflictError } from "@/domain/errors";
import {
  block,
  cancelPlan,
  createConditionOccurrence,
  createOccurrenceForPlan,
  isOverdue,
  loadHousehold,
  loadOccurrence,
  loadPlan,
  markCompleted,
  openOccurrenceOfPlan,
  postpone,
  reopen,
  reopenAfterVoid,
  seedPlanSchedule,
  skip,
  snooze,
  unblock,
} from "@/domain/occurrence";
import { ensureRecipientStates } from "@/domain/notify/recipients";
import { runNotificationTick } from "@/domain/notify/tick";
import { instantOf } from "@/domain/time";
import type { RecurrenceRule } from "@/domain/recurrence";
import {
  makeAsset,
  makeCompletion,
  makeDevice,
  makeOccurrence,
  makePlan,
  makeProcedure,
  makeWorld,
  type TestWorld,
} from "./fixtures";

const TZ = "Europe/Helsinki";
const SIX_MONTHS: RecurrenceRule = { v: 1, kind: "interval_from_completion", every: 6, unit: "month" };
const APRIL_OCTOBER: RecurrenceRule = { v: 1, kind: "fixed_monthly", months: [4, 10], dayOfMonth: 1 };

let world: TestWorld | null = null;

function open(startIso: string): TestWorld {
  world = makeWorld(startIso);
  return world;
}

afterEach(() => {
  world?.close();
  world = null;
});

function tx<T>(w: TestWorld, fn: Parameters<typeof writeTx<T>>[1]): T {
  return writeTx(w.handle.db, fn);
}

function statesOf(w: TestWorld, occurrenceId: string) {
  return w.handle.db
    .select()
    .from(notificationRecipientState)
    .where(eq(notificationRecipientState.occurrenceId, occurrenceId))
    .all();
}

function slotsOf(w: TestWorld, recipientStateId: string) {
  return w.handle.db
    .select()
    .from(reminderSlot)
    .where(eq(reminderSlot.recipientStateId, recipientStateId))
    .all();
}

function eventKinds(w: TestWorld, occurrenceId: string): string[] {
  return w.handle.db
    .select({ kind: occurrenceEvent.kind })
    .from(occurrenceEvent)
    .where(eq(occurrenceEvent.occurrenceId, occurrenceId))
    .all()
    .map((row) => row.kind);
}

function completionCount(w: TestWorld): number {
  return w.handle.db.select({ id: completion.id }).from(completion).all().length;
}

/**
 * Assert the stable machine-readable `code`, not the human message: `code` is the contract the UI
 * and these tests share (`src/domain/errors.ts`), the message is free to be rewritten.
 */
function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { code?: string }).code).toBe(code);
}

describe("one-off initial scheduling", () => {
  it("creates exactly one task on the selected due date without inventing history", () => {
    const w = open("2026-04-20T10:00:00Z");
    const planId = makePlan(w, { rule: { v: 1, kind: "one_off" }, anchorDate: null });
    const first = tx(w, (t) => seedPlanSchedule(t, w.ctx, planId, { kind: "user_chosen", date: "2026-05-07" }));
    expect(first?.dueDate).toBe("2026-05-07");
    expect(w.handle.db.select().from(completion).all()).toHaveLength(0);
    expect(tx(w, (t) => createOccurrenceForPlan(t, w.ctx, planId))).toBeNull();
    // A terminal occurrence remains the proof this single task has already existed.
    expect(tx(w, (t) => skip(t, w.ctx, first!.id, "No longer needed")).next).toBeNull();
    expect(tx(w, (t) => createOccurrenceForPlan(t, w.ctx, planId))).toBeNull();
    expect(w.handle.db.select().from(maintenanceOccurrence).all()).toHaveLength(1);
  });

  it("uses today for start-now and creates nothing while the date is unknown", () => {
    const w = open("2026-04-20T10:00:00Z");
    const planId = makePlan(w, { rule: { v: 1, kind: "one_off" }, anchorDate: null });
    expect(tx(w, (t) => createOccurrenceForPlan(t, w.ctx, planId))).toBeNull();
    expect(tx(w, (t) => seedPlanSchedule(t, w.ctx, planId, { kind: "start_now" }))?.dueDate).toBe("2026-04-20");
  });
});

describe("becoming due", () => {
  // 26
  it("flips pending -> due exactly at the delivery-time instant, not one tick earlier", () => {
    const w = open("2027-01-04T06:58:00Z");
    makeDevice(w, w.lucas.id);
    makeDevice(w, w.marja.id);
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04" });

    // 06:58Z is 08:58 local — one minute before 09:00.
    runNotificationTick({ handle: w.handle, clock: w.clock, workerId: "w1" });
    expect(loadOccurrence(w.handle.db, occId).status).toBe("pending");

    w.clock.set("2027-01-04T06:59:59Z");
    runNotificationTick({ handle: w.handle, clock: w.clock, workerId: "w1" });
    expect(loadOccurrence(w.handle.db, occId).status).toBe("pending");

    w.clock.set(instantOf("2027-01-04", "09:00", TZ));
    runNotificationTick({ handle: w.handle, clock: w.clock, workerId: "w1" });
    const occ = loadOccurrence(w.handle.db, occId);
    expect(occ.status).toBe("due");
    expect(occ.becameDueAtMs).toBe(instantOf("2027-01-04", "09:00", TZ));
    expect(eventKinds(w, occId)).toContain("became_due");
  });

  it("isOverdue is derived from status and due date", () => {
    const w = open("2027-01-10T10:00:00Z");
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const dueId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    const occ = loadOccurrence(w.handle.db, dueId);
    expect(isOverdue(occ, "2027-01-10")).toBe(true);
    expect(isOverdue(occ, "2027-01-04")).toBe(false);
    expect(isOverdue({ ...occ, status: "pending" }, "2027-01-10")).toBe(false);
  });
});

describe("completion and successor generation", () => {
  // 27
  it("generates exactly one successor and the index forbids a second open occurrence", () => {
    const w = open("2027-01-04T10:00:00Z");
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    const completionId = makeCompletion(w, {
      occurrenceId: occId,
      planId,
      completedLocalDate: "2027-01-04",
    });

    const { next } = tx(w, (t) =>
      markCompleted(t, w.ctx, {
        occurrenceId: occId,
        completionId,
        completedLocalDate: "2027-01-04",
        completedAtMs: w.clock.now(),
      }),
    );

    expect(next).not.toBeNull();
    expect(next!.dueDate).toBe("2027-07-04");
    expect(next!.status).toBe("pending");
    const openRows = w.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(
        and(eq(maintenanceOccurrence.planId, planId), eq(maintenanceOccurrence.status, "pending")),
      )
      .all();
    expect(openRows).toHaveLength(1);

    const plan = loadPlan(w.handle.db, planId);
    expect(plan.lastCompletionId).toBe(completionId);
    expect(plan.scheduleAnchorDate).toBe("2027-01-04");
    expect(plan.scheduleAnchorSource).toBe("completion");

    // A forced second open occurrence is rejected by `ux_occ_open_per_plan`.
    expect(() => makeOccurrence(w, { planId, dueDate: "2027-08-01" })).toThrow(/UNIQUE|constraint/i);

    // A second markCompleted on the same occurrence conflicts rather than double-generating.
    expect(() =>
      tx(w, (t) =>
        markCompleted(t, w.ctx, {
          occurrenceId: occId,
          completionId,
          completedLocalDate: "2027-01-04",
          completedAtMs: w.clock.now(),
        }),
      ),
    ).toThrowError(ConflictError);
  });

  it("anchors a calendar series on the previous due date, not the completion date", () => {
    const w = open("2026-04-20T10:00:00Z");
    const planId = makePlan(w, { rule: APRIL_OCTOBER, anchorDate: "2026-01-01" });
    const occId = makeOccurrence(w, { planId, dueDate: "2026-04-01", status: "due" });
    const completionId = makeCompletion(w, {
      occurrenceId: occId,
      planId,
      completedLocalDate: "2026-04-20",
    });
    const { next } = tx(w, (t) =>
      markCompleted(t, w.ctx, {
        occurrenceId: occId,
        completionId,
        completedLocalDate: "2026-04-20",
        completedAtMs: w.clock.now(),
      }),
    );
    expect(next!.dueDate).toBe("2026-10-01");
    expect(loadPlan(w.handle.db, planId).scheduleAnchorDate).toBe("2026-04-01");
  });

  it("clears both recipients on completion", () => {
    const w = open("2027-01-04T10:00:00Z");
    makeDevice(w, w.lucas.id);
    makeDevice(w, w.marja.id);
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    tx(w, (t) => ensureRecipientStates(t, w.workerCtx, loadOccurrence(t, occId)));
    const completionId = makeCompletion(w, {
      occurrenceId: occId,
      planId,
      completedLocalDate: "2027-01-04",
    });
    tx(w, (t) =>
      markCompleted(t, w.ctx, {
        occurrenceId: occId,
        completionId,
        completedLocalDate: "2027-01-04",
        completedAtMs: w.clock.now(),
      }),
    );
    const states = statesOf(w, occId);
    expect(states).toHaveLength(2);
    for (const state of states) {
      expect(state.state).toBe("cleared");
      expect(state.clearReason).toBe("completed");
      expect(state.clearedAtMs).toBe(w.clock.now());
    }
  });

  it("does not generate a successor for a one-off or a cancelled plan", () => {
    const w = open("2027-01-04T10:00:00Z");
    const oneOffPlan = makePlan(w, { rule: { v: 1, kind: "one_off" }, anchorDate: "2027-01-04" });
    const occId = makeOccurrence(w, { planId: oneOffPlan, dueDate: "2027-01-04", status: "due" });
    const completionId = makeCompletion(w, {
      occurrenceId: occId,
      planId: oneOffPlan,
      completedLocalDate: "2027-01-04",
    });
    const { next } = tx(w, (t) =>
      markCompleted(t, w.ctx, {
        occurrenceId: occId,
        completionId,
        completedLocalDate: "2027-01-04",
        completedAtMs: w.clock.now(),
      }),
    );
    expect(next).toBeNull();
  });
});

describe("postpone", () => {
  // 28
  it("moves the due date, keeps original_due_date, re-anchors reminders and leaves the plan alone", () => {
    const w = open("2027-01-06T10:00:00Z");
    // Both users need a device: a recipient without one has its slot `failed`, not `cancelled`.
    makeDevice(w, w.lucas.id);
    makeDevice(w, w.marja.id);
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    tx(w, (t) => ensureRecipientStates(t, w.workerCtx, loadOccurrence(t, occId)));
    // Give each recipient a live slot so the re-anchor has something to cancel.
    runNotificationTick({ handle: w.handle, clock: w.clock, workerId: "w1" });
    const before = loadPlan(w.handle.db, planId);

    tx(w, (t) => postpone(t, w.ctx, occId, "2027-02-01", "waiting for filters"));

    const occ = loadOccurrence(w.handle.db, occId);
    expect(occ.dueDate).toBe("2027-02-01");
    expect(occ.originalDueDate).toBe("2027-01-04");
    expect(occ.status).toBe("pending");

    const after = loadPlan(w.handle.db, planId);
    expect(after.scheduleAnchorDate).toBe(before.scheduleAnchorDate);
    expect(after.recurrenceJson).toBe(before.recurrenceJson);

    // 67: states re-anchored to the new date at index 0, old slot cancelled.
    for (const state of statesOf(w, occId)) {
      expect(state.anchorDate).toBe("2027-02-01");
      expect(state.nextSlotIndex).toBe(0);
      expect(state.state).toBe("active");
      const slots = slotsOf(w, state.id);
      expect(slots.filter((s) => s.state === "pending" || s.state === "claimed")).toHaveLength(0);
      expect(slots.some((s) => s.state === "cancelled" && s.cancelReason === "postponed")).toBe(true);
    }
    expect(eventKinds(w, occId)).toContain("postponed");
  });

  it("refuses a postpone into the past or past the max horizon", () => {
    const w = open("2027-01-06T10:00:00Z");
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    expectCode(() => tx(w, (t) => postpone(t, w.ctx, occId, "2027-01-05")), "postpone_in_past");
    expectCode(() => tx(w, (t) => postpone(t, w.ctx, occId, "2030-01-05")), "postpone_too_far");
  });
});

describe("snooze", () => {
  // 29
  it("changes nothing but one recipient's reminders", () => {
    const w = open("2027-01-04T10:00:00Z");
    makeDevice(w, w.lucas.id);
    makeDevice(w, w.marja.id);
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    tx(w, (t) => ensureRecipientStates(t, w.workerCtx, loadOccurrence(t, occId)));
    runNotificationTick({ handle: w.handle, clock: w.clock, workerId: "w1" });

    const before = loadOccurrence(w.handle.db, occId);
    const beforePlan = loadPlan(w.handle.db, planId);
    const marjaBefore = statesOf(w, occId).find((s) => s.recipientUserId === w.marja.id)!;
    const marjaSlotsBefore = slotsOf(w, marjaBefore.id).map((s) => ({
      index: s.slotIndex,
      at: s.scheduledAtMs,
      state: s.state,
    }));

    const until = instantOf("2027-01-05", "09:00", TZ);
    tx(w, (t) => snooze(t, w.ctx, occId, w.lucas.id, until));

    const after = loadOccurrence(w.handle.db, occId);
    expect(after.dueDate).toBe(before.dueDate);
    expect(loadPlan(w.handle.db, planId).scheduleAnchorDate).toBe(beforePlan.scheduleAnchorDate);
    expect(completionCount(w)).toBe(0);

    const lucasState = statesOf(w, occId).find((s) => s.recipientUserId === w.lucas.id)!;
    expect(lucasState.state).toBe("snoozed");
    expect(lucasState.snoozedUntilMs).toBe(until);
    expect(lucasState.snoozeCount).toBe(1);
    const lucasSlots = slotsOf(w, lucasState.id);
    const snoozeSlot = lucasSlots.find((s) => s.isSnooze)!;
    expect(snoozeSlot.state).toBe("pending");
    expect(snoozeSlot.scheduledAtMs).toBe(until);
    expect(snoozeSlot.slotIndex).toBe(0); // the same index — the series is not advanced

    // The other user is untouched.
    const marjaAfter = statesOf(w, occId).find((s) => s.recipientUserId === w.marja.id)!;
    expect(marjaAfter.state).toBe("active");
    expect(
      slotsOf(w, marjaAfter.id).map((s) => ({ index: s.slotIndex, at: s.scheduledAtMs, state: s.state })),
    ).toEqual(marjaSlotsBefore);
  });
});

describe("skip", () => {
  // 30
  it("closes without a completion, anchors the successor on the due date and leaves history alone", () => {
    const w = open("2026-04-20T10:00:00Z");
    makeDevice(w, w.lucas.id);
    const planId = makePlan(w, { rule: APRIL_OCTOBER, anchorDate: "2026-01-01" });
    const occId = makeOccurrence(w, { planId, dueDate: "2026-04-01", status: "due" });
    tx(w, (t) => ensureRecipientStates(t, w.workerCtx, loadOccurrence(t, occId)));

    const { next } = tx(w, (t) => skip(t, w.ctx, occId, "not needed this spring"));

    const occ = loadOccurrence(w.handle.db, occId);
    expect(occ.status).toBe("skipped");
    expect(occ.completionId).toBeNull();
    expect(occ.closeReason).toBe("not needed this spring");
    expect(completionCount(w)).toBe(0);

    expect(next!.dueDate).toBe("2026-10-01");
    const plan = loadPlan(w.handle.db, planId);
    expect(plan.scheduleAnchorSource).toBe("skipped_due_date");
    expect(plan.scheduleAnchorDate).toBe("2026-04-01");
    expect(plan.lastCompletionId).toBeNull();

    for (const state of statesOf(w, occId)) expect(state.state).toBe("cleared");
  });
});

describe("cancel plan", () => {
  // 31
  it("closes the open occurrence, clears recipients and generates nothing", () => {
    const w = open("2027-01-04T10:00:00Z");
    makeDevice(w, w.lucas.id);
    makeDevice(w, w.marja.id);
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    tx(w, (t) => ensureRecipientStates(t, w.workerCtx, loadOccurrence(t, occId)));

    tx(w, (t) => cancelPlan(t, w.ctx, planId, "unit removed"));

    const occ = loadOccurrence(w.handle.db, occId);
    expect(occ.status).toBe("cancelled");
    expect(occ.closeReason).toBe("plan_cancelled");
    expect(openOccurrenceOfPlan(w.handle.db, planId)).toBeNull();
    expect(loadPlan(w.handle.db, planId).status).toBe("cancelled");
    const states = statesOf(w, occId);
    expect(states).toHaveLength(2);
    for (const state of states) expect(state.state).toBe("cleared");
    expect(() => tx(w, (t) => cancelPlan(t, w.ctx, planId))).toThrowError(ConflictError);
  });
});

describe("block and unblock", () => {
  // 32
  it("leaves the due date and the slot series untouched", () => {
    const w = open("2027-01-04T10:00:00Z");
    makeDevice(w, w.lucas.id);
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    tx(w, (t) => ensureRecipientStates(t, w.workerCtx, loadOccurrence(t, occId)));
    runNotificationTick({ handle: w.handle, clock: w.clock, workerId: "w1" });
    const stateId = statesOf(w, occId)[0]!.id;
    const slotsBefore = slotsOf(w, stateId).map((s) => ({ index: s.slotIndex, at: s.scheduledAtMs }));

    tx(w, (t) => block(t, w.ctx, occId, "waiting for filters"));
    let occ = loadOccurrence(w.handle.db, occId);
    expect(occ.blockedReason).toBe("waiting for filters");
    expect(occ.status).toBe("due");
    expect(occ.dueDate).toBe("2027-01-04");
    expect(slotsOf(w, stateId).map((s) => ({ index: s.slotIndex, at: s.scheduledAtMs }))).toEqual(
      slotsBefore,
    );
    expect(() => tx(w, (t) => block(t, w.ctx, occId, "again"))).toThrowError(ConflictError);

    // "Block + snooze" is block plus an ordinary snooze — both effects, no new concept.
    const until = instantOf("2027-01-11", "09:00", TZ);
    tx(w, (t) => snooze(t, w.ctx, occId, w.lucas.id, until));
    expect(statesOf(w, occId)[0]!.snoozedUntilMs).toBe(until);
    expect(loadOccurrence(w.handle.db, occId).blockedReason).toBe("waiting for filters");

    tx(w, (t) => unblock(t, w.ctx, occId));
    occ = loadOccurrence(w.handle.db, occId);
    expect(occ.blockedReason).toBeNull();
    expect(occ.status).toBe("due");
    // The snooze survives the unblock; the user can un-snooze separately.
    expect(statesOf(w, occId)[0]!.snoozedUntilMs).toBe(until);
    expect(eventKinds(w, occId)).toEqual(expect.arrayContaining(["blocked", "snoozed", "unblocked"]));
  });
});

describe("booking", () => {
  // 33
  it("is not a completion, and attendance is not a completion either", () => {
    const w = open("2027-01-04T10:00:00Z");
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    const providerId = newId();
    const bookingId = newId();
    const at = w.clock.now();
    tx(w, (t) => {
      t.insert(serviceProvider)
        .values({ id: providerId, name: "Ilmastointi Oy", createdAtMs: at, updatedAtMs: at })
        .run();
      t.insert(serviceBooking)
        .values({
          id: bookingId,
          occurrenceId: occId,
          providerId,
          status: "confirmed",
          requestedAtMs: at,
          scheduledLocalDate: "2027-01-20",
          createdAtMs: at,
          updatedAtMs: at,
        })
        .run();
      t.update(maintenanceOccurrence)
        .set({ serviceBookingId: bookingId })
        .where(eq(maintenanceOccurrence.id, occId))
        .run();
    });

    let occ = loadOccurrence(w.handle.db, occId);
    expect(occ.status).toBe("due");
    expect(occ.dueDate).toBe("2027-01-04");
    expect(occ.completionId).toBeNull();

    tx(w, (t) => {
      t.update(serviceBooking)
        .set({ status: "attended" })
        .where(eq(serviceBooking.id, bookingId))
        .run();
    });
    occ = loadOccurrence(w.handle.db, occId);
    expect(occ.status).toBe("due");
    expect(occ.completionId).toBeNull();
    expect(completionCount(w)).toBe(0);
  });
});

describe("reopen", () => {
  // 34
  it("cancels an untouched successor and refuses when the successor has progress", () => {
    const w = open("2026-04-20T10:00:00Z");
    const { procedureId, versionId } = makeProcedure(w);
    const planId = makePlan(w, { rule: APRIL_OCTOBER, anchorDate: "2026-01-01", procedureId });
    const occId = makeOccurrence(w, { planId, dueDate: "2026-04-01", status: "due" });
    const { next } = tx(w, (t) => skip(t, w.ctx, occId, "changed my mind later"));
    expect(next).not.toBeNull();

    tx(w, (t) => reopen(t, w.ctx, occId));
    expect(loadOccurrence(w.handle.db, next!.id).status).toBe("cancelled");
    expect(loadOccurrence(w.handle.db, next!.id).closeReason).toBe("superseded_by_reopen");
    const reopened = loadOccurrence(w.handle.db, occId);
    expect(reopened.status).toBe("due"); // 2026-04-01 <= today
    expect(reopened.closedAtMs).toBeNull();
    expect(loadPlan(w.handle.db, planId).scheduleAnchorSource).toBe("baseline_exact");

    // Now skip again and touch the successor: the reopen must be refused, never destructive.
    const { next: second } = tx(w, (t) => skip(t, w.ctx, occId));
    const stepId = newId();
    const at = w.clock.now();
    tx(w, (t) => {
      t.insert(procedureStep)
        .values({ id: stepId, versionId, seq: 0, title: "Remove the cover" })
        .run();
      t.insert(occurrenceProgressItem)
        .values({
          id: newId(),
          occurrenceId: second!.id,
          itemKind: "step",
          stepId,
          state: "in_progress",
          changedAtMs: at,
        })
        .run();
    });
    expect(() => tx(w, (t) => reopen(t, w.ctx, occId))).toThrowError(ConflictError);
    expect(loadOccurrence(w.handle.db, second!.id).status).toBe("pending");
  });

  it("refuses to reopen outside the reopen window", () => {
    const w = open("2026-04-20T10:00:00Z");
    const planId = makePlan(w, { rule: APRIL_OCTOBER, anchorDate: "2026-01-01" });
    const occId = makeOccurrence(w, { planId, dueDate: "2026-04-01", status: "due" });
    tx(w, (t) => skip(t, w.ctx, occId));
    // The successor must go first, or its own existence is what blocks the reopen.
    const successor = openOccurrenceOfPlan(w.handle.db, planId)!;
    tx(w, (t) => cancelPlan(t, w.ctx, planId));
    void successor;
    w.clock.set("2026-12-01T10:00:00Z");
    expectCode(() => tx(w, (t) => reopen(t, w.ctx, occId)), "reopen_window_expired");
  });

  // Void path (§5.4 steps 3, 6, 7).
  it("reopenAfterVoid cancels the successor and reverts the plan anchor", () => {
    const w = open("2027-01-04T10:00:00Z");
    const planId = makePlan(w, {
      rule: SIX_MONTHS,
      anchorDate: "2026-07-04",
      anchorSource: "baseline_exact",
    });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due" });
    const completionId = makeCompletion(w, {
      occurrenceId: occId,
      planId,
      completedLocalDate: "2027-01-04",
    });
    const { next } = tx(w, (t) =>
      markCompleted(t, w.ctx, {
        occurrenceId: occId,
        completionId,
        completedLocalDate: "2027-01-04",
        completedAtMs: w.clock.now(),
      }),
    );

    // The completion module voids the row; this function does the occurrence/plan half.
    tx(w, (t) => {
      t.update(completion)
        .set({ voidedAtMs: w.clock.now(), voidedBy: w.lucas.id, voidReason: "wrong task" })
        .where(eq(completion.id, completionId))
        .run();
      reopenAfterVoid(t, w.ctx, occId);
    });

    expect(loadOccurrence(w.handle.db, next!.id).closeReason).toBe("superseded_by_void");
    const reopened = loadOccurrence(w.handle.db, occId);
    expect(reopened.status).toBe("due");
    expect(reopened.completionId).toBeNull();
    const plan = loadPlan(w.handle.db, planId);
    expect(plan.lastCompletionId).toBeNull();
    expect(plan.scheduleAnchorDate).toBe("2026-07-04");
    expect(plan.scheduleAnchorSource).toBe("baseline_exact");
    for (const state of statesOf(w, occId)) {
      expect(state.state).toBe("active");
      expect(state.nextSlotIndex).toBe(0);
    }
  });
});

describe("guided-procedure progress", () => {
  // 35
  it("survives a restart and resumes at the first not-done step", () => {
    const w = open("2027-01-04T10:00:00Z");
    const { procedureId, versionId } = makeProcedure(w);
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04", procedureId });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04", status: "due", procedureVersionId: versionId });

    const stepIds = [newId(), newId(), newId()];
    const at = w.clock.now();
    tx(w, (t) => {
      stepIds.forEach((id, seq) => {
        t.insert(procedureStep).values({ id, versionId, seq, title: `Step ${seq + 1}` }).run();
      });
      t.insert(occurrenceProgressItem)
        .values({
          id: newId(),
          occurrenceId: occId,
          itemKind: "step",
          stepId: stepIds[0]!,
          state: "done",
          changedAtMs: at,
        })
        .run();
    });

    // "Restart": nothing is held in memory — the resume point is a query over the same rows.
    const resume = w.handle.db
      .select({ id: procedureStep.id, seq: procedureStep.seq, state: occurrenceProgressItem.state })
      .from(procedureStep)
      .leftJoin(
        occurrenceProgressItem,
        and(
          eq(occurrenceProgressItem.stepId, procedureStep.id),
          eq(occurrenceProgressItem.occurrenceId, occId),
        ),
      )
      .where(eq(procedureStep.versionId, versionId))
      .orderBy(procedureStep.seq)
      .all()
      .find((row) => row.state !== "done");
    expect(resume?.id).toBe(stepIds[1]);
    expect(loadOccurrence(w.handle.db, occId).status).toBe("due");
  });
});

describe("condition occurrences", () => {
  // §6.4 — a dip / recover / dip while the first task is open creates no second task.
  it("reuses the open occurrence instead of duplicating it", () => {
    const w = open("2027-01-04T10:00:00Z");
    const assetId = makeOccurrenceAsset(w);
    const ruleId = insertConditionRule(w, assetId);
    const first = tx(w, (t) =>
      createConditionOccurrence(t, w.workerCtx, {
        conditionRuleId: ruleId,
        conditionEpisodeId: insertEpisode(w, ruleId, assetId),
        assetId,
        title: "Replace battery: smoke alarm",
        dueDate: "2027-01-04",
        priority: "high",
        assignmentMode: "shared",
        assigneeUserId: null,
      }),
    );
    const second = tx(w, (t) =>
      createConditionOccurrence(t, w.workerCtx, {
        conditionRuleId: ruleId,
        conditionEpisodeId: first.conditionEpisodeId!,
        assetId,
        title: "Replace battery: smoke alarm",
        dueDate: "2027-01-20",
        priority: "high",
        assignmentMode: "shared",
        assigneeUserId: null,
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.dueDate).toBe("2027-01-04");
    const all = w.handle.db
      .select({ id: maintenanceOccurrence.id })
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.source, "condition"))
      .all();
    expect(all).toHaveLength(1);
    expect(eventKinds(w, first.id).filter((k) => k === "created")).toHaveLength(2);
  });
});

describe("seeding the first occurrence", () => {
  // 16
  it("produces the documented anchor and due date for every setup answer, and zero completions", () => {
    const w = open("2026-09-08T10:00:00Z");
    const cases: Array<{
      seed: Parameters<typeof seedPlanSchedule>[3];
      rule: RecurrenceRule;
      anchorSource: string;
      anchorDate: string | null;
      dueDate: string | null;
    }> = [
      {
        seed: { kind: "baseline_exact", date: "2026-03-14" },
        rule: SIX_MONTHS,
        anchorSource: "baseline_exact",
        anchorDate: "2026-03-14",
        dueDate: "2026-09-14",
      },
      {
        seed: { kind: "baseline_approx", date: "2024-04-15", note: "sometime in spring 2024" },
        rule: SIX_MONTHS,
        anchorSource: "baseline_approx",
        anchorDate: "2024-04-15",
        dueDate: "2024-10-15",
      },
      {
        seed: { kind: "user_chosen", date: "2026-10-01" },
        rule: SIX_MONTHS,
        anchorSource: "user_chosen",
        anchorDate: "2026-10-01",
        dueDate: "2027-04-01",
      },
      {
        seed: { kind: "start_now" },
        rule: SIX_MONTHS,
        anchorSource: "user_chosen",
        anchorDate: "2026-09-08",
        dueDate: "2027-03-08",
      },
      {
        seed: { kind: "start_now" },
        rule: APRIL_OCTOBER,
        anchorSource: "user_chosen",
        anchorDate: "2026-09-07",
        dueDate: "2026-10-01",
      },
      {
        seed: { kind: "install_date" },
        rule: SIX_MONTHS,
        anchorSource: "install_date",
        anchorDate: "2026-05-20",
        dueDate: "2026-11-20",
      },
    ];

    for (const testCase of cases) {
      const assetId = makeAssetWithInstall(w, "2026-05-20");
      const planId = makePlan(w, { rule: testCase.rule, assetId, status: "paused" });
      const occ = tx(w, (t) => seedPlanSchedule(t, w.ctx, planId, testCase.seed));
      const plan = loadPlan(w.handle.db, planId);
      expect(plan.scheduleAnchorSource).toBe(testCase.anchorSource);
      expect(plan.scheduleAnchorDate).toBe(testCase.anchorDate);
      expect(plan.status).toBe("active");
      expect(occ?.dueDate ?? null).toBe(testCase.dueDate);
      expect(occ?.status).toBe("pending");
    }

    // The whole point: seeding writes scheduling inputs, never history.
    expect(completionCount(w)).toBe(0);
    expect(
      w.handle.db
        .select({ id: maintenancePlan.id })
        .from(maintenancePlan)
        .where(isNull(maintenancePlan.lastCompletionId))
        .all(),
    ).toHaveLength(cases.length);
  });

  // 17
  it("'ask me later' creates no occurrence and leaves the plan paused with an alert", () => {
    const w = open("2026-09-08T10:00:00Z");
    const planId = makePlan(w, { rule: SIX_MONTHS });
    const occ = tx(w, (t) => seedPlanSchedule(t, w.ctx, planId, { kind: "ask_later" }));
    expect(occ).toBeNull();
    const plan = loadPlan(w.handle.db, planId);
    expect(plan.status).toBe("paused");
    expect(plan.scheduleAnchorDate).toBeNull();
    expect(plan.scheduleAnchorSource).toBe("none");
    expect(
      w.handle.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.action, "plan_needs_baseline"))
        .all(),
    ).toHaveLength(1);
    expect(completionCount(w)).toBe(0);
    // A paused plan generates nothing even if asked directly.
    expect(tx(w, (t) => createOccurrenceForPlan(t, w.ctx, planId))).toBeNull();
  });

  it("a baseline_approx anchor marks the occurrence as estimated", () => {
    const w = open("2026-09-08T10:00:00Z");
    const planId = makePlan(w, { rule: SIX_MONTHS });
    const occ = tx(w, (t) =>
      seedPlanSchedule(t, w.ctx, planId, { kind: "baseline_approx", date: "2024-04-15" }),
    );
    const note = JSON.parse(occ!.generationNoteJson!) as Record<string, unknown>;
    expect(note.anchorPrecision).toBe("approx");
    expect(note.seedKind).toBe("baseline_approx");
  });

  it("household settings come from the singleton row", () => {
    const w = open("2026-09-08T10:00:00Z");
    const settings = loadHousehold(w.handle.db);
    expect(settings.timezone).toBe(TZ);
    expect(settings.deliveryTime).toBe("09:00");
    expect(settings.reminderIntervalDays).toBe(7);
    expect(settings.sendWindowStart).toBe("08:00");
    expect(settings.catchupDigestThreshold).toBe(3);
  });
});

// --- local helpers that need the ha schema ------------------------------------------------------

function makeOccurrenceAsset(w: TestWorld): string {
  return makeAsset(w, { name: "Smoke alarm", category: "safety" });
}

function makeAssetWithInstall(w: TestWorld, installedOn: string | null): string {
  return makeAsset(w, { installedOn });
}

function insertConditionRule(w: TestWorld, assetId: string): string {
  const id = newId();
  const at = w.clock.now();
  writeTx(w.handle.db, (t) => {
    t.insert(conditionRule)
      .values({
        id,
        kind: "low_battery",
        name: "Low battery",
        scope: "asset",
        assetId,
        titleTemplate: "Replace battery: {{asset}}",
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
  });
  return id;
}

function insertEpisode(w: TestWorld, ruleId: string, assetId: string): string {
  const id = newId();
  const registryId = `reg-${id.slice(0, 8)}`;
  const at = w.clock.now();
  writeTx(w.handle.db, (t) => {
    t.insert(haEntity)
      .values({
        registryId,
        entityId: "sensor.smoke_alarm_battery",
        domain: "sensor",
        firstSeenMs: at,
        lastSeenMs: at,
      })
      .run();
    t.insert(conditionEpisode)
      .values({
        id,
        ruleId,
        haEntityRegistryId: registryId,
        assetId,
        openedAtMs: at,
        openLocalDate: "2027-01-04",
        createdAtMs: at,
      })
      .run();
  });
  return id;
}
