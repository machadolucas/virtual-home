/**
 * Transient context used while inspecting a selection.
 *
 * This never enters persisted view state. Clearing the selection therefore restores the user's
 * roof, ceiling and floor choices exactly as they were before focus.
 */
import { boxCenter, boxSize, roomBox } from "./framingBoxes";
import type { ManifestIndex } from "./manifestIndex";
import type { BuildingId, FloorId, Placement, RoomId, Selection, SurfaceId, Vec3 } from "./types";

export interface FocusContext {
  floorId: FloorId | null;
  buildingId: BuildingId;
  /** Present for rooms, room surfaces, and equipment placed in a room. */
  roomId: RoomId | null;
  /** A specifically selected/mounted face must remain visible through contextual reveal. */
  preserveSurfaceId: SurfaceId | null;
  /** Exterior roof/eave equipment needs its supporting roof geometry as context. */
  keepRoof: boolean;
}

export function focusContextFor(
  index: ManifestIndex,
  selection: Selection | null,
  placement: (id: string) => Placement | undefined = () => undefined,
  enabled = true,
): FocusContext | null {
  if (!enabled || !selection) return null;

  let floorId: FloorId | null = null;
  let roomId: RoomId | null = null;
  let preserveSurfaceId: SurfaceId | null = null;
  let keepRoof = false;
  switch (selection.kind) {
    case "building":
      return index.buildings.has(selection.id)
        ? {
            floorId: null,
            buildingId: selection.id,
            roomId: null,
            preserveSurfaceId: null,
            keepRoof: true,
          }
        : null;
    case "floor":
      floorId = selection.id;
      break;
    case "room": {
      const room = index.rooms.get(selection.id);
      floorId = room?.floorId ?? null;
      roomId = room?.id ?? null;
      break;
    }
    case "surface": {
      const surface = index.surfaces.get(selection.id);
      floorId = index.floorOfSurface.get(selection.id) ?? null;
      roomId = surface?.roomId ?? null;
      preserveSurfaceId = surface?.id ?? null;
      break;
    }
    case "element":
      {
        const element = index.elements.get(selection.id);
        floorId = element?.floorId ?? null;
        // A terrace is a floor-like outdoor area at grade even when the package omits its floor
        // id. Resolve it to the owning building's lowest datum; roof/terrain elements deliberately
        // do not use this fallback because revealing those means keeping their own geometry.
        if (!floorId && element?.kind === "terrace" && element.buildingId) {
          floorId = [...(index.floorsByBuilding.get(element.buildingId) ?? [])].sort(
            (a, b) => a.elevation - b.elevation,
          )[0]?.id ?? null;
        }
      }
      break;
    case "equipment": {
      const p = placement(selection.id);
      floorId = p?.floorId ?? null;
      roomId = p?.roomId ?? null;
      preserveSurfaceId = p?.surfaceId ?? null;
      keepRoof = Boolean(p && !p.roomId && p.surfaceId && index.floorOfSurface.get(p.surfaceId) === null);
      break;
    }
    default:
      return null;
  }

  if (!floorId) return null;
  const buildingId = index.floors.get(floorId)?.buildingId;
  return buildingId
    ? { floorId, buildingId, roomId, preserveSurfaceId, keepRoof }
    : null;
}

/** True only for a higher floor in the same building as the focused floor. */
export function isAboveFocus(
  index: ManifestIndex,
  floorId: FloorId,
  focus: FocusContext,
): boolean {
  const floor = index.floors.get(floorId);
  const focused = focus.floorId ? index.floors.get(focus.floorId) : undefined;
  return Boolean(
    floor &&
      focused &&
      floor.buildingId === focus.buildingId &&
      floor.elevation > focused.elevation,
  );
}

/**
 * Room walls between the camera and the room centre. These receive a low horizontal cut for a
 * Sims-style open side while the back and side walls remain full height. Geometry centres are
 * supplied by the scene layer, which keeps this classifier deterministic and Three-free.
 */
export function cameraFacingRoomWalls(
  index: ManifestIndex,
  roomId: RoomId,
  camera: Vec3,
  surfaceCentres: ReadonlyMap<SurfaceId, Vec3>,
): SurfaceId[] {
  const room = index.rooms.get(roomId);
  if (!room) return [];
  const box = roomBox(room, 0);
  const centre = boxCenter(box);
  const size = boxSize(box);
  const viewX = camera[0] - centre[0];
  const viewZ = camera[2] - centre[2];
  const viewLength = Math.hypot(viewX, viewZ);
  if (viewLength < 1e-6) return [];
  const nx = viewX / viewLength;
  const nz = viewZ / viewLength;
  // Ignore walls close to the room's middle line. This keeps true side walls at oblique angles.
  const threshold = Math.max(0.08, Math.hypot(size[0], size[2]) * 0.06);

  const hidden: SurfaceId[] = [];
  for (const [sid, surface] of index.surfaces) {
    if (surface.kind !== "wall" || index.floorOfSurface.get(sid) !== room.floorId) continue;
    const p = surfaceCentres.get(sid);
    if (!p) continue;
    const dx = p[0] - centre[0];
    const dz = p[2] - centre[2];
    const along = dx * nx + dz * nz;
    const across = Math.abs(dx * -nz + dz * nx);
    const corridor = Math.max(size[0], size[2]) * 0.8;
    if (along > threshold && along < viewLength && across <= corridor) hidden.push(sid);
  }
  return hidden;
}

/**
 * Expand camera-facing wall faces to the rest of the same physical wall and its attached openings.
 * This keeps exterior skins, wall-top/trim bands, door leaves and window reveals from floating
 * above a cut wall, without clipping unrelated elements on the floor.
 */
export function focusCutSurfaceIds(
  index: ManifestIndex,
  cameraFacingWallIds: readonly SurfaceId[],
): SurfaceId[] {
  const wallElements = new Set<string>();
  for (const sid of cameraFacingWallIds) {
    const elementId = index.surfaces.get(sid)?.elementId;
    if (elementId) wallElements.add(elementId);
  }

  const cutElements = new Set(wallElements);
  for (const element of index.elements.values()) {
    if (element.wallId && wallElements.has(element.wallId)) cutElements.add(element.id);
  }

  const ids = new Set<SurfaceId>(cameraFacingWallIds);
  for (const elementId of cutElements)
    for (const sid of index.surfacesByElement.get(elementId) ?? []) ids.add(sid);
  return [...ids];
}

/**
 * A wall-top is the cap of the uncut source wall, not a replacement cap for the low wall. Clip it
 * wholly below the floor while its wall assembly is cut. This also prevents a malformed sloping
 * cap from leaving a diagonal wedge below the ordinary focus height.
 */
export function focusCutYForSurface(
  index: ManifestIndex,
  surfaceId: SurfaceId,
  cutY: number,
  floorY: number,
): number {
  return index.surfaces.get(surfaceId)?.role === "wall-top" ? floorY - 0.01 : cutY;
}

/** The selected wall face may stay whole in contextual view, but its source cap never may. */
export function preservesFocusCutSurface(
  index: ManifestIndex,
  surfaceId: SurfaceId,
  preserveSurfaceId: SurfaceId | null,
): boolean {
  return surfaceId === preserveSurfaceId && index.surfaces.get(surfaceId)?.role !== "wall-top";
}
