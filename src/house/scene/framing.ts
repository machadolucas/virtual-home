/** `Box3` adapters over the pure `framingBoxes` module, plus geometry-derived boxes. */
import * as THREE from "three";
import {
  boxUnion,
  buildingBox,
  emptyBox,
  equipmentBox,
  expandBox,
  floorBox,
  isEmptyBox,
  planBox,
  propertyBox,
  roomBox,
  routeBox,
  surfaceBox,
} from "@/house/model/framingBoxes";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import type { Box, BuildingId, FloorId, Placement, RoomId, Route, Selection } from "@/house/model/types";
import type { SceneIndex } from "./SceneIndex";

export const toBox3 = (b: Box): THREE.Box3 =>
  new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));

export const fromBox3 = (b: THREE.Box3): Box => ({
  min: [b.min.x, b.min.y, b.min.z],
  max: [b.max.x, b.max.y, b.max.z],
});

export const roomBox3 = (index: ManifestIndex, roomId: RoomId): THREE.Box3 => {
  const room = index.rooms.get(roomId);
  return room ? toBox3(roomBox(room)) : new THREE.Box3();
};

export const floorBox3 = (index: ManifestIndex, floorId: FloorId): THREE.Box3 =>
  toBox3(floorBox(index, floorId));

export const planBox3 = (index: ManifestIndex, floorId: FloorId): THREE.Box3 =>
  toBox3(planBox(index, floorId));

export const buildingBox3 = (index: ManifestIndex, id: BuildingId): THREE.Box3 =>
  toBox3(buildingBox(index, id));

export const propertyBox3 = (index: ManifestIndex): THREE.Box3 => toBox3(propertyBox(index));

export const equipmentBox3 = (p: Pick<Placement, "position">): THREE.Box3 =>
  toBox3(equipmentBox(p));

export const routeBox3 = (r: Pick<Route, "points">): THREE.Box3 => toBox3(routeBox(r));

/** Exact bounds of a surface's mesh, when it is loaded; the manifest box otherwise. */
export function surfaceBox3(index: SceneIndex, surfaceId: string): THREE.Box3 {
  const mesh = index.surfaceMesh.get(surfaceId);
  if (mesh?.geometry) {
    const box = new THREE.Box3().setFromObject(mesh);
    if (!box.isEmpty()) return box;
  }
  return toBox3(surfaceBox(index.manifest, surfaceId));
}

/** The box to frame for a selection. */
export function boxForSelection(
  index: SceneIndex,
  selection: Selection | null,
  lookup: {
    placement?: (id: string) => Placement | undefined;
    route?: (id: string) => Route | undefined;
  } = {},
): THREE.Box3 | null {
  if (!selection) return null;
  const m = index.manifest;
  switch (selection.kind) {
    case "room":
      return roomBox3(m, selection.id);
    case "surface":
      return surfaceBox3(index, selection.id);
    case "floor":
      return floorBox3(m, selection.id);
    case "building":
      return buildingBox3(m, selection.id);
    case "element": {
      let box = emptyBox();
      for (const sid of m.surfacesByElement.get(selection.id) ?? [])
        box = boxUnion(box, fromBox3(surfaceBox3(index, sid)));
      return isEmptyBox(box) ? null : toBox3(expandBox(box, 0.3));
    }
    case "equipment": {
      const p = lookup.placement?.(selection.id);
      return p ? equipmentBox3(p) : null;
    }
    case "route": {
      const r = lookup.route?.(selection.id);
      return r ? routeBox3(r) : null;
    }
    default:
      return null;
  }
}
