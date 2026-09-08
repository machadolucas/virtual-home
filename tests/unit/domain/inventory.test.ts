/**
 * The stock ledger: signs, kits, lots, estimates and expected materials.
 *
 * Covers §9 items 48 (kit explode / undo, and the no-double-counting assertion), 49 (estimated
 * lots) and 103's spirit (the view agrees with a naive reduction), plus the validation rules that
 * keep the ledger honest.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { stockTransaction } from "@/db/schema";
import { ValidationError, ConflictError, NotFoundError } from "@/domain/errors";
import {
  adjustStockTake,
  availableMilli,
  explodeKit,
  expectedMaterialsFor,
  getStock,
  loadOccurrenceLike,
  pickLot,
  purchase,
  raiseAlert,
  recordTransaction,
  reverseTransaction,
  setEstimate,
  stockHistory,
  undoExplode,
} from "@/domain/inventory";
import { makeFixture, type Fixture } from "./fixtures-inventory";

describe("inventory ledger", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  describe("getStock and availableMilli", () => {
    it("reports zero for a part with no movements", () => {
      const partId = f.addPart({ name: "AAA alkaline" });
      const level = f.tx((tx) => getStock(tx, partId));
      expect(level).toEqual({
        partId,
        onHandMilli: 0,
        effectiveMilli: 0,
        lastMovementMs: null,
      });
    });

    it("sums the ledger, and the view agrees with a naive reduction", () => {
      const partId = f.addPart({ name: "AAA alkaline" });
      f.tx((tx) => {
        purchase(tx, f.ctx, { partId, qtyMilli: 10_000 });
        purchase(tx, f.ctx, { partId, qtyMilli: 4_000 });
        recordTransaction(tx, f.ctx, {
          partId,
          qtyMilli: -2_000,
          kind: "consumption",
          reason: "maintenance_consumption",
        });
      });

      const naive = f
        .tx((tx) => tx.select().from(stockTransaction).where(eq(stockTransaction.partId, partId)).all())
        .reduce((sum, row) => sum + row.qtyMilli, 0);

      const level = f.tx((tx) => getStock(tx, partId));
      expect(naive).toBe(12_000);
      expect(level.onHandMilli).toBe(12_000);
      // The fixture clock is in the past, so nothing is future-dated.
      expect(level.effectiveMilli).toBe(12_000);
      expect(level.lastMovementMs).toBe(f.clock.now());
    });

    it("throws NotFoundError for an unknown part", () => {
      expect(() => f.tx((tx) => getStock(tx, "nope"))).toThrow(NotFoundError);
    });

    it("narrows to one lot when asked", () => {
      const partId = f.addPart({ name: "Silicone", trackingMode: "measured", unit: "ml", tracksLots: true });
      const lotA = f.addLot(partId, { label: "A" });
      const lotB = f.addLot(partId, { label: "B" });
      f.tx((tx) => {
        purchase(tx, f.ctx, { partId, qtyMilli: 300_000, lotId: lotA });
        purchase(tx, f.ctx, { partId, qtyMilli: 100_000, lotId: lotB });
      });
      expect(f.tx((tx) => availableMilli(tx, partId))).toBe(400_000);
      expect(f.tx((tx) => availableMilli(tx, partId, lotA))).toBe(300_000);
      expect(f.tx((tx) => availableMilli(tx, partId, lotB))).toBe(100_000);
    });
  });

  describe("recordTransaction validation", () => {
    it("refuses a zero quantity", () => {
      const partId = f.addPart({ name: "AAA" });
      expect(() =>
        f.tx((tx) =>
          recordTransaction(tx, f.ctx, { partId, qtyMilli: 0, kind: "purchase", reason: "purchase" }),
        ),
      ).toThrow(ValidationError);
    });

    it("refuses a positive consumption and a negative purchase", () => {
      const partId = f.addPart({ name: "AAA" });
      expect(() =>
        f.tx((tx) =>
          recordTransaction(tx, f.ctx, {
            partId,
            qtyMilli: 1_000,
            kind: "consumption",
            reason: "maintenance_consumption",
          }),
        ),
      ).toThrow(/consumption requires a negative/);
      expect(() =>
        f.tx((tx) =>
          recordTransaction(tx, f.ctx, {
            partId,
            qtyMilli: -1_000,
            kind: "purchase",
            reason: "purchase",
          }),
        ),
      ).toThrow(/purchase requires a positive/);
    });

    it("refuses a part quantity of a discrete part", () => {
      const partId = f.addPart({ name: "AAA", trackingMode: "discrete" });
      expect(() => f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 1_500 }))).toThrow(
        /whole units/,
      );
    });

    it("allows a fractional quantity of a measured part", () => {
      const partId = f.addPart({ name: "Oil", trackingMode: "measured", unit: "l" });
      const row = f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 1_500 }));
      expect(row.qtyMilli).toBe(1_500);
    });

    it("refuses a lot belonging to another part", () => {
      const a = f.addPart({ name: "A", tracksLots: true });
      const b = f.addPart({ name: "B", tracksLots: true });
      const lotOfB = f.addLot(b);
      expect(() => f.tx((tx) => purchase(tx, f.ctx, { partId: a, qtyMilli: 1_000, lotId: lotOfB }))).toThrow(
        /different part/,
      );
    });

    it("stamps the occurred local date in the household time zone", () => {
      const partId = f.addPart({ name: "AAA" });
      const row = f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 1_000 }));
      expect(row.occurredLocalDate).toBe("2026-06-10");
      expect(row.createdBy).toBe(f.lucas.id);
    });

    it("records the storage place it was given", () => {
      const partId = f.addPart({ name: "AAA" });
      const row = f.tx((tx) =>
        purchase(tx, f.ctx, { partId, qtyMilli: 1_000, storagePlaceId: f.storagePlaceId }),
      );
      expect(row.storagePlaceId).toBe(f.storagePlaceId);
    });
  });

  describe("adjustStockTake", () => {
    it("writes the delta, never an update", () => {
      const partId = f.addPart({ name: "AAA" });
      f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 10_000 }));

      const row = f.tx((tx) => adjustStockTake(tx, f.ctx, { partId, countedMilli: 7_000, notes: "counted the bin" }));
      expect(row).not.toBeNull();
      expect(row?.qtyMilli).toBe(-3_000);
      expect(row?.kind).toBe("adjustment");
      expect(row?.reason).toBe("stock_take");
      expect(row?.notes).toContain("counted 7000 milli (recorded 10000 milli)");
      expect(f.tx((tx) => availableMilli(tx, partId))).toBe(7_000);
      // Two rows: the purchase and the delta. The purchase is untouched.
      expect(f.tx((tx) => stockHistory(tx, partId, 10))).toHaveLength(2);
    });

    it("writes nothing when the count already matches", () => {
      const partId = f.addPart({ name: "AAA" });
      f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 4_000 }));
      expect(f.tx((tx) => adjustStockTake(tx, f.ctx, { partId, countedMilli: 4_000 }))).toBeNull();
      expect(f.tx((tx) => stockHistory(tx, partId, 10))).toHaveLength(1);
    });
  });

  // §9 item 48.
  describe("kit explode", () => {
    function kitFixture() {
      const kitId = f.addPart({ name: "Filter kit F7 (2 pcs)", isKit: true });
      const filterId = f.addPart({ name: "HEPA filter F7 200×200" });
      f.addKit(kitId, filterId, 2_000);
      f.tx((tx) => purchase(tx, f.ctx, { partId: kitId, qtyMilli: 1_000 }));
      return { kitId, filterId };
    }

    it("moves stock from the kit to the components under one transaction group", () => {
      const { kitId } = kitFixture();

      const result = f.tx((tx) => explodeKit(tx, f.ctx, { kitPartId: kitId, count: 1 }));

      expect(result.kitRow.qtyMilli).toBe(-1_000);
      expect(result.kitRow.kind).toBe("kit_explode_out");
      expect(result.componentRows).toHaveLength(1);
      expect(result.componentRows[0]?.qtyMilli).toBe(2_000);
      expect(result.componentRows[0]?.kind).toBe("kit_explode_in");
      // One group ties the atomic operation together.
      expect(new Set([result.kitRow, ...result.componentRows].map((r) => r.transactionGroupId))).toEqual(
        new Set([result.groupId]),
      );
    });

    it("does not double count: the kit has none left, the components have two", () => {
      const { kitId, filterId } = kitFixture();
      f.tx((tx) => explodeKit(tx, f.ctx, { kitPartId: kitId, count: 1 }));

      const kit = f.tx((tx) => availableMilli(tx, kitId));
      const filter = f.tx((tx) => availableMilli(tx, filterId));

      expect(kit).toBe(0);
      expect(filter).toBe(2_000);
      // The point of the whole design: availability is one SUM per part, with no cross term. Before
      // the explode the household had 1 kit and 0 filters; after it, 0 kits and 2 filters — never
      // "1 kit AND 2 filters".
      expect(kit + filter).toBe(2_000);
    });

    it("undo-explode restores both balances and cannot be applied twice", () => {
      const { kitId, filterId } = kitFixture();
      const { groupId } = f.tx((tx) => explodeKit(tx, f.ctx, { kitPartId: kitId, count: 1 }));

      const undone = f.tx((tx) => undoExplode(tx, f.ctx, groupId));
      expect(undone.rows).toHaveLength(2);
      expect(f.tx((tx) => availableMilli(tx, kitId))).toBe(1_000);
      expect(f.tx((tx) => availableMilli(tx, filterId))).toBe(0);
      for (const row of undone.rows) {
        expect(row.reason).toBe("kit_explode_undo");
        expect(row.reversesTransactionId).not.toBeNull();
      }

      // UNIQUE(reverses_transaction_id) makes the second undo impossible.
      expect(() => f.tx((tx) => undoExplode(tx, f.ctx, groupId))).toThrow(ConflictError);
    });

    it("refuses to explode a non-kit or an empty kit", () => {
      const plain = f.addPart({ name: "AAA" });
      expect(() => f.tx((tx) => explodeKit(tx, f.ctx, { kitPartId: plain, count: 1 }))).toThrow(
        /not a kit/,
      );
      const emptyKit = f.addPart({ name: "Empty kit", isKit: true, stockMode: "not_stocked" });
      expect(() => f.tx((tx) => explodeKit(tx, f.ctx, { kitPartId: emptyKit, count: 1 }))).toThrow(
        /no kit_component/,
      );
    });

    it("refuses a non-positive count", () => {
      const { kitId } = kitFixture();
      expect(() => f.tx((tx) => explodeKit(tx, f.ctx, { kitPartId: kitId, count: 0 }))).toThrow(
        ValidationError,
      );
    });
  });

  // §9 item 49.
  describe("estimated tracking", () => {
    it("setting an open lot to 40 % writes the implied delta and the ledger equals the display", () => {
      const partId = f.addPart({ name: "Sealant", trackingMode: "estimated", unit: "ml", tracksLots: true });
      const lotId = f.addLot(partId, { label: "tube 1", initialQtyMilli: 300_000, isOpen: true });
      f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 300_000, lotId }));

      const result = f.tx((tx) => setEstimate(tx, f.ctx, { lotId, estimatePct: 40 }));

      expect(result.remainingMilli).toBe(120_000);
      expect(result.transaction?.kind).toBe("estimate_update");
      expect(result.transaction?.reason).toBe("estimate_update");
      // 120 000 − 300 000
      expect(result.transaction?.qtyMilli).toBe(-180_000);
      expect(result.lot.estimatePct).toBe(40);
      // The ledger *is* the number the UI shows.
      expect(f.tx((tx) => availableMilli(tx, partId, lotId))).toBe(result.remainingMilli);
    });

    it("writes nothing when the percentage already matches the ledger", () => {
      const partId = f.addPart({ name: "Sealant", trackingMode: "estimated", unit: "ml", tracksLots: true });
      const lotId = f.addLot(partId, { initialQtyMilli: 100_000 });
      f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 50_000, lotId }));
      const result = f.tx((tx) => setEstimate(tx, f.ctx, { lotId, estimatePct: 50 }));
      expect(result.transaction).toBeNull();
      expect(result.lot.estimatePct).toBe(50);
    });

    it("refuses a percentage on a discrete part and an out-of-range value", () => {
      const discrete = f.addPart({ name: "AAA", tracksLots: true });
      const discreteLot = f.addLot(discrete, { initialQtyMilli: 4_000 });
      expect(() => f.tx((tx) => setEstimate(tx, f.ctx, { lotId: discreteLot, estimatePct: 50 }))).toThrow(
        /only an estimated part/,
      );

      const estimated = f.addPart({ name: "Oil", trackingMode: "estimated", unit: "l", tracksLots: true });
      const lot = f.addLot(estimated, { initialQtyMilli: 5_000 });
      expect(() => f.tx((tx) => setEstimate(tx, f.ctx, { lotId: lot, estimatePct: 101 }))).toThrow(
        ValidationError,
      );
    });

    it("refuses a percentage on a lot with no initial quantity", () => {
      const partId = f.addPart({ name: "Oil", trackingMode: "estimated", unit: "l", tracksLots: true });
      const lotId = f.addLot(partId, { initialQtyMilli: undefined });
      expect(() => f.tx((tx) => setEstimate(tx, f.ctx, { lotId, estimatePct: 50 }))).toThrow(
        /initial quantity/,
      );
    });
  });

  describe("reverseTransaction", () => {
    it("mirrors the row once and only once", () => {
      const partId = f.addPart({ name: "AAA" });
      const original = f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 4_000 }));

      const mirror = f.tx((tx) => reverseTransaction(tx, f.ctx, original.id, "manual_correction"));
      expect(mirror.qtyMilli).toBe(-4_000);
      expect(mirror.kind).toBe("correction");
      expect(mirror.reversesTransactionId).toBe(original.id);
      expect(f.tx((tx) => availableMilli(tx, partId))).toBe(0);

      expect(() => f.tx((tx) => reverseTransaction(tx, f.ctx, original.id))).toThrow(ConflictError);
      // The original is untouched.
      const reread = f.tx((tx) =>
        tx.select().from(stockTransaction).where(eq(stockTransaction.id, original.id)).get(),
      );
      expect(reread?.qtyMilli).toBe(4_000);
    });
  });

  describe("pickLot (FEFO)", () => {
    it("prefers the open lot expiring soonest", () => {
      const partId = f.addPart({ name: "Sealant", trackingMode: "measured", unit: "ml", tracksLots: true });
      f.addLot(partId, { label: "late", expiresOn: "2027-01-01", isOpen: true });
      const soon = f.addLot(partId, { label: "soon", expiresOn: "2026-08-01", isOpen: true });
      f.addLot(partId, { label: "sealed", expiresOn: "2026-07-01", isOpen: false });

      expect(f.tx((tx) => pickLot(tx, partId))?.id).toBe(soon);
    });

    it("returns null when the part has no lots", () => {
      const partId = f.addPart({ name: "AAA" });
      expect(f.tx((tx) => pickLot(tx, partId))).toBeNull();
    });
  });

  describe("expectedMaterialsFor", () => {
    it("takes plan_material ∪ procedure_material, with the plan winning per part", () => {
      const filter = f.addPart({ name: "Filter" });
      const gasket = f.addPart({ name: "Gasket" });
      const { procedureId, versionId } = f.addProcedure({
        materials: [
          { partId: filter, qtyMilli: 1_000 },
          { partId: gasket, qtyMilli: 2_000 },
        ],
      });
      const assetId = f.addAsset({ name: "AHU", category: "hvac" });
      const planId = f.addPlan({ title: "Change the filter", assetId, procedureId });
      f.addPlanMaterial(planId, filter, 3_000);
      const occurrenceId = f.addOccurrence({
        planId,
        assetId,
        title: "Change the filter",
        procedureVersionId: versionId,
      });

      const lines = f.tx((tx) => expectedMaterialsFor(tx, loadOccurrenceLike(tx, occurrenceId)));

      expect(lines).toEqual([
        { partId: filter, qtyMilli: 3_000, isRequired: true, source: "plan" },
        { partId: gasket, qtyMilli: 2_000, isRequired: true, source: "procedure" },
      ]);
    });

    it("uses asset_consumable(role='battery') for a condition occurrence", () => {
      const aaa = f.addPart({ name: "AAA alkaline" });
      const assetId = f.addAsset({ name: "Master bedroom smoke alarm" });
      f.addConsumable(assetId, aaa, "battery", 2_000);
      const ruleId = f.addConditionRule({ scope: "asset", assetId });
      const occurrenceId = f.addOccurrence({
        assetId,
        source: "condition",
        conditionRuleId: ruleId,
        title: "Replace battery",
      });

      const lines = f.tx((tx) => expectedMaterialsFor(tx, loadOccurrenceLike(tx, occurrenceId)));
      expect(lines).toEqual([
        { partId: aaa, qtyMilli: 2_000, isRequired: true, source: "asset_consumable", role: "battery" },
      ]);
    });

    it("falls back to the rule's default part when the asset declares no battery", () => {
      const cr2032 = f.addPart({ name: "CR2032" });
      const assetId = f.addAsset({ name: "Door sensor" });
      const ruleId = f.addConditionRule({ scope: "asset", assetId, defaultPartId: cr2032 });
      const occurrenceId = f.addOccurrence({
        assetId,
        source: "condition",
        conditionRuleId: ruleId,
        title: "Replace battery",
      });

      const lines = f.tx((tx) => expectedMaterialsFor(tx, loadOccurrenceLike(tx, occurrenceId)));
      expect(lines).toEqual([
        { partId: cr2032, qtyMilli: 1_000, isRequired: true, source: "condition_rule" },
      ]);
    });

    it("pulls no asset_consumable rows into plan work unless the caller declares the role", () => {
      const oil = f.addPart({ name: "Oil", trackingMode: "measured", unit: "l" });
      const assetId = f.addAsset({ name: "Mower", category: "outdoor" });
      f.addConsumable(assetId, oil, "fluid", 600);
      const planId = f.addPlan({ title: "Service the mower", assetId });
      const occurrenceId = f.addOccurrence({ planId, assetId, title: "Service the mower" });

      expect(f.tx((tx) => expectedMaterialsFor(tx, loadOccurrenceLike(tx, occurrenceId)))).toEqual([]);
      expect(
        f.tx((tx) =>
          expectedMaterialsFor(tx, loadOccurrenceLike(tx, occurrenceId), {
            consumableRoles: ["fluid"],
          }),
        ),
      ).toEqual([
        { partId: oil, qtyMilli: 600, isRequired: true, source: "asset_consumable", role: "fluid" },
      ]);
    });
  });

  describe("raiseAlert", () => {
    it("dedupes an unresolved alert by key instead of adding noise", () => {
      const first = f.tx((tx) =>
        raiseAlert(tx, f.ctx, {
          kind: "low_stock",
          severity: "info",
          title: "Filters are low",
          dedupeKey: "low_stock:part:x",
        }),
      );
      f.clock.advance(60_000);
      const second = f.tx((tx) =>
        raiseAlert(tx, f.ctx, {
          kind: "low_stock",
          severity: "info",
          title: "Filters are low",
          dedupeKey: "low_stock:part:x",
        }),
      );
      expect(second.id).toBe(first.id);
      expect(second.seenCount).toBe(2);
      expect(second.lastSeenAtMs).toBe(first.firstSeenAtMs + 60_000);
    });
  });
});
