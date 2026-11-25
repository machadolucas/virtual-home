import * as THREE from "three";
import { expect, it } from "vitest";
import type { Route } from "@/house/model/types";
import { matchDuctOutlet } from "@/house/scene/ductOutlets";
import { RouteLayer } from "@/house/scene/routes";
import { FIXTURE_DIR } from "./glb";
import { buildScene } from "./sceneFromGlb";

const room = { floorId: "f-lower", roomId: "r-l-a" };
const wallId = "s-w-l-ab--r-l-a";

function duct(id: string, points: Route["points"], pointKinds?: Route["pointKinds"]): Route {
  return {
    id, modelId: "fixture-house", name: id, system: "ventilation", kind: "duct",
    points, pointKinds, pointPlaces: points.map(() => room), segments: points.slice(1).map(() => room),
    certainty: "measured", lifecycle: "installed", medium: "supply_air",
    flowState: "active", flowDirection: "forward", flowBasis: "inferred",
    diameterM: 0.125, endpoints: [{ kind: "free" }, { kind: "free" }], photoIds: [],
  };
}

it("mounts a static grille on the actual finished wall while preserving floor grouping and flow", () => {
  const { index, clip } = buildScene(FIXTURE_DIR);
  const face = index.surfaceMesh.get(wallId)!;
  // This synthetic contact plane is 4 mm behind the recorded endpoint and translated with its floor.
  const originalGeometry = face.geometry;
  face.geometry = new THREE.PlaneGeometry(1, 1).rotateY(-Math.PI / 2).translate(3.004, 1.5, 2);
  const floor = index.floorNodes.get(room.floorId)![0]!;
  floor.position.y = 0.5;
  const route = duct("flush", [[3.08, 1.5, 2], [3, 1.5, 2]], ["junction", "outlet"]);
  const matched = matchDuctOutlet(index, route, 1, [route])!;
  expect(matched.surfaceId).toBe(wallId);
  expect(matched.contact.x).toBeCloseTo(3.004, 6);
  expect(matched.contact.y).toBeCloseTo(1.5);
  expect(matched.roomNormal.x).toBeCloseTo(-1);
  expect(matchDuctOutlet(index, { ...route, flowState: "inactive" }, 1, [])).toBeNull();
  expect(matchDuctOutlet(index, { ...route, airStream: "outdoor_intake" }, 1, [])).toBeNull();
  expect(matchDuctOutlet(index, { ...route, points: [[3.08, 1.5, 2.02], [3, 1.5, 2]] }, 1, [])).toBeNull();
  const layer = new RouteLayer(index, clip);
  layer.set([route], { tubes: true });
  const overlay = index.overlay.floorGroups.get(room.floorId)!;
  const marker = overlay.getObjectByName("vh-duct-outlet-flush-1") as THREE.Mesh;
  expect(marker.geometry.getAttribute("color")).toBeDefined();
  expect(marker.geometry.getAttribute("vhRouteDistance")).toBeUndefined();
  const material = marker.material as THREE.MeshStandardMaterial;
  expect(material.clippingPlanes).toEqual(clip.planesFor(wallId));
  const bounds = new THREE.Box3().setFromObject(marker);
  expect(3.004 - bounds.max.x).toBeCloseTo(0.007, 6);
  expect(3.004 - bounds.min.x).toBeCloseTo(0.0086, 6);
  expect(new THREE.Raycaster(new THREE.Vector3(2, 1.5, 2), new THREE.Vector3(1, 0, 0))
    .intersectObject(marker)).toHaveLength(0);
  expect(overlay.children.filter((child) => child.name.startsWith("vh-tube-"))).toHaveLength(1);
  expect(layer.tick(1 / 60, true)).toBe(true);
  layer.set([route], { tubes: false });
  expect(overlay.getObjectByName(marker.name)).toBeUndefined();
  layer.dispose();
  face.geometry.dispose();
  face.geometry = originalGeometry;
});

