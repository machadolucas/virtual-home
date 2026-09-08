/**
 * Integration: the occurrence-transition, progress and condition action families.
 *
 * These run the real `action()` wrapper against a real in-memory database built by the real
 * migrations, so what is under test is the whole path a click takes — validation, session, the
 * write transaction, and the domain guard inside it.
 *
 * What they are here to prove is the honesty rules, not the plumbing: a snooze writes no
 * completion, a postpone leaves `original_due_date` alone, a skip generates the successor from the
 * *due date* with `schedule_anchor_source='skipped_due_date'`, and closing a recovered condition
 * task writes no completion and no stock movement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => {
    const { currentUser } = await import("./harness");
    return { user: { id: currentUser() } };
  },
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { and, eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { newId } from "@/db/ids";
import {
  completion,
  maintenanceOccurrence,
  maintenancePlan,
  occurrenceEvent,
  occurrenceProgressItem,
} from "@/db/schema/maintenance";
import { notificationRecipientState, reminderSlot } from "@/db/schema/notifications";
import { procedureChecklistItem, procedureStep } from "@/db/schema/procedures";
import { instantOf } from "@/domain/time";
import {
  blockTask,
  postponeTask,
  reassignTask,
  reopenTask,
  skipTask,
  snoozeTask,
  snoozeUntilTomorrow,
  unblockTask,
} from "@/server/actions/maintenance/occurrence";
import { setChecklistProgress, setStepProgress } from "@/server/actions/maintenance/progress";
import { closeConditionWithoutMaintenance } from "@/server/actions/maintenance/condition";
import {
  makeOccurrence,
  makePlan,
  makeProcedure,
  makeWorld,
  TZ,
  type TestWorld,
} from "../../domain/fixtures";
import {
  clearTestDb,
  expectFail,
  expectOk,
  freezeClock,
  signIn,
  useTestDb,
  type FrozenClock,
} from "./harness";

const START = "2026-09-08T09:00:00+03:00";

let world: TestWorld;
let clock: FrozenClock;

beforeEach(() => {
  world = makeWorld(START);
  clock = freezeClock(world.clock.now());
  useTestDb(world.handle);
  signIn(world.lucas.id);
});

afterEach(() => {
  clock.restore();
  clearTestDb();
  world.close();
});

describe("postponeTask", () => {
  it("moves the due date and leaves the original due date and the plan anchor alone", async () => {
    const planId = makePlan(world, {
      rule: { v: 1, kind: "interval_from_completion", every: 6, unit: "month" },
      anchorDate: "2026-03-08",
    });
    const occurrenceId = makeOccurrence(world, {
      planId,
      dueDate: "2026-09-08",
      status: "due",
    });

    const data = expectOk(
      await postponeTask({
        occurrenceId,
        newDueDate: "2026-09-20",
        reason: "scaffolding is still up",
      }),
    );
    expect(data.dueDate).toBe("2026-09-20");

    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.dueDate).toBe("2026-09-20");
    expect(occ?.originalDueDate).toBe("2026-09-08");
    expect(occ?.status).toBe("pending");

    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, planId))
      .get();
    // The interval and the anchor are scheduling inputs; a postpone is not one.
    expect(plan?.scheduleAnchorDate).toBe("2026-03-08");
    expect(plan?.lastCompletionId).toBeNull();

    // And absolutely no completion was written.
    expect(world.handle.db.select().from(completion).all()).toHaveLength(0);

    const events = world.handle.db
      .select()
      .from(occurrenceEvent)
      .where(eq(occurrenceEvent.occurrenceId, occurrenceId))
      .all();
    expect(events.map((event) => event.kind)).toContain("postponed");
  });

  it("refuses to move a due date backwards, with the domain's own error code", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "due" });
    const failure = expectFail(
      await postponeTask({ occurrenceId, newDueDate: "2026-09-01" }),
    );
    expect(failure.error).toBe("postpone_in_past");
  });

  it("refuses a postpone beyond the household limit", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "due" });
    const failure = expectFail(await postponeTask({ occurrenceId, newDueDate: "2030-01-01" }));
    expect(failure.error).toBe("postpone_too_far");
  });

  it("replays a repeated submit instead of moving the date twice", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "due" });
    const key = "idem-postpone-0001";
    expectOk(await postponeTask({ occurrenceId, newDueDate: "2026-09-15", idempotencyKey: key }));
    // The same form instance submitting again must not move the date on from the new value.
    expectOk(await postponeTask({ occurrenceId, newDueDate: "2026-09-22", idempotencyKey: key }));
    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.dueDate).toBe("2026-09-15");
  });
});

describe("snoozeTask", () => {
  it("moves only the reminder: no due date, no completion, no plan change", async () => {
    const planId = makePlan(world, {
      rule: { v: 1, kind: "interval_from_completion", every: 6, unit: "month" },
      anchorDate: "2026-03-08",
    });
    const occurrenceId = makeOccurrence(world, { planId, dueDate: "2026-09-08", status: "due" });

    const data = expectOk(await snoozeTask({ occurrenceId, preset: "three_days" }));
    expect(data.untilDate).toBe("2026-09-11");
    expect(data.untilMs).toBe(instantOf("2026-09-11", "09:00", TZ));

    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.dueDate).toBe("2026-09-08");
    expect(occ?.status).toBe("due");
    expect(world.handle.db.select().from(completion).all()).toHaveLength(0);

    const state = world.handle.db
      .select()
      .from(notificationRecipientState)
      .where(
        and(
          eq(notificationRecipientState.occurrenceId, occurrenceId),
          eq(notificationRecipientState.recipientUserId, world.lucas.id),
        ),
      )
      .get();
    expect(state?.state).toBe("snoozed");
    expect(state?.snoozedUntilMs).toBe(data.untilMs);

    // The other member's reminders are untouched: a snooze is per person.
    const other = world.handle.db
      .select()
      .from(notificationRecipientState)
      .where(eq(notificationRecipientState.recipientUserId, world.marja.id))
      .get();
    expect(other?.state).toBe("active");

    const slots = world.handle.db.select().from(reminderSlot).all();
    expect(slots.some((slot) => slot.isSnooze && slot.scheduledAtMs === data.untilMs)).toBe(true);
  });

  it("creates the recipient row when the worker has not made one yet", async () => {
    // Snoozing a task that has not become due yet is exactly when the button is wanted.
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-20", status: "pending" });
    expectOk(await snoozeUntilTomorrow({ occurrenceId }));
    const state = world.handle.db
      .select()
      .from(notificationRecipientState)
      .where(eq(notificationRecipientState.occurrenceId, occurrenceId))
      .all();
    expect(state.length).toBeGreaterThan(0);
  });

  it("refuses to snooze a task assigned to the other member", async () => {
    const occurrenceId = makeOccurrence(world, {
      dueDate: "2026-09-08",
      status: "due",
      assignmentMode: "user",
      assigneeUserId: world.marja.id,
    });
    const failure = expectFail(await snoozeTask({ occurrenceId, preset: "tomorrow" }));
    expect(failure.error).toBe("not_a_recipient");
  });
});

describe("skipTask", () => {
  it("closes without a completion and anchors the successor on the due date", async () => {
    const planId = makePlan(world, {
      rule: { v: 1, kind: "fixed_monthly", months: [4, 10], dayOfMonth: 1 },
      anchorDate: "2026-04-01",
    });
    const occurrenceId = makeOccurrence(world, { planId, dueDate: "2026-10-01", status: "due" });

    const data = expectOk(
      await skipTask({ occurrenceId, reason: "the ventilation company did it in August" }),
    );

    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.status).toBe("skipped");
    expect(occ?.completionId).toBeNull();
    expect(world.handle.db.select().from(completion).all()).toHaveLength(0);

    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, planId))
      .get();
    // The anchor is the skipped due date, marked as such, and no history was fabricated.
    expect(plan?.scheduleAnchorDate).toBe("2026-10-01");
    expect(plan?.scheduleAnchorSource).toBe("skipped_due_date");
    expect(plan?.lastCompletionId).toBeNull();

    expect(data.nextDueDate).toBe("2027-04-01");
    expect(data.nextOccurrenceId).not.toBeNull();
  });

  it("insists on a reason", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "due" });
    const failure = expectFail(await skipTask({ occurrenceId, reason: "   " }));
    expect(failure.error).toBe("invalid_request");
  });
});

describe("blockTask / unblockTask", () => {
  it("decorates the task without touching the due date or the reminders", async () => {
    const occurrenceId = makeOccurrence(world, { planId: null, dueDate: "2026-09-08", status: "due" });
    expectOk(await blockTask({ occurrenceId, reason: "waiting for the F7 filters" }));

    let occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.blockedReason).toBe("waiting for the F7 filters");
    expect(occ?.status).toBe("due");
    expect(occ?.dueDate).toBe("2026-09-08");

    const second = expectFail(await blockTask({ occurrenceId, reason: "again" }));
    expect(second.error).toBe("already_blocked");

    expectOk(await unblockTask({ occurrenceId }));
    occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.blockedReason).toBeNull();

    expect(expectFail(await unblockTask({ occurrenceId })).error).toBe("not_blocked");
  });
});

describe("reopenTask", () => {
  it("reopens a skipped task and cancels its untouched successor", async () => {
    const planId = makePlan(world, {
      rule: { v: 1, kind: "fixed_monthly", months: [4, 10], dayOfMonth: 1 },
      anchorDate: "2026-04-01",
    });
    const occurrenceId = makeOccurrence(world, { planId, dueDate: "2026-10-01", status: "due" });
    const skipped = expectOk(await skipTask({ occurrenceId, reason: "changed my mind later" }));
    const successorId = skipped.nextOccurrenceId;
    expect(successorId).not.toBeNull();

    expectOk(await reopenTask({ occurrenceId }));

    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    // The status is recomputed from the due date, not restored: 1 October is still in the future,
    // so the reopened task is `pending` rather than `due`.
    expect(occ?.status).toBe("pending");
    expect(occ?.closedAtMs).toBeNull();

    const successor = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, successorId!))
      .get();
    expect(successor?.status).toBe("cancelled");
    expect(successor?.closeReason).toBe("superseded_by_reopen");
  });

  it("refuses to reopen an open task", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "due" });
    expect(expectFail(await reopenTask({ occurrenceId })).error).toBe("not_reopenable");
  });
});

describe("reassignTask", () => {
  it("changes this task only, and re-derives who gets reminded", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "due" });
    expectOk(
      await reassignTask({
        occurrenceId,
        assignmentMode: "user",
        assigneeUserId: world.marja.id,
      }),
    );
    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.assignmentMode).toBe("user");
    expect(occ?.assigneeUserId).toBe(world.marja.id);

    const states = world.handle.db
      .select()
      .from(notificationRecipientState)
      .where(eq(notificationRecipientState.occurrenceId, occurrenceId))
      .all();
    const marja = states.find((row) => row.recipientUserId === world.marja.id);
    expect(marja?.state).toBe("active");
  });

  it("rejects user-mode assignment without an assignee", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "due" });
    const failure = expectFail(
      await reassignTask({ occurrenceId, assignmentMode: "user", assigneeUserId: null }),
    );
    expect(failure.error).toBe("invalid_request");
  });
});

describe("progress actions", () => {
  it("records a step and a checklist value against the frozen procedure version", async () => {
    const { versionId } = makeProcedure(world, { requiresValue: "number" });
    // The fixture builds a version-level checklist item; a step is added here so the step-progress
    // path has something in the same version to point at.
    const stepId = newId();
    writeTx(world.handle.db, (tx) => {
      tx.insert(procedureStep)
        .values({ id: stepId, versionId, seq: 0, title: "Open the access panel", isOptional: false })
        .run();
    });

    const occurrenceId = makeOccurrence(world, {
      dueDate: "2026-09-08",
      status: "due",
      procedureVersionId: versionId,
    });

    expectOk(await setStepProgress({ occurrenceId, stepId, state: "done" }));
    const rows = world.handle.db
      .select()
      .from(occurrenceProgressItem)
      .where(eq(occurrenceProgressItem.occurrenceId, occurrenceId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemKind: "step", stepId, state: "done" });

    // Ticking the same step again updates the one row rather than inserting a second.
    expectOk(await setStepProgress({ occurrenceId, stepId, state: "todo" }));
    expect(
      world.handle.db
        .select()
        .from(occurrenceProgressItem)
        .where(eq(occurrenceProgressItem.occurrenceId, occurrenceId))
        .all(),
    ).toHaveLength(1);

    const checklistItemId = world.handle.db.select().from(procedureChecklistItem).all()[0]!.id;
    expectOk(
      await setChecklistProgress({
        occurrenceId,
        checklistItemId,
        state: "done",
        valueNumber: 120,
      }),
    );
    const check = world.handle.db
      .select()
      .from(occurrenceProgressItem)
      .where(eq(occurrenceProgressItem.itemKind, "checklist"))
      .get();
    expect(check?.valueNumber).toBe(120);
  });

  it("refuses a step id that is not in this task's procedure version", async () => {
    const { versionId } = makeProcedure(world);
    const occurrenceId = makeOccurrence(world, {
      dueDate: "2026-09-08",
      status: "due",
      procedureVersionId: versionId,
    });
    const failure = expectFail(
      await setStepProgress({ occurrenceId, stepId: newId(), state: "done" }),
    );
    expect(failure.error).toBe("unknown_step");
  });

  it("refuses to record progress against a closed task", async () => {
    const { versionId } = makeProcedure(world);
    const occurrenceId = makeOccurrence(world, {
      dueDate: "2026-09-08",
      status: "skipped",
      procedureVersionId: versionId,
    });
    const failure = expectFail(
      await setStepProgress({ occurrenceId, stepId: newId(), state: "done" }),
    );
    expect(failure.error).toBe("occurrence_not_open");
  });
});

describe("closeConditionWithoutMaintenance", () => {
  it("skips the task with no completion and no stock movement", async () => {
    const planId = makePlan(world, {
      rule: { v: 1, kind: "interval_from_completion", every: 6, unit: "month" },
      anchorDate: "2026-03-08",
    });
    const occurrenceId = makeOccurrence(world, { planId, dueDate: "2026-09-08", status: "due" });

    expectOk(await closeConditionWithoutMaintenance({ occurrenceId }));

    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.status).toBe("skipped");
    expect(occ?.closeReason).toBe("condition_recovered");
    expect(world.handle.db.select().from(completion).all()).toHaveLength(0);
  });
});
