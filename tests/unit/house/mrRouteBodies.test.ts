import { Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Ray, Raycaster, Vector3, type BufferGeometry, type WebGLRenderer } from "three";
import { expect, it } from "vitest";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import type { Route, Vec3 } from "@/house/model/types";
import { buildMixedRealityOverlay } from "@/house/xr/mixedOverlay";
import { matchDuctOutlet } from "@/house/scene/ductOutlets";
import type { WallPatch } from "@/house/xr/wallPatch";
import { FIXTURE_DIR, loadManifest } from "./glb";
import { buildScene } from "./sceneFromGlb";

const manifest = buildManifestIndex(loadManifest(FIXTURE_DIR));
const floorId = "f-lower", place = { floorId, roomId: null };
const ducts = (points: Vec3[], props: Partial<Route> = {}): Route => ({
  id: "test-run", name: "Test supply", modelId: manifest.modelId, kind: "duct", system: "ventilation",
  lifecycle: "installed", flowState: "active", medium: "supply_air", certainty: "inferred",
  points, segments: points.slice(1).map(() => place), endpoints: [], photoIds: [], ...props,
});
type Body = Mesh<BufferGeometry, MeshStandardMaterial>;
const bodies = (overlay: ReturnType<typeof buildMixedRealityOverlay>) =>
  overlay.group.getObjectsByProperty("isMesh", true) as Body[];
const patch: WallPatch = { hit: [1, 1, .4], origin: [.6, .5, .1], along: [1,0,0], behind: [0,0,1],
  widthM: .8, heightM: 1, depthM: .8 };

it("keeps a documented diameter and a continuous opaque surface along long estimated runs without per-metre geometry", () => {
  const run = ducts([[0, 0, 0], [9, 0, 0]], { diameterM: .16 });
  const overlay = buildMixedRealityOverlay(manifest, [run], floorId);
  const [body] = bodies(overlay);
  expect(body!.material).toBeInstanceOf(MeshStandardMaterial);
  expect(body!.material.transparent).toBe(false);
  expect(body!.material.depthWrite).toBe(true);
  expect(body!.geometry.boundingBox!.getSize(new Vector3()).toArray()).toEqual([
    expect.closeTo(9), expect.closeTo(.16), expect.closeTo(.16)]);
  const triangles = body!.geometry.index!.count / 3;
  expect(triangles).toBeLessThan(60);
  for (const x of [.01, .18, .26, .9, 4.39, 8.99]) {
    const hits: import("three").Intersection[] = [];
    Mesh.prototype.raycast.call(body, new Raycaster(new Vector3(x, 1, 0), new Vector3(0,-1,0)), hits);
    expect(hits[0]?.point.y).toBeCloseTo(.08);
  }
  const shader = { uniforms: {}, vertexShader: "#include <begin_vertex>", fragmentShader: "#include <color_fragment>" } as
    Parameters<MeshStandardMaterial["onBeforeCompile"]>[0];
  body!.material.onBeforeCompile(shader, {} as WebGLRenderer);
  expect(shader.fragmentShader).toContain("vhMark");
  expect(shader.fragmentShader).not.toContain("discard");
  expect(body!.geometry.hasAttribute("vhRouteDistance")).toBe(false);
  const material = body!.material;
  overlay.applyTransform(new Matrix4());
  expect(overlay.pick(new Ray(new Vector3(4, .07, -1), new Vector3(0,0,1)))).toMatchObject({
    approximate: true, sizeDetail: "Ø160 mm recorded",
  });
  overlay.setRoutes([ducts([[0,0,0],[100,0,0]], { diameterM: .16, certainty: "measured" })]);
  const [known] = bodies(overlay);
  expect(known!.geometry.index!.count / 3).toBe(triangles);
  expect(known!.material.customProgramCacheKey()).not.toBe(material.customProgramCacheKey());
  expect(known!.geometry.hasAttribute("vhRouteMark")).toBe(false);
  overlay.dispose();
});

it("keeps the recorded rectangular width horizontal through a bend with a shared miter and schematic height", () => {
  const run = ducts([[0,1,0],[1,1,0],[1,1,1]], { widthM: .4, depthM: 1.4, flowDirection: "reverse", flowBasis: "declared" });
  const overlay = buildMixedRealityOverlay(manifest, [run], floorId);
  const [body] = bodies(overlay), geo = body!.geometry;
  overlay.applyTransform(new Matrix4());
  expect(overlay.pick(new Ray(new Vector3(.2, 1, -1), new Vector3(0,0,1)))?.sizeDetail)
    .toBe("Width 400 mm recorded · height 150 mm schematic");
  expect(geo.boundingBox!.max.y - geo.boundingBox!.min.y).toBeCloseTo(.15);
  const positions = geo.getAttribute("position"), mark = geo.getAttribute("vhRouteMark");
  expect(positions.count).toBe(48);
  const section = (from: number, off: number) => {
    const corners = new Set<string>();
    for (let i = from; i < from + 24; i++) {
      if (Math.abs(mark.getX(i) - off) > 1e-6) continue;
      corners.add(new Vector3().fromBufferAttribute(positions, i).toArray().map(n => n.toFixed(3)).join(","));
    }
    return corners;
  };
  expect(section(0,0)).toEqual(new Set(["0.000,0.925,0.200","0.000,1.075,0.200","0.000,0.925,-0.200","0.000,1.075,-0.200"]));
  expect(section(0,1.25).size).toBe(4);
  expect(section(0,1.25)).toEqual(section(24,1.25));
  expect(Math.min(...Array.from(geo.getAttribute("vhRouteDistance").array))).toBeLessThan(0);
  overlay.dispose();
});

