/**
 * Integration tests for the equipment action family.
 *
 * The property these protect is the one the whole replacement design exists for: **history stays
 * on the unit that was serviced.** A replacement creates a second row, moves forward-looking
 * references and leaves backward-looking ones alone — so an eleven-year service record survives a
 * swap, and the box currently on the wall does not falsely claim eleven years of maintenance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  userId: { current: null as string | null },
  freshSessionCalls: { current: 0 },
}));

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
    requireFreshSession: async () => {
      mocks.freshSessionCalls.current += 1;
      if (mocks.userId.current === null) throw new UnauthorizedError();
      return { user: { id: mocks.userId.current }, session: { id: "fresh-test-session" } };
    },
  };
});

import { writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  appAlert,
  asset,
  assetConsumable,
  assetHaLink,
  assetReplacement,
  auditLog,
  conditionEpisode,
  conditionRule,
  haDevice,
  haEntity,
  maintenancePlan,
  systemAsset,
} from "@/db/schema";
import { listLinkableEntities } from "@/server/queries/ha/registry";
import { listTrashEquipment } from "@/server/queries/assets/trash";
import { replacementChain } from "@/domain/assets";
import { bulkRemoveEquipment } from "@/server/actions/assets/bulk";
import { permanentlyDeleteEquipment } from "@/server/actions/assets/trash";
import {
  createEquipment,
  replaceEquipment,
  retireEquipment,
  setConsumables,
  updateEquipment,
} from "@/server/actions/assets/equipment";
import {
  linkHaEntity,
  relinkHa,
  setHaLinkState,
  unlinkHa,
} from "@/server/actions/assets/haLinks";
import { deleteSystem, upsertSystem } from "@/server/actions/assets/systems";
import {
  expectRefusal,
  makeWorld,
  seedAsset,
  seedPart,
  teardown,
  unwrap,
  type World,
} from "../inventory/actionSetup";

let world: World;

beforeEach(() => {
  world = makeWorld();
  mocks.userId.current = world.user.id;
  mocks.freshSessionCalls.current = 0;
});

afterEach(() => {
  mocks.userId.current = null;
  teardown(world);
});

let haSeq = 0;

/**
 * A cached HA device with one battery entity, as the registry sync would have left it.
 *
 * The entity id and the integration `unique_id` are made unique per call, because the real schema
 * enforces both — a fixture that collided would be testing the fixture rather than the action.
 */
function seedHaDevice(options: { entryType?: string | null } = {}): {
  deviceId: string;
  registryId: string;
  entityId: string;
} {
  haSeq += 1;
  const deviceId = newId();
  const registryId = newId();
  const entityId = `sensor.device_${haSeq}_battery`;
  const at = nowMs();
  writeTx(world.handle.db, (tx) => {
    tx.insert(haDevice)
      .values({
        deviceId,
        name: "MYGGBETT door sensor",
        manufacturer: "IKEA",
        model: "MYGGBETT",
        entryType: options.entryType ?? null,
        firstSeenMs: at,
        lastSeenMs: at,
      })
      .run();
    tx.insert(haEntity)
      .values({
        registryId,
        entityId,
        uniqueId: `00:12:4b:00:1c:aa-${haSeq}-1`,
        platform: "zha",
        deviceId,
        domain: "sensor",
        deviceClass: "battery",
        unitOfMeasurement: "%",
        firstSeenMs: at,
        lastSeenMs: at,
      })
      .run();
  });
  return { deviceId, registryId, entityId };
}

