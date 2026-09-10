import * as THREE from "three";
import { isVisibleUp } from "./applyVisibility";

export type PointVisibility = (point: THREE.Vector3) => boolean;

/**
 * Three's raycaster does not apply Object3D visibility or material clipping. R3F event handling
 * therefore needs this small adapter so an invisible floor's furniture, or the clipped-away part
 * of a visible furnishing, cannot receive pointer events.
 */
export function furnishingRaycast(keepsPoint: PointVisibility): THREE.Mesh["raycast"] {
  return function raycast(
    this: THREE.Mesh,
    raycaster: THREE.Raycaster,
    intersections: THREE.Intersection[],
  ): void {
    if (!isVisibleUp(this)) return;
    const first = intersections.length;
    THREE.Mesh.prototype.raycast.call(this, raycaster, intersections);
    for (let index = intersections.length - 1; index >= first; index -= 1) {
      const hit = intersections[index];
      if (hit && !keepsPoint(hit.point)) intersections.splice(index, 1);
    }
  };
}
