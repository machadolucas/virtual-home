/**
 * The declarative visibility resolver, and the completeness of the explode/isolation policy.
 *
 * The two facts that make these tests worth having: floor node names recur across assets, and
 * several elements sit outside any floor node.
 */
import { describe, expect, it } from "vitest";
import { checkExplodePolicy, explodeGroupOf, isRoofGroup } from "@/house/model/explodeGroups";
import {
  cameraFacingRoomWalls,
  focusContextFor,
  focusCutSurfaceIds,
} from "@/house/model/focusContext";
import { buildManifestIndex, nodeKey } from "@/house/model/manifestIndex";
import { DEFAULT_LAYERS, type LayerId } from "@/house/model/types";
import {
  assetLayer,
  computeVisibility,
  isGroupVisible,
  type AssetNodeInventory,
  type VisibilityInput,
} from "@/house/model/visibilityPlan";
import { FIXTURE_DIR, inventoryOf, loadManifest, policyNodeNames, readPackageGlbs, REAL_DIR } from "./glb";

function setup(dir: string, loaded?: readonly string[]) {
  const manifest = loadManifest(dir);
  const index = buildManifestIndex(manifest);
  const assetIds = manifest.assets.map((a) => a.id);
  const glbs = readPackageGlbs(dir, assetIds);
  const inventory: AssetNodeInventory[] = [];
  for (const id of assetIds) {
    const g = glbs.get(id);
    if (!g) continue;
    const { assetId, floorNodes, floorlessElementNodes, edgesNode } = inventoryOf(g);
    inventory.push({ assetId, floorNodes, floorlessElementNodes, edgesNode });
  }
  const loadedAssetIds = loaded ?? [...glbs.keys()];
  return { manifest, index, glbs, inventory, loadedAssetIds };
}

const baseInput = (
  over: Partial<VisibilityInput>,
  inventory: readonly AssetNodeInventory[],
  loadedAssetIds: readonly string[],
): VisibilityInput => ({
  viewMode: "overview",
  activeFloorId: null,
  roofVisible: true,
  ceilingsVisible: true,
  edgesVisible: true,
  layers: { ...DEFAULT_LAYERS, structure: true, scanReferences: true },
  loadedAssetIds,
  inventory,
  ...over,
});

