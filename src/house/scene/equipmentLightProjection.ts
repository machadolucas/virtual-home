import * as THREE from "three";
import type { ClipGroups } from "./clipGroups";
import type { EquipmentLightProjectionSpec, EquipmentLightSpec } from "./equipmentLights";
import type { SceneIndex } from "./SceneIndex";
import { isVisibleUp } from "./applyVisibility";

const POINT_RAYS: ReadonlyArray<readonly [string, THREE.Vector3]> = [
  ["floor", new THREE.Vector3(0, -1, 0)],
  ["east", new THREE.Vector3(1, -0.2, 0).normalize()],
  ["west", new THREE.Vector3(-1, -0.2, 0).normalize()],
  ["south", new THREE.Vector3(0, -0.2, 1).normalize()],
  ["north", new THREE.Vector3(0, -0.2, -1).normalize()],
];

interface CachedRayHit {
  rayId: string;
  hit: THREE.Intersection | null;
}

export interface EquipmentLightProjectionCache {
  hits: Map<string, CachedRayHit[]>;
}

export function createEquipmentLightProjectionCache(): EquipmentLightProjectionCache {
  return { hits: new Map() };
}

/**
 * Approximate an overflow light on the exact physical faces its rays first reach. Every ray stops
 * at its nearest face even when that face is hidden or clipped, so a cut wall never becomes a
 * portal that illuminates the room beyond it.
 */
export function projectOverflowLight(
  spec: EquipmentLightSpec,
  index: SceneIndex,
  clip: ClipGroups,
  cache?: EquipmentLightProjectionCache,
): EquipmentLightProjectionSpec[] {
  const rays = spec.spot ? spotRays(spec.direction) : POINT_RAYS;
  const cacheKey = JSON.stringify([spec.id, spec.spot, spec.position, spec.direction]);
  let rayHits = cache?.hits.get(cacheKey);
  if (!rayHits) {
    const targets = [...index.surfaceMesh.values()];
    for (const surface of targets) surface.updateWorldMatrix(true, false);
    if (targets.length === 0) return [];
    rayHits = rays.map(([rayId, rayDirection]) => ({
      rayId,
      hit: firstPhysicalHit(spec.position, rayDirection, spec.spot ? 8 : 5, targets),
    }));
    cache?.hits.set(cacheKey, rayHits);
  }

  const patches: EquipmentLightProjectionSpec[] = [];
  const usedSurfaces = new Set<string>();
  for (const { rayId, hit } of rayHits) {
    if (!hit || !(hit.object instanceof THREE.Mesh)) continue;
    const surfaceId = index.meshSurfaceId.get(hit.object) ?? null;
    const group = surfaceId ? index.clipGroupOf.get(surfaceId) ?? "site" : "site";
    if (
      index.hiddenGroups.has(group) ||
      !isVisibleUp(hit.object) ||
      !clip.keepsSurface(group, surfaceId, hit.point)
    ) continue;

    // One radial patch already shades the whole receiving face around the hit. Keep additional
    // cone/cardinal samples only when they reach another physical face.
    const surfaceKey = surfaceId ?? hit.object.uuid;
    if (usedSurfaces.has(surfaceKey)) continue;
    usedSurfaces.add(surfaceKey);

    const sourceMaterial = Array.isArray(hit.object.material)
      ? hit.object.material[0]
      : hit.object.material;
    patches.push({
      id: `${spec.id}:${rayId}:${surfaceKey}`,
      sourceId: spec.id,
      surfaceId,
      geometry: hit.object.geometry,
      matrixWorld: hit.object.matrixWorld.clone(),
      hitPoint: hit.point.toArray(),
      radius: spec.spot
        ? THREE.MathUtils.clamp(hit.distance * Math.tan(Math.PI / 7), 0.3, 2.2)
        : THREE.MathUtils.clamp(0.8 + hit.distance * 0.3, 0.8, 2.4),
      color: spec.color,
      brightness: spec.brightness,
      clippingPlanes: sourceMaterial?.clippingPlanes ?? [],
      clipIntersection: sourceMaterial?.clipIntersection ?? false,
    });
  }
  return patches;
}

function firstPhysicalHit(
  origin: EquipmentLightSpec["position"],
  direction: THREE.Vector3,
  far: number,
  targets: THREE.Mesh[],
): THREE.Intersection | null {
  if (direction.lengthSq() < 0.0001) return null;
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(...origin),
    direction.clone().normalize(),
    0.03,
    far,
  );
  return raycaster.intersectObjects(targets, false)[0] ?? null;
}

function spotRays(direction: EquipmentLightSpec["direction"]): Array<readonly [string, THREE.Vector3]> {
  const forward = new THREE.Vector3(...direction);
  if (forward.lengthSq() < 0.0001) return [];
  forward.normalize();
  const reference = Math.abs(forward.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3().crossVectors(forward, reference).normalize();
  const bitangent = new THREE.Vector3().crossVectors(forward, tangent).normalize();
  const rays: Array<readonly [string, THREE.Vector3]> = [["center", forward]];
  const edgeAngle = Math.PI / 10;
  for (let index = 0; index < 6; index++) {
    const angle = (index / 6) * Math.PI * 2;
    const edge = forward.clone().multiplyScalar(Math.cos(edgeAngle))
      .addScaledVector(tangent, Math.sin(edgeAngle) * Math.cos(angle))
      .addScaledVector(bitangent, Math.sin(edgeAngle) * Math.sin(angle))
      .normalize();
    rays.push([`edge-${index}`, edge]);
  }
  return rays;
}
