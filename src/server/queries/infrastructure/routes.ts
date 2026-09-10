import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  assetPlacement,
  attachmentLink,
  infraEndpoint,
  infraRoute,
  infraRoutePoint,
} from "@/db/schema";
import type { RouteDto } from "@/features/projects/wire";
import { kindOfMedium, systemOfMedium } from "@/features/projects/infraMedium";
import { parseNominalSize } from "@/features/projects/nominalSize";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import type { RouteEndpoint, Vec3 } from "@/house/model/types";
import { mm, revisionIdsFor } from "./model";

/**
 * Reading routes back out.
 *
 * Two shapes meet here. The tables store a medium, a nominal size and per-point floor/room; the
 * workspace wants a system, a numeric size and per-*segment* floor/room. The translation is
 * deliberate and documented (`src/features/projects/infraMedium.ts`, `nominalSize.ts`), and every
 * id the current package no longer knows is **reported** in `stale` rather than silently dropped
 * or guessed at — same policy as `GET /colors`.
 */

export interface RouteListResult {
  routes: RouteDto[];
  /** Route ids that reference a floor, room or surface this package no longer knows. */
  stale: string[];
}

/** The `attachment` ids linked to each of `entityIds`, in `seq` order. */
export function photoIdsByEntity(
  db: Db,
  entityKind: "infra_route" | "annotation" | "project",
  entityIds: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (entityIds.length === 0) return out;
  const rows = db
    .select({
      entityId: attachmentLink.entityId,
      attachmentId: attachmentLink.attachmentId,
      seq: attachmentLink.seq,
    })
    .from(attachmentLink)
    .where(
      and(eq(attachmentLink.entityKind, entityKind), inArray(attachmentLink.entityId, [...entityIds])),
    )
    .orderBy(asc(attachmentLink.seq))
    .all();
  for (const row of rows) {
    const list = out.get(row.entityId);
    if (list) list.push(row.attachmentId);
    else out.set(row.entityId, [row.attachmentId]);
  }
  return out;
}

/**
 * `infra_endpoint` → the workspace's endpoint descriptor. An endpoint that names a piece of
 * equipment resolves to that equipment's body placement, which is what the 3D view can actually
 * draw a glyph on; anything else is a free point. The workspace's third variant (a surface plus
 * uv) has no column, which is why `endpoints` is listed in `ROUTE_PARTIAL_FIELDS`.
 */
function endpointDescriptor(
  db: Db,
  endpointId: string | null,
  placementByAsset: Map<string, string>,
): RouteEndpoint | null {
  if (!endpointId) return null;
  const row = db
    .select({ id: infraEndpoint.id, assetId: infraEndpoint.assetId })
    .from(infraEndpoint)
    .where(eq(infraEndpoint.id, endpointId))
    .get();
  if (!row) return null;
  const placementId = row.assetId ? placementByAsset.get(row.assetId) : undefined;
  return placementId ? { kind: "equipment", placementId } : { kind: "free" };
}

