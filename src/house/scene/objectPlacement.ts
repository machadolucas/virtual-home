import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import type { Furnishing } from "../model/types";
import type { PickResult } from "./picker";
import { isVisibleUp } from "./applyVisibility";

/** Pick actual, visible object faces; previews and the object being moved never support themselves. */
export function pickObjectSupport(runtime: HouseRuntime, clientX: number, clientY: number,
  furnishings: readonly Furnishing[], excludeId: string | null): PickResult | null {
  if (!runtime.scene || !runtime.camera3d || !runtime.canvasEl) return null;
  const rect = runtime.canvasEl.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1,
    -(clientY - rect.top) / rect.height * 2 + 1), runtime.camera3d);
  const candidates: THREE.Object3D[] = [...(runtime.markers?.meshes ?? [])];
  const furniture = runtime.scene.getObjectByName("furnishings");
  furniture?.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && object.parent?.name !== "vh-furniture-preview") candidates.push(object);
  });
  for (const hit of ray.intersectObjects(candidates.filter(isVisibleUp), false)) {
    const mesh = hit.object as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.every((m) => m.clippingPlanes?.some((p) => p.distanceToPoint(hit.point) < 0))) continue;
    const id = hit.instanceId !== undefined ? runtime.markers?.placementAt(mesh, hit.instanceId) : mesh.parent?.userData.furnishingId as string | undefined;
    if (!id || id === excludeId) continue;
    const item = hit.instanceId !== undefined ? runtime.store.getState().placements.find((x) => x.id === id) : furnishings.find((x) => x.id === id);
    if (!item || runtime.index?.hiddenGroups.has(item.floorId)) continue;
    const matrix = mesh.matrixWorld.clone();
    if (hit.instanceId !== undefined) {
      const instance = new THREE.Matrix4();
      (mesh as THREE.InstancedMesh).getMatrixAt(hit.instanceId, instance); matrix.multiply(instance);
    }
    const normal = hit.face?.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(matrix)).normalize();
    if (!normal) continue;
    return { surfaceId: null, elementId: null, roomId: item.roomId, floorId: item.floorId,
      buildingId: null, object: mesh, point: hit.point.clone(), normal, distance: hit.distance };
  }
  return null;
}

/** Clockwise body yaw follows the drag around its fixed anchor, in 45-degree steps. */
export function placementYaw(anchor: readonly number[], target: readonly number[], fallback: number): number {
  const dx = target[0]! - anchor[0]!, dz = target[2]! - anchor[2]!;
  if (Math.hypot(dx, dz) < .05) return fallback;
  return Math.round(THREE.MathUtils.radToDeg(Math.atan2(dx, dz)) / 45) * 45;
}

/** Visible fixture bodies are targets in Move and Select, with the same fragment clipping as drawing. */
export function pickEquipmentBody(runtime: HouseRuntime, clientX: number, clientY: number): { id: string; distance: number } | null {
  if (!runtime.camera3d || !runtime.canvasEl || !runtime.store.getState().layers.equipment) return null;
  const rect = runtime.canvasEl.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1,
    -(clientY - rect.top) / rect.height * 2 + 1), runtime.camera3d);
  for (const hit of ray.intersectObjects((runtime.markers?.meshes ?? []).filter(isVisibleUp), false)) {
    if (hit.instanceId === undefined) continue;
    const mesh = hit.object as THREE.Mesh;
    const material = Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material;
    if (material?.clippingPlanes?.some((plane) => plane.distanceToPoint(hit.point) < 0)) continue;
    const id = runtime.markers!.placementAt(mesh, hit.instanceId);
    if (id) return { id, distance: hit.distance };
  }
  return null;
}
