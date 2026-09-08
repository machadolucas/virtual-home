import "server-only";
import { asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset,
  conditionRule,
  haArea,
  haEntity,
  haFloor,
  location,
  locationMapping,
  part,
} from "@/db/schema";
import type { MappingRow } from "@/features/settings/mapping";
import { deviceCountsByArea } from "./registry";

/**
 * Every HA area and floor in the cache, left-joined to its mapping decision.
 *
 * The list is driven by the *cache*, not by the mapping table, so an area nobody has decided about
 * still appears (as `undecided`). Driving it from `location_mapping` would hide exactly the rows
 * that need attention.
 */
export function listLocationMappings(tx: Db): MappingRow[] {
  const deviceCounts = deviceCountsByArea(tx);

  const floorNames = new Map(
    tx
      .select({ floorId: haFloor.floorId, name: haFloor.name })
      .from(haFloor)
      .all()
      .map((row) => [row.floorId, row.name]),
  );

  const decisions = new Map<
    string,
    {
      id: string;
      locationId: string;
      locationName: string;
      source: MappingRow["source"];
      confidence: number | null;
      matchReason: string | null;
      decidedAtMs: number | null;
    }
  >();
  for (const row of tx
    .select({
      id: locationMapping.id,
      haKind: locationMapping.haKind,
      haId: locationMapping.haId,
      locationId: location.id,
      locationName: location.name,
      source: locationMapping.source,
      confidence: locationMapping.confidence,
      matchReason: locationMapping.matchReason,
      decidedAtMs: locationMapping.decidedAtMs,
    })
    .from(locationMapping)
    .innerJoin(location, eq(location.id, locationMapping.locationId))
    .all()) {
    decisions.set(`${row.haKind}:${row.haId}`, {
      id: row.id,
      locationId: row.locationId,
      locationName: row.locationName,
      source: row.source,
      confidence: row.confidence,
      matchReason: row.matchReason,
      decidedAtMs: row.decidedAtMs,
    });
  }

  const rows: MappingRow[] = [];

  for (const floor of tx
    .select()
    .from(haFloor)
    .where(isNull(haFloor.removedAtMs))
    .orderBy(asc(haFloor.level), asc(haFloor.name))
    .all()) {
    const decision = decisions.get(`floor:${floor.floorId}`);
    rows.push({
      id: decision?.id ?? null,
      haKind: "floor",
      haId: floor.floorId,
      haName: floor.name,
      haFloorId: null,
      haFloorName: null,
      deviceCount: 0,
      locationId: decision?.locationId ?? null,
      locationName: decision?.locationName ?? null,
      source: decision?.source ?? null,
      confidence: decision?.confidence ?? null,
      matchReason: decision?.matchReason ?? null,
      decidedAtMs: decision?.decidedAtMs ?? null,
    });
  }

  for (const area of tx
    .select()
    .from(haArea)
    .where(isNull(haArea.removedAtMs))
    .orderBy(asc(haArea.name))
    .all()) {
    const decision = decisions.get(`area:${area.areaId}`);
    rows.push({
      id: decision?.id ?? null,
      haKind: "area",
      haId: area.areaId,
      haName: area.name,
      haFloorId: area.floorId,
      haFloorName: area.floorId === null ? null : (floorNames.get(area.floorId) ?? null),
      deviceCount: deviceCounts.get(area.areaId) ?? 0,
      locationId: decision?.locationId ?? null,
      locationName: decision?.locationName ?? null,
      source: decision?.source ?? null,
      confidence: decision?.confidence ?? null,
      matchReason: decision?.matchReason ?? null,
      decidedAtMs: decision?.decidedAtMs ?? null,
    });
  }

  return rows;
}

export interface ConditionRuleListRow {
  id: string;
  name: string;
  kind: string;
  scope: string;
  enabled: boolean;
  thresholdPct: number | null;
  clearThresholdPct: number | null;
  sustainMinutes: number | null;
  clearSustainMinutes: number | null;
  assetId: string | null;
  assetName: string | null;
  haEntityRegistryId: string | null;
  entityId: string | null;
  defaultPartId: string | null;
  defaultPartName: string | null;
  titleTemplate: string;
  priority: string;
}

/**
 * Every condition rule, joined to what it watches and what it consumes.
 *
 * A rule with `scope='all_batteries'` watches every canonical battery entity; a rule scoped to an
 * asset or an entity is the exception a person configured. Both are listed together because the
 * question the page answers is "what turns readings into work here".
 */
export function listConditionRules(tx: Db): ConditionRuleListRow[] {
  return tx
    .select({
      id: conditionRule.id,
      name: conditionRule.name,
      kind: conditionRule.kind,
      scope: conditionRule.scope,
      enabled: conditionRule.enabled,
      thresholdPct: conditionRule.thresholdPct,
      clearThresholdPct: conditionRule.clearThresholdPct,
      sustainMinutes: conditionRule.sustainMinutes,
      clearSustainMinutes: conditionRule.clearSustainMinutes,
      assetId: conditionRule.assetId,
      assetName: asset.name,
      haEntityRegistryId: conditionRule.haEntityRegistryId,
      entityId: haEntity.entityId,
      defaultPartId: conditionRule.defaultPartId,
      defaultPartName: part.name,
      titleTemplate: conditionRule.titleTemplate,
      priority: conditionRule.priority,
    })
    .from(conditionRule)
    .leftJoin(asset, eq(asset.id, conditionRule.assetId))
    .leftJoin(haEntity, eq(haEntity.registryId, conditionRule.haEntityRegistryId))
    .leftJoin(part, eq(part.id, conditionRule.defaultPartId))
    .orderBy(asc(conditionRule.kind), asc(conditionRule.name))
    .all();
}
