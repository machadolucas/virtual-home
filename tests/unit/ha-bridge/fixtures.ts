/**
 * Seeding helpers for the HA persistence tests: the few household rows the registry cache reacts
 * to (assets, links, locations), plus a snapshot builder over `buildSampleRegistry()`.
 *
 * Rows go in with plain Drizzle inserts rather than through a service layer, because these tests
 * are about `src/server/ha/**` and the domain services are owned elsewhere.
 */
import { writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import { asset, assetHaLink, location } from "@/db/schema";
import type { HaLinkRole } from "@/db/schema/assets";
import type { RegistrySnapshotInput } from "@/server/ha/registryCache";
import type { FakeRegistry } from "../../helpers/fakeHa";

export const T0 = 1_760_000_000_000;

export function snapshotOf(registry: FakeRegistry): RegistrySnapshotInput {
  return {
    states: [...registry.states.values()],
    entities: registry.entities,
    devices: registry.devices,
    areas: registry.areas,
    floors: registry.floors,
  };
}

export function seedAsset(
  handle: DbHandle,
  input: { name: string; id?: string; locationId?: string | null },
): string {
  const id = input.id ?? newId();
  writeTx(handle.db, (tx) => {
    tx.insert(asset)
      .values({
        id,
        name: input.name,
        category: "other",
        status: "installed",
        locationId: input.locationId ?? null,
        createdAtMs: T0,
        updatedAtMs: T0,
      })
      .run();
  });
  return id;
}

export function linkEntity(
  handle: DbHandle,
  input: {
    assetId: string;
    registryId: string;
    entityIdSnapshot: string;
    role?: HaLinkRole;
    id?: string;
  },
): string {
  const id = input.id ?? newId();
  writeTx(handle.db, (tx) => {
    tx.insert(assetHaLink)
      .values({
        id,
        assetId: input.assetId,
        linkKind: "entity",
        haEntityRegistryId: input.registryId,
        role: input.role ?? "primary",
        entityIdSnapshot: input.entityIdSnapshot,
        linkState: "active",
        createdAtMs: T0,
        updatedAtMs: T0,
      })
      .run();
  });
  return id;
}

export function linkDevice(
  handle: DbHandle,
  input: { assetId: string; deviceId: string; role?: HaLinkRole; id?: string },
): string {
  const id = input.id ?? newId();
  writeTx(handle.db, (tx) => {
    tx.insert(assetHaLink)
      .values({
        id,
        assetId: input.assetId,
        linkKind: "device",
        haDeviceId: input.deviceId,
        role: input.role ?? "primary",
        linkState: "active",
        createdAtMs: T0,
        updatedAtMs: T0,
      })
      .run();
  });
  return id;
}

export interface SeededLocations {
  property: string;
  building: string;
  basement: string;
  ground: string;
  kitchen: string;
  technicalRoom: string;
}

/**
 * A spatial tree whose names deliberately mirror the sample HA registry — "Kitchen",
 * "Technical room", "Basement" — so the suggestion matcher has something to find.
 */
export function seedLocations(handle: DbHandle): SeededLocations {
  const ids: SeededLocations = {
    property: newId(),
    building: newId(),
    basement: newId(),
    ground: newId(),
    kitchen: newId(),
    technicalRoom: newId(),
  };
  const rows = [
    { id: ids.property, kind: "property" as const, parentId: null, name: "Home", slug: "home" },
    {
      id: ids.building,
      kind: "building" as const,
      parentId: ids.property,
      name: "Main house",
      slug: "main-house",
    },
    {
      id: ids.basement,
      kind: "floor" as const,
      parentId: ids.building,
      name: "Basement",
      slug: "basement",
      floorLevel: -1,
    },
    {
      id: ids.ground,
      kind: "floor" as const,
      parentId: ids.building,
      name: "Ground floor",
      slug: "ground-floor",
      floorLevel: 0,
    },
    {
      id: ids.kitchen,
      kind: "room" as const,
      parentId: ids.ground,
      name: "Kitchen",
      slug: "ground-kitchen",
    },
    {
      id: ids.technicalRoom,
      kind: "room" as const,
      parentId: ids.basement,
      name: "Technical room",
      slug: "basement-technical-room",
    },
  ];
  writeTx(handle.db, (tx) => {
    for (const row of rows) {
      tx.insert(location)
        .values({ ...row, createdAtMs: T0, updatedAtMs: T0 })
        .run();
    }
  });
  return ids;
}

/* -------------------------------------------------------------- assertions */

export function rows<T = Record<string, unknown>>(
  handle: DbHandle,
  sql: string,
  ...params: unknown[]
): T[] {
  return handle.sqlite.prepare(sql).all(...(params as never[])) as T[];
}

export function one<T = Record<string, unknown>>(
  handle: DbHandle,
  sql: string,
  ...params: unknown[]
): T | undefined {
  return handle.sqlite.prepare(sql).get(...(params as never[])) as T | undefined;
}
