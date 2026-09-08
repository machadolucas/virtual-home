/**
 * §9 P0 items 51–63, 67, 68 — the notification engine's scheduling half.
 *
 * Every test drives the shipped schema (in-memory SQLite built by the real migrations) with an
 * injected fake clock and an injected `sender`, so "Home Assistant is down" is a boolean rather
 * than a network condition. The invariants under test are the ones an outage would otherwise
 * break: one send per (occurrence, recipient) per slot, the weekly rhythm anchored to the due
 * date, and a clear that survives the transport being unavailable.
 *
 * Household defaults in play (`src/db/schema/household.ts`): tz `Europe/Helsinki`, delivery
 * `09:00` (= `07:00Z` in winter), interval 7 days, send window `08:00`–`21:30`, grace 30 min,
 * catch-up gap 120 min, digest threshold 3.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { writeTx } from "@/db/client";
import { completion, maintenanceOccurrence } from "@/db/schema/maintenance";
import { haNotifyCommand, reminderSlot } from "@/db/schema/notifications";
import { stockTransaction } from "@/db/schema/inventory";
import { CLAIM_TTL_MS } from "@/domain/notify/tick";
import { BACKOFF_MS } from "@/domain/notify/outbox";
import { DEFAULT_LEASE_TTL_MS, LEASE_OUTBOX_DRAIN, acquireLease } from "@/domain/notify/lease";
import { digestTagFor, tagFor } from "@/domain/notify/recipients";
import { loadOccurrence, markCompleted, postpone } from "@/domain/occurrence";
import { instantOf, localTimeOf } from "@/domain/time";
import type { RecurrenceRule } from "@/domain/recurrence";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../helpers/clock";
import { makeCompletion, makeDevice, makeOccurrence, makePlan, makeWorld, type TestWorld } from "./fixtures";
import {
  alerts,
  at,
  attemptsOf,
  clearCommands,
  commands,
  drain,
  fakeHaSender,
  notifiedEvents,
  notifyCommands,
  openSlot,
  payloadOf,
  slotsOf,
  stateOf,
  statesOf,
  tick,
  tickAndDrain,
} from "./notify-helpers";

const TZ = "Europe/Helsinki";
const SIX_MONTHS: RecurrenceRule = { v: 1, kind: "interval_from_completion", every: 6, unit: "month" };

/** `t(n)` for a due date of 2027-01-04 with the default 7-day interval and 09:00 delivery. */
const T = [
  at("2027-01-04T07:00:00Z"),
  at("2027-01-11T07:00:00Z"),
  at("2027-01-18T07:00:00Z"),
  at("2027-01-25T07:00:00Z"),
  at("2027-02-01T07:00:00Z"),
  at("2027-02-08T07:00:00Z"),
];

let world: TestWorld | null = null;

function open(startIso: string): TestWorld {
  world = makeWorld(startIso);
  return world;
}

afterEach(() => {
  world?.close();
  world = null;
});

/** A shared-assignment occurrence due 2027-01-04, with a phone for each user. */
function sharedTask(w: TestWorld): { planId: string; occId: string } {
  makeDevice(w, w.lucas.id, { label: "lucas-phone" });
  makeDevice(w, w.marja.id, { label: "marja-phone" });
  const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
  const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04" });
  return { planId, occId };
}

/** The same, assigned to Lucas alone — one recipient makes a cadence assertion unambiguous. */
function soloTask(w: TestWorld, dueDate = "2027-01-04"): { planId: string; occId: string } {
  makeDevice(w, w.lucas.id, { label: "lucas-solo-phone" });
  const planId = makePlan(w, {
    rule: SIX_MONTHS,
    anchorDate: "2026-07-04",
    assignmentMode: "user",
    assigneeUserId: w.lucas.id,
  });
  const occId = makeOccurrence(w, {
    planId,
    dueDate,
    assignmentMode: "user",
    assigneeUserId: w.lucas.id,
  });
  return { planId, occId };
}

