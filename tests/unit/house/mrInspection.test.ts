import { BufferGeometry, Float32BufferAttribute, Group, Matrix4, Mesh, MeshBasicMaterial, Ray, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import type { Furnishing, Room, Route, Vec3 } from "@/house/model/types";
import { createSceneIndex } from "@/house/scene/SceneIndex";
import { buildMixedRealityOverlay } from "@/house/xr/mixedOverlay";
import { modelSurveyFaces, suggestSurveyDiscrepancies, type ModelFace } from "@/house/xr/surveyDiscrepancies";
import { readInstallationPhoto, WallInspector } from "@/house/xr/wallInspector";
import { clipWallRoutes, pickWallPatch, wallCrossings } from "@/house/xr/wallPatch";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = buildManifestIndex(loadManifest(FIXTURE_DIR));
const room = { ...manifest.rooms.get("r-l-a"), id: "r-l-a", floorId: "f-lower", floorElevation: 0, ceilingHeight: 3,
  footprint: { outer: [[0, 0], [4, 0], [4, 4], [0, 4]] } } as Room;
const walls = [{ a: [0, 0] as [number, number], b: [4, 0] as [number, number], low: 0, high: 3 }];
const place = { floorId: room.floorId, roomId: room.id };
const ray = new Ray(new Vector3(2, 1.5, 1), new Vector3(0, 0, -1));
const route = (id: string, points: Vec3[], kind: Route["kind"]): Route => ({
  id, modelId: manifest.modelId, name: id, kind, points, segments: points.slice(1).map(() => place),
  system: kind === "duct" ? "ventilation" : "water", lifecycle: "installed", flowState: "active", certainty: "inferred",
  endpoints: [], photoIds: [],
});

describe("localized mixed reality wall inspection", () => {
  const lower = route("lower", [[1, 1.1, -0.4], [3, 1.5, -0.4]], "duct");
  const upper = route("upper", [[2, 1.4, 0.1], [2, 1.7, -0.9]], "pipe");
  const outside = route("outside", [[1, 1.4, 0.1], [3, 1.4, 0.1]], "pipe");
  const far = route("far", [[1, 1.4, -1], [3, 1.4, -1]], "pipe");

  it("clips a calibrated wall volume and interpolates true vertical separation at the plan crossing", () => {
    const matrix = new Matrix4().makeRotationY(0.4).setPosition(2, -0.5, -1);
    const patch = pickWallPatch(room, walls, ray.clone().applyMatrix4(matrix), matrix)!;
    expect(patch.hit[0]).toBeCloseTo(2);
    expect(new Vector3(...patch.behind).distanceTo(new Vector3(0, 0, -1))).toBeCloseTo(0);
    const runs = clipWallRoutes([lower, upper, outside, far], patch);
    expect(runs.map(({ id }) => id)).toEqual(["lower", "upper"]);
    expect(runs[0]?.points[0]?.[0]).toBeCloseTo(1.55);
    const [pass] = wallCrossings(runs);
    expect(pass?.upper.id).toBe("upper");
    expect(pass?.lower.id).toBe("lower");
    expect(pass?.upperPoint[1]).toBeCloseTo(1.55);
    expect(pass?.lowerPoint[1]).toBeCloseTo(1.3);
    expect(pass?.separationM).toBeCloseTo(0.25);
    expect(pickWallPatch(room, walls, new Ray(new Vector3(2, 1.5, -1), new Vector3(0, 0, 1)), new Matrix4())).toBeNull();
  });

  it("reveals both systems within the patch and restores the previous room-wide filter", () => {
    const overlay = buildMixedRealityOverlay(manifest, [lower, upper, outside], room.floorId);
    overlay.applyTransform(new Matrix4());
    overlay.setFilter("pipes");
    expect(overlay.count).toBe(2);
    overlay.setWallPatch(pickWallPatch(room, walls, ray, new Matrix4()));
    expect(overlay.patchRoutes.map(({ id }) => id)).toEqual(["lower", "upper"]);
    expect(overlay.toggleFocus("lower")).toBe("lower");
    expect(overlay.count).toBe(1);
    expect(overlay.toggleFocus("lower")).toBeNull();
    overlay.setWallPatch(null);
    expect(overlay.count).toBe(2);
    expect(overlay.toggleFocus("lower")).toBeNull();
    overlay.dispose();
  });

  it("renders a short numeric crossing summary, with exact run names and independent certainty on demand", () => {
    const source = { ...lower, medium: "supply_air" as const, name: "Supply · synthetic longer name", photoIds: ["first", "second"] };
    const extract = { ...upper, kind: "duct" as const, medium: "extract_air" as const, name: "Extract · synthetic longer name" };
    const overlay = buildMixedRealityOverlay(manifest, [source, extract], room.floorId);
    const inspector = new WallInspector(room, walls, overlay);
    const matrix = new Matrix4();
    overlay.applyTransform(matrix);
    inspector.start();
    inspector.confirm(ray, matrix);
    inspector.frame(matrix);
    const menu = inspector.menu(0.034, () => {});
    expect(menu.lines).toContain("Room alignment 3.4 cm");
    expect(menu.rows.find(({ id }) => id === "trace-lower")?.detail).toBe("Inferred · approximate path");
    expect(menu.rows.filter(({ id }) => id?.startsWith("photo-lower")).map(({ label }) => label)).toEqual([
      `Photo 1 of 2 · ${source.name}`, `Photo 2 of 2 · ${source.name}`,
    ]);
    const crossing = menu.rows.find(({ id }) => id === "crossing-0");
    expect(crossing?.label).toBe("25 cm · Supply below Extract");
    crossing?.act?.(0);
    expect(inspector.menu(0.034, () => {}).lines).toEqual([
      "25 cm vertical separation in the model",
      `Above · ${extract.name}`, "155 cm above room floor · Inferred · approximate path",
      `Below · ${source.name}`, "130 cm above room floor · Inferred · approximate path",
      "Room alignment 3.4 cm",
    ]);
    inspector.frame(null);
    expect(inspector.active).toBe(false);
    expect(inspector.group.visible).toBe(false);
    inspector.dispose();
    overlay.dispose();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads a linked photo only through the authenticated image derivative and retries a smaller preview", async () => {
    const bitmap = { close: vi.fn() };
    const create = vi.fn().mockResolvedValue(bitmap);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(new Response(new Blob(["raster"], { type: "image/webp" })));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("createImageBitmap", create);
    const { signal } = new AbortController();
    await expect(readInstallationPhoto("fixture/id", signal)).resolves.toBe(bitmap);
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/attachments/fixture%2Fid?v=web",
      { credentials: "same-origin", redirect: "error", cache: "no-store", signal });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/attachments/fixture%2Fid?v=thumb", expect.objectContaining({ signal }));
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("scan-to-model review", () => {
  const wall = (z: number): Vec3[] => [[0.3, 0, z], [3.7, 0, z], [3.7, 2.5, z], [0.3, 2.5, z]];
  const model = (id: string, z: number): ModelFace => ({
    id, kind: "wall", label: "Synthetic wall", points: wall(z).map((point) => new Vector3(...point)),
    normal: new Vector3(0, 0, 1), source: -1,
  });

  it("reports an independently visible surface with both original outlines and capture uncertainty", () => {
    const scan = { surfaces: [{ source: "plane" as const, label: "wall", points: wall(0.18) }], measurements: [] };
    const [proposal] = suggestSurveyDiscrepancies(scan, room, [model("wall-a", 0)], [], 0.03);
    expect(proposal?.comparison).toMatchObject({ target: { kind: "surface", id: "wall-a" }, sourceSurface: 0,
      scanOutline: expect.arrayContaining(wall(0.18)), modelOutline: expect.arrayContaining(wall(0)), scanUncertaintyM: 0.02 });
    expect(proposal?.comparison.offsetM).toBeCloseTo(0.18);
    expect(suggestSurveyDiscrepancies(scan, room, [model("wall-a", 0), model("wall-b", 0.03)], [], 0.03)).toEqual([]);
    expect(suggestSurveyDiscrepancies(scan, room, [model("wall-a", 0.16), model("wall-b", 0)], [], 0.03)).toEqual([]);
    expect(suggestSurveyDiscrepancies(scan, room, [model("wall-a", 0.11)], [], 0.04)).toEqual([]);
  });

  it("uses raw triangle indices for unlabeled sensed walls and semantic evidence for an object's footprint", () => {
    const furniture: Furnishing = { id: "table", modelId: manifest.modelId, kind: "dining_table", name: "Synthetic table",
      position: [2, 0, 2], rotationYDeg: 0, widthM: 1.2, depthM: 0.8, heightM: 0.75, ...place };
    const scan = { surfaces: [
      { source: "mesh" as const, points: wall(0.18), indices: [0, 1, 2, 0, 2, 3] },
      { source: "plane" as const, label: "table", points: [[1.6, 0.75, 1.6], [2.8, 0.75, 1.6],
        [2.8, 0.75, 2.4], [1.6, 0.75, 2.4]] as Vec3[] },
    ], measurements: [] };
    const proposals = suggestSurveyDiscrepancies(scan, room, [model("wall", 0)], [furniture], 0.01);
    expect(proposals).toHaveLength(2);
    const table = proposals.find(({ comparison }) => comparison.target.kind === "furnishing");
    expect(table?.comparison.sourceSurface).toBe(1);
    expect(table?.comparison.offsetM).toBeCloseTo(0.2);
    expect(table?.comparison.scanUncertaintyM).toBeCloseTo(0.035);
  });

  it("compares authored model planes in their physical parent transform", () => {
    const index = createSceneIndex(manifest);
    const id = manifest.roomSurfaces.get(room.id)?.find((key) => manifest.surfaces.get(key)?.kind === "wall");
    if (!id) throw new Error("Missing fixture wall");
    const root = new Group();
    const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(wall(0).flat(), 3));
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.position.set(0, 0, 0.2);
    root.position.set(0, 0, 0.3);
    root.add(mesh);
    index.surfaceMesh.set(id, mesh);
    const [face] = modelSurveyFaces(index, room.id, { enabled: false, gap: 0 });
    expect(face?.id).toBe(id);
    expect(face?.points[0]?.z).toBeCloseTo(0.5);
    geometry.dispose();
    mesh.material.dispose();
  });
});
