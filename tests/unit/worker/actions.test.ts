/**
 * The two notification adapters in `src/worker/actions.ts`.
 *
 * Outbound: the whole point of the sender is that each failure mode reaches the drain as the
 * *right* member of `SendOutcome` — `ha_unavailable` means "HA is down, retry soon", `ha_error`
 * means "something is wrong with us". Getting those two the wrong way round is how a reminder
 * would be abandoned during a router reboot.
 *
 * Inbound: an event from a phone is data, not a command. A malformed one is ignored without a
 * trace in the domain; a well-formed one reaches `handleNotificationAction` with the fields the
 * domain validates against the database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { completion } from "@/db/schema/maintenance";
import { completeFromAction } from "@/domain/completion";
import type { CompleteFromActionInput } from "@/domain/notify/actions";
import type { NotifyCommandRow } from "@/domain/notify/recipients";
import type { RecurrenceRule } from "@/domain/recurrence";
import { ACTION_DONE, ACTION_SNOOZE } from "@/domain/notify/payload";
import { HaCommandTimeoutError, HaDisconnectedError } from "@/worker/ha/socket";
import {
  createNotifySender,
  handleHaNotificationAction,
  type NotifyCapableSocket,
} from "@/worker/actions";
import { makeDevice, makeOccurrence, makePlan, makeWorld, type TestWorld } from "../domain/fixtures";
import {
  actionEvents,
  fakeHaSender,
  notifyCommands,
  payloadOf,
  stateOf,
  tickAndDrain,
} from "../domain/notify-helpers";

const SIX_MONTHS: RecurrenceRule = {
  v: 1,
  kind: "interval_from_completion",
  every: 6,
  unit: "month",
};

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let world: TestWorld | null = null;

afterEach(() => {
  world?.close();
  world = null;
});

/* ------------------------------------------------------------------- outbound */

function command(overrides: Partial<NotifyCommandRow> = {}): NotifyCommandRow {
  return {
    id: "cmd-1",
    kind: "notify",
    notifyService: "notify.mobile_app_lucas_iphone",
    payloadJson: JSON.stringify({ title: "Filters", message: "Due today", data: { tag: "vh:x" } }),
    tag: "vh:x",
    slotId: "slot-1",
    recipientStateId: "state-1",
    dedupeKey: "notify:slot-1:notify.mobile_app_lucas_iphone",
    state: "claimed",
    attemptCount: 1,
    nextAttemptAtMs: null,
    claimedBy: "w1",
    claimFence: 1,
    claimExpiresAtMs: null,
    sentAtMs: null,
    lastError: null,
    createdAtMs: 0,
    ...overrides,
  };
}

interface StubSocket extends NotifyCapableSocket {
  calls: Array<{ domain: string; service: string; serviceData?: Record<string, unknown> }>;
}

function stubSocket(
  state: string,
  behaviour: () => Promise<unknown> = async () => ({}),
): StubSocket {
  const calls: StubSocket["calls"] = [];
  return {
    state,
    calls,
    async callService(domain, service, serviceData) {
      calls.push({ domain, service, ...(serviceData ? { serviceData } : {}) });
      return behaviour();
    },
  };
}

