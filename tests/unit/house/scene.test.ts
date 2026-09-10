/**
 * Scene-layer tests. three.js runs headless in Node for everything here — geometry, matrices,
 * materials, visibility, raycasting and clipping-plane maths need no GL context.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { planAllSurfaces, planRoomColors } from "@/house/model/colorPlan";
import { buildGroupOrder, clipGroupOf, roofGroup } from "@/house/model/explodeGroups";
import { nodeKey } from "@/house/model/manifestIndex";
import { DEFAULT_LAYERS } from "@/house/model/types";
import { computeVisibility, type VisibilityInput } from "@/house/model/visibilityPlan";
import { allMaterialHex, applyColors, materialHex } from "@/house/scene/applyColors";
import { applyVisibility } from "@/house/scene/applyVisibility";
import { ClipGroups, OFF } from "@/house/scene/clipGroups";
import { boxForSelection } from "@/house/scene/framing";
import { disposeViewer } from "@/house/scene/dispose";
import { applyExplode, worldY } from "@/house/scene/explode";
import { Highlighter, highlightTargets } from "@/house/scene/highlight";
import { MarkerLayer } from "@/house/scene/markers";
import { auditMaterials } from "@/house/scene/materialAudit";
import { Picker } from "@/house/scene/picker";
import { RouteLayer } from "@/house/scene/routes";
import { wallFrame } from "@/house/scene/wallFrame";
import { inventoryOf } from "@/house/scene/SceneIndex";
import type { Route } from "@/house/model/types";
import { FIXTURE_DIR, loadManifest, REAL_DIR } from "./glb";
import { buildScene } from "./sceneFromGlb";

const visibilityInput = (
  built: ReturnType<typeof buildScene>,
  over: Partial<VisibilityInput> = {},
): VisibilityInput => ({
  viewMode: "overview",
  activeFloorId: null,
  roofVisible: true,
  ceilingsVisible: true,
  edgesVisible: true,
  layers: { ...DEFAULT_LAYERS },
  loadedAssetIds: [...built.index.assets.keys()],
  inventory: inventoryOf(built.index),
  ...over,
});

describe("SceneIndex (fixture)", () => {
  it("indexes every surface, and only mesh-backed ones into surfaceMesh", () => {
    const built = buildScene(FIXTURE_DIR);
    const defaults = built.manifest.surfaces.filter((s) =>
      built.index.assets.has(s.nodeRefs[0]!.assetId),
    );
    expect(built.index.surfaceNode.size).toBe(defaults.length);
    expect(built.index.surfaceMesh.size).toBe(defaults.length - 1); // the mesh-less band
    expect(built.index.surfaceNode.has("s-e-l-ext-out-band")).toBe(true);
    expect(built.index.surfaceMesh.has("s-e-l-ext-out-band")).toBe(false);
  });

  it("keeps a list per floor node, because the same name lives in several assets", () => {
    const built = buildScene(FIXTURE_DIR);
    const upper = built.index.floorNodes.get("f-upper") ?? [];
    expect(upper.length).toBe(2);
    expect(new Set(upper.map((o) => o.parent?.parent?.name))).toEqual(
      new Set(["fixture-upper", "fixture-roof"]),
    );
  });

  it("turns off automatic matrix updates for static shell nodes", () => {
    const built = buildScene(FIXTURE_DIR);
    const mesh = built.index.surfaceMesh.get("s-r-l-a-floor");
    expect(mesh?.matrixAutoUpdate).toBe(false);
  });

  it("reports no shared materials and clones nothing", () => {
    const built = buildScene(FIXTURE_DIR);
    for (const entry of built.index.assets.values()) {
      const audit = auditMaterials(entry);
      expect(audit.cloned, entry.id).toBe(0);
      expect(audit.materialCount, entry.id).toBe(audit.meshCount);
    }
  });

  it("frames an area element from its own loaded surfaces", () => {
    const built = buildScene(FIXTURE_DIR);
    const box = boxForSelection(built.index, { kind: "element", id: "e-terrain-fx" });
    expect(box).not.toBeNull();
    const asset = new THREE.Box3().setFromObject(built.index.assets.get("fixture-terrain")!.root);
    expect(box!.min.x).toBeCloseTo(asset.min.x - 0.3, 6);
    expect(box!.max.z).toBeCloseTo(asset.max.z + 0.3, 6);
  });

  it("uses a fixed per-surface focus plane to leave a low wall stub and reject clipped picks", () => {
    const clip = new ClipGroups(["f-lower"]);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2.5, 0.1), new THREE.MeshBasicMaterial());
    clip.attach(mesh, "f-lower", "wall-a");
    expect(clip.planesFor("wall-a")).toHaveLength(3);
    expect(clip.setFocusCuts(new Map([["wall-a", 0.9]]))).toBe(true);
    expect(clip.keepsSurface("f-lower", "wall-a", new THREE.Vector3(0, 0.5, 0))).toBe(true);
    expect(clip.keepsSurface("f-lower", "wall-a", new THREE.Vector3(0, 1.5, 0))).toBe(false);
    expect(clip.setFocusCuts(new Map())).toBe(true);
    expect(clip.keepsSurface("f-lower", "wall-a", new THREE.Vector3(0, 1.5, 0))).toBe(true);
  });

  it("lowers tree geometry with the wall modes and restores its full height", () => {
    const clip = new ClipGroups(["f-lower"]);
    const material = new THREE.MeshBasicMaterial();
    const tree = new THREE.Mesh(new THREE.BoxGeometry(3, 5, 3), material);
    clip.attachTree(tree, "f-lower");

    expect(material.clippingPlanes).toHaveLength(3);
    expect(clip.setTreeCuts(new Map([["f-lower", 0.9]]))).toBe(true);
    expect(material.clippingPlanes![2]!.distanceToPoint(new THREE.Vector3(0, 0.5, 0))).toBeGreaterThanOrEqual(0);
    expect(material.clippingPlanes![2]!.distanceToPoint(new THREE.Vector3(0, 1.5, 0))).toBeLessThan(0);
    expect(clip.setTreeCuts(new Map())).toBe(true);
    expect(material.clippingPlanes![2]!.distanceToPoint(new THREE.Vector3(0, 5, 0))).toBeGreaterThanOrEqual(0);
  });
});

describe("applyColors (fixture)", () => {
  it("reproduces every manifest defaultColor end to end", () => {
    const built = buildScene(FIXTURE_DIR);
    applyColors(planAllSurfaces(built.manifest.surfaces, {}), built.index);
    for (const [sid, hex] of Object.entries(allMaterialHex(built.index))) {
      expect(hex, sid).toBe(built.manifestIndex.surfaces.get(sid)?.defaultColor.toLowerCase());
    }
  });

  it("changes exactly one material when one surface is overridden", () => {
    const built = buildScene(FIXTURE_DIR);
    applyColors(planAllSurfaces(built.manifest.surfaces, {}), built.index);
    const before = allMaterialHex(built.index);
    const room = built.manifestIndex.rooms.get("r-l-a")!;
    applyColors(
      planRoomColors(room, built.manifestIndex.surfaces, { "s-r-l-a-floor": "#ff0000" }),
      built.index,
    );
    const after = allMaterialHex(built.index);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed).toEqual(["s-r-l-a-floor"]);
    expect(after["s-r-l-a-floor"]).toBe("#ff0000");
  });

  it("leaves the neighbour's face of a shared wall untouched", () => {
    const built = buildScene(FIXTURE_DIR);
    applyColors(planAllSurfaces(built.manifest.surfaces, {}), built.index);
    const before = materialHex(built.index, "s-w-l-ab--r-l-b");
    const room = built.manifestIndex.rooms.get("r-l-a")!;
    applyColors(
      planRoomColors(room, built.manifestIndex.surfaces, { "s-w-l-ab--r-l-a": "#00ff00" }),
      built.index,
    );
    expect(materialHex(built.index, "s-w-l-ab--r-l-a")).toBe("#00ff00");
    expect(materialHex(built.index, "s-w-l-ab--r-l-b")).toBe(before);
  });

  it("resets a room to the manifest's defaultColor, not to whatever loaded", () => {
    const built = buildScene(FIXTURE_DIR);
    const room = built.manifestIndex.rooms.get("r-l-a")!;
    applyColors(planAllSurfaces(built.manifest.surfaces, {}), built.index);
    const pristine = allMaterialHex(built.index);
    applyColors(
      planRoomColors(room, built.manifestIndex.surfaces, { "s-r-l-a-floor": "#ff0000" }),
      built.index,
    );
    applyColors(planRoomColors(room, built.manifestIndex.surfaces, {}), built.index);
    expect(allMaterialHex(built.index)).toEqual(pristine);
  });

  it("skips a mesh-less surface instead of throwing", () => {
    const built = buildScene(FIXTURE_DIR);
    const result = applyColors(
      [{ surfaceId: "s-e-l-ext-out-band", hex: "#123456", source: "override" }],
      built.index,
    );
    expect(result).toEqual({ touched: 0, skipped: ["s-e-l-ext-out-band"] });
  });
});

describe("applyVisibility (fixture)", () => {
  it("writes .visible and rebuilds the pickable list", () => {
    const built = buildScene(FIXTURE_DIR);
    const all = applyVisibility(computeVisibility(built.manifestIndex, visibilityInput(built)), built.index);
    expect(all.pickables).toBeGreaterThan(0);

    const ceilings = built.manifestIndex.ceilingSurfaceIds.filter((sid) =>
      built.index.surfaceMesh.has(sid),
    );
    const off = applyVisibility(
      computeVisibility(built.manifestIndex, visibilityInput(built, { ceilingsVisible: false })),
      built.index,
    );
    expect(off.pickables).toBe(all.pickables - ceilings.length);
    for (const sid of ceilings) expect(built.index.surfaceMesh.get(sid)!.visible, sid).toBe(false);
  });

  it("focuses a floor while keeping lower supporting meshes pickable", () => {
    const built = buildScene(FIXTURE_DIR);
    applyVisibility(
      computeVisibility(
        built.manifestIndex,
        visibilityInput(built, { viewMode: "floor", activeFloorId: "f-upper" }),
      ),
      built.index,
    );
    expect(built.index.pickables).toContain(built.index.surfaceMesh.get("s-r-l-a-floor"));
    expect(built.index.pickables).toContain(built.index.surfaceMesh.get("s-r-u-a-floor"));
    // the dormer lives in the roof asset under `f-upper`, so it survives the focus
    expect(built.index.pickables).toContain(built.index.surfaceMesh.get("s-e-dormer-fx-wall"));
  });

  it("agrees with the resolver after a dollhouse preset and a reset (no desync)", () => {
    const built = buildScene(FIXTURE_DIR);
    const dollhouse = visibilityInput(built, { roofVisible: false, ceilingsVisible: false });
    applyVisibility(computeVisibility(built.manifestIndex, dollhouse), built.index);
    const reset = visibilityInput(built);
    const plan = computeVisibility(built.manifestIndex, reset);
    applyVisibility(plan, built.index);
    for (const [assetId, entry] of built.index.assets) {
      expect(entry.root.visible, assetId).toBe(plan.assets.get(assetId));
      for (const [name, node] of entry.nodes) {
        const decision = plan.nodes.get(nodeKey(assetId, name));
        if (decision !== undefined) expect(node.visible, `${assetId}/${name}`).toBe(decision);
      }
    }
  });
});

describe("clipping planes (fixture)", () => {
  it("keeps two shared group planes and one fixed focus plane per surface", () => {
    const built = buildScene(FIXTURE_DIR);
    for (const pair of built.clip.planes.values()) expect(pair.length).toBe(2);
    const mesh = built.index.surfaceMesh.get("s-r-l-a-floor")!;
    const material = mesh.material as THREE.Material;
    expect(material.clippingPlanes?.length).toBe(3);
    expect(material.clipIntersection).toBe(false);

    built.clip.setCutAll({ enabled: true, y: 1.2, vertical: null }, () => 0);
    expect(material.clippingPlanes?.length).toBe(3);
    built.clip.setCutAll({ enabled: false, y: 1.2, vertical: null }, () => 0);
    expect(material.clippingPlanes?.length).toBe(3);
    expect(built.clip.planes.get("f-lower")![0]!.constant).toBe(OFF);
  });

  it("keeps points below the cut and drops points above it", () => {
    const built = buildScene(FIXTURE_DIR);
    built.clip.setCutAll({ enabled: true, y: 1.2, vertical: null }, () => 0);
    expect(built.clip.keeps("f-lower", new THREE.Vector3(1, 0.5, 1))).toBe(true);
    expect(built.clip.keeps("f-lower", new THREE.Vector3(1, 2.0, 1))).toBe(false);
  });

  it("tracks the explode offset so the cut stays at the same physical height", () => {
    const built = buildScene(FIXTURE_DIR);
    const order = buildGroupOrder(built.manifestIndex);
    const offsets = new Map([...order.keys()].map((g) => [g, (order.get(g) ?? 0) * 2.5]));
    built.clip.setCutAll({ enabled: true, y: 3.9, vertical: null }, (g) => offsets.get(g) ?? 0);
    // f-upper is one step up, so its plane sits 2.5 m higher in world space
    expect(built.clip.planes.get("f-upper")![0]!.constant).toBeCloseTo(3.9 + 2.5, 6);
    expect(built.clip.planes.get("f-lower")![0]!.constant).toBeCloseTo(3.9, 6);
  });

  it("applies a vertical cut on either side", () => {
    const built = buildScene(FIXTURE_DIR);
    built.clip.setCutAll({ enabled: true, y: 9, vertical: { axis: "x", v: 3, sign: 1 } }, () => 0);
    expect(built.clip.keeps("f-lower", new THREE.Vector3(2, 1, 1))).toBe(true);
    expect(built.clip.keeps("f-lower", new THREE.Vector3(4, 1, 1))).toBe(false);
    built.clip.setCutAll({ enabled: true, y: 9, vertical: { axis: "x", v: 3, sign: -1 } }, () => 0);
    expect(built.clip.keeps("f-lower", new THREE.Vector3(2, 1, 1))).toBe(false);
    expect(built.clip.keeps("f-lower", new THREE.Vector3(4, 1, 1))).toBe(true);
  });
});

describe("picking (fixture)", () => {
  function cameraLookingDown(): THREE.OrthographicCamera {
    const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, -200, 400);
    camera.position.set(0, 20, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return camera;
  }

  const rect = { left: 0, top: 0, width: 100, height: 100 };

  /** CSS pixel for a world point under `cameraLookingDown`. */
  function screenOf(camera: THREE.Camera, world: THREE.Vector3): [number, number] {
    const v = world.clone().project(camera);
    return [(v.x * 0.5 + 0.5) * rect.width, (-v.y * 0.5 + 0.5) * rect.height];
  }

  it("resolves ownership from userData and the manifest", () => {
    const built = buildScene(FIXTURE_DIR);
    applyVisibility(
      computeVisibility(
        built.manifestIndex,
        visibilityInput(built, {
          viewMode: "floor",
          activeFloorId: "f-lower",
          ceilingsVisible: false,
          roofVisible: false,
        }),
      ),
      built.index,
    );
    const camera = cameraLookingDown();
    const picker = new Picker();
    const anchor = built.manifestIndex.roomAnchors.get("r-l-b")!;
    const [x, y] = screenOf(camera, new THREE.Vector3(anchor.point[0], 0, anchor.point[2]));
    const hit = picker.pick(x, y, rect, camera, built.index, built.clip);
    expect(hit).not.toBeNull();
    expect(hit!.roomId).toBe("r-l-b");
    expect(hit!.floorId).toBe("f-lower");
    expect(hit!.buildingId).toBe("b-fx");
    expect(hit!.surfaceId).toBe("s-r-l-b-floor");
    // the room's own datum, 0.20 m below the floor datum
    expect(hit!.point.y).toBeCloseTo(-0.2, 3);
  });

  it("ignores geometry the cutaway removed", () => {
    const built = buildScene(FIXTURE_DIR);
    applyVisibility(computeVisibility(built.manifestIndex, visibilityInput(built)), built.index);
    const camera = cameraLookingDown();
    const picker = new Picker();
    const anchor = built.manifestIndex.roomAnchors.get("r-u-a")!;
    const [x, y] = screenOf(camera, new THREE.Vector3(anchor.point[0], 0, anchor.point[2]));

    const roofHit = picker.pick(x, y, rect, camera, built.index, built.clip);
    expect(roofHit?.surfaceId).toMatch(/^s-e-roof-fx/);

    built.clip.setCutAll({ enabled: true, y: 1.2, vertical: null }, () => 0);
    const cutHit = picker.pick(x, y, rect, camera, built.index, built.clip);
    expect(cutHit?.surfaceId).not.toMatch(/^s-e-roof-fx/);
    expect(cutHit?.point.y).toBeLessThanOrEqual(1.2 + 1e-6);
  });

  it("returns null when nothing is under the pointer", () => {
    const built = buildScene(FIXTURE_DIR);
    applyVisibility(computeVisibility(built.manifestIndex, visibilityInput(built)), built.index);
    const camera = cameraLookingDown();
    const picker = new Picker();
    const [x, y] = screenOf(camera, new THREE.Vector3(500, 0, 500));
    expect(picker.pick(x, y, rect, camera, built.index, built.clip)).toBeNull();
  });
});

