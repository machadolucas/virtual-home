import { Matrix4, Ray, Vector3 } from "three";
import { expect, it } from "vitest";
import { classifyStructuralHit, furnitureBeforePoint, intersectAlignmentEvidence, readAlignmentEvidence } from "@/house/xr/roomAlignmentEvidence";

type Point = [number, number, number];
const eye = new Vector3(2, 1.5, 2);
const ray = new Ray(eye, new Vector3(0, 0, -1));

it("blocks a manually projected point behind a shelf while leaving a point in front reachable", () => {
  const evidence = read([plane("shelf", vertical(.6))]);
  expect(furnitureBeforePoint(evidence, ray, new Vector3(2, 1.5, 0))).toBe(true);
  expect(furnitureBeforePoint(evidence, ray, new Vector3(2, 1.5, .6))).toBe(true);
  expect(furnitureBeforePoint(evidence, ray, new Vector3(2, 1.5, 1))).toBe(false);
});
function vertical(z: number, low = 0, high = 2.65, left = 0, right = 4): Point[] {
  return [[left, low, z], [right, low, z], [right, high, z], [left, high, z]];
}
function horizontal(y: number, front = 0): Point[] {
  return [[0, y, front], [4, y, front], [4, y, 3], [0, y, 3]];
}
function plane(semanticLabel: string, vertices: Point[]) {
  return { semanticLabel, planeSpace: {}, polygon: vertices.map(([x, y, z]) => ({ x, y, z })) };
}
function mesh(semanticLabel: string, vertices: Point[], indices = [0, 1, 2, 0, 2, 3]) {
  return { semanticLabel, meshSpace: {}, vertices: new Float32Array(vertices.flat()), indices: new Uint32Array(indices) };
}
function read(planes: ReturnType<typeof plane>[], meshes: ReturnType<typeof mesh>[] = []) {
  return readAlignmentEvidence({ detectedPlanes: new Set(planes), detectedMeshes: new Set(meshes),
    getPose: () => ({ transform: { matrix: new Matrix4().toArray() } }) } as unknown as XRFrame, {} as XRReferenceSpace, eye);
}

it("rejects racks along a clipped floor, including unlabelled global mesh, while retaining ordinary surface depth", () => {
  const clipped = plane("floor", horizontal(0, .45));
  const evidence = read([clipped, plane("", vertical(.45)), plane("storage", vertical(.45))],
    [mesh("global_mesh", vertical(.45)), mesh("cabinet", vertical(.45))]);
  expect(evidence.floor?.semanticFloor).toBe(true);
  expect(evidence.walls).toEqual([]);
  expect(classifyStructuralHit(evidence, ray, new Vector3())).toBe("blocked");
  expect(intersectAlignmentEvidence(evidence, ray, new Vector3())?.z).toBeCloseTo(.45);
  expect(read([clipped, plane("ceiling", horizontal(2.65)), plane("", vertical(.45))]).walls).toEqual([]);
  const unknown = read([clipped, plane("", vertical(.45))], [mesh("room-mesh", vertical(.45))]);
  expect(classifyStructuralHit(unknown, ray, new Vector3())).toBe("unverified");
});