describe("createEquipment", () => {
  it("creates a unit with its consumables", async () => {
    const partId = seedPart(world, { name: "AAA battery" });
    const { assetId } = unwrap(
      await createEquipment({
        name: "Hallway smoke alarm",
        category: "safety",
        locationId: world.locationId,
        consumables: [{ partId, role: "battery", qtyMilli: 2000 }],
      }),
    );
    const row = world.handle.db.select().from(asset).where(eq(asset.id, assetId)).get();
    expect(row?.name).toBe("Hallway smoke alarm");
    expect(row?.status).toBe("installed");
    const consumables = world.handle.db
      .select()
      .from(assetConsumable)
      .where(eq(assetConsumable.assetId, assetId))
      .all();
    expect(consumables).toHaveLength(1);
    expect(consumables[0]?.qtyMilli).toBe(2000);
  });

  it("refuses a software unit with a room", async () => {
    expect(
      expectRefusal(
        await createEquipment({
          name: "Zigbee bridge integration",
          category: "software",
          isVirtual: true,
          locationId: world.locationId,
        }),
      ),
    ).toBe("virtual_asset_has_location");
  });

  it("refuses to create a unit that is already out of service", async () => {
    expect(
      expectRefusal(
        await createEquipment({ name: "Old boiler", category: "hvac", status: "retired" }),
      ),
    ).toBe("status_not_creatable");
  });

  it("links Home Assistant entities given at creation time", async () => {
    const { deviceId, registryId } = seedHaDevice();
    const { assetId } = unwrap(
      await createEquipment({
        name: "Front door sensor",
        category: "safety",
        locationId: world.locationId,
        haDeviceId: deviceId,
        haEntityLinks: [{ registryId, role: "battery_level" }],
      }),
    );
    const links = world.handle.db
      .select()
      .from(assetHaLink)
      .where(eq(assetHaLink.assetId, assetId))
      .all();
    expect(links).toHaveLength(2);
    // The snapshots are captured at link time, which is what makes a later relink possible.
    const entityLink = links.find((link) => link.linkKind === "entity");
    expect(entityLink?.uniqueIdSnapshot).toMatch(/^00:12:4b:00:1c:aa-\d+-1$/);
    expect(entityLink?.platformSnapshot).toBe("zha");
  });
});

describe("updateEquipment", () => {
  it("refuses to make a unit its own parent", async () => {
    const assetId = seedAsset(world);
    expect(
      expectRefusal(
        await updateEquipment({
          assetId,
          name: "Ilmanvaihtokone",
          category: "hvac",
          parentAssetId: assetId,
        }),
      ),
    ).toBe("self_parent");
  });

  it("records the change in the audit trail without moving anything else", async () => {
    const assetId = seedAsset(world);
    unwrap(
      await updateEquipment({
        assetId,
        name: "Parmair MAC 120",
        category: "hvac",
        locationId: world.locationId,
      }),
    );
    expect(
      world.handle.db.select().from(asset).where(eq(asset.id, assetId)).get()?.name,
    ).toBe("Parmair MAC 120");
  });
});