describe("highlighting (fixture)", () => {
  it("does not touch any material colour, and clears cleanly", () => {
    const built = buildScene(FIXTURE_DIR);
    applyColors(planAllSurfaces(built.manifest.surfaces, {}), built.index);
    const before = allMaterialHex(built.index);
    const highlighter = new Highlighter(built.scene);
    const targets = highlightTargets(built.index, { kind: "room", id: "r-l-a" });
    highlighter.set(built.index, built.clip, targets.ids, null, {
      intensity: targets.intensity,
      primary: targets.primary,
    });
    expect(allMaterialHex(built.index)).toEqual(before);

    const floor = built.index.surfaceMesh.get("s-r-l-a-floor")!;
    expect((floor.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0);
    expect(highlighter.outlineNode).not.toBeNull();
    const outlineMaterial = highlighter.outlineNode!.material as THREE.LineBasicMaterial;
    expect(outlineMaterial.clippingPlanes?.length).toBe(3);

    highlighter.clear(built.index, built.clip);
    expect((floor.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0);
    expect(allMaterialHex(built.index)).toEqual(before);
    highlighter.dispose();
  });

  it("highlights the whole room, not the neighbour's shared face", () => {
    const built = buildScene(FIXTURE_DIR);
    const targets = highlightTargets(built.index, { kind: "room", id: "r-l-a" });
    expect(targets.ids).toContain("s-w-l-ab--r-l-a");
    expect(targets.ids).not.toContain("s-w-l-ab--r-l-b");
    expect(targets.primary).toBe("s-r-l-a-floor");
  });

  it("survives a mesh-less surface in the highlight set", () => {
    const built = buildScene(FIXTURE_DIR);
    const highlighter = new Highlighter(built.scene);
    expect(() =>
      highlighter.set(built.index, built.clip, ["s-e-l-ext-out-band"], null, {
        primary: "s-e-l-ext-out-band",
      }),
    ).not.toThrow();
    highlighter.dispose();
  });
});

describe("explode (fixture)", () => {
  it("moves each group by its own offset and returns to zero", () => {
    const built = buildScene(FIXTURE_DIR);
    const applied = applyExplode(built.index, { enabled: true, gap: 3 });
    expect(applied.offsets.get("f-lower")).toBe(0);
    expect(applied.offsets.get("f-upper")).toBe(3);
    expect(applied.offsets.get(roofGroup("b-fx"))).toBe(6);
    expect(applied.offsets.get("site")).toBe(0);

    expect(worldY(built.index, "fixture-upper", "f-upper")).toBeCloseTo(3, 6);
    // the same floor node in the roof asset moves by the same amount
    expect(worldY(built.index, "fixture-roof", "f-upper")).toBeCloseTo(3, 6);
    expect(worldY(built.index, "fixture-roof", "e-roof-fx")).toBeCloseTo(6, 6);
    expect(worldY(built.index, "fixture-lower", "f-lower")).toBeCloseTo(0, 6);
    expect(worldY(built.index, "fixture-terrain", "e-terrain-fx")).toBeCloseTo(0, 6);

    applyExplode(built.index, { enabled: false, gap: 3 });
    expect(worldY(built.index, "fixture-upper", "f-upper")).toBeCloseTo(0, 6);
    expect(worldY(built.index, "fixture-roof", "e-roof-fx")).toBeCloseTo(0, 6);
  });

  it("moves the overlay group, never the data underneath it", () => {
    const built = buildScene(FIXTURE_DIR);
    const markers = new MarkerLayer(built.index, built.clip);
    const placement = {
      id: "p1",
      modelId: "fixture-house",
      equipmentId: "eq1",
      name: "Sensor",
      position: [2, 3.2, 2] as [number, number, number],
      rotationYDeg: 0,
      mount: { kind: "floor" as const, height: 0.5 },
      floorId: "f-upper",
      roomId: "r-u-a",
      surfaceId: null,
      locationNote: "",
      photoId: null,
      entityId: null,
      symbol: null,
      category: null,
    };
    markers.set([placement], () => "live", () => "f-upper");
    applyExplode(built.index, { enabled: true, gap: 2.5 });

    const overlay = built.index.overlay.floorGroups.get("f-upper")!;
    overlay.updateMatrixWorld(true);
    const world = new THREE.Vector3(...placement.position).applyMatrix4(overlay.matrixWorld);
    expect(world.y).toBeCloseTo(3.2 + 2.5, 6);
    // the stored coordinate is byte-identical: the offset lives on the group only
    expect(placement.position).toEqual([2, 3.2, 2]);
    // Moving an instance must invalidate old bounds used by body picking and support snapping.
    const mesh = markers.meshes[0]!;
    mesh.computeBoundingSphere();
    const oldCenter = mesh.boundingSphere!.center.clone();
    markers.set([{ ...placement, position: [20, 3.2, 20] }], () => "live", () => "f-upper");
    expect(mesh.boundingSphere).toBeNull();
    mesh.computeBoundingSphere();
    expect(mesh.boundingSphere!.center.distanceTo(oldCenter)).toBeGreaterThan(20);
    markers.dispose();
  });
});

describe("routes (fixture)", () => {
  const route = (over: Partial<Route> = {}): Route => ({
    id: "r1",
    modelId: "fixture-house",
    name: "Kitchen duct",
    system: "ventilation",
    kind: "duct",
    points: [
      [1, 1, 1],
      [3, 1, 1],
      [3, 1, 3],
    ],
    segments: [
      { floorId: "f-lower", roomId: "r-l-a" },
      { floorId: "f-lower", roomId: "r-l-a" },
    ],
    certainty: "measured",
    lifecycle: "installed",
    endpoints: [{ kind: "free" }, { kind: "free" }],
    photoIds: [],
    ...over,
  });

  it("computes line distances for dashed (inferred / unknown) confidence", () => {
    const built = buildScene(FIXTURE_DIR);
    const layer = new RouteLayer(built.index, built.clip);
    layer.set([route({ certainty: "inferred" }), route({ id: "r2", certainty: "unknown" })]);
    expect(layer.hasLineDistances()).toBe(true);
    layer.dispose();
  });

  it("batches into one bucket per (group, system, lifecycle, certainty)", () => {
    const built = buildScene(FIXTURE_DIR);
    const layer = new RouteLayer(built.index, built.clip);
    layer.set([
      route(),
      route({ id: "r2" }),
      route({ id: "r3", certainty: "inferred" }),
      route({ id: "r4", system: "water" }),
    ]);
    expect(layer.bucketCount).toBe(3);
    layer.dispose();
  });

  it("adds a tube only where a diameter is known and tubes are on", () => {
    const built = buildScene(FIXTURE_DIR);
    const layer = new RouteLayer(built.index, built.clip);
    layer.set([route({ diameterM: 0.125 })], { tubes: true });
    const overlay = built.index.overlay.floorGroups.get("f-lower");
    expect(overlay).toBeDefined();
    expect(overlay!.children.filter((o) => o.name.startsWith("vh-tube-")).length).toBe(1);
    layer.set([route({ diameterM: 0.125 })], { tubes: false });
    expect(overlay!.children.filter((o) => o.name.startsWith("vh-tube-")).length).toBe(0);
    layer.dispose();
  });
});

describe("dispose (fixture)", () => {
  it("empties the index and frees every geometry", () => {
    const built = buildScene(FIXTURE_DIR);
    const markers = new MarkerLayer(built.index, built.clip);
    markers.set([], () => "live", () => "f-lower");
    const report = disposeViewer(built.index, built.scene);
    expect(report.assets).toBeGreaterThan(0);
    expect(report.geometries).toBeGreaterThan(0);
    expect(built.index.assets.size).toBe(0);
    expect(built.index.surfaceMesh.size).toBe(0);
    expect(built.index.pickables.length).toBe(0);
    expect(built.scene.children.some((c) => c.name.startsWith("fixture-"))).toBe(false);
  });
});

describe("wallFrame (fixture)", () => {
  it("round-trips toLocal(toWorld(u, v, d)) for every wall surface", () => {
    const built = buildScene(FIXTURE_DIR);
    let checked = 0;
    for (const [sid, mesh] of built.index.surfaceMesh) {
      if (built.manifestIndex.surfaces.get(sid)?.kind !== "wall") continue;
      const frame = wallFrame(mesh);
      for (const [u, v, d] of [
        [0, 0, 0],
        [0.3, 1.2, 0.02],
        [frame.uRange[1], frame.vRange[1], -0.05],
      ] as Array<[number, number, number]>) {
        const local = frame.toLocal(frame.toWorld(u, v, d));
        expect(local.u, sid).toBeCloseTo(u, 6);
        expect(local.v, sid).toBeCloseTo(v, 6);
        expect(local.d, sid).toBeCloseTo(d, 6);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("measures the true length of a non-axis-aligned wall, not its AABB", () => {
    const built = buildScene(FIXTURE_DIR);
    const mesh = built.index.surfaceMesh.get("s-w-u-diag--r-u-a")!;
    const frame = wallFrame(mesh);
    const trueLength = Math.hypot(5.8 - 4.0, 3.0 - 3.8);
    expect(frame.uRange[1]).toBeCloseTo(trueLength, 5);
    // the axis-aligned extents are both smaller than the real run
    const box = new THREE.Box3().setFromObject(mesh);
    expect(box.max.x - box.min.x).toBeLessThan(trueLength);
    expect(box.max.z - box.min.z).toBeLessThan(trueLength);
    // v is world height, so `room.floorElevation + h` reads as height above that room's floor
    expect(frame.vRange[0]).toBeCloseTo(2.7, 6);
    expect(frame.n.y).toBe(0);
  });

  it("orients the normal towards the room when asked", () => {
    const built = buildScene(FIXTURE_DIR);
    const mesh = built.index.surfaceMesh.get("s-w-l-ab--r-l-a")!;
    const anchor = built.manifestIndex.roomAnchors.get("r-l-a")!;
    const towards = new THREE.Vector3(...anchor.point);
    const frame = wallFrame(mesh, { towards });
    const face = frame.toWorld(frame.uRange[1] / 2, 1.2, 0);
    expect(towards.clone().sub(face).dot(frame.n)).toBeGreaterThan(0);
  });
});

describe.skipIf(!REAL_DIR)("scene layer against the real package", () => {
  it("indexes the 9 default assets' 403 surfaces, 401 of them mesh-backed, cloning nothing", () => {
    // The two scan references are `loadByDefault: false`, so the default set holds 403 of the 405
    // surfaces; two of those are the mesh-less garage bands, leaving 401 meshes.
    const built = buildScene(REAL_DIR as string);
    expect(built.index.assets.size).toBe(9);
    expect(built.index.surfaceNode.size).toBe(403);
    expect(built.index.surfaceMesh.size).toBe(401);
    expect(built.index.surfaceNode.has("s-e-f-garage-ext-out-0-upper")).toBe(true);
    expect(built.index.surfaceMesh.has("s-e-f-garage-ext-out-0-upper")).toBe(false);
    for (const entry of built.index.assets.values())
      expect(auditMaterials(entry).cloned, entry.id).toBe(0);
  });

  it("indexes all 405 surfaces once the scan references are opted in", () => {
    const built = buildScene(REAL_DIR as string, {
      assetIds: (loadManifest(REAL_DIR as string).assets ?? []).map((a) => a.id),
    });
    expect(built.index.surfaceNode.size).toBe(405);
    expect(built.index.surfaceMesh.size).toBe(403);
  });

  it("reproduces every default asset's defaultColor through three's colour management", () => {
    const built = buildScene(REAL_DIR as string);
    applyColors(planAllSurfaces(built.manifest.surfaces, {}), built.index);
    const hexes = allMaterialHex(built.index);
    expect(Object.keys(hexes).length).toBe(401);
    for (const [sid, hex] of Object.entries(hexes))
      expect(hex, sid).toBe(built.manifestIndex.surfaces.get(sid)?.defaultColor.toLowerCase());
  });

  it("round-trips the wall frame for all 152 mesh-backed wall surfaces", () => {
    const built = buildScene(REAL_DIR as string);
    let checked = 0;
    for (const [sid, mesh] of built.index.surfaceMesh) {
      if (built.manifestIndex.surfaces.get(sid)?.kind !== "wall") continue;
      const frame = wallFrame(mesh);
      const local = frame.toLocal(frame.toWorld(0.37, 1.15, 0.02));
      expect(local.u, sid).toBeCloseTo(0.37, 6);
      expect(local.v, sid).toBeCloseTo(1.15, 6);
      expect(local.d, sid).toBeCloseTo(0.02, 6);
      expect(frame.uRange[1], sid).toBeGreaterThan(0);
      checked++;
    }
    // 154 wall surfaces exist; the two mesh-less garage bands are `kind: "wall"` as well
    expect(checked).toBe(152);
  });

  it("keeps the garage stack out of the house stack when exploded", () => {
    const built = buildScene(REAL_DIR as string);
    applyExplode(built.index, { enabled: true, gap: 2.5 });
    expect(worldY(built.index, "house-upper", "f-upper")).toBeCloseTo(2.5, 6);
    expect(worldY(built.index, "house-roof", "e-roof-house")).toBeCloseTo(5, 6);
    expect(worldY(built.index, "garage-shell", "f-garage")).toBeCloseTo(0, 6);
    expect(worldY(built.index, "garage-roof", "e-roof-garage")).toBeCloseTo(2.5, 6);
  });

  it("assigns a clip group to every surface", () => {
    const built = buildScene(REAL_DIR as string);
    for (const sid of built.manifestIndex.surfaces.keys())
      expect(typeof clipGroupOf(built.manifestIndex, sid), sid).toBe("string");
    expect(built.index.clipGroupOf.size).toBe(403);
  });
});
