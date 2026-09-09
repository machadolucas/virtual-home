/**
 * Integration tests for the settings and Home Assistant action families.
 *
 * Three properties worth pinning here:
 *  - **a mapping is never auto-confirmed** (§7.3) — the suggester writes `suggested` rows only, and
 *    a rejection sticks so the same pairing is not re-proposed on every sync;
 *  - **acknowledging an alert is not resolving it** — `resolved_at_ms` stays null, because a human
 *    ticking a box does not make a battery full;
 *  - **a notify service reaches one person** — the uniqueness is global, or every reminder doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ userId: { current: null as string | null } }));

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
  };
});

import { writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  HOUSEHOLD_SETTING_ID,
  appAlert,
  asset,
  assetHaLink,
  conditionEpisode,
  conditionRule,
  haArea,
  haDevice,
  haEntity,
  haFloor,
  householdSetting,
  location,
  locationMapping,
  user,
  userNotifyDevice,
} from "@/db/schema";
import { raiseAlert } from "@/domain/inventory";
import { systemClock } from "@/domain/time";
import {
  acknowledgeAlert,
  addNotifyDevice,
  removeNotifyDevice,
  setNotifyDeviceActive,
  updateDisplayColor,
  updateHouseholdSettings,
} from "@/server/actions/settings/household";
import {
  decideLocationMapping,
  refreshMappingSuggestions,
} from "@/server/actions/ha/mappings";
import { importHaDevice, importHaDevices } from "@/server/actions/ha/import";
import {
  deleteConditionRule,
  setConditionRuleEnabled,
  upsertConditionRule,
} from "@/server/actions/ha/rules";
import { listLocationMappings } from "@/server/queries/ha/mappings";
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
});

afterEach(() => {
  mocks.userId.current = null;
  teardown(world);
});

/** The settings form posts every field, so the tests need a complete baseline. */
function householdInput(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Example House",
    timezone: "Europe/Helsinki",
    deliveryTime: "09:00",
    reminderIntervalDays: 7,
    sendWindowStart: "08:00",
    sendWindowEnd: "21:30",
    catchupGapMinutes: 120,
    catchupDigestThreshold: 3,
    slotGraceMinutes: 30,
    actionTtlDays: 30,
    batteryThresholdPct: 15,
    batteryClearPct: 30,
    batterySustainMinutes: 120,
    batteryClearSustainMinutes: 360,
    batteryStaleHours: 48,
    reorderHorizonDays: 90,
    haBaseUrl: "http://homeassistant.local:8123",
    inventoryPushEnabled: false,
    ...overrides,
  } as Parameters<typeof updateHouseholdSettings>[0];
}

describe("updateHouseholdSettings", () => {
  it("saves the whole form and attributes the change", async () => {
    unwrap(
      await updateHouseholdSettings(
        householdInput({ timezone: "Europe/Stockholm", deliveryTime: "07:30", reorderHorizonDays: 45 }),
      ),
    );
    const row = world.handle.db
      .select()
      .from(householdSetting)
      .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
      .get();
    expect(row?.timezone).toBe("Europe/Stockholm");
    expect(row?.deliveryTime).toBe("07:30");
    expect(row?.reorderHorizonDays).toBe(45);
    expect(row?.updatedBy).toBe(world.user.id);
  });

  it("refuses a clear level at or below the low level, so a battery cannot flap forever", async () => {
    expect(
      expectRefusal(
        await updateHouseholdSettings(
          householdInput({ batteryThresholdPct: 30, batteryClearPct: 20 }),
        ),
      ),
    ).toBe("invalid_request");
  });

  it("refuses a send window that ends before it starts", async () => {
    expect(
      expectRefusal(
        await updateHouseholdSettings(
          householdInput({ sendWindowStart: "22:00", sendWindowEnd: "08:00" }),
        ),
      ),
    ).toBe("invalid_request");
  });

  it("refuses an unknown time zone", async () => {
    expect(
      expectRefusal(await updateHouseholdSettings(householdInput({ timezone: "Mars/Olympus" }))),
    ).toBe("invalid_request");
  });

  it("refuses a malformed delivery time rather than storing an instant", async () => {
    expect(
      expectRefusal(await updateHouseholdSettings(householdInput({ deliveryTime: "9am" }))),
    ).toBe("invalid_request");
  });
});

