/**
 * Completion and stock atomicity — §9 items 36–47 and 50.
 *
 * Every test asserts the *whole* commit, not just the happy field: after a completion there is one
 * completion row, one consumption, one successor, both recipients cleared; after a rollback there
 * is nothing at all. That combination is the invariant, and asserting the parts separately would
 * miss the failure modes that matter.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@/db/ids";
import {
  appAlert,
  auditLog,
  asset,
  assetReplacement,
  completion,
  completionMaterial,
  haNotifyCommand,
  maintenanceOccurrence,
  maintenancePlan,
  notificationRecipientState,
  occurrenceProgressItem,
  stockTransaction,
} from "@/db/schema";
import { ConflictError, ValidationError } from "@/domain/errors";
import { instantOf } from "@/domain/time";
import { availableMilli, purchase, stockHistory } from "@/domain/inventory";
import {
  InsufficientStockError,
  completeFromAction,
  completeOccurrence,
  correctCompletion,
  isInsufficientStockError,
  voidCompletion,
} from "@/domain/completion";
import { makeFixture, START_DATE, TZ, type Fixture } from "./fixtures-inventory";

/** A filter part, a plan that needs one, one open occurrence and `stockMilli` on the shelf. */
function scenario(f: Fixture, stockMilli: number) {
  const partId = f.addPart({ name: "HEPA filter F7 200×200" });
  if (stockMilli !== 0) {
    f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: stockMilli }));
  }
  const assetId = f.addAsset({ name: "Ventilation unit", category: "hvac" });
  const planId = f.addPlan({ title: "Change the supply filter", assetId });
  f.addPlanMaterial(planId, partId, 1_000);
  const occurrenceId = f.addOccurrence({
    planId,
    assetId,
    title: "Change the supply filter",
    status: "due",
  });
  f.addRecipientStates(occurrenceId);
  f.addNotifyDevices();
  return { partId, assetId, planId, occurrenceId };
}

