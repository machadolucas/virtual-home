import * as THREE from "three";
import type { Furnishing, Vec3 } from "../model/types";
import type { SceneIndex } from "./SceneIndex";

interface WallTriangles { bounds: THREE.Box3; vertices: THREE.Vector3[] }
const cache = new WeakMap<SceneIndex, { count: number; walls: WallTriangles[] }>();

/** Physical wall triangles, including walls temporarily hidden/cut for an inside view. The
 * oriented furniture box is tested against triangles, not a diagonal wall's oversized AABB. */
function wallTriangles(index: SceneIndex): WallTriangles[] {
  const previous = cache.get(index);
  if (previous?.count === index.assets.size) return previous.walls;
  const walls: WallTriangles[] = [];
  for (const asset of index.assets.values()) {
    if (index.manifest.assets.get(asset.id)?.kind === "scan-reference") continue;
    for (const mesh of asset.meshes) {
      const sid = index.meshSurfaceId.get(mesh);
      const surface = sid ? index.manifest.surfaces.get(sid) : undefined;
      const element = surface?.elementId ? index.manifest.elements.get(surface.elementId) : undefined;
      if (surface?.kind !== "wall" && !element?.kind.includes("wall") && element?.kind !== "door") continue;
      mesh.updateWorldMatrix(true, false);
      const position = mesh.geometry.getAttribute("position");
      if (!position) continue;
      const indices = mesh.geometry.index;
      const vertices: THREE.Vector3[] = [];
      const bounds = new THREE.Box3();
      for (let i = 0; i < (indices?.count ?? position.count); i++) {
        const point = new THREE.Vector3().fromBufferAttribute(position, indices ? indices.getX(i) : i).applyMatrix4(mesh.matrixWorld);
        vertices.push(point); bounds.expandByPoint(point);
      }
      walls.push({ bounds, vertices });
    }
  }
  cache.set(index, { count: index.assets.size, walls });
  return walls;
}

export function furnishingWallCollision(item: Furnishing, walls: readonly WallTriangles[]): boolean {
  const origin = new THREE.Vector3(...item.position);
  const inverseYaw = new THREE.Matrix4().makeRotationY(-THREE.MathUtils.degToRad(item.rotationYDeg));
  // A tiny tolerance lets furniture touch a wall without treating contact as penetration.
  const box = new THREE.Box3(new THREE.Vector3(-item.widthM / 2 + .003, .003, -item.depthM / 2 + .003),
    new THREE.Vector3(item.widthM / 2 - .003, item.heightM - .003, item.depthM / 2 - .003));
  const worldBounds = box.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(item.rotationYDeg)).setPosition(origin));
  const triangle = new THREE.Triangle();
  for (const wall of walls) {
    if (!worldBounds.intersectsBox(wall.bounds)) continue;
    for (let i = 0; i + 2 < wall.vertices.length; i += 3) {
      triangle.a.copy(wall.vertices[i]!).sub(origin).applyMatrix4(inverseYaw);
      triangle.b.copy(wall.vertices[i + 1]!).sub(origin).applyMatrix4(inverseYaw);
      triangle.c.copy(wall.vertices[i + 2]!).sub(origin).applyMatrix4(inverseYaw);
      if (box.intersectsTriangle(triangle)) return true;
    }
  }
  return false;
}

export function furnishingPlacementError(item: Furnishing, index: SceneIndex): string | null {
  const values = [...item.position, item.widthM, item.depthM, item.heightM, item.rotationYDeg];
  if (!values.every(Number.isFinite) || item.widthM < .05 || item.depthM < .05 || item.heightM < .01)
    return "Enter valid furniture dimensions and coordinates.";
  if (item.position.some((value, axis) => value < index.manifest.manifest.bounds.min[axis]! || value > index.manifest.manifest.bounds.max[axis]!))
    return "Move the furniture inside the model bounds.";
  if (furnishingWallCollision(item, wallTriangles(index))) return "Overlaps a wall or door. Move or resize the furniture.";
  return null;
}

export function roundedPosition(position: Vec3): Vec3 {
  return position.map((value) => Math.round(value * 1000) / 1000) as Vec3;
}

/** Rebuild physical collision geometry after restoring an exploded view to normal. */
export function clearFurnishingCollisionCache(index: SceneIndex): void { cache.delete(index); }
