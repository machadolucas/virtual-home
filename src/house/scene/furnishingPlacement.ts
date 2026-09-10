import * as THREE from "three";
import type { Furnishing, Vec3 } from "../model/types";
import type { SceneIndex } from "./SceneIndex";
import { furnishingGeometry } from "./furnishingGeometry";

interface WallTriangles { surfaceId?: string; bounds: THREE.Box3; vertices: THREE.Vector3[] }
const cache = new WeakMap<SceneIndex, { count: number; walls: WallTriangles[] }>();

/** A yaw-only physical envelope. `position` is the centre of its bottom face. */
export type PlacementEnvelope = Pick<Furnishing, "id" | "position" | "rotationYDeg" | "widthM" | "depthM" | "heightM">;
export interface PlacementCollisionShape { id: string; parts: PlacementEnvelope[]; bounds: THREE.Box3 }

const CONTACT_EPSILON = .003;

/**
 * Exact overlap for the yaw-only boxes used by furniture and equipment previews. Contact is
 * allowed: an item may sit on a table or be mounted flush to a vertical face without the support
 * itself making the preview invalid.
 */
export function placementEnvelopeCollision(a: PlacementEnvelope, b: PlacementEnvelope): boolean {
  const aBottom = a.position[1] + CONTACT_EPSILON;
  const aTop = a.position[1] + a.heightM - CONTACT_EPSILON;
  const bBottom = b.position[1] + CONTACT_EPSILON;
  const bTop = b.position[1] + b.heightM - CONTACT_EPSILON;
  if (aTop <= bBottom || bTop <= aBottom) return false;

  const axes = (yawDeg: number) => {
    const yaw = THREE.MathUtils.degToRad(yawDeg);
    return [new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw)), new THREE.Vector2(Math.sin(yaw), Math.cos(yaw))] as const;
  };
  const aa = axes(a.rotationYDeg);
  const ba = axes(b.rotationYDeg);
  const delta = new THREE.Vector2(b.position[0] - a.position[0], b.position[2] - a.position[2]);
  const ah = [Math.max(0, a.widthM / 2 - CONTACT_EPSILON), Math.max(0, a.depthM / 2 - CONTACT_EPSILON)] as const;
  const bh = [Math.max(0, b.widthM / 2 - CONTACT_EPSILON), Math.max(0, b.depthM / 2 - CONTACT_EPSILON)] as const;
  for (const axis of [...aa, ...ba]) {
    const distance = Math.abs(delta.dot(axis));
    const ar = ah[0] * Math.abs(aa[0].dot(axis)) + ah[1] * Math.abs(aa[1].dot(axis));
    const br = bh[0] * Math.abs(ba[0].dot(axis)) + bh[1] * Math.abs(ba[1].dot(axis));
    if (distance >= ar + br) return false;
  }
  return true;
}

export function collidesWithPlacedObject(item: PlacementEnvelope, obstacles: readonly PlacementEnvelope[]): boolean {
  return obstacles.some((other) => other.id !== item.id && placementEnvelopeCollision(item, other));
}

/** Rugs are an underlay and deliberately do not reserve a solid volume. */
export function furnishingCollisionShape(item: Furnishing): PlacementCollisionShape | null {
  if (item.kind === "rug") return null;
  return collisionShapeFromGeometry(item.id, furnishingGeometry(item.kind), item.position,
    item.rotationYDeg, new THREE.Vector3(item.widthM, item.heightM, item.depthM));
}

const componentBoundsCache = new WeakMap<THREE.BufferGeometry, THREE.Box3[]>();

/** Bounds of disconnected authored primitives; merged furniture geometry deliberately retains them. */
function componentBounds(geometry: THREE.BufferGeometry): THREE.Box3[] {
  const cached = componentBoundsCache.get(geometry);
  if (cached) return cached;
  const position = geometry.getAttribute("position");
  const indices = geometry.index;
  const triangleCount = Math.floor((indices?.count ?? position.count) / 3);
  const parent = Array.from({ length: triangleCount }, (_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
  const union = (a: number, b: number) => { const ar = find(a), br = find(b); if (ar !== br) parent[br] = ar; };
  const owner = new Map<string, number>();
  const vertex = new THREE.Vector3();
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    for (let corner = 0; corner < 3; corner++) {
      const offset = triangle * 3 + corner;
      vertex.fromBufferAttribute(position, indices ? indices.getX(offset) : offset);
      const key = `${vertex.x.toFixed(6)},${vertex.y.toFixed(6)},${vertex.z.toFixed(6)}`;
      const previous = owner.get(key);
      if (previous === undefined) owner.set(key, triangle); else union(triangle, previous);
    }
  }
  const groups = new Map<number, THREE.Box3>();
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const bounds = groups.get(find(triangle)) ?? new THREE.Box3();
    for (let corner = 0; corner < 3; corner++) {
      const offset = triangle * 3 + corner;
      bounds.expandByPoint(vertex.fromBufferAttribute(position, indices ? indices.getX(offset) : offset));
    }
    groups.set(find(triangle), bounds);
  }
  const result = [...groups.values()];
  componentBoundsCache.set(geometry, result);
  return result;
}

