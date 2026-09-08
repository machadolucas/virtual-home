import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset,
  kitComponent,
  location,
  part,
  partCompatibility,
  partLot,
  partStock,
  storagePlace,
  type PartTrackingMode,
  type PartUnit,
} from "@/db/schema";
import { reorderSuggestions, type ReorderSuggestion } from "@/domain/reorder";
import { addDaysLocal, type LocalDate } from "@/domain/time";
import { EXPIRY_HORIZON_DAYS, type FilterableSupply } from "@/features/inventory/filter";

/**
 * One row of `/supplies`.
 *
 * It carries the reorder verdict rather than recomputing it in the page, because
 * `reorderSuggestions` is the single place that knows how demand is resolved — the list must agree
 * with the shopping list and with what a completion will refuse to do.
 */
export interface SupplyListRow extends FilterableSupply {
  unit: PartUnit;
  trackingMode: PartTrackingMode;
  stocked: boolean;
  tracksLots: boolean;
  reorderThresholdMilli: number | null;
  reorderTargetMilli: number | null;
  leadTimeDays: number | null;
  /** From `reorderSuggestions`; null for a part it does not consider (`not_stocked` kits). */
  reason: string | null;
  expectedDemandMilli: number;
  projectedBalanceMilli: number;
  suggestedOrderMilli: number;
  demandTaskCount: number;
  /** Number of components, for a kit. */
  componentCount: number;
  openLotCount: number;
  /** `estimate_pct` of the open lot, for an `estimated` part. */
  openLotEstimatePct: number | null;
  lastMovementMs: number | null;
}

export interface SupplyListResult {
  rows: SupplyListRow[];
  today: LocalDate;
  expiryHorizonEnd: LocalDate;
  horizonDays: number;
  /** True when the household has no parts at all — the difference between empty and filtered-out. */
  isEmpty: boolean;
}

/**
 * Everything `/supplies` needs, in a handful of set-based queries rather than one per part.
 *
 * Archived parts are excluded: an archived part is history, and history lives in the ledger of the
 * part detail page, not on a shopping-oriented list.
 */
