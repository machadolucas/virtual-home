/**
 * Low battery — §9 items 69–80.
 *
 * The theme of every test here is CLAUDE.md rule 8 and rule 6: `unavailable` is never 0 %, and a
 * reading recovering is never evidence that maintenance happened.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  appAlert,
  assetHaLink,
  completion,
  conditionEpisode,
  conditionSignal,
  haDevice,
  maintenanceOccurrence,
  notificationRecipientState,
  occurrenceEvent,
  reminderSlot,
  stockTransaction,
} from "@/db/schema";
import { availableMilli, purchase } from "@/domain/inventory";
import { completeOccurrence } from "@/domain/completion";
import {
  closeEpisodeWithoutMaintenance,
  evaluateBatterySignal,
  onEntityRemoved,
  resolveCanonicalBatteryEntity,
  resolveRule,
  syncCanonicalBatteryEntity,
} from "@/domain/condition";
import { makeFixture, START_DATE, type Fixture } from "./fixtures-inventory";

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** A smoke alarm whose battery entity is linked to it, plus a household-wide low-battery rule. */
function batteryScenario(
  f: Fixture,
  ruleOverrides: Parameters<Fixture["addConditionRule"]>[0] = {},
) {
  const assetId = f.addAsset({ name: "Master bedroom smoke alarm" });
  const deviceId = f.addDevice({ name: "Smoke alarm" });
  const entityRegistryId = f.addEntity({ entityId: "sensor.smoke_alarm_battery", deviceId });
  f.linkAsset(assetId, { entityRegistryId, role: "battery_level" });
  // A scoped rule points at the asset/entity this scenario just created, unless told otherwise.
  const scope = ruleOverrides.scope ?? "all_batteries";
  const ruleId = f.addConditionRule({
    ...ruleOverrides,
    assetId: scope === "asset" ? (ruleOverrides.assetId ?? assetId) : (ruleOverrides.assetId ?? null),
    entityRegistryId:
      scope === "entity"
        ? (ruleOverrides.entityRegistryId ?? entityRegistryId)
        : (ruleOverrides.entityRegistryId ?? null),
  });
  return { assetId, deviceId, entityRegistryId, ruleId };
}

function signalOf(f: Fixture, entityRegistryId: string) {
  return f.tx((tx) =>
    tx
      .select()
      .from(conditionSignal)
      .where(eq(conditionSignal.haEntityRegistryId, entityRegistryId))
      .get(),
  );
}

function episodesOf(f: Fixture) {
  return f.tx((tx) => tx.select().from(conditionEpisode).all());
}

function occurrencesOf(f: Fixture) {
  return f.tx((tx) => tx.select().from(maintenanceOccurrence).all());
}

function alertsOf(f: Fixture, kind: "stale_sensor" | "ha_link_missing" | "negative_stock") {
  return f.tx((tx) =>
    tx
      .select()
      .from(appAlert)
      .where(and(eq(appAlert.kind, kind), isNull(appAlert.resolvedAtMs)))
      .all(),
  );
}

