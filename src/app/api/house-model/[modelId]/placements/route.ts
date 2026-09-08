/**
 * GET / PUT /api/house-model/[modelId]/placements
 *
 * Where a piece of equipment sits in the model. Two rules from CLAUDE.md shape this endpoint:
 *
 *  - **Rule 7, presentation is never persisted.** Exploded and cutaway views are presentation
 *    transforms. A write is therefore accepted only when it carries `viewMode: "normal"`; anything
 *    else answers `422 presentation_view_mode` rather than storing a view-space coordinate. The
 *    client already collapses and locks the exploded view on entering edit mode and saves the edit
 *    draft's `physical` triple (never `object.position`); this is the server-side backstop.
 *  - **Rule 7, semantic ids + metres.** A row references `model_revision_id` + the package's own
 *    `model_node_id` (the room, or the floor when no room contains the point) plus physical site
 *    metres rounded to millimetres. No geometry, no transform.
 *
 * Coverage (recorded in `docs/model-contract.md` §3.1): `asset_placement` now also stores the
 * **mount** — kind, the wall or ceiling surface, the height above the room's own floor and the
 * standoff — plus the location note and the close-up photo. So a wall-mounted sensor keeps the
 * record of *which* wall, which it did not before.
 *
 * One field still cannot round-trip: the HA `entityId`, which lives in `asset_ha_link` and belongs
 * to a module this endpoint does not own. It stays in `partialFields`, so the workspace states it
 * rather than pretending.
 *
 * The stored mount kind is one of `floor | wall | ceiling | free`; the workspace's own
 * `PlacementMount` union only knows `floor` and `wall`, so `mount` is answered in that narrower
 * shape and the true value travels beside it as `mountKind` (with `mountSurfaceId`,
 * `mountHeightM`, `mountOffsetM`). A ceiling mount reads as a wall mount on its surface, and a
 * free mount as a floor mount at its height — the numbers are unchanged either way.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { asset, assetPlacement, attachment, modelRevision, type MountKind } from "@/db/schema";
import { roomAt } from "@/house/model/manifestIndex";
import type { Placement, PlacementMount } from "@/house/model/types";
import { authed, badRequest, conflict, HttpError } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";

type Ctx = { params: Promise<{ modelId: string }> };

/**
 * A placement as this endpoint answers it: the workspace's `Placement` plus the stored mount in
 * full, because `PlacementMount` only knows `floor` and `wall`.
 */
type PersistedPlacement = Placement & {
  mountKind: MountKind;
  mountSurfaceId: string | null;
  mountHeightM: number | null;
  mountOffsetM: number | null;
};

/**
 * The stored mount narrowed to the workspace's union. `ceiling` reads as a mount on its surface
 * and `free` as a mount at its height: the numbers are identical, only the noun is coarser, and
 * `mountKind` beside it carries the real one.
 */
function clientMount(
  kind: MountKind,
  surfaceId: string | null,
  height: number,
  offset: number | null,
): PlacementMount {
  if ((kind === "wall" || kind === "ceiling") && surfaceId !== null)
    return { kind: "wall", surfaceId, height, offset: offset ?? 0 };
  return { kind: "floor", height };
}

/**
 * What `asset_placement` still cannot hold; reported so the UI never pretends otherwise. The HA
 * entity link is a row in `asset_ha_link`, owned by another module — a placement is where a thing
 * sits, not what it reports.
 */
export const PARTIAL_FIELDS = ["entityId"] as const;

const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const FiniteSchema = z.number().finite();

/**
 * The mount, as the client states it. A discriminated union rather than four loose columns, so
 * "wall mount with no surface" cannot be expressed at all.
 */
const MountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("floor"), height: FiniteSchema.default(0) }),
  z.object({
    kind: z.literal("wall"),
    surfaceId: IdSchema,
    height: FiniteSchema,
    offset: FiniteSchema.default(0),
  }),
  z.object({
    kind: z.literal("ceiling"),
    surfaceId: IdSchema,
    height: FiniteSchema.optional(),
    offset: FiniteSchema.default(0),
  }),
  z.object({ kind: z.literal("free"), height: FiniteSchema.optional() }),
]);

