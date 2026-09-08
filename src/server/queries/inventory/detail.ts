import "server-only";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset,
  kitComponent,
  location,
  maintenanceOccurrence,
  part,
  partCompatibility,
  partLot,
  partSupplier,
  storagePlace,
  stockTransaction,
  user,
  type CompatibilityConfidence,
  type PartUnit,
} from "@/db/schema";
import { getStock, type StockLevel } from "@/domain/inventory";
import { reorderSuggestions, type ReorderSuggestion } from "@/domain/reorder";
import type { LocalDate } from "@/domain/time";

export type PartRow = typeof part.$inferSelect;
export type LotRow = typeof partLot.$inferSelect;
export type SupplierRow = typeof partSupplier.$inferSelect;

export interface LedgerEntry {
  id: string;
  qtyMilli: number;
  kind: (typeof stockTransaction.$inferSelect)["kind"];
  reason: (typeof stockTransaction.$inferSelect)["reason"];
  occurredAtMs: number;
  occurredLocalDate: string;
  notes: string | null;
  lotLabel: string | null;
  storagePlaceName: string | null;
  actorName: string | null;
  transactionGroupId: string | null;
  reversesTransactionId: string | null;
  /** Set when *this* row has already been reversed — the correct button must not offer twice. */
  reversedByTransactionId: string | null;
  /** The task this movement belongs to, when it came from a completion. */
  occurrenceId: string | null;
  occurrenceTitle: string | null;
}

export interface KitComponentEntry {
  partId: string;
  name: string;
  unit: PartUnit;
  qtyMilli: number;
  onHandMilli: number;
}

export interface CompatibilityEntry {
  id: string;
  assetId: string | null;
  label: string;
  locationName: string | null;
  confidence: CompatibilityConfidence;
  note: string | null;
}

export interface PartDetail {
  part: PartRow;
  stock: StockLevel;
  storagePlaceName: string | null;
  suggestion: ReorderSuggestion | null;
  lots: LotRow[];
  suppliers: SupplierRow[];
  ledger: LedgerEntry[];
  /** Rows this part is a component of, so the page can offer "open one of those". */
  memberOfKits: { partId: string; name: string; onHandMilli: number; qtyMilli: number }[];
  components: KitComponentEntry[];
  compatibility: CompatibilityEntry[];
  /** Kit-explode groups that can still be undone (no reversal row exists yet). */
  undoableExplodeGroups: { groupId: string; occurredAtMs: number; kitQtyMilli: number }[];
}

/** Everything `/supplies/[partId]` renders. Returns `null` for an unknown id. */
export function readPartDetail(
  tx: Db,
  partId: string,
  options: { today: LocalDate; horizonDays: number },
): PartDetail | null {
  const row = tx.select().from(part).where(eq(part.id, partId)).get();
  if (!row) return null;

  const stock = getStock(tx, partId);

  const suggestion =
    reorderSuggestions(tx, options).find((entry) => entry.partId === partId) ?? null;

  const storagePlaceName =
    row.defaultStoragePlaceId === null
      ? null
      : (tx
          .select({ name: storagePlace.name, locationName: location.name })
          .from(storagePlace)
          .leftJoin(location, eq(location.id, storagePlace.locationId))
          .where(eq(storagePlace.id, row.defaultStoragePlaceId))
          .get()
          ?.name ?? null);

  const lots = tx
    .select()
    .from(partLot)
    .where(eq(partLot.partId, partId))
    .orderBy(desc(partLot.isOpen), asc(partLot.expiresOn), asc(partLot.label))
    .all();

  const suppliers = tx
    .select()
    .from(partSupplier)
    .where(eq(partSupplier.partId, partId))
    .orderBy(desc(partSupplier.isPreferred), asc(partSupplier.supplierName))
    .all();

  const ledger = readLedger(tx, partId);

  const components: KitComponentEntry[] = tx
    .select({
      partId: kitComponent.componentPartId,
      name: part.name,
      unit: part.unit,
      qtyMilli: kitComponent.qtyMilli,
    })
    .from(kitComponent)
    .innerJoin(part, eq(part.id, kitComponent.componentPartId))
    .where(eq(kitComponent.kitPartId, partId))
    .orderBy(asc(part.name))
    .all()
    .map((entry) => ({
      ...entry,
      onHandMilli: getStock(tx, entry.partId).onHandMilli,
    }));

  const memberOfKits = tx
    .select({
      partId: kitComponent.kitPartId,
      name: part.name,
      qtyMilli: kitComponent.qtyMilli,
    })
    .from(kitComponent)
    .innerJoin(part, eq(part.id, kitComponent.kitPartId))
    .where(eq(kitComponent.componentPartId, partId))
    .orderBy(asc(part.name))
    .all()
    .map((entry) => ({ ...entry, onHandMilli: getStock(tx, entry.partId).onHandMilli }));

  const compatibility: CompatibilityEntry[] = tx
    .select({
      id: partCompatibility.id,
      assetId: partCompatibility.assetId,
      assetName: asset.name,
      modelName: partCompatibility.assetModelName,
      manufacturer: partCompatibility.manufacturer,
      locationName: location.name,
      confidence: partCompatibility.confidence,
      note: partCompatibility.note,
    })
    .from(partCompatibility)
    .leftJoin(asset, eq(asset.id, partCompatibility.assetId))
    .leftJoin(location, eq(location.id, asset.locationId))
    .where(eq(partCompatibility.partId, partId))
    .orderBy(asc(partCompatibility.confidence))
    .all()
    .map((entry) => ({
      id: entry.id,
      assetId: entry.assetId,
      label:
        entry.assetName ??
        [entry.manufacturer, entry.modelName].filter(Boolean).join(" ") ??
        "Unnamed",
      locationName: entry.locationName,
      confidence: entry.confidence,
      note: entry.note,
    }));

  return {
    part: row,
    stock,
    storagePlaceName,
    suggestion,
    lots,
    suppliers,
    ledger,
    components,
    memberOfKits,
    compatibility,
    undoableExplodeGroups: undoableExplodeGroups(tx, partId),
  };
}

