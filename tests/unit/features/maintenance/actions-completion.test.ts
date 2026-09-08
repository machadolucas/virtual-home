/**
 * Integration: the completion action family, and photo linking.
 *
 * The two contracts asserted here are the ones the whole slice is built around:
 *
 *  - **§5.3** — the server never guesses about stock. A short line comes back as
 *    `insufficient_stock` with its lines, nothing is written, and resubmitting with a per-line
 *    choice **and the same `requestId`** commits exactly once.
 *  - **§5.4** — a void deletes nothing: the completion row stays, the stock is reversed by mirror
 *    rows, and the task reopens.
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

import { eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { newId } from "@/db/ids";
import { attachment, attachmentLink } from "@/db/schema/attachments";
import { stockTransaction } from "@/db/schema/inventory";
import {
  completion,
  completionMaterial,
  maintenanceOccurrence,
  maintenancePlan,
} from "@/db/schema/maintenance";
import { availableMilli } from "@/domain/inventory";
import { linkTaskPhoto, unlinkTaskPhoto } from "@/server/actions/maintenance/attachments";
import {
  completeTask,
  correctTaskCompletion,
  voidTaskCompletion,
} from "@/server/actions/maintenance/complete";
import {
  addStock,
  makeOccurrence,
  makePart,
  makePlan,
  makeWorld,
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

interface Fixture {
  planId: string;
  occurrenceId: string;
  partId: string;
}

/** A six-monthly filter plan with one open task and a two-filter requirement. */
function filterPlan(stockMilli: number): Fixture {
  const partId = makePart(world, { name: "HEPA filter F7" });
  if (stockMilli > 0) addStock(world, partId, stockMilli);
  const planId = makePlan(world, {
    rule: { v: 1, kind: "interval_from_completion", every: 6, unit: "month" },
    anchorDate: "2026-03-08",
    materials: [{ partId, qtyMilli: 2000 }],
  });
  const occurrenceId = makeOccurrence(world, { planId, dueDate: "2026-09-08", status: "due" });
  return { planId, occurrenceId, partId };
}