const PlacementSchema = z.object({
  /** Absent = a new placement. */
  id: z.string().min(1).max(64).optional(),
  equipmentId: z.string().min(1).max(64),
  /** Physical site metres. Rounded to millimetres on write. */
  position: z.tuple([FiniteSchema, FiniteSchema, FiniteSchema]),
  rotationYDeg: FiniteSchema.default(0),
  floorId: IdSchema,
  roomId: IdSchema.nullish(),
  placementKind: z.enum(["body", "access_panel", "label", "shutoff"]).default("body"),
  mount: MountSchema.optional(),
  /** Free text: "behind the hatch, left of the manifold". */
  locationNote: z.string().trim().max(1000).nullish(),
  /** An `attachment` id — the close-up that makes the location findable. */
  photoId: z.string().min(1).max(64).nullish(),
  colorOverride: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .nullish(),
});

const PutSchema = z.object({
  fingerprint: z.string().min(8),
  /**
   * The presentation state the coordinates were read in. Only `"normal"` is a legal source of a
   * placement; a free-form string (rather than a literal) so a wrong value is a deliberate 422
   * instead of a generic schema error.
   */
  viewMode: z.string().min(1),
  placement: PlacementSchema,
});

const mm = (v: number): number => Math.round(v * 1000) / 1000;

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);

  const db = getDb().db;
  const revisionIds = db
    .select({ id: modelRevision.id })
    .from(modelRevision)
    .where(eq(modelRevision.modelId, modelId))
    .all()
    .map((r) => r.id);

  if (revisionIds.length === 0)
    return Response.json(
      { placements: [], stale: [], partialFields: PARTIAL_FIELDS },
      { headers: NO_STORE },
    );

  const rows = db
    .select({
      id: assetPlacement.id,
      assetId: assetPlacement.assetId,
      modelNodeId: assetPlacement.modelNodeId,
      posX: assetPlacement.posX,
      posY: assetPlacement.posY,
      posZ: assetPlacement.posZ,
      rotYawDeg: assetPlacement.rotYawDeg,
      placementKind: assetPlacement.placementKind,
      mountKind: assetPlacement.mountKind,
      mountSurfaceId: assetPlacement.mountSurfaceId,
      mountHeightM: assetPlacement.mountHeightM,
      mountOffsetM: assetPlacement.mountOffsetM,
      locationNote: assetPlacement.locationNote,
      photoAttachmentId: assetPlacement.photoAttachmentId,
      needsReconciliation: assetPlacement.needsReconciliation,
      name: asset.name,
    })
    .from(assetPlacement)
    .innerJoin(asset, eq(asset.id, assetPlacement.assetId))
    .where(inArray(assetPlacement.modelRevisionId, revisionIds))
    .all();

  const placements: PersistedPlacement[] = [];
  const stale: string[] = [];

  for (const row of rows) {
    if (row.posX === null || row.posY === null || row.posZ === null) {
      // A placement without coordinates is a location-only record; it has nothing to draw.
      continue;
    }
    const resolved = resolveNode(index, row.modelNodeId, row.posX, row.posZ);
    if (!resolved) {
      // The package no longer knows this node: reported, never guessed at.
      stale.push(row.id);
      continue;
    }
    const roomElevation = resolved.roomId
      ? (index.rooms.get(resolved.roomId)?.floorElevation ?? 0)
      : (index.floors.get(resolved.floorId)?.elevation ?? 0);
    // A row written before the mount columns existed has no stored height; deriving it from the
    // resolved room's own floor elevation is what the endpoint always did, so old rows keep
    // answering the same numbers.
    const height = row.mountHeightM ?? mm(row.posY - roomElevation);
    placements.push({
      id: row.id,
      modelId,
      equipmentId: row.assetId,
      name: row.name,
      position: [mm(row.posX), mm(row.posY), mm(row.posZ)],
      rotationYDeg: row.rotYawDeg ?? 0,
      mount: clientMount(row.mountKind, row.mountSurfaceId, height, row.mountOffsetM),
      floorId: resolved.floorId,
      roomId: resolved.roomId,
      surfaceId: row.mountSurfaceId,
      locationNote: row.locationNote ?? "",
      photoId: row.photoAttachmentId,
      entityId: null,
      mountKind: row.mountKind,
      mountSurfaceId: row.mountSurfaceId,
      mountHeightM: height,
      mountOffsetM: row.mountOffsetM,
    });
  }

  return Response.json(
    { placements, stale, partialFields: PARTIAL_FIELDS },
    { headers: NO_STORE },
  );
});

