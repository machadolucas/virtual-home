import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  asset,
  assetConsumable,
  assetHaLink,
  assetPlacement,
  assetReplacement,
  haDevice,
  haEntity,
  location,
  part,
  system,
  systemAsset,
  systemLocation,
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
 * `GET /api/exports/equipment` — equipment, its placement in the model, what it consumes, the
 * systems it belongs to, its Home Assistant links and its replacement history.
 *
 * The §8.4 envelope matters most here: `asset_placement` carries **metre coordinates in the model
 * frame**, and a coordinate without its frame is a number without a unit. So every response states
 * the model id, the revision, the content hash and the coordinate system, and the placement rows
 * repeat `model_revision_id` and `model_node_id` beside their `pos_*` columns.
 */

const DATASETS = [
  "assets",
  "placements",
  "consumables",
  "systems",
  "systemMembers",
  "haLinks",
  "replacements",
] as const;
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
          "Content-Disposition": `attachment; filename="${exportFilename("equipment", "json", datasetParam, nowMs)}"`,
        },
      },
    );
  }

  const name: DatasetName = datasetParam ?? "assets";
  const body = csvDocument(contextTable(flattenContext(envelope)), tables[name]);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${exportFilename("equipment", "csv", name, nowMs)}"`,
    },
  });
});

function objectsOf(table: CsvTable): Record<string, CsvValue>[] {
  return table.rows.map((row) =>
    Object.fromEntries(table.columns.map((column, index) => [column, row[index] ?? null])),
  );
}

type Tables = Record<DatasetName, CsvTable>;

