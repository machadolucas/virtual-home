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
 * HA links are resolved by durable registry/device identity on read. The response carries both the
 * main entity id and metadata for every linked reading, including device-level links.
 *
 * The stored mount kind is one of `floor | wall | ceiling | free`, and the workspace now knows all
 * four, so `mount` carries the true kind. `mountKind`/`mountSurfaceId`/`mountHeightM`/
 * `mountOffsetM` still travel beside it for callers that read the row shape directly.
 */
import { canMountSurface } from "@/house/model/mountSurface";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, writeTx, type Db } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  asset,
  assetHaLink,
  assetPlacement,
  attachment,
  haDevice,
  haEntity,
  location,
  modelRevision,
  type MountKind,
} from "@/db/schema";
import { roomAt } from "@/house/model/manifestIndex";
import type { Placement, PlacementLinkedEntity, PlacementMount } from "@/house/model/types";
import { authed, badRequest, conflict, HttpError } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";

type Ctx = { params: Promise<{ modelId: string }> };

/**
 * A placement as this endpoint answers it: the workspace's `Placement` plus the stored mount
 * columns for callers that still read the row-shaped fields directly.
 */
type PersistedPlacement = Placement & {
  mountKind: MountKind;
  mountSurfaceId: string | null;
  mountHeightM: number | null;
  mountOffsetM: number | null;
};

/** The stored mount as the workspace's union, which now names all four kinds. */
function clientMount(
  kind: MountKind,
  surfaceId: string | null,
  height: number,
  offset: number | null,
): PlacementMount {
  if (kind === "wall" && surfaceId !== null)
    return { kind: "wall", surfaceId, height, offset: offset ?? 0 };
  if (kind === "ceiling" && surfaceId !== null)
    return { kind: "ceiling", surfaceId, height, offset: offset ?? 0 };
  if (kind === "free") return { kind: "free", height };
  return { kind: "floor", height };
}

/**
 * What `asset_placement` still cannot hold. Nothing, now: the HA entity link lives in
 * `asset_ha_link` and is joined in below rather than reported as missing.
 */
export const PARTIAL_FIELDS = [] as const;

/**
 * The live `entity_id` for each of these assets, or nothing when they have no HA link.
 *
 * This used to be hardcoded `null`, which quietly disabled the whole live layer in the 3D
 * workspace: `useHaStream` builds its subscription purely from these ids, so it never opened a
 * stream at all — every marker stayed "unlinked" grey and the inspector told the household an
 * entity was not linked when it was.
 *
 * Resolution follows rule 8: the link stores the durable **registry id**, and the current
 * `entity_id` is read from `ha_entity`, never from the link's own snapshot (which is only a paper
 * trail and goes stale on a rename). A `renamed` link is as live as an `active` one — that is the
 * state renaming produces, and it is still bound by registry id. The `primary` role wins when an
 * asset carries several links, because that is the reading the marker is meant to show.
 */
