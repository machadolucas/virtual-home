import "server-only";
import type { Db } from "@/db/client";
import { infraEndpoint } from "@/db/schema";
import type { EndpointDto } from "@/features/projects/wire";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import { mm, revisionIdsFor } from "./model";

/**
 * `infra_endpoint` rows — the manifolds, shutoffs, meters and patch panels a route runs between.
 *
 * An endpoint may legitimately have no coordinates ("the panel in the utility room"), so a missing
 * position is data, not an error: `position: null` reaches the client and the UI lists the row
 * without a marker rather than dropping it.
 *
 * Endpoints with no revision stamp at all are included too. Unlike a route they can be purely
 * locational, and refusing to list them would hide a shutoff valve from the person looking for it.
 */
export function listEndpoints(
  db: Db,
  modelId: string,
  index: ManifestIndex,
): { endpoints: EndpointDto[]; stale: string[] } {
  const revisionIds = revisionIdsFor(db, modelId);
  const rows = db
    .select()
    .from(infraEndpoint)
    .all()
    .filter((r) => r.modelRevisionId === null || revisionIds.includes(r.modelRevisionId));

  const endpoints: EndpointDto[] = [];
  const stale: string[] = [];
  for (const row of rows) {
    const unknownNode = row.modelNodeId !== null && !knownNode(index, row.modelNodeId);
    if (unknownNode) stale.push(row.id);
    endpoints.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      locationId: row.locationId,
      assetId: row.assetId,
      modelNodeId: row.modelNodeId,
      position:
        row.posX !== null && row.posY !== null && row.posZ !== null
          ? [mm(row.posX), mm(row.posY), mm(row.posZ)]
          : null,
      notes: row.notes,
      needsReconciliation: row.needsReconciliation || unknownNode,
    });
  }
  return { endpoints, stale };
}

const knownNode = (index: ManifestIndex, nodeId: string): boolean =>
  index.rooms.has(nodeId) ||
  index.floors.has(nodeId) ||
  index.surfaces.has(nodeId) ||
  index.elements.has(nodeId) ||
  index.buildings.has(nodeId);