function allSlots(w: TestWorld) {
  return w.handle.db.select().from(reminderSlot).all();
}

describe("the due-date notification", () => {
  // 51
  it("fires once at delivery time with slot_index 0, and never in advance", async () => {
    const w = open("2027-01-01T07:00:00Z");
    const { occId } = sharedTask(w);
    const sender = fakeHaSender();

    // Every hour from three days out up to one minute before 09:00 on the due date.
    for (let now = at("2027-01-01T07:00:00Z"); now < T[0]!; now += HOUR_MS) {
      w.clock.set(now);
      await tickAndDrain(w, sender);
      expect(loadOccurrence(w.handle.db, occId).status).toBe("pending");
      // The recipient states exist from the first tick; a *slot* is what would notify, and there
      // is no advance reminder in this design at all.
      expect(allSlots(w)).toHaveLength(0);
      expect(commands(w)).toHaveLength(0);
    }
    expect(statesOf(w, occId)).toHaveLength(2);

    w.clock.set(T[0]!);
    const first = tick(w);
    expect(first.becameDue).toEqual([occId]);
    expect(first.slotsCreated).toBe(2);
    expect(first.commandsQueued).toBe(2);

    for (const state of statesOf(w, occId)) {
      const slots = slotsOf(w, state.id);
      expect(slots).toHaveLength(1);
      expect(slots[0]!.slotIndex).toBe(0);
      expect(slots[0]!.scheduledAtMs).toBe(T[0]);
      expect(slots[0]!.consolidatedCount).toBe(1);
    }

    const drained = await drain(w, sender);
    expect(drained.sent).toBe(2);
    expect(sender.calls).toHaveLength(2);
    expect(notifyCommands(w).map((c) => payloadOf(c).message)).toEqual(["Due today", "Due today"]);

    // The successor slot is a week out; ticking through the rest of the day adds nothing.
    for (let i = 0; i < 12; i += 1) {
      w.clock.advance(HOUR_MS);
      await tickAndDrain(w, sender);
    }
    expect(sender.calls).toHaveLength(2);
    for (const state of statesOf(w, occId)) {
      expect(state.nextSlotIndex).toBe(1);
      expect(openSlot(w, state.id)?.scheduledAtMs).toBe(T[1]);
    }
  });

  // 52
  it("produces one recipient state, tag and command per recipient", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = sharedTask(w); // one phone each, so one command per recipient
    const soloPlanId = makePlan(w, {
      rule: SIX_MONTHS,
      anchorDate: "2026-07-04",
      assignmentMode: "user",
      assigneeUserId: w.lucas.id,
    });
    const soloOccId = makeOccurrence(w, {
      planId: soloPlanId,
      title: "Test the smoke alarm",
      dueDate: "2027-01-04",
      assignmentMode: "user",
      assigneeUserId: w.lucas.id,
    });
    const sender = fakeHaSender();
    await tickAndDrain(w, sender);

    const shared = statesOf(w, occId);
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((s) => s.tag))).toEqual(
      new Set([tagFor(occId, w.lucas.id), tagFor(occId, w.marja.id)]),
    );
    const sharedCommands = notifyCommands(w).filter((c) => c.tag.includes(occId));
    expect(sharedCommands).toHaveLength(2);
    expect(new Set(sharedCommands.map((c) => c.notifyService)).size).toBe(2);

    const soloStates = statesOf(w, soloOccId);
    expect(soloStates).toHaveLength(1);
    expect(soloStates[0]!.recipientUserId).toBe(w.lucas.id);
    const soloCommands = notifyCommands(w).filter((c) => c.tag.includes(soloOccId));
    expect(soloCommands).toHaveLength(1);
    expect(payloadOf(soloCommands[0]!).data.action_data!.recipientUserId).toBe(w.lucas.id);
  });
});

