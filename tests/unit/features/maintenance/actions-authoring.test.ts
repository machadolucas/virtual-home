/**
 * Integration: the plan, procedure and booking action families.
 *
 * The rules being pinned down:
 *
 *  - **§2.4** — creating a plan writes a *schedule anchor*, never a completion. "Ask me later"
 *    pauses the plan and generates nothing rather than guessing a date.
 *  - **§1.6** — a published procedure version is frozen; editing forks a draft, and publishing
 *    supersedes without deleting.
 *  - **§3.2** — booking a professional does not complete the task and does not move the due date
 *    unless that is asked for explicitly.
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
  requireFreshSession: async () => {
    const { currentUser } = await import("./harness");
    return { user: { id: currentUser() } };
  },
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { eq } from "drizzle-orm";
import {
  completion,
  maintenanceOccurrence,
  maintenancePlan,
  planMaterial,
  serviceBooking,
} from "@/db/schema/maintenance";
import {
  procedure,
  procedureChecklistItem,
  procedureStep,
  procedureVersion,
} from "@/db/schema/procedures";
import {
  cancelPlanAction,
  createPlan,
  previewSchedule,
  seedPlan,
  updatePlan,
} from "@/server/actions/maintenance/plans";
import {
  createProcedure,
  discardProcedureDraft,
  publishProcedureDraft,
  saveProcedureDraft,
  startProcedureDraft,
} from "@/server/actions/maintenance/procedures";
import { bookProfessional, createProvider, updateBooking } from "@/server/actions/maintenance/bookings";
import { makeAsset, makeOccurrence, makePart, makePlan, makeWorld, type TestWorld } from "../../domain/fixtures";
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

const SIX_MONTHS = {
  v: 1 as const,
  kind: "interval_from_completion" as const,
  every: 6,
  unit: "month" as const,
};

function planFields(assetId: string, overrides: Record<string, unknown> = {}) {
  return {
    target: `asset:${assetId}`,
    title: "Replace the ventilation filters",
    description: null,
    procedureId: null,
    scheduleFormKind: "interval_from_completion" as const,
    rule: SIX_MONTHS,
    assignmentMode: "shared" as const,
    assigneeUserId: null,
    priority: "normal" as const,
    estimatedMinutes: 30,
    requiresProfessional: false,
    defaultProviderId: null,
    materials: [],
    status: "active" as const,
    ...overrides,
  };
}

describe("createPlan", () => {
  it("creates a one-off task on its explicit due date", async () => {
    const assetId = makeAsset(world);
    const data = expectOk(await createPlan({
      plan: planFields(assetId, { scheduleFormKind: "one_off", rule: { v: 1, kind: "one_off" } }),
      seed: { kind: "user_chosen", date: "2026-09-30" },
    }));
    expect(data.firstOccurrenceId).toBeTruthy();
    expect(data.firstDueDate).toBe("2026-09-30");
    expect(world.handle.db.select().from(maintenanceOccurrence).all()).toHaveLength(1);
    expect(world.handle.db.select().from(completion).all()).toHaveLength(0);
  });

  it("writes a schedule anchor and generates the first task — and no completion", async () => {
    const assetId = makeAsset(world, { name: "Ventilation unit" });
    const data = expectOk(
      await createPlan({
        plan: planFields(assetId),
        seed: { kind: "baseline_exact", date: "2026-03-08" },
      }),
    );

    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, data.planId))
      .get();
    expect(plan?.scheduleKind).toBe("interval_from_completion");
    expect(plan?.scheduleAnchorDate).toBe("2026-03-08");
    expect(plan?.scheduleAnchorSource).toBe("baseline_exact");
    // The load-bearing assertion: a starting point is not a completion.
    expect(plan?.lastCompletionId).toBeNull();
    expect(world.handle.db.select().from(completion).all()).toHaveLength(0);

    expect(data.firstDueDate).toBe("2026-09-08");
    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, data.firstOccurrenceId!))
      .get();
    expect(occ?.assetId).toBe(assetId);
    expect(occ?.originalDueDate).toBe("2026-09-08");
  });

  it("keeps an approximate anchor approximate, and lets the first task be already overdue", async () => {
    const assetId = makeAsset(world);
    const data = expectOk(
      await createPlan({
        plan: planFields(assetId),
        seed: {
          kind: "baseline_approx",
          date: "2024-04-15",
          note: "Sometime in spring 2024",
        },
      }),
    );
    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, data.planId))
      .get();
    expect(plan?.scheduleAnchorSource).toBe("baseline_approx");
    expect(plan?.scheduleAnchorNote).toBe("Sometime in spring 2024");
    // 2024-10-15 is in the past, which is the truth and not a bug.
    expect(data.firstDueDate).toBe("2024-10-15");
    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, data.firstOccurrenceId!))
      .get();
    expect(occ?.generationNoteJson).toContain("approx");
  });

  it("pauses the plan and generates nothing for “ask me later”", async () => {
    const assetId = makeAsset(world);
    const data = expectOk(
      await createPlan({ plan: planFields(assetId), seed: { kind: "ask_later" } }),
    );
    expect(data.firstOccurrenceId).toBeNull();
    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, data.planId))
      .get();
    expect(plan?.status).toBe("paused");
    expect(plan?.scheduleAnchorSource).toBe("none");
    expect(plan?.scheduleAnchorDate).toBeNull();
    expect(world.handle.db.select().from(maintenanceOccurrence).all()).toHaveLength(0);
  });

  it("stores required materials, and refuses a part that does not exist", async () => {
    const assetId = makeAsset(world);
    const partId = makePart(world);
    const data = expectOk(
      await createPlan({
        plan: planFields(assetId, {
          materials: [{ partId, qtyMilli: 2000, isRequired: true }],
        }),
        seed: { kind: "start_now" },
      }),
    );
    const lines = world.handle.db
      .select()
      .from(planMaterial)
      .where(eq(planMaterial.planId, data.planId))
      .all();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.qtyMilli).toBe(2000);

    const failure = expectFail(
      await createPlan({
        plan: planFields(assetId, {
          materials: [{ partId: "no-such-part", qtyMilli: 1000, isRequired: true }],
        }),
        seed: { kind: "start_now" },
      }),
    );
    expect(failure.error).toBe("not_found");
  });

  it("rejects an unparseable target", async () => {
    const failure = expectFail(
      await createPlan({
        plan: planFields("x", { target: "nonsense" }),
        seed: { kind: "start_now" },
      }),
    );
    expect(failure.error).toBe("invalid_target");
  });

  it("insists on an assignee when the plan is assigned to one person", async () => {
    const assetId = makeAsset(world);
    const failure = expectFail(
      await createPlan({
        plan: planFields(assetId, { assignmentMode: "user", assigneeUserId: null }),
        seed: { kind: "start_now" },
      }),
    );
    expect(failure.error).toBe("assignee_required");
  });
});

describe("seedPlan", () => {
  it("answers “ask me later” afterwards, unpausing the plan and generating the first task", async () => {
    const assetId = makeAsset(world);
    const created = expectOk(
      await createPlan({ plan: planFields(assetId), seed: { kind: "ask_later" } }),
    );

    const data = expectOk(
      await seedPlan({ planId: created.planId, seed: { kind: "user_chosen", date: "2026-09-01" } }),
    );
    expect(data.dueDate).toBe("2027-03-01");
    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, created.planId))
      .get();
    expect(plan?.status).toBe("active");
    expect(plan?.scheduleAnchorSource).toBe("user_chosen");
    expect(world.handle.db.select().from(completion).all()).toHaveLength(0);
  });
});

describe("updatePlan", () => {
  it("changes the plan without rewriting the task already open", async () => {
    const assetId = makeAsset(world);
    const created = expectOk(
      await createPlan({
        plan: planFields(assetId),
        seed: { kind: "baseline_exact", date: "2026-03-08" },
      }),
    );
    const openBefore = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, created.firstOccurrenceId!))
      .get();

    expectOk(
      await updatePlan({
        planId: created.planId,
        plan: planFields(assetId, {
          title: "Replace the ventilation filters (both sides)",
          rule: { v: 1, kind: "interval_from_completion", every: 12, unit: "month" },
          priority: "high",
        }),
      }),
    );

    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, created.planId))
      .get();
    expect(plan?.title).toBe("Replace the ventilation filters (both sides)");
    expect(plan?.recurrenceJson).toContain('"every":12');

    const openAfter = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, created.firstOccurrenceId!))
      .get();
    // The open occurrence is a snapshot: it keeps its title, due date and priority.
    expect(openAfter?.title).toBe(openBefore?.title);
    expect(openAfter?.dueDate).toBe(openBefore?.dueDate);
    expect(openAfter?.priority).toBe(openBefore?.priority);
  });

  it("refuses to edit a cancelled plan", async () => {
    const assetId = makeAsset(world);
    const created = expectOk(
      await createPlan({ plan: planFields(assetId), seed: { kind: "start_now" } }),
    );
    expectOk(await cancelPlanAction({ planId: created.planId, reason: "unit removed" }));
    const failure = expectFail(
      await updatePlan({ planId: created.planId, plan: planFields(assetId) }),
    );
    expect(failure.error).toBe("plan_cancelled");
  });
});

describe("cancelPlanAction", () => {
  it("closes the plan and its open task and keeps the recorded history", async () => {
    const assetId = makeAsset(world);
    const created = expectOk(
      await createPlan({
        plan: planFields(assetId),
        seed: { kind: "baseline_exact", date: "2026-03-08" },
      }),
    );
    expectOk(await cancelPlanAction({ planId: created.planId, reason: "the unit was removed" }));

    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, created.planId))
      .get();
    expect(plan?.status).toBe("cancelled");
    expect(plan?.cancelReason).toBe("the unit was removed");

    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, created.firstOccurrenceId!))
      .get();
    expect(occ?.status).toBe("cancelled");
    expect(occ?.closeReason).toBe("plan_cancelled");

    expect(expectFail(await cancelPlanAction({ planId: created.planId })).error).toBe(
      "plan_already_cancelled",
    );
  });
});

describe("previewSchedule", () => {
  it("computes the next dates in the household time zone", async () => {
    const data = expectOk(
      await previewSchedule({
        rule: { v: 1, kind: "fixed_monthly", months: [4, 10], dayOfMonth: 1 },
        anchorDate: "2026-04-01",
        count: 3,
      }),
    );
    expect(data.today).toBe("2026-09-08");
    expect(data.tz).toBe("Europe/Helsinki");
    expect(data.entries.map((entry) => entry.dueDate)).toEqual([
      "2026-10-01",
      "2027-04-01",
      "2027-10-01",
    ]);
  });

  it("rejects a rule the domain would refuse, rather than previewing nonsense", async () => {
    const failure = expectFail(
      await previewSchedule({
        rule: { v: 1, kind: "fixed_yearly", month: 2, day: 29 } as never,
        anchorDate: null,
      }),
    );
    expect(failure.error).toBe("invalid_request");
  });
});

describe("procedure authoring", () => {
  const content = {
    title: "Replace the ventilation filters",
    summary: "Two filters, twice a year.",
    defaultEffortMinutes: 30,
    prerequisites: "Switch the unit off at the isolator.",
    safetyNotes: "The fan keeps spinning for about a minute.",
    steps: [
      {
        title: "Open the access panel",
        bodyMd: "Two clips at the top; the panel hinges downwards.",
        expectedMinutes: 5,
        isOptional: false,
        warning: null,
        checklist: [
          { text: "Panel seal is intact", requiresValue: null, unit: null },
          { text: "Pressure reading before", requiresValue: "number" as const, unit: "Pa" },
        ],
      },
      {
        title: "Swap both filters",
        bodyMd: null,
        expectedMinutes: 10,
        isOptional: false,
        warning: "Note the airflow arrow on the frame.",
        checklist: [],
      },
    ],
    looseChecklist: [{ text: "Unit restarted and quiet", requiresValue: null, unit: null }],
    tools: [{ name: "Torx T20 screwdriver", isRequired: true, notes: null }],
    materials: [],
    references: [
      {
        kind: "manual" as const,
        label: "Service manual",
        url: null,
        manualName: "Vallox 096 MV",
        pageFrom: 14,
        pageTo: 16,
        attachmentId: null,
      },
    ],
    equipmentNotes: [
      { assetId: null, assetModelName: "096 MV (2019)", note: "The filter clip is reversed." },
    ],
  };

  it("creates a draft, saves it, publishes it, and forks a fresh draft on the next edit", async () => {
    const created = expectOk(await createProcedure({ title: "Replace the ventilation filters" }));

    // A brand-new procedure has one draft and nothing published.
    let versions = world.handle.db
      .select()
      .from(procedureVersion)
      .where(eq(procedureVersion.procedureId, created.procedureId))
      .all();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.status).toBe("draft");
    expect(
      world.handle.db.select().from(procedure).where(eq(procedure.id, created.procedureId)).get()
        ?.currentVersionId,
    ).toBeNull();

    expectOk(await saveProcedureDraft({ procedureId: created.procedureId, content }));
    const steps = world.handle.db
      .select()
      .from(procedureStep)
      .where(eq(procedureStep.versionId, created.versionId))
      .all();
    expect(steps.map((step) => step.title)).toEqual([
      "Open the access panel",
      "Swap both filters",
    ]);
    expect(steps.map((step) => step.seq)).toEqual([0, 1]);
    const checks = world.handle.db
      .select()
      .from(procedureChecklistItem)
      .where(eq(procedureChecklistItem.versionId, created.versionId))
      .all();
    // Two step-level checks plus one final check.
    expect(checks).toHaveLength(3);
    expect(checks.filter((check) => check.stepId === null)).toHaveLength(1);
    expect(checks.find((check) => check.requiresValue === "number")?.unit).toBe("Pa");

    // Saving again replaces the children rather than duplicating them.
    expectOk(await saveProcedureDraft({ procedureId: created.procedureId, content }));
    expect(
      world.handle.db
        .select()
        .from(procedureStep)
        .where(eq(procedureStep.versionId, created.versionId))
        .all(),
    ).toHaveLength(2);

    const published = expectOk(
      await publishProcedureDraft({
        procedureId: created.procedureId,
        changeNote: "First written-down version",
      }),
    );
    expect(published.version).toBe(1);
    const afterPublish = world.handle.db
      .select()
      .from(procedure)
      .where(eq(procedure.id, created.procedureId))
      .get();
    expect(afterPublish?.currentVersionId).toBe(published.versionId);
    expect(
      world.handle.db
        .select()
        .from(procedureVersion)
        .where(eq(procedureVersion.id, published.versionId))
        .get()?.status,
    ).toBe("published");

    // Publishing twice has nothing to publish — the draft is gone.
    expect(
      expectFail(await publishProcedureDraft({ procedureId: created.procedureId })).error,
    ).toBe("no_draft");

    // Editing forks v2 as a copy, leaving v1 exactly as it was.
    const forked = expectOk(await startProcedureDraft({ procedureId: created.procedureId }));
    expect(forked.created).toBe(true);
    versions = world.handle.db
      .select()
      .from(procedureVersion)
      .where(eq(procedureVersion.procedureId, created.procedureId))
      .all();
    expect(versions).toHaveLength(2);
    const v1 = versions.find((version) => version.version === 1);
    const v2 = versions.find((version) => version.version === 2);
    expect(v1?.status).toBe("published");
    expect(v2?.status).toBe("draft");
    expect(
      world.handle.db
        .select()
        .from(procedureStep)
        .where(eq(procedureStep.versionId, v1!.id))
        .all(),
    ).toHaveLength(2);
    expect(
      world.handle.db
        .select()
        .from(procedureStep)
        .where(eq(procedureStep.versionId, v2!.id))
        .all(),
    ).toHaveLength(2);

    // Asking again returns the existing draft rather than piling up versions.
    const again = expectOk(await startProcedureDraft({ procedureId: created.procedureId }));
    expect(again.created).toBe(false);
    expect(again.versionId).toBe(forked.versionId);

    // Publishing v2 supersedes v1 without deleting it.
    expectOk(await publishProcedureDraft({ procedureId: created.procedureId }));
    expect(
      world.handle.db.select().from(procedureVersion).where(eq(procedureVersion.id, v1!.id)).get()
        ?.status,
    ).toBe("superseded");

    // And the discarded draft path leaves the published version in force.
    expectOk(await startProcedureDraft({ procedureId: created.procedureId }));
    expectOk(await discardProcedureDraft({ procedureId: created.procedureId }));
    expect(
      world.handle.db
        .select()
        .from(procedureVersion)
        .where(eq(procedureVersion.procedureId, created.procedureId))
        .all(),
    ).toHaveLength(2);
  });

  it("refuses to publish a version with no steps", async () => {
    const created = expectOk(await createProcedure({ title: "Empty" }));
    const failure = expectFail(await publishProcedureDraft({ procedureId: created.procedureId }));
    expect(failure.error).toBe("no_steps");
  });

  it("refuses to discard the very first draft, which is the whole procedure", async () => {
    const created = expectOk(await createProcedure({ title: "Only draft" }));
    expect(expectFail(await discardProcedureDraft({ procedureId: created.procedureId })).error).toBe(
      "first_draft",
    );
  });

  it("gives each procedure a unique slug", async () => {
    const first = expectOk(await createProcedure({ title: "Clean the gutters" }));
    const second = expectOk(await createProcedure({ title: "Clean the gutters" }));
    const slugs = world.handle.db
      .select()
      .from(procedure)
      .all()
      .filter((row) => row.id === first.procedureId || row.id === second.procedureId)
      .map((row) => row.slug);
    expect(new Set(slugs).size).toBe(2);
    expect(slugs).toContain("clean-the-gutters");
  });
});

describe("bookProfessional", () => {
  it("records the appointment without completing the task or moving the due date", async () => {
    const planId = makePlan(world, { rule: SIX_MONTHS, anchorDate: "2026-03-08" });
    const occurrenceId = makeOccurrence(world, { planId, dueDate: "2026-09-08", status: "due" });
    const provider = expectOk(
      await createProvider({ name: "Ilmastointi Oy", trade: "hvac", phone: "+358 40 000 0000" }),
    );

    const data = expectOk(
      await bookProfessional({
        occurrenceId,
        providerId: provider.providerId,
        scheduledDate: "2026-09-25",
        startTime: "08:00",
        endTime: "12:00",
        windowNote: "between 8 and 12",
        reference: "TT-4412",
      }),
    );
    expect(data.postponedTo).toBeNull();

    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    // Decorated, not closed, and not moved.
    expect(occ?.serviceBookingId).toBe(data.bookingId);
    expect(occ?.status).toBe("due");
    expect(occ?.dueDate).toBe("2026-09-08");
    expect(world.handle.db.select().from(completion).all()).toHaveLength(0);

    const booking = world.handle.db
      .select()
      .from(serviceBooking)
      .where(eq(serviceBooking.id, data.bookingId))
      .get();
    expect(booking?.status).toBe("requested");
    expect(booking?.scheduledLocalDate).toBe("2026-09-25");
    expect(booking?.windowNote).toBe("between 8 and 12");

    // Booking twice is refused rather than silently replacing the appointment.
    expect(
      expectFail(
        await bookProfessional({ occurrenceId, providerId: provider.providerId }),
      ).error,
    ).toBe("already_booked");
  });

  it("moves the due date only when that is asked for explicitly", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "due" });
    const provider = expectOk(await createProvider({ name: "Piippumestari" }));
    const data = expectOk(
      await bookProfessional({
        occurrenceId,
        providerId: provider.providerId,
        scheduledDate: "2026-09-25",
        alsoPostponeToAppointment: true,
      }),
    );
    expect(data.postponedTo).toBe("2026-09-25");
    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.dueDate).toBe("2026-09-25");
    // The honest record of when it was first due survives.
    expect(occ?.originalDueDate).toBe("2026-09-08");
  });

  it("attendance is still not a completion, and cancelling clears the decorator", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "due" });
    const provider = expectOk(await createProvider({ name: "Putkimies" }));
    const booked = expectOk(
      await bookProfessional({ occurrenceId, providerId: provider.providerId }),
    );

    expectOk(
      await updateBooking({ bookingId: booked.bookingId, occurrenceId, status: "attended" }),
    );
    let occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.status).toBe("due");
    expect(world.handle.db.select().from(completion).all()).toHaveLength(0);

    expectOk(
      await updateBooking({ bookingId: booked.bookingId, occurrenceId, status: "cancelled" }),
    );
    occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.serviceBookingId).toBeNull();
  });

  it("refuses to book a closed task", async () => {
    const occurrenceId = makeOccurrence(world, { dueDate: "2026-09-08", status: "skipped" });
    const provider = expectOk(await createProvider({ name: "Sähkömies" }));
    expect(
      expectFail(await bookProfessional({ occurrenceId, providerId: provider.providerId })).error,
    ).toBe("occurrence_not_open");
  });
});