/** Transform every authored primitive into the yaw-only envelope used by the placement editor. */
export function collisionShapeFromGeometry(
  id: string,
  geometry: THREE.BufferGeometry,
  position: readonly [number, number, number],
  rotationYDeg: number,
  scale: THREE.Vector3,
  tilt = 0,
): PlacementCollisionShape {
  const yaw = THREE.MathUtils.degToRad(rotationYDeg);
  const localTransform = new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z)
    .premultiply(new THREE.Matrix4().makeRotationX(tilt));
  const origin = new THREE.Vector3(...position);
  const parts = componentBounds(geometry).map((source, part) => {
    const bounds = source.clone().applyMatrix4(localTransform);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3()).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(origin);
    return { id: `${id}:${part}`, position: [center.x, center.y - size.y / 2, center.z], rotationYDeg,
      widthM: size.x, heightM: size.y, depthM: size.z } as PlacementEnvelope;
  });
  const bounds = new THREE.Box3();
  for (const item of parts) {
    const local = new THREE.Box3(
      new THREE.Vector3(-item.widthM / 2, 0, -item.depthM / 2),
      new THREE.Vector3(item.widthM / 2, item.heightM, item.depthM / 2),
    );
    bounds.union(local.applyMatrix4(new THREE.Matrix4().makeRotationY(
      THREE.MathUtils.degToRad(item.rotationYDeg),
    ).setPosition(new THREE.Vector3(...item.position))));
  }
  return { id, parts, bounds };
}

/** Per-primitive envelopes preserve the open space under tables, chairs, benches and shelves. */
export function placementShapeCollision(a: PlacementCollisionShape, b: PlacementCollisionShape): boolean {
  if (a.id === b.id || !a.bounds.intersectsBox(b.bounds)) return false;
  return a.parts.some((ap) => b.parts.some((bp) => placementEnvelopeCollision(ap, bp)));
}

export function collidesWithPlacementShape(item: PlacementCollisionShape | null, obstacles: readonly (PlacementCollisionShape | null)[]): boolean {
  return !!item && obstacles.some((other) => !!other && placementShapeCollision(item, other));
}

/** Physical wall triangles, including walls temporarily hidden/cut for an inside view. The
 * oriented furniture box is tested against triangles, not a diagonal wall's oversized AABB. */
export function wallTriangles(index: SceneIndex): WallTriangles[] {
  const previous = cache.get(index);
  if (previous?.count === index.assets.size) return previous.walls;
  const walls: WallTriangles[] = [];
  for (const asset of index.assets.values()) {
    if (index.manifest.assets.get(asset.id)?.kind === "scan-reference") continue;
    for (const mesh of asset.meshes) {
      const sid = index.meshSurfaceId.get(mesh);
      const surface = sid ? index.manifest.surfaces.get(sid) : undefined;
      if (surface?.role === "wall-top") continue;
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
      walls.push({ surfaceId: sid, bounds, vertices });
    }
  }
  cache.set(index, { count: index.assets.size, walls });
  return walls;
}

export function furnishingWallCollision(item: PlacementEnvelope, walls: readonly WallTriangles[], excludeSurfaceId?: string | null): boolean {
  const origin = new THREE.Vector3(...item.position);
  const inverseYaw = new THREE.Matrix4().makeRotationY(-THREE.MathUtils.degToRad(item.rotationYDeg));
  // A tiny tolerance lets furniture touch a wall without treating contact as penetration.
  const box = new THREE.Box3(new THREE.Vector3(-item.widthM / 2 + .003, .003, -item.depthM / 2 + .003),
    new THREE.Vector3(item.widthM / 2 - .003, item.heightM - .003, item.depthM / 2 - .003));
  const worldBounds = box.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(item.rotationYDeg)).setPosition(origin));
  const triangle = new THREE.Triangle();
  for (const wall of walls) {
    if (excludeSurfaceId && wall.surfaceId === excludeSurfaceId) continue;
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

export function furnishingPlacementError(
  item: Furnishing,
  index: SceneIndex,
  obstacles: readonly (PlacementCollisionShape | null)[] = [],
): string | null {
  const values = [...item.position, item.widthM, item.depthM, item.heightM, item.rotationYDeg];
  if (!values.every(Number.isFinite) || item.widthM < .05 || item.depthM < .05 || item.heightM < .01)
    return "Enter valid furniture dimensions and coordinates.";
  if (item.position.some((value, axis) => value < index.manifest.manifest.bounds.min[axis]! || value > index.manifest.manifest.bounds.max[axis]!))
    return "Move the furniture inside the model bounds.";
  if (furnishingWallCollision(item, wallTriangles(index))) return "Overlaps a wall or door. Move or resize the furniture.";
  if (collidesWithPlacementShape(furnishingCollisionShape(item), obstacles))
    return "Overlaps furniture or equipment. Move or resize the furniture.";
  return null;
}

export function roundedPosition(position: Vec3): Vec3 {
  return position.map((value) => Math.round(value * 1000) / 1000) as Vec3;
}

/** Rebuild physical collision geometry after restoring an exploded view to normal. */
export function clearFurnishingCollisionCache(index: SceneIndex): void { cache.delete(index); }
