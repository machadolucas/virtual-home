import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FURNISHING_KINDS, type FurnishingKind } from "@/house/model/types";
import {
  disposeFurnishingGeometries,
  furnishingGeometry,
} from "@/house/scene/furnishingGeometry";

afterEach(() => disposeFurnishingGeometries());

describe("procedural furnishing geometry", () => {
  it("builds every kind as a finite unit envelope based at the floor origin", () => {
    for (const kind of FURNISHING_KINDS) {
      const geometry = furnishingGeometry(kind);
      const position = geometry.getAttribute("position");
      const box = geometry.boundingBox!;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      expect(position.count, kind).toBeGreaterThan(0);
      expect(Array.from(position.array).every(Number.isFinite), kind).toBe(true);
      expect(size.x, `${kind} width`).toBeCloseTo(1, 6);
      expect(size.y, `${kind} height`).toBeCloseTo(1, 6);
      expect(size.z, `${kind} depth`).toBeCloseTo(1, 6);
      expect(box.min.y, `${kind} base`).toBeCloseTo(0, 6);
      expect(center.x, `${kind} center x`).toBeCloseTo(0, 6);
      expect(center.z, `${kind} center z`).toBeCloseTo(0, 6);
    }
  });

  it("caches one immutable geometry per kind and recreates it after global disposal", () => {
    const first = furnishingGeometry("sofa");
    expect(furnishingGeometry("sofa")).toBe(first);
    expect(furnishingGeometry("chair")).not.toBe(first);
    const disposed = vi.fn();
    first.addEventListener("dispose", disposed);
    disposeFurnishingGeometries();
    expect(disposed).toHaveBeenCalledOnce();
    expect(furnishingGeometry("sofa")).not.toBe(first);
  });

  it("leaves the inside corner of the L sofa open", () => {
    const mesh = meshFor("sofa_l");
    expect(hitsDown(mesh, 0.3, 0.3).length).toBeGreaterThan(0);
    expect(hitsDown(mesh, 0.3, -0.3)).toHaveLength(0);
  });

  it("makes shelves open while cabinet and counter doors close their fronts", () => {
    const ray = new THREE.Raycaster(new THREE.Vector3(0.2, 0.5, -2), new THREE.Vector3(0, 0, 1));
    expect(ray.intersectObject(meshFor("shelves"), false)).toHaveLength(0);
    expect(ray.intersectObject(meshFor("cabinet"), false).length).toBeGreaterThan(0);
    expect(ray.intersectObject(meshFor("kitchen_counter"), false).length).toBeGreaterThan(0);
  });

  it("gives the bicycle enough separate geometry for two wheels, its triangle frame and controls", () => {
    const bicycle = furnishingGeometry("bicycle");
    const sofa = furnishingGeometry("sofa");
    expect(bicycle.getAttribute("position").count).toBeGreaterThan(sofa.getAttribute("position").count * 2);
    // The handlebar spans depth while the wheels and triangular frame remain centred around Z=0.
    const positions = bicycle.getAttribute("position");
    let centered = 0;
    let depthExtremes = 0;
    for (let index = 0; index < positions.count; index += 1) {
      if (Math.abs(positions.getZ(index)) < 0.1) centered += 1;
      if (Math.abs(positions.getZ(index)) > 0.45) depthExtremes += 1;
    }
    expect(centered).toBeGreaterThan(100);
    expect(depthExtremes).toBeGreaterThan(0);
  });
});

function meshFor(kind: FurnishingKind): THREE.Mesh {
  const mesh = new THREE.Mesh(
    furnishingGeometry(kind),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  mesh.updateMatrixWorld(true);
  return mesh;
}

function hitsDown(mesh: THREE.Mesh, x: number, z: number): THREE.Intersection[] {
  return new THREE.Raycaster(
    new THREE.Vector3(x, 2, z),
    new THREE.Vector3(0, -1, 0),
  ).intersectObject(mesh, false);
}
