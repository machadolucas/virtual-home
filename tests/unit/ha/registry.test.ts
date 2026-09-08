import { describe, expect, it } from "vitest";
import {
  classifyBatteryReading,
  diffRegistry,
  indexStates,
  normalizeArea,
  normalizeDevice,
  normalizeEntity,
  normalizeFloor,
  normalizeState,
  selectCanonicalBatteryEntities,
  type NormalizedEntity,
} from "@/worker/ha/registry";
import { SAMPLE_NOW_MS, buildSampleRegistry } from "../../helpers/fakeHa";

function sampleEntities(): NormalizedEntity[] {
  return buildSampleRegistry().entities.map(normalizeEntity);
}

describe("normalize*", () => {
  it("uses the identity precedence registry_id -> (platform, unique_id) -> entity_id", () => {
    expect(
      normalizeEntity({
        entity_id: "sensor.a",
        id: "reg_1",
        platform: "mqtt",
        unique_id: "u1",
      }),
    ).toMatchObject({ identityKey: "reg_1", identitySource: "registry_id", registryId: "reg_1" });

    expect(
      normalizeEntity({ entity_id: "sensor.b", platform: "mqtt", unique_id: "u2" }),
    ).toMatchObject({
      identityKey: "mqtt:u2",
      identitySource: "platform_unique_id",
      registryId: null,
    });

    expect(normalizeEntity({ entity_id: "sensor.c" })).toMatchObject({
      identityKey: "sensor.c",
      identitySource: "entity_id",
      registryId: null,
    });
  });

  it("derives the domain and normalises absent fields to null", () => {
    const entity = normalizeEntity({
      entity_id: "binary_sensor.ventilation_filter_state",
      id: "reg_x",
      name: "",
      device_id: null,
    });
    expect(entity.domain).toBe("binary_sensor");
    expect(entity.name).toBeNull();
    expect(entity.deviceId).toBeNull();
  });

  it("keeps a 2026.9 child device and prefers primary_config_entry over config_entries", () => {
    const registry = buildSampleRegistry();
    const child = registry.devices.find((device) => device.id === "dev_parmair_filter");
    expect(child).toBeDefined();
    const normalized = normalizeDevice(child!);
    expect(normalized).toMatchObject({
      deviceId: "dev_parmair_filter",
      parentDeviceId: "dev_parmair",
      manufacturer: null,
      model: null,
      swVersion: null,
      configEntryId: "cfg_parmair",
    });

    const deprecatedOnly = normalizeDevice({ id: "dev_old", config_entries: ["cfg_legacy"] });
    expect(deprecatedOnly.configEntryId).toBe("cfg_legacy");
  });

  it("normalises areas, floors and states", () => {
    const registry = buildSampleRegistry();
    const area = normalizeArea(registry.areas.find((a) => a.area_id === "technical_room")!);
    expect(area).toMatchObject({ areaId: "technical_room", floorId: "basement" });
    expect(area.aliases).toEqual(["Tekninen tila"]);

    const floor = normalizeFloor(registry.floors.find((f) => f.floor_id === "basement")!);
    expect(floor).toMatchObject({ floorId: "basement", level: -1 });

    const state = normalizeState(registry.states.get("fan.house_hrv")!);
    expect(state.entityId).toBe("fan.house_hrv");
    expect(state.raw).toBe("on");
    expect(typeof state.lastUpdatedMs).toBe("number");
  });
});

describe("diffRegistry", () => {
  const base = normalizeEntity({
    entity_id: "sensor.bedroom_door_sensor_battery",
    id: "reg_door_battery",
    platform: "mqtt",
    unique_id: "0x0c43_battery",
    device_id: "dev_door_sensor",
  });

  it("detects a rename by registry id, not by entity_id", () => {
    const renamed = normalizeEntity({
      entity_id: "sensor.guest_room_door_sensor_battery",
      id: "reg_door_battery",
      platform: "mqtt",
      unique_id: "0x0c43_battery",
      device_id: "dev_door_sensor",
    });
    const diff = diffRegistry([base], [renamed]);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.renamed).toHaveLength(1);
    expect(diff.renamed[0]).toMatchObject({
      from: "sensor.bedroom_door_sensor_battery",
      to: "sensor.guest_room_door_sensor_battery",
    });
    expect(diff.renamed[0]?.fields).toContain("entityId");
  });

  it("reports non-rename edits as changed, with the field names", () => {
    const moved = normalizeEntity({
      entity_id: "sensor.bedroom_door_sensor_battery",
      id: "reg_door_battery",
      platform: "mqtt",
      unique_id: "0x0c43_battery",
      device_id: "dev_door_sensor",
      area_id: "kitchen",
      hidden_by: "user",
    });
    const diff = diffRegistry([base], [moved]);
    expect(diff.renamed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.fields).toEqual(["areaId", "hiddenBy"]);
  });

  it("does not call an entity_id change a rename when the identity is weak", () => {
    // No registry id: identity falls back to (platform, unique_id), so a different entity_id
    // cannot be distinguished from a replacement and must not be reported as a rename.
    const before = normalizeEntity({
      entity_id: "sensor.old",
      platform: "mqtt",
      unique_id: "weak",
    });
    const after = normalizeEntity({
      entity_id: "sensor.new",
      platform: "mqtt",
      unique_id: "weak",
    });
    const diff = diffRegistry([before], [after]);
    expect(diff.renamed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
  });

  it("reports additions and removals", () => {
    const other = normalizeEntity({ entity_id: "sensor.new_thing", id: "reg_new" });
    const diff = diffRegistry([base], [other]);
    expect(diff.added.map((e) => e.identityKey)).toEqual(["reg_new"]);
    expect(diff.removed.map((e) => e.identityKey)).toEqual(["reg_door_battery"]);
  });

  it("ignores unchanged records", () => {
    expect(diffRegistry([base], [base])).toEqual({
      added: [],
      removed: [],
      renamed: [],
      changed: [],
    });
  });
});