it("carries a schematic diffuser into focus at a documented elbow that crosses its own ceiling", () => {
  const { index, manifestIndex } = buildScene(FIXTURE_DIR);
  const room = { floorId, roomId: "r-l-a" };
  const [sid] = manifestIndex.roomSurfaces.get(room.roomId)!.filter(id => manifestIndex.surfaces.get(id)?.kind === "ceiling");
  const surface = index.surfaceMesh.get(sid!)!;
  const original = surface.geometry;
  surface.geometry = new PlaneGeometry(1, 1).rotateX(Math.PI / 2).translate(2, 2, 2);
  const run = ducts([[1, 2.13, 2], [2, 2.13, 2], [2, 1.96, 2]], {
    segments: [room, room], pointPlaces: [room, room, room], pointKinds: ["junction", "vertex", "outlet"],
  });
  expect(matchDuctOutlet(index, run, 2, [run])).toBeNull();
  const overlay = buildMixedRealityOverlay(manifestIndex, [run], floorId, index);
  expect(bodies(overlay).some(m => m.userData.vhDuctOutlet?.schematic)).toBe(true);
  overlay.applyTransform(new Matrix4());
  expect(overlay.pick(new Ray(new Vector3(1.5, 2.13, 1), new Vector3(0,0,1)))?.sizeDetail)
    .toBe("Schematic diameter · Ø125 mm");
  overlay.toggleFocus(run.id);
  expect(overlay.group.getObjectByName("vh-mr-focused-route")!.getObjectByName("vh-duct-outlet-test-run-2")).toBeDefined();
  overlay.setWallPatch({ ...patch, origin: [1.5, 1.5, 1.7], widthM: .2 });
  expect(overlay.group.getObjectByName("vh-mr-wall-routes")!.getObjectByName("vh-duct-outlet-test-run-1")).toBeUndefined();
  surface.geometry.translate(0, .25, 0);
  expect(matchDuctOutlet(index, run, 2, [run], true)).toBeNull();
  surface.geometry.dispose();
  surface.geometry = original;
  overlay.dispose();
});

it("can pick the visible rim of an inline silencer", () => {
  const overlay = buildMixedRealityOverlay(manifest, [ducts([[0,0,0],[1,0,0]], { ductFitting: "silencer" })], floorId);
  overlay.applyTransform(new Matrix4());
  expect(overlay.pick(new Ray(new Vector3(.5, .125, -1), new Vector3(0,0,1)))?.sizeDetail).toContain("casing schematic");
  expect(overlay.pick(new Ray(new Vector3(.5, .14, -1), new Vector3(0,0,1)))).toBeNull();
  overlay.dispose();
});

it("preserves the full-run phase and bend within a wall clipping volume, including a separately focused trace", () => {
  const run = ducts([[0,1,.4],[1,1,.4],[1,1,1.4]], { widthM: .2, flowDirection: "forward", flowBasis: "declared" });
  const overlay = buildMixedRealityOverlay(manifest, [run], floorId);
  overlay.applyTransform(new Matrix4()); overlay.setWallPatch(patch);
  expect(overlay.patchRoutes).toHaveLength(1);
  expect(overlay.patchRoutes[0]!.points).toEqual([[.6,1,.4],[1,1,.4],[1,1,.9]]);
  const check = (name: string) => {
    const group = overlay.group.getObjectByName(name)!;
    const body = group.getObjectsByProperty("isMesh", true)[0] as Body;
    expect(body.userData.vhRouteSpanCount).toBe(2);
    const marks = body.geometry.getAttribute("vhRouteMark").array, flow = body.geometry.getAttribute("vhRouteDistance").array;
    expect(Math.min(...Array.from(marks))).toBeCloseTo(.6 / .8);
    expect(Math.max(...Array.from(flow))).toBeCloseTo(1.5 / .85);
  };
  check("vh-mr-wall-routes");
  expect(overlay.toggleFocus(run.id)).toBe(run.id);
  check("vh-mr-focused-route");
  overlay.applyTransform(null);
  expect(overlay.group.visible).toBe(false);
  expect(overlay.tick(.02, true, {supply:1, extract:1})).toBe(false);
  overlay.dispose();
});
