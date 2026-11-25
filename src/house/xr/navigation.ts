import * as THREE from "three";
import { poleOfInaccessibility } from "../model/geometry2d";
import type { Room, Surface, Vec3 } from "../model/types";
import type { SceneIndex } from "../scene/SceneIndex";
import { isVisibleUp } from "../scene/applyVisibility";
import type { MarkerLayer } from "../scene/markers";

export function roomLanding(room: Room): Vec3 | null {
  if (!room.footprint || room.kind === "void" || room.kind === "attic") return null;
  const { point, clearance } = poleOfInaccessibility(room.footprint);
  return clearance > 0.2 ? [point[0], room.floorElevation, point[1]] : null;
}

export function walkable(surface: Surface | undefined, normalY: number): boolean {
  if (!surface || normalY < 0.72) return false;
  return surface.kind === "floor" || surface.role === "ground" || surface.role === "paving";
}

/** Move the tracked head's horizontal projection to the destination, keeping physical eye height. */
export function teleport(rig: THREE.Group, headInLocalFloor: THREE.Vector3, destination: THREE.Vector3) {
  const offset = headInLocalFloor.clone().applyQuaternion(rig.quaternion);
  rig.position.set(destination.x - offset.x, destination.y, destination.z - offset.z);
  rig.updateMatrixWorld(true);
}

export function turnAroundHead(rig: THREE.Group, head: THREE.Vector3, angle: number) {
  const before = head.clone().applyQuaternion(rig.quaternion);
  rig.rotateY(angle);
  const after = head.clone().applyQuaternion(rig.quaternion);
  rig.position.add(before.sub(after));
  rig.updateMatrixWorld(true);
}

/** First visible physical surface occludes equipment and destinations behind it. */
export function pickWalkthrough(ray: THREE.Raycaster, index: SceneIndex, markers: MarkerLayer | null) {
  const bodies = ray.intersectObjects(index.pickables, false);
  const surface = bodies[0];
  const marker = markers && ray.intersectObjects(markers.meshes.filter(isVisibleUp), false)[0];
  if (marker && marker.instanceId !== undefined && marker.distance <= (surface?.distance ?? Infinity) + 0.015) {
    const placementId = markers.placementAt(marker.object, marker.instanceId);
    if (placementId) return { placementId, landing: null, point: marker.point };
  }
  if (!surface) return null;
  const id = index.meshSurfaceId.get(surface.object);
  const normal = surface.face?.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(surface.object.matrixWorld));
  return { placementId: surface.object.userData.vhPlacementId as string | undefined,
    landing: id && walkable(index.manifest.surfaces.get(id), normal?.y ?? 0) ? surface.point : null, point: surface.point };
}