describe("weekly cadence", () => {
  // 53
  it("sends at due, +7, +14 and +21 days, each at 09:00 local and each exactly once", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = soloTask(w);
    const sender = fakeHaSender();
    const state = () => stateOf(w, occId, w.lucas.id);

    for (let n = 0; n <= 3; n += 1) {
      w.clock.set(T[n]!);
      await tickAndDrain(w, sender);
      expect(sender.calls).toHaveLength(n + 1);
      expect(state().lastSentSlotIndex).toBe(n);
      expect(state().nextSlotIndex).toBe(n + 1);
      expect(openSlot(w, state().id)?.scheduledAtMs).toBe(T[n + 1]);
    }

    const sent = slotsOf(w, state().id).filter((s) => s.state === "sent");
    expect(sent.map((s) => s.slotIndex)).toEqual([0, 1, 2, 3]);
    for (const slot of slotsOf(w, state().id)) {
      expect(localTimeOf(slot.scheduledAtMs, TZ)).toBe("09:00");
    }
    expect(notifiedEvents(w, occId).map((e) => e.slotIndex)).toEqual([0, 1, 2, 3]);

    // A whole day of minute-by-minute ticks between two slots must add nothing.
    w.clock.set(at("2027-01-26T07:00:00Z"));
    for (let i = 0; i < 1440; i += 1) {
      w.clock.advance(MINUTE_MS);
      tick(w);
    }
    await drain(w, sender);
    expect(sender.calls).toHaveLength(4);
    expect(notifyCommands(w)).toHaveLength(4);
    expect(openSlot(w, state().id)?.slotIndex).toBe(4);
  });

  // 63
  it("keeps one identical tag across slot_index 0..5", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = soloTask(w);
    const sender = fakeHaSender();

    for (const scheduled of T) {
      w.clock.set(scheduled);
      await tickAndDrain(w, sender);
    }

    const state = stateOf(w, occId, w.lucas.id);
    expect(slotsOf(w, state.id).filter((s) => s.state === "sent").map((s) => s.slotIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    const tags = new Set(notifyCommands(w).map((c) => c.tag));
    expect(tags).toEqual(new Set([tagFor(occId, w.lucas.id)]));
    expect(new Set(notifyCommands(w).map((c) => payloadOf(c).data.tag))).toEqual(tags);
    // Each slot still carries its own nonce — the tag is stable, the nonce is not.
    const nonces = slotsOf(w, state.id).map((s) => s.nonce);
    expect(new Set(nonces).size).toBe(nonces.length);
  });
});

describe("clearing", () => {
  // 54
  it("clears both recipients on completion and never sends again", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = sharedTask(w);
    const sender = fakeHaSender();
    await tickAndDrain(w, sender);
    w.clock.set(T[1]!);
    await tickAndDrain(w, sender);
    expect(sender.calls).toHaveLength(4);

    // Day 10 after the due date.
    w.clock.set(at("2027-01-14T10:00:00Z"));
    const completionId = makeCompletion(w, {
      occurrenceId: occId,
      completedLocalDate: "2027-01-14",
    });
    writeTx(w.handle.db, (t) =>
      markCompleted(t, w.ctx, {
        occurrenceId: occId,
        completionId,
        completedLocalDate: "2027-01-14",
        completedAtMs: w.clock.now(),
      }),
    );

    for (const state of statesOf(w, occId)) {
      expect(state.state).toBe("cleared");
      expect(state.clearReason).toBe("completed");
      expect(state.clearedAtMs).toBe(w.clock.now());
      expect(openSlot(w, state.id)).toBeUndefined();
      expect(slotsOf(w, state.id).some((s) => s.state === "cancelled")).toBe(true);
    }

    const clears = clearCommands(w);
    expect(clears).toHaveLength(2);
    expect(new Set(clears.map((c) => c.tag))).toEqual(
      new Set([tagFor(occId, w.lucas.id), tagFor(occId, w.marja.id)]),
    );
    expect(new Set(clears.map((c) => JSON.parse(c.payloadJson).message))).toEqual(
      new Set(["clear_notification"]),
    );

    const before = notifyCommands(w).length;
    for (let day = 0; day < 100; day += 1) {
      w.clock.advance(DAY_MS);
      await tickAndDrain(w, sender);
    }
    // The successor occurrence may legitimately notify later; this occurrence never does again.
    const forThisTask = notifyCommands(w).filter((c) => c.tag.includes(occId));
    expect(forThisTask).toHaveLength(before);
    expect(clearCommands(w).every((c) => c.state === "sent")).toBe(true);
  });
});

