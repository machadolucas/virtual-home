import { Box3, Matrix4, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fitPresets } from "@/house/model/fitProposal";
import type { Furnishing, Room, Vec3 } from "@/house/model/types";
import type { HouseRuntime } from "@/house/runtime";
import { assessFit, fitOpening, type FitObject, type FitWall } from "@/house/xr/fitGeometry";
import { FitPlanner } from "@/house/xr/fitPlanner";
import { FIXTURE_DIR, loadManifest } from "./glb";

const room: Room = {
  ...loadManifest(FIXTURE_DIR).rooms[0]!,
  floorElevation: 0,
  ceilingHeight: 3,
  footprint: {
    outer: [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ],
    holes: [],
  },
};
const pose = { x: 2, z: 2, yaw: 0 };
const part = (id: string, position: Vec3, widthM = 0.08, depthM = 0.08) => ({
  id,
  position,
  widthM,
  depthM,
  heightM: 0.5,
  rotationYDeg: 0,
});
const object = (kind: "equipment" | "furnishing", name: string, position: Vec3): FitObject => ({
  id: name,
  name,
  kind,
  parts: [part(name, position)],
});
function wallAt(z: number): FitWall {
  const vertices = [
    [1.7, 0, z],
    [2.3, 0, z],
    [2.3, 2, z],
    [1.7, 0, z],
    [2.3, 2, z],
    [1.7, 2, z],
  ].map(([x, y, z]) => new Vector3(x, y, z));
  return {
    id: "wall-face",
    name: "Partition",
    kind: "wall",
    bounds: new Box3().setFromPoints(vertices),
    vertices,
  };
}

describe("fit planner first contact", () => {
  it("locates the first angled obstruction on a modeled wall rather than its bounds", () => {
    const wall = wallAt(2.63);
    const later = object("equipment", "Far object", [1.82, 0.2, 2.78]);
    const test = assessFit(pose, fitPresets.Washer, room, [later], [wall]);
    expect(test.bodyClear).toBe(true);
    expect(test.openingClear).toBe(false);
    expect(test.openingLimit * 90).toBeGreaterThan(15);
    expect(test.openingLimit * 90).toBeLessThan(65);
    expect(test.openingContact?.obstacle).toBe(wall);
    const [x, y, z] = test.openingContact!.point;
    expect(z).toBeCloseTo(2.63, 6);
    expect(x).toBeGreaterThanOrEqual(1.7);
    expect(x).toBeLessThanOrEqual(2.3);
    expect(y).toBeGreaterThan(0.14);
    expect(y).toBeLessThan(0.73);
    const offsetWall = {
      ...wall,
      vertices: wall.vertices.map((v) => v.clone().setY(v.y + 1)),
      bounds: wall.bounds.clone().expandByScalar(2),
    };
    expect(assessFit(pose, fitPresets.Washer, room, [], [offsetWall]).openingClear).toBe(true);
  });

  it("ranks drawer contacts by travel and identifies the blocking equipment part", () => {
    const early = object("equipment", "Radiator bracket", [2.18, 0.5, 2.45]);
    const late = object("furnishing", "Cabinet leg", [2, 0.5, 2.69]);
    const test = assessFit(pose, fitPresets.Cabinet, room, [late, early]);
    expect(test.openingContact?.obstacle).toBe(early);
    expect(test.openingContact?.part).toBe(early.parts[0]);
    expect(test.openingContact?.point[2]).toBeCloseTo(2.41, 6);
    expect(test.openingLimit * fitPresets.Cabinet.reach).toBeCloseTo(0.12, 2);
  });

  it("labels the obstacle limiting the clearance and identifies the specific floor-opening edge", () => {
    const cabinet = object("furnishing", "Bench leg", [2.2, 0.1, 3.5]);
    const test = assessFit(pose, fitPresets.Cabinet, room, [cabinet]);
    expect(test.openingClear).toBe(true);
    expect(test.clearanceContact?.obstacle).toBe(cabinet);
    expect(test.gap).toBeCloseTo(0.71, 2);
    const withHole: Room = {
      ...room,
      footprint: {
        ...room.footprint,
        holes: [
          [
            [2.2, 1.8],
            [2.4, 1.8],
            [2.4, 2.05],
            [2.2, 2.05],
          ],
        ],
      },
    };
    const body = assessFit(pose, fitPresets.Washer, withHole, []);
    expect(body.bodyContact?.obstacle).toMatchObject({ kind: "edge", name: "Floor opening edge" });
    expect(body.bodyContact?.point[1]).toBe(0);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows the modeled blocker and clamps both headset preview controls, including on tracking loss", async () => {
    const furniture: Furnishing = {
      id: "cabinet",
      name: "Utility cabinet",
      kind: "cabinet",
      modelId: "synthetic",
      floorId: room.floorId,
      roomId: room.id,
      position: [2.17, 0, 2.6],
      rotationYDeg: 0,
      widthM: 0.08,
      depthM: 0.08,
      heightM: 0.9,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            Response.json(url.endsWith("/furnishings") ? { furnishings: [furniture] } : { proposals: [] }),
          ),
        ),
    );
    const runtime = {
      base: "/fixture",
      index: null,
      store: { getState: () => ({ placements: [] }) },
    } as unknown as HouseRuntime;
    const fit = new FitPlanner(
      runtime,
      room,
      () => {},
      () => {},
    );
    const matrix = new Matrix4().makeTranslation(3, 1, 0);
    fit.transform(matrix, 0);
    await vi.waitFor(() =>
      expect(fit.menu(() => {}).lines.join(" ")).toMatch(/Stops at [\d.]+° · Utility cabinet/),
    );
    const row = (id: string) => fit.menu(() => {}).rows.find((entry) => entry.id === id)!;
    const limit = row("opening").value!;
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(1);
    const marker = fit.group.getObjectByName("vh-fit-first-contact")!;
    const obstacle = fit.group.getObjectByName("vh-fit-obstacle")!;
    const leaf = fit.group.getObjectByName("vh-fit-opening")!;
    expect(marker.visible).toBe(true);
    expect(obstacle.children.length).toBeGreaterThan(0);
    expect(marker.getWorldPosition(new Vector3()).x - marker.position.x).toBeCloseTo(3);
    row("opening").act?.(0);
    row("opening").act?.(1);
    expect(row("opening").value).toBeCloseTo(limit);
    const expected = fitOpening(pose, fitPresets.Washer, 0, limit);
    expect(leaf.position.x).toBeCloseTo(expected.position[0]);
    expect(leaf.rotation.y).toBeCloseTo((expected.rotationYDeg * Math.PI) / 180);
    row("play-opening").act?.(0);
    fit.transform(matrix, 20);
    fit.transform(matrix, 200);
    expect(row("opening").value).toBeLessThan(limit);
    fit.transform(matrix, 2000);
    expect(row("opening").value).toBeCloseTo(limit);
    row("play-opening").act?.(0);
    fit.transform(matrix, 2020);
    fit.transform(null, 2030);
    expect(fit.group.visible).toBe(false);
    fit.transform(matrix, 3000);
    expect(row("opening").value).toBe(0);
    fit.dispose();
  });
});
