import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset,
  assetHaLink,
  haArea,
  haDevice,
  haEntity,
  haEntityState,
  haFloor,
  location,
  locationMapping,
} from "@/db/schema";

export interface RegistryEntityRow {
  registryId: string;
  entityId: string;
  domain: string;
  name: string | null;
  originalName: string | null;
  deviceClass: string | null;
  unitOfMeasurement: string | null;
  entityCategory: string | null;
  disabledBy: string | null;
  hiddenBy: string | null;
  platform: string | null;
  uniqueId: string | null;
  areaId: string | null;
  /** Latest cached state, verbatim. `null` when this entity is not in the state cache. */
  state: string | null;
  stateLastUpdatedMs: number | null;
  /** Equipment already linked to this entity, if any. */
  linkedAssetId: string | null;
  linkedAssetName: string | null;
}

export interface RegistryDeviceRow {
  deviceId: string;
  name: string | null;
  nameByUser: string | null;
  manufacturer: string | null;
  model: string | null;
  swVersion: string | null;
  hwVersion: string | null;
  areaId: string | null;
  areaName: string | null;
  /** `'service'` marks a software device — an integration, not a thing you can touch. */
  entryType: string | null;
  disabledBy: string | null;
  canonicalBatteryEntityId: string | null;
  entityCount: number;
  /** Entities of this device that are neither diagnostic/config nor disabled/hidden. */
  visibleEntityCount: number;
  linkedAssetId: string | null;
  linkedAssetName: string | null;
  /** The location a confirmed mapping (or a suggestion) puts this device's area in. */
  suggestedLocationId: string | null;
  suggestedLocationName: string | null;
  suggestedLocationSource: "confirmed" | "suggested" | null;
}

export interface RegistryAreaGroup {
  floorId: string | null;
  floorName: string;
  floorLevel: number | null;
  areas: {
    areaId: string | null;
    areaName: string;
    devices: RegistryDeviceRow[];
  }[];
}

export interface RegistryBrowseOptions {
  /** Include `entity_category IN ('diagnostic','config')` and disabled/hidden entities. */
  includeHidden: boolean;
  /** Case-insensitive substring across device and entity names/ids. */
  query: string;
}

export interface RegistryBrowseResult {
  groups: RegistryAreaGroup[];
  deviceCount: number;
  /** Devices the filter removed, so the toggle can say what it is hiding. */
  hiddenDeviceCount: number;
  /** True when the registry cache is empty — the worker has never synced. */
  cacheEmpty: boolean;
}

function normalise(value: string): string {
  return value.toLowerCase();
}

/**
 * Browse the cached registry by HA floor -> area -> device.
 *
 * Everything here reads the cache, never Home Assistant: the web process has no socket (§7.1), and
 * a settings page that blocked on a WebSocket round-trip would be unusable while HA is down. An
 * empty cache is reported as such rather than as "no devices".
 */
