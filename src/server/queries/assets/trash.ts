import "server-only";

import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  annotation,
  appAlert,
  asset,
  assetPlacement,
  assetReplacement,
  attachmentLink,
  completion,
  conditionEpisode,
  conditionRule,
  infraEndpoint,
  infraRoutePoint,
  maintenanceOccurrence,
  maintenancePlan,
  modelReconciliationItem,
  partCompatibility,
  procedureEquipmentNote,
  projectLink,
  serviceDocument,
} from "@/db/schema";
import type { EquipmentGroup, ListEquipmentOptions } from "./list";
import { listEquipment } from "./list";

export interface TrashEquipmentResult {
  groups: EquipmentGroup[];
  total: number;
  blockers: Record<string, string>;
}

function addRows(
  blocked: Map<string, string>,
  reason: string,
  rows: readonly { assetId: string | null }[],
): void {
  for (const row of rows) {
    if (row.assetId !== null && !blocked.has(row.assetId)) blocked.set(row.assetId, reason);
  }
}

/**
 * Reasons an asset must remain as a historical record. The order is deliberate: the UI gives one
 * concise reason, while the permanent-delete action re-runs every check inside its write lock.
 */
export function assetDeletionBlockers(tx: Db, assetIds: readonly string[]): Map<string, string> {
  const blocked = new Map<string, string>();
  if (assetIds.length === 0) return blocked;

  for (const row of tx
    .select({ id: asset.id, replacesAssetId: asset.replacesAssetId, replacedByAssetId: asset.replacedByAssetId })
    .from(asset)
    .where(inArray(asset.id, assetIds))
    .all()) {
    if (row.replacesAssetId !== null || row.replacedByAssetId !== null) {
      blocked.set(row.id, "Part of an equipment replacement chain");
    }
  }
  addRows(blocked, "Referenced by another equipment record", tx.select({ assetId: asset.parentAssetId }).from(asset).where(inArray(asset.parentAssetId, assetIds)).all());
  addRows(blocked, "Part of another equipment record's replacement chain", tx.select({ assetId: asset.replacesAssetId }).from(asset).where(inArray(asset.replacesAssetId, assetIds)).all());
  addRows(blocked, "Part of another equipment record's replacement chain", tx.select({ assetId: asset.replacedByAssetId }).from(asset).where(inArray(asset.replacedByAssetId, assetIds)).all());
  const replacements = tx.select({ oldAssetId: assetReplacement.oldAssetId, newAssetId: assetReplacement.newAssetId }).from(assetReplacement).where(or(inArray(assetReplacement.oldAssetId, assetIds), inArray(assetReplacement.newAssetId, assetIds))).all();
  addRows(blocked, "Part of an equipment replacement record", replacements.map((row) => ({ assetId: row.oldAssetId })));
  addRows(blocked, "Part of an equipment replacement record", replacements.map((row) => ({ assetId: row.newAssetId })));
  addRows(blocked, "Has a maintenance plan", tx.select({ assetId: maintenancePlan.assetId }).from(maintenancePlan).where(inArray(maintenancePlan.assetId, assetIds)).all());
  addRows(blocked, "Has scheduled or historical work", tx.select({ assetId: maintenanceOccurrence.assetId }).from(maintenanceOccurrence).where(inArray(maintenanceOccurrence.assetId, assetIds)).all());
  addRows(blocked, "Has service history", tx.select({ assetId: completion.assetId }).from(completion).where(inArray(completion.assetId, assetIds)).all());
  addRows(blocked, "Is referenced by a condition rule", tx.select({ assetId: conditionRule.assetId }).from(conditionRule).where(inArray(conditionRule.assetId, assetIds)).all());
  addRows(blocked, "Has condition history", tx.select({ assetId: conditionEpisode.assetId }).from(conditionEpisode).where(inArray(conditionEpisode.assetId, assetIds)).all());
  addRows(blocked, "Has a service document", tx.select({ assetId: serviceDocument.assetId }).from(serviceDocument).where(inArray(serviceDocument.assetId, assetIds)).all());
  addRows(blocked, "Is referenced by a procedure note", tx.select({ assetId: procedureEquipmentNote.assetId }).from(procedureEquipmentNote).where(inArray(procedureEquipmentNote.assetId, assetIds)).all());
  addRows(blocked, "Is referenced by a compatible supply", tx.select({ assetId: partCompatibility.assetId }).from(partCompatibility).where(inArray(partCompatibility.assetId, assetIds)).all());
  addRows(blocked, "Is an infrastructure route endpoint", tx.select({ assetId: infraRoutePoint.assetId }).from(infraRoutePoint).where(inArray(infraRoutePoint.assetId, assetIds)).all());
  addRows(blocked, "Is an infrastructure endpoint", tx.select({ assetId: infraEndpoint.assetId }).from(infraEndpoint).where(inArray(infraEndpoint.assetId, assetIds)).all());
  addRows(blocked, "Has an attachment", tx.select({ assetId: attachmentLink.entityId }).from(attachmentLink).where(and(eq(attachmentLink.entityKind, "asset"), inArray(attachmentLink.entityId, assetIds))).all());
  addRows(
    blocked,
    "Has a close-up photo",
    tx
      .select({ assetId: assetPlacement.assetId })
      .from(assetPlacement)
      .where(
        and(
          inArray(assetPlacement.assetId, assetIds),
          isNotNull(assetPlacement.photoAttachmentId),
        ),
      )
      .all(),
  );
  addRows(blocked, "Is linked to a project", tx.select({ assetId: projectLink.entityId }).from(projectLink).where(and(eq(projectLink.entityKind, "asset"), inArray(projectLink.entityId, assetIds))).all());
  addRows(blocked, "Has a house annotation", tx.select({ assetId: annotation.targetId }).from(annotation).where(and(eq(annotation.targetKind, "asset"), inArray(annotation.targetId, assetIds))).all());
  addRows(blocked, "Has an application alert", tx.select({ assetId: appAlert.entityId }).from(appAlert).where(and(eq(appAlert.entityTable, "asset"), inArray(appAlert.entityId, assetIds))).all());
  addRows(
    blocked,
    "Its placement is part of a house-model reconciliation",
    tx
      .select({ assetId: assetPlacement.assetId })
      .from(modelReconciliationItem)
      .innerJoin(assetPlacement, eq(assetPlacement.id, modelReconciliationItem.entityId))
      .where(
        and(
          eq(modelReconciliationItem.entityKind, "asset_placement"),
          inArray(assetPlacement.assetId, assetIds),
        ),
      )
      .all(),
  );

  return blocked;
}

export function listTrashEquipment(tx: Db, options: ListEquipmentOptions): TrashEquipmentResult {
  const all = listEquipment(tx, { ...options, includeHistoric: true });
  const groups = all.groups.flatMap((group) => {
    const rows = group.rows.filter((row) => ["removed", "retired", "lost"].includes(row.status));
    return rows.length === 0 ? [] : [{ ...group, rows }];
  });
  const ids = groups.flatMap((group) => group.rows.map((row) => row.id));
  return {
    groups,
    total: ids.length,
    blockers: Object.fromEntries(assetDeletionBlockers(tx, ids)),
  };
}
