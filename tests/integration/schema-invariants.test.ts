/**
 * The invariants the *database* enforces, as opposed to the ones the service layer enforces.
 *
 * Each of these is a guard that has to hold even if a bad migration, a second worker or a manual
 * `sqlite3` session tries to violate it — so each is tested against the real migrated schema.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import {
  idempotencyKey,
  location,
  maintenanceOccurrence,
  maintenancePlan,
  notificationActionEvent,
  notificationRecipientState,
  part,
  partStock,
  reminderSlot,
  stockTransaction,
} from "@/db/schema";
import { seedUser, testDb } from "../helpers/db";

const AT = 1_700_000_000_000; // 2023-11-14T22:13:20Z — a fixed instant in the past.

/** Assert that `fn` fails with a specific SQLite constraint code, and return the error. */
function expectSqliteError(fn: () => unknown, code: string): { code?: string; message: string } {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ${code}, but nothing was thrown`).toBeDefined();
  const err = caught as { code?: string; message: string };
  expect(err.code, err.message).toBe(code);
  return err;
}

describe("schema invariants", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = testDb();
  });

  afterEach(() => {
    handle.close();
  });

  function makeLocation(): string {
    const id = newId();
    writeTx(handle.db, (tx) => {
      tx.insert(location)
        .values({
          id,
          kind: "property",
          name: "Test property",
          slug: `prop-${id.slice(0, 8)}`,
          createdAtMs: AT,
          updatedAtMs: AT,
        })
        .run();
    });
    return id;
  }

  function makePlan(): string {
    const id = newId();
    const locationId = makeLocation();
    writeTx(handle.db, (tx) => {
      tx.insert(maintenancePlan)
        .values({
          id,
          title: "Test plan",
          locationId,
          scheduleKind: "interval_from_completion",
          recurrenceJson: '{"v":1,"kind":"interval_from_completion","months":6}',
          assignmentMode: "shared",
          createdAtMs: AT,
          updatedAtMs: AT,
        })
        .run();
    });
    return id;
  }

  function insertOccurrence(planId: string | null, status: "pending" | "due"): string {
    const id = newId();
    writeTx(handle.db, (tx) => {
      tx.insert(maintenanceOccurrence)
        .values({
          id,
          planId,
          source: planId ? "plan" : "manual",
          title: "Test occurrence",
          status,
          dueDate: "2023-12-01",
          originalDueDate: "2023-12-01",
          assignmentMode: "shared",
          createdAtMs: AT,
          updatedAtMs: AT,
        })
        .run();
    });
    return id;
  }

  function makePart(): string {
    const id = newId();
    writeTx(handle.db, (tx) => {
      tx.insert(part)
        .values({
          id,
          name: "Test part",
          trackingMode: "discrete",
          unit: "pcs",
          createdAtMs: AT,
          updatedAtMs: AT,
        })
        .run();
    });
    return id;
  }

  function insertStock(values: {
    partId: string;
    qtyMilli: number;
    kind: "purchase" | "consumption" | "adjustment";
    reason: "purchase" | "maintenance_consumption" | "stock_take";
  }): string {
    const id = newId();
    writeTx(handle.db, (tx) => {
      tx.insert(stockTransaction)
        .values({
          id,
          partId: values.partId,
          qtyMilli: values.qtyMilli,
          kind: values.kind,
          reason: values.reason,
          occurredAtMs: AT,
          occurredLocalDate: "2023-11-14",
          createdAtMs: AT,
        })
        .run();
    });
    return id;
  }

  it("allows only one open occurrence per plan (ux_occ_open_per_plan)", () => {
    const planId = makePlan();
    insertOccurrence(planId, "pending");

    const err = expectSqliteError(
      () => insertOccurrence(planId, "due"),
      "SQLITE_CONSTRAINT_UNIQUE",
    );
    // SQLite names the indexed columns (or the index, for an expression index), not the index name.
    expect(err.message).toMatch(/plan_id|ux_occ_open_per_plan/);
  });

  it("allows a new open occurrence once the previous one is closed", () => {
    const planId = makePlan();
    const first = insertOccurrence(planId, "due");
    writeTx(handle.db, (tx) => {
      tx.update(maintenanceOccurrence)
        .set({ status: "skipped", closedAtMs: AT, closeReason: "not needed" })
        .where(eq(maintenanceOccurrence.id, first))
        .run();
    });

    expect(() => insertOccurrence(planId, "pending")).not.toThrow();
  });

  it("allows only one non-terminal reminder slot per recipient state (ux_slot_one_open)", () => {
    const planId = makePlan();
    const occurrenceId = insertOccurrence(planId, "due");
    const lucas = seedUser(handle, { username: "lucas", name: "Lucas" });

    const recipientStateId = newId();
    writeTx(handle.db, (tx) => {
      tx.insert(notificationRecipientState)
        .values({
          id: recipientStateId,
          occurrenceId,
          recipientUserId: lucas.id,
          tag: `vh:occ:${occurrenceId}:${lucas.id}`,
          anchorDate: "2023-12-01",
          createdAtMs: AT,
          updatedAtMs: AT,
        })
        .run();
    });

    const insertSlot = (slotIndex: number, state: "pending" | "claimed" | "sent"): void => {
      writeTx(handle.db, (tx) => {
        tx.insert(reminderSlot)
          .values({
            id: newId(),
            recipientStateId,
            slotIndex,
            scheduledAtMs: AT + slotIndex * 86_400_000,
            scheduledLocalDate: "2023-12-01",
            state,
            nonce: newId().replace(/-/g, ""),
            createdAtMs: AT,
          })
          .run();
      });
    };

    insertSlot(0, "pending");
    const err = expectSqliteError(() => insertSlot(1, "claimed"), "SQLITE_CONSTRAINT_UNIQUE");
    expect(err.message).toMatch(/recipient_state_id|ux_slot_one_open/);

    // A terminal slot is not "open", so it does not collide.
    expect(() => insertSlot(2, "sent")).not.toThrow();
  });

  it("rejects a replayed accepted (nonce, action) (ux_action_replay)", () => {
    const nonce = "a".repeat(32);
    const insertAction = (validation: "accepted" | "duplicate"): void => {
      writeTx(handle.db, (tx) => {
        tx.insert(notificationActionEvent)
          .values({
            id: newId(),
            receivedAtMs: AT,
            nonce,
            action: "done",
            rawJson: "{}",
            validation,
            appliedEffect: validation === "accepted" ? "completed" : "noop",
          })
          .run();
      });
    };

    insertAction("accepted");
    const err = expectSqliteError(() => insertAction("accepted"), "SQLITE_CONSTRAINT_UNIQUE");
    expect(err.message).toMatch(/nonce|ux_action_replay/);

    // Recording the replay itself must still succeed — that is how the handler answers.
    expect(() => insertAction("duplicate")).not.toThrow();
  });

  it("rejects a zero-quantity stock transaction", () => {
    const partId = makePart();
    const err = expectSqliteError(
      () => insertStock({ partId, qtyMilli: 0, kind: "adjustment", reason: "stock_take" }),
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(err.message).toContain("ck_stock_transaction_qty_nonzero");
  });

  it("rejects a positive 'consumption' stock transaction", () => {
    const partId = makePart();
    const err = expectSqliteError(
      () =>
        insertStock({
          partId,
          qtyMilli: 1000,
          kind: "consumption",
          reason: "maintenance_consumption",
        }),
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(err.message).toContain("ck_stock_transaction_consumption_sign");
  });

  it("sums signed quantities in the part_stock view", () => {
    const partId = makePart();
    const emptyPartId = makePart();

    insertStock({ partId, qtyMilli: 5000, kind: "purchase", reason: "purchase" });
    insertStock({ partId, qtyMilli: 2000, kind: "purchase", reason: "purchase" });
    insertStock({
      partId,
      qtyMilli: -3000,
      kind: "consumption",
      reason: "maintenance_consumption",
    });

    const [row] = handle.db.select().from(partStock).where(eq(partStock.partId, partId)).all();
    expect(row).toBeDefined();
    expect(row?.onHandMilli).toBe(4000);
    expect(row?.effectiveMilli).toBe(4000);
    expect(row?.lastMovementMs).toBe(AT);

    // A part with no movements still appears, at zero — that is the LEFT JOIN doing its job.
    const [empty] = handle.db
      .select()
      .from(partStock)
      .where(eq(partStock.partId, emptyPartId))
      .all();
    expect(empty?.onHandMilli).toBe(0);
    expect(empty?.lastMovementMs).toBeNull();
  });

  it("goes negative rather than lying about stock", () => {
    const partId = makePart();
    insertStock({
      partId,
      qtyMilli: -1500,
      kind: "consumption",
      reason: "maintenance_consumption",
    });
    const [row] = handle.db.select().from(partStock).where(eq(partStock.partId, partId)).all();
    expect(row?.onHandMilli).toBe(-1500);
  });

  it("enforces foreign keys", () => {
    const err = expectSqliteError(() => {
      writeTx(handle.db, (tx) => {
        tx.insert(maintenancePlan)
          .values({
            id: newId(),
            title: "Dangling plan",
            locationId: "no-such-location",
            scheduleKind: "one_off",
            recurrenceJson: '{"v":1,"kind":"one_off"}',
            assignmentMode: "shared",
            createdAtMs: AT,
            updatedAtMs: AT,
          })
          .run();
      });
    }, "SQLITE_CONSTRAINT_FOREIGNKEY");
    expect(err.message).toContain("FOREIGN KEY");
  });

  it("keeps household_setting a singleton", () => {
    const err = expectSqliteError(
      () =>
        handle.sqlite
          .prepare(
            `INSERT INTO household_setting (id, display_name, current_model_id, created_at_ms, updated_at_ms)
             VALUES ('other', 'Second house', 'unset', ?, ?)`,
          )
          .run(AT, AT),
      "SQLITE_CONSTRAINT_CHECK",
    );
    expect(err.message).toContain("ck_household_setting_singleton");
  });

  it("round-trips an idempotency key", () => {
    const lucas = seedUser(handle, { username: "lucas", name: "Lucas" });
    const key = newId();
    const responseJson = JSON.stringify({ ok: true, data: { occurrenceId: "abc" } });

    writeTx(handle.db, (tx) => {
      tx.insert(idempotencyKey)
        .values({ key, userId: lucas.id, responseJson, createdAtMs: AT })
        .run();
    });

    const hit = handle.db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.key, key))
      .get();
    expect(hit).toEqual({ key, userId: lucas.id, responseJson, createdAtMs: AT });

    // A replayed submit must not create a second row.
    writeTx(handle.db, (tx) => {
      tx.insert(idempotencyKey)
        .values({ key, userId: lucas.id, responseJson: "{}", createdAtMs: AT + 1 })
        .onConflictDoNothing()
        .run();
    });
    const rows = handle.db.select().from(idempotencyKey).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.responseJson).toBe(responseJson);
  });
});
