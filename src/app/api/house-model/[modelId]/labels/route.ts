/**
 * GET / PATCH /api/house-model/[modelId]/labels
 *
 * Household-facing room and floor labels. The package remains immutable: preferences are keyed by
 * its stable semantic ids, and confirmed Home Assistant area/floor mappings supply the automatic
 * name when no explicit override exists.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  auditLog,
  haArea,
  haFloor,
  location,
  locationMapping,
  modelLabelPreference,
  modelRevision,
} from "@/db/schema";
import { authed, badRequest, conflict } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import {
  defaultRoomLabelVisibility,
  inferFloorDisplayNames,
} from "@/house/model/labelPreferences";

type Ctx = { params: Promise<{ modelId: string }> };

const NodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const PatchSchema = z.object({
  fingerprint: z.string().min(8),
  write: z.object({
    nodeId: NodeId,
    displayName: z.string().trim().min(1).max(100).nullable(),
    visible: z.boolean().nullable(),
  }),
});

type Package = Awaited<ReturnType<typeof currentPackageForRequest>>;

function resolvedPreferences(modelId: string, pkg: Package) {
  const db = getDb().db;
  const knownRooms = new Map(pkg.manifest.rooms.map((room) => [room.id, room]));
  const knownFloors = new Set(pkg.manifest.floors.map((floor) => floor.id));
  const knownIds = new Set([...knownRooms.keys(), ...knownFloors]);
  const names: Record<string, string> = {};
  const visibility: Record<string, boolean> = defaultRoomLabelVisibility(pkg.manifest.rooms);
  const customNames: Record<string, string> = {};
  const customVisibility: Record<string, boolean> = {};

  const revision = db
    .select({ id: modelRevision.id })
    .from(modelRevision)
    .where(and(eq(modelRevision.modelId, modelId), eq(modelRevision.status, "current")))
    .get();
  const locations = revision
    ? db
        .select({
          id: location.id,
          parentId: location.parentId,
          name: location.name,
          modelNodeId: location.modelNodeId,
        })
        .from(location)
        .where(eq(location.modelRevisionId, revision.id))
        .all()
        .filter((row) => row.modelNodeId !== null && knownIds.has(row.modelNodeId))
    : [];
  const locationsById = new Map(locations.map((row) => [row.id, row]));
  for (const row of locations) if (row.modelNodeId) names[row.modelNodeId] = row.name;

  if (locations.length) {
    const mappings = db
      .select({
        locationId: locationMapping.locationId,
        haKind: locationMapping.haKind,
        haId: locationMapping.haId,
      })
      .from(locationMapping)
      .where(
        and(
          eq(locationMapping.source, "confirmed"),
          inArray(locationMapping.locationId, locations.map((row) => row.id)),
        ),
      )
      .all();
    const areas = new Map(
      db
        .select({ id: haArea.areaId, name: haArea.name, floorId: haArea.floorId })
        .from(haArea)
        .where(isNull(haArea.removedAtMs))
        .all()
        .map((row) => [row.id, row]),
    );
    const floorNames = new Map(
      db
        .select({ id: haFloor.floorId, name: haFloor.name })
        .from(haFloor)
        .where(isNull(haFloor.removedAtMs))
        .all()
        .map((row) => [row.id, row.name]),
    );
    const directFloorNames = new Set<string>();
    const inferredFloors: Array<{ floorNodeId: string; haFloorId: string }> = [];
    for (const mapping of mappings) {
      const mappedLocation = locationsById.get(mapping.locationId);
      const nodeId = mappedLocation?.modelNodeId;
      if (!nodeId) continue;
      if (mapping.haKind === "floor") {
        const name = floorNames.get(mapping.haId);
        if (name) {
          names[nodeId] = name;
          directFloorNames.add(nodeId);
        }
        continue;
      }
      const area = areas.get(mapping.haId);
      if (area) names[nodeId] = area.name;
      // A confirmed room→area mapping may also tell us the display-only floor name. This does not
      // create a mapping: all confirmed areas on the app floor must agree on the same HA floor.
      const parentNodeId = mappedLocation?.parentId
        ? locationsById.get(mappedLocation.parentId)?.modelNodeId
        : null;
      if (parentNodeId && area?.floorId) {
        inferredFloors.push({ floorNodeId: parentNodeId, haFloorId: area.floorId });
      }
    }
    Object.assign(names, inferFloorDisplayNames(inferredFloors, floorNames, directFloorNames));
  }

  const rows = db
    .select()
    .from(modelLabelPreference)
    .where(eq(modelLabelPreference.modelId, modelId))
    .all();
  for (const row of rows) {
    if (!knownIds.has(row.modelNodeId)) continue;
    if (row.displayName !== null) {
      customNames[row.modelNodeId] = row.displayName;
      names[row.modelNodeId] = row.displayName;
    }
    if (row.visible !== null) {
      customVisibility[row.modelNodeId] = row.visible;
      visibility[row.modelNodeId] = row.visible;
    }
  }

  return { names, visibility, customNames, customVisibility };
}

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  return Response.json(resolvedPreferences(modelId, pkg), { headers: NO_STORE });
});

export const PATCH = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const body = PatchSchema.parse(await req.json());
  if (body.fingerprint !== pkg.fingerprint)
    throw conflict("stale_fingerprint", { fingerprint: pkg.fingerprint });

  const node = pkg.manifest.rooms.find((room) => room.id === body.write.nodeId)
    ?? pkg.manifest.floors.find((floor) => floor.id === body.write.nodeId);
  if (!node) throw badRequest("unknown_label_node", { nodeId: body.write.nodeId });

  const db = getDb().db;
  const at = nowMs();
  const actor = typeof session.user.id === "string" ? session.user.id : null;
  writeTx(db, (tx) => {
    const reset = body.write.displayName === null && body.write.visible === null;
    const existing = tx
      .select({ id: modelLabelPreference.id })
      .from(modelLabelPreference)
      .where(
        and(
          eq(modelLabelPreference.modelId, modelId),
          eq(modelLabelPreference.modelNodeId, body.write.nodeId),
        ),
      )
      .get();
    if (reset) {
      if (!existing) return;
      tx.delete(modelLabelPreference).where(eq(modelLabelPreference.id, existing.id)).run();
    } else if (existing) {
      tx.update(modelLabelPreference)
        .set({
          displayName: body.write.displayName,
          visible: body.write.visible,
          updatedAtMs: at,
          updatedBy: actor,
        })
        .where(eq(modelLabelPreference.id, existing.id))
        .run();
    } else {
      tx.insert(modelLabelPreference).values({
        id: newId(),
        modelId,
        modelNodeId: body.write.nodeId,
        displayName: body.write.displayName,
        visible: body.write.visible,
        createdAtMs: at,
        createdBy: actor,
        updatedAtMs: at,
        updatedBy: actor,
      }).run();
    }
    tx.insert(auditLog).values({
      id: newId(),
      atMs: at,
      actorKind: "user",
      actorUserId: actor,
      entityTable: "model_label_preference",
      entityId: `${modelId}:${body.write.nodeId}`,
      action: reset ? "deleted" : existing ? "updated" : "created",
      summary: `3D label preference ${reset ? "reset" : "updated"}`,
      changesJson: JSON.stringify(body.write),
    }).run();
  });

  return Response.json(resolvedPreferences(modelId, pkg), { headers: NO_STORE });
});