export function listSupplies(
  tx: Db,
  options: { today: LocalDate; horizonDays: number },
): SupplyListResult {
  const { today, horizonDays } = options;
  const parts = tx
    .select()
    .from(part)
    .where(isNull(part.archivedAtMs))
    .orderBy(asc(part.name), asc(part.id))
    .all();

  if (parts.length === 0) {
    return {
      rows: [],
      today,
      expiryHorizonEnd: addDaysLocal(today, EXPIRY_HORIZON_DAYS),
      horizonDays,
      isEmpty: true,
    };
  }

  const partIds = parts.map((row) => row.id);
  const suggestions = new Map<string, ReorderSuggestion>();
  for (const suggestion of reorderSuggestions(tx, { horizonDays, today })) {
    suggestions.set(suggestion.partId, suggestion);
  }

  const stock = new Map<string, { onHandMilli: number; lastMovementMs: number | null }>();
  for (const row of tx
    .select()
    .from(partStock)
    .where(inArray(partStock.partId, partIds))
    .all()) {
    stock.set(row.partId, {
      onHandMilli: row.onHandMilli,
      lastMovementMs: row.lastMovementMs ?? null,
    });
  }

  const places = new Map<string, string>();
  for (const row of tx
    .select({ id: storagePlace.id, name: storagePlace.name, locationName: location.name })
    .from(storagePlace)
    .leftJoin(location, eq(location.id, storagePlace.locationId))
    .all()) {
    places.set(row.id, row.locationName ? `${row.name} · ${row.locationName}` : row.name);
  }

  const compatible = new Map<string, string[]>();
  for (const row of tx
    .select({
      partId: partCompatibility.partId,
      assetName: asset.name,
      modelName: partCompatibility.assetModelName,
    })
    .from(partCompatibility)
    .leftJoin(asset, eq(asset.id, partCompatibility.assetId))
    .where(inArray(partCompatibility.partId, partIds))
    .all()) {
    const label = row.assetName ?? row.modelName;
    if (!label) continue;
    compatible.set(row.partId, [...(compatible.get(row.partId) ?? []), label]);
  }

  const componentCounts = new Map<string, number>();
  for (const row of tx
    .select({ kitPartId: kitComponent.kitPartId, n: sql<number>`count(*)` })
    .from(kitComponent)
    .groupBy(kitComponent.kitPartId)
    .all()) {
    componentCounts.set(row.kitPartId, row.n);
  }

  const lotSummary = new Map<
    string,
    { earliestExpiry: string | null; openCount: number; openEstimatePct: number | null }
  >();
  for (const row of tx
    .select()
    .from(partLot)
    .where(inArray(partLot.partId, partIds))
    .orderBy(asc(partLot.partId), asc(partLot.expiresOn))
    .all()) {
    const current = lotSummary.get(row.partId) ?? {
      earliestExpiry: null,
      openCount: 0,
      openEstimatePct: null,
    };
    if (row.expiresOn !== null) {
      current.earliestExpiry =
        current.earliestExpiry === null || row.expiresOn < current.earliestExpiry
          ? row.expiresOn
          : current.earliestExpiry;
    }
    if (row.isOpen) {
      current.openCount += 1;
      if (current.openEstimatePct === null) current.openEstimatePct = row.estimatePct;
    }
    lotSummary.set(row.partId, current);
  }

  const rows: SupplyListRow[] = parts.map((row) => {
    const suggestion = suggestions.get(row.id);
    const level = stock.get(row.id);
    const lots = lotSummary.get(row.id);
    return {
      partId: row.id,
      name: row.name,
      spec: row.spec,
      manufacturer: row.manufacturer,
      productCode: row.productCode,
      storagePlaceName:
        row.defaultStoragePlaceId === null
          ? null
          : (places.get(row.defaultStoragePlaceId) ?? null),
      compatibleAssetNames: compatible.get(row.id) ?? [],
      isKit: row.isKit,
      unit: row.unit,
      trackingMode: row.trackingMode,
      stocked: row.stockMode === "stocked",
      tracksLots: row.tracksLots,
      onHandMilli: suggestion?.onHandMilli ?? level?.onHandMilli ?? 0,
      lastMovementMs: level?.lastMovementMs ?? null,
      suggest: suggestion?.suggest ?? false,
      reason: suggestion?.reason ?? null,
      expectedDemandMilli: suggestion?.expectedDemandMilli ?? 0,
      projectedBalanceMilli:
        suggestion?.projectedBalanceMilli ?? level?.onHandMilli ?? 0,
      suggestedOrderMilli: suggestion?.suggestedOrderMilli ?? 0,
      demandTaskCount: suggestion?.demandSources.length ?? 0,
      reorderThresholdMilli: row.reorderThresholdMilli,
      reorderTargetMilli: row.reorderTargetMilli,
      leadTimeDays: row.leadTimeDays,
      componentCount: componentCounts.get(row.id) ?? 0,
      earliestExpiry: lots?.earliestExpiry ?? null,
      openLotCount: lots?.openCount ?? 0,
      openLotEstimatePct: lots?.openEstimatePct ?? null,
    };
  });

  return {
    rows,
    today,
    expiryHorizonEnd: addDaysLocal(today, EXPIRY_HORIZON_DAYS),
    horizonDays,
    isEmpty: false,
  };
}

/** Storage places for the part form, deepest label first so a nested bin reads sensibly. */
export function listStoragePlaces(
  tx: Db,
): { id: string; name: string; locationName: string | null }[] {
  return tx
    .select({
      id: storagePlace.id,
      name: storagePlace.name,
      locationName: location.name,
    })
    .from(storagePlace)
    .leftJoin(location, eq(location.id, storagePlace.locationId))
    .orderBy(asc(location.name), asc(storagePlace.name))
    .all();
}

/** Non-archived parts, for pickers (kit components, consumables, condition-rule defaults). */
export function listPartOptions(
  tx: Db,
  options: { excludeKits?: boolean } = {},
): { id: string; name: string; unit: PartUnit; isKit: boolean; spec: string | null }[] {
  const where = options.excludeKits
    ? and(isNull(part.archivedAtMs), eq(part.isKit, false))
    : isNull(part.archivedAtMs);
  return tx
    .select({
      id: part.id,
      name: part.name,
      unit: part.unit,
      isKit: part.isKit,
      spec: part.spec,
    })
    .from(part)
    .where(where)
    .orderBy(asc(part.name))
    .all();
}