describe("completeOccurrence", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  // §9 item 36.
  it("happy path: one completion, one consumption, closed occurrence, successor, clears", () => {
    const { partId, planId, occurrenceId } = scenario(f, 3_000);

    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-1",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, expectedQtyMilli: 1_000, actualQtyMilli: 1_000 }],
    });

    expect(result.idempotentReplay).toBe(false);
    expect(result.stockResolution).toBe("sufficient");
    expect(result.completion.completedLocalDate).toBe(START_DATE);
    expect(result.completion.performedByUserId).toBe(f.lucas.id);

    // Exactly one completion, one material line, one consumption.
    const completions = f.tx((tx) => tx.select().from(completion).all());
    expect(completions).toHaveLength(1);
    const materials = f.tx((tx) => tx.select().from(completionMaterial).all());
    expect(materials).toHaveLength(1);
    expect(materials[0]?.resolution).toBe("sufficient");
    expect(materials[0]?.shortfallMilli).toBe(0);

    const ledger = f.tx((tx) => stockHistory(tx, partId, 20));
    const consumptions = ledger.filter((row) => row.kind === "consumption");
    expect(consumptions).toHaveLength(1);
    expect(consumptions[0]?.qtyMilli).toBe(-1_000);
    expect(consumptions[0]?.completionId).toBe(result.completion.id);
    expect(consumptions[0]?.occurrenceId).toBe(occurrenceId);
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(2_000);

    // The occurrence is closed and points at the completion.
    const closed = f.tx((tx) =>
      tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, occurrenceId)).get(),
    );
    expect(closed?.status).toBe("completed");
    expect(closed?.completionId).toBe(result.completion.id);
    expect(closed?.closeReason).toBe("completed");

    // Exactly one successor, six months out, and the plan's anchor moved to the completion.
    expect(result.next).not.toBeNull();
    expect(result.next?.dueDate).toBe("2026-12-10");
    const open = f.tx((tx) =>
      tx
        .select()
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.planId, planId))
        .all()
        .filter((row) => row.status === "pending" || row.status === "due"),
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(result.next?.id);

    const plan = f.tx((tx) =>
      tx.select().from(maintenancePlan).where(eq(maintenancePlan.id, planId)).get(),
    );
    expect(plan?.lastCompletionId).toBe(result.completion.id);
    expect(plan?.scheduleAnchorDate).toBe(START_DATE);
    expect(plan?.scheduleAnchorSource).toBe("completion");

    // Both recipients cleared, one clear command per device.
    const states = f.tx((tx) =>
      tx
        .select()
        .from(notificationRecipientState)
        .where(eq(notificationRecipientState.occurrenceId, occurrenceId))
        .all(),
    );
    expect(states).toHaveLength(2);
    expect(states.every((row) => row.state === "cleared")).toBe(true);
    expect(states.every((row) => row.clearReason === "completed")).toBe(true);
    const clears = f.tx((tx) =>
      tx.select().from(haNotifyCommand).where(eq(haNotifyCommand.kind, "clear")).all(),
    );
    expect(clears).toHaveLength(2);
  });

  // §9 item 37.
  it("the same request id twice returns the first completion and deducts once", () => {
    const { partId, occurrenceId } = scenario(f, 3_000);
    const input = {
      requestId: "req-same",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    };

    const first = completeOccurrence(f.handle, f.ctx, input);
    f.clock.advance(60_000);
    const second = completeOccurrence(f.handle, f.ctx, input);

    expect(second.idempotentReplay).toBe(true);
    expect(second.completion.id).toBe(first.completion.id);
    expect(second.next).toBeNull();
    expect(second.materials).toHaveLength(1);

    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(1);
    const consumptions = f
      .tx((tx) => stockHistory(tx, partId, 20))
      .filter((row) => row.kind === "consumption");
    expect(consumptions).toHaveLength(1);
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(2_000);
  });

  // §9 item 38. better-sqlite3 is synchronous, so "concurrently" means what SQLite actually does
  // with two BEGIN IMMEDIATE transactions: it serialises them. The loser re-reads a closed
  // occurrence — which is exactly the path a second phone would take.
  it("two different request ids: one wins, the other conflicts, one consumption", () => {
    const { partId, planId, occurrenceId } = scenario(f, 3_000);
    const base = {
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    };

    const winner = completeOccurrence(f.handle, f.ctx, { ...base, requestId: "req-lucas" });

    let caught: unknown;
    try {
      completeOccurrence(
        f.handle,
        { ...f.ctx, actorUserId: f.marja.id },
        { ...base, requestId: "req-marja" },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).code).toBe("already_closed");
    expect((caught as ConflictError).detail?.completionId).toBe(winner.completion.id);

    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(1);
    expect(
      f.tx((tx) => stockHistory(tx, partId, 20)).filter((row) => row.kind === "consumption"),
    ).toHaveLength(1);
    const successors = f.tx((tx) =>
      tx
        .select()
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.planId, planId))
        .all()
        .filter((row) => row.status === "pending" || row.status === "due"),
    );
    expect(successors).toHaveLength(1);
  });

  // §9 item 39.
  it("a notification action delivered twice completes once (`act:` + nonce)", () => {
    const { partId, occurrenceId } = scenario(f, 3_000);
    const done = completeFromAction({ handle: f.handle, clock: f.clock, tz: TZ });
    const action = { occurrenceId, recipientUserId: f.marja.id, requestId: "act:deadbeef" };

    const first = done(action);
    const second = done(action);

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.completion.id).toBe(first.completion.id);
    expect(first.completion.source).toBe("notification_action");
    expect(first.completion.performedByUserId).toBe(f.marja.id);
    // Expected materials came from `plan_material`: one filter.
    expect(first.materials).toHaveLength(1);
    expect(first.materials[0]?.expectedQtyMilli).toBe(1_000);
    expect(
      f.tx((tx) => stockHistory(tx, partId, 20)).filter((row) => row.kind === "consumption"),
    ).toHaveLength(1);
  });

  it("a notification action on a short shelf throws so the caller can record a noop", () => {
    const { occurrenceId } = scenario(f, 0);
    const done = completeFromAction({ handle: f.handle, clock: f.clock, tz: TZ });

    expect(() => done({ occurrenceId, recipientUserId: f.lucas.id, requestId: "act:1" })).toThrow(
      InsufficientStockError,
    );
    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(0);
  });

  // §9 item 40.
  it("insufficient stock without a resolution rolls back everything and lists the options", () => {
    const { partId, occurrenceId } = scenario(f, 1_000);

    let caught: unknown;
    try {
      completeOccurrence(f.handle, f.ctx, {
        requestId: "req-short",
        occurrenceId,
        completedAtMs: f.clock.now(),
        materials: [{ partId, expectedQtyMilli: 2_000, actualQtyMilli: 2_000 }],
      });
    } catch (err) {
      caught = err;
    }

    expect(isInsufficientStockError(caught)).toBe(true);
    const err = caught as InsufficientStockError;
    expect(err.code).toBe("insufficient_stock");
    expect(err.lines).toEqual([
      {
        partId,
        partName: "HEPA filter F7 200×200",
        lotId: null,
        availableMilli: 1_000,
        requestedMilli: 2_000,
        options: ["adjust_up", "consume_available", "note_discrepancy"],
      },
    ]);

    // Nothing partial: no completion, no material line, no new ledger row, task still open.
    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(0);
    expect(f.tx((tx) => tx.select().from(completionMaterial).all())).toHaveLength(0);
    expect(f.tx((tx) => stockHistory(tx, partId, 20))).toHaveLength(1);
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(1_000);
    const occ = f.tx((tx) =>
      tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, occurrenceId)).get(),
    );
    expect(occ?.status).toBe("due");
  });

  it("enumerates every short line, not just the first", () => {
    const filter = f.addPart({ name: "Filter" });
    const gasket = f.addPart({ name: "Gasket" });
    const assetId = f.addAsset({ name: "AHU", category: "hvac" });
    const planId = f.addPlan({ title: "Service", assetId });
    const occurrenceId = f.addOccurrence({ planId, assetId, title: "Service" });

    let caught: unknown;
    try {
      completeOccurrence(f.handle, f.ctx, {
        requestId: "req-two-short",
        occurrenceId,
        completedAtMs: f.clock.now(),
        materials: [
          { partId: filter, actualQtyMilli: 1_000 },
          { partId: gasket, actualQtyMilli: 2_000 },
        ],
      });
    } catch (err) {
      caught = err;
    }
    const lines = (caught as InsufficientStockError).lines;
    expect(lines.map((line) => line.partId)).toEqual([filter, gasket]);
  });

  it("retrying a short line with the same request id after a committed attempt replays", () => {
    const { partId, occurrenceId } = scenario(f, 3_000);
    const first = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-retry",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });
    // The client lost the response and retries with a resolution added.
    const retry = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-retry",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000, resolutionIfShort: "note_discrepancy" }],
    });
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.completion.id).toBe(first.completion.id);
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(2_000);
  });

  // §9 item 41.
  it("adjust_up writes an adjustment and a consumption, netting to zero, and audits it", () => {
    const { partId, occurrenceId } = scenario(f, 1_000);

    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-adjust",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, expectedQtyMilli: 2_000, actualQtyMilli: 2_000, resolutionIfShort: "adjust_up" }],
    });

    expect(result.stockResolution).toBe("adjusted_up");
    const rows = f.tx((tx) => stockHistory(tx, partId, 20));
    const adjustment = rows.find((row) => row.kind === "adjustment");
    const consumption = rows.find((row) => row.kind === "consumption");
    expect(adjustment?.qtyMilli).toBe(1_000);
    expect(adjustment?.reason).toBe("reconcile_missing_stock");
    expect(consumption?.qtyMilli).toBe(-2_000);
    expect(adjustment?.transactionGroupId).toBe(consumption?.transactionGroupId);
    // 1000 (purchase) + 1000 (adjustment) − 2000 (consumption)
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(0);

    expect(result.materials[0]?.resolution).toBe("adjusted_up");
    expect(result.materials[0]?.shortfallMilli).toBe(0);
    expect(result.materials[0]?.stockTransactionId).toBe(consumption?.id);

    const audits = f.tx((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, "stock_adjusted")).all(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityId).toBe(adjustment?.id);
    expect(audits[0]?.requestId).toBe("req-adjust");
  });

  // §9 item 42.
  it("consume_available consumes what is recorded and keeps the shortfall on the line", () => {
    const { partId, occurrenceId } = scenario(f, 1_000);

    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-avail",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [
        { partId, expectedQtyMilli: 3_000, actualQtyMilli: 3_000, resolutionIfShort: "consume_available" },
      ],
    });

    expect(result.stockResolution).toBe("consumed_available");
    const consumption = f
      .tx((tx) => stockHistory(tx, partId, 20))
      .find((row) => row.kind === "consumption");
    expect(consumption?.qtyMilli).toBe(-1_000);
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(0);

    const line = result.materials[0];
    expect(line?.actualQtyMilli).toBe(3_000);
    expect(line?.shortfallMilli).toBe(2_000);
    expect(line?.resolution).toBe("consumed_available");
    // The completion itself is preserved.
    expect(result.completion.stockResolution).toBe("consumed_available");
  });

  it("consume_available writes no consumption at all when the balance is already zero", () => {
    const { partId, occurrenceId } = scenario(f, 0);

    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-avail-0",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 2_000, resolutionIfShort: "consume_available" }],
    });

    expect(f.tx((tx) => stockHistory(tx, partId, 20))).toHaveLength(0);
    expect(result.materials[0]?.shortfallMilli).toBe(2_000);
    expect(result.materials[0]?.stockTransactionId).toBeNull();
  });

  // §9 item 43.
  it("note_discrepancy takes the balance negative and raises app_alert('negative_stock')", () => {
    const { partId, occurrenceId } = scenario(f, 1_000);

    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-neg",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 3_000, resolutionIfShort: "note_discrepancy" }],
    });

    expect(result.stockResolution).toBe("discrepancy_noted");
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(-2_000);

    const alerts = f.tx((tx) =>
      tx.select().from(appAlert).where(eq(appAlert.kind, "negative_stock")).all(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.dedupeKey).toBe(`negative_stock:part:${partId}`);
    expect(alerts[0]?.entityId).toBe(partId);
    expect(alerts[0]?.resolvedAtMs).toBeNull();

    // The completion is preserved, not lost.
    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(1);
    expect(result.materials[0]?.resolution).toBe("discrepancy_noted");
  });

  it("a zero-quantity line records the fact and moves no stock", () => {
    const { partId, occurrenceId } = scenario(f, 3_000);

    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-zero",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, expectedQtyMilli: 1_000, actualQtyMilli: 0 }],
    });

    expect(result.materials[0]?.actualQtyMilli).toBe(0);
    expect(result.materials[0]?.stockTransactionId).toBeNull();
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(3_000);
    expect(result.stockResolution).toBe("sufficient");
  });

  it("takes the worst resolution across lines", () => {
    const good = f.addPart({ name: "Filter" });
    const bad = f.addPart({ name: "Gasket" });
    f.tx((tx) => purchase(tx, f.ctx, { partId: good, qtyMilli: 5_000 }));
    const assetId = f.addAsset({ name: "AHU", category: "hvac" });
    const planId = f.addPlan({ title: "Service", assetId });
    const occurrenceId = f.addOccurrence({ planId, assetId, title: "Service" });

    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-worst",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [
        { partId: good, actualQtyMilli: 1_000 },
        { partId: bad, actualQtyMilli: 1_000, resolutionIfShort: "adjust_up" },
      ],
    });
    expect(result.stockResolution).toBe("adjusted_up");
  });

  it("refuses a completion dated in the future", () => {
    const { partId, occurrenceId } = scenario(f, 3_000);
    expect(() =>
      completeOccurrence(f.handle, f.ctx, {
        requestId: "req-future",
        occurrenceId,
        completedAtMs: f.clock.now() + 10 * 60_000,
        materials: [{ partId, actualQtyMilli: 1_000 }],
      }),
    ).toThrow(ValidationError);
  });

  // §9 item 44.
  it("a failure after the material rows rolls back the completion and the stock rows", () => {
    const { partId, occurrenceId } = scenario(f, 3_000);

    expect(() =>
      completeOccurrence(
        f.handle,
        f.ctx,
        {
          requestId: "req-boom",
          occurrenceId,
          completedAtMs: f.clock.now(),
          materials: [{ partId, actualQtyMilli: 1_000 }],
        },
        {
          afterMaterials: () => {
            throw new Error("successor generation exploded");
          },
        },
      ),
    ).toThrow(/exploded/);

    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(0);
    expect(f.tx((tx) => tx.select().from(completionMaterial).all())).toHaveLength(0);
    expect(f.tx((tx) => stockHistory(tx, partId, 20))).toHaveLength(1); // just the purchase
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(3_000);
    const occ = f.tx((tx) =>
      tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, occurrenceId)).get(),
    );
    expect(occ?.status).toBe("due");
    expect(occ?.completionId).toBeNull();
  });
});