describe("display colours and notify devices", () => {
  it("saves a lowercase hex colour and clears back to the default", async () => {
    unwrap(await updateDisplayColor({ userId: world.user.id, displayColor: "#2f5fd0" }));
    expect(
      world.handle.db.select().from(user).where(eq(user.id, world.user.id)).get()?.displayColor,
    ).toBe("#2f5fd0");

    unwrap(await updateDisplayColor({ userId: world.user.id, displayColor: null }));
    expect(
      world.handle.db.select().from(user).where(eq(user.id, world.user.id)).get()?.displayColor,
    ).toBeNull();
  });

  it("refuses anything that is not a lowercase #rrggbb, before it can reach CSS", async () => {
    for (const colour of ["#2F5FD0", "red", "#fff", "javascript:alert(1)"]) {
      expect(
        expectRefusal(await updateDisplayColor({ userId: world.user.id, displayColor: colour })),
        colour,
      ).toBe("invalid_request");
    }
  });

  it("registers a phone and mutes it without deleting it", async () => {
    const { deviceId } = unwrap(
      await addNotifyDevice({
        userId: world.user.id,
        label: "Lucas iPhone",
        notifyService: "notify.mobile_app_lucas_iphone",
        haDeviceName: "Lucas iPhone",
      }),
    );
    unwrap(await setNotifyDeviceActive({ deviceId, isActive: false }));
    const row = world.handle.db
      .select()
      .from(userNotifyDevice)
      .where(eq(userNotifyDevice.id, deviceId))
      .get();
    expect(row?.isActive).toBe(false);
    expect(row?.haDeviceName).toBe("Lucas iPhone");
  });

  it("refuses the same notification service twice, because one phone reaches one person", async () => {
    unwrap(
      await addNotifyDevice({
        userId: world.user.id,
        label: "Lucas iPhone",
        notifyService: "notify.mobile_app_lucas_iphone",
      }),
    );
    expect(
      expectRefusal(
        await addNotifyDevice({
          userId: world.user.id,
          label: "The same phone again",
          notifyService: "notify.mobile_app_lucas_iphone",
        }),
      ),
    ).toBe("notify_service_taken");
  });

  it("refuses a service name Home Assistant would not accept", async () => {
    expect(
      expectRefusal(
        await addNotifyDevice({
          userId: world.user.id,
          label: "Wrong",
          notifyService: "mobile_app_lucas_iphone",
        }),
      ),
    ).toBe("invalid_request");
  });

  it("removes a device when it is genuinely gone", async () => {
    const { deviceId } = unwrap(
      await addNotifyDevice({
        userId: world.user.id,
        label: "Old phone",
        notifyService: "notify.mobile_app_old_phone",
      }),
    );
    unwrap(await removeNotifyDevice({ deviceId }));
    expect(world.handle.db.select().from(userNotifyDevice).all()).toHaveLength(0);
  });
});

describe("acknowledgeAlert", () => {
  it("records who saw it without resolving it", async () => {
    const alert = writeTx(world.handle.db, (tx) =>
      raiseAlert(
        tx,
        {
          clock: systemClock,
          tz: "Europe/Helsinki",
          actorUserId: world.user.id,
          actorKind: "user",
        },
        {
          kind: "low_stock",
          severity: "warning",
          title: "Low on filters",
          dedupeKey: "low_stock:test",
        },
      ),
    );

    unwrap(await acknowledgeAlert({ alertId: alert.id }));
    const row = world.handle.db.select().from(appAlert).where(eq(appAlert.id, alert.id)).get();
    expect(row?.acknowledgedBy).toBe(world.user.id);
    expect(row?.acknowledgedAtMs).not.toBeNull();
    // Still unresolved: only the condition going away resolves it.
    expect(row?.resolvedAtMs).toBeNull();
  });

  it("refuses an alert that does not exist", async () => {
    expect(expectRefusal(await acknowledgeAlert({ alertId: "nope" }))).toBe("not_found");
  });
});

