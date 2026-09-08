/**
 * Registry liveness: which entities Home Assistant is actually providing, recorded for **every**
 * registry entity rather than only the cached ones.
 *
 * Why it exists: HA keeps registry entries whose integration no longer provides them (`restored`),
 * so the import browser listed devices that do not exist any more — 16 such devices out of 483 on
 * the household this was measured against. A registry row says nothing about liveness on its own,
 * and `ha_entity_state` only caches the entities something is already linked to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `src/server/queries/**` carries the `server-only` guard, which throws outside a server
// component. The same stub the other query tests use.
vi.mock("server-only", () => ({}));

import type { DbHandle } from "@/db/client";
import { applyRegistryList, applySnapshot } from "@/server/ha/registryCache";
import { browseRegistry, livenessOf } from "@/server/queries/ha/registry";
import { buildSampleRegistry, type FakeRegistry } from "../../helpers/fakeHa";
import { testDb } from "../../helpers/db";
import { T0, one, rows, snapshotOf } from "./fixtures";

interface LivenessRow {
  registry_id: string;
  entity_id: string;
  live_state: string | null;
  live_restored: number | null;
  live_at_ms: number | null;
}

const ALL = "SELECT registry_id, entity_id, live_state, live_restored, live_at_ms FROM ha_entity";
const BY_ID = `${ALL} WHERE registry_id = ?`;

/** `livenessOf` takes the camelCase row shape the query layer selects. */
const classify = (row: LivenessRow) =>
  livenessOf({
    liveState: row.live_state,
    liveRestored: row.live_restored === null ? null : row.live_restored === 1,
    liveAtMs: row.live_at_ms,
  });

/** Rewrite one entity's state so it looks like a leftover registry entry. */
function makeRestored(registry: FakeRegistry, entityId: string): void {
  const state = registry.states.get(entityId);
  if (!state) return;
  registry.states.set(entityId, {
    ...state,
    state: "unavailable",
    attributes: { ...state.attributes, restored: true },
  });
}

describe("registry liveness", () => {
  let handle: DbHandle;
  let registry: FakeRegistry;

  beforeEach(() => {
    handle = testDb();
    registry = buildSampleRegistry();
  });

  afterEach(() => {
    handle.close();
  });

  it("measures every entity in the snapshot, linked or not", () => {
    applySnapshot(handle, snapshotOf(registry), T0);

    const stored = rows<LivenessRow>(handle, ALL);
    expect(stored.length).toBe(registry.entities.length);
    expect(stored.every((row) => row.live_at_ms === T0)).toBe(true);
    // The state cache holds only the interesting ones, so this is strictly more coverage.
    expect(stored.filter((row) => classify(row) === "live").length).toBeGreaterThan(0);
  });

  it("flags an entity Home Assistant only has a registry entry for", () => {
    const first = registry.entities[0]!;
    makeRestored(registry, first.entity_id);

    applySnapshot(handle, snapshotOf(registry), T0);

    const row = one<LivenessRow>(handle, BY_ID, first.id)!;
    expect(row.live_restored).toBe(1);
    expect(classify(row)).toBe("restored");
  });

  it("treats an entity with no state object as dead, not as unmeasured", () => {
    const first = registry.entities[0]!;
    registry.states.delete(first.entity_id);

    applySnapshot(handle, snapshotOf(registry), T0);

    const row = one<LivenessRow>(handle, BY_ID, first.id)!;
    expect(row.live_state).toBeNull();
    expect(row.live_at_ms).toBe(T0);
    expect(classify(row)).toBe("no_state");
  });

  it("leaves liveness alone on a registry-only re-list, which carries no states", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    applyRegistryList(handle, "entity", registry.entities, T0 + 60_000);

    // Still the snapshot's stamp: "we did not look" must not read as "it is dead".
    expect(rows<LivenessRow>(handle, ALL).every((row) => row.live_at_ms === T0)).toBe(true);
  });

  it("claims nothing before a snapshot has measured it", () => {
    applyRegistryList(handle, "entity", registry.entities, T0);

    const stored = rows<LivenessRow>(handle, ALL);
    expect(stored.every((row) => row.live_at_ms === null)).toBe(true);
    expect(stored.every((row) => classify(row) === null)).toBe(true);
  });
});

describe("browseRegistry liveness filter", () => {
  let handle: DbHandle;
  let registry: FakeRegistry;

  beforeEach(() => {
    handle = testDb();
    registry = buildSampleRegistry();
  });

  afterEach(() => {
    handle.close();
  });

  const devicesIn = (result: ReturnType<typeof browseRegistry>) =>
    result.groups.flatMap((floor) => floor.areas.flatMap((area) => area.devices));

  it("hides a device once nothing it exposes is live, and says how many it hid", () => {
    for (const entityId of [...registry.states.keys()]) makeRestored(registry, entityId);
    applySnapshot(handle, snapshotOf(registry), T0);

    const hidden = browseRegistry(handle.db, { includeHidden: false, query: "" });
    expect(hidden.deadDeviceCount).toBeGreaterThan(0);
    // Nothing left on screen has a live entity to justify it.
    expect(devicesIn(hidden).filter((device) => device.liveEntityCount > 0)).toHaveLength(0);

    // The escape hatch, for hardware that is only temporarily offline.
    const shown = browseRegistry(handle.db, { includeHidden: false, query: "", hideDead: false });
    expect(devicesIn(shown).length).toBeGreaterThan(devicesIn(hidden).length);
    expect(shown.deadDeviceCount).toBe(0);
  });

  it("keeps a device that still has one live entity, and counts the dead ones", () => {
    const target = registry.entities.find((entity) => entity.device_id !== null)!;
    const siblings = registry.entities.filter((e) => e.device_id === target.device_id);
    makeRestored(registry, target.entity_id);
    applySnapshot(handle, snapshotOf(registry), T0);

    const result = browseRegistry(handle.db, { includeHidden: false, query: "" });
    const device = devicesIn(result).find((d) => d.deviceId === target.device_id);

    // Only meaningful when the device has another entity to keep it alive.
    if (siblings.length > 1 && device) {
      expect(device.deadEntityCount).toBeGreaterThan(0);
      expect(device.liveEntityCount).toBeGreaterThan(0);
      expect(device.livenessUnmeasured).toBe(false);
    }
    expect(result.deadDeviceCount).toBe(0);
  });

  it("hides nothing when liveness has never been measured", () => {
    applyRegistryList(handle, "device", registry.devices, T0);
    applyRegistryList(handle, "entity", registry.entities, T0);

    const result = browseRegistry(handle.db, { includeHidden: false, query: "" });
    expect(result.deadDeviceCount).toBe(0);
    // Only devices that have something to measure can be "unmeasured"; one with no visible
    // entities is a separate case the flag deliberately does not claim.
    const measurable = devicesIn(result).filter((device) => device.visibleEntityCount > 0);
    expect(measurable.length).toBeGreaterThan(0);
    expect(measurable.every((device) => device.livenessUnmeasured)).toBe(true);
  });
});