describe("restart catch-up", () => {
  // 55 — the §4.5 worked example, asserted field by field.
  it("consolidates a month of missed reminders into one send anchored to the due date", async () => {
    const w = open("2027-01-02T10:00:00Z");
    const { occId } = sharedTask(w);
    const sender = fakeHaSender();

    // A healthy tick before the outage, so the heartbeat gap is measurable afterwards.
    const healthy = tick(w);
    expect(healthy.ran).toBe(true);
    expect(healthy.inCatchUp).toBe(false);
    expect(allSlots(w)).toHaveLength(0);

    // Mac mini offline 2027-01-03 → 2027-02-03 12:00 local (= 10:00Z).
    w.clock.set(at("2027-02-03T10:00:00Z"));
    const restart = tick(w);
    expect(restart.inCatchUp).toBe(true);
    expect(restart.outageMs).toBe(at("2027-02-03T10:00:00Z") - at("2027-01-02T10:00:00Z"));
    expect(restart.becameDue).toEqual([occId]);
    expect(restart.slotsFastForwarded).toBe(2);
    expect(restart.slotsHeld).toBe(0);
    expect(restart.digestsSent).toBe(0);
    expect(restart.commandsQueued).toBe(2);

    for (const state of statesOf(w, occId)) {
      expect(state.anchorDate).toBe("2027-01-04"); // the anchor never moved
      const slots = slotsOf(w, state.id);
      expect(slots).toHaveLength(1);
      const slot = slots[0]!;
      expect(slot.slotIndex).toBe(4);
      expect(slot.consolidatedFromIndex).toBe(0);
      expect(slot.consolidatedCount).toBe(5);
      expect(slot.scheduledAtMs).toBe(T[4]);
      expect(slot.scheduledLocalDate).toBe("2027-02-01");
    }

    const drained = await drain(w, sender);
    expect(drained.sent).toBe(2);
    expect(drained.slotsSent).toBe(2);
    // Exactly one notification per recipient — never a replay of the four missed weeks.
    expect(sender.calls).toHaveLength(2);
    expect(new Set(notifyCommands(w).map((c) => payloadOf(c).message))).toEqual(
      new Set(["Overdue since 4 Jan · 5 reminders while offline"]),
    );

    for (const state of statesOf(w, occId)) {
      expect(state.lastSentSlotIndex).toBe(4);
      expect(state.nextSlotIndex).toBe(5);
      const next = openSlot(w, state.id)!;
      expect(next.slotIndex).toBe(5);
      expect(next.scheduledAtMs).toBe(T[5]); // 2027-02-08T07:00Z, still anchored to 4 Jan
      expect(next.scheduledLocalDate).toBe("2027-02-08");
      expect(next.consolidatedCount).toBe(1);
    }
    const events = notifiedEvents(w, occId);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.slotIndex).toBe(4);
      expect(event.consolidatedCount).toBe(5);
      expect(event.consolidatedFromIndex).toBe(0);
      expect(event.via).toBe("push");
    }
  });

  // 56
  it("holds a late slot outside the send window and sends once when it opens", async () => {
    const w = open("2027-01-03T10:00:00Z");
    const { occId } = soloTask(w);
    const sender = fakeHaSender();
    tick(w); // heartbeat before the outage

    // Restart at 03:00 local on 11 January — inside nobody's idea of a reasonable push.
    w.clock.set(at("2027-01-11T01:00:00Z"));
    const held = tick(w);
    expect(held.becameDue).toEqual([occId]);
    expect(held.slotsHeld).toBe(1);
    expect(held.commandsQueued).toBe(0);
    const state = stateOf(w, occId, w.lucas.id);
    expect(openSlot(w, state.id)!.heldUntilMs).toBe(instantOf("2027-01-11", "08:00", TZ));
    await drain(w, sender);
    expect(sender.calls).toHaveLength(0);

    // 08:00 local: the window opens.
    w.clock.set(instantOf("2027-01-11", "08:00", TZ));
    const sent = tick(w);
    expect(sent.slotsHeld).toBe(0);
    expect(sent.commandsQueued).toBe(1);
    await drain(w, sender);
    expect(sender.calls).toHaveLength(1);
    const fired = slotsOf(w, state.id).find((s) => s.state === "sent")!;
    expect(fired.slotIndex).toBe(0);
    expect(notifyCommands(w)).toHaveLength(1);
  });

  // 57
  it("sends one digest instead of six pushes when a recipient is over the threshold", async () => {
    const w = open("2027-01-01T10:00:00Z");
    makeDevice(w, w.lucas.id, { label: "lucas-phone" });
    const sender = fakeHaSender();
    const occIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const planId = makePlan(w, {
        title: `Task ${i}`,
        rule: SIX_MONTHS,
        anchorDate: "2026-07-04",
        assignmentMode: "user",
        assigneeUserId: w.lucas.id,
      });
      occIds.push(
        makeOccurrence(w, {
          planId,
          title: `Task ${i}`,
          dueDate: "2027-01-04",
          assignmentMode: "user",
          assigneeUserId: w.lucas.id,
        }),
      );
    }
    tick(w); // heartbeat before the outage

    w.clock.set(at("2027-01-05T10:00:00Z")); // 12:00 local, a day late, after an outage
    const result = tick(w);
    expect(result.inCatchUp).toBe(true);
    expect(result.digestsSent).toBe(1);
    expect(result.commandsQueued).toBe(1);

    const queued = notifyCommands(w);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.tag).toBe(digestTagFor(w.lucas.id));
    expect(queued[0]!.slotId).toBeNull();
    expect(JSON.parse(queued[0]!.payloadJson).message).toBe("6 tasks are overdue");
    // No per-task pushes at all.
    expect(queued.filter((c) => c.slotId !== null)).toHaveLength(0);

    for (const occId of occIds) {
      const state = stateOf(w, occId, w.lucas.id);
      const slots = slotsOf(w, state.id);
      expect(slots.find((s) => s.slotIndex === 0)!.state).toBe("sent");
      expect(openSlot(w, state.id)!.scheduledAtMs).toBe(T[1]); // the rhythm continues
      const events = notifiedEvents(w, occId);
      expect(events).toHaveLength(1);
      expect(events[0]!.via).toBe("digest");
    }

    const drained = await drain(w, sender);
    expect(drained.sent).toBe(1);
    expect(sender.calls).toHaveLength(1);
  });
});

