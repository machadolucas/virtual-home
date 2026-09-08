/**
 * The worker's two timed loops (§4.4).
 *
 * The three properties `src/worker/scheduler.ts` exists to guarantee, one test each: never two
 * runs of a loop at once, a throwing run never stops the loop, and the loops really are wired to
 * the shipped domain functions (a tick that queues a command, a drain that sends it).
 *
 * Fake timers throughout, so "a minute of worker time" costs no wall-clock time and nothing fires
 * behind the test's back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTx } from "@/db/client";
import {
  DEFAULT_LEASE_TTL_MS,
  LEASE_NOTIFICATION_TICK,
  LEASE_OUTBOX_DRAIN,
  acquireLease,
} from "@/domain/notify/lease";
import type { DrainOutboxResult } from "@/domain/notify/outbox";
import type { TickResult } from "@/domain/notify/tick";
import type { RecurrenceRule } from "@/domain/recurrence";
import { firstRunDelayMs, startScheduler, type Scheduler } from "@/worker/scheduler";
import { makeDevice, makeOccurrence, makePlan, makeWorld, type TestWorld } from "../domain/fixtures";
import { fakeHaSender, leaseOf, notifyCommands } from "../domain/notify-helpers";

const SIX_MONTHS: RecurrenceRule = {
  v: 1,
  kind: "interval_from_completion",
  every: 6,
  unit: "month",
};

const EMPTY_TICK: TickResult = {
  ran: true,
  fence: 1,
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

const EMPTY_DRAIN: DrainOutboxResult = {
  ran: true,
  fence: 1,
  attempted: 0,
  sent: 0,
  requeued: 0,
  abandoned: 0,
  reclaimed: 0,
  slotsSent: 0,
  order: [],
};

/** Silent, so a `warn` about an intentional failure does not look like a test failure. */
const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let world: TestWorld | null = null;
let scheduler: Scheduler | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  scheduler?.stop();
  scheduler = null;
  vi.useRealTimers();
  world?.close();
  world = null;
});

function open(startIso = "2027-01-11T07:00:00Z"): TestWorld {
  world = makeWorld(startIso);
  return world;
}

describe("first-run jitter", () => {
  it("is bounded by the interval and by the 5 s cap", () => {
    expect(firstRunDelayMs(60_000, () => 0)).toBe(0);
    expect(firstRunDelayMs(60_000, () => 0.999)).toBeLessThanOrEqual(5_000);
    // A short interval must not be delayed by more than itself.
    expect(firstRunDelayMs(1_000, () => 0.999)).toBeLessThan(1_000);
  });
});

describe("overlap protection", () => {
  it("never runs two drains at once, and skips instead of interleaving", async () => {
    const w = open();
    let inFlight = 0;
    let maxInFlight = 0;
    const finishers: Array<() => void> = [];

    scheduler = startScheduler({
      handle: w.handle,
      clock: w.clock,
      workerId: "w1",
      sender: async () => "accepted",
      drainMs: 100,
      tickMs: 10_000_000, // effectively off: this test is about the drain
      releaseLeasesOnStop: false,
      deps: {
        random: () => 0,
        logger: silent,
        runTick: () => EMPTY_TICK,
        drain: () =>
          new Promise<DrainOutboxResult>((resolve) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            finishers.push(() => {
              inFlight -= 1;
              resolve(EMPTY_DRAIN);
            });
          }),
      },
    });

    // Jitter is 0, so the first run fires on the first tick of the clock and then blocks.
    await vi.advanceTimersByTimeAsync(0);
    expect(inFlight).toBe(1);
    expect(scheduler.busy.drain).toBe(true);

    // An out-of-band run while one is in flight is refused, not queued.
    expect(await scheduler.runDrainNow()).toBeNull();
    expect(scheduler.stats.drainSkips).toBe(1);

    // And the timer chain cannot start a second one either: the next run is armed only after the
    // current one settles.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(maxInFlight).toBe(1);
    expect(scheduler.stats.drains).toBe(0);

    finishers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.stats.drains).toBe(1);
    expect(scheduler.busy.drain).toBe(false);

    // The loop keeps going after the run it was waiting on.
    await vi.advanceTimersByTimeAsync(100);
    expect(inFlight).toBe(1);
    expect(maxInFlight).toBe(1);
    finishers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.stats.drains).toBe(2);
  });
});