export function browseRegistry(
  tx: Db,
  options: RegistryBrowseOptions,
): RegistryBrowseResult {
  const devices = tx
    .select()
    .from(haDevice)
    .where(isNull(haDevice.removedAtMs))
    .orderBy(asc(haDevice.name))
    .all();

  if (devices.length === 0) {
    return { groups: [], deviceCount: 0, hiddenDeviceCount: 0, cacheEmpty: true };
  }

  const areas = tx.select().from(haArea).where(isNull(haArea.removedAtMs)).all();
  const areaById = new Map(areas.map((row) => [row.areaId, row]));
  const floors = tx.select().from(haFloor).where(isNull(haFloor.removedAtMs)).all();
  const floorById = new Map(floors.map((row) => [row.floorId, row]));

  const mappings = readAreaMappings(tx);

  const deviceIds = devices.map((row) => row.deviceId);
  const entityCounts = new Map<string, { total: number; visible: number }>();
  for (const row of tx
    .select({
      deviceId: haEntity.deviceId,
      entityCategory: haEntity.entityCategory,
      disabledBy: haEntity.disabledBy,
      hiddenBy: haEntity.hiddenBy,
    })
    .from(haEntity)
    .where(and(isNull(haEntity.removedAtMs), inArray(haEntity.deviceId, deviceIds)))
    .all()) {
    if (row.deviceId === null) continue;
    const current = entityCounts.get(row.deviceId) ?? { total: 0, visible: 0 };
    current.total += 1;
    if (isVisibleEntity(row)) current.visible += 1;
    entityCounts.set(row.deviceId, current);
  }

  const linkedByDevice = new Map<string, { id: string; name: string }>();
  for (const row of tx
    .select({ deviceId: assetHaLink.haDeviceId, id: asset.id, name: asset.name })
    .from(assetHaLink)
    .innerJoin(asset, eq(asset.id, assetHaLink.assetId))
    .where(inArray(assetHaLink.linkState, ["active", "renamed"]))
    .all()) {
    if (row.deviceId === null) continue;
    if (!linkedByDevice.has(row.deviceId)) linkedByDevice.set(row.deviceId, row);
  }
  // A device whose *entities* are linked counts as linked too, which is the common case.
  for (const row of tx
    .select({ deviceId: haEntity.deviceId, id: asset.id, name: asset.name })
    .from(assetHaLink)
    .innerJoin(haEntity, eq(haEntity.registryId, assetHaLink.haEntityRegistryId))
    .innerJoin(asset, eq(asset.id, assetHaLink.assetId))
    .where(inArray(assetHaLink.linkState, ["active", "renamed"]))
    .all()) {
    if (row.deviceId === null) continue;
    if (!linkedByDevice.has(row.deviceId)) linkedByDevice.set(row.deviceId, row);
  }

  const needle = normalise(options.query.trim());
  let hiddenDeviceCount = 0;

  const rows: RegistryDeviceRow[] = [];
  for (const device of devices) {
    const area = device.areaId === null ? null : (areaById.get(device.areaId) ?? null);
    const counts = entityCounts.get(device.deviceId) ?? { total: 0, visible: 0 };

    if (!options.includeHidden && device.disabledBy !== null) {
      hiddenDeviceCount += 1;
      continue;
    }
    if (!options.includeHidden && counts.visible === 0 && counts.total > 0) {
      // Every entity is diagnostic/config or disabled: nothing here maps to equipment.
      hiddenDeviceCount += 1;
      continue;
    }

    if (needle !== "") {
      const haystack = normalise(
        [
          device.nameByUser ?? "",
          device.name ?? "",
          device.manufacturer ?? "",
          device.model ?? "",
          area?.name ?? "",
        ].join(" "),
      );
      if (!haystack.includes(needle)) continue;
    }

    const mapping = device.areaId === null ? undefined : mappings.get(device.areaId);
    const linked = linkedByDevice.get(device.deviceId) ?? null;

    rows.push({
      deviceId: device.deviceId,
      name: device.name,
      nameByUser: device.nameByUser,
      manufacturer: device.manufacturer,
      model: device.model,
      swVersion: device.swVersion,
      hwVersion: device.hwVersion,
      areaId: device.areaId,
      areaName: area?.name ?? null,
      entryType: device.entryType,
      disabledBy: device.disabledBy,
      canonicalBatteryEntityId: device.canonicalBatteryEntityId,
      entityCount: counts.total,
      visibleEntityCount: counts.visible,
      linkedAssetId: linked?.id ?? null,
      linkedAssetName: linked?.name ?? null,
      suggestedLocationId: mapping?.locationId ?? null,
      suggestedLocationName: mapping?.locationName ?? null,
      suggestedLocationSource: mapping?.source ?? null,
    });
  }

  // floor -> area -> devices
  const groups = new Map<string, RegistryAreaGroup>();
  for (const row of rows) {
    const area = row.areaId === null ? null : (areaById.get(row.areaId) ?? null);
    const floor = area?.floorId == null ? null : (floorById.get(area.floorId) ?? null);
    const floorKey = floor?.floorId ?? "";
    const group = groups.get(floorKey) ?? {
      floorId: floor?.floorId ?? null,
      floorName: floor?.name ?? "No floor",
      floorLevel: floor?.level ?? null,
      areas: [],
    };
    const areaKey = row.areaId ?? "";
    let areaGroup = group.areas.find((entry) => (entry.areaId ?? "") === areaKey);
    if (!areaGroup) {
      areaGroup = { areaId: row.areaId, areaName: area?.name ?? "No area", devices: [] };
      group.areas.push(areaGroup);
    }
    areaGroup.devices.push(row);
    groups.set(floorKey, group);
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.floorId === null) return 1;
    if (b.floorId === null) return -1;
    if (a.floorLevel !== b.floorLevel) return (a.floorLevel ?? 0) - (b.floorLevel ?? 0);
    return a.floorName.localeCompare(b.floorName);
  });
  for (const group of ordered) {
    group.areas.sort((a, b) => {
      if (a.areaId === null) return 1;
      if (b.areaId === null) return -1;
      return a.areaName.localeCompare(b.areaName);
    });
  }

  return {
    groups: ordered,
    deviceCount: rows.length,
    hiddenDeviceCount,
    cacheEmpty: false,
  };
}

