/**
 * The registry cache against the sample household registry.
 *
 * The four behaviours that actually protect data: a rename must not break a link, a removal must
 * be visible rather than silent, the same registry id coming back must resurrect its row, and the
 * canonical battery entity must be the `%` one and not the `AAA` battery-type sensor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@/db/client";
import {
  applyRegistryList,
  applyRegistryLists,
  applySnapshot,
  normaliseName,
  suggestLocationMappings,
} from "@/server/ha/registryCache";
import { applyStates } from "@/server/ha/stateCache";
import { buildSampleRegistry, type FakeRegistry } from "../../helpers/fakeHa";
import { testDb } from "../../helpers/db";
import {
  T0,
  linkDevice,
  linkEntity,
  one,
  rows,
  seedAsset,
  seedLocations,
  snapshotOf,
} from "./fixtures";

const DOOR_BATTERY = "reg_door_battery";
const DOOR_CONTACT = "reg_door_contact";

describe("registry cache", () => {
  let handle: DbHandle;
  let registry: FakeRegistry;

  beforeEach(() => {
    handle = testDb();
    registry = buildSampleRegistry();
  });

  afterEach(() => {
    handle.close();
  });

  it("persists a first snapshot with counts matching the registry", () => {
    const result = applySnapshot(handle, snapshotOf(registry), T0);

    expect(result.floorsSeen).toBe(registry.floors.length);
    expect(result.areasSeen).toBe(registry.areas.length);
    expect(result.devicesSeen).toBe(registry.devices.length);
    expect(result.entitiesSeen).toBe(registry.entities.length);
    expect(result.additionsDetected).toBe(
      registry.floors.length + registry.areas.length + registry.devices.length + registry.entities.length,
    );
    expect(result.removalsDetected).toBe(0);
    expect(result.renamesDetected).toBe(0);

    expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_entity`)?.n).toBe(
      registry.entities.length,
    );
    expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_device`)?.n).toBe(
      registry.devices.length,
    );

    const run = one<{ status: string; entities_seen: number; finished_at_ms: number }>(
      handle,
      `SELECT status, entities_seen, finished_at_ms FROM ha_sync_run`,
    );
    expect(run?.status).toBe("ok");
    expect(run?.entities_seen).toBe(registry.entities.length);
    expect(run?.finished_at_ms).toBe(T0);
  });

  it("keeps the registry graph intact: areas on floors, entities on devices", () => {
    applySnapshot(handle, snapshotOf(registry), T0);

    expect(
      one<{ floor_id: string }>(handle, `SELECT floor_id FROM ha_area WHERE area_id = 'kitchen'`)
        ?.floor_id,
    ).toBe("ground");
    expect(
      one<{ device_id: string }>(
        handle,
        `SELECT device_id FROM ha_entity WHERE registry_id = ?`,
        DOOR_CONTACT,
      )?.device_id,
    ).toBe("dev_door_sensor");
    // The Zigbee coordinator is a `service` device and the door sensor hangs off it.
    expect(
      one<{ via_device_id: string }>(
        handle,
        `SELECT via_device_id FROM ha_device WHERE device_id = 'dev_door_sensor'`,
      )?.via_device_id,
    ).toBe("dev_zigbee_coordinator");
    expect(
      one<{ entry_type: string }>(
        handle,
        `SELECT entry_type FROM ha_device WHERE device_id = 'dev_zigbee_coordinator'`,
      )?.entry_type,
    ).toBe("service");
  });

  it("is idempotent: a second identical snapshot changes nothing and detects nothing", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    const again = applySnapshot(handle, snapshotOf(registry), T0 + 60_000);

    expect(again.additionsDetected).toBe(0);
    expect(again.removalsDetected).toBe(0);
    expect(again.renamesDetected).toBe(0);
    expect(again.canonicalBatteryChanges).toBe(0);
    expect(
      one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_entity WHERE removed_at_ms IS NOT NULL`)
        ?.n,
    ).toBe(0);
  });

  it("picks the % battery entity as canonical, never the type or voltage sensor", () => {
    applySnapshot(handle, snapshotOf(registry), T0);

    expect(
      one<{ canonical_battery_entity_id: string }>(
        handle,
        `SELECT canonical_battery_entity_id FROM ha_device WHERE device_id = 'dev_door_sensor'`,
      )?.canonical_battery_entity_id,
    ).toBe(DOOR_BATTERY);

    // The ventilation unit reports fan speeds in '%' but has no battery: it must stay unset.
    expect(
      one<{ canonical_battery_entity_id: string | null }>(
        handle,
        `SELECT canonical_battery_entity_id FROM ha_device WHERE device_id = 'dev_parmair'`,
      )?.canonical_battery_entity_id,
    ).toBeNull();

    const audits = rows<{ entity_id: string; changes_json: string }>(
      handle,
      `SELECT entity_id, changes_json FROM audit_log WHERE entity_table = 'ha_device'`,
    );
    expect(audits.map((row) => row.entity_id).sort()).toEqual([
      "dev_door_sensor",
      "dev_lucas_iphone",
      "dev_marja_iphone",
    ]);
    expect(JSON.parse(audits.find((row) => row.entity_id === "dev_door_sensor")!.changes_json)).toEqual(
      { canonical_battery_entity_id: [null, DOOR_BATTERY] },
    );
  });

  it("lets a manual battery_level link override the automatic pick", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    // Deliberately pin the voltage sensor: an override wins even against the exclusion rules.
    linkEntity(handle, {
      assetId,
      registryId: "reg_door_battery_voltage",
      entityIdSnapshot: "sensor.bedroom_door_sensor_battery_voltage",
      role: "battery_level",
    });

    const result = applySnapshot(handle, snapshotOf(registry), T0 + 1_000);

    expect(result.canonicalBatteryChanges).toBe(1);
    expect(
      one<{ canonical_battery_entity_id: string }>(
        handle,
        `SELECT canonical_battery_entity_id FROM ha_device WHERE device_id = 'dev_door_sensor'`,
      )?.canonical_battery_entity_id,
    ).toBe("reg_door_battery_voltage");
  });

  it("records a rename, refreshes the link snapshot, keeps the link active and raises an info alert", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    const linkId = linkEntity(handle, {
      assetId,
      registryId: DOOR_CONTACT,
      entityIdSnapshot: "binary_sensor.bedroom_door_sensor_contact",
    });

    registry.entities.find((entry) => entry.id === DOOR_CONTACT)!.entity_id =
      "binary_sensor.bedroom_door_contact";
    const result = applySnapshot(handle, snapshotOf(registry), T0 + 5_000);

    expect(result.renamesDetected).toBe(1);
    expect(result.removalsDetected).toBe(0);
    expect(result.additionsDetected).toBe(0);

    const rename = one<{ old_entity_id: string; new_entity_id: string; source: string }>(
      handle,
      `SELECT old_entity_id, new_entity_id, source FROM ha_entity_rename WHERE registry_id = ?`,
      DOOR_CONTACT,
    );
    expect(rename).toEqual({
      old_entity_id: "binary_sensor.bedroom_door_sensor_contact",
      new_entity_id: "binary_sensor.bedroom_door_contact",
      source: "registry_sync",
    });

    const link = one<{ link_state: string; entity_id_snapshot: string }>(
      handle,
      `SELECT link_state, entity_id_snapshot FROM asset_ha_link WHERE id = ?`,
      linkId,
    );
    // Nothing breaks: the FK is the registry id. Only the informational snapshot moves.
    expect(link).toEqual({
      link_state: "active",
      entity_id_snapshot: "binary_sensor.bedroom_door_contact",
    });

    const alert = one<{ kind: string; severity: string }>(
      handle,
      `SELECT kind, severity FROM app_alert WHERE kind = 'ha_entity_renamed'`,
    );
    expect(alert).toEqual({ kind: "ha_entity_renamed", severity: "info" });
  });

  it("flags links missing and warns when an entity disappears", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    const linkId = linkEntity(handle, {
      assetId,
      registryId: DOOR_CONTACT,
      entityIdSnapshot: "binary_sensor.bedroom_door_sensor_contact",
    });

    registry.entities = registry.entities.filter((entry) => entry.id !== DOOR_CONTACT);
    const result = applySnapshot(handle, snapshotOf(registry), T0 + 5_000);

    expect(result.removalsDetected).toBe(1);
    expect(result.linksMarkedMissing).toBe(1);

    // Soft delete, never a hard delete: the link still points at this row.
    expect(
      one<{ removed_at_ms: number }>(
        handle,
        `SELECT removed_at_ms FROM ha_entity WHERE registry_id = ?`,
        DOOR_CONTACT,
      )?.removed_at_ms,
    ).toBe(T0 + 5_000);

    expect(
      one<{ link_state: string }>(handle, `SELECT link_state FROM asset_ha_link WHERE id = ?`, linkId)
        ?.link_state,
    ).toBe("missing");

    const alert = one<{ kind: string; severity: string; title: string }>(
      handle,
      `SELECT kind, severity, title FROM app_alert WHERE kind = 'ha_link_missing'`,
    );
    expect(alert?.severity).toBe("warning");
    expect(alert?.title).toContain("Bedroom door sensor");
  });

  it("re-raising a removal bumps seen_count instead of adding rows", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    linkEntity(handle, {
      assetId,
      registryId: DOOR_CONTACT,
      entityIdSnapshot: "binary_sensor.bedroom_door_sensor_contact",
    });
    registry.entities = registry.entities.filter((entry) => entry.id !== DOOR_CONTACT);

    applySnapshot(handle, snapshotOf(registry), T0 + 5_000);
    // A link already `missing` is not re-flagged, so the alert stays at one row and one sighting.
    applySnapshot(handle, snapshotOf(registry), T0 + 10_000);

    const alerts = rows<{ seen_count: number }>(
      handle,
      `SELECT seen_count FROM app_alert WHERE kind = 'ha_link_missing'`,
    );
    expect(alerts).toHaveLength(1);
  });

  it("resurrects the row and reactivates the link when the same registry id comes back", () => {
    const full = buildSampleRegistry();
    applySnapshot(handle, snapshotOf(registry), T0);
    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    const linkId = linkEntity(handle, {
      assetId,
      registryId: DOOR_CONTACT,
      entityIdSnapshot: "binary_sensor.bedroom_door_sensor_contact",
    });

    registry.entities = registry.entities.filter((entry) => entry.id !== DOOR_CONTACT);
    applySnapshot(handle, snapshotOf(registry), T0 + 5_000);

    registry.entities = full.entities;
    const result = applySnapshot(handle, snapshotOf(registry), T0 + 10_000);

    expect(result.resurrectionsDetected).toBe(1);
    expect(
      one<{ removed_at_ms: number | null }>(
        handle,
        `SELECT removed_at_ms FROM ha_entity WHERE registry_id = ?`,
        DOOR_CONTACT,
      )?.removed_at_ms,
    ).toBeNull();
    expect(
      one<{ link_state: string }>(handle, `SELECT link_state FROM asset_ha_link WHERE id = ?`, linkId)
        ?.link_state,
    ).toBe("active");
    expect(
      one<{ resolved_at_ms: number | null }>(
        handle,
        `SELECT resolved_at_ms FROM app_alert WHERE kind = 'ha_link_missing'`,
      )?.resolved_at_ms,
    ).toBe(T0 + 10_000);
  });

  it("flags device links missing when the device disappears", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    const assetId = seedAsset(handle, { name: "House ventilation" });
    const linkId = linkDevice(handle, { assetId, deviceId: "dev_parmair_filter" });

    registry.devices = registry.devices.filter((entry) => entry.id !== "dev_parmair_filter");
    registry.entities = registry.entities.filter((entry) => entry.id !== "reg_hrv_filter_days");
    applySnapshot(handle, snapshotOf(registry), T0 + 5_000);

    expect(
      one<{ link_state: string }>(handle, `SELECT link_state FROM asset_ha_link WHERE id = ?`, linkId)
        ?.link_state,
    ).toBe("missing");
  });

  it("applyRegistryList refreshes a single registry and writes its own sync run", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    // The state cache is what battery selection reads on a registry-only refresh.
    applyStates(handle, [...registry.states.values()], T0, { onlyInteresting: true });

    registry.entities.find((entry) => entry.id === DOOR_BATTERY)!.entity_id =
      "sensor.bedroom_door_battery";
    const result = applyRegistryList(handle, "entity", registry.entities, T0 + 1_000);

    expect(result.renamesDetected).toBe(1);
    expect(result.entitiesSeen).toBe(registry.entities.length);
    expect(
      one<{ entity_id: string }>(
        handle,
        `SELECT entity_id FROM ha_entity WHERE registry_id = ?`,
        DOOR_BATTERY,
      )?.entity_id,
    ).toBe("sensor.bedroom_door_battery");
    // Selection survives the rename because it is keyed on the registry id.
    expect(
      one<{ canonical_battery_entity_id: string }>(
        handle,
        `SELECT canonical_battery_entity_id FROM ha_device WHERE device_id = 'dev_door_sensor'`,
      )?.canonical_battery_entity_id,
    ).toBe(DOOR_BATTERY);
    expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_sync_run`)?.n).toBe(2);
  });

  it("applyRegistryLists applies all four registries in one run row", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    applyStates(handle, [...registry.states.values()], T0, { onlyInteresting: true });

    const result = applyRegistryLists(
      handle,
      {
        entities: registry.entities,
        devices: registry.devices,
        areas: registry.areas,
        floors: registry.floors,
      },
      T0 + 3_600_000,
    );

    expect(result.additionsDetected).toBe(0);
    expect(result.canonicalBatteryChanges).toBe(0);
    expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_sync_run`)?.n).toBe(2);
  });
});

describe("location mapping suggestions", () => {
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

  it("normalises names for matching", () => {
    expect(normaliseName("Technical Room")).toBe("technical room");
    expect(normaliseName("basement-technical-room")).toBe("basement technical room");
    expect(normaliseName("Kylmä­varasto")).toBe("kylma varasto");
  });

  it("suggests exact normalised name matches and never confirms them", () => {
    const locations = seedLocations(handle);
    const suggestions = suggestLocationMappings(handle, T0 + 1_000);

    expect(
      suggestions.map((suggestion) => [suggestion.haKind, suggestion.haId, suggestion.locationId]),
    ).toEqual(
      expect.arrayContaining([
        ["area", "kitchen", locations.kitchen],
        ["area", "technical_room", locations.technicalRoom],
        ["floor", "basement", locations.basement],
        ["floor", "ground", locations.ground],
      ]),
    );

    const stored = rows<{ ha_kind: string; ha_id: string; source: string; confidence: number }>(
      handle,
      `SELECT ha_kind, ha_id, source, confidence FROM location_mapping ORDER BY ha_kind, ha_id`,
    );
    expect(stored.every((row) => row.source === "suggested")).toBe(true);
    expect(stored.every((row) => row.confidence === 1)).toBe(true);
    // 'Bedroom' and 'First floor' have no location with that name.
    expect(stored.map((row) => row.ha_id)).toEqual([
      "kitchen",
      "technical_room",
      "basement",
      "ground",
    ]);
  });

  it("leaves an existing decision alone, including a rejection", () => {
    const locations = seedLocations(handle);
    handle.sqlite
      .prepare(
        `INSERT INTO location_mapping
           (id, ha_kind, ha_id, location_id, source, match_reason, created_at_ms, updated_at_ms)
         VALUES ('m1', 'area', 'kitchen', ?, 'rejected', 'manual', ?, ?)`,
      )
      .run(locations.technicalRoom, T0, T0);

    const suggestions = suggestLocationMappings(handle, T0 + 1_000);
    expect(suggestions.some((suggestion) => suggestion.haId === "kitchen")).toBe(false);
    expect(
      one<{ source: string }>(
        handle,
        `SELECT source FROM location_mapping WHERE ha_kind = 'area' AND ha_id = 'kitchen'`,
      )?.source,
    ).toBe("rejected");
  });

  it("does not guess when two locations share a name", () => {
    handle.sqlite
      .prepare(
        `INSERT INTO location_mapping (id, ha_kind, ha_id, location_id, source, created_at_ms, updated_at_ms)
         SELECT 'noop', 'area', '__none__', id, 'suggested', ?, ? FROM location LIMIT 0`,
      )
      .run(T0, T0);

    const propertyId = "loc-property";
    handle.sqlite
      .prepare(
        `INSERT INTO location (id, kind, parent_id, name, slug, sort_order, is_outdoor,
                               needs_reconciliation, created_at_ms, updated_at_ms)
         VALUES (?, 'property', NULL, 'Home', 'home', 0, 0, 0, ?, ?)`,
      )
      .run(propertyId, T0, T0);
    for (const [index, id] of ["loc-kitchen-a", "loc-kitchen-b"].entries()) {
      handle.sqlite
        .prepare(
          `INSERT INTO location (id, kind, parent_id, name, slug, sort_order, is_outdoor,
                                 needs_reconciliation, created_at_ms, updated_at_ms)
           VALUES (?, 'room', ?, 'Kitchen', ?, 0, 0, 0, ?, ?)`,
        )
        .run(id, propertyId, `kitchen-${index}`, T0, T0);
    }

    const suggestions = suggestLocationMappings(handle, T0 + 1_000);
    expect(suggestions.some((suggestion) => suggestion.haId === "kitchen")).toBe(false);
  });

  it("does nothing when there are no locations yet", () => {
    expect(suggestLocationMappings(handle, T0 + 1_000)).toEqual([]);
    expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM location_mapping`)?.n).toBe(0);
  });
});