describe("selectCanonicalBatteryEntities", () => {
  const registry = buildSampleRegistry();
  const entities = sampleEntities();
  const states = indexStates([...registry.states.values()]);

  it("picks the % level entity and never the _battery_type or _battery_voltage sibling", () => {
    const selection = selectCanonicalBatteryEntities(entities, states);
    expect(selection.canonicalByDevice.get("dev_door_sensor")).toBe("reg_door_battery");
    expect([...selection.canonicalByDevice.values()]).not.toContain("reg_door_battery_type");
    expect([...selection.canonicalByDevice.values()]).not.toContain("reg_door_battery_voltage");
  });

  it("remembers the _battery_type entity separately, for the part suggestion", () => {
    const selection = selectCanonicalBatteryEntities(entities, states);
    expect(selection.batteryTypeEntityByDevice.get("dev_door_sensor")).toBe(
      "reg_door_battery_type",
    );
    expect(registry.states.get("sensor.bedroom_door_sensor_battery_type")?.state).toBe("AAA");
  });

  it("excludes the phones' _battery_state and keeps _battery_level", () => {
    const selection = selectCanonicalBatteryEntities(entities, states);
    expect(selection.canonicalByDevice.get("dev_lucas_iphone")).toBe("reg_lucas_battery_level");
    expect(selection.canonicalByDevice.get("dev_marja_iphone")).toBe("reg_marja_battery_level");
    expect(selection.rejected.map((r) => r.entity.identityKey)).toContain(
      "reg_lucas_battery_state",
    );
  });

  it("does not treat a plain % sensor as a battery", () => {
    const selection = selectCanonicalBatteryEntities(entities, states);
    // The Parmair unit reports fan speeds and efficiency in %, and has no battery at all.
    expect(selection.canonicalByDevice.has("dev_parmair")).toBe(false);
  });

  it("lets a manual override win outright", () => {
    const selection = selectCanonicalBatteryEntities(entities, states, {
      dev_door_sensor: "reg_door_battery_voltage",
    });
    expect(selection.canonicalByDevice.get("dev_door_sensor")).toBe("reg_door_battery_voltage");
  });

  it("ignores an override that names an entity HA does not have", () => {
    const selection = selectCanonicalBatteryEntities(
      entities,
      states,
      new Map([["dev_door_sensor", "reg_does_not_exist"]]),
    );
    expect(selection.canonicalByDevice.get("dev_door_sensor")).toBe("reg_door_battery");
  });

  it("prefers the _battery suffix, then the shortest id, then the lowest registry id", () => {
    const candidates = [
      normalizeEntity({
        entity_id: "sensor.hub_pack_two_charge",
        id: "reg_b",
        device_id: "dev_hub",
        original_device_class: "battery",
        unit_of_measurement: "%",
      }),
      normalizeEntity({
        entity_id: "sensor.hub_pack_battery",
        id: "reg_a",
        device_id: "dev_hub",
        original_device_class: "battery",
        unit_of_measurement: "%",
      }),
    ];
    const selection = selectCanonicalBatteryEntities(candidates, [], undefined);
    expect(selection.canonicalByDevice.get("dev_hub")).toBe("reg_a");

    const tie = [
      normalizeEntity({
        entity_id: "sensor.hub_two_battery",
        id: "reg_z",
        device_id: "dev_tie",
        original_device_class: "battery",
        unit_of_measurement: "%",
      }),
      normalizeEntity({
        entity_id: "sensor.hub_one_battery",
        id: "reg_a",
        device_id: "dev_tie",
        original_device_class: "battery",
        unit_of_measurement: "%",
      }),
    ];
    // Same length, both end in _battery: the lowest registry id breaks the tie deterministically.
    expect(selectCanonicalBatteryEntities(tie, []).canonicalByDevice.get("dev_tie")).toBe("reg_a");
  });

  it("prefers a candidate with a numeric state over one that is merely unavailable", () => {
    const candidates = [
      normalizeEntity({
        entity_id: "sensor.hub_battery",
        id: "reg_unavailable",
        device_id: "dev_hub",
        original_device_class: "battery",
        unit_of_measurement: "%",
      }),
      normalizeEntity({
        entity_id: "sensor.hub_pack_battery",
        id: "reg_numeric",
        device_id: "dev_hub",
        original_device_class: "battery",
        unit_of_measurement: "%",
      }),
    ];
    const stateMap = indexStates([
      { entity_id: "sensor.hub_battery", state: "unavailable", attributes: {} },
      { entity_id: "sensor.hub_pack_battery", state: "77", attributes: {} },
    ]);
    const selection = selectCanonicalBatteryEntities(candidates, stateMap);
    expect(selection.canonicalByDevice.get("dev_hub")).toBe("reg_numeric");
  });

  it("hard-excludes a mislabelled entity whose state is a real non-numeric value", () => {
    const candidates = [
      normalizeEntity({
        entity_id: "sensor.weird_battery",
        id: "reg_weird",
        device_id: "dev_weird",
        original_device_class: "battery",
        unit_of_measurement: "%",
      }),
    ];
    const stateMap = indexStates([
      { entity_id: "sensor.weird_battery", state: "AAA", attributes: {} },
    ]);
    const selection = selectCanonicalBatteryEntities(candidates, stateMap);
    expect(selection.canonicalByDevice.has("dev_weird")).toBe(false);
    expect(selection.rejected).toEqual([
      { entity: candidates[0], reason: "non_numeric_state" },
    ]);
  });

  it("skips disabled and hidden entities", () => {
    const candidates = [
      normalizeEntity({
        entity_id: "sensor.disabled_battery",
        id: "reg_disabled",
        device_id: "dev_d",
        original_device_class: "battery",
        unit_of_measurement: "%",
        disabled_by: "integration",
      }),
    ];
    const selection = selectCanonicalBatteryEntities(candidates, []);
    expect(selection.canonicalByDevice.size).toBe(0);
    expect(selection.rejected[0]?.reason).toBe("disabled_or_hidden");
  });
});