describe("completeTask", () => {
  it("records the completion, deducts stock and generates the successor", async () => {
    const { planId, occurrenceId, partId } = filterPlan(5000);

    const data = expectOk(
      await completeTask({
        occurrenceId,
        requestId: "req-complete-0001",
        completedAt: { mode: "now" },
        performedByUserId: world.lucas.id,
        notes: "Outer filter was much dirtier than the inner one.",
        effortMinutes: 25,
        materials: [{ partId, actualQtyMilli: 2000, expectedQtyMilli: 2000 }],
      }),
    );

    expect(data.idempotentReplay).toBe(false);
    expect(data.stockResolution).toBe("sufficient");
    // Completion-anchored: six months after the completion date, which is today.
    expect(data.nextDueDate).toBe("2027-03-08");

    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.status).toBe("completed");
    expect(occ?.completionId).toBe(data.completionId);

    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, planId))
      .get();
    expect(plan?.lastCompletionId).toBe(data.completionId);
    expect(plan?.scheduleAnchorSource).toBe("completion");
    expect(plan?.scheduleAnchorDate).toBe("2026-09-08");

    expect(availableMilli(world.handle.db, partId)).toBe(3000);

    const lines = world.handle.db
      .select()
      .from(completionMaterial)
      .where(eq(completionMaterial.completionId, data.completionId))
      .all();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actualQtyMilli: 2000, shortfallMilli: 0, resolution: "sufficient" });
  });

  it("records a backdated completion in the household time zone, not the browser's", async () => {
    const { occurrenceId, partId } = filterPlan(5000);
    const data = expectOk(
      await completeTask({
        occurrenceId,
        requestId: "req-complete-0002",
        completedAt: { mode: "date", date: "2026-09-05", time: "18:30" },
        completedAtPrecision: "exact",
        performedByUserId: world.lucas.id,
        materials: [{ partId, actualQtyMilli: 2000 }],
      }),
    );
    const row = world.handle.db
      .select()
      .from(completion)
      .where(eq(completion.id, data.completionId))
      .get();
    expect(row?.completedLocalDate).toBe("2026-09-05");
    // The anchor follows the real completion date, so the next one is six months from the 5th.
    expect(data.nextDueDate).toBe("2027-03-05");
  });

  it("replays the same requestId instead of completing twice", async () => {
    const { occurrenceId, partId } = filterPlan(5000);
    const input = {
      occurrenceId,
      requestId: "req-complete-0003",
      completedAt: { mode: "now" as const },
      performedByUserId: world.lucas.id,
      materials: [{ partId, actualQtyMilli: 2000 }],
    };
    const first = expectOk(await completeTask(input));
    const second = expectOk(await completeTask(input));

    expect(second.completionId).toBe(first.completionId);
    expect(second.idempotentReplay).toBe(true);
    // One completion, one deduction.
    expect(world.handle.db.select().from(completion).all()).toHaveLength(1);
    expect(availableMilli(world.handle.db, partId)).toBe(3000);
  });

  describe("insufficient stock (§5.3)", () => {
    it("refuses without guessing, changes nothing, and lists the short lines", async () => {
      const { occurrenceId, partId } = filterPlan(1000);
      const failure = expectFail(
        await completeTask({
          occurrenceId,
          requestId: "req-short-0001",
          completedAt: { mode: "now" },
          performedByUserId: world.lucas.id,
          materials: [{ partId, actualQtyMilli: 2000, expectedQtyMilli: 2000 }],
        }),
      );

      expect(failure.error).toBe("insufficient_stock");
      const details = failure.details as {
        lines: { partId: string; partName: string; availableMilli: number; requestedMilli: number; options: string[] }[];
      };
      expect(details.lines).toHaveLength(1);
      expect(details.lines[0]).toMatchObject({
        partId,
        partName: "HEPA filter F7",
        availableMilli: 1000,
        requestedMilli: 2000,
      });
      expect(details.lines[0]?.options).toEqual([
        "adjust_up",
        "consume_available",
        "note_discrepancy",
      ]);

      // Nothing was written: no completion, no stock movement, task still open.
      expect(world.handle.db.select().from(completion).all()).toHaveLength(0);
      expect(availableMilli(world.handle.db, partId)).toBe(1000);
      const occ = world.handle.db
        .select()
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.id, occurrenceId))
        .get();
      expect(occ?.status).toBe("due");
    });

    it("commits once when the retry reuses the same requestId with a resolution", async () => {
      const { occurrenceId, partId } = filterPlan(1000);
      const requestId = "req-short-0002";
      const base = {
        occurrenceId,
        requestId,
        completedAt: { mode: "now" as const },
        performedByUserId: world.lucas.id,
      };

      expectFail(
        await completeTask({ ...base, materials: [{ partId, actualQtyMilli: 2000 }] }),
      );

      const data = expectOk(
        await completeTask({
          ...base,
          materials: [
            { partId, actualQtyMilli: 2000, resolutionIfShort: "adjust_up" },
          ],
        }),
      );

      expect(data.stockResolution).toBe("adjusted_up");
      expect(world.handle.db.select().from(completion).all()).toHaveLength(1);
      // "There was more on the shelf than recorded": the ledger is adjusted up by the missing
      // amount and then the full quantity is consumed, so the net effect is zero and there is no
      // outstanding shortfall to reconcile.
      expect(availableMilli(world.handle.db, partId)).toBe(0);
      const line = world.handle.db.select().from(completionMaterial).get();
      expect(line).toMatchObject({
        resolution: "adjusted_up",
        actualQtyMilli: 2000,
        shortfallMilli: 0,
      });
    });

    it("consume-what's-there records the smaller amount, not the requested one", async () => {
      const { occurrenceId, partId } = filterPlan(1000);
      expectOk(
        await completeTask({
          occurrenceId,
          requestId: "req-short-0003",
          completedAt: { mode: "now" },
          performedByUserId: world.lucas.id,
          materials: [
            { partId, actualQtyMilli: 2000, resolutionIfShort: "consume_available" },
          ],
        }),
      );
      const line = world.handle.db.select().from(completionMaterial).get();
      // What was *used* is still recorded as 2 filters — that is the fact. Only 1 could come out
      // of the ledger, so the difference stays visible as a shortfall instead of being smoothed
      // away, and the balance goes to zero rather than negative.
      expect(line).toMatchObject({
        actualQtyMilli: 2000,
        shortfallMilli: 1000,
        resolution: "consumed_available",
      });
      expect(availableMilli(world.handle.db, partId)).toBe(0);
    });

    it("note-the-discrepancy leaves the shortfall visible", async () => {
      const { occurrenceId, partId } = filterPlan(1000);
      expectOk(
        await completeTask({
          occurrenceId,
          requestId: "req-short-0004",
          completedAt: { mode: "now" },
          performedByUserId: world.lucas.id,
          materials: [
            { partId, actualQtyMilli: 2000, resolutionIfShort: "note_discrepancy" },
          ],
        }),
      );
      const line = world.handle.db.select().from(completionMaterial).get();
      // "Record the truth now, fix the books later": the whole quantity is consumed and the
      // balance is allowed to go negative, which is what makes the discrepancy impossible to miss.
      expect(line).toMatchObject({ resolution: "discrepancy_noted", actualQtyMilli: 2000 });
      expect(availableMilli(world.handle.db, partId)).toBe(-1000);
    });
  });

  it("refuses to complete a task that is already closed", async () => {
    const { occurrenceId, partId } = filterPlan(5000);
    expectOk(
      await completeTask({
        occurrenceId,
        requestId: "req-closed-0001",
        completedAt: { mode: "now" },
        performedByUserId: world.lucas.id,
        materials: [{ partId, actualQtyMilli: 2000 }],
      }),
    );
    // A different request id is a genuinely different attempt, so it must conflict rather than
    // replay (§5.2: exactly one completion).
    const failure = expectFail(
      await completeTask({
        occurrenceId,
        requestId: "req-closed-0002",
        completedAt: { mode: "now" },
        performedByUserId: world.lucas.id,
        materials: [{ partId, actualQtyMilli: 2000 }],
      }),
    );
    expect(failure.error).toBe("already_closed");
  });
});