describe("createNotifySender", () => {
  it("reports ha_unavailable when HA is not configured at all", async () => {
    const send = createNotifySender({ socket: () => null, logger: silent });
    expect(await send(command())).toBe("ha_unavailable");
  });

  it("reports ha_unavailable for every state that is not 'subscribed'", async () => {
    for (const state of ["disconnected", "connecting", "authenticating", "syncing", "degraded", "backoff", "auth_failed"]) {
      const socket = stubSocket(state);
      const send = createNotifySender({ socket: () => socket, logger: silent });
      expect(await send(command())).toBe("ha_unavailable");
      // Not even attempted: a call on an unauthenticated socket would just reject.
      expect(socket.calls).toHaveLength(0);
    }
  });

  it("calls notify.<service> with the stored payload and reports accepted", async () => {
    const socket = stubSocket("subscribed");
    const send = createNotifySender({ socket: () => socket, logger: silent });

    expect(await send(command())).toBe("accepted");
    expect(socket.calls).toEqual([
      {
        domain: "notify",
        // The `notify.` prefix is stripped: HA's domain and service are separate arguments.
        service: "mobile_app_lucas_iphone",
        serviceData: { title: "Filters", message: "Due today", data: { tag: "vh:x" } },
      },
    ]);
  });

  it("maps a lost connection mid-call to ha_unavailable", async () => {
    const socket = stubSocket("subscribed", () => Promise.reject(new HaDisconnectedError()));
    const send = createNotifySender({ socket: () => socket, logger: silent });
    expect(await send(command())).toBe("ha_unavailable");
  });

  it("maps a command timeout to timeout", async () => {
    const socket = stubSocket("subscribed", () =>
      Promise.reject(new HaCommandTimeoutError("call_service", 30_000)),
    );
    const send = createNotifySender({ socket: () => socket, logger: silent });
    expect(await send(command())).toBe("timeout");
  });

  it("maps any other thrown error to ha_error", async () => {
    const socket = stubSocket("subscribed", () =>
      Promise.reject(new Error("Service notify.mobile_app_x not found")),
    );
    const send = createNotifySender({ socket: () => socket, logger: silent });
    expect(await send(command())).toBe("ha_error");
  });

  it("maps an unusable row to ha_error without calling HA", async () => {
    const socket = stubSocket("subscribed");
    const send = createNotifySender({ socket: () => socket, logger: silent });

    expect(await send(command({ payloadJson: "not json" }))).toBe("ha_error");
    expect(await send(command({ payloadJson: '["an array"]' }))).toBe("ha_error");
    expect(await send(command({ notifyService: "notify.Not A Service" }))).toBe("ha_error");
    expect(socket.calls).toHaveLength(0);
  });

  it("resolves the socket per call, so a late connect is picked up", async () => {
    let socket: StubSocket | null = null;
    const send = createNotifySender({ socket: () => socket, logger: silent });
    expect(await send(command())).toBe("ha_unavailable");
    socket = stubSocket("subscribed");
    expect(await send(command())).toBe("accepted");
  });
});

/* -------------------------------------------------------------------- inbound */

/** A world with one due occurrence whose reminder has been sent, so a slot nonce exists. */
async function sentWorld(): Promise<{ w: TestWorld; occurrenceId: string; nonce: string; slotId: string }> {
  const w = makeWorld("2027-01-11T07:00:00Z");
  world = w;
  makeDevice(w, w.lucas.id, { label: "lucas-phone", haDeviceName: "Lucas iPhone" });
  const planId = makePlan(w, {
    rule: SIX_MONTHS,
    anchorDate: "2026-07-11",
    assignmentMode: "user",
    assigneeUserId: w.lucas.id,
  });
  const occurrenceId = makeOccurrence(w, { planId, dueDate: "2027-01-11" });
  await tickAndDrain(w, fakeHaSender());
  const payload = payloadOf(notifyCommands(w)[0]!);
  const data = payload.data.action_data;
  if (!data) throw new Error("expected action_data in the sent payload");
  return { w, occurrenceId, nonce: data.nonce, slotId: data.slotId };
}

/** The envelope shape `HaSocket` hands its `subscribeEvents` handlers. */
function haEvent(data: unknown, eventType = "mobile_app_notification_action"): unknown {
  return {
    event_type: eventType,
    data,
    origin: "REMOTE",
    time_fired: "2027-01-11T07:05:00.000Z",
    context: { id: "ctx-01", parent_id: null, user_id: "ha-user-1" },
  };
}