export const PUT = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);

  const body = PutSchema.parse(await req.json());
  if (body.fingerprint !== pkg.fingerprint)
    throw conflict("stale_fingerprint", { fingerprint: pkg.fingerprint });

  // Rule 7: a coordinate read in an exploded or cutaway view is a presentation value.
  if (body.viewMode !== "normal")
    throw new HttpError(422, "presentation_view_mode", undefined, {
      viewMode: body.viewMode,
      hint: "collapse the exploded view and send the placement's physical coordinates",
    });

  const p = body.placement;
  const floor = index.floors.get(p.floorId);
  if (!floor) throw badRequest("unknown_floor", { floorId: p.floorId });
  if (p.roomId != null) {
    const room = index.rooms.get(p.roomId);
    if (!room) throw badRequest("unknown_room", { roomId: p.roomId });
    if (room.floorId !== p.floorId)
      throw badRequest("room_floor_mismatch", { roomId: p.roomId, floorId: room.floorId });
  }

  const bounds = pkg.manifest.bounds;
  for (let i = 0; i < 3; i++) {
    const v = p.position[i] as number;
    if (v < (bounds.min[i] as number) || v > (bounds.max[i] as number))
      throw badRequest("out_of_bounds", { axis: "xyz"[i], value: v, bounds });
  }

  const db = getDb().db;
  const revision = db
    .select({ id: modelRevision.id })
    .from(modelRevision)
    .where(and(eq(modelRevision.modelId, modelId), eq(modelRevision.status, "current")))
    .get();
  if (!revision)
    throw conflict("model_revision_missing", {
      hint: "import the model package first (pnpm vh-admin model-import <dir>); placements stay local until then",
    });

  const equipment = db
    .select({ id: asset.id, name: asset.name })
    .from(asset)
    .where(eq(asset.id, p.equipmentId))
    .get();
  if (!equipment)
    throw conflict("unknown_equipment", {
      equipmentId: p.equipmentId,
      hint: "create the equipment record before placing it in the model",
    });

  // The mount names a surface of *this* package, or it names nothing. A stale surface id would
  // otherwise be stored and only discovered as a missing marker months later.
  const mountSurfaceId =
    p.mount && (p.mount.kind === "wall" || p.mount.kind === "ceiling") ? p.mount.surfaceId : null;
  if (mountSurfaceId !== null) {
    const surface = index.surfaces.get(mountSurfaceId);
    if (!surface) throw badRequest("unknown_surface", { surfaceId: mountSurfaceId });
    if (p.mount?.kind === "wall" && surface.kind !== "wall")
      throw badRequest("mount_surface_kind_mismatch", {
        surfaceId: mountSurfaceId,
        surfaceKind: surface.kind,
        mountKind: "wall",
      });
    if (p.mount?.kind === "ceiling" && surface.kind !== "ceiling")
      throw badRequest("mount_surface_kind_mismatch", {
        surfaceId: mountSurfaceId,
        surfaceKind: surface.kind,
        mountKind: "ceiling",
      });
  }
  if (p.photoId != null) {
    const found = db
      .select({ id: attachment.id })
      .from(attachment)
      .where(eq(attachment.id, p.photoId))
      .get();
    if (!found) throw conflict("unknown_attachment", { attachmentId: p.photoId });
  }

  const nodeId = p.roomId ?? p.floorId;
  const position: [number, number, number] = [mm(p.position[0]), mm(p.position[1]), mm(p.position[2])];
  const actor = typeof session.user.id === "string" ? session.user.id : null;
  const at = nowMs();

  // Height is measured from the resolved room's own floor, not from the site datum, which is what
  // makes "1.4 m up the wall" mean the same thing on every floor.
  const mountRoomId = p.roomId ?? roomAt(index, p.floorId, position[0], position[2]);
  const mountElevation = mountRoomId
    ? (index.rooms.get(mountRoomId)?.floorElevation ?? floor.elevation)
    : floor.elevation;
  const mountKind: MountKind = p.mount?.kind ?? "floor";
  const mountHeightM = mm(
    p.mount && "height" in p.mount && p.mount.height !== undefined
      ? p.mount.height
      : position[1] - mountElevation,
  );
  const mountOffsetM =
    p.mount && "offset" in p.mount && p.mount.offset !== undefined ? mm(p.mount.offset) : null;

  // A client-supplied id addresses an existing row; without one this is a new placement, and the
  // natural key (asset, kind) decides whether it replaces one. Splitting the two keeps a re-`PUT`
  // of a known id from colliding with the primary key.
  const existing = p.id
    ? db
        .select({ id: assetPlacement.id, assetId: assetPlacement.assetId })
        .from(assetPlacement)
        .where(eq(assetPlacement.id, p.id))
        .get()
    : undefined;
  if (existing && existing.assetId !== p.equipmentId)
    throw conflict("placement_belongs_to_other_equipment", {
      placementId: existing.id,
      equipmentId: existing.assetId,
    });

  const shared = {
    modelRevisionId: revision.id,
    modelNodeId: nodeId,
    posX: position[0],
    posY: position[1],
    posZ: position[2],
    rotYawDeg: mm(p.rotationYDeg),
    mountKind,
    mountSurfaceId,
    mountHeightM,
    mountOffsetM,
    locationNote: p.locationNote ?? null,
    photoAttachmentId: p.photoId ?? null,
    needsReconciliation: false,
    colorOverride: p.colorOverride ?? null,
    updatedAtMs: at,
    updatedBy: actor,
  };

  writeTx(db, (tx) => {
    if (existing) {
      tx.update(assetPlacement).set(shared).where(eq(assetPlacement.id, existing.id)).run();
      return;
    }
    tx
      .insert(assetPlacement)
      .values({
        id: p.id ?? newId(),
        assetId: p.equipmentId,
        placementKind: p.placementKind,
        createdAtMs: at,
        createdBy: actor,
        ...shared,
      })
      .onConflictDoUpdate({
        // One placement of a given kind per asset, so the natural key is (asset, kind).
        target: [assetPlacement.assetId, assetPlacement.placementKind],
        set: shared,
      })
      .run();
  });

  const stored = db
    .select({ id: assetPlacement.id, rotYawDeg: assetPlacement.rotYawDeg })
    .from(assetPlacement)
    .where(
      and(
        eq(assetPlacement.assetId, p.equipmentId),
        eq(assetPlacement.placementKind, p.placementKind),
      ),
    )
    .get();

  // The row was just written, so this is a read-back, not a hope.
  const storedId = existing?.id ?? stored?.id;
  if (!storedId) throw new HttpError(500, "placement_not_stored");

  const placement: PersistedPlacement = {
    id: storedId,
    modelId,
    equipmentId: p.equipmentId,
    name: equipment.name,
    position,
    rotationYDeg: stored?.rotYawDeg ?? mm(p.rotationYDeg),
    mount: clientMount(mountKind, mountSurfaceId, mountHeightM, mountOffsetM),
    floorId: p.floorId,
    roomId: mountRoomId,
    surfaceId: mountSurfaceId,
    locationNote: p.locationNote ?? "",
    photoId: p.photoId ?? null,
    entityId: null,
    mountKind,
    mountSurfaceId,
    mountHeightM,
    mountOffsetM,
  };

  return Response.json({ placement, partialFields: PARTIAL_FIELDS }, { headers: NO_STORE });
});

/**
 * `model_node_id` is the room the placement belongs to, or the floor when the point fell outside
 * every room's footprint. Anything else is a node this package no longer knows.
 */
function resolveNode(
  index: ReturnType<typeof manifestIndexOf>,
  nodeId: string,
  x: number,
  z: number,
): { floorId: string; roomId: string | null } | null {
  const room = index.rooms.get(nodeId);
  if (room) return { floorId: room.floorId, roomId: room.id };
  const floor = index.floors.get(nodeId);
  if (floor) return { floorId: floor.id, roomId: roomAt(index, floor.id, x, z) };
  return null;
}