describe("evaluateBatterySignal", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  // §9 item 69.
  it("12 % sustained two hours opens one episode and one task due today", () => {
    const { assetId, entityRegistryId, ruleId } = batteryScenario(f);

    const first = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    expect(first.action).toBe("below_pending");
    expect(episodesOf(f)).toHaveLength(0);
    expect(signalOf(f, entityRegistryId)?.belowSinceMs).toBe(f.clock.now());

    f.clock.advance(2 * HOUR);
    const opened = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });

    expect(opened.action).toBe("episode_opened");
    const episodes = episodesOf(f);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.ruleId).toBe(ruleId);
    expect(episodes[0]?.assetId).toBe(assetId);
    expect(episodes[0]?.openedValue).toBe(12);
    expect(episodes[0]?.openLocalDate).toBe(START_DATE);
    expect(episodes[0]?.closedAtMs).toBeNull();
    expect(episodes[0]?.occurrenceId).toBe(opened.occurrenceId);

    const occurrences = occurrencesOf(f);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.source).toBe("condition");
    expect(occurrences[0]?.conditionRuleId).toBe(ruleId);
    expect(occurrences[0]?.assetId).toBe(assetId);
    expect(occurrences[0]?.title).toBe("Replace battery: Master bedroom smoke alarm");
    expect(occurrences[0]?.dueDate).toBe(START_DATE);
    expect(occurrences[0]?.originalDueDate).toBe(START_DATE);
    expect(occurrences[0]?.status).toBe("pending");
    // Never a fabricated completion.
    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(0);
  });

  // §9 item 70.
  it("12 % for 30 minutes then 40 % opens nothing", () => {
    const { entityRegistryId } = batteryScenario(f);

    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(30 * MINUTE);
    const recovered = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "40",
      lastUpdatedMs: f.clock.now(),
    });

    expect(recovered.action).toBe("above_pending");
    expect(episodesOf(f)).toHaveLength(0);
    expect(occurrencesOf(f)).toHaveLength(0);
    // The low timer was reset by a genuine high reading.
    expect(signalOf(f, entityRegistryId)?.belowSinceMs).toBeNull();
    expect(signalOf(f, entityRegistryId)?.aboveSinceMs).toBe(f.clock.now());
  });

  // §9 item 71.
  it.each([
    ["unavailable", "unavailable"],
    ["unknown", "unknown"],
    ["", "non_numeric"],
    ["AAA", "non_numeric"],
    ["none", "non_numeric"],
  ])("treats %o as invalid, never as 0 %%", (rawState, invalidReason) => {
    const { entityRegistryId } = batteryScenario(f);

    const result = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState,
      lastUpdatedMs: f.clock.now(),
    });

    expect(result.action).toBe("invalid");
    expect(result.value).toBeNull();
    const signal = signalOf(f, entityRegistryId);
    expect(signal?.isValid).toBe(false);
    expect(signal?.invalidReason).toBe(invalidReason);
    expect(signal?.numericValue).toBeNull();
    expect(signal?.rawState).toBe(rawState);
    expect(signal?.belowSinceMs).toBeNull();
    expect(episodesOf(f)).toHaveLength(0);
    expect(occurrencesOf(f)).toHaveLength(0);
  });

  // §9 item 72.
  it("a five-minute unavailable blip freezes the sustain clock instead of resetting it", () => {
    const { entityRegistryId } = batteryScenario(f);
    const startedAt = f.clock.now();

    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });

    f.clock.advance(90 * MINUTE);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "unavailable",
      lastUpdatedMs: f.clock.now(),
    });
    // The clock is frozen, not restarted.
    expect(signalOf(f, entityRegistryId)?.belowSinceMs).toBe(startedAt);

    f.clock.advance(5 * MINUTE);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    expect(episodesOf(f)).toHaveLength(0);

    // 2 h after the *first* low reading, the episode opens on schedule.
    f.clock.set(startedAt + 2 * HOUR);
    const opened = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    expect(opened.action).toBe("episode_opened");
    expect(episodesOf(f)).toHaveLength(1);
  });

  // §9 item 73.
  it("a three-day-old reading opens nothing and raises app_alert('stale_sensor')", () => {
    const { entityRegistryId } = batteryScenario(f);

    const result = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now() - 3 * 24 * HOUR,
    });

    expect(result.action).toBe("stale");
    expect(signalOf(f, entityRegistryId)?.isStale).toBe(true);
    expect(episodesOf(f)).toHaveLength(0);
    expect(occurrencesOf(f)).toHaveLength(0);
    const alerts = alertsOf(f, "stale_sensor");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.entityId).toBe(entityRegistryId);
  });

  it("raises stale_sensor for a continuously unavailable entity, once it has been long enough", () => {
    const { entityRegistryId } = batteryScenario(f);
    const wentAway = f.clock.now();

    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "unavailable",
      lastUpdatedMs: wentAway,
      lastChangedMs: wentAway,
    });
    expect(alertsOf(f, "stale_sensor")).toHaveLength(0);

    // 49 h later, still unavailable — `last_changed` has not moved, which is the measure.
    f.clock.advance(49 * HOUR);
    const result = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "unavailable",
      lastUpdatedMs: f.clock.now(),
    });
    expect(result.action).toBe("invalid");
    expect(result.alertId).not.toBeNull();
    expect(alertsOf(f, "stale_sensor")).toHaveLength(1);
  });

  // §9 item 74.
  it("dead-band oscillation neither closes nor re-opens anything", () => {
    const { entityRegistryId } = batteryScenario(f);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(2 * HOUR);
    const opened = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    expect(opened.action).toBe("episode_opened");

    for (const value of ["16", "17", "29", "16"]) {
      f.clock.advance(7 * HOUR);
      const result = evaluateBatterySignal(f.handle, f.workerCtx, {
        entityRegistryId,
        rawState: value,
        lastUpdatedMs: f.clock.now(),
      });
      expect(result.action).toBe("dead_band");
    }

    const episodes = episodesOf(f);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.closedAtMs).toBeNull();
    expect(occurrencesOf(f)).toHaveLength(1);
  });

  it("readings at or below the threshold while an episode is open only track the minimum", () => {
    const { entityRegistryId } = batteryScenario(f);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(2 * HOUR);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });

    f.clock.advance(HOUR);
    const again = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "7",
      lastUpdatedMs: f.clock.now(),
    });
    expect(again.action).toBe("already_open");
    expect(episodesOf(f)[0]?.minValue).toBe(7);
    expect(episodesOf(f)).toHaveLength(1);
  });

  // §9 item 75.
  it("recovery closes the episode, keeps the task open and snoozes both recipients three days", () => {
    const { entityRegistryId } = batteryScenario(f);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(2 * HOUR);
    const opened = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    const occurrenceId = opened.occurrenceId!;

    // 45 % arrives, then holds for the six-hour clear sustain.
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "45",
      lastUpdatedMs: f.clock.now(),
    });
    expect(episodesOf(f)[0]?.closedAtMs).toBeNull();

    f.clock.advance(6 * HOUR);
    const closed = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "45",
      lastUpdatedMs: f.clock.now(),
    });

    expect(closed.action).toBe("episode_closed");
    const episodes = episodesOf(f);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.closeReason).toBe("recovered");
    expect(episodes[0]?.closedValue).toBe(45);
    expect(episodes[0]?.closedAtMs).toBe(f.clock.now());

    // The task stays open. Recovery is not maintenance.
    const occurrence = f.tx((tx) =>
      tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, occurrenceId)).get(),
    );
    expect(occurrence?.status).toBe("pending");
    expect(occurrence?.completionId).toBeNull();
    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(0);
    expect(f.tx((tx) => tx.select().from(stockTransaction).all())).toHaveLength(0);

    // Both recipients snoozed — snoozed, not cleared.
    const states = f.tx((tx) =>
      tx
        .select()
        .from(notificationRecipientState)
        .where(eq(notificationRecipientState.occurrenceId, occurrenceId))
        .all(),
    );
    expect(states).toHaveLength(2);
    expect(states.every((row) => row.state === "snoozed")).toBe(true);
    expect(states.every((row) => row.clearedAtMs === null)).toBe(true);

    // Three days out, at the household delivery time.
    const slots = f.tx((tx) =>
      tx.select().from(reminderSlot).where(eq(reminderSlot.state, "pending")).all(),
    );
    expect(slots).toHaveLength(2);
    expect(new Set(slots.map((row) => row.scheduledLocalDate))).toEqual(new Set(["2026-06-13"]));

    const events = f.tx((tx) =>
      tx
        .select()
        .from(occurrenceEvent)
        .where(eq(occurrenceEvent.kind, "condition_recovered"))
        .all(),
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.detailJson ?? "{}")).toMatchObject({ value: 45 });
  });

  // §9 item 78.
  it("dip → recover → dip creates no second task while the first is still open", () => {
    const { entityRegistryId } = batteryScenario(f);

    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(2 * HOUR);
    const opened = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });

    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "45",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(6 * HOUR);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "45",
      lastUpdatedMs: f.clock.now(),
    });

    // Down again.
    f.clock.advance(HOUR);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "11",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(2 * HOUR);
    const reopened = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "11",
      lastUpdatedMs: f.clock.now(),
    });

    expect(reopened.action).toBe("episode_opened");
    // Two episodes (the history worth keeping), one task (`ux_occ_open_per_condition`).
    expect(episodesOf(f)).toHaveLength(2);
    expect(occurrencesOf(f)).toHaveLength(1);
    expect(reopened.occurrenceId).toBe(opened.occurrenceId);
    // The second episode points at the same task.
    const episodes = episodesOf(f);
    expect(new Set(episodes.map((row) => row.occurrenceId))).toEqual(
      new Set([opened.occurrenceId]),
    );
  });

  it("raises ha_link_missing and creates no task when nothing links the entity to an asset", () => {
    const deviceId = f.addDevice();
    const entityRegistryId = f.addEntity({ entityId: "sensor.orphan_battery", deviceId });
    f.addConditionRule();

    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "9",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(2 * HOUR);
    const result = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "9",
      lastUpdatedMs: f.clock.now(),
    });

    expect(result.action).toBe("link_missing");
    // The episode is honest history; the task would have nowhere to record it.
    expect(episodesOf(f)).toHaveLength(1);
    expect(episodesOf(f)[0]?.assetId).toBeNull();
    expect(occurrencesOf(f)).toHaveLength(0);
    expect(alertsOf(f, "ha_link_missing")).toHaveLength(1);
  });

  it("does nothing at all when no rule matches", () => {
    const { entityRegistryId } = batteryScenario(f, { enabled: false });
    const result = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "5",
      lastUpdatedMs: f.clock.now(),
    });
    expect(result.action).toBe("no_rule");
    expect(episodesOf(f)).toHaveLength(0);
    // The reading is still recorded — we know what HA said.
    expect(signalOf(f, entityRegistryId)?.numericValue).toBe(5);
  });

  it("honours a per-rule threshold and sustain over the household defaults", () => {
    const { entityRegistryId } = batteryScenario(f, {
      scope: "entity",
      thresholdPct: 40,
      clearThresholdPct: 60,
      sustainMinutes: 10,
    });

    const resolved = f.tx((tx) => resolveRule(tx, entityRegistryId));
    expect(resolved?.matchedBy).toBe("entity");
    expect(resolved?.thresholds).toEqual({
      lowPct: 40,
      clearPct: 60,
      sustainLowMinutes: 10,
      sustainClearMinutes: 360,
      staleHours: 48,
    });

    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "35",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(10 * MINUTE);
    const opened = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "35",
      lastUpdatedMs: f.clock.now(),
    });
    expect(opened.action).toBe("episode_opened");
  });

  it("prefers an entity rule, then an asset rule, then the household-wide rule", () => {
    const assetId = f.addAsset({ name: "Door sensor" });
    const deviceId = f.addDevice();
    const entityRegistryId = f.addEntity({ entityId: "sensor.door_battery", deviceId });
    f.linkAsset(assetId, { entityRegistryId, role: "battery_level" });

    const globalId = f.addConditionRule();
    expect(f.tx((tx) => resolveRule(tx, entityRegistryId))?.rule.id).toBe(globalId);

    const assetRuleId = f.addConditionRule({ scope: "asset", assetId });
    expect(f.tx((tx) => resolveRule(tx, entityRegistryId))?.rule.id).toBe(assetRuleId);

    const entityRuleId = f.addConditionRule({ scope: "entity", entityRegistryId });
    expect(f.tx((tx) => resolveRule(tx, entityRegistryId))?.rule.id).toBe(entityRuleId);
  });
});

