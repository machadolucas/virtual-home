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
import { defaultLightAim } from "../model/equipmentLight";
import { isDirectionalSymbol, isLedBar, ledLength } from "../model/equipmentOptics";
import { DEFAULT_SOLAR_PANEL_CONFIG } from "../model/solarPanel";
import { treeScale } from "../model/tree";
import { isPlacementSymbol, symbolGeometry } from "./symbols";
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

/** Keep room context for tiny devices, but include the full physical appliance/lamp envelope. */
export function equipmentBox3(p: Pick<Placement, "position"> & Partial<Placement>): THREE.Box3 {
  const box = toBox3(equipmentBox(p));
  if (!isPlacementSymbol(p.symbol)) return box;
  const panel = p.symbol === "solar_panel" ? p.solarPanel ?? DEFAULT_SOLAR_PANEL_CONFIG : null;
  const rotation = new THREE.Euler(THREE.MathUtils.degToRad(panel?.tiltDeg ?? 0), THREE.MathUtils.degToRad(p.rotationYDeg ?? 0), 0, "YXZ");
  const scale = new THREE.Vector3(panel?.widthM ?? 1, panel?.thicknessM ?? 1, panel?.lengthM ?? 1);
  if (isDirectionalSymbol(p.symbol)) {
    const aim = p.lightAim ?? defaultLightAim(p.symbol, p.rotationYDeg);
    rotation.set(THREE.MathUtils.degToRad(-aim.pitchDeg), THREE.MathUtils.degToRad(aim.yawDeg), 0, "YXZ");
  }
  if (isLedBar(p.symbol)) scale.set(p.symbol === "led_bar_horizontal" ? ledLength(p.ledLengthM) : 1, p.symbol === "led_bar_vertical" ? ledLength(p.ledLengthM) : 1, 1);
  if (p.symbol === "tree") scale.setScalar(treeScale(p.treeHeightM));
  const transform = new THREE.Matrix4().compose(new THREE.Vector3(...p.position), new THREE.Quaternion().setFromEuler(rotation), scale);
  return box.union(symbolGeometry(p.symbol).boundingBox!.clone().applyMatrix4(transform).expandByScalar(0.2));
}

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
