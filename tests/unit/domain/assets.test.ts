/**
 * Equipment replacement and the history reads built on it — §1.5 and §5.5.
 *
 * `completion.test.ts` covers a replacement recorded *inside* a completion; this file is about
 * `assets.ts`'s own contract: both sides of the swap written in one transaction, chains that stay
 * acyclic, forward-looking references moving while past completions never do, and the history read
 * that lets the UI show "the whole appliance" or "this unit only".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@/db/ids";
import {
  appAlert,
  asset,
  assetConsumable,
  assetHaLink,
  assetReplacement,
  auditLog,
  conditionEpisode,
  maintenancePlan,
} from "@/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { completeOccurrence } from "@/domain/completion";
import {
  activeHaLinks,
  assetHistory,
  assetsForEntity,
  replaceAsset,
  replacementChain,
} from "@/domain/assets";
import { makeFixture, START_DATE, TZ, type Fixture } from "./fixtures-inventory";

describe("replaceAsset", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  const swap = (oldAssetId: string, input: Partial<Parameters<typeof replaceAsset>[2]> = {}) =>
    f.tx((tx) =>
      replaceAsset(tx, f.ctx, {
        oldAssetId,
        newAsset: { name: "Unit 2026" },
        replacedOn: START_DATE,
        reason: "end_of_life",
        ...input,
      }),
    );

  const assetRow = (assetId: string) =>
    f.tx((tx) => tx.select().from(asset).where(eq(asset.id, assetId)).get());

  it("writes both sides of the swap, the replacement row and an audit entry", () => {
    const oldAssetId = f.addAsset({
      name: "Ventilation unit",
      category: "hvac",
      installedOn: "2018-04-01",
    });

    const result = swap(oldAssetId, { notes: "compressor seized" });

    const old = assetRow(oldAssetId);
    const created = assetRow(result.newAsset.id);
    expect(old?.status).toBe("removed");
    expect(old?.removedOn).toBe(START_DATE);
    expect(old?.replacedByAssetId).toBe(created?.id);
    expect(created?.status).toBe("installed");
    expect(created?.installedOn).toBe(START_DATE);
    expect(created?.installedOnPrecision).toBe("exact");
    expect(created?.replacesAssetId).toBe(oldAssetId);
    // Copied from the unit being replaced, not invented.
    expect(created?.category).toBe("hvac");
    expect(created?.locationId).toBe(f.locationId);
    // Not copied: this is a different physical unit.
    expect(created?.serialNumber).toBeNull();

    const replacements = f.tx((tx) => tx.select().from(assetReplacement).all());
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.oldAssetId).toBe(oldAssetId);
    expect(replacements[0]?.newAssetId).toBe(created?.id);
    expect(replacements[0]?.reason).toBe("end_of_life");
    expect(replacements[0]?.replacedOn).toBe(START_DATE);
    expect(replacements[0]?.notes).toBe("compressor seized");
    expect(replacements[0]?.occurrenceId).toBeNull();
    expect(replacements[0]?.completionId).toBeNull();

    const audits = f.tx((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityTable, "asset_replacement")).all(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityId).toBe(replacements[0]?.id);
    expect(audits[0]?.actorUserId).toBe(f.lucas.id);
  });

  it("clones what the unit eats and its Home Assistant links", () => {
    const oldAssetId = f.addAsset({ name: "Smoke alarm" });
    const partId = f.addPart({ name: "AAA alkaline" });
    f.addConsumable(oldAssetId, partId, "battery", 2_000);
    const deviceId = f.addDevice();
    const entityRegistryId = f.addEntity({ entityId: "sensor.alarm_battery", deviceId });
    const linkId = f.linkAsset(oldAssetId, { entityRegistryId, role: "battery_level" });

    const result = swap(oldAssetId, { cloneConsumables: true, cloneHaLinks: true });

    const consumables = f.tx((tx) =>
      tx.select().from(assetConsumable).where(eq(assetConsumable.assetId, result.newAsset.id)).all(),
    );
    expect(consumables).toHaveLength(1);
    expect(consumables[0]?.partId).toBe(partId);
    expect(consumables[0]?.role).toBe("battery");
    expect(consumables[0]?.qtyMilli).toBe(2_000);
    expect(result.consumableIds).toEqual([consumables[0]?.id]);

    // The old link is retired, the clone is live, and both point at the same registry entry.
    expect(result.retiredLinkIds).toEqual([linkId]);
    expect(result.clonedLinkIds).toHaveLength(1);
    const links = f.tx((tx) =>
      tx.select().from(assetHaLink).where(eq(assetHaLink.haEntityRegistryId, entityRegistryId)).all(),
    );
    expect(links).toHaveLength(2);
    expect(links.find((link) => link.id === linkId)?.linkState).toBe("replaced");
    const clone = links.find((link) => link.id !== linkId);
    expect(clone?.assetId).toBe(result.newAsset.id);
    expect(clone?.linkState).toBe("active");
    expect(clone?.role).toBe("battery_level");
    expect(f.tx((tx) => activeHaLinks(tx, result.newAsset.id))).toHaveLength(1);
    expect(f.tx((tx) => activeHaLinks(tx, oldAssetId))).toHaveLength(0);

    // Cloned links mean nothing to re-link, so no alert.
    expect(
      f.tx((tx) =>
        tx
          .select()
          .from(appAlert)
          .where(and(eq(appAlert.kind, "ha_link_missing"), isNull(appAlert.resolvedAtMs)))
          .all(),
      ),
    ).toHaveLength(0);
  });

  it("retires the links and asks the user to re-link when nothing is cloned", () => {
    const oldAssetId = f.addAsset({ name: "Smoke alarm" });
    const deviceId = f.addDevice();
    f.linkAsset(oldAssetId, { deviceId });

    const result = swap(oldAssetId);

    expect(result.retiredLinkIds).toHaveLength(1);
    expect(result.clonedLinkIds).toEqual([]);
    const alerts = f.tx((tx) =>
      tx.select().from(appAlert).where(eq(appAlert.kind, "ha_link_missing")).all(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.entityId).toBe(result.newAsset.id);
    expect(alerts[0]?.dedupeKey).toBe(`ha_link_missing:asset:${result.newAsset.id}`);
  });

  it("installs an existing spare unit and keeps its own identity", () => {
    const oldAssetId = f.addAsset({ name: "Old pump", category: "plumbing" });
    const spareId = f.addAsset({
      name: "Spare pump",
      category: "plumbing",
      status: "planned",
      installedOn: null,
    });

    const result = swap(oldAssetId, { newAsset: { existingAssetId: spareId } });

    expect(result.newAsset.id).toBe(spareId);
    const spare = assetRow(spareId);
    expect(spare?.name).toBe("Spare pump");
    expect(spare?.status).toBe("installed");
    expect(spare?.installedOn).toBe(START_DATE);
    expect(spare?.replacesAssetId).toBe(oldAssetId);
    expect(assetRow(oldAssetId)?.replacedByAssetId).toBe(spareId);
    // No second asset row was invented.
    expect(f.tx((tx) => tx.select().from(asset).all())).toHaveLength(2);
  });

  it("does not duplicate a consumable the replacement already declares", () => {
    const oldAssetId = f.addAsset({ name: "Old alarm" });
    const spareId = f.addAsset({ name: "Spare alarm", status: "planned", installedOn: null });
    const aaa = f.addPart({ name: "AAA alkaline" });
    const cr2032 = f.addPart({ name: "CR2032" });
    f.addConsumable(oldAssetId, aaa, "battery", 2_000);
    f.addConsumable(oldAssetId, cr2032, "other", 1_000);
    f.addConsumable(spareId, aaa, "battery", 3_000);

    const result = swap(oldAssetId, {
      newAsset: { existingAssetId: spareId },
      cloneConsumables: true,
    });

    const consumables = f.tx((tx) =>
      tx.select().from(assetConsumable).where(eq(assetConsumable.assetId, spareId)).all(),
    );
    expect(consumables).toHaveLength(2);
    // The spare's own AAA line is left as it is; only the missing role is cloned.
    expect(consumables.find((row) => row.partId === aaa)?.qtyMilli).toBe(3_000);
    expect(consumables.find((row) => row.partId === cr2032)?.qtyMilli).toBe(1_000);
    expect(result.consumableIds).toHaveLength(1);
  });

  it("moves active plans to the replacement and leaves paused ones behind", () => {
    const oldAssetId = f.addAsset({ name: "Old unit" });
    const activePlanId = f.addPlan({ title: "Service it", assetId: oldAssetId });
    const pausedPlanId = f.addPlan({ title: "Old idea", assetId: oldAssetId, status: "paused" });

    const result = swap(oldAssetId);

    expect(result.repointedPlanIds).toEqual([activePlanId]);
    const plans = f.tx((tx) => tx.select().from(maintenancePlan).all());
    expect(plans.find((plan) => plan.id === activePlanId)?.assetId).toBe(result.newAsset.id);
    expect(plans.find((plan) => plan.id === pausedPlanId)?.assetId).toBe(oldAssetId);
    const audits = f.tx((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityTable, "maintenance_plan")).all(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityId).toBe(activePlanId);
  });

  describe("refusals", () => {
    it("refuses a unit that has already been replaced", () => {
      const oldAssetId = f.addAsset({ name: "Old unit" });
      swap(oldAssetId);
      expect(() => swap(oldAssetId)).toThrow(ConflictError);
    });

    it("refuses a unit replacing itself", () => {
      const assetId = f.addAsset({ name: "Only unit" });
      expect(() => swap(assetId, { newAsset: { existingAssetId: assetId } })).toThrow(
        ValidationError,
      );
    });

    it("refuses a swap that would close the chain into a cycle", () => {
      const first = f.addAsset({ name: "Unit 1" });
      const second = swap(first).newAsset.id;
      // "Unit 2 is replaced by Unit 1" would make the chain circular.
      expect(() => swap(second, { newAsset: { existingAssetId: first } })).toThrow(
        /replacement chain/,
      );
    });

    it("refuses an unknown unit", () => {
      expect(() => swap("nope")).toThrow(NotFoundError);
    });
  });
});

describe("replacementChain", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("reads oldest first, from whichever generation you ask about", () => {
    const first = f.addAsset({ name: "Unit 1" });
    const second = f.tx((tx) =>
      replaceAsset(tx, f.ctx, {
        oldAssetId: first,
        newAsset: { name: "Unit 2" },
        replacedOn: "2020-05-01",
        reason: "failure",
      }),
    ).newAsset.id;
    const third = f.tx((tx) =>
      replaceAsset(tx, f.ctx, {
        oldAssetId: second,
        newAsset: { name: "Unit 3" },
        replacedOn: START_DATE,
        reason: "end_of_life",
      }),
    ).newAsset.id;

    const expected = [first, second, third];
    expect(f.tx((tx) => replacementChain(tx, first))).toEqual(expected);
    expect(f.tx((tx) => replacementChain(tx, second))).toEqual(expected);
    expect(f.tx((tx) => replacementChain(tx, third))).toEqual(expected);
  });

  it("is a single element for a unit that was never swapped", () => {
    const assetId = f.addAsset({ name: "Only unit" });
    expect(f.tx((tx) => replacementChain(tx, assetId))).toEqual([assetId]);
  });

  it("terminates on a chain corrupted into a cycle", () => {
    const first = f.addAsset({ name: "Unit 1" });
    const second = f.addAsset({ name: "Unit 2" });
    // Only reachable by writing the columns behind the service's back; the guard exists so a bad
    // row cannot hang a page.
    f.tx((tx) => {
      tx.update(asset).set({ replacedByAssetId: second }).where(eq(asset.id, first)).run();
      tx.update(asset).set({ replacedByAssetId: first }).where(eq(asset.id, second)).run();
    });
    expect(f.tx((tx) => replacementChain(tx, first))).toEqual([first, second]);
  });
});

describe("assetHistory", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  /** Complete one throwaway task against `assetId` so the unit has a completion of its own. */
  function completeOnce(assetId: string, requestId: string): string {
    const planId = f.addPlan({ title: `Service ${requestId}`, assetId });
    const occurrenceId = f.addOccurrence({ planId, assetId, title: `Service ${requestId}` });
    return completeOccurrence(f.handle, f.ctx, {
      requestId,
      occurrenceId,
      completedAtMs: f.clock.now(),
      materials: [],
    }).completion.id;
  }

  it("separates this unit's completions from the whole chain's, newest first", () => {
    f.clock.advanceToLocal("2026-01-10T09:00", TZ);
    const first = f.addAsset({ name: "Unit 1", category: "hvac" });
    const firstCompletionId = completeOnce(first, "req-first");

    const second = f.tx((tx) =>
      replaceAsset(tx, f.ctx, {
        oldAssetId: first,
        newAsset: { name: "Unit 2" },
        replacedOn: "2026-01-10",
        reason: "failure",
      }),
    ).newAsset.id;

    f.clock.advanceToLocal("2026-06-10T09:00", TZ);
    const secondCompletionId = completeOnce(second, "req-second");
    const third = f.tx((tx) =>
      replaceAsset(tx, f.ctx, {
        oldAssetId: second,
        newAsset: { name: "Unit 3" },
        replacedOn: START_DATE,
        reason: "end_of_life",
      }),
    ).newAsset.id;

    const history = f.tx((tx) => assetHistory(tx, first));
    expect(history.assetId).toBe(first);
    expect(history.chain).toEqual([first, second, third]);
    // Newest first, and every unit in the chain.
    expect(history.chainCompletions.map((row) => row.id)).toEqual([
      secondCompletionId,
      firstCompletionId,
    ]);
    // "This unit only" — the snapshot on the completion decides, never the chain.
    expect(history.completions.map((row) => row.id)).toEqual([firstCompletionId]);
    expect(f.tx((tx) => assetHistory(tx, second)).completions.map((row) => row.id)).toEqual([
      secondCompletionId,
    ]);
    expect(f.tx((tx) => assetHistory(tx, third)).completions).toEqual([]);

    // Both swaps, oldest first.
    expect(history.replacements.map((row) => row.newAssetId)).toEqual([second, third]);
  });

  it("includes the condition episodes of every unit in the chain", () => {
    const first = f.addAsset({ name: "Unit 1" });
    const second = f.tx((tx) =>
      replaceAsset(tx, f.ctx, {
        oldAssetId: first,
        newAsset: { name: "Unit 2" },
        replacedOn: START_DATE,
        reason: "failure",
      }),
    ).newAsset.id;

    const ruleId = f.addConditionRule();
    const entityRegistryId = f.addEntity({ entityId: "sensor.unit_battery" });
    const episodeId = newId();
    f.tx((tx) =>
      tx
        .insert(conditionEpisode)
        .values({
          id: episodeId,
          ruleId,
          haEntityRegistryId: entityRegistryId,
          assetId: second,
          openedAtMs: f.clock.now(),
          openedValue: 12,
          openLocalDate: START_DATE,
          minValue: 12,
          createdAtMs: f.clock.now(),
          createdBy: null,
        })
        .run(),
    );

    expect(f.tx((tx) => assetHistory(tx, first)).episodes.map((row) => row.id)).toEqual([
      episodeId,
    ]);
  });

  it("throws for an unknown unit", () => {
    expect(() => f.tx((tx) => assetHistory(tx, "nope"))).toThrow(NotFoundError);
  });
});