// §9 item 77.
describe("canonical battery entity", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("picks the percentage entity out of level / voltage / type", () => {
    const deviceId = f.addDevice();
    const level = f.addEntity({ entityId: "sensor.x_battery", deviceId, deviceClass: "battery", unit: "%" });
    f.addEntity({
      entityId: "sensor.x_battery_voltage",
      deviceId,
      deviceClass: "voltage",
      unit: "V",
    });
    f.addEntity({ entityId: "sensor.x_battery_type", deviceId, deviceClass: "enum", unit: null });

    expect(f.tx((tx) => resolveCanonicalBatteryEntity(tx, deviceId))).toBe(level);
  });

  it("still picks exactly one when the type sensor is mislabelled as a battery percentage", () => {
    const deviceId = f.addDevice();
    const level = f.addEntity({ entityId: "sensor.x_battery", deviceId });
    const type = f.addEntity({ entityId: "sensor.x_battery_type", deviceId });
    // Its latest reading is `"AAA"` — non-numeric, so it is not a level whatever the metadata says.
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId: type,
      rawState: "AAA",
      lastUpdatedMs: f.clock.now(),
    });

    expect(f.tx((tx) => resolveCanonicalBatteryEntity(tx, deviceId))).toBe(level);
  });

  it("a manual asset_ha_link(role='battery_level') overrides the ranking", () => {
    const assetId = f.addAsset({ name: "Hub" });
    const deviceId = f.addDevice();
    f.addEntity({ entityId: "sensor.x_battery", deviceId });
    const pack2 = f.addEntity({ entityId: "sensor.x_pack_two_battery_level", deviceId });
    f.linkAsset(assetId, { entityRegistryId: pack2, role: "battery_level" });

    expect(f.tx((tx) => resolveCanonicalBatteryEntity(tx, deviceId))).toBe(pack2);
  });

  it("a non-canonical entity of the same device is ignored by the evaluator", () => {
    const assetId = f.addAsset({ name: "Smoke alarm" });
    const deviceId = f.addDevice();
    const level = f.addEntity({ entityId: "sensor.x_battery", deviceId });
    const voltage = f.addEntity({
      entityId: "sensor.x_battery_voltage",
      deviceId,
      deviceClass: "voltage",
      unit: "V",
    });
    f.linkAsset(assetId, { deviceId, role: "primary" });
    f.addConditionRule();
    f.tx((tx) => syncCanonicalBatteryEntity(tx, f.workerCtx, deviceId));
    expect(
      f.tx((tx) => tx.select().from(haDevice).where(eq(haDevice.deviceId, deviceId)).get())
        ?.canonicalBatteryEntityId,
    ).toBe(level);

    // 3.2 V is not 3.2 % — and the evaluator refuses to pretend otherwise.
    const result = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId: voltage,
      rawState: "3.2",
      lastUpdatedMs: f.clock.now(),
    });
    expect(result.action).toBe("not_canonical");
    expect(episodesOf(f)).toHaveLength(0);
  });
});

