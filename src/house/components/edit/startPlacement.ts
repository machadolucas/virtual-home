"use client";
/**
 * Starting a placement for equipment that has none yet.
 *
 * This is the missing half of edit mode: `toggleEdit` could only ever adjust an existing
 * placement, so equipment imported from Home Assistant had no way into the editor at all — it was
 * absent from the tree and from search (both of which read `placements`), and `E` had nothing to
 * act on. The draft this builds is a *starting point*, not a claim about where the thing is: the
 * user drags or types the real position before saving.
 */
import type { HouseRuntime } from "@/house/runtime";
import type { PlaceableEquipment } from "@/house/store/dataApi";
import type { FloorId, Vec3 } from "@/house/model/types";
import { roomAt } from "@/house/model/manifestIndex";

/** Mean of a footprint ring — good enough for "somewhere in this room, now move me". */
function ringCentre(ring: readonly [number, number][]): [number, number] {
  let x = 0;
  let z = 0;
  for (const [px, pz] of ring) {
    x += px;
    z += pz;
  }
  return [x / ring.length, z / ring.length];
}

/**
 * Where a new marker appears before the user moves it: the middle of the selected room when a room
 * is selected, otherwise the middle of the active floor's own extent. Never (0, 0, 0), which on
 * this coordinate system is a corner of the house and reads as a bug.
 */
function initialPosition(
  runtime: HouseRuntime,
  floorId: FloorId,
): { position: Vec3; roomId: string | null } {
  const s = runtime.store.getState();
  const index = s.index;
  if (!index) return { position: [0, 0, 0], roomId: null };

  const floorElevation = index.floors.get(floorId)?.elevation ?? 0;

  const selection = s.selection;
  if (selection?.kind === "room") {
    const room = index.rooms.get(selection.id);
    if (room && room.floorId === floorId) {
      const [x, z] = ringCentre(room.footprint.outer as readonly [number, number][]);
      return { position: [x, room.floorElevation, z], roomId: room.id };
    }
  }

  const rooms = index.roomsByFloor.get(floorId) ?? [];
  if (rooms.length > 0) {
    // Mean of the floor's room centres: inside the building, and stable regardless of which room
    // happens to be first in the manifest.
    let x = 0;
    let z = 0;
    for (const room of rooms) {
      const [rx, rz] = ringCentre(room.footprint.outer as readonly [number, number][]);
      x += rx;
      z += rz;
    }
    const cx = x / rooms.length;
    const cz = z / rooms.length;
    return { position: [cx, floorElevation, cz], roomId: roomAt(index, floorId, cx, cz) };
  }

  const min = index.manifest.bounds.min;
  const max = index.manifest.bounds.max;
  const cx = ((min?.[0] ?? 0) + (max?.[0] ?? 0)) / 2;
  const cz = ((min?.[2] ?? 0) + (max?.[2] ?? 0)) / 2;
  return { position: [cx, floorElevation, cz], roomId: roomAt(index, floorId, cx, cz) };
}

/**
 * Opens the placement editor on a new draft for `equipment`. Returns false when there is no model
 * loaded to place into, so the caller can say so instead of appearing to do nothing.
 */
export function startPlacement(runtime: HouseRuntime, equipment: PlaceableEquipment): boolean {
  const s = runtime.store.getState();
  const index = s.index;
  if (s.editorSaving || !index || !s.modelId) return false;
  if (s.routeDraft) s.cancelRouteDraft();

  const floorId = s.activeFloorId ?? index.floorOrder[0] ?? null;
  if (!floorId) return false;

  const { position, roomId } = initialPosition(runtime, floorId);

  s.beginEdit({
    placementId: null,
    equipmentId: equipment.assetId,
    modelId: s.modelId,
    name: equipment.name,
    category: equipment.category,
    physical: position,
    rotationYDeg: 0,
    mount: { kind: "floor", height: 0 },
    floorId,
    roomId,
    surfaceId: null,
    locationNote: "",
    photoId: null,
    symbol: null,
    dirty: false,
  });
  s.announce(
    `Placing ${equipment.name}. Drag on the 3D view, or type the position in the inspector, then save.`,
  );
  return true;
}
