import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset,
  assetHaLink,
  conditionSignal,
  haEntity,
  haEntityState,
  location,
  maintenanceOccurrence,
  type AssetCategory,
  type AssetStatus,
  type HaLinkState,
} from "@/db/schema";
import { batteryDisplay, type BatteryDisplay } from "@/features/assets/battery";

export interface EquipmentListRow {
  id: string;
  name: string;
  category: AssetCategory;
  status: AssetStatus;
  manufacturer: string | null;
  modelName: string | null;
  isVirtual: boolean;
  locationId: string | null;
  locationName: string | null;
  /** `floor > room` trail, for grouping. */
  locationPath: string | null;
  /** Worst link state among this asset's links, or null when it has none (the normal case). */
  linkState: HaLinkState | null;
  linkCount: number;
  battery: BatteryDisplay | null;
  openTaskCount: number;
  overdueTaskCount: number;
}

export interface EquipmentGroup {
  locationId: string | null;
  locationName: string;
  rows: EquipmentListRow[];
}

export interface EquipmentListResult {
  groups: EquipmentGroup[];
  total: number;
  /** True when there is no equipment at all. */
  isEmpty: boolean;
}

/** How alarming a link state is, so a row can show the one that needs attention. */
const LINK_STATE_SEVERITY: Record<HaLinkState, number> = {
  missing: 4,
  renamed: 3,
  replaced: 2,
  retired: 1,
  active: 0,
};

export interface ListEquipmentOptions {
  nowMs: number;
  batteryThresholdPct: number;
  batteryStaleHours: number;
  /** Include units that were replaced or retired. Off by default: the list is about what is here. */
  includeHistoric?: boolean;
}

/**
 * `/equipment`, grouped by location.
 *
 * Battery comes from the canonical battery entity reached through the asset's `battery_level`
 * link, and it is `null` when there is no such link — a piece of equipment with no battery is not
 * a piece of equipment at 0 %.
 */
