import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { panelOrientation } from "@/house/model/panelOrientation";
import { MarkerLayer } from "@/house/scene/markers";
import type { Placement } from "@/house/model/types";
import { FIXTURE_DIR } from "./glb";
import { buildScene } from "./sceneFromGlb";

describe("solar panel physical transforms", () => {
  it("aligns its outward face with arbitrary roof slopes, without changing physical position", () => {
    for (const normal of [[0, 1, 0], [0.4, 0.8, -0.2], [-0.2, 0.6, 0.7]] as [number, number, number][]) {
      const orientation = panelOrientation(normal)!;
      const euler = new THREE.Euler(orientation.tiltDeg * Math.PI / 180, orientation.rotationYDeg * Math.PI / 180, 0, "YXZ");
      const actual = new THREE.Vector3(0, 1, 0).applyEuler(euler);
      expect(actual.distanceTo(new THREE.Vector3(...normal).normalize())).toBeLessThan(1e-6);
    }
    expect(panelOrientation([0, 0, 0])).toBeNull();
    expect(panelOrientation([NaN, 1, 0])).toBeNull();
    expect(panelOrientation([0, -1, 0])).toEqual({ rotationYDeg: 0, tiltDeg: 0 });
  });

  it("instances sixteen panels with independent physical sizes and tilt in one draw group", () => {
    const built = buildScene(FIXTURE_DIR);
    const markers = new MarkerLayer(built.index, built.clip);
    const placements: Placement[] = Array.from({ length: 16 }, (_, i) => ({
      id: `panel-${i}`, modelId: "fixture-house", equipmentId: `equipment-${i}`, name: `Panel ${i + 1}`,
      position: [i % 4, 3, Math.floor(i / 4)], rotationYDeg: 25, mount: { kind: "free", height: 3 },
      floorId: "f-lower", roomId: null, surfaceId: null, locationNote: "", photoId: null, entityId: null,
      symbol: "solar_panel", category: "electrical", solarPanel: { widthM: 1 + i / 10, lengthM: 1.8, thicknessM: 0.04, tiltDeg: 30 },
    }));
    try {
      markers.set(placements, () => "unlinked", () => "f-lower", () => "solar_panel");
      expect(markers.meshes).toHaveLength(1);
      expect(markers.meshes[0]!.count).toBe(16);
      expect(markers.meshes[0]!.castShadow).toBe(true);
      const matrix = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), scale = new THREE.Vector3();
      markers.meshes[0]!.getMatrixAt(15, matrix);
      matrix.decompose(pos, q, scale);
      expect(pos.toArray()).toEqual([3, 3, 3]);
      expect(scale.x).toBeCloseTo(2.5);
      expect(scale.y).toBeCloseTo(0.04);
      expect(scale.z).toBeCloseTo(1.8);
      const expected = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(Math.PI / 6, 25 * Math.PI / 180, 0, "YXZ"));
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(q).distanceTo(expected)).toBeLessThan(1e-6);
      markers.set(placements.slice(0, 1), () => "live", () => "f-lower", () => "wall_spot");
      const spot = markers.meshes.find((mesh) => mesh.name.endsWith("wall_spot"))!;
      expect(spot.castShadow).toBe(false); // A solid marker must not block its own emitter.
      expect(spot.receiveShadow).toBe(true);
    } finally { markers.dispose(); }
  });
});