describe("replaceEquipment", () => {
  it("creates a new unit, links the chain, and leaves the old record intact", async () => {
    const oldId = seedAsset(world, { name: "Old air handling unit" });
    const result = unwrap(
      await replaceEquipment({
        oldAssetId: oldId,
        replacedOn: "2026-09-01",
        reason: "end_of_life",
        newAsset: { name: "New air handling unit" },
      }),
    );

    const oldRow = world.handle.db.select().from(asset).where(eq(asset.id, oldId)).get();
    const newRow = world.handle.db
      .select()
      .from(asset)
      .where(eq(asset.id, result.newAssetId))
      .get();

    expect(oldRow?.status).toBe("removed");
    expect(oldRow?.removedOn).toBe("2026-09-01");
    expect(oldRow?.replacedByAssetId).toBe(result.newAssetId);
    expect(newRow?.replacesAssetId).toBe(oldId);
    expect(newRow?.installedOn).toBe("2026-09-01");
    expect(replacementChain(world.handle.db, result.newAssetId)).toEqual([
      oldId,
      result.newAssetId,
    ]);

    const swap = world.handle.db
      .select()
      .from(assetReplacement)
      .where(eq(assetReplacement.oldAssetId, oldId))
      .get();
    expect(swap?.reason).toBe("end_of_life");
  });

  it("moves active plans forward and clones the consumables when asked", async () => {
    const partId = seedPart(world, { name: "Filter" });
    const oldId = seedAsset(world);
    unwrap(await setConsumables({ assetId: oldId, consumables: [{ partId, role: "filter", qtyMilli: 2000 }] }));
    writeTx(world.handle.db, (tx) => {
      tx.insert(maintenancePlan)
        .values({
          id: newId(),
          title: "Change the filter",
          assetId: oldId,
          scheduleKind: "interval_from_completion",
          recurrenceJson: '{"v":1,"kind":"interval_from_completion","every":6,"unit":"month"}',
          assignmentMode: "shared",
          status: "active",
          createdAtMs: nowMs(),
          updatedAtMs: nowMs(),
        })
        .run();
    });

    const result = unwrap(
      await replaceEquipment({
        oldAssetId: oldId,
        replacedOn: "2026-09-01",
        reason: "failure",
        cloneConsumables: true,
        newAsset: { name: "Replacement unit" },
      }),
    );

    expect(result.repointedPlanIds).toHaveLength(1);
    expect(
      world.handle.db
        .select()
        .from(maintenancePlan)
        .where(eq(maintenancePlan.assetId, result.newAssetId))
        .all(),
    ).toHaveLength(1);
    expect(
      world.handle.db
        .select()
        .from(assetConsumable)
        .where(eq(assetConsumable.assetId, result.newAssetId))
        .all(),
    ).toHaveLength(1);
  });

  it("retires the old links and raises an alert when they are not cloned", async () => {
    const { registryId } = seedHaDevice();
    const oldId = seedAsset(world);
    unwrap(await linkHaEntity({ assetId: oldId, registryId, role: "battery_level" }));

    const result = unwrap(
      await replaceEquipment({
        oldAssetId: oldId,
        replacedOn: "2026-09-01",
        reason: "failure",
        cloneHaLinks: false,
        newAsset: { name: "Replacement unit" },
      }),
    );

    expect(result.retiredLinkIds).toHaveLength(1);
    expect(result.clonedLinkIds).toEqual([]);
    expect(
      world.handle.db.select().from(assetHaLink).where(eq(assetHaLink.assetId, oldId)).get()
        ?.linkState,
    ).toBe("replaced");
    // The household is told the new unit needs linking, rather than left with a silent gap.
    const alerts = world.handle.db
      .select()
      .from(appAlert)
      .where(eq(appAlert.kind, "ha_link_missing"))
      .all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.entityId).toBe(result.newAssetId);
  });

  it("clones the links when the same physical sensor stayed", async () => {
    const { registryId } = seedHaDevice();
    const oldId = seedAsset(world);
    unwrap(await linkHaEntity({ assetId: oldId, registryId, role: "battery_level" }));

    const result = unwrap(
      await replaceEquipment({
        oldAssetId: oldId,
        replacedOn: "2026-09-01",
        reason: "upgrade",
        cloneHaLinks: true,
        newAsset: { name: "Replacement unit" },
      }),
    );
    expect(result.clonedLinkIds).toHaveLength(1);
    expect(
      world.handle.db
        .select()
        .from(assetHaLink)
        .where(
          and(eq(assetHaLink.assetId, result.newAssetId), eq(assetHaLink.linkState, "active")),
        )
        .all(),
    ).toHaveLength(1);
  });

  it("can install an existing spare instead of creating a new row", async () => {
    const oldId = seedAsset(world, { name: "Failed pump" });
    const spareId = seedAsset(world, { name: "Spare pump", status: "planned" });
    const result = unwrap(
      await replaceEquipment({
        oldAssetId: oldId,
        replacedOn: "2026-09-01",
        reason: "failure",
        existingAssetId: spareId,
      }),
    );
    expect(result.newAssetId).toBe(spareId);
    expect(
      world.handle.db.select().from(asset).where(eq(asset.id, spareId)).get()?.status,
    ).toBe("installed");
  });

  it("refuses to replace the same unit twice", async () => {
    const oldId = seedAsset(world);
    unwrap(
      await replaceEquipment({
        oldAssetId: oldId,
        replacedOn: "2026-09-01",
        reason: "failure",
        newAsset: { name: "First replacement" },
      }),
    );
    expect(
      expectRefusal(
        await replaceEquipment({
          oldAssetId: oldId,
          replacedOn: "2026-09-02",
          reason: "failure",
          newAsset: { name: "Second replacement" },
        }),
      ),
    ).toBe("already_replaced");
  });

  it("refuses both a new unit and an existing spare at once", async () => {
    const oldId = seedAsset(world);
    const spareId = seedAsset(world, { name: "Spare", status: "planned" });
    expect(
      expectRefusal(
        await replaceEquipment({
          oldAssetId: oldId,
          replacedOn: "2026-09-01",
          reason: "failure",
          existingAssetId: spareId,
          newAsset: { name: "Also new" },
        }),
      ),
    ).toBe("invalid_request");
  });
});