describe("computeVisibility (fixture)", () => {
  const { index, inventory, loadedAssetIds } = setup(FIXTURE_DIR);

  it("hides upper equipment groups without relying on loaded floor nodes", () => {
    const input = baseInput({ viewMode: "floor", activeFloorId: "f-lower" }, [], []);
    const plan = computeVisibility(index, input);
    expect(isGroupVisible(index, plan, "f-upper", input)).toBe(false);
    expect(isGroupVisible(index, plan, "f-lower", input)).toBe(true);
    const focused = { ...input, focus: focusContextFor(index, { kind: "room", id: "r-u-a" }) };
    expect(isGroupVisible(index, plan, "f-upper", focused)).toBe(true);
    expect(isGroupVisible(index, plan, "f-lower", focused)).toBe(true);
  });

  it("hides complete door geometry in both cut modes and restores it with walls up", () => {
    const doors = [...index.elements.values()].filter((element) => element.kind === "door");
    expect(doors.length).toBeGreaterThan(0);
    for (const wallMode of ["cut", "contextual"] as const) {
      const plan = computeVisibility(index, baseInput({ wallMode }, inventory, loadedAssetIds));
      for (const door of doors) for (const ref of door.nodeRefs)
        expect(plan.nodes.get(nodeKey(ref.assetId, ref.nodeName))).toBe(false);
    }
    for (const wallMode of ["up", "closed"] as const) {
      const plan = computeVisibility(index, baseInput({ wallMode }, inventory, loadedAssetIds));
      for (const door of doors) for (const ref of door.nodeRefs)
        expect(plan.nodes.get(nodeKey(ref.assetId, ref.nodeName))).not.toBe(false);
    }
  });

  it("shows everything in the overview", () => {
    const plan = computeVisibility(index, baseInput({}, inventory, loadedAssetIds));
    for (const [id, visible] of plan.assets) {
      if (loadedAssetIds.includes(id)) expect(visible, id).toBe(true);
    }
  });

  it("focuses a building floor while retaining its lower support", () => {
    const plan = computeVisibility(
      index,
      baseInput({ viewMode: "floor", activeFloorId: "f-upper" }, inventory, loadedAssetIds),
    );
    // `f-upper` lives in both the upper asset and the roof asset (the dormer)
    expect(plan.nodes.get(nodeKey("fixture-upper", "f-upper"))).toBe(true);
    expect(plan.nodes.get(nodeKey("fixture-roof", "f-upper"))).toBe(true);
    // lower floors in the same building remain as visual support
    expect(plan.nodes.get(nodeKey("fixture-lower", "f-lower"))).toBe(true);
    expect(plan.nodes.get(nodeKey("fixture-scan", "f-lower"))).toBe(true);
    expect(plan.assets.get("fixture-lower")).toBe(true);
    expect(plan.assets.get("fixture-upper")).toBe(true);
    // the roof asset stays loaded because it also owns the dormer
    expect(plan.assets.get("fixture-roof")).toBe(true);
  });

  it("keeps the dormer with the floor and the roof with the roof toggle", () => {
    const on = computeVisibility(
      index,
      baseInput({ viewMode: "floor", activeFloorId: "f-upper" }, inventory, loadedAssetIds),
    );
    expect(on.nodes.get(nodeKey("fixture-roof", "e-roof-fx"))).toBe(true);
    const off = computeVisibility(
      index,
      baseInput(
        { viewMode: "floor", activeFloorId: "f-upper", roofVisible: false },
        inventory,
        loadedAssetIds,
      ),
    );
    expect(off.nodes.get(nodeKey("fixture-roof", "e-roof-fx"))).toBe(false);
    // the dormer node is under f-upper, so it follows the floor, not the roof toggle
    expect(off.nodes.get(nodeKey("fixture-roof", "f-upper"))).toBe(true);
    expect(off.nodes.get(nodeKey("fixture-roof", "s-e-dormer-fx-ceiling"))).toBe(false);
    expect(off.nodes.get(nodeKey("fixture-roof", "s-e-dormer-fx-wall"))).not.toBe(false);
  });

  it("hides ceilings by surface node, including the dormer ceiling", () => {
    const plan = computeVisibility(index, baseInput({ ceilingsVisible: false }, inventory, loadedAssetIds));
    for (const sid of index.ceilingSurfaceIds) {
      const s = index.surfaces.get(sid);
      for (const nr of s!.nodeRefs) expect(plan.nodes.get(nodeKey(nr.assetId, nr.nodeName)), sid).toBe(false);
    }
    expect(index.ceilingSurfaceIds).toContain("s-e-dormer-fx-ceiling");
  });

  it("gates the yard, structure and scan layers", () => {
    const off = computeVisibility(
      index,
      baseInput(
        { layers: { ...DEFAULT_LAYERS, yard: false, scanReferences: false } },
        inventory,
        loadedAssetIds,
      ),
    );
    expect(off.assets.get("fixture-terrain")).toBe(false);
    expect(off.assets.get("fixture-scan")).toBe(false);
  });

  it("hides an asset's edges overlay when the asset spans more than one explode group", () => {
    // the roof asset holds both roof geometry and the upper-floor dormer
    const exploded = computeVisibility(
      index,
      baseInput({ explode: { enabled: true, gap: 2.5 } }, inventory, loadedAssetIds),
    );
    expect(exploded.nodes.get(nodeKey("fixture-roof", "edges-fixture-roof"))).toBe(false);
    // the lower asset also spans two groups: `f-lower` plus the grade-level step
    expect(exploded.nodes.get(nodeKey("fixture-lower", "edges-fixture-lower"))).toBe(false);
    // the upper asset holds one floor only, so its edges ride along
    expect(exploded.nodes.get(nodeKey("fixture-upper", "edges-fixture-upper"))).toBe(true);
    const flat = computeVisibility(index, baseInput({}, inventory, loadedAssetIds));
    expect(flat.nodes.get(nodeKey("fixture-roof", "edges-fixture-roof"))).toBe(true);
    expect(flat.nodes.get(nodeKey("fixture-lower", "edges-fixture-lower"))).toBe(true);
  });

  it("turns every edges overlay off with the edges toggle", () => {
    const plan = computeVisibility(index, baseInput({ edgesVisible: false }, inventory, loadedAssetIds));
    for (const inv of inventory)
      if (inv.edgesNode) expect(plan.nodes.get(nodeKey(inv.assetId, inv.edgesNode))).toBe(false);
  });

  it("never shows an asset that has not loaded", () => {
    const plan = computeVisibility(index, baseInput({}, inventory, ["fixture-lower"]));
    expect(plan.assets.get("fixture-lower")).toBe(true);
    expect(plan.assets.get("fixture-upper")).toBe(false);
  });

  it("derives the layer that gates each asset from the manifest", () => {
    const layers: Record<string, LayerId | undefined> = {};
    for (const a of index.manifest.assets) layers[a.id] = assetLayer(index, a);
    expect(layers["fixture-terrain"]).toBe("yard");
    expect(layers["fixture-scan"]).toBe("scanReferences");
    expect(layers["fixture-lower"]).toBeUndefined();
  });

  it("reveals a focused lower-floor room while keeping lower context and hiding its roof, ceiling and upper floors", () => {
    const focus = focusContextFor(index, { kind: "room", id: "r-l-a" });
    const plan = computeVisibility(
      index,
      baseInput(
        {
          // Focus must temporarily supersede a stale manual isolation without mutating it.
          viewMode: "floor",
          activeFloorId: "f-upper",
          focus,
        },
        inventory,
        loadedAssetIds,
      ),
    );
    expect(plan.nodes.get(nodeKey("fixture-lower", "f-lower"))).toBe(true);
    expect(plan.nodes.get(nodeKey("fixture-upper", "f-upper"))).toBe(false);
    expect(plan.nodes.get(nodeKey("fixture-roof", "e-roof-fx"))).toBe(false);
    expect(plan.nodes.get(nodeKey("fixture-lower", "s-r-l-a-ceiling"))).toBe(false);

    const restored = computeVisibility(
      index,
      baseInput(
        { viewMode: "floor", activeFloorId: "f-upper", focus: null },
        inventory,
        loadedAssetIds,
      ),
    );
    expect(restored.nodes.get(nodeKey("fixture-lower", "f-lower"))).toBe(true);
    expect(restored.nodes.get(nodeKey("fixture-upper", "f-upper"))).toBe(true);
  });

  it("keeps lower floors as context when focusing the upper floor", () => {
    const focus = focusContextFor(index, { kind: "room", id: "r-u-a" });
    const plan = computeVisibility(
      index,
      baseInput({ focus }, inventory, loadedAssetIds),
    );
    expect(plan.nodes.get(nodeKey("fixture-lower", "f-lower"))).toBe(true);
    expect(plan.nodes.get(nodeKey("fixture-upper", "f-upper"))).toBe(true);
    expect(plan.nodes.get(nodeKey("fixture-roof", "e-roof-fx"))).toBe(false);
    expect(plan.nodes.get(nodeKey("fixture-upper", "s-r-u-a-ceiling"))).toBe(false);
  });

  it("keeps a manually closed shell closed while room focus persists", () => {
    const focus = focusContextFor(index, { kind: "room", id: "r-u-a" });
    const plan = computeVisibility(
      index,
      baseInput({ wallMode: "closed", focus }, inventory, loadedAssetIds),
    );
    expect(plan.nodes.get(nodeKey("fixture-roof", "e-roof-fx"))).toBe(true);
    expect(plan.nodes.get(nodeKey("fixture-upper", "s-r-u-a-ceiling"))).toBe(true);
  });

  it("frames floors transiently and restores all floors when a building is focused", () => {
    const floorFocus = focusContextFor(index, { kind: "floor", id: "f-lower" });
    const floorPlan = computeVisibility(
      index,
      baseInput({ focus: floorFocus }, inventory, loadedAssetIds),
    );
    expect(floorPlan.nodes.get(nodeKey("fixture-upper", "f-upper"))).toBe(false);

    const buildingFocus = focusContextFor(index, { kind: "building", id: "b-fx" });
    const buildingPlan = computeVisibility(
      index,
      baseInput(
        { viewMode: "floor", activeFloorId: "f-lower", focus: buildingFocus },
        inventory,
        loadedAssetIds,
      ),
    );
    expect(buildingPlan.nodes.get(nodeKey("fixture-upper", "f-upper"))).toBe(true);
    expect(buildingPlan.nodes.get(nodeKey("fixture-roof", "e-roof-fx"))).toBe(true);
  });

  it("preserves a specifically focused ceiling surface", () => {
    const focus = focusContextFor(index, { kind: "surface", id: "s-r-l-a-ceiling" });
    const plan = computeVisibility(index, baseInput({ focus }, inventory, loadedAssetIds));
    expect(plan.nodes.get(nodeKey("fixture-lower", "s-r-l-a-ceiling"))).toBe(true);
    expect(plan.nodes.get(nodeKey("fixture-lower", "s-r-l-b-ceiling"))).toBe(false);
  });

  it("suspends contextual reveal while an editor owns scene visibility", () => {
    expect(focusContextFor(index, { kind: "room", id: "r-l-a" }, undefined, false)).toBeNull();
    expect(focusContextFor(index, { kind: "room", id: "r-l-a" })).not.toBeNull();
  });

  it("classifies only camera-facing room walls for a low cut", () => {
    const centres = new Map([
      ["s-e-l-ext--r-l-a", [0.2, 1.2, 2] as [number, number, number]],
      ["s-w-l-ab--r-l-a", [3, 1.2, 2] as [number, number, number]],
      // A wall owned by the next room still blocks the view corridor to the target.
      ["s-w-l-bc--r-l-b", [4, 1.2, 2] as [number, number, number]],
    ]);
    expect(cameraFacingRoomWalls(index, "r-l-a", [8, 5, 2], centres)).toEqual([
      "s-w-l-ab--r-l-a",
      "s-w-l-bc--r-l-b",
    ]);
    expect(cameraFacingRoomWalls(index, "r-l-a", [-5, 5, 2], centres)).toEqual([
      "s-e-l-ext--r-l-a",
    ]);
  });

  it("cuts the whole wall assembly and attached openings without touching unrelated elements", () => {
    const local = buildManifestIndex(loadManifest(FIXTURE_DIR));
    const wallFace = local.surfaces.get("s-w-l-ab--r-l-a")!;
    local.surfaces.set("synthetic-wall-top", {
      ...wallFace,
      id: "synthetic-wall-top",
      kind: "other",
      role: "wall-top",
      roomId: undefined,
      nodeRefs: [{ ...wallFace.nodeRefs[0]!, nodeName: "synthetic-wall-top" }],
    });
    local.surfacesByElement.get("e-w-l-ab")!.push("synthetic-wall-top");

    const cuts = focusCutSurfaceIds(local, ["s-w-l-ab--r-l-a"]);
    expect(cuts).toEqual(
      expect.arrayContaining([
        "s-w-l-ab--r-l-a",
        "s-w-l-ab--r-l-b",
        "synthetic-wall-top",
        "s-o-l-door-reveal",
        "s-o-l-door-leaf",
      ]),
    );
    expect(cuts).not.toContain("s-w-l-bc--r-l-b");
  });
});