it("requires a short down-facing outlet with a same-floor, same-medium horizontal through-run", () => {
  const { index, clip } = buildScene(FIXTURE_DIR);
  const branch = duct("vertical", [[2, 1.6, 2], [2, 1.8, 2]], ["outlet", "junction"]);
  const through = duct("through", [[1.7, 1.8, 2], [2.3, 1.8, 2]]);
  const left = duct("left", [[1.7, 1.8, 2], [2, 1.8, 2]]);
  const right = duct("right", [[2, 1.8, 2], [2.3, 1.8, 2]]);
  const corner = duct("corner", [[2, 1.8, 2], [2, 1.8, 2.3]]);
  expect(matchDuctOutlet(index, branch, 0, [branch, through])?.roomNormal.toArray()).toEqual([0, -1, 0]);
  expect(matchDuctOutlet(index, branch, 0, [branch, left, right])?.surfaceId).toBeUndefined();
  expect(matchDuctOutlet(index, branch, 0, [branch, left, right])).not.toBeNull();

  for (const supports of [
    [],
    [left],
    [left, corner],
    [{ ...through, medium: "extract_air" } satisfies Route],
    [{ ...through, segments: [{ ...room, floorId: "f-upper" }] }],
    [{ ...through, flowState: "inactive" } satisfies Route],
  ]) {
    expect(matchDuctOutlet(index, branch, 0, [branch, ...supports])).toBeNull();
  }
  const unsupported = [
    duct("long", [[2, 1.3, 2], [2, 1.8, 2]], ["outlet", "junction"]),
    duct("up", [[2, 2, 2], [2, 1.8, 2]], ["outlet", "junction"]),
    duct("unmarked", branch.points, ["vertex", "junction"]),
  ];
  for (const route of unsupported) expect(matchDuctOutlet(index, route, 0, [route, through])).toBeNull();

  const layer = new RouteLayer(index, clip);
  layer.set([branch, through, ...unsupported], { tubes: true });
  const marker = index.overlay.floorGroups.get(room.floorId)!
    .getObjectByName("vh-duct-outlet-vertical-0") as THREE.Mesh;
  const bounds = new THREE.Box3().setFromObject(marker);
  expect(1.6 - bounds.max.y).toBeCloseTo(.007, 6);
  expect(1.6 - bounds.min.y).toBeCloseTo(.0086, 6);
  expect((marker.material as THREE.Material).clippingPlanes).toBe(clip.ensure(room.floorId));
  layer.dispose();
});

it("advances the two air circuits independently without restarting phase or changing pipe motion", () => {
  const { index, clip } = buildScene(FIXTURE_DIR);
  const layer = new RouteLayer(index, clip);
  const supply = duct("supply", [[2, 1.8, 2], [2.3, 1.8, 2]]);
  const intake = { ...supply, id: "intake", airStream: "outdoor_intake" } satisfies Route;
  const extract = { ...supply, id: "extract", medium: "extract_air" } satisfies Route;
  const exhaust = { ...extract, id: "exhaust", airStream: "outdoor_discharge" } satisfies Route;
  const pipe = { ...supply, id: "pipe", system: "water", kind: "pipe", medium: "cold_water" } satisfies Route;
  layer.set([supply, intake, extract, exhaust, pipe], { tubes: true });

  const meshes = index.overlay.floorGroups.get(room.floorId)!.children.filter((child) =>
    child.name.startsWith("vh-tube-")) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[];
  const uniforms = (stream?: string) => {
    const mesh = meshes.find((mesh) => mesh.userData.vhAirStream === stream)!;
    const shader = { uniforms: {}, vertexShader: "", fragmentShader: "" } as Parameters<typeof mesh.material.onBeforeCompile>[0];
    mesh.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader.uniforms;
  };
  const [inletUniforms, supplyUniforms, extractUniforms, exhaustUniforms, pipeUniforms] = [
    "outdoor_intake", "room_supply", "room_extract", "outdoor_discharge", undefined,
  ].map(uniforms);
  expect(inletUniforms?.vhRoutePhase).toBe(supplyUniforms?.vhRoutePhase);
  expect(exhaustUniforms?.vhRoutePhase).toBe(extractUniforms?.vhRoutePhase);

  expect(layer.tick(0.025, true, { supply: 0.4, extract: 0.8 })).toBe(true);
  expect(supplyUniforms?.vhRoutePhase?.value).toBeCloseTo(0.01);
  expect(extractUniforms?.vhRoutePhase?.value).toBeCloseTo(0.02);
  expect(pipeUniforms?.vhRoutePhase?.value).toBeCloseTo(0.0125);
  layer.tick(0.025, true, { supply: 1, extract: 0 });
  expect(supplyUniforms?.vhRoutePhase?.value).toBeCloseTo(0.035);
  expect(extractUniforms?.vhRoutePhase?.value).toBeCloseTo(0.02);
  expect(extractUniforms?.vhRouteMotion?.value).toBe(0);
  expect(pipeUniforms?.vhRoutePhase?.value).toBeCloseTo(0.025);
  expect(layer.tick(0.05, false, { supply: 1, extract: 1 })).toBe(false);
  expect(supplyUniforms?.vhRouteMotion?.value).toBe(0);
  expect(pipeUniforms?.vhRoutePhase?.value).toBeCloseTo(0.025);
  expect(meshes[0]?.parent?.children).toContain(meshes[0]);
  layer.dispose();
});
