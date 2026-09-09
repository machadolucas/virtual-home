import * as THREE from "three";
import type { ExplodeGroup, SurfaceId } from "@/house/model/types";
import type { ClipGroups } from "./clipGroups";
import type { SceneIndex } from "./SceneIndex";

/** Keep a label on its own mounting face from treating that face as an occluder. */
export const OCCLUSION_ENDPOINT_TOLERANCE_M = 0.015;

interface Blocker {
  source: THREE.Mesh;
  raycastMesh: THREE.Mesh;
  worldBounds: THREE.Box3;
  surfaceId: SurfaceId;
  group: ExplodeGroup;
}

function hierarchyVisible(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

function hasVisibleMaterial(mesh: THREE.Mesh): boolean {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some((material) => material.visible && material.opacity > 0);
}

function isDescendantOf(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (node === ancestor) return true;
  }
  return false;
}

/** Ray/AABB slab test constrained to the camera-to-label segment. Allocation-free hot path. */
function intersectsSegmentBounds(ray: THREE.Ray, box: THREE.Box3, far: number): boolean {
  let enter = 0;
  let exit = far;
  for (let axis = 0; axis < 3; axis += 1) {
    const origin = ray.origin.getComponent(axis);
    const direction = ray.direction.getComponent(axis);
    const min = box.min.getComponent(axis);
    const max = box.max.getComponent(axis);
    if (Math.abs(direction) < 1e-12) {
      if (origin < min || origin > max) return false;
      continue;
    }
    let near = (min - origin) / direction;
    let distant = (max - origin) / direction;
    if (near > distant) {
      const swap = near;
      near = distant;
      distant = swap;
    }
    enter = Math.max(enter, near);
    exit = Math.min(exit, distant);
    if (enter > exit) return false;
  }
  return exit >= 0;
}

/**
 * Demand-driven visibility test for DOM equipment markers.
 *
 * `beginFrame` snapshots the camera and current physical surface meshes once. Calls to
 * `isOccluded` then raycast only that snapshot; overlay equipment, routes and editing guides never
 * enter it. A private double-sided raycast material makes walls block labels from either face
 * without touching their rendered materials.
 */
export class EquipmentOcclusion {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly projected = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private readonly raycastMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  private readonly proxies = new WeakMap<THREE.Mesh, THREE.Mesh>();
  private readonly intersections: THREE.Intersection[] = [];
  private blockers: Blocker[] = [];
  private camera: THREE.Camera | null = null;
  private clip: ClipGroups | null = null;

  beginFrame(index: SceneIndex, clip: ClipGroups | null, camera: THREE.Camera): void {
    camera.updateMatrixWorld(true);
    this.camera = camera;
    this.clip = clip;
    this.blockers = [];

    for (const [surfaceId, source] of index.surfaceMesh) {
      // Explode and other presentation transforms live above the mesh. Pull those matrices into
      // this snapshot without asking the whole scene to update for every projected label.
      source.updateWorldMatrix(true, false);
      if (!hierarchyVisible(source) || !hasVisibleMaterial(source)) continue;
      if (isDescendantOf(source, index.overlay.root)) continue;
      const group = index.clipGroupOf.get(surfaceId);
      if (!group) continue;

      if (!source.geometry.boundingBox) source.geometry.computeBoundingBox();
      const localBounds = source.geometry.boundingBox;
      if (!localBounds || localBounds.isEmpty()) continue;

      let raycastMesh = this.proxies.get(source);
      if (!raycastMesh) {
        raycastMesh = new THREE.Mesh(source.geometry, this.raycastMaterial);
        raycastMesh.matrixAutoUpdate = false;
        this.proxies.set(source, raycastMesh);
      }
      raycastMesh.geometry = source.geometry;
      raycastMesh.matrixWorld.copy(source.matrixWorld);
      this.blockers.push({
        source,
        raycastMesh,
        worldBounds: new THREE.Box3().copy(localBounds).applyMatrix4(source.matrixWorld),
        surfaceId,
        group,
      });
    }
  }

  isOccluded(world: THREE.Vector3): boolean {
    const camera = this.camera;
    if (!camera || this.blockers.length === 0) return false;

    this.projected.copy(world).project(camera);
    if (!Number.isFinite(this.projected.x) || !Number.isFinite(this.projected.y)) return false;
    this.ndc.set(this.projected.x, this.projected.y);
    this.raycaster.setFromCamera(this.ndc, camera);

    const targetDistance = this.delta.subVectors(world, this.raycaster.ray.origin)
      .dot(this.raycaster.ray.direction);
    if (targetDistance <= OCCLUSION_ENDPOINT_TOLERANCE_M) return false;
    this.raycaster.near = 0;
    this.raycaster.far = targetDistance - OCCLUSION_ENDPOINT_TOLERANCE_M;

    for (const blocker of this.blockers) {
      if (!intersectsSegmentBounds(this.raycaster.ray, blocker.worldBounds, this.raycaster.far)) {
        continue;
      }
      if (!hierarchyVisible(blocker.source) || !hasVisibleMaterial(blocker.source)) continue;

      this.intersections.length = 0;
      blocker.raycastMesh.raycast(this.raycaster, this.intersections);
      for (const hit of this.intersections) {
        if (this.clip?.keepsSurface(blocker.group, blocker.surfaceId, hit.point) === false) {
          continue;
        }
        return true;
      }
    }
    return false;
  }
}
