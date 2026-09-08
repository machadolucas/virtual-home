import "server-only";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { modelRevision } from "@/db/schema";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import { roomAt } from "@/house/model/manifestIndex";
import { badRequest, conflict, HttpError } from "@/server/api/handler";
import type { CurrentPackage } from "@/server/house-model/package";

/**
 * The pieces every infrastructure endpoint needs before it may write a coordinate: the revision to
 * stamp, the household's own idea of "today", and the two guards from `docs/model-contract.md`
 * §3.2 — physical view mode and in-bounds coordinates.
 */

/** Millimetre rounding. Positions are metres; a millimetre is finer than the model is honest to. */
export const mm = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * The revision a write is stamped with. Created by the model import pipeline, so until an import
 * has run every write answers `409 model_revision_missing` and the workspace keeps the user's work
 * in its session store (and says so) — exactly as `colors` and `placements` already do.
 */
export function requireCurrentRevisionId(db: Db, modelId: string, what: string): string {
  const revision = db
    .select({ id: modelRevision.id })
    .from(modelRevision)
    .where(and(eq(modelRevision.modelId, modelId), eq(modelRevision.status, "current")))
    .get();
  if (!revision)
    throw conflict("model_revision_missing", {
      hint: `import the model package first (pnpm vh-admin model-import <dir>); ${what} stay local until then`,
    });
  return revision.id;
}

/** Every revision of this model — reads span them, because a row keeps its own revision pointer. */
export function revisionIdsFor(db: Db, modelId: string): string[] {
  return db
    .select({ id: modelRevision.id })
    .from(modelRevision)
    .where(eq(modelRevision.modelId, modelId))
    .all()
    .map((r) => r.id);
}

/**
 * The household's calendar date (CLAUDE.md rule 4: never `new Date()` arithmetic). Re-exported
 * from the settings queries rather than reimplemented, so there is one reading of "today".
 */
export { householdToday } from "@/server/queries/settings/household";

/**
 * Rule 7: a coordinate read in an exploded or cutaway view is a presentation value and must never
 * reach a table. The client already collapses and locks the exploded view before editing; this is
 * the server-side backstop.
 */
export function assertPhysicalViewMode(viewMode: string): void {
  if (viewMode === "normal") return;
  throw new HttpError(422, "presentation_view_mode", undefined, {
    viewMode,
    hint: "collapse the exploded view and send physical site coordinates",
  });
}

/** A point outside the package's own bounds is a coordinate-frame mistake, not a long pipe. */
export function assertInBounds(pkg: CurrentPackage, position: readonly number[]): void {
  const bounds = pkg.manifest.bounds;
  for (let i = 0; i < 3; i++) {
    const v = position[i] as number;
    if (v < (bounds.min[i] as number) || v > (bounds.max[i] as number))
      throw badRequest("out_of_bounds", { axis: "xyz"[i], value: v, bounds });
  }
}

/** A surface id the current package does not know is refused, never stored and hoped about. */
export function assertKnownSurface(
  index: ManifestIndex,
  surfaceId: string | null | undefined,
): void {
  if (surfaceId == null) return;
  if (!index.surfaces.has(surfaceId)) throw badRequest("unknown_surface", { surfaceId });
}

export interface ResolvedPlace {
  floorId: string | null;
  roomId: string | null;
}

/**
 * The floor/room of a point. An explicit `floorId`/`roomId` is validated and honoured; otherwise
 * the room is resolved from the footprint the point falls in, and a point outside every room's
 * footprint legitimately resolves to a floor with no room.
 */
export function resolvePlace(
  index: ManifestIndex,
  place: { floorId?: string | null; roomId?: string | null },
  x: number,
  z: number,
): ResolvedPlace {
  const roomId = place.roomId ?? null;
  if (roomId !== null) {
    const room = index.rooms.get(roomId);
    if (!room) throw badRequest("unknown_room", { roomId });
    if (place.floorId != null && place.floorId !== room.floorId)
      throw badRequest("room_floor_mismatch", { roomId, floorId: room.floorId });
    return { floorId: room.floorId, roomId };
  }
  const floorId = place.floorId ?? null;
  if (floorId === null) return { floorId: null, roomId: null };
  if (!index.floors.has(floorId)) throw badRequest("unknown_floor", { floorId });
  return { floorId, roomId: roomAt(index, floorId, x, z) };
}

/**
 * Any id the package still knows: a room, a floor, a surface, an element or a building. Used for
 * `annotation.model_node_id`, which is deliberately not restricted to one node kind.
 */
export function assertKnownNode(index: ManifestIndex, nodeId: string | null | undefined): void {
  if (nodeId == null) return;
  const known =
    index.rooms.has(nodeId) ||
    index.floors.has(nodeId) ||
    index.surfaces.has(nodeId) ||
    index.elements.has(nodeId) ||
    index.buildings.has(nodeId);
  if (!known) throw badRequest("unknown_model_node", { modelNodeId: nodeId });
}