/**
 * The visible history: newest first, with the actor and the linked task resolved, and with the
 * "already reversed" flag the correction button needs.
 *
 * The flag is a second query rather than a self-join because the unique index on
 * `reverses_transaction_id` means the set is tiny, and a left self-join in Drizzle here would need
 * an alias for no readability gain.
 */
export function readLedger(tx: Db, partId: string, limit = 200): LedgerEntry[] {
  const rows = tx
    .select({
      id: stockTransaction.id,
      qtyMilli: stockTransaction.qtyMilli,
      kind: stockTransaction.kind,
      reason: stockTransaction.reason,
      occurredAtMs: stockTransaction.occurredAtMs,
      occurredLocalDate: stockTransaction.occurredLocalDate,
      notes: stockTransaction.notes,
      lotLabel: partLot.label,
      storagePlaceName: storagePlace.name,
      actorName: user.name,
      transactionGroupId: stockTransaction.transactionGroupId,
      reversesTransactionId: stockTransaction.reversesTransactionId,
      occurrenceId: stockTransaction.occurrenceId,
      occurrenceTitle: maintenanceOccurrence.title,
    })
    .from(stockTransaction)
    .leftJoin(partLot, eq(partLot.id, stockTransaction.lotId))
    .leftJoin(storagePlace, eq(storagePlace.id, stockTransaction.storagePlaceId))
    .leftJoin(user, eq(user.id, stockTransaction.createdBy))
    .leftJoin(
      maintenanceOccurrence,
      eq(maintenanceOccurrence.id, stockTransaction.occurrenceId),
    )
    .where(eq(stockTransaction.partId, partId))
    .orderBy(desc(stockTransaction.occurredAtMs), desc(stockTransaction.createdAtMs))
    .limit(limit)
    .all();

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const reversals = new Map<string, string>();
  for (const reversal of tx
    .select({ id: stockTransaction.id, reverses: stockTransaction.reversesTransactionId })
    .from(stockTransaction)
    .where(inArray(stockTransaction.reversesTransactionId, ids))
    .all()) {
    if (reversal.reverses !== null) reversals.set(reversal.reverses, reversal.id);
  }

  return rows.map((row) => ({ ...row, reversedByTransactionId: reversals.get(row.id) ?? null }));
}

/**
 * Kit-explode groups whose rows have not been reversed. Only these can be undone, and offering
 * the button for anything else would produce a `ConflictError` the user cannot act on.
 */
function undoableExplodeGroups(
  tx: Db,
  kitPartId: string,
): { groupId: string; occurredAtMs: number; kitQtyMilli: number }[] {
  const explodes = tx
    .select({
      id: stockTransaction.id,
      groupId: stockTransaction.transactionGroupId,
      occurredAtMs: stockTransaction.occurredAtMs,
      qtyMilli: stockTransaction.qtyMilli,
    })
    .from(stockTransaction)
    .where(
      and(
        eq(stockTransaction.partId, kitPartId),
        eq(stockTransaction.kind, "kit_explode_out"),
        eq(stockTransaction.reason, "kit_explode"),
      ),
    )
    .orderBy(desc(stockTransaction.occurredAtMs))
    .all();

  const out: { groupId: string; occurredAtMs: number; kitQtyMilli: number }[] = [];
  for (const row of explodes) {
    if (row.groupId === null) continue;
    const reversed = tx
      .select({ id: stockTransaction.id })
      .from(stockTransaction)
      .where(eq(stockTransaction.reversesTransactionId, row.id))
      .get();
    if (reversed) continue;
    out.push({ groupId: row.groupId, occurredAtMs: row.occurredAtMs, kitQtyMilli: row.qtyMilli });
  }
  return out;
}

/** Assets, for the compatibility picker on the part form. */
export function listAssetOptions(tx: Db): { id: string; name: string; locationName: string | null }[] {
  return tx
    .select({ id: asset.id, name: asset.name, locationName: location.name })
    .from(asset)
    .leftJoin(location, eq(location.id, asset.locationId))
    .where(isNull(asset.replacedByAssetId))
    .orderBy(asc(asset.name))
    .all();
}
