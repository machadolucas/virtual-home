/**
 * §9 P0 items 64–66 — the `Done`-vs-`Complete…` decision, inbound action validation, and snooze.
 *
 * The two rules under test:
 *  - a one-tap `Done` is offered **only** when nothing needs to be recorded or chosen, and the
 *    decision is frozen into `reminder_slot.offered_actions_json` at send time, so an action is
 *    later validated against what was actually offered;
 *  - nothing in an inbound HA event is trusted. Every field the phone asserts is checked against
 *    the database, every event is recorded accepted or not, and the second accepted
 *    `(nonce, action)` is rejected by `ux_action_replay`.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { readTx, writeTx } from "@/db/client";
import { completion, maintenanceOccurrence } from "@/db/schema/maintenance";
import { stockTransaction } from "@/db/schema/inventory";
import { reminderSlot } from "@/db/schema/notifications";
import {
  ACTION_DONE,
  ACTION_SNOOZE,
  ACTION_URI,
  allowQuickDone,
  decideActions,
  offeredActionIds,
} from "@/domain/notify/payload";
import {
  handleNotificationAction,
  type CompleteFromActionInput,
  type NotificationActionEvent,
} from "@/domain/notify/actions";
import { loadOccurrence, markCompleted, type OccurrenceRow } from "@/domain/occurrence";
import { instantOf } from "@/domain/time";
import type { RecurrenceRule } from "@/domain/recurrence";
import { DAY_MS } from "../../helpers/clock";
import {
  addStock,
  makeCompletion,
  makeDevice,
  makeOccurrence,
  makePart,
  makePlan,
  makeProcedure,
  makeWorld,
  type TestWorld,
} from "./fixtures";
import {
  actionEvents,
  at,
  drain,
  fakeHaSender,
  openSlot,
  payloadOf,
  slotsOf,
  stateOf,
  statesOf,
  notifyCommands,
  tick,
  tickAndDrain,
  type SlotRow,
  type StateRow,
} from "./notify-helpers";

const TZ = "Europe/Helsinki";
const SIX_MONTHS: RecurrenceRule = { v: 1, kind: "interval_from_completion", every: 6, unit: "month" };
const WEEK_1 = at("2027-01-11T07:00:00Z");
const WEEK_2 = at("2027-01-18T07:00:00Z");

let world: TestWorld | null = null;

function open(startIso: string): TestWorld {
  world = makeWorld(startIso);
  return world;
}

afterEach(() => {
  world?.close();
  world = null;
});

function quickDoneFor(w: TestWorld, occId: string): boolean {
  return readTx(w.handle.db, (tx) => allowQuickDone(tx, loadOccurrence(tx, occId)));
}

function occRow(w: TestWorld, occId: string): OccurrenceRow {
  return loadOccurrence(w.handle.db, occId);
}

describe("allow_quick_done", () => {
  // 64
  it("offers Done only when nothing has to be recorded or chosen", () => {
    const w = open("2027-01-04T07:00:00Z");

    // (a) nothing required at all.
    const plainPlan = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const plain = makeOccurrence(w, { planId: plainPlan, dueDate: "2027-01-04" });
    expect(quickDoneFor(w, plain)).toBe(true);

    // (b) a checklist item that requires a value needs a form, not a button.
    const { procedureId, versionId } = makeProcedure(w, { requiresValue: "number" });
    const checklistPlan = makePlan(w, {
      rule: SIX_MONTHS,
      anchorDate: "2026-07-04",
      procedureId,
    });
    const checklist = makeOccurrence(w, {
      planId: checklistPlan,
      dueDate: "2027-01-04",
      procedureVersionId: versionId,
    });
    expect(quickDoneFor(w, checklist)).toBe(false);

    // (c) an unambiguous, sufficiently stocked material line is fine.
    const filter = makePart(w, { name: "HEPA F7" });
    addStock(w, filter, 2_000);
    const stockedPlan = makePlan(w, {
      rule: SIX_MONTHS,
      anchorDate: "2026-07-04",
      materials: [{ partId: filter, qtyMilli: 1_000 }],
    });
    const stocked = makeOccurrence(w, { planId: stockedPlan, dueDate: "2027-01-04" });
    expect(quickDoneFor(w, stocked)).toBe(true);

    // (d) short stock is a decision (adjust / consume available / note discrepancy).
    const scarce = makePart(w, { name: "Anode rod" });
    addStock(w, scarce, 500);
    const shortPlan = makePlan(w, {
      rule: SIX_MONTHS,
      anchorDate: "2026-07-04",
      materials: [{ partId: scarce, qtyMilli: 1_000 }],
    });
    const short = makeOccurrence(w, { planId: shortPlan, dueDate: "2027-01-04" });
    expect(quickDoneFor(w, short)).toBe(false);

    // (e) a professional job is never completed by tapping a phone.
    const proPlan = makePlan(w, {
      rule: SIX_MONTHS,
      anchorDate: "2026-07-04",
      requiresProfessional: true,
    });
    const pro = makeOccurrence(w, { planId: proPlan, dueDate: "2027-01-04" });
    expect(quickDoneFor(w, pro)).toBe(false);

    // (f) a kit has to be exploded first — another decision.
    const kit = makePart(w, { name: "Service kit", isKit: true });
    addStock(w, kit, 5_000);
    const kitPlan = makePlan(w, {
      rule: SIX_MONTHS,
      anchorDate: "2026-07-04",
      materials: [{ partId: kit, qtyMilli: 1_000 }],
    });
    const kitOcc = makeOccurrence(w, { planId: kitPlan, dueDate: "2027-01-04" });
    expect(quickDoneFor(w, kitOcc)).toBe(false);

    // The action list is what the user sees, and it follows the flag exactly.
    const yes = decideActions(occRow(w, plain), "https://vh.example", true);
    expect(yes.map((a) => a.action)).toEqual([ACTION_URI, ACTION_SNOOZE, ACTION_DONE]);
    expect(yes[2]!.title).toBe("Done");
    const no = decideActions(occRow(w, checklist), "https://vh.example", false);
    expect(no.map((a) => a.action)).toEqual([ACTION_URI, ACTION_SNOOZE, ACTION_URI]);
    expect(no[2]!.title).toBe("Complete…");
    expect(no[2]!.uri).toBe(`https://vh.example/tasks/${checklist}/complete`);
    expect(offeredActionIds(no)).toEqual([ACTION_URI, ACTION_SNOOZE]);
  });

  it("freezes the decision into offered_actions_json at send time", async () => {
    const w = open("2027-01-04T07:00:00Z");
    makeDevice(w, w.lucas.id, { label: "lucas-phone" });
    const { procedureId, versionId } = makeProcedure(w, { requiresValue: "photo" });
    const planId = makePlan(w, {
      rule: SIX_MONTHS,
      anchorDate: "2026-07-04",
      procedureId,
      assignmentMode: "user",
      assigneeUserId: w.lucas.id,
    });
    const occId = makeOccurrence(w, {
      planId,
      dueDate: "2027-01-04",
      procedureVersionId: versionId,
      assignmentMode: "user",
      assigneeUserId: w.lucas.id,
    });
    await tickAndDrain(w, fakeHaSender());

    const state = stateOf(w, occId, w.lucas.id);
    const slot = slotsOf(w, state.id).find((s) => s.slotIndex === 0)!;
    expect(JSON.parse(slot.offeredActionsJson!)).toEqual([ACTION_URI, ACTION_SNOOZE]);
    const actions = payloadOf(notifyCommands(w)[0]!).data.actions;
    expect(actions.map((a) => a.title)).toEqual(["Open", "Snooze 1 day", "Complete…"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Inbound actions
// ---------------------------------------------------------------------------------------------

interface Armed {
  world: TestWorld;
  occId: string;
  state: StateRow;
  slot: SlotRow;
}

/** A solo task whose slot 0 has been sent, so there is a real nonce to tap. */
async function armed(startIso = "2027-01-04T07:00:00Z"): Promise<Armed> {
  const w = open(startIso);
  makeDevice(w, w.lucas.id, { label: "lucas-phone" });
  makeDevice(w, w.marja.id, { label: "marja-phone" });
  const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
  const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04" });
  await tickAndDrain(w, fakeHaSender());
  const state = stateOf(w, occId, w.lucas.id);
  const slot = slotsOf(w, state.id).find((s) => s.slotIndex === 0)!;
  expect(slot.state).toBe("sent");
  expect(JSON.parse(slot.offeredActionsJson!)).toContain(ACTION_SNOOZE);
  return { world: w, occId, state, slot };
}

