/**
 * Integration tests for the inventory action family.
 *
 * These go through the real `action()` wrapper, the real domain functions and the real migrations,
 * so what they prove is what the UI actually gets: the ledger stays append-only, a correction can
 * happen once, a stock take records a delta rather than a count, and every refusal comes back as a
 * code the screen can turn into a sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ userId: { current: null as string | null } }));

// `server-only` is a build-time guard for the Next bundler; under Vitest its client entry throws.
vi.mock("server-only", () => ({}));

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));

vi.mock("@/server/auth/session", () => {
  class UnauthorizedError extends Error {
    readonly status = 401 as const;
  }
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (mocks.userId.current === null) throw new UnauthorizedError();
      return { user: { id: mocks.userId.current }, session: { id: "test-session" } };
    },
  };
});

import { part, partLot, partSupplier, stockTransaction } from "@/db/schema";
import { getStock } from "@/domain/inventory";
import {
  createPart,
  setKitComponents,
  setPartArchived,
  updatePart,
  upsertLot,
  upsertSupplier,
} from "@/server/actions/inventory/parts";
import {
  addPurchase,
  correctTransaction,
  explodeKit,
  setEstimate,
  stockTake,
  undoExplode,
} from "@/server/actions/inventory/stock";
import {
  expectRefusal,
  makeWorld,
  seedKitComponent,
  seedPart,
  teardown,
  unwrap,
  type World,
} from "./actionSetup";

let world: World;

beforeEach(() => {
  world = makeWorld();
  mocks.userId.current = world.user.id;
});

afterEach(() => {
  mocks.userId.current = null;
  teardown(world);
});

describe("the session boundary", () => {
  it("refuses without a session, before touching the database", async () => {
    mocks.userId.current = null;
    const result = await addPurchase({ partId: "whatever", qtyMilli: 1000 });
    expect(expectRefusal(result)).toBe("unauthorized");
  });
});

describe("createPart", () => {
  it("creates a part with no stock", async () => {
    const { partId } = unwrap(
      await createPart({
        name: "Softener salt",
        trackingMode: "measured",
        unit: "kg",
        reorderThresholdMilli: 10_000,
        reorderTargetMilli: 25_000,
        defaultStoragePlaceId: world.storagePlaceId,
      }),
    );
    const row = world.handle.db.select().from(part).where(eq(part.id, partId)).get();
    expect(row?.name).toBe("Softener salt");
    expect(row?.stockMode).toBe("stocked");
    // Defining an item is not the same as having any of it.
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(0);
  });

  it("refuses a reorder target below the threshold", async () => {
    const result = await createPart({
      name: "Bad thresholds",
      trackingMode: "discrete",
      unit: "pcs",
      reorderThresholdMilli: 5000,
      reorderTargetMilli: 1000,
    });
    expect(expectRefusal(result)).toBe("reorder_target_below_threshold");
  });

  it("refuses a parts list on something that is not a kit", async () => {
    const componentId = seedPart(world, { name: "Filter" });
    const result = await createPart({
      name: "Not a kit",
      trackingMode: "discrete",
      unit: "pcs",
      components: [{ componentPartId: componentId, qtyMilli: 1000 }],
    });
    expect(expectRefusal(result)).toBe("components_on_non_kit");
  });

  it("creates a kit with its contents and its supplier", async () => {
    const componentId = seedPart(world, { name: "Filter" });
    const { partId } = unwrap(
      await createPart({
        name: "Annual filter kit",
        trackingMode: "discrete",
        unit: "pcs",
        isKit: true,
        components: [{ componentPartId: componentId, qtyMilli: 2000 }],
        suppliers: [{ supplierName: "Motonet", isPreferred: true, url: "https://example.test/x" }],
      }),
    );
    const suppliers = world.handle.db
      .select()
      .from(partSupplier)
      .where(eq(partSupplier.partId, partId))
      .all();
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]?.isPreferred).toBe(true);
  });

  it("replays instead of writing twice when the same idempotency key is used", async () => {
    const key = "form-instance-0000001";
    const first = unwrap(
      await createPart({
        name: "Once only",
        trackingMode: "discrete",
        unit: "pcs",
        idempotencyKey: key,
      }),
    );
    const second = unwrap(
      await createPart({
        name: "Once only",
        trackingMode: "discrete",
        unit: "pcs",
        idempotencyKey: key,
      }),
    );
    expect(second.partId).toBe(first.partId);
    expect(world.handle.db.select().from(part).all()).toHaveLength(1);
  });
});

describe("the idempotency key across two real submits", () => {
  /**
   * The client contract this protects, from `useAction` in `features/settings/actionClient.ts` and
   * `features/maintenance/useAction.ts`: a key covers one submit **and its retries**, and is
   * replaced after a success.
   *
   * Both halves matter, and only together. Reusing the key is what makes a double-click harmless;
   * rotating it is what makes the *second* purchase from a dialog that is still mounted a real
   * second ledger row instead of a replay that writes nothing and toasts the first movement's
   * quantity back at the user.
   */
  it("replays the retry of one submit and writes the next one", async () => {
    const partId = seedPart(world);
    const firstSubmit = "form-submit-0000001";

    const first = unwrap(await addPurchase({ partId, qtyMilli: 2000, idempotencyKey: firstSubmit }));
    // The retry: same key, because the first attempt may have committed with the response lost.
    const retry = unwrap(await addPurchase({ partId, qtyMilli: 2000, idempotencyKey: firstSubmit }));
    expect(retry.transactionId).toBe(first.transactionId);
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(2000);

    // A second, deliberate purchase from the same still-mounted dialog: a rotated key, a real row.
    const secondSubmit = "form-submit-0000002";
    const second = unwrap(
      await addPurchase({ partId, qtyMilli: 3000, idempotencyKey: secondSubmit }),
    );
    expect(second.transactionId).not.toBe(first.transactionId);
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(5000);
    expect(
      world.handle.db
        .select()
        .from(stockTransaction)
        .where(eq(stockTransaction.partId, partId))
        .all(),
    ).toHaveLength(2);
  });
});