// §9 items 76 and 79.
describe("closing a battery task", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  function openedTask() {
    const aaa = f.addPart({ name: "AAA alkaline" });
    f.tx((tx) => purchase(tx, f.ctx, { partId: aaa, qtyMilli: 8_000 }));
    const { assetId, entityRegistryId, ruleId } = batteryScenario(f);
    f.addConsumable(assetId, aaa, "battery", 2_000);

    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(2 * HOUR);
    const opened = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    return { aaa, assetId, entityRegistryId, ruleId, occurrenceId: opened.occurrenceId! };
  }

  // §9 item 79.
  it("a completion consumes 2 × AAA and closes the episode as `completed`", () => {
    const { aaa, occurrenceId } = openedTask();

    const result = completeOccurrence(f.handle, f.ctx, {
      requestId: "req-battery",
      occurrenceId,
      completedAtMs: f.clock.now(),
    });

    // Expected materials came from `asset_consumable(role='battery')`.
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]?.partId).toBe(aaa);
    expect(result.materials[0]?.expectedQtyMilli).toBe(2_000);
    expect(result.materials[0]?.actualQtyMilli).toBe(2_000);
    expect(f.tx((tx) => availableMilli(tx, aaa))).toBe(6_000);

    const episodes = episodesOf(f);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.closeReason).toBe("completed");
    expect(episodes[0]?.closedAtMs).toBe(f.clock.now());
    expect(episodes[0]?.occurrenceId).toBe(occurrenceId);

    // A condition task has no plan, so no successor is generated: the next task arises the next
    // time the battery actually goes low.
    expect(result.next).toBeNull();
    expect(occurrencesOf(f)).toHaveLength(1);
  });

  // §9 item 76.
  it("close without maintenance skips the task, writing no completion and no stock movement", () => {
    const { aaa, entityRegistryId, occurrenceId } = openedTask();
    const stockBefore = f.tx((tx) => availableMilli(tx, aaa));

    // The reading recovers first, which is the situation the button exists for.
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "45",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(6 * HOUR);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "45",
      lastUpdatedMs: f.clock.now(),
    });

    const result = closeEpisodeWithoutMaintenance(f.handle, f.ctx, occurrenceId);

    expect(result.occurrenceId).toBe(occurrenceId);
    // Recovery already closed the episode, so this call closes nothing extra.
    expect(result.closedEpisodeIds).toEqual([]);

    const occurrence = f.tx((tx) =>
      tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, occurrenceId)).get(),
    );
    expect(occurrence?.status).toBe("skipped");
    expect(occurrence?.closeReason).toBe("condition_recovered");
    expect(occurrence?.completionId).toBeNull();

    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(0);
    expect(f.tx((tx) => availableMilli(tx, aaa))).toBe(stockBefore);
  });

  it("closes a still-open episode as `manual` when the user closes without maintenance", () => {
    const { occurrenceId } = openedTask();
    const result = closeEpisodeWithoutMaintenance(f.handle, f.ctx, occurrenceId);
    expect(result.closedEpisodeIds).toHaveLength(1);
    expect(episodesOf(f)[0]?.closeReason).toBe("manual");
  });
});