describe("two workers", () => {
  // 58
  it("lets only the lease holder schedule, and only the fence holder finalise", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = sharedTask(w);

    const first = tick(w, "w1");
    expect(first.ran).toBe(true);
    expect(first.fence).toBe(1);
    expect(first.commandsQueued).toBe(2);

    // The sibling worker's whole tick is a no-op while the lease is live.
    const loser = tick(w, "w2");
    expect(loser.ran).toBe(false);
    expect(loser.fence).toBeNull();
    expect(loser.commandsQueued).toBe(0);

    // Exactly one command per (slot, device): the dedupe key is the structural guarantee.
    const queued = notifyCommands(w);
    expect(queued).toHaveLength(2);
    expect(new Set(queued.map((c) => c.dedupeKey)).size).toBe(2);
    for (const state of statesOf(w, occId)) {
      expect(slotsOf(w, state.id)).toHaveLength(1);
      expect(slotsOf(w, state.id)[0]!.claimedBy).toBe("w1");
      expect(slotsOf(w, state.id)[0]!.claimFence).toBe(1);
    }

    // Once the lease expires the sibling takes over with a bumped fence, and still queues nothing
    // extra (the claims it inherits are not `pending`).
    w.clock.advance(DEFAULT_LEASE_TTL_MS + MINUTE_MS);
    const taken = tick(w, "w2");
    expect(taken.ran).toBe(true);
    expect(taken.fence).toBe(2);
    expect(notifyCommands(w)).toHaveLength(2);

    // The fence check in the finalising transaction: w1 loses the outbox lease mid-call, so it
    // must not write `sent`, even though HA accepted.
    const sender = fakeHaSender();
    let stolen = false;
    sender.onSend = () => {
      if (stolen) return undefined;
      stolen = true;
      w.clock.advance(DEFAULT_LEASE_TTL_MS + MINUTE_MS);
      writeTx(w.handle.db, (t) =>
        acquireLease(t, LEASE_OUTBOX_DRAIN, "w2", DEFAULT_LEASE_TTL_MS, w.clock.now()),
      );
      return undefined;
    };
    const drained = await drain(w, sender, "w1");
    expect(drained.attempted).toBeGreaterThan(0);
    expect(drained.sent).toBe(0);
    for (const command of notifyCommands(w)) {
      expect(command.state).toBe("queued");
      expect(command.sentAtMs).toBeNull();
      // HA did accept the call — the attempt log says so; the fence is what stopped the write.
      expect(attemptsOf(w, command.id).some((a) => a.outcome === "accepted")).toBe(true);
    }
    expect(allSlots(w).every((s) => s.state !== "sent")).toBe(true);
  });

  // 59
  it("retries a drain that died mid-call and still sends exactly once", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = soloTask(w);
    tick(w);
    const command = notifyCommands(w)[0]!;

    const sender = fakeHaSender();
    sender.onSend = () => "ha_error";
    const first = await drain(w, sender);
    expect(first.requeued).toBe(1);
    const afterFailure = notifyCommands(w)[0]!;
    expect(afterFailure.state).toBe("queued");
    expect(afterFailure.attemptCount).toBe(1);
    expect(afterFailure.nextAttemptAtMs).toBe(w.clock.now() + BACKOFF_MS[0]!);

    w.clock.advance(BACKOFF_MS[0]!);
    sender.onSend = undefined;
    const second = await drain(w, sender);
    expect(second.sent).toBe(1);
    expect(second.slotsSent).toBe(1);

    const attempts = attemptsOf(w, command.id);
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
    expect(attempts.filter((a) => a.outcome === "accepted")).toHaveLength(1);
    expect(sender.calls).toHaveLength(1);
    expect(notifyCommands(w)).toHaveLength(1);
    const state = stateOf(w, occId, w.lucas.id);
    expect(openSlot(w, state.id)!.slotIndex).toBe(1);
  });

  it("reclaims a slot claim left behind by a killed worker without duplicating the command", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = soloTask(w);
    tick(w);
    const state = stateOf(w, occId, w.lucas.id);
    expect(openSlot(w, state.id)!.state).toBe("claimed");

    // The worker never came back; the claim expires.
    w.clock.advance(CLAIM_TTL_MS + MINUTE_MS);
    const next = tick(w);
    expect(next.slotsReclaimed).toBe(1);
    expect(next.slotsClaimed).toBe(1);
    expect(next.commandsQueued).toBe(0); // `notify:<slot>:<service>` already exists
    expect(notifyCommands(w)).toHaveLength(1);
    expect(slotsOf(w, state.id)[0]!.attemptCount).toBe(2);

    const sender = fakeHaSender();
    await drain(w, sender);
    expect(sender.calls).toHaveLength(1);
  });
});