describe("handleHaNotificationAction", () => {
  it("maps a well-formed event into the domain and applies the snooze", async () => {
    const { w, occurrenceId, nonce, slotId } = await sentWorld();

    const result = handleHaNotificationAction(
      { handle: w.handle, clock: w.clock, logger: silent },
      haEvent({
        action: ACTION_SNOOZE,
        action_data: { v: 1, occurrenceId, recipientUserId: w.lucas.id, slotId, nonce },
        device_name: "Lucas iPhone",
      }),
    );

    expect(result?.validation).toBe("accepted");
    expect(result?.appliedEffect).toBe("snoozed");

    const events = actionEvents(w);
    expect(events).toHaveLength(1);
    // The adapter is what puts the HA context id on the forensic row.
    expect(events[0]!.haContextId).toBe("ctx-01");
    expect(events[0]!.sourceDeviceName).toBe("Lucas iPhone");
    expect(stateOf(w, occurrenceId, w.lucas.id).state).toBe("snoozed");
  });

  it("passes a Done tap to the injected completeFromAction as act:<nonce>", async () => {
    const { w, occurrenceId, nonce, slotId } = await sentWorld();
    // Returns nothing: this test is about what the adapter *hands over*, not what completion does.
    const seen: CompleteFromActionInput[] = [];
    const completeFromAction = vi.fn((input: CompleteFromActionInput) => {
      seen.push(input);
      return null;
    });

    const result = handleHaNotificationAction(
      { handle: w.handle, clock: w.clock, logger: silent, completeFromAction },
      haEvent({
        action: ACTION_DONE,
        action_data: { v: 1, occurrenceId, recipientUserId: w.lucas.id, slotId, nonce },
      }),
    );

    expect(result?.validation).toBe("accepted");
    expect(result?.appliedEffect).toBe("completed");
    expect(completeFromAction).toHaveBeenCalledTimes(1);
    // `act:<nonce>` is what makes a re-delivered HA action one completion, not two.
    expect(seen).toEqual([
      { occurrenceId, recipientUserId: w.lucas.id, requestId: `act:${nonce}` },
    ]);
  });

  it("completes the occurrence for real with the dependency index.ts injects", async () => {
    const { w, occurrenceId, nonce, slotId } = await sentWorld();

    const result = handleHaNotificationAction(
      {
        handle: w.handle,
        clock: w.clock,
        logger: silent,
        // Exactly the wiring in `src/worker/index.ts`.
        completeFromAction: completeFromAction({ handle: w.handle, clock: w.clock, tz: w.tz }),
      },
      haEvent({
        action: ACTION_DONE,
        action_data: { v: 1, occurrenceId, recipientUserId: w.lucas.id, slotId, nonce },
      }),
    );

    expect(result?.appliedEffect).toBe("completed");
    expect(result?.completionId).not.toBeNull();
    const completions = w.handle.db.select().from(completion).all();
    expect(completions).toHaveLength(1);
    expect(completions[0]!.requestId).toBe(`act:${nonce}`);
    expect(completions[0]!.source).toBe("notification_action");
  });

  it("ignores a malformed event without writing anything", async () => {
    const { w } = await sentWorld();

    // No action field at all.
    expect(
      handleHaNotificationAction(
        { handle: w.handle, clock: w.clock, logger: silent },
        haEvent({ tag: "vh:x" }),
      ),
    ).toBeNull();
    // An empty action.
    expect(
      handleHaNotificationAction(
        { handle: w.handle, clock: w.clock, logger: silent },
        haEvent({ action: "   " }),
      ),
    ).toBeNull();
    // A different event type entirely.
    expect(
      handleHaNotificationAction(
        { handle: w.handle, clock: w.clock, logger: silent },
        haEvent({ action: ACTION_SNOOZE }, "state_changed"),
      ),
    ).toBeNull();
    // Not an object.
    expect(
      handleHaNotificationAction({ handle: w.handle, clock: w.clock, logger: silent }, null),
    ).toBeNull();

    expect(actionEvents(w)).toHaveLength(0);
  });

  it("records a structurally valid but unauthorised event as rejected, and never throws", async () => {
    const { w, occurrenceId, slotId } = await sentWorld();

    const result = handleHaNotificationAction(
      { handle: w.handle, clock: w.clock, logger: silent },
      haEvent({
        action: ACTION_SNOOZE,
        action_data: {
          v: 1,
          occurrenceId,
          recipientUserId: w.lucas.id,
          slotId,
          nonce: "a-nonce-nobody-issued",
        },
      }),
    );

    expect(result?.validation).toBe("unknown_nonce");
    expect(result?.appliedEffect).toBe("noop");
    // Recorded anyway: `notification_action_event` is the forensic log, not a success log.
    expect(actionEvents(w)).toHaveLength(1);
  });

  it("swallows a domain failure instead of throwing into the socket", async () => {
    const { w, occurrenceId, nonce, slotId } = await sentWorld();
    const completeFromAction = vi.fn(() => {
      throw new Error("stock ledger exploded");
    });

    expect(() =>
      handleHaNotificationAction(
        { handle: w.handle, clock: w.clock, logger: silent, completeFromAction },
        haEvent({
          action: ACTION_DONE,
          action_data: { v: 1, occurrenceId, recipientUserId: w.lucas.id, slotId, nonce },
        }),
      ),
    ).not.toThrow();
  });
});
