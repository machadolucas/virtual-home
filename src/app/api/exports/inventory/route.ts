import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  kitComponent,
  location,
  maintenanceOccurrence,
  part,
  partCompatibility,
  partLot,
  partStock,
  partSupplier,
  storagePlace,
  stockTransaction,
  user,
} from "@/db/schema";
import {
  contextTable,
  csvDocument,
  flattenContext,
  isoUtc,
  milliToDecimal,
  type CsvTable,
  type CsvValue,
} from "@/features/settings/csv";
import { authed, badRequest } from "@/server/api/handler";
import { buildEnvelope, exportFilename } from "@/server/queries/settings/export";

/**
 * `GET /api/exports/inventory` — parts, kits, suppliers, storage, lots and the whole stock ledger.
 *
 * JSON by default; `?format=csv&dataset=<name>` for one dataset as a spreadsheet. Behind `authed`,
 * because this is the household's entire purchase history and there is no public tier.
 *
 * Every response carries the §8.4 envelope: exported-at, household time zone, and the model
 * context (`modelId`, revision, content hash, coordinate system). Inventory rows have no
 * coordinates of their own, but a storage place points at a model node, so the frame still matters.
 */

const DATASETS = ["parts", "kitComponents", "suppliers", "storagePlaces", "lots", "stockTransactions", "compatibility"] as const;
type DatasetName = (typeof DATASETS)[number];

function isDataset(value: string): value is DatasetName {
  return (DATASETS as readonly string[]).includes(value);
}

export const GET = authed(async (_session, req) => {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    throw badRequest("unsupported_format", { supported: ["json", "csv"] });
  }
  const datasetParam = url.searchParams.get("dataset");
  if (datasetParam !== null && !isDataset(datasetParam)) {
    throw badRequest("unknown_dataset", { supported: DATASETS });
  }

  const { db } = getDb();
  const nowMs = Date.now();
  const envelope = await buildEnvelope(db, datasetParam === null ? DATASETS : [datasetParam], nowMs);
  const tables = buildTables(db);

  if (format === "json") {
    const datasets: Record<string, unknown[]> =
      datasetParam === null
        ? Object.fromEntries(DATASETS.map((name) => [name, objectsOf(tables[name])]))
        : { [datasetParam]: objectsOf(tables[datasetParam]) };
    return Response.json(
      { ...envelope, datasets },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="${exportFilename("inventory", "json", datasetParam, nowMs)}"`,
        },
      },
    );
  }

  // CSV is one dataset per file (§8.4). Without a `dataset` the ledger is the useful default: it is
  // the dataset somebody opens a spreadsheet for.
  const name: DatasetName = datasetParam ?? "stockTransactions";
  const body = csvDocument(contextTable(flattenContext(envelope)), tables[name]);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${exportFilename("inventory", "csv", name, nowMs)}"`,
    },
  });
});

/** A CSV table read back as JSON objects, so both formats are provably the same data. */
function objectsOf(table: CsvTable): Record<string, CsvValue>[] {
  return table.rows.map((row) =>
    Object.fromEntries(table.columns.map((column, index) => [column, row[index] ?? null])),
  );
}

type Tables = Record<DatasetName, CsvTable>;