describe("the transport outbox", () => {
  // 60
  it("backs off while HA is unreachable and sends once on reconnect", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = soloTask(w);
    tick(w);
    const command = notifyCommands(w)[0]!;
    const state = stateOf(w, occId, w.lucas.id);

    const sender = fakeHaSender();
    sender.connected = false;
    for (const expected of [BACKOFF_MS[0]!, BACKOFF_MS[1]!, BACKOFF_MS[2]!]) {
      const result = await drain(w, sender);
      expect(result.requeued).toBe(1);
      expect(result.sent).toBe(0);
      const row = notifyCommands(w)[0]!;
      expect(row.state).toBe("queued");
      expect(row.lastError).toBe("ha_unavailable");
      expect(row.nextAttemptAtMs).toBe(w.clock.now() + expected);
      w.clock.advance(expected);
    }
    const attempts = attemptsOf(w, command.id);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.outcome === "ha_unavailable")).toBe(true);
    // Nothing was sent, so nothing advanced: no `sent_at_ms`, no successor slot.
    expect(slotsOf(w, state.id)).toHaveLength(1);
    expect(slotsOf(w, state.id)[0]!.state).not.toBe("sent");
    expect(slotsOf(w, state.id)[0]!.sentAtMs).toBeNull();
    expect(stateOf(w, occId, w.lucas.id).lastSentAtMs).toBeNull();

    sender.connected = true;
    const reconnected = await drain(w, sender);
    expect(reconnected.sent).toBe(1);
    expect(sender.calls).toHaveLength(1);
    expect(attemptsOf(w, command.id)).toHaveLength(4);
    expect(openSlot(w, state.id)!.scheduledAtMs).toBe(T[1]);
  });

  // 61
  it("drains a clear queued during the outage before any pending notify", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = sharedTask(w);
    tick(w);
    expect(notifyCommands(w)).toHaveLength(2);

    const sender = fakeHaSender();
    sender.connected = false;
    const failed = await drain(w, sender);
    expect(failed.sent).toBe(0);

    // A completion lands while HA is still down.
    const completionId = makeCompletion(w, {
      occurrenceId: occId,
      completedLocalDate: "2027-01-04",
    });
    writeTx(w.handle.db, (t) =>
      markCompleted(t, w.ctx, {
        occurrenceId: occId,
        completionId,
        completedLocalDate: "2027-01-04",
        completedAtMs: w.clock.now(),
      }),
    );
    expect(clearCommands(w)).toHaveLength(2);
    expect(clearCommands(w).every((c) => c.state === "queued")).toBe(true);

    w.clock.advance(BACKOFF_MS[0]!);
    sender.connected = true;
    const drained = await drain(w, sender);
    expect(drained.sent).toBe(4);

    const kindById = new Map(commands(w).map((c) => [c.id, c.kind]));
    expect(drained.order.map((id) => kindById.get(id))).toEqual([
      "clear",
      "clear",
      "notify",
      "notify",
    ]);
    // The clear survived the outage; the stale notify still went out and is a no-op on the phone.
    expect(clearCommands(w).every((c) => c.state === "sent")).toBe(true);
    expect(drained.slotsSent).toBe(0);
  });

  // 62
  it("records `sent` when HA accepts, and has nowhere to record `delivered`", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = soloTask(w);
    const sender = fakeHaSender();
    await tickAndDrain(w, sender);

    const command = notifyCommands(w)[0]!;
    expect(command.state).toBe("sent");
    expect(command.sentAtMs).toBe(w.clock.now());
    const state = stateOf(w, occId, w.lucas.id);
    const fired = slotsOf(w, state.id).find((s) => s.state === "sent")!;
    expect(fired.sentAtMs).toBe(w.clock.now());
    // Positive delivery evidence only ever comes from an action event.
    expect(state.interactedAtMs).toBeNull();

    const columns = w.handle.sqlite
      .prepare(
        `SELECT m.name AS tbl, p.name AS col
           FROM sqlite_master m JOIN pragma_table_info(m.name) p
          WHERE m.type = 'table'`,
      )
      .all() as Array<{ tbl: string; col: string }>;
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.filter((row) => /delivered/i.test(row.col))).toEqual([]);
  });
});