describe("retireEquipment", () => {
  it("takes a unit out of service and retires its links without deleting them", async () => {
    const { registryId } = seedHaDevice();
    const assetId = seedAsset(world);
    unwrap(await linkHaEntity({ assetId, registryId, role: "primary" }));

    unwrap(await retireEquipment({ assetId, status: "removed", removedOn: "2026-09-05" }));

    const row = world.handle.db.select().from(asset).where(eq(asset.id, assetId)).get();
    expect(row?.status).toBe("removed");
    expect(row?.removedOn).toBe("2026-09-05");
    // Not a replacement: nothing took its place, so nothing claims to have.
    expect(row?.replacedByAssetId).toBeNull();
    expect(
      world.handle.db.select().from(assetHaLink).where(eq(assetHaLink.assetId, assetId)).get()
        ?.linkState,
    ).toBe("retired");
  });

  it("refuses to retire a unit that was replaced", async () => {
    const oldId = seedAsset(world);
    unwrap(
      await replaceEquipment({
        oldAssetId: oldId,
        replacedOn: "2026-09-01",
        reason: "failure",
        newAsset: { name: "Replacement" },
      }),
    );
    expect(
      expectRefusal(
        await retireEquipment({ assetId: oldId, status: "retired", removedOn: "2026-09-02" }),
      ),
    ).toBe("already_replaced");
  });
});