function isVisibleEntity(row: {
  entityCategory: string | null;
  disabledBy: string | null;
  hiddenBy: string | null;
}): boolean {
  if (row.disabledBy !== null || row.hiddenBy !== null) return false;
  return row.entityCategory !== "diagnostic" && row.entityCategory !== "config";
}

/**
 * The entities of one device, for the "which entities do I link, and as what" step.
 *
 * The state is joined in because it is the only way a person can tell `sensor.temperature_2` from
 * `sensor.temperature_3`, and it is shown verbatim — `unavailable` stays `unavailable`.
 */
export function readDeviceEntities(
  tx: Db,
  deviceId: string,
  options: { includeHidden: boolean },
): RegistryEntityRow[] {
  const rows = tx
    .select({
      registryId: haEntity.registryId,
      entityId: haEntity.entityId,
      domain: haEntity.domain,
      name: haEntity.name,
      originalName: haEntity.originalName,
      deviceClass: haEntity.deviceClass,
      unitOfMeasurement: haEntity.unitOfMeasurement,
      entityCategory: haEntity.entityCategory,
      disabledBy: haEntity.disabledBy,
      hiddenBy: haEntity.hiddenBy,
      platform: haEntity.platform,
      uniqueId: haEntity.uniqueId,
      areaId: haEntity.areaId,
      state: haEntityState.state,
      stateLastUpdatedMs: haEntityState.lastUpdatedMs,
    })
    .from(haEntity)
    .leftJoin(haEntityState, eq(haEntityState.registryId, haEntity.registryId))
    .where(and(eq(haEntity.deviceId, deviceId), isNull(haEntity.removedAtMs)))
    .orderBy(asc(haEntity.domain), asc(haEntity.entityId))
    .all();

  const registryIds = rows.map((row) => row.registryId);
  const linked = new Map<string, { id: string; name: string }>();
  if (registryIds.length > 0) {
    for (const row of tx
      .select({
        registryId: assetHaLink.haEntityRegistryId,
        id: asset.id,
        name: asset.name,
      })
      .from(assetHaLink)
      .innerJoin(asset, eq(asset.id, assetHaLink.assetId))
      .where(inArray(assetHaLink.haEntityRegistryId, registryIds))
      .all()) {
      if (row.registryId === null) continue;
      linked.set(row.registryId, row);
    }
  }

  return rows
    .filter((row) => options.includeHidden || isVisibleEntity(row))
    .map((row) => ({
      ...row,
      linkedAssetId: linked.get(row.registryId)?.id ?? null,
      linkedAssetName: linked.get(row.registryId)?.name ?? null,
    }));
}

export function readDevice(tx: Db, deviceId: string) {
  return (
    tx
      .select({
        deviceId: haDevice.deviceId,
        name: haDevice.name,
        nameByUser: haDevice.nameByUser,
        manufacturer: haDevice.manufacturer,
        model: haDevice.model,
        swVersion: haDevice.swVersion,
        hwVersion: haDevice.hwVersion,
        areaId: haDevice.areaId,
        areaName: haArea.name,
        entryType: haDevice.entryType,
        disabledBy: haDevice.disabledBy,
        canonicalBatteryEntityId: haDevice.canonicalBatteryEntityId,
        removedAtMs: haDevice.removedAtMs,
      })
      .from(haDevice)
      .leftJoin(haArea, eq(haArea.areaId, haDevice.areaId))
      .where(eq(haDevice.deviceId, deviceId))
      .get() ?? null
  );
}

/** `area_id` -> the location it maps to, confirmed first. */
export function readAreaMappings(
  tx: Db,
): Map<
  string,
  { locationId: string; locationName: string; source: "confirmed" | "suggested" }
> {
  const out = new Map<
    string,
    { locationId: string; locationName: string; source: "confirmed" | "suggested" }
  >();
  for (const row of tx
    .select({
      haId: locationMapping.haId,
      source: locationMapping.source,
      locationId: location.id,
      locationName: location.name,
    })
    .from(locationMapping)
    .innerJoin(location, eq(location.id, locationMapping.locationId))
    .where(
      and(
        eq(locationMapping.haKind, "area"),
        inArray(locationMapping.source, ["confirmed", "suggested"]),
      ),
    )
    .all()) {
    const existing = out.get(row.haId);
    if (existing?.source === "confirmed") continue;
    out.set(row.haId, {
      locationId: row.locationId,
      locationName: row.locationName,
      source: row.source === "confirmed" ? "confirmed" : "suggested",
    });
  }
  return out;
}