function buildTables(db: ReturnType<typeof getDb>["db"]): Tables {
  return {
    assets: {
      columns: [
        "asset_id",
        "name",
        "category",
        "status",
        "manufacturer",
        "model_name",
        "serial_number",
        "product_code",
        "location_id",
        "location_name",
        "location_slug",
        "location_model_node_id",
        "parent_asset_id",
        "is_virtual",
        "installed_on_local_date",
        "installed_on_precision",
        "removed_on_local_date",
        "replaces_asset_id",
        "replaced_by_asset_id",
        "purchase_price",
        "purchase_price_cents",
        "currency",
        "warranty_until_local_date",
        "expected_life_years",
        "created_at_utc",
        "notes",
      ],
      rows: db
        .select({
          id: asset.id,
          name: asset.name,
          category: asset.category,
          status: asset.status,
          manufacturer: asset.manufacturer,
          modelName: asset.modelName,
          serialNumber: asset.serialNumber,
          productCode: asset.productCode,
          locationId: asset.locationId,
          locationName: location.name,
          locationSlug: location.slug,
          locationModelNodeId: location.modelNodeId,
          parentAssetId: asset.parentAssetId,
          isVirtual: asset.isVirtual,
          installedOn: asset.installedOn,
          installedOnPrecision: asset.installedOnPrecision,
          removedOn: asset.removedOn,
          replacesAssetId: asset.replacesAssetId,
          replacedByAssetId: asset.replacedByAssetId,
          purchasePriceCents: asset.purchasePriceCents,
          currency: asset.currency,
          warrantyUntil: asset.warrantyUntil,
          expectedLifeYears: asset.expectedLifeYears,
          createdAtMs: asset.createdAtMs,
          notes: asset.notes,
        })
        .from(asset)
        .leftJoin(location, eq(location.id, asset.locationId))
        .orderBy(asc(asset.name))
        .all()
        .map((row) => [
          row.id,
          row.name,
          row.category,
          row.status,
          row.manufacturer,
          row.modelName,
          row.serialNumber,
          row.productCode,
          row.locationId,
          row.locationName,
          row.locationSlug,
          row.locationModelNodeId,
          row.parentAssetId,
          row.isVirtual,
          row.installedOn,
          row.installedOnPrecision,
          row.removedOn,
          row.replacesAssetId,
          row.replacedByAssetId,
          row.purchasePriceCents === null ? null : row.purchasePriceCents / 100,
          row.purchasePriceCents,
          row.currency,
          row.warrantyUntil,
          row.expectedLifeYears,
          isoUtc(row.createdAtMs),
          row.notes,
        ]),
    },

    // Coordinates are metres in the model frame; the frame is in the envelope, and the revision id
    // is repeated on every row so a mixed-revision export is still readable.
    placements: {
      columns: [
        "placement_id",
        "asset_id",
        "asset_name",
        "model_revision_id",
        "model_node_id",
        "placement_kind",
        "pos_x",
        "pos_y",
        "pos_z",
        "rot_yaw_deg",
        "needs_reconciliation",
        "color_override",
      ],
      rows: db
        .select({
          id: assetPlacement.id,
          assetId: assetPlacement.assetId,
          assetName: asset.name,
          modelRevisionId: assetPlacement.modelRevisionId,
          modelNodeId: assetPlacement.modelNodeId,
          placementKind: assetPlacement.placementKind,
          posX: assetPlacement.posX,
          posY: assetPlacement.posY,
          posZ: assetPlacement.posZ,
          rotYawDeg: assetPlacement.rotYawDeg,
          needsReconciliation: assetPlacement.needsReconciliation,
          colorOverride: assetPlacement.colorOverride,
        })
        .from(assetPlacement)
        .innerJoin(asset, eq(asset.id, assetPlacement.assetId))
        .orderBy(asc(asset.name))
        .all()
        .map((row) => [
          row.id,
          row.assetId,
          row.assetName,
          row.modelRevisionId,
          row.modelNodeId,
          row.placementKind,
          row.posX,
          row.posY,
          row.posZ,
          row.rotYawDeg,
          row.needsReconciliation,
          row.colorOverride,
        ]),
    },

    consumables: {
      columns: [
        "consumable_id",
        "asset_id",
        "asset_name",
        "part_id",
        "part_name",
        "role",
        "qty",
        "qty_milli",
        "unit",
        "notes",
      ],
      rows: db
        .select({
          id: assetConsumable.id,
          assetId: assetConsumable.assetId,
          assetName: asset.name,
          partId: assetConsumable.partId,
          partName: part.name,
          role: assetConsumable.role,
          qtyMilli: assetConsumable.qtyMilli,
          unit: part.unit,
          notes: assetConsumable.notes,
        })
        .from(assetConsumable)
        .innerJoin(asset, eq(asset.id, assetConsumable.assetId))
        .innerJoin(part, eq(part.id, assetConsumable.partId))
        .orderBy(asc(asset.name), asc(part.name))
        .all()
        .map((row) => [
          row.id,
          row.assetId,
          row.assetName,
          row.partId,
          row.partName,
          row.role,
          milliToDecimal(row.qtyMilli),
          row.qtyMilli,
          row.unit,
          row.notes,
        ]),
    },

    systems: {
      columns: [
        "system_id",
        "name",
        "kind",
        "status",
        "description",
        "declared_location_ids",
        "declared_location_names",
      ],
      rows: (() => {
        const spans = new Map<string, { ids: string[]; names: string[] }>();
        for (const row of db
          .select({
            systemId: systemLocation.systemId,
            locationId: location.id,
            locationName: location.name,
          })
          .from(systemLocation)
          .innerJoin(location, eq(location.id, systemLocation.locationId))
          .all()) {
          const entry = spans.get(row.systemId) ?? { ids: [], names: [] };
          entry.ids.push(row.locationId);
          entry.names.push(row.locationName);
          spans.set(row.systemId, entry);
        }
        return db
          .select()
          .from(system)
          .orderBy(asc(system.name))
          .all()
          .map((row) => {
            const span = spans.get(row.id) ?? { ids: [], names: [] };
            return [
              row.id,
              row.name,
              row.kind,
              row.status,
              row.description,
              span.ids.join(" "),
              span.names.join(" | "),
            ] as const;
          });
      })(),
    },

    systemMembers: {
      columns: ["system_id", "system_name", "asset_id", "asset_name", "role"],
      rows: db
        .select({
          systemId: systemAsset.systemId,
          systemName: system.name,
          assetId: systemAsset.assetId,
          assetName: asset.name,
          role: systemAsset.role,
        })
        .from(systemAsset)
        .innerJoin(system, eq(system.id, systemAsset.systemId))
        .innerJoin(asset, eq(asset.id, systemAsset.assetId))
        .orderBy(asc(system.name), asc(asset.name))
        .all()
        .map((row) => [row.systemId, row.systemName, row.assetId, row.assetName, row.role]),
    },

    // The FK is the registry id (CLAUDE.md rule 8); `entity_id` is exported as a *snapshot* column
    // so nobody mistakes it for an identity when they read the file back.
    haLinks: {
      columns: [
        "link_id",
        "asset_id",
        "asset_name",
        "link_kind",
        "role",
        "link_state",
        "link_state_changed_at_utc",
        "ha_device_id",
        "ha_device_name",
        "ha_entity_registry_id",
        "current_entity_id",
        "entity_id_snapshot",
        "platform_snapshot",
        "unique_id_snapshot",
        "notes",
      ],
      rows: db
        .select({
          id: assetHaLink.id,
          assetId: assetHaLink.assetId,
          assetName: asset.name,
          linkKind: assetHaLink.linkKind,
          role: assetHaLink.role,
          linkState: assetHaLink.linkState,
          linkStateChangedAtMs: assetHaLink.linkStateChangedAtMs,
          haDeviceId: assetHaLink.haDeviceId,
          haDeviceName: haDevice.name,
          haEntityRegistryId: assetHaLink.haEntityRegistryId,
          currentEntityId: haEntity.entityId,
          entityIdSnapshot: assetHaLink.entityIdSnapshot,
          platformSnapshot: assetHaLink.platformSnapshot,
          uniqueIdSnapshot: assetHaLink.uniqueIdSnapshot,
          notes: assetHaLink.notes,
        })
        .from(assetHaLink)
        .innerJoin(asset, eq(asset.id, assetHaLink.assetId))
        .leftJoin(haDevice, eq(haDevice.deviceId, assetHaLink.haDeviceId))
        .leftJoin(haEntity, eq(haEntity.registryId, assetHaLink.haEntityRegistryId))
        .orderBy(asc(asset.name), asc(assetHaLink.role))
        .all()
        .map((row) => [
          row.id,
          row.assetId,
          row.assetName,
          row.linkKind,
          row.role,
          row.linkState,
          isoUtc(row.linkStateChangedAtMs),
          row.haDeviceId,
          row.haDeviceName,
          row.haEntityRegistryId,
          row.currentEntityId,
          row.entityIdSnapshot,
          row.platformSnapshot,
          row.uniqueIdSnapshot,
          row.notes,
        ]),
    },

    replacements: {
      columns: [
        "replacement_id",
        "old_asset_id",
        "new_asset_id",
        "replaced_on_local_date",
        "reason",
        "occurrence_id",
        "completion_id",
        "created_at_utc",
        "notes",
      ],
      rows: db
        .select()
        .from(assetReplacement)
        .orderBy(asc(assetReplacement.replacedOn))
        .all()
        .map((row) => [
          row.id,
          row.oldAssetId,
          row.newAssetId,
          row.replacedOn,
          row.reason,
          row.occurrenceId,
          row.completionId,
          isoUtc(row.createdAtMs),
          row.notes,
        ]),
    },
  };
}