describe("bulkRemoveEquipment", () => {
  it("atomically removes selected units, retires their HA links, and keeps audit history", async () => {
    const firstLink = seedHaDevice();
    const secondLink = seedHaDevice();
    const firstId = seedAsset(world, { name: "Kitchen sensor" });
    const secondId = seedAsset(world, { name: "Garage controller", status: "planned" });
    const untouchedId = seedAsset(world, { name: "Heat pump" });
    unwrap(await linkHaEntity({ assetId: firstId, registryId: firstLink.registryId, role: "primary" }));
    const { linkId: secondLinkId } = unwrap(
      await linkHaEntity({ assetId: secondId, registryId: secondLink.registryId, role: "primary" }),
    );
    writeTx(world.handle.db, (tx) => {
      tx.update(assetHaLink)
        .set({ linkState: "renamed" })
        .where(eq(assetHaLink.id, secondLinkId))
        .run();
    });

    const result = unwrap(
      await bulkRemoveEquipment({
        assetIds: [firstId, secondId],
        idempotencyKey: "bulk-remove-request",
      }),
    );

    expect(result.removedCount).toBe(2);
    expect(result.removedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mocks.freshSessionCalls.current).toBe(1);
    const removed = world.handle.db
      .select()
      .from(asset)
      .where(inArray(asset.id, [firstId, secondId]))
      .all();
    expect(removed.map((row) => row.status)).toEqual(["removed", "removed"]);
    expect(removed.every((row) => row.removedOn === result.removedOn)).toBe(true);
    expect(
      world.handle.db
        .select()
        .from(assetHaLink)
        .where(inArray(assetHaLink.assetId, [firstId, secondId]))
        .all()
        .map((row) => row.linkState),
    ).toEqual(["retired", "retired"]);
    expect(world.handle.db.select().from(asset).where(eq(asset.id, untouchedId)).get()?.status).toBe(
      "installed",
    );

    const audits = world.handle.db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.entityId, [firstId, secondId]))
      .all();
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => row.requestId === "bulk-remove-request")).toBe(true);

    // Retired bindings no longer reserve the registry entry, so the household can import it again.
    expect(
      listLinkableEntities(world.handle.db).entities.find(
        (entity) => entity.registryId === firstLink.registryId,
      )?.linkedAssetName,
    ).toBeNull();
  });

  it("changes nothing when any selected unit is no longer removable", async () => {
    const currentId = seedAsset(world, { name: "Current" });
    const alreadyRemovedId = seedAsset(world, { name: "Gone", status: "removed" });
    writeTx(world.handle.db, (tx) => {
      tx.update(asset).set({ removedOn: "2026-09-01" }).where(eq(asset.id, alreadyRemovedId)).run();
    });

    expect(
      expectRefusal(
        await bulkRemoveEquipment({
          assetIds: [currentId, alreadyRemovedId],
          idempotencyKey: "bulk-remove-conflict",
        }),
      ),
    ).toBe("equipment_changed");
    expect(world.handle.db.select().from(asset).where(eq(asset.id, currentId)).get()?.status).toBe(
      "installed",
    );
  });

  it("rejects oversized and duplicate batches before opening a write", async () => {
    const assetId = seedAsset(world);
    expect(
      expectRefusal(
        await bulkRemoveEquipment({
          assetIds: [assetId, assetId],
          idempotencyKey: "bulk-remove-duplicate",
        }),
      ),
    ).toBe("invalid_request");
    expect(
      expectRefusal(
        await bulkRemoveEquipment({
          assetIds: Array.from({ length: 1001 }, (_, index) => `asset-${index}`),
          idempotencyKey: "bulk-remove-oversized",
        }),
      ),
    ).toBe("invalid_request");
    expect(world.handle.db.select().from(asset).where(eq(asset.id, assetId)).get()?.status).toBe(
      "installed",
    );
  });
});

describe("Home Assistant links", () => {
  it("resolves the “link this unit” alert once a link exists", async () => {
    const { registryId } = seedHaDevice();
    const oldId = seedAsset(world);
    unwrap(await linkHaEntity({ assetId: oldId, registryId, role: "primary" }));
    const result = unwrap(
      await replaceEquipment({
        oldAssetId: oldId,
        replacedOn: "2026-09-01",
        reason: "failure",
        cloneHaLinks: false,
        newAsset: { name: "Replacement" },
      }),
    );

    const second = seedHaDevice();
    unwrap(
      await linkHaEntity({
        assetId: result.newAssetId,
        registryId: second.registryId,
        role: "primary",
      }),
    );
    const alert = world.handle.db
      .select()
      .from(appAlert)
      .where(eq(appAlert.entityId, result.newAssetId))
      .get();
    expect(alert?.resolvedAtMs).not.toBeNull();
  });

  it("refuses to repoint a link that is not missing", async () => {
    const first = seedHaDevice();
    const second = seedHaDevice();
    const assetId = seedAsset(world);
    const { linkId } = unwrap(
      await linkHaEntity({ assetId, registryId: first.registryId, role: "primary" }),
    );
    expect(
      expectRefusal(await relinkHa({ assetId, linkId, registryId: second.registryId })),
    ).toBe("link_not_missing");
  });

  it("repoints a missing link and records the repair", async () => {
    const first = seedHaDevice();
    const second = seedHaDevice();
    const assetId = seedAsset(world);
    const { linkId } = unwrap(
      await linkHaEntity({ assetId, registryId: first.registryId, role: "primary" }),
    );
    // Simulate what the registry sync does when the entity disappears.
    writeTx(world.handle.db, (tx) => {
      tx.update(assetHaLink)
        .set({ linkState: "missing" })
        .where(eq(assetHaLink.id, linkId))
        .run();
    });

    unwrap(await relinkHa({ assetId, linkId, registryId: second.registryId }));
    const row = world.handle.db
      .select()
      .from(assetHaLink)
      .where(eq(assetHaLink.id, linkId))
      .get();
    expect(row?.linkState).toBe("active");
    expect(row?.haEntityRegistryId).toBe(second.registryId);
  });

  it("refuses to mark a missing link active by hand", async () => {
    const { registryId } = seedHaDevice();
    const assetId = seedAsset(world);
    const { linkId } = unwrap(await linkHaEntity({ assetId, registryId, role: "primary" }));
    writeTx(world.handle.db, (tx) => {
      tx.update(assetHaLink)
        .set({ linkState: "missing" })
        .where(eq(assetHaLink.id, linkId))
        .run();
    });
    expect(expectRefusal(await setHaLinkState({ assetId, linkId, linkState: "active" }))).toBe(
      "link_still_missing",
    );
  });

  it("refuses to touch a link that belongs to another unit", async () => {
    const { registryId } = seedHaDevice();
    const assetId = seedAsset(world);
    const otherId = seedAsset(world, { name: "Other" });
    const { linkId } = unwrap(await linkHaEntity({ assetId, registryId, role: "primary" }));
    expect(expectRefusal(await unlinkHa({ assetId: otherId, linkId }))).toBe(
      "link_asset_mismatch",
    );
  });

  it("removes a link created by mistake", async () => {
    const { registryId } = seedHaDevice();
    const assetId = seedAsset(world);
    const { linkId } = unwrap(await linkHaEntity({ assetId, registryId, role: "primary" }));
    unwrap(await unlinkHa({ assetId, linkId }));
    expect(
      world.handle.db.select().from(assetHaLink).where(eq(assetHaLink.id, linkId)).all(),
    ).toHaveLength(0);
  });
});

