/**
 * Clip-aware picking.
 *
 * `index.pickables` is precomputed by `applyVisibility`, so a click does no traversal:
 * `intersectObjects(list, false)`. Every hit is then tested against its own group's clipping
 * planes, because a fragment that the cutaway removed must not be selectable even though the
 * triangle is still there.
 *
 * `DoubleSide` means back faces are hit. That is correct and wanted in a cutaway (you want the
 * inside face of the far wall) and harmless otherwise, because the nearest kept hit wins.
 */
import * as THREE from "three";
import type {
  BuildingId,
  ElementId,
  FloorId,
  RoomId,
  SurfaceId,
} from "@/house/model/types";
import type { ClipGroups } from "./clipGroups";
import type { SceneIndex } from "./SceneIndex";
import { isVisibleUp } from "./applyVisibility";
import { canMountSurface } from "../model/mountSurface";

export interface PickResult {
  surfaceId: SurfaceId | null;
  elementId: ElementId | null;
  roomId: RoomId | null;
  floorId: FloorId | null;
  buildingId: BuildingId | null;
  point: THREE.Vector3;
  /** World normal facing the side hit by the pointer ray. */
  normal?: THREE.Vector3;
  object: THREE.Object3D;
  distance: number;
}

/** Desktop picks the centre ray only; touch tries a small ring so a fat finger still lands. */
const DESKTOP_OFFSETS: ReadonlyArray<readonly [number, number]> = [[0, 0]];
const TOUCH_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-9, 0],
  [9, 0],
  [0, -9],
  [0, 9],
];

/** Pointer travel beyond which a pointerup is a drag, not a click. */
export const CLICK_SLOP_MOUSE = 4;
export const CLICK_SLOP_TOUCH = 8;

export class Picker {
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  pick(
    clientX: number,
    clientY: number,
    rect: { left: number; top: number; width: number; height: number },
    camera: THREE.Camera,
    index: SceneIndex,
    clip: ClipGroups,
    opts: { touch?: boolean; candidates?: THREE.Object3D[] } = {},
  ): PickResult | null {
    const offsets = opts.touch ? TOUCH_OFFSETS : DESKTOP_OFFSETS;
    const list = opts.candidates ?? index.pickables;
    if (list.length === 0) return null;

    for (const [dx, dy] of offsets) {
      this.ndc.set(
        ((clientX + dx - rect.left) / rect.width) * 2 - 1,
        -((clientY + dy - rect.top) / rect.height) * 2 + 1,
      );
      this.ray.setFromCamera(this.ndc, camera);
      const hits = this.ray.intersectObjects(list, false);
      for (const hit of hits) {
        const sid = index.meshSurfaceId.get(hit.object) ?? (hit.object.userData.surfaceId as string | undefined);
        const group = (sid && index.clipGroupOf.get(sid)) || "site";
        if (!clip.keeps(group, hit.point)) continue;
        const result = resolveOwnership(hit, index);
        if (result.normal && result.normal.dot(this.ray.ray.direction) > 0) result.normal.negate();
        return result;
      }
    }
    return null;
  }
}

/**
 * Ownership from `userData` (GLTFLoader copies glTF `extras` there), then by walking parents —
 * which is how the package's own convention says to resolve it.
 */
export function resolveOwnership(
  hit: THREE.Intersection,
  index: SceneIndex,
): PickResult {
  const surfaceId =
    index.meshSurfaceId.get(hit.object) ??
    (hit.object.userData.surfaceId as SurfaceId | undefined) ??
    null;

  let elementId = (hit.object.userData.elementId as ElementId | undefined) ?? null;
  let roomId = (hit.object.userData.roomId as RoomId | undefined) ?? null;
  let floorId = (hit.object.userData.floorId as FloorId | undefined) ?? null;
  let buildingId = (hit.object.userData.buildingId as BuildingId | undefined) ?? null;

  if (surfaceId) {
    const s = index.manifest.surfaces.get(surfaceId);
    elementId ??= s?.elementId ?? null;
    roomId ??= s?.roomId ?? null;
    floorId ??= index.manifest.floorOfSurface.get(surfaceId) ?? null;
  }

  let node: THREE.Object3D | null = hit.object.parent;
  while (node && (!elementId || !floorId || !buildingId)) {
    elementId ??= (node.userData.elementId as ElementId | undefined) ?? null;
    floorId ??= (node.userData.floorId as FloorId | undefined) ?? null;
    buildingId ??= (node.userData.buildingId as BuildingId | undefined) ?? null;
    node = node.parent;
  }
  if (!buildingId && floorId) buildingId = index.manifest.floors.get(floorId)?.buildingId ?? null;

  return {
    surfaceId,
    elementId,
    roomId,
    floorId,
    buildingId,
    point: hit.point.clone(),
    normal: hit.face?.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize(),
    object: hit.object,
    distance: hit.distance,
  };
}

/** Ray candidates during a placement drag: the active floor's floor and wall faces only. */
export function dragCandidates(index: SceneIndex, floorId: FloorId | null): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const [sid, mesh] of index.surfaceMesh) {
    const s = index.manifest.surfaces.get(sid);
    if (!s) continue;
    if (!isVisibleUp(mesh)) continue;

    // Roof undersides and other soffits belong to no floor — an eave is above the ground floor's
    // ceiling and below the roof — so they are admitted regardless of the isolated floor. Without
    // this an eave spot could not be aimed at all, which is the case that motivated it.
    if (canMountSurface(index.manifest, sid, "ceiling")) {
      out.push(mesh);
      continue;
    }

    if (s.kind !== "floor" && !canMountSurface(index.manifest, sid, "wall")) continue;
    if (floorId && index.manifest.floorOfSurface.get(sid) !== floorId) continue;
    out.push(mesh);
  }
  return out;
}

/** Ray/plane intersection at a fixed height, for the free-placement fallback. */
export function intersectHorizontalPlane(
  ndcX: number,
  ndcY: number,
  camera: THREE.Camera,
  y: number,
): THREE.Vector3 | null {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
  const target = new THREE.Vector3();
  return ray.ray.intersectPlane(plane, target) ? target : null;
}