describe("assetsForEntity", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("prefers the entity link over the device link", () => {
    const deviceId = f.addDevice();
    const entityRegistryId = f.addEntity({ entityId: "sensor.alarm_battery", deviceId });
    const viaEntity = f.addAsset({ name: "The alarm" });
    const viaDevice = f.addAsset({ name: "The hub" });
    f.linkAsset(viaEntity, { entityRegistryId });
    f.linkAsset(viaDevice, { deviceId });

    expect(f.tx((tx) => assetsForEntity(tx, entityRegistryId, deviceId))).toEqual([viaEntity]);
  });

  it("falls back to the device link when the entity itself is not linked", () => {
    const deviceId = f.addDevice();
    const entityRegistryId = f.addEntity({ entityId: "sensor.alarm_battery", deviceId });
    const assetId = f.addAsset({ name: "The alarm" });
    f.linkAsset(assetId, { deviceId });

    expect(f.tx((tx) => assetsForEntity(tx, entityRegistryId, deviceId))).toEqual([assetId]);
    // No device to fall back to means no asset, which is what makes §6.4 raise an alert instead
    // of creating a task nobody can record history against.
    expect(f.tx((tx) => assetsForEntity(tx, entityRegistryId, null))).toEqual([]);
  });

  it("ignores links that are no longer live", () => {
    const deviceId = f.addDevice();
    const entityRegistryId = f.addEntity({ entityId: "sensor.alarm_battery", deviceId });
    const assetId = f.addAsset({ name: "The alarm" });
    f.linkAsset(assetId, { entityRegistryId });
    f.tx((tx) =>
      tx
        .update(assetHaLink)
        .set({ linkState: "missing" })
        .where(eq(assetHaLink.assetId, assetId))
        .run(),
    );

    expect(f.tx((tx) => assetsForEntity(tx, entityRegistryId, deviceId))).toEqual([]);
  });
});