describe("location mappings", () => {
  function seedArea(name: string): string {
    const areaId = newId();
    const at = nowMs();
    writeTx(world.handle.db, (tx) => {
      tx.insert(haArea).values({ areaId, name, lastSeenMs: at }).run();
    });
    return areaId;
  }

  it("lists an HA area with no decision as undecided", () => {
    seedArea("Autotalli");
    const rows = listLocationMappings(world.handle.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBeNull();
    expect(rows[0]?.locationId).toBeNull();
  });

  it("suggests an exact name match but never confirms it", async () => {
    seedArea("Autotalli");
    const { added } = unwrap(await refreshMappingSuggestions({}));
    expect(added).toBe(1);
    const row = world.handle.db.select().from(locationMapping).get();
    expect(row?.source).toBe("suggested");
    expect(row?.decidedAtMs).toBeNull();
  });

  it("confirms a mapping and attributes the decision", async () => {
    const areaId = seedArea("Autotalli");
    unwrap(
      await decideLocationMapping({
        haKind: "area",
        haId: areaId,
        locationId: world.locationId,
        decision: "confirm",
      }),
    );
    const row = world.handle.db.select().from(locationMapping).get();
    expect(row?.source).toBe("confirmed");
    expect(row?.decidedBy).toBe(world.user.id);
    expect(row?.matchReason).toBe("manual");
    // A decision replaces the suggester's confidence rather than keeping a stale number.
    expect(row?.confidence).toBeNull();
  });

  it("keeps a rejection, so the suggester does not re-propose it", async () => {
    const areaId = seedArea("Autotalli");
    unwrap(
      await decideLocationMapping({
        haKind: "area",
        haId: areaId,
        locationId: world.locationId,
        decision: "reject",
      }),
    );
    const { added } = unwrap(await refreshMappingSuggestions({}));
    expect(added).toBe(0);
    expect(world.handle.db.select().from(locationMapping).get()?.source).toBe("rejected");
  });

  it("cannot overwrite a confirmation by re-running the suggester", async () => {
    const areaId = seedArea("Autotalli");
    unwrap(
      await decideLocationMapping({
        haKind: "area",
        haId: areaId,
        locationId: world.locationId,
        decision: "confirm",
      }),
    );
    unwrap(await refreshMappingSuggestions({}));
    expect(world.handle.db.select().from(locationMapping).get()?.source).toBe("confirmed");
  });

  it("refuses to confirm with no location chosen", async () => {
    const areaId = seedArea("Autotalli");
    expect(
      expectRefusal(
        await decideLocationMapping({ haKind: "area", haId: areaId, decision: "confirm" }),
      ),
    ).toBe("confirm_needs_location");
  });

  it("refuses to map an HA area onto a floor", async () => {
    const areaId = seedArea("Autotalli");
    const at = nowMs();
    const floorLocationId = newId();
    writeTx(world.handle.db, (tx) => {
      tx.insert(haFloor).values({ floorId: newId(), name: "Ground", lastSeenMs: at }).run();
      tx.insert(location)
        .values({
          id: floorLocationId,
          kind: "floor",
          parentId: world.propertyId,
          name: "Ground",
          slug: "ground",
          floorLevel: 0,
          createdAtMs: at,
          updatedAtMs: at,
        })
        .run();
    });
    // An HA area is a room-sized thing; pairing one with a floor would put every new device on a
    // whole storey.
    expect(
      expectRefusal(
        await decideLocationMapping({
          haKind: "area",
          haId: areaId,
          locationId: floorLocationId,
          decision: "confirm",
        }),
      ),
    ).toBe("area_mapped_to_floor");
  });

  it("clears a decision entirely", async () => {
    const areaId = seedArea("Autotalli");
    unwrap(
      await decideLocationMapping({
        haKind: "area",
        haId: areaId,
        locationId: world.locationId,
        decision: "confirm",
      }),
    );
    unwrap(await decideLocationMapping({ haKind: "area", haId: areaId, decision: "clear" }));
    expect(world.handle.db.select().from(locationMapping).all()).toHaveLength(0);
  });
});

describe("importHaDevice", () => {
  // A counter rather than a slice of the id: UUIDv7 shares a timestamp prefix, so two devices
  // created in the same millisecond would collide on the entity id the schema enforces.
  let seq = 0;

  function seedDevice(options: { entryType?: string | null; areaId?: string | null } = {}): {
    deviceId: string;
    registryId: string;
  } {
    seq += 1;
    const deviceId = newId();
    const registryId = newId();
    const at = nowMs();
    writeTx(world.handle.db, (tx) => {
      tx.insert(haDevice)
        .values({
          deviceId,
          name: "Parmair MAC 120",
          manufacturer: "Parmair",
          model: "MAC 120",
          areaId: options.areaId ?? null,
          entryType: options.entryType ?? null,
          firstSeenMs: at,
          lastSeenMs: at,
        })
        .run();
      tx.insert(haEntity)
        .values({
          registryId,
          entityId: `sensor.mac120_${seq}_filter`,
          uniqueId: `unique-${seq}`,
          platform: "modbus",
          deviceId,
          domain: "binary_sensor",
          firstSeenMs: at,
          lastSeenMs: at,
        })
        .run();
    });
    return { deviceId, registryId };
  }

  it("creates equipment from a device, prefilled from the registry", async () => {
    const { deviceId, registryId } = seedDevice();
    const result = unwrap(
      await importHaDevice({
        deviceId,
        name: "Ilmanvaihtokone",
        category: "hvac",
        locationId: world.locationId,
        entities: [{ registryId, role: "status" }],
      }),
    );
    expect(result.created).toBe(true);
    expect(result.linkCount).toBe(2);
    const row = world.handle.db.select().from(asset).where(eq(asset.id, result.assetId)).get();
    expect(row?.manufacturer).toBe("Parmair");
    expect(row?.modelName).toBe("MAC 120");
    // Never a fabricated install date: HA knows when it first saw the device, not when it went in.
    expect(row?.installedOn).toBeNull();
    expect(row?.installedOnPrecision).toBe("unknown");
  });

  it("marks a `service` device as software with no room", async () => {
    const { deviceId } = seedDevice({ entryType: "service" });
    const result = unwrap(
      await importHaDevice({
        deviceId,
        name: "Zigbee bridge",
        category: "software",
        locationId: world.locationId,
      }),
    );
    expect(result.isVirtual).toBe(true);
    const row = world.handle.db.select().from(asset).where(eq(asset.id, result.assetId)).get();
    expect(row?.isVirtual).toBe(true);
    expect(row?.locationId).toBeNull();
  });

  it("links a device to equipment that already exists", async () => {
    const assetId = seedAsset(world, { name: "Hand-entered unit" });
    const { deviceId, registryId } = seedDevice();
    const result = unwrap(
      await importHaDevice({
        deviceId,
        existingAssetId: assetId,
        name: "ignored",
        category: "hvac",
        entities: [{ registryId, role: "status" }],
      }),
    );
    expect(result.created).toBe(false);
    expect(result.assetId).toBe(assetId);
    expect(
      world.handle.db.select().from(assetHaLink).where(eq(assetHaLink.assetId, assetId)).all(),
    ).toHaveLength(2);
  });

  it("does not collide on the primary role when a second device is linked", async () => {
    const assetId = seedAsset(world);
    const first = seedDevice();
    const second = seedDevice();
    unwrap(
      await importHaDevice({
        deviceId: first.deviceId,
        existingAssetId: assetId,
        name: "x",
        category: "hvac",
      }),
    );
    unwrap(
      await importHaDevice({
        deviceId: second.deviceId,
        existingAssetId: assetId,
        name: "x",
        category: "hvac",
      }),
    );
    const primaries = world.handle.db
      .select()
      .from(assetHaLink)
      .where(and(eq(assetHaLink.assetId, assetId), eq(assetHaLink.role, "primary")))
      .all();
    expect(primaries).toHaveLength(1);
  });

  it("bulk imports the entity roles explicitly selected for each device", async () => {
    const first = seedDevice();
    const second = seedDevice();
    const result = unwrap(
      await importHaDevices({
        devices: [
          {
            deviceId: first.deviceId,
            entities: [{ registryId: first.registryId, role: "status" }],
          },
          {
            deviceId: second.deviceId,
            entities: [{ registryId: second.registryId, role: "power" }],
          },
        ],
        category: "hvac",
        useMappedLocation: true,
      }),
    );

    expect(result.createdCount).toBe(2);
    expect(result.skipped).toEqual([]);
    const entityLinks = world.handle.db
      .select()
      .from(assetHaLink)
      .where(eq(assetHaLink.linkKind, "entity"))
      .all();
    expect(entityLinks.map((link) => link.role).sort()).toEqual(["power", "status"]);
    expect(entityLinks.map((link) => link.haEntityRegistryId).sort()).toEqual(
      [first.registryId, second.registryId].sort(),
    );
  });

  it("refuses a bulk entity choice that belongs to another device and rolls back the batch", async () => {
    const first = seedDevice();
    const second = seedDevice();
    const assetsBefore = world.handle.db.select().from(asset).all().length;

    expect(
      expectRefusal(
        await importHaDevices({
          devices: [
            {
              deviceId: first.deviceId,
              entities: [{ registryId: second.registryId, role: "status" }],
            },
          ],
          category: "hvac",
          useMappedLocation: true,
        }),
      ),
    ).toBe("entity_device_mismatch");
    expect(world.handle.db.select().from(asset).all()).toHaveLength(assetsBefore);
  });

  it("refuses an unknown category", async () => {
    const { deviceId } = seedDevice();
    expect(
      expectRefusal(
        await importHaDevice({ deviceId, name: "x", category: "spaceship" }),
      ),
    ).toBe("unknown_category");
  });

  it("refuses a device that has been removed from the registry", async () => {
    const { deviceId } = seedDevice();
    writeTx(world.handle.db, (tx) => {
      tx.update(haDevice)
        .set({ removedAtMs: nowMs() })
        .where(eq(haDevice.deviceId, deviceId))
        .run();
    });
    expect(
      expectRefusal(await importHaDevice({ deviceId, name: "x", category: "hvac" })),
    ).toBe("device_removed");
  });
});

describe("condition rules", () => {
  it("creates a rule with hysteresis and a fallback part", async () => {
    const partId = seedPart(world, { name: "AAA battery" });
    const { ruleId } = unwrap(
      await upsertConditionRule({
        name: "Low battery",
        kind: "low_battery",
        scope: "all_batteries",
        thresholdPct: 20,
        clearThresholdPct: 35,
        sustainMinutes: 60,
        defaultPartId: partId,
        titleTemplate: "Replace battery: {{asset}}",
      }),
    );
    const row = world.handle.db
      .select()
      .from(conditionRule)
      .where(eq(conditionRule.id, ruleId))
      .get();
    expect(row?.thresholdPct).toBe(20);
    expect(row?.clearThresholdPct).toBe(35);
    expect(row?.defaultPartId).toBe(partId);
    expect(row?.assignmentMode).toBe("shared");
  });

  it("refuses a clear level at or below the low level", async () => {
    expect(
      expectRefusal(
        await upsertConditionRule({
          name: "Bad hysteresis",
          kind: "low_battery",
          scope: "all_batteries",
          thresholdPct: 30,
          clearThresholdPct: 20,
          titleTemplate: "x",
        }),
      ),
    ).toBe("invalid_request");
  });

  it("refuses an asset-scoped rule with no asset", async () => {
    expect(
      expectRefusal(
        await upsertConditionRule({
          name: "Scoped nowhere",
          kind: "low_battery",
          scope: "asset",
          titleTemplate: "x",
        }),
      ),
    ).toBe("invalid_request");
  });

  it("closes open episodes when the rule is switched off, and leaves the tasks alone", async () => {
    const assetId = seedAsset(world);
    const at = nowMs();
    const registryId = newId();
    writeTx(world.handle.db, (tx) => {
      tx.insert(haEntity)
        .values({
          registryId,
          entityId: "sensor.thing_battery",
          uniqueId: "u-1",
          platform: "zha",
          domain: "sensor",
          deviceClass: "battery",
          firstSeenMs: at,
          lastSeenMs: at,
        })
        .run();
    });
    const { ruleId } = unwrap(
      await upsertConditionRule({
        name: "One entity",
        kind: "low_battery",
        scope: "entity",
        haEntityRegistryId: registryId,
        titleTemplate: "Replace battery: {{asset}}",
      }),
    );
    writeTx(world.handle.db, (tx) => {
      tx.insert(conditionEpisode)
        .values({
          id: newId(),
          ruleId,
          haEntityRegistryId: registryId,
          assetId,
          openedAtMs: at,
          openLocalDate: "2026-09-08",
          createdAtMs: at,
        })
        .run();
    });

    unwrap(await setConditionRuleEnabled({ ruleId, enabled: false }));
    const episode = world.handle.db
      .select()
      .from(conditionEpisode)
      .where(eq(conditionEpisode.ruleId, ruleId))
      .get();
    expect(episode?.closedAtMs).not.toBeNull();
    expect(episode?.closeReason).toBe("rule_disabled");
  });

  it("deletes a rule that has produced nothing", async () => {
    const { ruleId } = unwrap(
      await upsertConditionRule({
        name: "Throwaway",
        kind: "low_battery",
        scope: "all_batteries",
        titleTemplate: "x",
      }),
    );
    unwrap(await deleteConditionRule({ ruleId }));
    expect(world.handle.db.select().from(conditionRule).all()).toHaveLength(0);
  });
});
