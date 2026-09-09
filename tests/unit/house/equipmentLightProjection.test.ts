import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ClipGroups } from "@/house/scene/clipGroups";
import { createEquipmentLightProjectionCache, projectOverflowLight } from "@/house/scene/equipmentLightProjection";
import type { EquipmentLightSpec } from "@/house/scene/equipmentLights";
import type { SceneIndex } from "@/house/scene/SceneIndex";

const source = (over: Partial<EquipmentLightSpec> = {}): EquipmentLightSpec => ({
  id: "lamp",
  spot: false,
  position: [0, 2, 0],
  direction: [0, -1, 0],
  color: [1, 0.7, 0.3],
  brightness: 1,
  ...over,
});

function roomIndex(): SceneIndex {
  const surfaceMesh = new Map<string, THREE.Mesh>();
  const meshSurfaceId = new WeakMap<THREE.Object3D, string>();
  const clipGroupOf = new Map<string, string>();
  const add = (
    id: string,
    geometry: THREE.BufferGeometry,
    position: readonly [number, number, number],
  ) => {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    mesh.position.set(...position);
    mesh.updateMatrixWorld(true);
    surfaceMesh.set(id, mesh);
    meshSurfaceId.set(mesh, id);
    clipGroupOf.set(id, "floor");
    return mesh;
  };
  add("floor", new THREE.BoxGeometry(6, 0.1, 6), [0, -0.05, 0]);
  add("east", new THREE.BoxGeometry(0.1, 4, 6), [2, 2, 0]);
  add("west", new THREE.BoxGeometry(0.1, 4, 6), [-2, 2, 0]);
  add("south", new THREE.BoxGeometry(6, 4, 0.1), [0, 2, 2]);
  add("north", new THREE.BoxGeometry(6, 4, 0.1), [0, 2, -2]);
  return {
    surfaceMesh,
    meshSurfaceId,
    clipGroupOf,
    hiddenGroups: new Set(),
  } as unknown as SceneIndex;
}

describe("overflow equipment-light projection", () => {
  it("projects a point source onto its floor and first surrounding walls", () => {
    const index = roomIndex();
    const patches = projectOverflowLight(source(), index, new ClipGroups(["floor"]));

    expect(new Set(patches.map((patch) => patch.surfaceId))).toEqual(
      new Set(["floor", "east", "west", "south", "north"]),
    );
    expect(new Set(patches.map((patch) => patch.id)).size).toBe(patches.length);
    expect(patches.every((patch) => patch.sourceId === "lamp" && patch.radius >= 0.8)).toBe(true);
  });

  it("reuses physical intersections across visibility and brightness changes", () => {
    const index = roomIndex();
    const cache = createEquipmentLightProjectionCache();
    const clip = new ClipGroups(["floor"]);
    const raycast = vi.spyOn(THREE.Mesh.prototype, "raycast");
    try {
      expect(projectOverflowLight(source(), index, clip, cache)).toHaveLength(5);
      const coldCalls = raycast.mock.calls.length;
      expect(coldCalls).toBeGreaterThan(0);
      index.hiddenGroups.add("floor");
      expect(projectOverflowLight(source(), index, clip, cache)).toHaveLength(0);
      index.hiddenGroups.clear();
      for (let i = 0; i < 100; i++) projectOverflowLight(source({ brightness: i / 100 }), index, clip, cache);
      expect(raycast.mock.calls.length).toBe(coldCalls);
      projectOverflowLight(source({ position: [0.5, 2, 0] }), index, clip, cache);
      expect(raycast.mock.calls.length).toBeGreaterThan(coldCalls);
    } finally { raycast.mockRestore(); }
  });

  it("deduplicates cone samples that land on the same receiving face", () => {
    const index = roomIndex();
    const patches = projectOverflowLight(
      source({ spot: true, direction: [0, 0, 1] }),
      index,
      new ClipGroups(["floor"]),
    );

    expect(patches.filter((patch) => patch.surfaceId === "south")).toHaveLength(1);
    expect(patches[0]?.radius).toBeGreaterThanOrEqual(0.3);
  });

  it("lets a hidden first face block the room behind it", () => {
    const index = roomIndex();
    index.surfaceMesh.get("south")!.visible = false;
    const behind = new THREE.Mesh(
      new THREE.BoxGeometry(6, 4, 0.1),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    behind.position.set(0, 2, 2.8);
    behind.updateMatrixWorld(true);
    index.surfaceMesh.set("behind", behind);
    index.meshSurfaceId.set(behind, "behind");
    index.clipGroupOf.set("behind", "floor");

    const patches = projectOverflowLight(
      source({ spot: true, direction: [0, 0, 1] }),
      index,
      new ClipGroups(["floor"]),
    );
    expect(patches.some((patch) => patch.surfaceId === "behind")).toBe(false);
  });
});
