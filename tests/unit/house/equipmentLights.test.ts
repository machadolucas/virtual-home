import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  EquipmentLightLayer,
  LIGHT_BUDGET,
  LIGHT_FADE_SECONDS,
  LIGHT_SLOTS_PER_KIND,
  PERFORMANCE_LIGHT_BUDGET,
  prepareEquipmentLightSurfaces,
  type EquipmentLightSpec,
} from "@/house/scene/equipmentLights";
import type { SceneIndex } from "@/house/scene/SceneIndex";

const spec: EquipmentLightSpec = { id: "lamp", spot: true, position: [1, 2.4, 1], direction: [0, -1, 0], color: [1, 0.4, 0.1], brightness: 0.5 };

describe("live equipment lights", () => {
  it("rapidly fades brightness and colour, then lets demand rendering settle", () => {
    const scene = new THREE.Scene();
    const layer = new EquipmentLightLayer(scene);
    expect(layer.set([spec])).toBe(true);
    const light = layer.root.getObjectByName("vh-live-spot-0") as THREE.SpotLight;
    expect(light.intensity).toBe(0);
    expect(layer.fading).toBe(true);
    expect(light.target.position.toArray()).toEqual([1, 1.4, 1]);
    expect(layer.tick(LIGHT_FADE_SECONDS / 2)).toBe(true);
    expect(light.intensity).toBeCloseTo(13.75);
    expect(layer.tick(LIGHT_FADE_SECONDS / 2)).toBe(true);
    expect(light.intensity).toBe(27.5);
    expect(light.color.r).toBeGreaterThan(light.color.g);
    expect(layer.fading).toBe(false);
    expect(layer.tick(1)).toBe(false);

    const blue: EquipmentLightSpec = { ...spec, color: [0.1, 0.4, 1] };
    expect(layer.set([blue])).toBe(true);
    layer.tick(LIGHT_FADE_SECONDS / 2);
    expect(light.color.r).toBeGreaterThan(0.1);
    expect(light.color.b).toBeLessThan(1);
    layer.tick(LIGHT_FADE_SECONDS / 2);
    const targetBlue = new THREE.Color().setRGB(...blue.color, THREE.SRGBColorSpace);
    expect(light.color.getHex()).toBe(targetBlue.getHex());

    expect(layer.set([blue])).toBe(false);
    expect(layer.set([{ ...blue, brightness: 0.25 }])).toBe(true);
    layer.tick(LIGHT_FADE_SECONDS);
    expect(light.intensity).toBe(13.75);
    layer.set([]);
    expect(light.intensity).toBe(13.75);
    layer.tick(LIGHT_FADE_SECONDS);
    expect(light.intensity).toBe(0);
    expect(layer.root.getObjectByName("vh-live-spot-0")).toBe(light);
    layer.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("bounds shadow cost, shadows every emitter, and keeps priority within each kind", () => {
    const layer = new EquipmentLightLayer(new THREE.Scene());
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...spec,
      id: `lamp-${i}`,
      spot: i % 2 === 0,
    }));
    layer.set(many);
    expect(layer.snapshot().filter((entry) => entry.spot).map((entry) => entry.id)).toEqual([
      "lamp-0", "lamp-2", "lamp-4", "lamp-6",
    ]);
    expect(layer.snapshot().filter((entry) => !entry.spot).map((entry) => entry.id)).toEqual([
      "lamp-1", "lamp-3", "lamp-5", "lamp-7",
    ]);
    const emitters = layer.root.children.filter(
      (child): child is THREE.PointLight | THREE.SpotLight =>
        (child instanceof THREE.PointLight || child instanceof THREE.SpotLight) && child.castShadow,
    );
    expect(emitters).toHaveLength(LIGHT_BUDGET.point + LIGHT_BUDGET.spot);
    expect(emitters.every((light) => light.shadow.mapSize.width <= 256)).toBe(true);

    layer.set(many, PERFORMANCE_LIGHT_BUDGET);
    expect(layer.snapshot()).toHaveLength(2);
    layer.dispose();
  });

  it("makes surfaces matte shadow receivers while leaving cutaway out of shadow clipping", () => {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.4 });
    material.clipShadows = true;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    const scan = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const index = {
      assets: new Map([
        ["shell", { id: "shell", meshes: [mesh] }],
        ["scan", { id: "scan", meshes: [scan] }],
      ]),
      manifest: {
        assets: new Map([
          ["shell", { kind: "shell" }],
          ["scan", { kind: "scan-reference" }],
        ]),
      },
    } as unknown as SceneIndex;

    expect(prepareEquipmentLightSurfaces(index)).toBe(true);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(material.roughness).toBe(0.94);
    expect(material.clipShadows).toBe(false);
    expect(scan.castShadow).toBe(false);
    expect(scan.receiveShadow).toBe(false);
    expect(prepareEquipmentLightSurfaces(index)).toBe(false);
  });

  it("keeps the fixed physical slot pool even with lower active shadow budgets", () => {
    const layer = new EquipmentLightLayer(new THREE.Scene());
    expect(layer.root.children.filter((child) => child instanceof THREE.PointLight)).toHaveLength(
      LIGHT_SLOTS_PER_KIND,
    );
    expect(layer.root.children.filter((child) => child instanceof THREE.SpotLight)).toHaveLength(
      LIGHT_SLOTS_PER_KIND,
    );
    layer.dispose();
  });

  it("keeps a surviving fixture in its slot while its neighbour fades out", () => {
    const layer = new EquipmentLightLayer(new THREE.Scene());
    const a = { ...spec, id: "a" };
    const b = { ...spec, id: "b", brightness: 0.25 };
    layer.set([a, b]);
    layer.tick(LIGHT_FADE_SECONDS);
    const before = layer.renderedSnapshot().find((light) => light.id === "b")?.intensity;

    layer.set([b]);
    expect(layer.renderedSnapshot().find((light) => light.id === "a")?.fading).toBe(true);
    expect(layer.renderedSnapshot().find((light) => light.id === "b")?.intensity).toBe(before);
    layer.tick(LIGHT_FADE_SECONDS / 2);
    expect(layer.renderedSnapshot().find((light) => light.id === "b")?.intensity).toBe(before);
    layer.tick(LIGHT_FADE_SECONDS / 2);
    expect(layer.renderedSnapshot().some((light) => light.id === "a")).toBe(false);
    layer.dispose();
  });
});