function buildTables(db: ReturnType<typeof getDb>["db"]): Tables {
  const parts = db
    .select({
      id: part.id,
      name: part.name,
      spec: part.spec,
      dimensions: part.dimensions,
      manufacturer: part.manufacturer,
      productCode: part.productCode,
      ean: part.ean,
      trackingMode: part.trackingMode,
      unit: part.unit,
      isKit: part.isKit,
      stockMode: part.stockMode,
      reorderThresholdMilli: part.reorderThresholdMilli,
      reorderTargetMilli: part.reorderTargetMilli,
      leadTimeDays: part.leadTimeDays,
      tracksLots: part.tracksLots,
      storagePlaceName: storagePlace.name,
      storageModelNodeId: storagePlace.modelNodeId,
      onHandMilli: partStock.onHandMilli,
      effectiveMilli: partStock.effectiveMilli,
      lastMovementMs: partStock.lastMovementMs,
      archivedAtMs: part.archivedAtMs,
      notes: part.notes,
    })
    .from(part)
    .leftJoin(storagePlace, eq(storagePlace.id, part.defaultStoragePlaceId))
    .leftJoin(partStock, eq(partStock.partId, part.id))
    .orderBy(asc(part.name))
    .all();

  return {
    parts: {
      columns: [
        "part_id",
        "name",
        "spec",
        "dimensions",
        "manufacturer",
        "product_code",
        "ean",
        "tracking_mode",
        "unit",
        "is_kit",
        "stock_mode",
        "reorder_threshold",
        "reorder_threshold_milli",
        "reorder_target",
        "reorder_target_milli",
        "lead_time_days",
        "tracks_lots",
        "default_storage_place",
        "default_storage_model_node_id",
        "on_hand",
        "on_hand_milli",
        "effective_on_hand",
        "effective_on_hand_milli",
        "last_movement_at_utc",
        "archived_at_utc",
        "notes",
      ],
      rows: parts.map((row) => [
        row.id,
        row.name,
        row.spec,
        row.dimensions,
        row.manufacturer,
        row.productCode,
        row.ean,
        row.trackingMode,
        row.unit,
        row.isKit,
        row.stockMode,
        milliToDecimal(row.reorderThresholdMilli),
        row.reorderThresholdMilli,
        milliToDecimal(row.reorderTargetMilli),
        row.reorderTargetMilli,
        row.leadTimeDays,
        row.tracksLots,
        row.storagePlaceName,
        row.storageModelNodeId,
        milliToDecimal(row.onHandMilli ?? 0),
        row.onHandMilli ?? 0,
        milliToDecimal(row.effectiveMilli ?? 0),
        row.effectiveMilli ?? 0,
        isoUtc(row.lastMovementMs),
        isoUtc(row.archivedAtMs),
        row.notes,
      ]),
    },

    kitComponents: {
      columns: ["kit_part_id", "kit_name", "component_part_id", "qty", "qty_milli", "unit"],
      rows: db
        .select({
          kitPartId: kitComponent.kitPartId,
          componentPartId: kitComponent.componentPartId,
          qtyMilli: kitComponent.qtyMilli,
          kitName: part.name,
          unit: part.unit,
        })
        .from(kitComponent)
        .innerJoin(part, eq(part.id, kitComponent.kitPartId))
        .orderBy(asc(part.name))
        .all()
        .map((row) => [
          row.kitPartId,
          row.kitName,
          row.componentPartId,
          milliToDecimal(row.qtyMilli),
          row.qtyMilli,
          row.unit,
        ]),
    },

    suppliers: {
      columns: [
        "supplier_row_id",
        "part_id",
        "part_name",
        "supplier_name",
        "supplier_sku",
        "url",
        "last_price",
        "last_price_cents",
        "currency",
        "pack_qty",
        "pack_qty_milli",
        "lead_time_days",
        "is_preferred",
        "note",
      ],
      rows: db
        .select({
          id: partSupplier.id,
          partId: partSupplier.partId,
          partName: part.name,
          supplierName: partSupplier.supplierName,
          supplierSku: partSupplier.supplierSku,
          url: partSupplier.url,
          lastPriceCents: partSupplier.lastPriceCents,
          currency: partSupplier.currency,
          packQtyMilli: partSupplier.packQtyMilli,
          leadTimeDays: partSupplier.leadTimeDays,
          isPreferred: partSupplier.isPreferred,
          note: partSupplier.note,
        })
        .from(partSupplier)
        .innerJoin(part, eq(part.id, partSupplier.partId))
        .orderBy(asc(part.name), asc(partSupplier.supplierName))
        .all()
        .map((row) => [
          row.id,
          row.partId,
          row.partName,
          row.supplierName,
          row.supplierSku,
          row.url,
          row.lastPriceCents === null ? null : row.lastPriceCents / 100,
          row.lastPriceCents,
          row.currency,
          milliToDecimal(row.packQtyMilli),
          row.packQtyMilli,
          row.leadTimeDays,
          row.isPreferred,
          row.note,
        ]),
    },

    storagePlaces: {
      columns: [
        "storage_place_id",
        "name",
        "location_id",
        "location_name",
        "location_slug",
        "model_node_id",
        "parent_place_id",
        "needs_reconciliation",
        "notes",
      ],
      rows: db
        .select({
          id: storagePlace.id,
          name: storagePlace.name,
          locationId: storagePlace.locationId,
          locationName: location.name,
          locationSlug: location.slug,
          modelNodeId: storagePlace.modelNodeId,
          parentPlaceId: storagePlace.parentPlaceId,
          needsReconciliation: storagePlace.needsReconciliation,
          notes: storagePlace.notes,
        })
        .from(storagePlace)
        .leftJoin(location, eq(location.id, storagePlace.locationId))
        .orderBy(asc(storagePlace.name))
        .all()
        .map((row) => [
          row.id,
          row.name,
          row.locationId,
          row.locationName,
          row.locationSlug,
          row.modelNodeId,
          row.parentPlaceId,
          row.needsReconciliation,
          row.notes,
        ]),
    },

    lots: {
      columns: [
        "lot_id",
        "part_id",
        "part_name",
        "label",
        "storage_place_id",
        "purchased_on_local_date",
        "expires_on_local_date",
        "opened_on_local_date",
        "initial_qty",
        "initial_qty_milli",
        "unit",
        "is_open",
        "estimate_pct",
        "notes",
      ],
      rows: db
        .select({
          id: partLot.id,
          partId: partLot.partId,
          partName: part.name,
          label: partLot.label,
          storagePlaceId: partLot.storagePlaceId,
          purchasedOn: partLot.purchasedOn,
          expiresOn: partLot.expiresOn,
          openedOn: partLot.openedOn,
          initialQtyMilli: partLot.initialQtyMilli,
          unit: part.unit,
          isOpen: partLot.isOpen,
          estimatePct: partLot.estimatePct,
          notes: partLot.notes,
        })
        .from(partLot)
        .innerJoin(part, eq(part.id, partLot.partId))
        .orderBy(asc(part.name), asc(partLot.label))
        .all()
        .map((row) => [
          row.id,
          row.partId,
          row.partName,
          row.label,
          row.storagePlaceId,
          row.purchasedOn,
          row.expiresOn,
          row.openedOn,
          milliToDecimal(row.initialQtyMilli),
          row.initialQtyMilli,
          row.unit,
          row.isOpen,
          row.estimatePct,
          row.notes,
        ]),
    },

    stockTransactions: {
      columns: [
        "transaction_id",
        "part_id",
        "part_name",
        "unit",
        "qty",
        "qty_milli",
        "kind",
        "reason",
        "lot_id",
        "storage_place_id",
        "occurrence_id",
        "occurrence_title",
        "completion_id",
        "transaction_group_id",
        "reverses_transaction_id",
        "unit_price",
        "unit_price_cents",
        "occurred_at_utc",
        "occurred_local_date",
        "recorded_at_utc",
        "recorded_by",
        "notes",
      ],
      rows: db
        .select({
          id: stockTransaction.id,
          partId: stockTransaction.partId,
          partName: part.name,
          unit: part.unit,
          qtyMilli: stockTransaction.qtyMilli,
          kind: stockTransaction.kind,
          reason: stockTransaction.reason,
          lotId: stockTransaction.lotId,
          storagePlaceId: stockTransaction.storagePlaceId,
          occurrenceId: stockTransaction.occurrenceId,
          occurrenceTitle: maintenanceOccurrence.title,
          completionId: stockTransaction.completionId,
          transactionGroupId: stockTransaction.transactionGroupId,
          reversesTransactionId: stockTransaction.reversesTransactionId,
          unitPriceCents: stockTransaction.unitPriceCents,
          occurredAtMs: stockTransaction.occurredAtMs,
          occurredLocalDate: stockTransaction.occurredLocalDate,
          createdAtMs: stockTransaction.createdAtMs,
          createdByName: user.name,
          notes: stockTransaction.notes,
        })
        .from(stockTransaction)
        .innerJoin(part, eq(part.id, stockTransaction.partId))
        .leftJoin(user, eq(user.id, stockTransaction.createdBy))
        .leftJoin(
          maintenanceOccurrence,
          eq(maintenanceOccurrence.id, stockTransaction.occurrenceId),
        )
        .orderBy(desc(stockTransaction.occurredAtMs))
        .all()
        .map((row) => [
          row.id,
          row.partId,
          row.partName,
          row.unit,
          milliToDecimal(row.qtyMilli),
          row.qtyMilli,
          row.kind,
          row.reason,
          row.lotId,
          row.storagePlaceId,
          row.occurrenceId,
          row.occurrenceTitle,
          row.completionId,
          row.transactionGroupId,
          row.reversesTransactionId,
          row.unitPriceCents === null ? null : row.unitPriceCents / 100,
          row.unitPriceCents,
          isoUtc(row.occurredAtMs),
          row.occurredLocalDate,
          isoUtc(row.createdAtMs),
          row.createdByName,
          row.notes,
        ]),
    },

    compatibility: {
      columns: [
        "compatibility_id",
        "part_id",
        "part_name",
        "asset_id",
        "asset_model_name",
        "manufacturer",
        "confidence",
        "note",
      ],
      rows: db
        .select({
          id: partCompatibility.id,
          partId: partCompatibility.partId,
          partName: part.name,
          assetId: partCompatibility.assetId,
          assetModelName: partCompatibility.assetModelName,
          manufacturer: partCompatibility.manufacturer,
          confidence: partCompatibility.confidence,
          note: partCompatibility.note,
        })
        .from(partCompatibility)
        .innerJoin(part, eq(part.id, partCompatibility.partId))
        .orderBy(asc(part.name))
        .all()
        .map((row) => [
          row.id,
          row.partId,
          row.partName,
          row.assetId,
          row.assetModelName,
          row.manufacturer,
          row.confidence,
          row.note,
        ]),
    },
  };
}