describe("classifyBatteryReading", () => {
  const now = SAMPLE_NOW_MS;
  const fresh = now - 60_000;

  it("never yields a value for unknown, unavailable or a battery-type string", () => {
    for (const [raw, reason] of [
      ["unknown", "unknown"],
      ["unavailable", "unavailable"],
      ["none", "unknown"],
      ["", "empty"],
      ["AAA", "non_numeric"],
    ] as const) {
      const reading = classifyBatteryReading(raw, fresh, now, 24);
      expect(reading.valid).toBe(false);
      expect(reading.value).toBeUndefined();
      expect(reading.invalidReason).toBe(reason);
    }
    expect(classifyBatteryReading(null, fresh, now, 24)).toMatchObject({
      valid: false,
      invalidReason: "empty",
    });
  });

  it("accepts a numeric percentage", () => {
    expect(classifyBatteryReading("68", fresh, now, 24)).toEqual({
      valid: true,
      value: 68,
      stale: false,
    });
    expect(classifyBatteryReading(" 12.5 ", fresh, now, 24)).toMatchObject({
      valid: true,
      value: 12.5,
    });
    // 0 % is a real reading and must survive; the rule is only that *invalid* is never 0.
    expect(classifyBatteryReading("0", fresh, now, 24)).toMatchObject({ valid: true, value: 0 });
  });

  it("rejects impossible percentages instead of clamping them", () => {
    expect(classifyBatteryReading("140", fresh, now, 24)).toMatchObject({
      valid: false,
      invalidReason: "out_of_range",
    });
    expect(classifyBatteryReading("-5", fresh, now, 24)).toMatchObject({
      valid: false,
      invalidReason: "out_of_range",
    });
  });

  it("marks a reading stale past the threshold, and when the timestamp is missing", () => {
    expect(classifyBatteryReading("68", now - 25 * 3_600_000, now, 24).stale).toBe(true);
    expect(classifyBatteryReading("68", now - 23 * 3_600_000, now, 24).stale).toBe(false);
    expect(classifyBatteryReading("68", null, now, 24).stale).toBe(true);
  });
});