// §9 item 80.
describe("onEntityRemoved", () => {
  let f: Fixture;

  beforeEach(() => {
    f = makeFixture();
  });

  afterEach(() => {
    f.close();
  });

  it("closes the episode `entity_removed`, keeps the task open, marks the links missing", () => {
    const { entityRegistryId } = batteryScenario(f);
    evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });
    f.clock.advance(2 * HOUR);
    const opened = evaluateBatterySignal(f.handle, f.workerCtx, {
      entityRegistryId,
      rawState: "12",
      lastUpdatedMs: f.clock.now(),
    });

    f.clock.advance(HOUR);
    const result = onEntityRemoved(f.handle, f.workerCtx, entityRegistryId);

    expect(result.closedEpisodeIds).toHaveLength(1);
    const episodes = episodesOf(f);
    expect(episodes[0]?.closeReason).toBe("entity_removed");
    expect(episodes[0]?.closedAtMs).toBe(f.clock.now());

    // Telemetry vanishing is not maintenance: the task stays open.
    expect(result.openOccurrenceIds).toEqual([opened.occurrenceId]);
    const occurrence = f.tx((tx) =>
      tx
        .select()
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.id, opened.occurrenceId!))
        .get(),
    );
    expect(occurrence?.status).toBe("pending");
    expect(f.tx((tx) => tx.select().from(completion).all())).toHaveLength(0);

    // The links say `missing`, and the alert asks the user to re-link.
    const links = f.tx((tx) =>
      tx
        .select()
        .from(assetHaLink)
        .where(eq(assetHaLink.haEntityRegistryId, entityRegistryId))
        .all(),
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.linkState).toBe("missing");
    expect(links[0]?.linkStateChangedAtMs).toBe(f.clock.now());
    const alerts = alertsOf(f, "ha_link_missing");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.entityId).toBe(entityRegistryId);
  });

  it("clears the device's canonical battery pointer", () => {
    const { deviceId, entityRegistryId } = batteryScenario(f);
    f.tx((tx) => syncCanonicalBatteryEntity(tx, f.workerCtx, deviceId));
    expect(
      f.tx((tx) => tx.select().from(haDevice).where(eq(haDevice.deviceId, deviceId)).get())
        ?.canonicalBatteryEntityId,
    ).toBe(entityRegistryId);

    onEntityRemoved(f.handle, f.workerCtx, entityRegistryId);

    expect(
      f.tx((tx) => tx.select().from(haDevice).where(eq(haDevice.deviceId, deviceId)).get())
        ?.canonicalBatteryEntityId,
    ).toBeNull();
  });
});