export function listRoutes(db: Db, modelId: string, index: ManifestIndex): RouteListResult {
  const revisionIds = revisionIdsFor(db, modelId);
  if (revisionIds.length === 0) return { routes: [], stale: [] };

  const rows = db
    .select()
    .from(infraRoute)
    .where(inArray(infraRoute.modelRevisionId, revisionIds))
    .all();
  if (rows.length === 0) return { routes: [], stale: [] };

  const routeIds = rows.map((r) => r.id);
  const pointRows = db
    .select()
    .from(infraRoutePoint)
    .where(inArray(infraRoutePoint.routeId, routeIds))
    .orderBy(asc(infraRoutePoint.routeId), asc(infraRoutePoint.seq))
    .all();

  const pointsByRoute = new Map<string, typeof pointRows>();
  for (const p of pointRows) {
    const list = pointsByRoute.get(p.routeId);
    if (list) list.push(p);
    else pointsByRoute.set(p.routeId, [p]);
  }

  // One lookup for the whole list: body placements keyed by asset, for endpoint descriptors.
  const placementByAsset = new Map<string, string>();
  for (const row of db
    .select({ id: assetPlacement.id, assetId: assetPlacement.assetId })
    .from(assetPlacement)
    .where(
      and(
        inArray(assetPlacement.modelRevisionId, revisionIds),
        eq(assetPlacement.placementKind, "body"),
      ),
    )
    .all())
    placementByAsset.set(row.assetId, row.id);

  const photos = photoIdsByEntity(db, "infra_route", routeIds);

  const routes: RouteDto[] = [];
  const stale: string[] = [];

  for (const row of rows) {
    const points = pointsByRoute.get(row.id) ?? [];
    // A route needs two points to be a line. One (or none) is a data error, not something to draw.
    if (points.length < 2) {
      stale.push(row.id);
      continue;
    }

    let unknownId = false;
    const pointPlaces: Array<{ floorId: string | null; roomId: string | null }> = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      let floorId = p.floorId ?? null;
      let roomId = p.roomId ?? null;
      if (floorId !== null && !index.floors.has(floorId)) {
        floorId = null;
        unknownId = true;
      }
      if (roomId !== null && !index.rooms.has(roomId)) {
        roomId = null;
        unknownId = true;
      }
      pointPlaces.push({ floorId, roomId });
    }

    let offsetFrom: RouteDto["offsetFrom"];
    if (row.offsetSurfaceId !== null && row.offsetM !== null) {
      const surface = index.surfaces.get(row.offsetSurfaceId);
      if (!surface) unknownId = true;
      else
        offsetFrom = {
          surfaceId: row.offsetSurfaceId,
          kind:
            surface.kind === "floor" || surface.kind === "ceiling" || surface.kind === "wall"
              ? surface.kind
              : "wall",
          offsetM: mm(row.offsetM),
        };
    }
    if (unknownId) stale.push(row.id);

    const size = parseNominalSize(row.nominalSize);
    const endpoints: RouteEndpoint[] = [];
    for (const id of [row.fromEndpointId, row.toEndpointId]) {
      const descriptor = endpointDescriptor(db, id, placementByAsset);
      if (descriptor) endpoints.push(descriptor);
    }

    routes.push({
      id: row.id,
      modelId,
      name: row.name,
      system: systemOfMedium(row.medium),
      kind: kindOfMedium(row.medium),
      points: points.map((p): Vec3 => [mm(p.posX), mm(p.posY), mm(p.posZ)]),
      segments: pointPlaces.slice(0, -1),
      pointPlaces,
      certainty: row.certainty,
      lifecycle: row.lifecycle,
      ...(size.widthM !== undefined ? { widthM: size.widthM } : {}),
      ...(size.diameterM !== undefined ? { diameterM: size.diameterM } : {}),
      ...(row.depthM !== null ? { depthM: mm(row.depthM) } : {}),
      ...(offsetFrom ? { offsetFrom } : {}),
      endpoints,
      ...(row.installedOn !== null ? { installedAt: row.installedOn } : {}),
      ...(row.removedOn !== null ? { removedAt: row.removedOn } : {}),
      ...(row.projectId !== null ? { renovationId: row.projectId } : {}),
      photoIds: photos.get(row.id) ?? [],
      ...(row.notes !== null ? { note: row.notes } : {}),

      medium: row.medium,
      nominalSize: row.nominalSize,
      systemId: row.systemId,
      isEstimated: row.isEstimated,
      projectId: row.projectId,
      fromEndpointId: row.fromEndpointId,
      toEndpointId: row.toEndpointId,
      needsReconciliation: row.needsReconciliation || unknownId,
      pointKinds: points.map((p) => p.pointKind),
      modelRevisionId: row.modelRevisionId,
    });
  }

  return { routes, stale };
}

/** One route, or `null`. Same shape as the list, so the UI has one mapping to trust. */
export function readRoute(
  db: Db,
  modelId: string,
  index: ManifestIndex,
  routeId: string,
): RouteDto | null {
  return listRoutes(db, modelId, index).routes.find((r) => r.id === routeId) ?? null;
}
