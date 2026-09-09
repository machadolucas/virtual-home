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
  type EquipmentLightProjectionSpec,
} from "@/house/scene/equipmentLights";
import type { SceneIndex } from "@/house/scene/SceneIndex";

const spec: EquipmentLightSpec = { id: "lamp", spot: true, position: [1, 2.4, 1], direction: [0, -1, 0], color: [1, 0.4, 0.1], brightness: 0.5 };

const projection = (
  id: string,
  over: Partial<EquipmentLightProjectionSpec> = {},
): EquipmentLightProjectionSpec => ({
  id,
  sourceId: id,
  surfaceId: null,
  geometry: new THREE.PlaneGeometry(4, 4),
  matrixWorld: new THREE.Matrix4(),
  hitPoint: [0, 0, 0],
  radius: 1,
  color: [1, 0.4, 0.1],
  brightness: 0.5,
  clippingPlanes: [],
  clipIntersection: false,
  ...over,
});

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

  it("bounds shadow cost while retaining every active source in diagnostics", () => {
    const layer = new EquipmentLightLayer(new THREE.Scene());
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...spec,
      id: `lamp-${i}`,
      spot: i % 2 === 0,
    }));
    layer.set(many);
    expect(layer.snapshot().map((entry) => entry.id)).toEqual(many.map((entry) => entry.id));
    const emitters = layer.root.children.filter(
      (child): child is THREE.PointLight | THREE.SpotLight =>
        (child instanceof THREE.PointLight || child instanceof THREE.SpotLight) && child.castShadow,
    );
    expect(emitters).toHaveLength(LIGHT_BUDGET.point + LIGHT_BUDGET.spot);
    expect(emitters.every((light) => light.shadow.mapSize.width <= 256)).toBe(true);

    layer.set(many, PERFORMANCE_LIGHT_BUDGET);
    expect(layer.snapshot()).toHaveLength(30);
    layer.dispose();
  });

  it("renders one clipped, non-shadow projection for each overflow source and fades it", () => {
    const layer = new EquipmentLightLayer(new THREE.Scene());
    const specs = Array.from({ length: 8 }, (_, index) => ({
      ...spec,
      id: `lamp-${index}`,
      spot: false,
    }));
    const overflow = specs.slice(6).map((entry) => projection(entry.id));

    layer.set(specs, LIGHT_BUDGET, overflow);
    expect(layer.projectedSnapshot().map((entry) => entry.id)).toEqual(["lamp-6", "lamp-7"]);
    expect(layer.renderedSnapshot().filter((entry) => entry.kind === "projection")).toEqual([
      expect.objectContaining({ id: "lamp-6", castShadow: false, intensity: 0, fading: true }),
      expect.objectContaining({ id: "lamp-7", castShadow: false, intensity: 0, fading: true }),
    ]);

    layer.tick(LIGHT_FADE_SECONDS);
    expect(layer.renderedSnapshot().map((entry) => entry.id).sort()).toEqual(
      specs.map((entry) => entry.id).sort(),
    );
    expect(layer.renderedSnapshot().filter((entry) => entry.kind === "projection").every(
      (entry) => entry.intensity > 0 && !entry.castShadow,
    )).toBe(true);

    layer.set(specs, LIGHT_BUDGET, [overflow[1]!]);
    layer.tick(LIGHT_FADE_SECONDS);
    expect(layer.projectedSnapshot().map((entry) => entry.id)).toEqual(["lamp-7"]);
    layer.dispose();
  });

  it("recompiles a projection when its clipping mode changes", () => {
    const layer = new EquipmentLightLayer(new THREE.Scene());
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -1);
    layer.set([spec], { point: 0, spot: 0 }, [projection(spec.id)]);
    const mesh = layer.root.getObjectByName(`vh-light-projection-${spec.id}`) as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.ShaderMaterial
    >;
    const initialVersion = mesh.material.version;

    expect(layer.set([spec], { point: 0, spot: 0 }, [projection(spec.id, {
      clippingPlanes: [plane],
      clipIntersection: true,
    })])).toBe(true);
    expect(mesh.material.version).toBeGreaterThan(initialVersion);
    expect(layer.projectedSnapshot()).toEqual([
      expect.objectContaining({ clippingPlaneCount: 1, clipIntersection: true }),
    ]);

    plane.constant = -2;
    expect(layer.set([spec], { point: 0, spot: 0 }, [projection(spec.id, {
      clippingPlanes: [plane],
      clipIntersection: true,
    })])).toBe(true);
    layer.dispose();
  });

  it("reuses shadow depth for brightness/colour and invalidates moved lights independently", () => {
    const layer = new EquipmentLightLayer(new THREE.Scene());
    const a = { ...spec, id: "a" }, b = { ...spec, id: "b", position: [2, 2, 2] as [number, number, number] };
    layer.set([a, b]);
    const lights = layer.root.children.filter((child): child is THREE.SpotLight => child instanceof THREE.SpotLight);
    for (const light of lights) {
      expect(light.shadow.autoUpdate).toBe(false);
      light.shadow.map = new THREE.WebGLRenderTarget(1, 1);
      light.shadow.needsUpdate = false; // Simulate the completed first shadow pass.
    }
    layer.set([{ ...a, brightness: 0.9, color: [0.1, 1, 0.2] }, b]);
    expect(lights.every((l) => !l.shadow.needsUpdate)).toBe(true);
    layer.set([{ ...a, position: [1.5, 2.4, 1] }, b]);
    expect(lights[0]!.shadow.needsUpdate).toBe(true);
    expect(lights[1]!.shadow.needsUpdate).toBe(false);
    layer.invalidateShadows();
    expect(lights.every((l) => l.shadow.needsUpdate)).toBe(true);
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
