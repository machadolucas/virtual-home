import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ClipGroups } from "@/house/scene/clipGroups";
import { EquipmentOcclusion } from "@/house/scene/equipmentOcclusion";
import { createSceneIndex } from "@/house/scene/SceneIndex";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import type { SurfaceId } from "@/house/model/types";

function fixture() {
  const index = createSceneIndex({} as ManifestIndex);
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(4, 4, 0.2),
    new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  );
  root.add(mesh);
  root.updateMatrixWorld(true);
  const surfaceId = "wall" as SurfaceId;
  index.surfaceMesh.set(surfaceId, mesh);
  index.meshSurfaceId.set(mesh, surfaceId);
  index.clipGroupOf.set(surfaceId, "f-lower");
  return { index, root, mesh, surfaceId };
}

function perspective(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function orthographic(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

describe("equipment label occlusion", () => {
  it.each([
    ["perspective", perspective],
    ["orthographic", orthographic],
  ])("finds physical blockers with a %s camera", (_name, makeCamera) => {
    const { index } = fixture();
    const occlusion = new EquipmentOcclusion();
    occlusion.beginFrame(index, null, makeCamera());
    expect(occlusion.isOccluded(new THREE.Vector3(0, 0, -1))).toBe(true);
    expect(occlusion.isOccluded(new THREE.Vector3(0, 0, 1))).toBe(false);
  });

  it("raycasts both sides without changing the surface material", () => {
    const { index, mesh } = fixture();
    const material = mesh.material as THREE.MeshBasicMaterial;
    const camera = perspective();
    camera.position.z = -5;
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const occlusion = new EquipmentOcclusion();
    occlusion.beginFrame(index, null, camera);
    expect(occlusion.isOccluded(new THREE.Vector3(0, 0, 1))).toBe(true);
    expect(material.side).toBe(THREE.FrontSide);
    expect(mesh.material).toBe(material);
  });

  it("ignores hidden meshes and hidden ancestors, including changes after beginFrame", () => {
    const { index, root, mesh } = fixture();
    const occlusion = new EquipmentOcclusion();
    const target = new THREE.Vector3(0, 0, -1);
    root.visible = false;
    occlusion.beginFrame(index, null, perspective());
    expect(occlusion.isOccluded(target)).toBe(false);

    root.visible = true;
    occlusion.beginFrame(index, null, perspective());
    mesh.visible = false;
    expect(occlusion.isOccluded(target)).toBe(false);
  });

  it("ignores fully transparent surfaces", () => {
    const { index, mesh } = fixture();
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.transparent = true;
    material.opacity = 0;
    const occlusion = new EquipmentOcclusion();
    occlusion.beginFrame(index, null, perspective());
    expect(occlusion.isOccluded(new THREE.Vector3(0, 0, -1))).toBe(false);
  });

  it("snapshots current ancestor transforms before raycasting", () => {
    const { index, root } = fixture();
    root.position.x = 5;
    const occlusion = new EquipmentOcclusion();
    occlusion.beginFrame(index, null, perspective());
    expect(occlusion.isOccluded(new THREE.Vector3(0, 0, -1))).toBe(false);
    expect(occlusion.isOccluded(new THREE.Vector3(5, 0, -1))).toBe(true);
  });

  it("ignores intersections removed by group and surface clipping", () => {
    const { index } = fixture();
    const clip = new ClipGroups(["f-lower"]);
    clip.setCut(
      "f-lower",
      { enabled: true, y: 3, vertical: { axis: "x", v: 0, sign: 1 } },
      0,
    );
    const occlusion = new EquipmentOcclusion();
    occlusion.beginFrame(index, clip, perspective());
    expect(occlusion.isOccluded(new THREE.Vector3(1, 0, -1))).toBe(false);
    expect(occlusion.isOccluded(new THREE.Vector3(-1, 0, -1))).toBe(true);
  });

  it("does not include overlay equipment, routes or editing guides as blockers", () => {
    const { index, mesh } = fixture();
    index.overlay.root.add(mesh);
    index.overlay.root.updateMatrixWorld(true);
    const occlusion = new EquipmentOcclusion();
    occlusion.beginFrame(index, null, perspective());
    expect(occlusion.isOccluded(new THREE.Vector3(0, 0, -1))).toBe(false);
  });

  it("does not hide a marker resting on its own mounting surface", () => {
    const { index } = fixture();
    const occlusion = new EquipmentOcclusion();
    occlusion.beginFrame(index, null, perspective());
    expect(occlusion.isOccluded(new THREE.Vector3(0, 0, 0.1))).toBe(false);
    expect(occlusion.isOccluded(new THREE.Vector3(0, 0, 0.08))).toBe(true);
  });

  it("broadphases a dense scene before doing exact mesh raycasts", () => {
    const index = createSceneIndex({} as ManifestIndex);
    const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.1);
    const material = new THREE.MeshBasicMaterial();
    for (let i = 0; i < 400; i += 1) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(10 + (i % 20), 10 + Math.floor(i / 20), 0);
      mesh.updateMatrixWorld(true);
      const id = `far-${i}` as SurfaceId;
      index.surfaceMesh.set(id, mesh);
      index.clipGroupOf.set(id, "f-lower");
    }
    const blocker = new THREE.Mesh(geometry, material);
    blocker.updateMatrixWorld(true);
    index.surfaceMesh.set("near" as SurfaceId, blocker);
    index.clipGroupOf.set("near" as SurfaceId, "f-lower");

    const occlusion = new EquipmentOcclusion();
    occlusion.beginFrame(index, null, perspective());
    const exactRaycast = vi.spyOn(THREE.Mesh.prototype, "raycast");
    try {
      expect(occlusion.isOccluded(new THREE.Vector3(0, 0, -1))).toBe(true);
      // 401 physical meshes are present; only the one AABB crossing this label ray reaches the
      // triangle-level Mesh.raycast path.
      expect(exactRaycast).toHaveBeenCalledTimes(1);
    } finally {
      exactRaycast.mockRestore();
      geometry.dispose();
      material.dispose();
    }
  });
});
