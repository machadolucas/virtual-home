import { describe, expect, it } from "vitest";
import { Group, Mesh, Vector3 } from "three";
import { crossCheck } from "@/house/model/crossref";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import type { Placement } from "@/house/model/types";
import { assetLayer, type VisibilityPlan } from "@/house/model/visibilityPlan";
import { createSceneIndex, indexAsset } from "@/house/scene/SceneIndex";
import { applyPlacementBodies, hasPlacementBody } from "@/house/scene/placementBodies";
import { FIXTURE_DIR, loadManifest } from "./glb";

const placement: Placement = {
  id: "test-placement", equipmentId: "fixture-unit", modelId: "fixture-house", name: "Unit",
  position: [4, 3, 2], rotationYDeg: 90, mount: { kind: "floor", height: 0 }, floorId: "f-upper",
  roomId: null, surfaceId: null, entityId: null, locationNote: "", photoId: null, symbol: null, category: null,
};

function setup() {
  const manifest = loadManifest(FIXTURE_DIR);
  const asset = manifest.assets.find(a => a.floorId === placement.floorId)!;
  asset.placementBody = { placementId: placement.id, anchor: [6, 3, 7], rotationYDeg: 0 };
  const index = createSceneIndex(buildManifestIndex(manifest));
  const root = new Group();
  const mesh = new Mesh();
  mesh.name = index.manifest.surfacesByAsset.get(asset.id)![0]!;
  root.add(mesh);
  const plan: VisibilityPlan = { assets: new Map([[asset.id, true]]), nodes: new Map() };
  return { index, asset, manifest, root, mesh, plan };
}

describe("package equipment bodies", () => {
  it("uses the loaded mesh for picking and moves it around the package mounting point", () => {
    const { index, asset, root, mesh, plan } = setup();
    expect(hasPlacementBody(index, placement.id, placement.floorId)).toBe(false);
    indexAsset(index, asset.id, root);
    expect(assetLayer(index.manifest, asset)).toBe("equipment");
    expect(mesh.userData.vhPlacementId).toBe(placement.id);
    expect(hasPlacementBody(index, placement.id, "f-upper")).toBe(true);
    expect(hasPlacementBody(index, placement.id, "f-lower")).toBe(false);
    applyPlacementBodies(index, plan, [placement], null);
    const result = mesh.localToWorld(new Vector3(7, 3, 7));
    expect(result.distanceTo(new Vector3(4, 3, 1))).toBeLessThan(0.000001);
    plan.assets.set(asset.id, false);
    applyPlacementBodies(index, plan, [placement], null);
    expect(plan.assets.get(asset.id)).toBe(false);
  });

  it("hides absent and relocated bodies without obscuring another floor", () => {
    const { index, asset, root, plan } = setup();
    indexAsset(index, asset.id, root);
    for (const rows of [[], [{ ...placement, floorId: "f-lower" }]]) {
      plan.assets.set(asset.id, true);
      applyPlacementBodies(index, plan, rows, null);
      expect(plan.assets.get(asset.id)).toBe(false);
    }
  });

  it("rejects ambiguous and floorless package bindings", () => {
    const { manifest, asset } = setup();
    manifest.assets.push({ ...asset, id: "second-body", floorId: undefined });
    expect(crossCheck(manifest).filter(d => d.code === "E_PLACEMENT_BODY")).toHaveLength(2);
  });
});