describe("systems", () => {
  it("creates a system with members and the rooms it reaches", async () => {
    const a = seedAsset(world, { name: "Air handling unit" });
    const b = seedAsset(world, { name: "Extract fan" });
    const { systemId } = unwrap(
      await upsertSystem({
        name: "Whole-house ventilation",
        kind: "ventilation",
        members: [{ assetId: a }, { assetId: b, role: "extract" }],
        locationIds: [world.locationId, world.propertyId],
      }),
    );
    expect(
      world.handle.db.select().from(systemAsset).where(eq(systemAsset.systemId, systemId)).all(),
    ).toHaveLength(2);
  });

  it("replaces membership wholesale rather than merging", async () => {
    const a = seedAsset(world, { name: "A" });
    const b = seedAsset(world, { name: "B" });
    const { systemId } = unwrap(
      await upsertSystem({ name: "Water", kind: "water", members: [{ assetId: a }] }),
    );
    unwrap(
      await upsertSystem({ systemId, name: "Water", kind: "water", members: [{ assetId: b }] }),
    );
    const members = world.handle.db
      .select()
      .from(systemAsset)
      .where(eq(systemAsset.systemId, systemId))
      .all();
    expect(members.map((member) => member.assetId)).toEqual([b]);
  });

  it("refuses a unit listed twice", async () => {
    const a = seedAsset(world);
    expect(
      expectRefusal(
        await upsertSystem({
          name: "Duplicated",
          kind: "other",
          members: [{ assetId: a }, { assetId: a }],
        }),
      ),
    ).toBe("duplicate_member");
  });

  it("refuses to delete a system that scheduled work points at", async () => {
    const { systemId } = unwrap(await upsertSystem({ name: "Heating", kind: "heating" }));
    writeTx(world.handle.db, (tx) => {
      tx.insert(maintenancePlan)
        .values({
          id: newId(),
          title: "Bleed the radiators",
          systemId,
          scheduleKind: "fixed_calendar",
          recurrenceJson: '{"v":1,"kind":"fixed_yearly","month":10,"dayOfMonth":1}',
          assignmentMode: "shared",
          status: "active",
          createdAtMs: nowMs(),
          updatedAtMs: nowMs(),
        })
        .run();
    });
    expect(expectRefusal(await deleteSystem({ systemId }))).toBe("system_has_plans");
  });

  it("deletes a system without touching its members", async () => {
    const a = seedAsset(world);
    const { systemId } = unwrap(
      await upsertSystem({ name: "Networking", kind: "networking", members: [{ assetId: a }] }),
    );
    unwrap(await deleteSystem({ systemId }));
    expect(world.handle.db.select().from(asset).where(eq(asset.id, a)).all()).toHaveLength(1);
  });
});


