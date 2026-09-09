/**
 * The two counters the import browser's toggles describe themselves with.
 *
 * They are separate numbers because the remedies are different: a device hidden for exposing only
 * disabled/hidden entities is a filter preference, while a device hidden for exposing
 * nothing live is a stale registry entry to clean up in Home Assistant, or hardware that is
 * currently offline. Counting a dead device as both made the first toggle claim the second one's
 * devices when most of them were stale instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// `src/server/queries/**` carries the `server-only` guard, which throws outside a server component.
vi.mock("server-only", () => ({}));

import { writeTx, type DbHandle } from "@/db/client";
import { haDevice, haEntity } from "@/db/schema";
import { applyRegistryList, applySnapshot } from "@/server/ha/registryCache";
import {
  browseRegistry,
  listLinkableEntities,
  readDeviceEntities,
} from "@/server/queries/ha/registry";
import { buildSampleRegistry, type FakeRegistry } from "../../helpers/fakeHa";
import { testDb } from "../../helpers/db";
import { T0, snapshotOf } from "./fixtures";

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

let handle: DbHandle;
let registry: FakeRegistry;

beforeEach(() => {
  handle = testDb();
  registry = buildSampleRegistry();
});

afterEach(() => {
  handle.close();
});

describe("browseRegistry counters", () => {
  it("counts a device dropped for having nothing live only once, as dead", () => {
    for (const entityId of [...registry.states.keys()]) makeRestored(registry, entityId);
    applySnapshot(handle, snapshotOf(registry), T0);

    const withDeadHidden = browseRegistry(handle.db, { includeHidden: false, query: "" });
    const withDeadShown = browseRegistry(handle.db, {
      includeHidden: false,
      query: "",
      hideDead: false,
    });

    expect(withDeadHidden.deadDeviceCount).toBeGreaterThan(0);
    // The number the disabled/hidden toggle reports must not move when the *other*
    // filter hides something: it is the same set of devices either way.
    expect(withDeadHidden.hiddenDeviceCount).toBe(withDeadShown.hiddenDeviceCount);
  });

  it("reports liveness as unmeasured after a registry-only sync", () => {
    applyRegistryList(handle, "device", registry.devices, T0);
    applyRegistryList(handle, "entity", registry.entities, T0);

    const result = browseRegistry(handle.db, { includeHidden: false, query: "" });

    // Nothing has been hidden, but nothing has been *checked* either — so "every device listed has
    // at least one live entity" is a claim about a measurement that has not happened (rule 8).
    expect(result.deadDeviceCount).toBe(0);
    expect(result.livenessUnmeasured).toBe(true);
  });

  it("stops reporting liveness as unmeasured once a snapshot has measured it", () => {
    applySnapshot(handle, snapshotOf(registry), T0);

    const result = browseRegistry(handle.db, { includeHidden: false, query: "" });
    expect(result.livenessUnmeasured).toBe(false);
  });

  it("reports an empty cache as unmeasured rather than as healthy", () => {
    const result = browseRegistry(handle.db, { includeHidden: false, query: "" });
    expect(result.cacheEmpty).toBe(true);
    expect(result.livenessUnmeasured).toBe(true);
  });

  it("shows a device whose only entities are diagnostic and offers those entities for linking", () => {
    applySnapshot(handle, snapshotOf(registry), T0);

    const result = browseRegistry(handle.db, { includeHidden: false, query: "Lucas iPhone" });
    const devices = result.groups.flatMap((floor) =>
      floor.areas.flatMap((area) => area.devices),
    );

    expect(devices.map((device) => device.deviceId)).toContain("dev_lucas_iphone");
    expect(
      readDeviceEntities(handle.db, "dev_lucas_iphone", { includeHidden: false }).map(
        (entity) => entity.registryId,
      ),
    ).toContain("reg_lucas_battery_level");
    expect(listLinkableEntities(handle.db).entities.map((entity) => entity.registryId)).toContain(
      "reg_lucas_battery_level",
    );
  });

  it("still excludes disabled diagnostic entities by default", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    writeTx(handle.db, (tx) => {
      tx.update(haEntity)
        .set({ disabledBy: "integration" })
        .where(eq(haEntity.registryId, "reg_lucas_battery_level"))
        .run();
    });

    expect(
      readDeviceEntities(handle.db, "dev_lucas_iphone", { includeHidden: false }).map(
        (entity) => entity.registryId,
      ),
    ).not.toContain("reg_lucas_battery_level");
    expect(
      readDeviceEntities(handle.db, "dev_lucas_iphone", { includeHidden: true }).map(
        (entity) => entity.registryId,
      ),
    ).toContain("reg_lucas_battery_level");
    expect(
      listLinkableEntities(handle.db).entities.map((entity) => entity.registryId),
    ).not.toContain("reg_lucas_battery_level");
  });

  it("excludes enabled entities of a disabled device by default", () => {
    applySnapshot(handle, snapshotOf(registry), T0);
    writeTx(handle.db, (tx) => {
      tx.update(haDevice)
        .set({ disabledBy: "user" })
        .where(eq(haDevice.deviceId, "dev_lucas_iphone"))
        .run();
    });

    expect(
      readDeviceEntities(handle.db, "dev_lucas_iphone", { includeHidden: false }),
    ).toEqual([]);
    expect(
      readDeviceEntities(handle.db, "dev_lucas_iphone", { includeHidden: true }).map(
        (entity) => entity.registryId,
      ),
    ).toContain("reg_lucas_battery_level");
    expect(
      listLinkableEntities(handle.db).entities.map((entity) => entity.registryId),
    ).not.toContain("reg_lucas_battery_level");
    expect(
      listLinkableEntities(handle.db, { includeHidden: true }).entities.map(
        (entity) => entity.registryId,
      ),
    ).toContain("reg_lucas_battery_level");
  });
});