describe("voidTaskCompletion", () => {
  it("keeps the row, reverses the stock, reopens the task and cancels the successor", async () => {
    const { planId, occurrenceId, partId } = filterPlan(5000);
    const completed = expectOk(
      await completeTask({
        occurrenceId,
        requestId: "req-void-0001",
        completedAt: { mode: "now" },
        performedByUserId: world.lucas.id,
        materials: [{ partId, actualQtyMilli: 2000 }],
      }),
    );
    expect(availableMilli(world.handle.db, partId)).toBe(3000);
    const successorId = completed.nextOccurrenceId;

    const data = expectOk(
      await voidTaskCompletion({
        completionId: completed.completionId,
        occurrenceId,
        reason: "logged against the wrong unit",
        requestId: "req-void-req-0001",
      }),
    );
    expect(data.reversals).toBe(1);

    // Nothing deleted.
    const row = world.handle.db
      .select()
      .from(completion)
      .where(eq(completion.id, completed.completionId))
      .get();
    expect(row).toBeDefined();
    expect(row?.voidedAtMs).not.toBeNull();
    expect(row?.voidReason).toBe("logged against the wrong unit");
    expect(
      world.handle.db
        .select()
        .from(completionMaterial)
        .where(eq(completionMaterial.completionId, completed.completionId))
        .all(),
    ).toHaveLength(1);

    // The balance is back, by a mirror row rather than by an update.
    expect(availableMilli(world.handle.db, partId)).toBe(5000);
    const reversal = world.handle.db
      .select()
      .from(stockTransaction)
      .all()
      .find((tx) => tx.reversesTransactionId !== null);
    expect(reversal).toBeDefined();

    const occ = world.handle.db
      .select()
      .from(maintenanceOccurrence)
      .where(eq(maintenanceOccurrence.id, occurrenceId))
      .get();
    expect(occ?.status).toBe("due");
    expect(occ?.completionId).toBeNull();

    if (successorId !== null) {
      const successor = world.handle.db
        .select()
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.id, successorId))
        .get();
      expect(successor?.status).toBe("cancelled");
    }

    const plan = world.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, planId))
      .get();
    expect(plan?.lastCompletionId).toBeNull();
  });

  it("refuses a second void of the same completion", async () => {
    const { occurrenceId, partId } = filterPlan(5000);
    const completed = expectOk(
      await completeTask({
        occurrenceId,
        requestId: "req-void-0002",
        completedAt: { mode: "now" },
        performedByUserId: world.lucas.id,
        materials: [{ partId, actualQtyMilli: 2000 }],
      }),
    );
    expectOk(
      await voidTaskCompletion({
        completionId: completed.completionId,
        occurrenceId,
        reason: "wrong task",
        requestId: "void-request-a",
      }),
    );
    const failure = expectFail(
      await voidTaskCompletion({
        completionId: completed.completionId,
        occurrenceId,
        reason: "wrong task again",
        requestId: "void-request-b",
      }),
    );
    expect(failure.error).toBe("already_voided");
  });
});