describe("voidCompletion", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  // §9 item 45.
  it("restores the balance exactly, cancels an untouched successor and reopens the task", () => {
    const { partId, planId, occurrenceId } = scenario(f, 3_000);

    // A first, earlier completion so the anchor has something to revert to.
    f.clock.advanceToLocal("2026-01-10T09:00", TZ);
    const earlier = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-earlier",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });
    const successorId = earlier.next?.id;
    expect(successorId).toBeDefined();
    f.addRecipientStates(successorId!, earlier.next!.dueDate);

    f.clock.advanceToLocal("2026-06-10T09:00", TZ);
    const second = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-second",
      occurrenceId: successorId!,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(1_000);

    f.clock.advance(2 * 86_400_000);
    const voided = voidCompletion(f.handle, f.ctx, {
      completionId: second.completion.id,
      reason: "wrong task",
      requestId: "void-1",
    });

    // The mirror rows restore the balance exactly; the originals are untouched.
    expect(voided.reversals).toHaveLength(1);
    expect(voided.reversals[0]?.qtyMilli).toBe(1_000);
    expect(voided.reversals[0]?.kind).toBe("correction");
    expect(voided.reversals[0]?.reason).toBe("completion_voided");
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(2_000);
    const originals = f
      .tx((tx) => stockHistory(tx, partId, 20))
      .filter((row) => row.kind === "consumption");
    expect(originals).toHaveLength(2);
    expect(originals.every((row) => row.qtyMilli === -1_000)).toBe(true);

    // The completion row and its lines stay — history reads "completed then voided".
    expect(voided.completion.voidedAtMs).toBe(f.clock.now());
    expect(voided.completion.voidReason).toBe("wrong task");
    expect(f.tx((tx) => tx.select().from(completionMaterial).all())).toHaveLength(2);

    // The successor generated by the voided completion is cancelled, not deleted.
    const successorOfSecond = second.next?.id;
    const cancelled = f.tx((tx) =>
      tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, successorOfSecond!)).get(),
    );
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.closeReason).toBe("superseded_by_void");

    // The voided occurrence is open again — `pending`, because its due date (2026-07-10) is still
    // ahead of the void date, which is the honest state to reopen into.
    const reopened = f.tx((tx) =>
      tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, successorId!)).get(),
    );
    expect(reopened?.status).toBe("pending");
    expect(reopened?.completionId).toBeNull();
    expect(reopened?.closedAtMs).toBeNull();

    // The plan's history pointer reverts to the previous non-voided completion.
    const plan = f.tx((tx) =>
      tx.select().from(maintenancePlan).where(eq(maintenancePlan.id, planId)).get(),
    );
    expect(plan?.lastCompletionId).toBe(earlier.completion.id);
    expect(plan?.scheduleAnchorDate).toBe("2026-01-10");
  });

  // §9 item 46.
  it("is idempotent on the same request id, and refuses a second void", () => {
    const { partId, occurrenceId } = scenario(f, 3_000);
    const done = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-v",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });

    const first = voidCompletion(f.handle, f.ctx, {
      completionId: done.completion.id,
      reason: "oops",
      requestId: "void-same",
    });
    const replay = voidCompletion(f.handle, f.ctx, {
      completionId: done.completion.id,
      reason: "oops",
      requestId: "void-same",
    });

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.reversals).toHaveLength(0);

    // A *different* request id on an already-voided completion is a conflict, not a second mirror.
    let caught: unknown;
    try {
      voidCompletion(f.handle, f.ctx, {
        completionId: done.completion.id,
        reason: "again",
        requestId: "void-other",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).code).toBe("already_voided");

    // Exactly one mirror row exists — UNIQUE(reverses_transaction_id) is the backstop.
    const mirrors = f
      .tx((tx) => stockHistory(tx, partId, 20))
      .filter((row) => row.reversesTransactionId !== null);
    expect(mirrors).toHaveLength(1);
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(3_000);
  });

  it("refuses to void when the successor has been worked on", () => {
    const { partId, occurrenceId } = scenario(f, 5_000);
    const first = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-a",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });

    // Someone started the guided procedure on the successor. That makes it untouchable.
    f.tx((tx) =>
      tx
        .insert(occurrenceProgressItem)
        .values({
          id: newId(),
          occurrenceId: first.next!.id,
          itemKind: "step",
          state: "in_progress",
          changedAtMs: f.clock.now(),
          changedBy: f.marja.id,
        })
        .run(),
    );

    let caught: unknown;
    try {
      voidCompletion(f.handle, f.ctx, {
        completionId: first.completion.id,
        reason: "wrong",
        requestId: "void-blocked",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).code).toBe("successor_touched");

    // Nothing was written: no mirror rows, the completion is still live, the successor still open.
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(4_000);
    expect(
      f.tx((tx) => stockHistory(tx, partId, 20)).filter((row) => row.reversesTransactionId !== null),
    ).toHaveLength(0);
    const stillLive = f.tx((tx) =>
      tx.select().from(completion).where(eq(completion.id, first.completion.id)).get(),
    );
    expect(stillLive?.voidedAtMs).toBeNull();
  });
});