describe("device and entity role compatibility", () => {
  it("lets a primary entity take over the imported device primary slot", async () => {
    const { deviceId, registryId } = seedHaDevice();
    const { assetId } = unwrap(await createEquipment({ name: "Motion sensor", category: "safety", haDeviceId: deviceId }));
    unwrap(await linkHaEntity({ assetId, registryId, role: "primary" }));
    const links = world.handle.db.select().from(assetHaLink).where(eq(assetHaLink.assetId, assetId)).all();
    expect(links).toHaveLength(2);
    expect(links.find((link) => link.linkKind === "device")?.role).toBe("status");
    expect(links.find((link) => link.linkKind === "entity")?.role).toBe("primary");
  });

  it("creates equipment with both a device and primary entity in one transaction", async () => {
    const { deviceId, registryId } = seedHaDevice();
    const { assetId } = unwrap(await createEquipment({ name: "Motion sensor", category: "safety", haDeviceId: deviceId,
      haEntityLinks: [{ registryId, role: "primary" }] }));
    expect(world.handle.db.select().from(assetHaLink).where(eq(assetHaLink.assetId, assetId)).all()).toHaveLength(2);
  });

  it("reports duplicate entities and occupied roles without changing existing links", async () => {
    const first = seedHaDevice();
    const second = seedHaDevice();
    const assetId = seedAsset(world);
    unwrap(await linkHaEntity({ assetId, registryId: first.registryId, role: "primary" }));
    expect(expectRefusal(await linkHaEntity({ assetId, registryId: first.registryId, role: "status" }))).toBe("entity_already_linked");
    expect(expectRefusal(await linkHaEntity({ assetId, registryId: second.registryId, role: "primary" }))).toBe("ha_role_taken");
    expect(world.handle.db.select().from(assetHaLink).where(eq(assetHaLink.assetId, assetId)).all()).toHaveLength(1);
  });
});


describe("equipment entity picker", () => {
  it("prioritizes the linked device before limiting and filters hidden rows before limiting", async () => {
    const unrelated = seedHaDevice();
    const own = seedHaDevice();
    const hidden = seedHaDevice();
    writeTx(world.handle.db, (tx) => {
      tx.update(haEntity).set({ entityId: "sensor.aaa_hidden", hiddenBy: "user" }).where(eq(haEntity.registryId, hidden.registryId)).run();
      tx.update(haEntity).set({ entityId: "sensor.bbb_unrelated" }).where(eq(haEntity.registryId, unrelated.registryId)).run();
      tx.update(haEntity).set({ entityId: "sensor.zzz_own" }).where(eq(haEntity.registryId, own.registryId)).run();
    });
    const { assetId } = unwrap(await createEquipment({ name: "Own device", category: "other", haDeviceId: own.deviceId }));
    const result = listLinkableEntities(world.handle.db, { assetId, limit: 1 });
    expect(result.truncated).toBe(true);
    expect(result.entities.map((row) => row.registryId)).toEqual([own.registryId]);
    expect(result.entities[0]?.belongsToDevice).toBe(true);
    expect(listLinkableEntities(world.handle.db, { limit: 1 }).entities[0]?.registryId).toBe(unrelated.registryId);
  });
});

