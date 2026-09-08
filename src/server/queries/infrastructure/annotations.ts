import "server-only";
import { inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { annotation } from "@/db/schema";
import type { AnnotationDto } from "@/features/projects/wire";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import { mm, revisionIdsFor } from "./model";
import { photoIdsByEntity } from "./routes";

/**
 * Pins in the model: a note, a measurement, a warning, a to-do, a photo viewpoint.
 *
 * A pin whose `model_node_id` the current package no longer knows is listed in `stale` and flagged
 * `needsReconciliation`, never dropped — the words on it ("the shutoff is behind this panel") are
 * worth more than the node id that located them.
 */
export function listAnnotations(
  db: Db,
  modelId: string,
  index: ManifestIndex,
): { annotations: AnnotationDto[]; stale: string[] } {
  const revisionIds = revisionIdsFor(db, modelId);
  if (revisionIds.length === 0) return { annotations: [], stale: [] };

  const rows = db
    .select()
    .from(annotation)
    .where(inArray(annotation.modelRevisionId, revisionIds))
    .all();
  const photos = photoIdsByEntity(
    db,
    "annotation",
    rows.map((r) => r.id),
  );

  const annotations: AnnotationDto[] = [];
  const stale: string[] = [];
  for (const row of rows) {
    const unknownNode = row.modelNodeId !== null && !knownNode(index, row.modelNodeId);
    if (unknownNode) stale.push(row.id);
    annotations.push({
      id: row.id,
      targetKind: row.targetKind,
      targetId: row.targetId,
      modelNodeId: row.modelNodeId,
      position:
        row.posX !== null && row.posY !== null && row.posZ !== null
          ? [mm(row.posX), mm(row.posY), mm(row.posZ)]
          : null,
      kind: row.kind,
      title: row.title,
      body: row.body,
      measurementValue: row.measurementValue,
      measurementUnit: row.measurementUnit,
      needsReconciliation: row.needsReconciliation || unknownNode,
      photoIds: photos.get(row.id) ?? [],
    });
  }
  return { annotations, stale };
}

const knownNode = (index: ManifestIndex, nodeId: string): boolean =>
  index.rooms.has(nodeId) ||
  index.floors.has(nodeId) ||
  index.surfaces.has(nodeId) ||
  index.elements.has(nodeId) ||
  index.buildings.has(nodeId);
