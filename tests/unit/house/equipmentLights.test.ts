import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { EquipmentLightLayer, LIGHT_SLOTS_PER_KIND, type EquipmentLightSpec } from "@/house/scene/equipmentLights";

const spec: EquipmentLightSpec = { id: "lamp", spot: true, position: [1, 2.4, 1], direction: [0, -1, 0], color: [1, 0.4, 0.1], brightness: 0.5 };

describe("live equipment lights", () => {
  it("updates brightness, colour and beam target without replacing shader light slots", () => {
    const scene = new THREE.Scene();
    const layer = new EquipmentLightLayer(scene);
    expect(layer.set([spec])).toBe(true);
    const light = layer.root.getObjectByName("vh-live-spot-0") as THREE.SpotLight;
    expect(light.intensity).toBe(45);
    expect(light.target.position.toArray()).toEqual([1, 1.4, 1]);
    expect(light.color.r).toBeGreaterThan(light.color.g);
    expect(layer.set([spec])).toBe(false);
    expect(layer.set([{ ...spec, brightness: 0.25 }])).toBe(true);
    expect(light.intensity).toBe(22.5);
    layer.set([]);
    expect(light.intensity).toBe(0);
    expect(layer.root.getObjectByName("vh-live-spot-0")).toBe(light);
    layer.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("bounds cost and keeps the caller's priority order", () => {
    const layer = new EquipmentLightLayer(new THREE.Scene());
    const many = Array.from({ length: 30 }, (_, i) => ({ ...spec, id: `lamp-${i}` }));
    layer.set(many);
    expect(layer.snapshot().map((s) => s.id)).toEqual(many.slice(0, LIGHT_SLOTS_PER_KIND).map((s) => s.id));
    layer.set(many, 2);
    expect(layer.snapshot()).toHaveLength(2);
    layer.dispose();
  });
});
