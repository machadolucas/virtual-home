import { expect, it } from "vitest";
import * as THREE from "three";
import { LightEmitters } from "@/house/scene/lightEmitters";
import type { EquipmentLightSpec } from "@/house/scene/equipmentLights";

it("shows hundreds of live emitters in one draw and settles after state changes", () => {
  const root = new THREE.Group();
  const emitters = new LightEmitters(root);
  expect(root.children[0]?.visible).toBe(false);
  const specs: EquipmentLightSpec[] = Array.from({ length: 200 }, (_, i) => ({
    id: `light-${i}`, spot: false, position: [i, 2, 0], direction: [0, -1, 0],
    color: [1, 0.7, 0.4], brightness: 1,
  }));
  emitters.set(specs);
  expect(emitters.tick(0.16)).toBe(true);
  expect(root.children).toHaveLength(1);
  const mesh = root.children[0] as THREE.InstancedMesh;
  expect(mesh.count).toBe(200);
  expect(mesh.visible).toBe(true);
  const color = new THREE.Color();
  mesh.getColorAt(199, color);
  expect(color.r).toBe(3);
  expect(emitters.tick(0.16)).toBe(false);
  emitters.set([]);
  emitters.tick(0.16);
  expect(mesh.count).toBe(0);
  expect(mesh.visible).toBe(false);
  expect(emitters.tick(0.16)).toBe(false);
  emitters.dispose();
  expect(root.children).toHaveLength(0);
});