function validData(a: Armed): Record<string, unknown> {
  return {
    v: 1,
    occurrenceId: a.state.occurrenceId,
    recipientUserId: a.state.recipientUserId,
    slotId: a.slot.id,
    nonce: a.slot.nonce,
  };
}

function send(
  a: Armed,
  event: Partial<NotificationActionEvent> & { action: string },
  deps?: Parameters<typeof handleNotificationAction>[0]["deps"],
) {
  return handleNotificationAction({
    handle: a.world.handle,
    clock: a.world.clock,
    event: { actionData: validData(a), deviceName: "lucas-phone", ...event },
    ...(deps ? { deps } : {}),
  });
}

describe("inbound action validation", () => {
  // 65
  it("rejects a malformed payload, an unknown nonce and a mismatched claim", async () => {
    const a = await armed();

    expect(send(a, { action: ACTION_SNOOZE, actionData: {} }).validation).toBe("malformed");
    expect(
      send(a, { action: ACTION_SNOOZE, actionData: { ...validData(a), v: 2 } }).validation,
    ).toBe("malformed");
    expect(
      send(a, { action: ACTION_SNOOZE, actionData: { ...validData(a), nonce: "00ff00ff" } })
        .validation,
    ).toBe("unknown_nonce");
    expect(
      send(a, {
        action: ACTION_SNOOZE,
        actionData: { ...validData(a), recipientUserId: a.world.marja.id },
      }).validation,
    ).toBe("wrong_recipient");
    expect(
      send(a, {
        action: ACTION_SNOOZE,
        actionData: { ...validData(a), occurrenceId: "not-this-occurrence" },
      }).validation,
    ).toBe("wrong_recipient");
    expect(
      send(a, { action: ACTION_SNOOZE, actionData: { ...validData(a), slotId: "not-this-slot" } })
        .validation,
    ).toBe("malformed");

    // Every rejection is recorded, and none of them did anything.
    const events = actionEvents(a.world);
    expect(events).toHaveLength(6);
    expect(events.every((e) => e.appliedEffect === "noop")).toBe(true);
    expect(events.every((e) => e.validation !== "accepted")).toBe(true);
    expect(stateOf(a.world, a.occId, a.world.lucas.id).snoozeCount).toBe(0);
    expect(stateOf(a.world, a.occId, a.world.lucas.id).interactedAtMs).toBeNull();
  });

  it("rejects an action that was never offered", async () => {
    const a = await armed();
    const offered = JSON.parse(a.slot.offeredActionsJson!) as string[];
    expect(offered).not.toContain("vh_reschedule");
    const result = send(a, { action: "vh_reschedule" });
    expect(result.validation).toBe("action_not_offered");
    expect(result.appliedEffect).toBe("noop");
  });

  it("rejects a nonce older than the action TTL", async () => {
    const a = await armed();
    a.world.clock.advance(31 * DAY_MS);
    const result = send(a, { action: ACTION_SNOOZE });
    expect(result.validation).toBe("expired");
    expect(result.appliedEffect).toBe("noop");
  });

  it("logs but never acts on a tap from the other user's phone", async () => {
    const a = await armed();
    const result = send(a, { action: ACTION_SNOOZE, deviceName: "marja-phone" });
    expect(result.validation).toBe("device_mismatch");
    expect(result.appliedEffect).toBe("noop");
    expect(actionEvents(a.world)[0]!.sourceDeviceName).toBe("marja-phone");
    expect(stateOf(a.world, a.occId, a.world.lucas.id).snoozeCount).toBe(0);
  });

  it("treats a stale tap after completion as a no-op", async () => {
    const a = await armed();
    const completionId = makeCompletion(a.world, {
      occurrenceId: a.occId,
      completedLocalDate: "2027-01-04",
    });
    writeTx(a.world.handle.db, (t) =>
      markCompleted(t, a.world.ctx, {
        occurrenceId: a.occId,
        completionId,
        completedLocalDate: "2027-01-04",
        completedAtMs: a.world.clock.now(),
      }),
    );
    const result = send(a, { action: ACTION_SNOOZE });
    expect(result.validation).toBe("occurrence_closed");
    expect(result.appliedEffect).toBe("noop");
  });

  it("rejects the same tap delivered twice", async () => {
    const a = await armed();
    const first = send(a, { action: ACTION_SNOOZE });
    expect(first.validation).toBe("accepted");
    expect(first.appliedEffect).toBe("snoozed");

    const second = send(a, { action: ACTION_SNOOZE });
    expect(second.validation).toBe("duplicate");
    expect(second.appliedEffect).toBe("noop");
    // The replay left the first effect standing and added nothing.
    expect(stateOf(a.world, a.occId, a.world.lucas.id).snoozeCount).toBe(1);
    expect(
      actionEvents(a.world).filter((e) => e.validation === "accepted"),
    ).toHaveLength(1);
  });

  it("delegates a Done tap once, keyed by the nonce", async () => {
    const a = await armed();
    const seen: CompleteFromActionInput[] = [];
    const completionId = makeCompletion(a.world, {
      occurrenceId: a.occId,
      completedLocalDate: "2027-01-04",
      requestId: `act:${a.slot.nonce}`,
    });
    const deps = {
      completeFromAction: (input: CompleteFromActionInput) => {
        seen.push(input);
        return { completion: { id: completionId } };
      },
    };

    const first = send(a, { action: ACTION_DONE }, deps);
    expect(first.validation).toBe("accepted");
    expect(first.appliedEffect).toBe("completed");
    expect(first.completionId).toBe(completionId);
    expect(seen).toEqual([
      {
        occurrenceId: a.occId,
        recipientUserId: a.world.lucas.id,
        requestId: `act:${a.slot.nonce}`,
      },
    ]);

    const second = send(a, { action: ACTION_DONE }, deps);
    expect(second.validation).toBe("duplicate");
    expect(second.appliedEffect).toBe("noop");
    expect(seen).toHaveLength(1); // the DB gate stopped the second call reaching the ledger
    expect(stateOf(a.world, a.occId, a.world.lucas.id).interactedAtMs).toBe(a.world.clock.now());
  });
});