describe("correctTaskCompletion", () => {
  it("writes a correction for the delta and never touches the original consumption row", async () => {
    const { occurrenceId, partId } = filterPlan(5000);
    const completed = expectOk(
      await completeTask({
        occurrenceId,
        requestId: "req-correct-0001",
        completedAt: { mode: "now" },
        performedByUserId: world.lucas.id,
        effortMinutes: 20,
        materials: [{ partId, actualQtyMilli: 2000 }],
      }),
    );

    const data = expectOk(
      await correctTaskCompletion({
        completionId: completed.completionId,
        occurrenceId,
        effortMinutes: 35,
        materials: [{ partId, actualQtyMilli: 1000 }],
      }),
    );
    expect(data.corrections).toBe(1);

    const row = world.handle.db
      .select()
      .from(completion)
      .where(eq(completion.id, completed.completionId))
      .get();
    expect(row?.effortMinutes).toBe(35);

    // One filter was put back: 5000 − 2000 + 1000.
    expect(availableMilli(world.handle.db, partId)).toBe(4000);
    const kinds = world.handle.db
      .select()
      .from(stockTransaction)
      .all()
      .map((tx) => tx.kind);
    expect(kinds).toContain("correction");
    expect(kinds.filter((kind) => kind === "consumption")).toHaveLength(1);
  });
});

describe("photo linking", () => {
  it("links an uploaded file to the task, dedupes the link, and unlinks without deleting it", async () => {
    const { occurrenceId } = filterPlan(5000);
    const attachmentId = newId();
    writeTx(world.handle.db, (tx) => {
      tx.insert(attachment)
        .values({
          id: attachmentId,
          kind: "photo",
          mime: "image/jpeg",
          byteSize: 2048,
          sha256: "a".repeat(64),
          storagePath: "2026/09/photo.jpg",
          originalFilename: "filter.jpg",
          createdAtMs: clock.now(),
          updatedAtMs: clock.now(),
        })
        .run();
    });

    const first = expectOk(
      await linkTaskPhoto({
        attachmentId,
        scope: "occurrence",
        entityId: occurrenceId,
        occurrenceId,
        role: "before",
      }),
    );
    // Linking the same file twice returns the existing link rather than a duplicate row.
    const second = expectOk(
      await linkTaskPhoto({
        attachmentId,
        scope: "occurrence",
        entityId: occurrenceId,
        occurrenceId,
        role: "after",
      }),
    );
    expect(second.linkId).toBe(first.linkId);
    expect(world.handle.db.select().from(attachmentLink).all()).toHaveLength(1);

    expectOk(await unlinkTaskPhoto({ linkId: first.linkId, occurrenceId }));
    expect(world.handle.db.select().from(attachmentLink).all()).toHaveLength(0);
    // The file itself is kept: detaching a photo is not deleting it.
    expect(world.handle.db.select().from(attachment).all()).toHaveLength(1);
  });

  it("refuses to link a file that does not exist", async () => {
    const { occurrenceId } = filterPlan(5000);
    const failure = expectFail(
      await linkTaskPhoto({
        attachmentId: newId(),
        scope: "occurrence",
        entityId: occurrenceId,
        occurrenceId,
      }),
    );
    expect(failure.error).toBe("not_found");
  });
});