describe("updatePart", () => {
  const fields = (over: Record<string, unknown> = {}) => ({
    name: "HEPA filter F7",
    trackingMode: "measured" as const,
    unit: "l" as const,
    isKit: false,
    stocked: true,
    tracksLots: false,
    ...over,
  });

  it("lets the unit be corrected while the ledger is still empty", async () => {
    const partId = seedPart(world, { trackingMode: "measured", unit: "l" });
    unwrap(await updatePart({ ...fields({ unit: "kg" }), partId }));
    expect(world.handle.db.select().from(part).where(eq(part.id, partId)).get()?.unit).toBe("kg");
  });

  it("refuses a unit change once a movement exists", async () => {
    const partId = seedPart(world, { trackingMode: "measured", unit: "l" });
    unwrap(await addPurchase({ partId, qtyMilli: 750 }));
    // 750 means "0.75 l" only because the part says litres. Letting the unit move would turn the
    // same stored integer into 0.75 kg without touching a single ledger row.
    const result = await updatePart({ ...fields({ unit: "kg" }), partId });
    expect(expectRefusal(result)).toBe("unit_immutable_with_history");
    expect(world.handle.db.select().from(part).where(eq(part.id, partId)).get()?.unit).toBe("l");
  });

  it("refuses becoming whole-units-only once a movement exists", async () => {
    const partId = seedPart(world, { trackingMode: "measured", unit: "l" });
    unwrap(await addPurchase({ partId, qtyMilli: 750 }));
    const result = await updatePart({ ...fields({ trackingMode: "discrete" }), partId });
    expect(expectRefusal(result)).toBe("tracking_mode_immutable_with_history");
  });

  it("still allows the other fields to be edited on a part with history", async () => {
    const partId = seedPart(world, { trackingMode: "measured", unit: "l" });
    unwrap(await addPurchase({ partId, qtyMilli: 750 }));
    unwrap(await updatePart({ ...fields({ name: "HEPA filter F7, 46 mm" }), partId }));
    expect(world.handle.db.select().from(part).where(eq(part.id, partId)).get()?.name).toBe(
      "HEPA filter F7, 46 mm",
    );
  });
});