it("requires independently agreeing structural boundaries and full height before promoting a generic mesh wall", () => {
  const floor = plane("floor", horizontal(0)), ceiling = plane("ceiling", horizontal(2.65));
  const ends = [0, 4].map(x => plane("wall", [[x, 0, 0], [x, 0, 3], [x, 2.65, 3], [x, 2.65, 0]]));
  const boundaries = [floor, ceiling, ...ends];
  const evidence = read([...boundaries, plane("", vertical(.45))], [mesh("room-mesh", vertical(0))]);
  expect(evidence.walls).toHaveLength(3);
  expect(evidence.walls.find(w => !w.semanticWall)?.a[1]).toBeCloseTo(0);
  expect(classifyStructuralHit(evidence, ray, new Vector3())).toBe("blocked");
  const target = new Vector3();
  expect(classifyStructuralHit(read(boundaries, [mesh("", vertical(0))]), ray, target)).toBe("matched");
  expect(target.z).toBeCloseTo(0);
  expect(read([floor, ceiling, plane("", vertical(0))]).walls).toEqual([]);
  expect(read([...boundaries, plane("", vertical(0, 0, 2.1))]).walls).toHaveLength(2);
  expect(read(boundaries, [mesh("other", vertical(0))]).walls).toHaveLength(2);
  expect(read([...boundaries, plane("invisible_wall_face", vertical(0))], [mesh("", vertical(0))]).walls).toHaveLength(2);
  expect(read(boundaries, [mesh("invisible_wall_face", vertical(0)), mesh("", vertical(0))]).walls).toHaveLength(2);
  expect(read([plane("floor", horizontal(0, .4)), plane("ceiling", horizontal(2.65, .4)), ...ends],
    [mesh("global mesh", vertical(.4))]).walls).toHaveLength(2);
});

it("retains observed height on elevated semantic walls and fails closed on foreground cabinets or conflicting native depth", () => {
  const wall = plane("wall_face", vertical(0, .85, 2.4));
  const evidence = read([wall], [mesh("wall", vertical(0, .85, 2.4))]);
  expect(evidence.walls).toHaveLength(1);
  expect(evidence.walls[0]).toMatchObject({ low: .85, semanticWall: true });
  expect(evidence.walls[0]!.high).toBeCloseTo(2.4);
  const hit = new Vector3();
  expect(classifyStructuralHit(evidence, ray, hit)).toBe("matched");
  expect(hit.toArray()).toEqual([2, 1.5, 0]);
  expect(classifyStructuralHit(evidence, ray, hit, hit.set(2, 1.5, .4))).toBe("blocked");
  for (const object of [read([wall, plane("other-furniture", vertical(.04))]),
    read([wall], [mesh("shelf", vertical(.04))]), read([wall, plane("cabinet", vertical(0))])]) {
    expect(classifyStructuralHit(object, ray, hit)).toBe("blocked");
  }
});

it("keeps omitted furniture faces occluding a semantic wall under a saturated mesh budget", () => {
  const back = vertical(0, .85, 2.4);
  const dense: number[] = [];
  for (let i = 0; i < 1_101; i++) dense.push(0, 1, 2);
  const evidence = read([plane("wall", back)], [mesh("global_mesh", back, dense), mesh("shelf", vertical(.35))]);
  expect(evidence.partialObjects).toHaveLength(1);
  expect(classifyStructuralHit(evidence, ray, new Vector3())).toBe("blocked");
});

it("uses only matching semantic openings for depth and retains their measured centers before wall projection", () => {
  const wall = plane("wall", vertical(0));
  const door = plane("door_frame", vertical(.09, 0, 2.1, 1.5, 2.5));
  const evidence = read([wall, door]);
  expect(evidence.landmarks[0]).toMatchObject({ kind: "door", center: [2, 1.05, 0], rawCenter: [2, 1.05, .09], axis: [1, 0] });
  const hit = new Vector3();
  expect(classifyStructuralHit(evidence, ray, hit, null, "door")).toBe("matched");
  expect(hit.z).toBeCloseTo(.09);
  expect(classifyStructuralHit(evidence, ray, hit, null, "window")).toBe("blocked");
  expect(classifyStructuralHit(evidence, ray, hit)).toBe("blocked");
  expect(classifyStructuralHit(read([door], [mesh("storage", vertical(.5))]), ray, hit, null, "door")).toBe("blocked");
  expect(classifyStructuralHit(read([], [mesh("window_frame", vertical(.25, 1, 2, 1.5, 2.5))]), ray, hit, null, "window")).toBe("matched");
  expect(classifyStructuralHit(read([]), ray, hit, new Vector3(2, 1.5, .4), "door")).toBe("unverified");
});