describe("correctCompletion", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  // §9 item 47.
  it("a quantity correction writes the delta only and never touches the original row", () => {
    const { partId, occurrenceId } = scenario(f, 5_000);
    const done = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-c",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });
    const originalConsumption = f
      .tx((tx) => stockHistory(tx, partId, 20))
      .find((row) => row.kind === "consumption");
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(4_000);

    f.clock.advance(3_600_000);
    const corrected = correctCompletion(f.handle, f.ctx, {
      completionId: done.completion.id,
      notes: "used two, not one",
      effortMinutes: 25,
      materials: [{ partId, actualQtyMilli: 2_000 }],
      requestId: "corr-1",
    });

    expect(corrected.corrections).toHaveLength(1);
    const delta = corrected.corrections[0];
    expect(delta?.kind).toBe("correction");
    expect(delta?.reason).toBe("manual_correction");
    // Using one more takes the balance down by one more.
    expect(delta?.qtyMilli).toBe(-1_000);
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(3_000);

    // The original consumption row is byte-for-byte what it was.
    const reread = f.tx((tx) =>
      tx.select().from(stockTransaction).where(eq(stockTransaction.id, originalConsumption!.id)).get(),
    );
    expect(reread).toEqual(originalConsumption);

    expect(corrected.materials[0]?.actualQtyMilli).toBe(2_000);
    expect(corrected.completion.notes).toBe("used two, not one");
    expect(corrected.completion.effortMinutes).toBe(25);

    const diffs = f.tx((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, "updated")).all(),
    );
    expect(diffs.some((row) => row.entityTable === "completion_material")).toBe(true);
  });

  it("writes nothing for an unchanged quantity", () => {
    const { partId, occurrenceId } = scenario(f, 5_000);
    const done = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-d",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });
    const corrected = correctCompletion(f.handle, f.ctx, {
      completionId: done.completion.id,
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });
    expect(corrected.corrections).toHaveLength(0);
    expect(f.tx((tx) => availableMilli(tx, partId))).toBe(4_000);
  });

  it("refuses to correct a voided completion", () => {
    const { partId, occurrenceId } = scenario(f, 5_000);
    const done = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-e",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });
    voidCompletion(f.handle, f.ctx, {
      completionId: done.completion.id,
      reason: "nope",
      requestId: "void-x",
    });
    expect(() =>
      correctCompletion(f.handle, f.ctx, {
        completionId: done.completion.id,
        notes: "too late",
      }),
    ).toThrow(ConflictError);
  });

  // §5.4, the date paragraph: "changing completed_at_ms … regenerates the successor's due date".
  describe("a corrected completion date", () => {
    it("re-anchors the plan and regenerates the untouched successor", () => {
      const { partId, planId, occurrenceId } = scenario(f, 5_000);
      const done = completeOccurrence(f.handle, f.ctx, {
        requestId: "req-date",
        occurrenceId,
        completedAtMs: f.clock.now(),
        materials: [{ partId, actualQtyMilli: 1_000 }],
      });
      expect(done.next?.dueDate).toBe("2026-12-10");

      // "It was actually done on the 3rd, not the 10th."
      const correctedAtMs = instantOf("2026-06-03", "09:00", TZ);
      const result = correctCompletion(f.handle, f.ctx, {
        completionId: done.completion.id,
        completedAtMs: correctedAtMs,
        requestId: "corr-date",
      });

      expect(result.completion.completedAtMs).toBe(correctedAtMs);
      expect(result.completion.completedLocalDate).toBe("2026-06-03");
      expect(result.regeneratedSuccessor).toEqual({
        occurrenceId: done.next!.id,
        fromDueDate: "2026-12-10",
        toDueDate: "2026-12-03",
      });

      // Six months from the corrected date, and still exactly one open occurrence.
      const successor = f.tx((tx) =>
        tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, done.next!.id)).get(),
      );
      expect(successor?.dueDate).toBe("2026-12-03");
      expect(successor?.originalDueDate).toBe("2026-12-03");
      expect(successor?.status).toBe("pending");
      const open = f.tx((tx) =>
        tx
          .select()
          .from(maintenanceOccurrence)
          .where(eq(maintenanceOccurrence.planId, planId))
          .all()
          .filter((row) => row.status === "pending" || row.status === "due"),
      );
      expect(open).toHaveLength(1);

      // The plan's anchor follows the correction; the reminder series is re-anchored with it.
      const plan = f.tx((tx) =>
        tx.select().from(maintenancePlan).where(eq(maintenancePlan.id, planId)).get(),
      );
      expect(plan?.scheduleAnchorDate).toBe("2026-06-03");
      expect(plan?.scheduleAnchorSource).toBe("completion");

      // No stock moved: a date is not a quantity.
      expect(result.corrections).toHaveLength(0);
      expect(f.tx((tx) => availableMilli(tx, partId))).toBe(4_000);
    });

    it("leaves a calendar series exactly where it was", () => {
      const partId = f.addPart({ name: "Filter" });
      f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 5_000 }));
      const planId = f.addPlan({
        title: "Change the filter every April and October",
        scheduleKind: "fixed_calendar",
        recurrenceJson: JSON.stringify({
          v: 1,
          kind: "fixed_monthly",
          months: [4, 10],
          dayOfMonth: 1,
        }),
        scheduleAnchorDate: "2026-04-01",
      });
      const occurrenceId = f.addOccurrence({
        planId,
        title: "Change the filter",
        dueDate: "2026-04-01",
      });
      const done = completeOccurrence(f.handle, f.ctx, {
        requestId: "req-cal",
        occurrenceId,
        completedAtMs: f.clock.now(),
        materials: [],
      });
      expect(done.next?.dueDate).toBe("2026-10-01");

      const result = correctCompletion(f.handle, f.ctx, {
        completionId: done.completion.id,
        completedAtMs: instantOf("2026-06-03", "09:00", TZ),
      });

      // The completion date moved; the series did not.
      expect(result.completion.completedLocalDate).toBe("2026-06-03");
      expect(result.regeneratedSuccessor).toBeNull();
      const successor = f.tx((tx) =>
        tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, done.next!.id)).get(),
      );
      expect(successor?.dueDate).toBe("2026-10-01");
    });

    it("refuses when the successor has already been worked on", () => {
      const { partId, occurrenceId } = scenario(f, 5_000);
      const done = completeOccurrence(f.handle, f.ctx, {
        requestId: "req-touched",
        occurrenceId,
        completedAtMs: f.clock.now(),
        materials: [{ partId, actualQtyMilli: 1_000 }],
      });
      f.tx((tx) =>
        tx
          .insert(occurrenceProgressItem)
          .values({
            id: newId(),
            occurrenceId: done.next!.id,
            itemKind: "step",
            state: "in_progress",
            changedAtMs: f.clock.now(),
            changedBy: f.marja.id,
          })
          .run(),
      );

      let caught: unknown;
      try {
        correctCompletion(f.handle, f.ctx, {
          completionId: done.completion.id,
          completedAtMs: instantOf("2026-06-03", "09:00", TZ),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as ConflictError).code).toBe("successor_touched");

      // Nothing was written: the whole correction rolled back.
      const reread = f.tx((tx) =>
        tx.select().from(completion).where(eq(completion.id, done.completion.id)).get(),
      );
      expect(reread?.completedLocalDate).toBe(START_DATE);
      const successor = f.tx((tx) =>
        tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, done.next!.id)).get(),
      );
      expect(successor?.dueDate).toBe("2026-12-10");
    });

    it("refuses a corrected date in the future", () => {
      const { partId, occurrenceId } = scenario(f, 5_000);
      const done = completeOccurrence(f.handle, f.ctx, {
        requestId: "req-future",
        occurrenceId,
        completedAtMs: f.clock.now(),
        materials: [{ partId, actualQtyMilli: 1_000 }],
      });
      expect(() =>
        correctCompletion(f.handle, f.ctx, {
          completionId: done.completion.id,
          completedAtMs: f.clock.now() + 86_400_000,
        }),
      ).toThrow(ValidationError);
    });
  });
});