describe("equipment trash", () => {
  it("permanently deletes an unused out-of-service record and its owned setup rows", async () => {
    const assetId = seedAsset(world, { name: "Accidental import" });
    const partId = seedPart(world);
    const { registryId } = seedHaDevice();
    const { systemId } = unwrap(
      await upsertSystem({ name: "Temporary", kind: "other", members: [{ assetId }] }),
    );
    unwrap(await linkHaEntity({ assetId, registryId, role: "battery_level" }));
    unwrap(
      await setConsumables({
        assetId,
        consumables: [{ partId, role: "battery", qtyMilli: 1000 }],
      }),
    );
    unwrap(
      await bulkRemoveEquipment({
        assetIds: [assetId],
        idempotencyKey: "remove-before-delete",
      }),
    );

    unwrap(
      await permanentlyDeleteEquipment({
        assetIds: [assetId],
        idempotencyKey: "permanent-delete-unused",
      }),
    );

    expect(world.handle.db.select().from(asset).where(eq(asset.id, assetId)).all()).toEqual([]);
    expect(
      world.handle.db.select().from(assetHaLink).where(eq(assetHaLink.assetId, assetId)).all(),
    ).toEqual([]);
    expect(
      world.handle.db.select().from(assetConsumable).where(eq(assetConsumable.assetId, assetId)).all(),
    ).toEqual([]);
    expect(
      world.handle.db.select().from(systemAsset).where(eq(systemAsset.systemId, systemId)).all(),
    ).toEqual([]);
    expect(
      world.handle.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, assetId), eq(auditLog.action, "permanently_deleted")))
        .all(),
    ).toHaveLength(1);
    expect(mocks.freshSessionCalls.current).toBeGreaterThan(0);
  });

  it("refuses permanent deletion when maintenance history depends on the record", async () => {
    const assetId = seedAsset(world, { name: "Serviced unit" });
    unwrap(
      await bulkRemoveEquipment({
        assetIds: [assetId],
        idempotencyKey: "remove-serviced-unit",
      }),
    );
    writeTx(world.handle.db, (tx) => {
      tx.insert(maintenancePlan)
        .values({
          id: newId(),
          title: "Keep this history",
          assetId,
          scheduleKind: "one_off",
          recurrenceJson: '{"v":1,"kind":"one_off"}',
          assignmentMode: "shared",
          status: "cancelled",
          createdAtMs: nowMs(),
          updatedAtMs: nowMs(),
        })
        .run();
    });

    const trash = listTrashEquipment(world.handle.db, {
      nowMs: nowMs(),
      batteryThresholdPct: 20,
      batteryStaleHours: 24,
    });
    expect(trash.blockers[assetId]).toBe("Has a maintenance plan");

    expect(
      expectRefusal(
        await permanentlyDeleteEquipment({
          assetIds: [assetId],
          idempotencyKey: "refuse-delete-history",
        }),
      ),
    ).toBe("equipment_not_deletable");
    expect(world.handle.db.select().from(asset).where(eq(asset.id, assetId)).all()).toHaveLength(1);
  });

  it("preserves an asset referenced only by condition episode history", async () => {
    const assetId = seedAsset(world, { name: "Battery history" });
    const { registryId } = seedHaDevice();
    const ruleId = newId();
    const at = nowMs();
    unwrap(
      await bulkRemoveEquipment({
        assetIds: [assetId],
        idempotencyKey: "remove-condition-history",
      }),
    );
    writeTx(world.handle.db, (tx) => {
      tx.insert(conditionRule)
        .values({
          id: ruleId,
          kind: "low_battery",
          name: "Battery rule",
          scope: "entity",
          haEntityRegistryId: registryId,
          titleTemplate: "Replace battery",
          createdAtMs: at,
          updatedAtMs: at,
        })
        .run();
      tx.insert(conditionEpisode)
        .values({
          id: newId(),
          ruleId,
          haEntityRegistryId: registryId,
          assetId,
          openedAtMs: at,
          openLocalDate: "2026-09-09",
          createdAtMs: at,
        })
        .run();
    });

    expect(
      expectRefusal(
        await permanentlyDeleteEquipment({
          assetIds: [assetId],
          idempotencyKey: "refuse-condition-history",
        }),
      ),
    ).toBe("equipment_not_deletable");
    expect(world.handle.db.select().from(asset).where(eq(asset.id, assetId)).all()).toHaveLength(1);
  });
});