export function listEquipment(tx: Db, options: ListEquipmentOptions): EquipmentListResult {
  const rows = tx
    .select({
      id: asset.id,
      name: asset.name,
      category: asset.category,
      status: asset.status,
      manufacturer: asset.manufacturer,
      modelName: asset.modelName,
      isVirtual: asset.isVirtual,
      locationId: asset.locationId,
      locationName: location.name,
      locationKind: location.kind,
      parentLocationId: location.parentId,
    })
    .from(asset)
    .leftJoin(location, eq(location.id, asset.locationId))
    .where(
      options.includeHistoric === true
        ? undefined
        : and(isNull(asset.replacedByAssetId), inArray(asset.status, ["planned", "installed"])),
    )
    .orderBy(asc(location.name), asc(asset.name))
    .all();

  if (rows.length === 0) return { groups: [], total: 0, isEmpty: true };

  const assetIds = rows.map((row) => row.id);
  const parentNames = new Map(
    tx.select({ id: location.id, name: location.name }).from(location).all().map((r) => [r.id, r.name]),
  );

  // Link state and count per asset.
  const links = new Map<string, { worst: HaLinkState | null; count: number }>();
  const batteryLinks = new Map<string, string>();
  for (const link of tx
    .select({
      assetId: assetHaLink.assetId,
      role: assetHaLink.role,
      linkState: assetHaLink.linkState,
      entityId: haEntity.entityId,
      registryId: haEntity.registryId,
    })
    .from(assetHaLink)
    .leftJoin(haEntity, eq(haEntity.registryId, assetHaLink.haEntityRegistryId))
    .where(inArray(assetHaLink.assetId, assetIds))
    .all()) {
    const current = links.get(link.assetId) ?? { worst: null, count: 0 };
    current.count += 1;
    if (
      current.worst === null ||
      LINK_STATE_SEVERITY[link.linkState] > LINK_STATE_SEVERITY[current.worst]
    ) {
      current.worst = link.linkState;
    }
    links.set(link.assetId, current);
    if (link.role === "battery_level" && link.entityId !== null && link.linkState === "active") {
      batteryLinks.set(link.assetId, link.entityId);
    }
  }

  const entityIds = [...batteryLinks.values()];
  const states = new Map<string, { state: string; lastUpdatedMs: number; isStale: boolean }>();
  if (entityIds.length > 0) {
    for (const row of tx
      .select({
        entityId: haEntityState.entityId,
        state: haEntityState.state,
        lastUpdatedMs: haEntityState.lastUpdatedMs,
        isStale: conditionSignal.isStale,
      })
      .from(haEntityState)
      .leftJoin(conditionSignal, eq(conditionSignal.haEntityRegistryId, haEntityState.registryId))
      .where(inArray(haEntityState.entityId, entityIds))
      .all()) {
      states.set(row.entityId, {
        state: row.state,
        lastUpdatedMs: row.lastUpdatedMs,
        isStale: row.isStale ?? false,
      });
    }
  }

  const tasks = new Map<string, { open: number; overdue: number }>();
  for (const row of tx
    .select({
      assetId: maintenanceOccurrence.assetId,
      status: maintenanceOccurrence.status,
      n: sql<number>`count(*)`,
    })
    .from(maintenanceOccurrence)
    .where(
      and(
        inArray(maintenanceOccurrence.assetId, assetIds),
        inArray(maintenanceOccurrence.status, ["pending", "due"]),
      ),
    )
    .groupBy(maintenanceOccurrence.assetId, maintenanceOccurrence.status)
    .all()) {
    if (row.assetId === null) continue;
    const current = tasks.get(row.assetId) ?? { open: 0, overdue: 0 };
    current.open += row.n;
    if (row.status === "due") current.overdue += row.n;
    tasks.set(row.assetId, current);
  }

  const listRows: EquipmentListRow[] = rows.map((row) => {
    const entityId = batteryLinks.get(row.id);
    const reading = entityId === undefined ? undefined : states.get(entityId);
    const link = links.get(row.id);
    const task = tasks.get(row.id);
    const parentName =
      row.parentLocationId === null ? null : (parentNames.get(row.parentLocationId) ?? null);
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      status: row.status,
      manufacturer: row.manufacturer,
      modelName: row.modelName,
      isVirtual: row.isVirtual,
      locationId: row.locationId,
      locationName: row.locationName,
      locationPath:
        row.locationName === null
          ? null
          : parentName === null
            ? row.locationName
            : `${parentName} · ${row.locationName}`,
      linkState: link?.worst ?? null,
      linkCount: link?.count ?? 0,
      battery:
        entityId === undefined
          ? null
          : batteryDisplay({
              rawState: reading?.state ?? null,
              lastUpdatedMs: reading?.lastUpdatedMs ?? null,
              isStale: reading?.isStale,
              thresholdPct: options.batteryThresholdPct,
              staleHours: options.batteryStaleHours,
              nowMs: options.nowMs,
            }),
      openTaskCount: task?.open ?? 0,
      overdueTaskCount: task?.overdue ?? 0,
    };
  });

  const byLocation = new Map<string, EquipmentGroup>();
  for (const row of listRows) {
    const key = row.locationId ?? "";
    const group = byLocation.get(key) ?? {
      locationId: row.locationId,
      locationName: row.locationName ?? "No location",
      rows: [],
    };
    group.rows.push(row);
    byLocation.set(key, group);
  }

  const groups = [...byLocation.values()].sort((a, b) => {
    // "No location" last: it is the group that needs a decision, not the one you browse.
    if (a.locationId === null) return 1;
    if (b.locationId === null) return -1;
    return a.locationName.localeCompare(b.locationName);
  });

  return { groups, total: listRows.length, isEmpty: false };
}

/** Locations for the equipment form and the systems editor. */
export function listLocationOptions(
  tx: Db,
): { id: string; name: string; kind: string; parentName: string | null }[] {
  const rows = tx.select().from(location).orderBy(asc(location.sortOrder), asc(location.name)).all();
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentName: row.parentId === null ? null : (names.get(row.parentId) ?? null),
  }));
}