describe("snooze from a notification", () => {
  // 66
  it("moves only that recipient's next slot to tomorrow and then resumes the anchored series", async () => {
    const a = await armed();
    const w = a.world;
    const marjaBefore = stateOf(w, a.occId, w.marja.id);
    const marjaSlotBefore = openSlot(w, marjaBefore.id)!;
    expect(marjaSlotBefore.slotIndex).toBe(1);
    expect(marjaSlotBefore.scheduledAtMs).toBe(WEEK_1);

    const result = send(a, { action: ACTION_SNOOZE });
    expect(result.validation).toBe("accepted");
    expect(result.appliedEffect).toBe("snoozed");

    const tomorrow9 = instantOf("2027-01-05", "09:00", TZ);
    const lucas = stateOf(w, a.occId, w.lucas.id);
    expect(lucas.state).toBe("snoozed");
    expect(lucas.snoozedUntilMs).toBe(tomorrow9);
    expect(lucas.snoozeCount).toBe(1);
    expect(lucas.anchorDate).toBe("2027-01-04"); // the anchor is untouched
    const snoozeSlot = openSlot(w, lucas.id)!;
    expect(snoozeSlot.isSnooze).toBe(true);
    expect(snoozeSlot.slotIndex).toBe(1); // the index is kept, not restarted
    expect(snoozeSlot.scheduledAtMs).toBe(tomorrow9);
    expect(
      slotsOf(w, lucas.id).some((s) => s.slotIndex === 1 && s.state === "snoozed"),
    ).toBe(true);

    // Marja's series is untouched — a snooze is per recipient.
    const marjaAfter = stateOf(w, a.occId, w.marja.id);
    expect(marjaAfter.state).toBe("active");
    expect(openSlot(w, marjaAfter.id)!.scheduledAtMs).toBe(WEEK_1);
    expect(openSlot(w, marjaAfter.id)!.isSnooze).toBe(false);

    // A snooze is harmless: no completion, no stock movement, no change to the work itself.
    expect(w.handle.db.select().from(completion).all()).toHaveLength(0);
    expect(w.handle.db.select().from(stockTransaction).all()).toHaveLength(0);
    expect(
      w.handle.db
        .select()
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.id, a.occId))
        .all()[0]!.dueDate,
    ).toBe("2027-01-04");

    // Tomorrow the snooze fires once and hands back to the anchored series at t(2).
    const sender = fakeHaSender();
    w.clock.set(tomorrow9);
    const ticked = tick(w);
    expect(ticked.slotsFastForwarded).toBe(0); // a snooze fire is never consolidated
    await drain(w, sender);
    expect(sender.calls).toHaveLength(1);

    const after = stateOf(w, a.occId, w.lucas.id);
    expect(after.state).toBe("active");
    expect(after.snoozedUntilMs).toBeNull();
    expect(after.lastSentSlotIndex).toBe(1);
    expect(after.nextSlotIndex).toBe(2);
    const resumed = openSlot(w, after.id)!;
    expect(resumed.isSnooze).toBe(false);
    expect(resumed.slotIndex).toBe(2);
    expect(resumed.scheduledAtMs).toBe(WEEK_2); // t(2) from the original anchor, not from the snooze

    // Marja still has exactly one open slot, still at t(1).
    expect(
      slotsOf(w, marjaAfter.id).filter((s) => s.state === "pending" || s.state === "claimed"),
    ).toHaveLength(1);
    expect(statesOf(w, a.occId)).toHaveLength(2);
  });
});

/** Guards the `reminder_slot` invariant the whole engine leans on, in every test above. */
describe("slot invariants", () => {
  it("never lets a recipient state hold two open slots", async () => {
    const a = await armed();
    send(a, { action: ACTION_SNOOZE });
    const open = a.world.handle.db
      .select()
      .from(reminderSlot)
      .where(eq(reminderSlot.state, "pending"))
      .all();
    const byState = new Map<string, number>();
    for (const slot of open) {
      byState.set(slot.recipientStateId, (byState.get(slot.recipientStateId) ?? 0) + 1);
    }
    expect([...byState.values()].every((count) => count === 1)).toBe(true);
  });
});
