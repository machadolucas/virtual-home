/**
 * Reorder suggestions — §1.8 (thresholds, targets, lead times) and §1.5 (`asset_consumable`
 * feeding upcoming demand).
 *
 * The interesting property is the horizon: demand comes from the open occurrences that actually
 * exist, never from a speculatively re-run recurrence rule, so every assertion here is about which
 * tasks a date range does and does not sweep in.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { maintenanceOccurrence, part } from "@/db/schema";
import { ValidationError } from "@/domain/errors";
import { purchase } from "@/domain/inventory";
import { partsToReorder, reorderSuggestions } from "@/domain/reorder";
import { makeFixture, START_DATE, type Fixture } from "./fixtures-inventory";

/** 30 days from the fixture date: 2026-06-10 → 2026-07-10 inclusive. */
const HORIZON = { horizonDays: 30, today: START_DATE };

describe("reorderSuggestions", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  const suggestions = (options = HORIZON) => f.tx((tx) => reorderSuggestions(tx, options));
  const row = (partId: string, options = HORIZON) => {
    const found = suggestions(options).find((line) => line.partId === partId);
    if (!found) throw new Error(`no suggestion row for ${partId}`);
    return found;
  };

  describe("inputs", () => {
    it("refuses a non-positive or fractional horizon", () => {
      for (const horizonDays of [0, -1, 1.5]) {
        expect(() => suggestions({ horizonDays, today: START_DATE })).toThrow(ValidationError);
      }
    });

    it("refuses a today that is not a local date", () => {
      expect(() => suggestions({ horizonDays: 30, today: "10.6.2026" })).toThrow(
        /YYYY-MM-DD/,
      );
    });
  });

  describe("the whole shelf, with the urgent rows marked", () => {
    it("lists every stocked part by name, suggesting nothing when there is no demand", () => {
      const zinc = f.addPart({ name: "Zinc washer" });
      const aaa = f.addPart({ name: "AAA alkaline" });
      f.tx((tx) => purchase(tx, f.ctx, { partId: aaa, qtyMilli: 4_000 }));

      const all = suggestions();
      expect(all.map((line) => line.partId)).toEqual([aaa, zinc]);
      expect(all.map((line) => line.suggest)).toEqual([false, false]);
      expect(all[0]?.onHandMilli).toBe(4_000);
      expect(all[0]?.expectedDemandMilli).toBe(0);
      expect(all[0]?.projectedBalanceMilli).toBe(4_000);
      expect(all[0]?.suggestedOrderMilli).toBe(0);
      expect(all[0]?.reason).toBe("4 pcs left");
      // A part nobody has ever bought is still listed — at zero, which is the point.
      expect(all[1]?.onHandMilli).toBe(0);
    });

    it("skips a not_stocked kit (a pure bill of materials) and an archived part", () => {
      const bom = f.addPart({ name: "Service kit (BOM only)", isKit: true, stockMode: "not_stocked" });
      const gone = f.addPart({ name: "Discontinued filter" });
      const live = f.addPart({ name: "Live filter" });
      f.tx((tx) =>
        tx.update(part).set({ archivedAtMs: f.clock.now() }).where(eq(part.id, gone)).run(),
      );

      expect(suggestions().map((line) => line.partId)).toEqual([live]);
      expect(suggestions().some((line) => line.partId === bom)).toBe(false);
    });

    it("without a threshold, only a projected shortfall is worth acting on", () => {
      const partId = f.addPart({ name: "Filter" });
      f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 1_000 }));
      const planId = f.addPlan({ title: "Change the filter" });
      f.addPlanMaterial(planId, partId, 2_000);
      f.addOccurrence({ planId, title: "Change the filter", dueDate: "2026-06-20" });

      const line = row(partId);
      expect(line.expectedDemandMilli).toBe(2_000);
      expect(line.projectedBalanceMilli).toBe(-1_000);
      expect(line.suggest).toBe(true);
      // No target and no threshold: buy enough to serve the horizon.
      expect(line.suggestedOrderMilli).toBe(3_000);
      expect(line.reason).toContain("1 pcs left");
      expect(line.reason).toContain("1 task in 30 days need 2 pcs");
      expect(line.reason).toContain("short by 1 pcs");
    });

    it("with a threshold, buys back up to the target and names the lead time", () => {
      const partId = f.addPart({
        name: "HEPA filter F7",
        reorderThresholdMilli: 2_000,
        reorderTargetMilli: 6_000,
        leadTimeDays: 14,
      });
      f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 1_000 }));

      const line = row(partId);
      expect(line.projectedBalanceMilli).toBe(1_000);
      expect(line.suggest).toBe(true);
      expect(line.suggestedOrderMilli).toBe(5_000);
      expect(line.reorderThresholdMilli).toBe(2_000);
      expect(line.reorderTargetMilli).toBe(6_000);
      expect(line.leadTimeDays).toBe(14);
      expect(line.reason).toContain("below the reorder threshold of 2 pcs");
      expect(line.reason).toContain("lead time 14 days");
    });

    it("counts demand from two plans and orders back to the target", () => {
      const partId = f.addPart({
        name: "Filter",
        reorderThresholdMilli: 1_000,
        reorderTargetMilli: 4_000,
      });
      f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 2_000 }));
      for (const title of ["Supply filter", "Extract filter"]) {
        const planId = f.addPlan({ title });
        f.addPlanMaterial(planId, partId, 1_000);
        f.addOccurrence({ planId, title, dueDate: "2026-06-25" });
      }

      const line = row(partId);
      expect(line.demandSources).toHaveLength(2);
      expect(line.expectedDemandMilli).toBe(2_000);
      expect(line.projectedBalanceMilli).toBe(0);
      expect(line.suggest).toBe(true);
      expect(line.suggestedOrderMilli).toBe(4_000);
      expect(line.reason).toContain("2 tasks in 30 days need 2 pcs");
    });
  });

  describe("which tasks the horizon sweeps in", () => {
    /** One plan needing `qtyMilli` of `partId`, with one open occurrence on `dueDate`. */
    function taskDue(partId: string, dueDate: string, qtyMilli = 1_000): string {
      const planId = f.addPlan({ title: `Task ${dueDate}` });
      f.addPlanMaterial(planId, partId, qtyMilli);
      return f.addOccurrence({ planId, title: `Task ${dueDate}`, dueDate, status: "pending" });
    }

    it("includes the last day of the horizon and excludes the day after", () => {
      const partId = f.addPart({ name: "Filter" });
      const inside = taskDue(partId, "2026-07-10");
      taskDue(partId, "2026-07-11");

      const line = row(partId);
      expect(line.demandSources.map((source) => source.occurrenceId)).toEqual([inside]);
      expect(line.expectedDemandMilli).toBe(1_000);
    });

    it("includes an overdue task: a due date in the past is still inside the horizon", () => {
      const partId = f.addPart({ name: "Filter" });
      const overdue = taskDue(partId, "2026-05-01");

      const line = row(partId);
      expect(line.demandSources.map((source) => source.occurrenceId)).toEqual([overdue]);
    });

    it("ignores a task that is already closed", () => {
      const partId = f.addPart({ name: "Filter" });
      const occurrenceId = taskDue(partId, "2026-06-20");
      f.tx((tx) =>
        tx
          .update(maintenanceOccurrence)
          .set({ status: "cancelled", closedAtMs: f.clock.now(), closeReason: "plan_cancelled" })
          .where(eq(maintenanceOccurrence.id, occurrenceId))
          .run(),
      );

      expect(row(partId).demandSources).toEqual([]);
      expect(row(partId).expectedDemandMilli).toBe(0);
    });

    it("reports each demand source with the task that needs it", () => {
      const partId = f.addPart({ name: "Filter" });
      const occurrenceId = taskDue(partId, "2026-06-20", 2_000);

      expect(row(partId).demandSources).toEqual([
        {
          kind: "plan",
          occurrenceId,
          title: "Task 2026-06-20",
          dueDate: "2026-06-20",
          qtyMilli: 2_000,
          isRequired: true,
        },
      ]);
    });

    it("counts a battery task's demand from asset_consumable", () => {
      const partId = f.addPart({ name: "AAA alkaline" });
      f.tx((tx) => purchase(tx, f.ctx, { partId, qtyMilli: 1_000 }));
      const assetId = f.addAsset({ name: "Master bedroom smoke alarm" });
      f.addConsumable(assetId, partId, "battery", 2_000);
      const ruleId = f.addConditionRule({ scope: "asset", assetId });
      const occurrenceId = f.addOccurrence({
        assetId,
        source: "condition",
        conditionRuleId: ruleId,
        title: "Replace battery: Master bedroom smoke alarm",
        dueDate: START_DATE,
      });

      const line = row(partId);
      expect(line.expectedDemandMilli).toBe(2_000);
      expect(line.demandSources).toHaveLength(1);
      expect(line.demandSources[0]?.kind).toBe("condition");
      expect(line.demandSources[0]?.occurrenceId).toBe(occurrenceId);
      expect(line.projectedBalanceMilli).toBe(-1_000);
      expect(line.suggest).toBe(true);
    });

    it("a longer horizon sees a task a shorter one does not", () => {
      const partId = f.addPart({ name: "Filter" });
      taskDue(partId, "2026-08-01");

      expect(row(partId, { horizonDays: 30, today: START_DATE }).expectedDemandMilli).toBe(0);
      expect(row(partId, { horizonDays: 90, today: START_DATE }).expectedDemandMilli).toBe(1_000);
    });
  });

  describe("kits count in kits", () => {
    it("labels a stocked kit in kits, not pieces", () => {
      const kitId = f.addPart({ name: "Service kit", isKit: true });
      const componentId = f.addPart({ name: "Filter" });
      f.addKit(kitId, componentId, 2_000);
      f.tx((tx) => purchase(tx, f.ctx, { partId: kitId, qtyMilli: 1_000 }));
      const planId = f.addPlan({ title: "Annual service" });
      f.addPlanMaterial(planId, kitId, 2_000);
      f.addOccurrence({ planId, title: "Annual service", dueDate: "2026-06-20" });

      const line = row(kitId);
      expect(line.isKit).toBe(true);
      expect(line.reason).toContain("1 kit left");
      expect(line.reason).toContain("need 2 kits");
      expect(line.reason).toContain("short by 1 kit");
    });
  });

  describe("partsToReorder", () => {
    it("returns only the rows worth acting on", () => {
      const short = f.addPart({ name: "Short filter", reorderThresholdMilli: 2_000 });
      const fine = f.addPart({ name: "Well stocked filter", reorderThresholdMilli: 1_000 });
      f.tx((tx) => {
        purchase(tx, f.ctx, { partId: short, qtyMilli: 1_000 });
        purchase(tx, f.ctx, { partId: fine, qtyMilli: 9_000 });
      });

      expect(suggestions()).toHaveLength(2);
      const acting = f.tx((tx) => partsToReorder(tx, HORIZON));
      expect(acting.map((line) => line.partId)).toEqual([short]);
    });
  });
});