describe("addPurchase", () => {
  it("appends to the ledger and moves the balance", async () => {
    const partId = seedPart(world);
    const { transactionId } = unwrap(
      await addPurchase({ partId, qtyMilli: 2000, storagePlaceId: world.storagePlaceId }),
    );
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(2000);
    const row = world.handle.db
      .select()
      .from(stockTransaction)
      .where(eq(stockTransaction.id, transactionId))
      .get();
    expect(row?.kind).toBe("purchase");
    expect(row?.createdBy).toBe(world.user.id);
  });

  it("refuses a fractional amount for an item counted in whole units", async () => {
    const partId = seedPart(world, { trackingMode: "discrete" });
    expect(expectRefusal(await addPurchase({ partId, qtyMilli: 1500 }))).toBe(
      "qty_not_whole_unit",
    );
  });

  it("accepts a fractional amount for a measured item", async () => {
    const partId = seedPart(world, { trackingMode: "measured", unit: "l" });
    unwrap(await addPurchase({ partId, qtyMilli: 750 }));
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(750);
  });

  it("records a backdated arrival on the day it happened", async () => {
    const partId = seedPart(world);
    const { transactionId } = unwrap(
      await addPurchase({ partId, qtyMilli: 1000, occurredOn: "2026-03-03" }),
    );
    const row = world.handle.db
      .select()
      .from(stockTransaction)
      .where(eq(stockTransaction.id, transactionId))
      .get();
    expect(row?.occurredLocalDate).toBe("2026-03-03");
  });

  it("refuses an unknown part with the domain's own code", async () => {
    expect(expectRefusal(await addPurchase({ partId: "nope", qtyMilli: 1000 }))).toBe("not_found");
  });
});

describe("stockTake", () => {
  it("writes the difference, not the count", async () => {
    const partId = seedPart(world);
    unwrap(await addPurchase({ partId, qtyMilli: 5000 }));

    const result = unwrap(await stockTake({ partId, countedMilli: 3000 }));
    expect(result.matched).toBe(false);
    expect(result.deltaMilli).toBe(-2000);
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(3000);

    const rows = world.handle.db
      .select()
      .from(stockTransaction)
      .where(eq(stockTransaction.partId, partId))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.reason === "stock_take")).toBe(true);
  });

  it("writes nothing when the shelf matches, and says so", async () => {
    const partId = seedPart(world);
    unwrap(await addPurchase({ partId, qtyMilli: 2000 }));
    const result = unwrap(await stockTake({ partId, countedMilli: 2000 }));
    expect(result.matched).toBe(true);
    expect(result.transactionId).toBeNull();
    expect(
      world.handle.db.select().from(stockTransaction).where(eq(stockTransaction.partId, partId)).all(),
    ).toHaveLength(1);
  });

  it("can record a negative balance honestly", async () => {
    const partId = seedPart(world);
    unwrap(await addPurchase({ partId, qtyMilli: 1000 }));
    unwrap(await stockTake({ partId, countedMilli: 0, notes: "the shelf is empty" }));
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(0);
  });
});