describe("a failing run", () => {
  it("does not stop the loop", async () => {
    const w = open();
    let calls = 0;

    scheduler = startScheduler({
      handle: w.handle,
      clock: w.clock,
      workerId: "w1",
      sender: async () => "accepted",
      tickMs: 1_000,
      drainMs: 10_000_000,
      releaseLeasesOnStop: false,
      deps: {
        random: () => 0,
        logger: silent,
        drain: async () => EMPTY_DRAIN,
        runTick: () => {
          calls += 1;
          if (calls <= 2) throw new Error("boom");
          return EMPTY_TICK;
        },
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls).toBe(3);
    expect(scheduler.stats.tickErrors).toBe(2);
    expect(scheduler.stats.ticks).toBe(1);
  });

  it("survives a rejected drain promise too", async () => {
    const w = open();
    let calls = 0;
    scheduler = startScheduler({
      handle: w.handle,
      clock: w.clock,
      workerId: "w1",
      sender: async () => "accepted",
      tickMs: 10_000_000,
      drainMs: 500,
      releaseLeasesOnStop: false,
      deps: {
        random: () => 0,
        logger: silent,
        runTick: () => EMPTY_TICK,
        drain: async () => {
          calls += 1;
          throw new Error("ha exploded");
        },
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(2);
    expect(scheduler.stats.drainErrors).toBe(2);
  });
});

describe("wiring", () => {
  it("ticks the shipped domain functions: due -> command -> sent", async () => {
    const w = open("2027-01-11T07:00:00Z");
    makeDevice(w, w.lucas.id, { label: "lucas-phone" });
    makeDevice(w, w.marja.id, { label: "marja-phone" });
    const planId = makePlan(w, { rule: SIX_MONTHS, anchorDate: "2026-07-11" });
    makeOccurrence(w, { planId, dueDate: "2027-01-11" });
    const ha = fakeHaSender();

    scheduler = startScheduler({
      handle: w.handle,
      clock: w.clock,
      workerId: "w1",
      sender: (command) => ha.sender(command),
      releaseLeasesOnStop: false,
      deps: { random: () => 0, logger: silent },
    });

    const tick = await scheduler.runTickNow();
    expect(tick?.ran).toBe(true);
    expect(tick?.becameDue).toHaveLength(1);
    // Shared assignment: one command per active device of each recipient.
    expect(tick?.commandsQueued).toBe(2);
    expect(notifyCommands(w)).toHaveLength(2);

    const drained = await scheduler.runDrainNow();
    expect(drained?.attempted).toBe(2);
    expect(drained?.sent).toBe(2);
    expect(ha.calls).toHaveLength(2);
  });

  it("hands both leases back on stop so a restart takes over immediately", () => {
    const w = open();
    const now = w.clock.now();
    writeTx(w.handle.db, (tx) => {
      acquireLease(tx, LEASE_NOTIFICATION_TICK, "w1", DEFAULT_LEASE_TTL_MS, now);
      acquireLease(tx, LEASE_OUTBOX_DRAIN, "w1", DEFAULT_LEASE_TTL_MS, now);
    });
    expect(leaseOf(w, LEASE_NOTIFICATION_TICK)?.holderId).toBe("w1");

    const s = startScheduler({
      handle: w.handle,
      clock: w.clock,
      workerId: "w1",
      sender: async () => "accepted",
      deps: { random: () => 0, logger: silent, runTick: () => EMPTY_TICK, drain: async () => EMPTY_DRAIN },
    });
    s.stop();

    expect(leaseOf(w, LEASE_NOTIFICATION_TICK)?.holderId).toBeNull();
    expect(leaseOf(w, LEASE_OUTBOX_DRAIN)?.holderId).toBeNull();
  });

  it("stop() cancels the timers", async () => {
    const w = open();
    let calls = 0;
    const s = startScheduler({
      handle: w.handle,
      clock: w.clock,
      workerId: "w1",
      sender: async () => "accepted",
      tickMs: 100,
      drainMs: 100,
      releaseLeasesOnStop: false,
      deps: {
        random: () => 0,
        logger: silent,
        drain: async () => EMPTY_DRAIN,
        runTick: () => {
          calls += 1;
          return EMPTY_TICK;
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    s.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
  });
});
