import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import { computeVisibility } from "@/house/model/visibilityPlan";
import { DEFAULT_LAYERS } from "@/house/model/types";
import { createSceneIndex, indexAsset, inventoryOf } from "@/house/scene/SceneIndex";
import { applyVisibility } from "@/house/scene/applyVisibility";
import { invalidWallCap, withoutCapEdges } from "@/house/scene/invalidWallCaps";
import { FIXTURE_DIR, loadManifest } from "./glb";

function fixture(low = -.2, high = 2.4) {
  const manifest = loadManifest(FIXTURE_DIR);
  const surface = manifest.surfaces.find((s) => s.id === "s-e-l-ext--r-l-a")!;
  surface.kind = "other"; surface.role = "wall-top";
  const index = createSceneIndex(buildManifestIndex(manifest));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, low, 0, 4, high, 0, 4, high, .2, 0, low, .2,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const cap = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  cap.name = surface.id;
  const edgeGeometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([
    0, low, 0, 4, high, 0, // invalid cap edge
    0, 0, 2, 4, 0, 2, // unrelated floor edge
  ], 3));
  const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial());
  edges.name = "edges-fixture-lower";
  const root = new THREE.Group(); root.add(cap, edges); root.updateMatrixWorld(true);
  return { index, root, cap, edges, edgeGeometry };
}

describe("invalid wall caps", () => {
  it("suppresses below-floor diagonal caps and their edges through every wall visibility mode", () => {
    const { index, root, cap, edges, edgeGeometry } = fixture();
    indexAsset(index, "fixture-lower", root);
    expect(cap.visible).toBe(false);
    expect(edges.geometry.index?.count).toBe(2);
    expect(edgeGeometry.index).toBeNull(); // input edge buffers remain untouched
    for (const wallMode of ["cut", "contextual", "up", "closed"] as const) {
      applyVisibility(computeVisibility(index.manifest, {
        viewMode: "overview", activeFloorId: null, wallMode, roofVisible: true,
        ceilingsVisible: true, edgesVisible: true, layers: { ...DEFAULT_LAYERS },
        loadedAssetIds: ["fixture-lower"], inventory: inventoryOf(index),
      }), index);
      expect(cap.visible, wallMode).toBe(false);
      expect(index.pickables).not.toContain(cap);
    }
  });

  it("retains horizontal and sloping gable caps above the floor", () => {
    for (const [low, high] of [[2.4, 2.4], [2.4, 4]]) {
      const { index, cap } = fixture(low, high);
      expect(invalidWallCap(cap, cap.name, index.manifest)).toBe(false);
    }
  });

  it("does not suppress ordinary walls or caps without a known floor", () => {
    const { index, cap } = fixture();
    index.manifest.surfaces.get(cap.name)!.role = "exterior";
    expect(invalidWallCap(cap, cap.name, index.manifest)).toBe(false);
    index.manifest.surfaces.get(cap.name)!.role = "wall-top";
    index.manifest.floorOfSurface.delete(cap.name);
    expect(invalidWallCap(cap, cap.name, index.manifest)).toBe(false);
  });

  it("does not copy unaffected edge geometry", () => {
    const { edges } = fixture();
    expect(withoutCapEdges(edges, [])).toBeNull();
  });
});
