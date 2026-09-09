/**
 * The state cache. The behaviour that carries the load is the *filter*: the household instance has
 * ~3300 entities and a handful of links, so "is this entity interesting" decides both how big this
 * table gets and how many rows the outbox grows per minute.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@/db/client";
import { applySnapshot } from "@/server/ha/registryCache";
import {
  KEPT_ATTRIBUTES,
  applyStateChanged,
  applyStates,
  countCachedStates,
  interestingEntityIds,
  pruneUninterestingStates,
  readCanonicalBatteryStates,
  readSnapshot,
  renderableEntityIds,
} from "@/server/ha/stateCache";
import { buildSampleRegistry, type FakeRegistry } from "../../helpers/fakeHa";
import { testDb } from "../../helpers/db";
import { T0, linkDevice, linkEntity, one, seedAsset, snapshotOf } from "./fixtures";

const DOOR_BATTERY_ENTITY = "sensor.bedroom_door_sensor_battery";
const DOOR_CONTACT_ENTITY = "binary_sensor.bedroom_door_sensor_contact";
const SUPPLY_TEMP_ENTITY = "sensor.ventilation_supply_air_temperature";

describe("state cache", () => {
  let handle: DbHandle;
  let registry: FakeRegistry;

  beforeEach(() => {
    handle = testDb();
    registry = buildSampleRegistry();
    applySnapshot(handle, snapshotOf(registry), T0);
  });

  afterEach(() => {
    handle.close();
  });

  it("counts the canonical battery entities as interesting even with no links at all", () => {
    const interesting = interestingEntityIds(handle.db);
    expect([...interesting].sort()).toEqual([
      DOOR_BATTERY_ENTITY,
      "sensor.lucas_iphone_battery_level",
      "sensor.marja_helenas_iphone_battery_level",
    ]);
  });

  it("adds a directly linked entity", () => {
    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    linkEntity(handle, {
      assetId,
      registryId: "reg_door_contact",
      entityIdSnapshot: DOOR_CONTACT_ENTITY,
    });
    expect(interestingEntityIds(handle.db).has(DOOR_CONTACT_ENTITY)).toBe(true);
  });

  it("a device link makes that device's entities interesting", () => {
    const assetId = seedAsset(handle, { name: "House ventilation" });
    linkDevice(handle, { assetId, deviceId: "dev_parmair" });
    const interesting = interestingEntityIds(handle.db);
    expect(interesting.has(SUPPLY_TEMP_ENTITY)).toBe(true);
    expect(interesting.has("fan.house_hrv")).toBe(true);
    // The filter device is a separate registry entry, so its entity stays out.
    expect(interesting.has("sensor.ventilation_filter_remaining_days")).toBe(false);
  });

  it("a missing link stops making its entity interesting", () => {
    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    const linkId = linkEntity(handle, {
      assetId,
      registryId: "reg_door_contact",
      entityIdSnapshot: DOOR_CONTACT_ENTITY,
    });
    handle.sqlite
      .prepare(`UPDATE asset_ha_link SET link_state = 'retired' WHERE id = ?`)
      .run(linkId);
    expect(interestingEntityIds(handle.db).has(DOOR_CONTACT_ENTITY)).toBe(false);
  });

  it("counts an enabled condition rule's entity, but not a disabled one", () => {
    handle.sqlite
      .prepare(
        `INSERT INTO condition_rule
           (id, kind, name, scope, ha_entity_registry_id, priority, assignment_mode,
            title_template, enabled, created_at_ms, updated_at_ms)
         VALUES (?, 'threshold_below', 'Supply air too cold', 'entity', 'reg_hrv_supply_temp',
                 'normal', 'shared', 'Check ventilation', ?, ?, ?)`,
      )
      .run("rule-1", 1, T0, T0);
    expect(interestingEntityIds(handle.db).has(SUPPLY_TEMP_ENTITY)).toBe(true);

    handle.sqlite.prepare(`UPDATE condition_rule SET enabled = 0 WHERE id = 'rule-1'`).run();
    expect(interestingEntityIds(handle.db).has(SUPPLY_TEMP_ENTITY)).toBe(false);
    // ...but a condition-rule entity is engine input, never a marker in the hello snapshot.
    expect(renderableEntityIds(handle.db).has(SUPPLY_TEMP_ENTITY)).toBe(false);
  });

  it("persists only the interesting states, with only the attributes we need", () => {
    const doorBattery = registry.states.get(DOOR_BATTERY_ENTITY);
    if (doorBattery) {
      doorBattery.attributes = {
        ...doorBattery.attributes,
        brightness: 153,
        rgb_color: [240, 210, 180],
        hs_color: [31, 25],
        color_temp_kelvin: 2700,
        color_temp: 370,
        effect_list: ["pulse"],
      };
    }
    const written = applyStates(handle, [...registry.states.values()], T0, {
      onlyInteresting: true,
    });

    expect(written.map((record) => record.entityId).sort()).toEqual([
      DOOR_BATTERY_ENTITY,
      "sensor.lucas_iphone_battery_level",
      "sensor.marja_helenas_iphone_battery_level",
    ]);
    expect(countCachedStates(handle.db)).toBe(3);

    const row = one<{ state: string; attributes_json: string; registry_id: string }>(
      handle,
      `SELECT state, attributes_json, registry_id FROM ha_entity_state WHERE entity_id = ?`,
      DOOR_BATTERY_ENTITY,
    );
    expect(row?.state).toBe("68");
    expect(row?.registry_id).toBe("reg_door_battery");
    const attributes = JSON.parse(row!.attributes_json) as Record<string, unknown>;
    expect(Object.keys(attributes).every((key) => KEPT_ATTRIBUTES.includes(key))).toBe(true);
    expect(attributes).toMatchObject({
      device_class: "battery",
      unit_of_measurement: "%",
      brightness: 153,
      rgb_color: [240, 210, 180],
      hs_color: [31, 25],
      color_temp_kelvin: 2700,
      color_temp: 370,
    });
    expect(attributes).not.toHaveProperty("effect_list");
  });

  it("onlyInteresting: false stores the whole instance", () => {
    applyStates(handle, [...registry.states.values()], T0, { onlyInteresting: false });
    expect(countCachedStates(handle.db)).toBe(registry.states.size);
  });

  it("applyStateChanged persists and reports interest for a linked entity", () => {
    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    linkEntity(handle, {
      assetId,
      registryId: "reg_door_contact",
      entityIdSnapshot: DOOR_CONTACT_ENTITY,
    });

    const interesting = applyStateChanged(
      handle,
      {
        entity_id: DOOR_CONTACT_ENTITY,
        new_state: {
          entity_id: DOOR_CONTACT_ENTITY,
          state: "on",
          attributes: { friendly_name: "Contact", device_class: "door" },
          last_changed: new Date(T0 + 1_000).toISOString(),
          last_updated: new Date(T0 + 1_000).toISOString(),
        },
        old_state: null,
      },
      T0 + 2_000,
    );

    expect(interesting).toBe(true);
    const row = one<{ state: string; last_updated_ms: number; observed_at_ms: number }>(
      handle,
      `SELECT state, last_updated_ms, observed_at_ms FROM ha_entity_state WHERE entity_id = ?`,
      DOOR_CONTACT_ENTITY,
    );
    expect(row).toEqual({
      state: "on",
      last_updated_ms: T0 + 1_000,
      observed_at_ms: T0 + 2_000,
    });
  });

  it("ignores a change on an unlinked entity entirely", () => {
    const interesting = applyStateChanged(
      handle,
      {
        entity_id: SUPPLY_TEMP_ENTITY,
        new_state: {
          entity_id: SUPPLY_TEMP_ENTITY,
          state: "21.1",
          attributes: {},
          last_changed: new Date(T0).toISOString(),
          last_updated: new Date(T0).toISOString(),
        },
      },
      T0 + 1_000,
    );
    expect(interesting).toBe(false);
    expect(countCachedStates(handle.db)).toBe(0);
  });

  it("drops the cached row when HA removes the entity", () => {
    applyStates(handle, [...registry.states.values()], T0, { onlyInteresting: true });
    expect(countCachedStates(handle.db)).toBe(3);

    const interesting = applyStateChanged(
      handle,
      { entity_id: DOOR_BATTERY_ENTITY, new_state: null, old_state: null },
      T0 + 1_000,
    );
    expect(interesting).toBe(true);
    expect(countCachedStates(handle.db)).toBe(2);
  });

  it("stores unknown / unavailable verbatim — they are never a value", () => {
    applyStateChanged(
      handle,
      {
        entity_id: DOOR_BATTERY_ENTITY,
        new_state: {
          entity_id: DOOR_BATTERY_ENTITY,
          state: "unavailable",
          attributes: { device_class: "battery", unit_of_measurement: "%" },
          last_changed: new Date(T0).toISOString(),
          last_updated: new Date(T0).toISOString(),
        },
      },
      T0 + 1_000,
    );
    expect(
      one<{ state: string }>(
        handle,
        `SELECT state FROM ha_entity_state WHERE entity_id = ?`,
        DOOR_BATTERY_ENTITY,
      )?.state,
    ).toBe("unavailable");
  });

  it("readSnapshot returns all rows, or just the ids asked for", () => {
    applyStates(handle, [...registry.states.values()], T0, { onlyInteresting: true });

    expect(readSnapshot(handle.db)).toHaveLength(3);
    const subset = readSnapshot(handle.db, [DOOR_BATTERY_ENTITY]);
    expect(subset).toHaveLength(1);
    expect(subset[0]).toMatchObject({ entityId: DOOR_BATTERY_ENTITY, state: "68" });
    expect(readSnapshot(handle.db, [])).toEqual([]);
  });

  it("readCanonicalBatteryStates joins the pointer to the reading", () => {
    applyStates(handle, [...registry.states.values()], T0, { onlyInteresting: true });
    const canonical = readCanonicalBatteryStates(handle.db);
    expect(canonical).toHaveLength(3);
    expect(canonical.find((row) => row.deviceId === "dev_door_sensor")).toMatchObject({
      registryId: "reg_door_battery",
      entityId: DOOR_BATTERY_ENTITY,
      state: "68",
    });
  });

  it("prunes rows that stopped being interesting", () => {
    applyStates(handle, [...registry.states.values()], T0, { onlyInteresting: false });
    expect(countCachedStates(handle.db)).toBe(registry.states.size);

    const removed = pruneUninterestingStates(handle);
    expect(removed).toBe(registry.states.size - 3);
    expect(countCachedStates(handle.db)).toBe(3);
    expect(pruneUninterestingStates(handle)).toBe(0);
  });
});