// §9 item 50.
describe("equipment replacement inside a completion", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("creates the new unit, retires the old one and repoints the plans", () => {
    const partId = f.addPart({ name: "Filter" });
    f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 5_000 }));
    const oldAssetId = f.addAsset({ name: "Ventilation unit 2014", category: "hvac" });
    const aaa = f.addPart({ name: "AAA" });
    f.addConsumable(oldAssetId, aaa, "battery", 2_000);
    const deviceId = f.addDevice({ name: "AHU" });
    f.linkAsset(oldAssetId, { deviceId, role: "primary" });

    const planId = f.addPlan({ title: "Change the filter", assetId: oldAssetId });
    f.addPlanMaterial(planId, partId, 1_000);
    const pausedPlanId = f.addPlan({
      title: "Old paused plan",
      assetId: oldAssetId,
      status: "paused",
    });
    const occurrenceId = f.addOccurrence({ planId, assetId: oldAssetId, title: "Change the filter" });

    // A completion from before the swap, which must never be rewritten.
    f.clock.advanceToLocal("2026-01-05T09:00", TZ);
    const past = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-past",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
    });
    const swapOccurrenceId = past.next!.id;

    f.clock.advanceToLocal("2026-07-05T09:00", TZ);
    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-swap",
      occurrenceId: swapOccurrenceId,
      completedAtMs: f.clock.now(),
      materials: [{ partId, actualQtyMilli: 1_000 }],
      replacement: {
        newAsset: { name: "Ventilation unit 2026", serialNumber: "SN-2026" },
        reason: "end_of_life",
        cloneConsumables: true,
        cloneHaLinks: true,
      },
    });

    expect(result.replacement).not.toBeNull();
    const newAssetId = result.replacement!.newAssetId;

    const oldAsset = f.tx((tx) => tx.select().from(asset).where(eq(asset.id, oldAssetId)).get());
    const newAsset = f.tx((tx) => tx.select().from(asset).where(eq(asset.id, newAssetId)).get());
    expect(oldAsset?.status).toBe("removed");
    expect(oldAsset?.removedOn).toBe("2026-07-05");
    expect(oldAsset?.replacedByAssetId).toBe(newAssetId);
    expect(newAsset?.status).toBe("installed");
    expect(newAsset?.installedOn).toBe("2026-07-05");
    expect(newAsset?.replacesAssetId).toBe(oldAssetId);
    expect(newAsset?.serialNumber).toBe("SN-2026");
    // Copied, not invented.
    expect(newAsset?.category).toBe("hvac");
    expect(newAsset?.locationId).toBe(oldAsset?.locationId);

    const replacements = f.tx((tx) => tx.select().from(assetReplacement).all());
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.replacedOn).toBe("2026-07-05");
    expect(replacements[0]?.reason).toBe("end_of_life");
    expect(replacements[0]?.completionId).toBe(result.completion.id);
    expect(replacements[0]?.occurrenceId).toBe(swapOccurrenceId);

    // The completion snapshots the unit that was serviced: the OLD one.
    expect(result.completion.assetId).toBe(oldAssetId);
    expect(result.completion.isReplacement).toBe(true);
    // Past completions are untouched.
    const rereadPast = f.tx((tx) =>
      tx.select().from(completion).where(eq(completion.id, past.completion.id)).get(),
    );
    expect(rereadPast?.assetId).toBe(oldAssetId);

    // Active plans move; paused ones do not.
    const plans = f.tx((tx) => tx.select().from(maintenancePlan).all());
    expect(plans.find((p) => p.id === planId)?.assetId).toBe(newAssetId);
    expect(plans.find((p) => p.id === pausedPlanId)?.assetId).toBe(oldAssetId);

    // "6 months after replacement" falls out of the completion anchor for free.
    expect(result.next?.dueDate).toBe("2027-01-05");
    expect(result.next?.assetId).toBe(newAssetId);
  });

  it("refuses a replacement on an occurrence with no asset", () => {
    const planId = f.addPlan({ title: "Sweep the yard" });
    const occurrenceId = f.addOccurrence({ planId, title: "Sweep the yard" });
    expect(() =>
      completeOccurrence(f.handle, f.ctx, {
        requestId: "req-noasset",
        occurrenceId,
        completedAtMs: f.clock.now(),
        materials: [],
        replacement: { newAsset: { name: "Nope" }, reason: "other" },
      }),
    ).toThrow(ValidationError);
  });

  it("raises ha_link_missing when the links are not cloned", () => {
    const oldAssetId = f.addAsset({ name: "Old sensor" });
    const deviceId = f.addDevice();
    f.linkAsset(oldAssetId, { deviceId });
    const planId = f.addPlan({ title: "Swap", assetId: oldAssetId });
    const occurrenceId = f.addOccurrence({ planId, assetId: oldAssetId, title: "Swap" });

    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-nolinks",
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [],
      replacement: { newAsset: { name: "New sensor" }, reason: "failure", cloneHaLinks: false },
    });

    const alerts = f.tx((tx) =>
      tx
        .select()
        .from(appAlert)
        .where(and(eq(appAlert.kind, "ha_link_missing"), isNull(appAlert.resolvedAtMs)))
        .all(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.entityId).toBe(result.replacement!.newAssetId);
  });
});