describe("explode / isolation policy completeness (fixture)", () => {
  const { index, glbs } = setup(FIXTURE_DIR);

  it("classifies every node that needs a group", () => {
    const inputs = [...glbs.values()].map((g) => ({
      assetId: g.assetId,
      nodeNames: policyNodeNames(g),
    }));
    const result = checkExplodePolicy(index, inputs);
    expect(result.unclassified).toEqual([]);
    expect(result.classified).toBeGreaterThan(0);
  });

  it("puts roof geometry in a per-building roof group and terrain on the site", () => {
    expect(explodeGroupOf(index, "fixture-roof", "e-roof-fx")).toBe("roof:b-fx");
    expect(isRoofGroup("roof:b-fx")).toBe(true);
    expect(explodeGroupOf(index, "fixture-terrain", "e-terrain-fx")).toBe("site");
    expect(explodeGroupOf(index, "fixture-upper", "f-upper")).toBe("f-upper");
  });
});

describe.skipIf(!REAL_DIR)("real package visibility and policy", () => {
  it("classifies every floor-less node of every asset", () => {
    const { index, glbs } = setup(REAL_DIR as string);
    const inputs = [...glbs.values()].map((g) => ({
      assetId: g.assetId,
      nodeNames: policyNodeNames(g),
    }));
    const result = checkExplodePolicy(index, inputs);
    expect(result.unclassified).toEqual([]);
  });

  it("isolates f-upper across house-upper, house-roof, house-structure and the scan asset", () => {
    const { index, inventory, loadedAssetIds } = setup(REAL_DIR as string);
    const plan = computeVisibility(
      index,
      baseInput({ viewMode: "floor", activeFloorId: "f-upper" }, inventory, loadedAssetIds),
    );
    expect(plan.nodes.get(nodeKey("house-upper", "f-upper"))).toBe(true);
    expect(plan.nodes.get(nodeKey("house-roof", "f-upper"))).toBe(true);
    expect(plan.nodes.get(nodeKey("house-structure", "f-upper"))).toBe(true);
    expect(plan.nodes.get(nodeKey("house-structure", "f-ground"))).toBe(false);
    expect(plan.nodes.get(nodeKey("house-ground", "f-ground"))).toBe(false);
    expect(plan.nodes.get(nodeKey("garage-structure", "f-garage"))).toBe(false);
    expect(plan.assets.get("house-ground")).toBe(false);
  });

  it("pins the three floor-less ground-floor elements to the ground floor", () => {
    const { index, inventory, loadedAssetIds } = setup(REAL_DIR as string);
    const upper = computeVisibility(
      index,
      baseInput({ viewMode: "floor", activeFloorId: "f-upper" }, inventory, loadedAssetIds),
    );
    for (const n of ["e-g-fire-door-landing", "e-g-bay-door-landing", "e-outdoor-fireplace"])
      expect(upper.nodes.get(nodeKey("house-ground", n)), n).toBe(false);
    const ground = computeVisibility(
      index,
      baseInput({ viewMode: "floor", activeFloorId: "f-ground" }, inventory, loadedAssetIds),
    );
    for (const n of ["e-g-fire-door-landing", "e-g-bay-door-landing", "e-outdoor-fireplace"])
      expect(ground.nodes.get(nodeKey("house-ground", n)), n).toBe(true);
  });

  it("hides the structure assets' edges while exploded (they span two floors)", () => {
    const { index, inventory, loadedAssetIds } = setup(REAL_DIR as string);
    const plan = computeVisibility(
      index,
      baseInput({ explode: { enabled: true, gap: 2.5 } }, inventory, loadedAssetIds),
    );
    expect(plan.nodes.get(nodeKey("house-structure", "edges-house-structure"))).toBe(false);
    expect(plan.nodes.get(nodeKey("house-ground", "edges-house-ground"))).toBe(true);
  });

  it("hides all 25 ceiling surfaces with the ceilings toggle", () => {
    const { index, inventory, loadedAssetIds } = setup(REAL_DIR as string);
    expect(index.ceilingSurfaceIds.length).toBe(25);
    const plan = computeVisibility(index, baseInput({ ceilingsVisible: false }, inventory, loadedAssetIds));
    let hidden = 0;
    for (const sid of index.ceilingSurfaceIds) {
      const s = index.surfaces.get(sid);
      for (const nr of s!.nodeRefs)
        if (plan.nodes.get(nodeKey(nr.assetId, nr.nodeName)) === false) hidden++;
    }
    expect(hidden).toBe(25);
  });
});
