import * as THREE from "three";
import type { ManifestIndex } from "../model/manifestIndex";

/** A wall's upper cap cannot run from below its floor into the occupied storey. Keep legitimate
 * sloping/gable caps above the floor; suppress only this contradictory source geometry. */
export function invalidWallCap(mesh: THREE.Mesh, surfaceId: string, manifest: ManifestIndex): boolean {
  if (manifest.surfaces.get(surfaceId)?.role !== "wall-top") return false;
  const floorId = manifest.floorOfSurface.get(surfaceId);
  const floor = floorId ? manifest.floors.get(floorId) : undefined;
  if (!floor) return false;
  const box = new THREE.Box3().setFromObject(mesh);
  return box.min.y < floor.elevation - .05 && box.max.y > floor.elevation + .5;
}

/** The asset's baked wireframe is independent of surface visibility. Remove only line segments
 * on invalid caps from a cloned index; retain all vertex attributes and the source buffers. */
export function withoutCapEdges(edges: THREE.LineSegments, caps: readonly THREE.Mesh[]): THREE.BufferGeometry | null {
  const triangles: THREE.Triangle[] = [];
  for (const cap of caps) {
    const positions = cap.geometry.getAttribute("position"), indices = cap.geometry.index;
    if (!positions) continue;
    for (let i = 0; i + 2 < (indices?.count ?? positions.count); i += 3) {
      const points = [0, 1, 2].map((offset) => new THREE.Vector3()
        .fromBufferAttribute(positions, indices ? indices.getX(i + offset) : i + offset)
        .applyMatrix4(cap.matrixWorld));
      const triangle = new THREE.Triangle(points[0]!, points[1]!, points[2]!);
      if (triangle.getArea() > 1e-8) triangles.push(triangle);
    }
  }
  const positions = edges.geometry.getAttribute("position"), indices = edges.geometry.index;
  if (!positions || triangles.length === 0) return null;
  const closest = new THREE.Vector3();
  const onCap = (point: THREE.Vector3) => triangles.some((triangle) =>
    triangle.closestPointToPoint(point, closest).distanceToSquared(point) < 1e-6);
  const kept: number[] = [];
  const count = indices?.count ?? positions.count;
  for (let i = 0; i + 1 < count; i += 2) {
    const a = indices ? indices.getX(i) : i, b = indices ? indices.getX(i + 1) : i + 1;
    const start = new THREE.Vector3().fromBufferAttribute(positions, a).applyMatrix4(edges.matrixWorld);
    const end = new THREE.Vector3().fromBufferAttribute(positions, b).applyMatrix4(edges.matrixWorld);
    if (onCap(start) && onCap(end) && onCap(start.clone().lerp(end, .5))) continue;
    kept.push(a, b);
  }
  if (kept.length === count) return null;
  const geometry = edges.geometry.clone();
  geometry.setIndex(kept);
  return geometry;
}