describe("explodeKit and undoExplode", () => {
  it("moves the stock from the kit to its contents, and nothing is counted twice", async () => {
    const filterId = seedPart(world, { name: "Filter" });
    const kitId = seedPart(world, { name: "Filter kit", isKit: true });
    seedKitComponent(world, kitId, filterId, 2000);
    unwrap(await addPurchase({ partId: kitId, qtyMilli: 1000 }));

    const { groupId, componentPartIds } = unwrap(await explodeKit({ kitPartId: kitId, count: 1 }));
    expect(componentPartIds).toEqual([filterId]);
    expect(getStock(world.handle.db, kitId).onHandMilli).toBe(0);
    expect(getStock(world.handle.db, filterId).onHandMilli).toBe(2000);

    unwrap(await undoExplode({ kitPartId: kitId, groupId }));
    expect(getStock(world.handle.db, kitId).onHandMilli).toBe(1000);
    expect(getStock(world.handle.db, filterId).onHandMilli).toBe(0);
  });

  it("refuses to undo the same opening twice", async () => {
    const filterId = seedPart(world, { name: "Filter" });
    const kitId = seedPart(world, { name: "Filter kit", isKit: true });
    seedKitComponent(world, kitId, filterId, 1000);
    unwrap(await addPurchase({ partId: kitId, qtyMilli: 2000 }));
    const { groupId } = unwrap(await explodeKit({ kitPartId: kitId, count: 1 }));
    unwrap(await undoExplode({ kitPartId: kitId, groupId }));
    expect(expectRefusal(await undoExplode({ kitPartId: kitId, groupId }))).toBe(
      "already_reversed",
    );
  });

  it("refuses to open something that is not a kit", async () => {
    const partId = seedPart(world);
    expect(expectRefusal(await explodeKit({ kitPartId: partId, count: 1 }))).toBe("not_a_kit");
  });

  it("refuses to open a kit with no contents listed", async () => {
    const kitId = seedPart(world, { isKit: true });
    expect(expectRefusal(await explodeKit({ kitPartId: kitId, count: 1 }))).toBe("kit_empty");
  });
});

describe("correctTransaction", () => {
  it("appends a mirror row and leaves the original in place", async () => {
    const partId = seedPart(world);
    const { transactionId } = unwrap(await addPurchase({ partId, qtyMilli: 3000 }));

    const correction = unwrap(
      await correctTransaction({
        partId,
        transactionId,
        reason: "manual_correction",
        notes: "wrong item — it was the bathroom filter",
      }),
    );
    expect(correction.qtyMilli).toBe(-3000);
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(0);

    const rows = world.handle.db
      .select()
      .from(stockTransaction)
      .where(eq(stockTransaction.partId, partId))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === transactionId)?.qtyMilli).toBe(3000);
  });

  it("refuses a second correction of the same row", async () => {
    const partId = seedPart(world);
    const { transactionId } = unwrap(await addPurchase({ partId, qtyMilli: 1000 }));
    unwrap(
      await correctTransaction({
        partId,
        transactionId,
        reason: "manual_correction",
        notes: "first",
      }),
    );
    expect(
      expectRefusal(
        await correctTransaction({
          partId,
          transactionId,
          reason: "manual_correction",
          notes: "second",
        }),
      ),
    ).toBe("already_reversed");
  });

  it("insists on a reason", async () => {
    const partId = seedPart(world);
    const { transactionId } = unwrap(await addPurchase({ partId, qtyMilli: 1000 }));
    expect(
      expectRefusal(
        await correctTransaction({
          partId,
          transactionId,
          reason: "manual_correction",
          notes: "   ",
        }),
      ),
    ).toBe("invalid_request");
  });
});