/** Devices the `mobile_app` integration registered — the notify-service candidates. */
export function readMobileAppDevices(
  tx: Db,
): { deviceId: string; displayName: string; model: string | null }[] {
  const deviceIds = tx
    .selectDistinct({ deviceId: haEntity.deviceId })
    .from(haEntity)
    .where(and(eq(haEntity.platform, "mobile_app"), isNull(haEntity.removedAtMs)))
    .all()
    .map((row) => row.deviceId)
    .filter((value): value is string => value !== null);

  if (deviceIds.length === 0) return [];

  return tx
    .select({
      deviceId: haDevice.deviceId,
      name: haDevice.name,
      nameByUser: haDevice.nameByUser,
      model: haDevice.model,
    })
    .from(haDevice)
    .where(and(inArray(haDevice.deviceId, deviceIds), isNull(haDevice.removedAtMs)))
    .orderBy(asc(haDevice.name))
    .all()
    .map((row) => ({
      deviceId: row.deviceId,
      displayName: row.nameByUser ?? row.name ?? row.deviceId,
      model: row.model,
    }));
}

/** How many cached devices sit in each HA area — the "is this worth mapping" signal. */
export function deviceCountsByArea(tx: Db): Map<string, number> {
  return new Map(
    tx
      .select({ areaId: haDevice.areaId, n: sql<number>`count(*)` })
      .from(haDevice)
      .where(isNull(haDevice.removedAtMs))
      .groupBy(haDevice.areaId)
      .all()
      .flatMap((row) => (row.areaId === null ? [] : [[row.areaId, row.n] as const])),
  );
}

export interface LinkableEntity {
  registryId: string;
  entityId: string;
  domain: string;
  deviceClass: string | null;
  unitOfMeasurement: string | null;
  deviceName: string | null;
  areaName: string | null;
  state: string | null;
  linkedAssetName: string | null;
}

/**
 * Live, non-diagnostic entities a person could sensibly link to a piece of equipment.
 *
 * Capped, because a household instance has thousands of entities and this feeds a `Select`. The
 * cap is generous enough to cover every instance we expect and the caller says when it bites, so
 * a truncated list is never silently a complete one.
 */
export function listLinkableEntities(
  tx: Db,
  options: { limit?: number; includeHidden?: boolean } = {},
): { entities: LinkableEntity[]; truncated: boolean } {
  const limit = options.limit ?? 500;
  const rows = tx
    .select({
      registryId: haEntity.registryId,
      entityId: haEntity.entityId,
      domain: haEntity.domain,
      deviceClass: haEntity.deviceClass,
      unitOfMeasurement: haEntity.unitOfMeasurement,
      entityCategory: haEntity.entityCategory,
      disabledBy: haEntity.disabledBy,
      hiddenBy: haEntity.hiddenBy,
      deviceName: haDevice.name,
      deviceNameByUser: haDevice.nameByUser,
      areaName: haArea.name,
      state: haEntityState.state,
    })
    .from(haEntity)
    .leftJoin(haDevice, eq(haDevice.deviceId, haEntity.deviceId))
    .leftJoin(haArea, eq(haArea.areaId, haDevice.areaId))
    .leftJoin(haEntityState, eq(haEntityState.registryId, haEntity.registryId))
    .where(isNull(haEntity.removedAtMs))
    .orderBy(asc(haEntity.entityId))
    .limit(limit + 1)
    .all()
    .filter(
      (row) =>
        options.includeHidden === true ||
        (row.disabledBy === null &&
          row.hiddenBy === null &&
          row.entityCategory !== "diagnostic" &&
          row.entityCategory !== "config"),
    );

  const linked = new Map<string, string>();
  for (const row of tx
    .select({ registryId: assetHaLink.haEntityRegistryId, name: asset.name })
    .from(assetHaLink)
    .innerJoin(asset, eq(asset.id, assetHaLink.assetId))
    .all()) {
    if (row.registryId !== null) linked.set(row.registryId, row.name);
  }

  const truncated = rows.length > limit;
  return {
    truncated,
    entities: rows.slice(0, limit).map((row) => ({
      registryId: row.registryId,
      entityId: row.entityId,
      domain: row.domain,
      deviceClass: row.deviceClass,
      unitOfMeasurement: row.unitOfMeasurement,
      deviceName: row.deviceNameByUser ?? row.deviceName,
      areaName: row.areaName,
      state: row.state,
      linkedAssetName: linked.get(row.registryId) ?? null,
    })),
  };
}