describe("re-anchoring and failures", () => {
  // 67
  it("re-anchors every recipient to the new due date on postpone", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const { occId } = sharedTask(w);
    const sender = fakeHaSender();
    await tickAndDrain(w, sender);
    for (const state of statesOf(w, occId)) {
      expect(openSlot(w, state.id)!.slotIndex).toBe(1);
    }

    w.clock.set(at("2027-01-06T10:00:00Z"));
    writeTx(w.handle.db, (t) => postpone(t, w.ctx, occId, "2027-02-01", "waiting for filters"));

    for (const state of statesOf(w, occId)) {
      expect(state.anchorDate).toBe("2027-02-01");
      expect(state.nextSlotIndex).toBe(0);
      expect(state.state).toBe("active");
      expect(openSlot(w, state.id)).toBeUndefined();
      expect(
        slotsOf(w, state.id).some((s) => s.state === "cancelled" && s.cancelReason === "postponed"),
      ).toBe(true);
    }

    // The postpone also clears the now-untrue "due" push from both phones.
    expect(clearCommands(w)).toHaveLength(2);

    // No reminder fires until the new due date, and then at index 0 from the new anchor.
    const notifyCalls = () => sender.calls.filter((c) => c.kind === "notify");
    w.clock.set(at("2027-01-25T07:00:00Z"));
    await tickAndDrain(w, sender);
    expect(notifyCalls()).toHaveLength(2);

    w.clock.set(instantOf("2027-02-01", "09:00", TZ));
    await tickAndDrain(w, sender);
    expect(notifyCalls()).toHaveLength(4);
    for (const state of statesOf(w, occId)) {
      const fired = slotsOf(w, state.id).filter((s) => s.state === "sent");
      expect(fired.at(-1)!.slotIndex).toBe(0);
      expect(fired.at(-1)!.scheduledAtMs).toBe(instantOf("2027-02-01", "09:00", TZ));
    }
  });

  // 68
  it("fails the slot and raises an alert when a recipient has no notify device", async () => {
    const w = open("2027-01-04T07:00:00Z");
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-04" });
    const occId = makeOccurrence(w, { planId, dueDate: "2027-01-04" });

    const result = tick(w);
    expect(result.ran).toBe(true);
    expect(result.slotsFailed).toBe(2);
    expect(result.slotsClaimed).toBe(0);
    expect(result.commandsQueued).toBe(0);
    for (const state of statesOf(w, occId)) {
      const slot = slotsOf(w, state.id)[0]!;
      expect(slot.state).toBe("failed");
      expect(slot.cancelReason).toBe("no_device");
    }
    const raised = alerts(w);
    expect(raised).toHaveLength(2);
    expect(new Set(raised.map((a) => a.kind))).toEqual(new Set(["notify_device_missing"]));
    expect(new Set(raised.map((a) => a.entityId))).toEqual(new Set([w.lucas.id, w.marja.id]));

    // The next tick must not crash and must not multiply the alerts.
    w.clock.advance(MINUTE_MS);
    const again = tick(w);
    expect(again.ran).toBe(true);
    expect(again.slotsFailed).toBe(2);
    expect(alerts(w)).toHaveLength(2);
    expect(alerts(w).every((a) => a.seenCount === 2)).toBe(true);

    // Still no fabricated history of any kind.
    expect(w.handle.db.select().from(completion).all()).toHaveLength(0);
    expect(w.handle.db.select().from(stockTransaction).all()).toHaveLength(0);
    expect(
      w.handle.db
        .select()
        .from(haNotifyCommand)
        .where(eq(haNotifyCommand.kind, "notify"))
        .all(),
    ).toHaveLength(0);
    expect(
      w.handle.db
        .select()
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.id, occId))
        .all()[0]!.status,
    ).toBe("due");
  });
});