describe("setEstimate", () => {
  it("writes the implied delta so the ledger and the percentage agree", async () => {
    const partId = seedPart(world, {
      trackingMode: "estimated",
      unit: "l",
      tracksLots: true,
    });
    const { lotId } = unwrap(
      await upsertLot({
        partId,
        label: "5 l can",
        initialQtyMilli: 5000,
        isOpen: true,
      }),
    );

    const result = unwrap(await setEstimate({ partId, lotId, estimatePct: 40 }));
    expect(result.estimatePct).toBe(40);
    expect(result.remainingMilli).toBe(2000);
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(2000);

    // Setting the same percentage again writes no row: there is no change to record.
    const again = unwrap(await setEstimate({ partId, lotId, estimatePct: 40 }));
    expect(again.transactionId).toBeNull();
  });

  it("refuses a percentage on an item that is not tracked as an estimate", async () => {
    const partId = seedPart(world, { tracksLots: true });
    const { lotId } = unwrap(await upsertLot({ partId, label: "box", isOpen: true }));
    expect(expectRefusal(await setEstimate({ partId, lotId, estimatePct: 50 }))).toBe(
      "part_not_estimated",
    );
  });

  it("refuses a lot with no full size, because a percentage of nothing means nothing", async () => {
    const partId = seedPart(world, {
      trackingMode: "estimated",
      unit: "l",
      tracksLots: true,
    });
    expect(
      expectRefusal(await upsertLot({ partId, label: "unknown can", isOpen: true })),
    ).toBe("lot_initial_qty_missing");
  });
});

describe("part definition edits", () => {
  it("refuses a lot on an item that does not track lots", async () => {
    const partId = seedPart(world, { tracksLots: false });
    expect(expectRefusal(await upsertLot({ partId, label: "box" }))).toBe(
      "part_does_not_track_lots",
    );
  });

  it("keeps exactly one preferred supplier per item", async () => {
    const partId = seedPart(world);
    unwrap(await upsertSupplier({ partId, supplierName: "Motonet", isPreferred: true }));
    unwrap(await upsertSupplier({ partId, supplierName: "Bauhaus", isPreferred: true }));
    const preferred = world.handle.db
      .select()
      .from(partSupplier)
      .where(eq(partSupplier.partId, partId))
      .all()
      .filter((row) => row.isPreferred);
    expect(preferred).toHaveLength(1);
    expect(preferred[0]?.supplierName).toBe("Bauhaus");
  });

  it("refuses a kit inside a kit", async () => {
    const innerKitId = seedPart(world, { name: "Inner kit", isKit: true });
    const outerKitId = seedPart(world, { name: "Outer kit", isKit: true });
    expect(
      expectRefusal(
        await setKitComponents({
          partId: outerKitId,
          components: [{ componentPartId: innerKitId, qtyMilli: 1000 }],
        }),
      ),
    ).toBe("nested_kit");
  });

  it("refuses a kit that contains itself", async () => {
    const kitId = seedPart(world, { isKit: true });
    expect(
      expectRefusal(
        await setKitComponents({
          partId: kitId,
          components: [{ componentPartId: kitId, qtyMilli: 1000 }],
        }),
      ),
    ).toBe("kit_self_component");
  });

  it("archives without touching the ledger, and restores", async () => {
    const partId = seedPart(world);
    unwrap(await addPurchase({ partId, qtyMilli: 1000 }));
    unwrap(await setPartArchived({ partId, archived: true }));
    expect(
      world.handle.db.select().from(part).where(eq(part.id, partId)).get()?.archivedAtMs,
    ).not.toBeNull();
    expect(getStock(world.handle.db, partId).onHandMilli).toBe(1000);

    unwrap(await setPartArchived({ partId, archived: false }));
    expect(
      world.handle.db.select().from(part).where(eq(part.id, partId)).get()?.archivedAtMs,
    ).toBeNull();
  });

  it("stores the lot dates it was given", async () => {
    const partId = seedPart(world, { tracksLots: true });
    const { lotId } = unwrap(
      await upsertLot({
        partId,
        label: "2028 box",
        expiresOn: "2028-01-31",
        purchasedOn: "2026-01-02",
        isOpen: false,
      }),
    );
    const row = world.handle.db.select().from(partLot).where(eq(partLot.id, lotId)).get();
    expect(row?.expiresOn).toBe("2028-01-31");
    expect(row?.purchasedOn).toBe("2026-01-02");
  });
});