function linkedEntitiesByAsset(
  db: Db,
  assetIds: readonly string[],
): Map<string, PlacementLinkedEntity[]> {
  const out = new Map<string, PlacementLinkedEntity[]>();
  if (assetIds.length === 0) return out;

  const directRows = db
    .select({
      assetId: assetHaLink.assetId,
      role: assetHaLink.role,
      entityId: haEntity.entityId,
      name: haEntity.name,
      originalName: haEntity.originalName,
      deviceClass: haEntity.deviceClass,
      unit: haEntity.unitOfMeasurement,
    })
    .from(assetHaLink)
    .innerJoin(haEntity, eq(haEntity.registryId, assetHaLink.haEntityRegistryId))
    .where(
      and(
        inArray(assetHaLink.assetId, [...assetIds]),
        eq(assetHaLink.linkKind, "entity"),
        inArray(assetHaLink.linkState, ["active", "renamed"]),
        isNull(haEntity.removedAtMs),
      ),
    )
    .all();

  const deviceRows = db
    .select({
      assetId: assetHaLink.assetId,
      role: assetHaLink.role,
      entityId: haEntity.entityId,
      name: haEntity.name,
      originalName: haEntity.originalName,
      deviceClass: haEntity.deviceClass,
      unit: haEntity.unitOfMeasurement,
    })
    .from(assetHaLink)
    .innerJoin(haDevice, eq(haDevice.deviceId, assetHaLink.haDeviceId))
    .innerJoin(haEntity, eq(haEntity.deviceId, assetHaLink.haDeviceId))
    .where(
      and(
        inArray(assetHaLink.assetId, [...assetIds]),
        eq(assetHaLink.linkKind, "device"),
        inArray(assetHaLink.linkState, ["active", "renamed"]),
        isNull(haDevice.disabledBy),
        isNull(haEntity.disabledBy),
        isNull(haEntity.hiddenBy),
        isNull(haEntity.removedAtMs),
      ),
    )
    .all();

  const priority: Record<PlacementLinkedEntity["role"], number> = {
    primary: 0,
    status: 1,
    control: 2,
    power: 3,
    diagnostic: 4,
    other: 5,
    battery_level: 6,
  };
  // Explicit entity links are authoritative for role metadata. Remove device-expanded duplicates
  // before sorting, otherwise a generic device role can sort ahead of an explicit battery role.
  const seen = new Set<string>();
  const rows = [...directRows, ...deviceRows].filter((row) => {
    const key = `${row.assetId}\0${row.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  rows.sort((a, b) => priority[a.role] - priority[b.role] || a.entityId.localeCompare(b.entityId));
  for (const row of rows) {
    const linked = out.get(row.assetId) ?? [];
    linked.push({
      entityId: row.entityId,
      role: row.role,
      name: row.name ?? row.originalName ?? null,
      deviceClass: row.deviceClass,
      unit: row.unit,
    });
    out.set(row.assetId, linked);
  }
  return out;
}

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
  lightAim: z.object({ yawDeg: FiniteSchema.min(-180).max(180), pitchDeg: FiniteSchema.min(-90).max(90) }).nullish(),
  floorId: IdSchema,
  roomId: IdSchema.nullish(),
  placementKind: z.enum(["body", "access_panel", "label", "shutoff"]).default("body"),
  mount: MountSchema.optional(),
  /** Free text: "behind the hatch, left of the manifold". */
  locationNote: z.string().trim().max(1000).nullish(),
  /** An `attachment` id — the close-up that makes the location findable. */
  photoId: z.string().min(1).max(64).nullish(),
  /** Which silhouette the 3D view draws. Appearance the household chose, not geometry. */
  symbol: z.string().trim().min(1).max(40).nullish(),
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

export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);

  const db = getDb().db;

  // `?options=placeable` answers "what is there left to place?" — equipment that has no placement
  // with coordinates in this model yet. It lives on this resource for the same reason
  // `?options=projects` lives on routes: it exists only to start a write to *this* resource, and
  // the workspace should not need a second round trip for it.
  //
  // Without this the workspace could only ever show equipment that was already placed, so a
  // freshly imported device was unreachable: not in the tree, not in search, and `E` had nothing
  // to act on. Virtual (software) units are excluded — they are not things you can point at.
  if (new URL(req.url).searchParams.get("options") === "placeable") {
    const revisionIdsForModel = db
      .select({ id: modelRevision.id })
      .from(modelRevision)
      .where(eq(modelRevision.modelId, modelId))
      .all()
      .map((r) => r.id);

    // A placement with no coordinates is a location-only record (see the GET below), so it does
    // not count as placed here: it still has nothing to draw and still needs a position.
    const placed = new Set(
      revisionIdsForModel.length === 0
        ? []
        : db
            .select({ assetId: assetPlacement.assetId })
            .from(assetPlacement)
            .where(
              and(
                inArray(assetPlacement.modelRevisionId, revisionIdsForModel),
                isNotNull(assetPlacement.posX),
              ),
            )
            .all()
            .map((r) => r.assetId),
    );

    const rows = db
      .select({
        assetId: asset.id,
        name: asset.name,
        category: asset.category,
        status: asset.status,
        locationName: location.name,
      })
      .from(asset)
      .leftJoin(location, eq(location.id, asset.locationId))
      .where(and(
        eq(asset.isVirtual, false),
        inArray(asset.status, ["planned", "installed"]),
        isNull(asset.replacedByAssetId),
      ))
      .orderBy(asc(asset.name))
      .all();

    const placeable = rows
      .filter((row) => !placed.has(row.assetId))
      .map((row) => ({
        assetId: row.assetId,
        name: row.name,
        category: row.category,
        status: row.status,
        locationName: row.locationName ?? null,
      }));

    return Response.json({ placeable }, { headers: NO_STORE });
  }
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
      lightAimYawDeg: assetPlacement.lightAimYawDeg,
      lightAimPitchDeg: assetPlacement.lightAimPitchDeg,
      placementKind: assetPlacement.placementKind,
      mountKind: assetPlacement.mountKind,
      mountSurfaceId: assetPlacement.mountSurfaceId,
      mountHeightM: assetPlacement.mountHeightM,
      mountOffsetM: assetPlacement.mountOffsetM,
      locationNote: assetPlacement.locationNote,
      symbol: assetPlacement.symbol,
      photoAttachmentId: assetPlacement.photoAttachmentId,
      needsReconciliation: assetPlacement.needsReconciliation,
      name: asset.name,
      // Read-only, for the view's symbol inference — a wall-mounted sensor and a wall lamp are
      // different silhouettes, and the category is what tells them apart.
      category: asset.category,
    })
    .from(assetPlacement)
    .innerJoin(asset, eq(asset.id, assetPlacement.assetId))
    .where(and(
      inArray(assetPlacement.modelRevisionId, revisionIds),
      eq(asset.isVirtual, false),
      inArray(asset.status, ["planned", "installed"]),
      isNull(asset.replacedByAssetId),
    ))
    .all();

  const linkedEntities = linkedEntitiesByAsset(db, [...new Set(rows.map((row) => row.assetId))]);
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
      lightAim:
        row.lightAimYawDeg != null && row.lightAimPitchDeg != null
          ? { yawDeg: row.lightAimYawDeg, pitchDeg: row.lightAimPitchDeg }
          : null,
      entityId: linkedEntities.get(row.assetId)?.[0]?.entityId ?? null,
      linkedEntities: linkedEntities.get(row.assetId) ?? [],
      symbol: row.symbol,
      category: row.category,
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
    .select({ id: asset.id, name: asset.name, category: asset.category })
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
    if (p.mount?.kind === "wall" && !canMountSurface(index, mountSurfaceId, "wall"))
      throw badRequest("mount_surface_kind_mismatch", {
        surfaceId: mountSurfaceId,
        surfaceKind: surface.kind,
        mountKind: "wall",
      });
    if (p.mount?.kind === "ceiling" && !canMountSurface(index, mountSurfaceId, "ceiling"))
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
    ...(p.lightAim === undefined ? {} : {
      lightAimYawDeg: p.lightAim ? mm(p.lightAim.yawDeg) : null,
      lightAimPitchDeg: p.lightAim ? mm(p.lightAim.pitchDeg) : null,
    }),
    mountKind,
    mountSurfaceId,
    mountHeightM,
    mountOffsetM,
    locationNote: p.locationNote ?? null,
    symbol: p.symbol ?? null,
    photoAttachmentId: p.photoId ?? null,
    needsReconciliation: false,
    colorOverride: p.colorOverride ?? null,
    updatedAtMs: at,
    updatedBy: actor,
  };

  writeTx(db, (tx) => {
    // A stale viewer must not create or move a marker for an archived/replaced unit. Keep its
    // historical placement row, but use the same current-equipment policy as both GET lists.
    const currentEquipment = tx.select({ id: asset.id }).from(asset).where(and(
      eq(asset.id, p.equipmentId),
      eq(asset.isVirtual, false),
      inArray(asset.status, ["planned", "installed"]),
      isNull(asset.replacedByAssetId),
    )).get();
    if (!currentEquipment) throw conflict("equipment_not_current");
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
    .select({ id: assetPlacement.id, rotYawDeg: assetPlacement.rotYawDeg, lightAimYawDeg: assetPlacement.lightAimYawDeg, lightAimPitchDeg: assetPlacement.lightAimPitchDeg })
    .from(assetPlacement)
    .where(
      and(
        eq(assetPlacement.assetId, p.equipmentId),
        eq(assetPlacement.placementKind, p.placementKind),
      ),
    )
    .get();

  const linkedEntities = linkedEntitiesByAsset(db, [p.equipmentId]).get(p.equipmentId) ?? [];

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
    lightAim: stored?.lightAimYawDeg != null && stored.lightAimPitchDeg != null
      ? { yawDeg: stored.lightAimYawDeg, pitchDeg: stored.lightAimPitchDeg } : p.lightAim ?? null,
    mount: clientMount(mountKind, mountSurfaceId, mountHeightM, mountOffsetM),
    floorId: p.floorId,
    roomId: mountRoomId,
    surfaceId: mountSurfaceId,
    locationNote: p.locationNote ?? "",
    photoId: p.photoId ?? null,
    entityId: linkedEntities[0]?.entityId ?? null,
    linkedEntities,
    symbol: p.symbol ?? null,
    category: equipment.category,
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
