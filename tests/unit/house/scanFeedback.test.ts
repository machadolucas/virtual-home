import { InstancedMesh, Matrix4, Vector3 } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { ScanFeedback } from "@/house/xr/scanFeedback";
import { readAlignmentEvidence } from "@/house/xr/roomAlignmentEvidence";
import { buildAlignmentModel, checkAnchoredCorner, matchRoomAlignment } from "@/house/xr/roomAlignment";
import { RoomDiscovery } from "@/house/xr/roomDiscovery";
import { calibrationFeatures } from "@/house/xr/mixedCalibration";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = loadManifest(FIXTURE_DIR);
const room = { ...manifest.rooms[0]!, floorElevation: 4, ceilingHeight: 2.6,
  footprint: { outer: [[0,0], [4,0], [4,3], [0,3]] as [number, number][], holes: [] } };
const model = buildAlignmentModel(room, calibrationFeatures({ ...manifest, rooms: [room] }, room.floorId, room.id));
const identity = new Matrix4().toArray();
const viewer = new Vector3(2, 1.4, 1.3);
function scan(y: number, label = "floor", tracked = true, polygon = room.footprint.outer) {
  const xy = ([x,z]: [number, number], height: number) => ({ x, y: height, z });
  const planes = [{ planeSpace: {}, semanticLabel: label, polygon: polygon.map(p => xy(p, y)) },
    ...polygon.map((a, i) => {
      const b = polygon[(i + 1) % polygon.length]!;
      return { planeSpace: {}, semanticLabel: "wall",
        polygon: [xy(a,y),xy(b,y),xy(b,y+2.6),xy(a,y+2.6)] };
    })];
  return readAlignmentEvidence({ detectedPlanes: new Set(planes),
    getPose: () => ({ emulatedPosition: !tracked, transform: { matrix: identity } }) } as unknown as XRFrame,
    {} as XRReferenceSpace, viewer);
}

afterEach(() => vi.unstubAllGlobals());

it("recognizes and checks a labeled split-level floor below local zero, while rejecting an inferred platform", () => {
  const y = -.34;
  const evidence = scan(y);
  expect(evidence.floor).toMatchObject({y, semanticFloor: true});
  expect(scan(y, "").floor).toBeNull();
  expect(scan(y, "table").floor).toBeNull();
  expect(scan(-1.3).floor).toBeNull();
  const candidates = matchRoomAlignment(model, evidence, viewer);
  expect(candidates.length).toBeGreaterThan(0);
  const pose = new Matrix4().makeTranslation(0, y - room.floorElevation, 0);
  expect(checkAnchoredCorner(model, evidence, viewer, pose)?.errorM).toBeLessThan(.001);
  const discovery = new RoomDiscovery([room], () => model);
  discovery.submit(evidence, viewer, 100);
  expect(discovery.step(viewer).phase).toBe("confirming");
  discovery.submit(scan(y), viewer, 700);
  expect(discovery.step(viewer).match?.room.id).toBe(room.id);
});

it("recognizes small returns in a measured outline while requiring independent enclosure on full walls", () => {
  const outline: [number, number][] = [[0,0], [4,0], [4,3], [2,3], [2,2.82], [0,2.82]];
  const insetRoom = { ...room, footprint: { outer: outline, holes: [] } };
  const inset = buildAlignmentModel(insetRoom, calibrationFeatures({ ...manifest, rooms: [insetRoom] }, room.floorId, room.id));
  const discovery = new RoomDiscovery([insetRoom], () => inset);
  const evidence = scan(0, "floor", true, outline);
  expect(evidence.walls).toHaveLength(5);
  discovery.submit(evidence, viewer, 10);
  expect(discovery.step(viewer).phase).toBe("confirming");
  const fresh = scan(0, "floor", true, outline);
  discovery.submit(fresh, viewer, 510);
  expect(discovery.step(viewer).match?.room.id).toBe(room.id);
  discovery.reset();
  fresh.walls = fresh.walls.slice(1);
  discovery.submit(fresh, viewer, 1100);
  expect(discovery.step(viewer).phase).not.toBe("confirming");
});

it("draws observed polygons in tracking space and explains empty, unavailable and stale scans", () => {
  const ctx = {fillRect: vi.fn(), fillText: vi.fn()};
  vi.stubGlobal("document", {createElement: () => ({getContext: () => ctx})});
  const feedback = new ScanFeedback();
  const pose = {emulatedPosition: false, transform: {position: viewer, orientation: {x:0,y:0,z:0,w:1}}} as unknown as XRViewerPose;
  const tick = (now: number, unavailable = false) => feedback.frame(pose, now, .014, unavailable, false, "Choose your room");
  const edges = feedback.group.getObjectByName("vh-measured-surfaces") as InstancedMesh;
  tick(10);
  expect(feedback.group.visible).toBe(true);
  expect(ctx.fillText.mock.calls.some(([text]) => text === "No room surfaces received")).toBe(true);
  expect(edges.visible).toBe(false);
  feedback.observe(scan(-.34), 100);
  tick(100);
  expect(feedback.summary(100, false)).toBe("Floor found · 4 walls");
  expect(edges.count).toBe(20);
  const edge = new Matrix4();
  edges.getMatrixAt(0, edge);
  expect(new Vector3().setFromMatrixPosition(edge).distanceTo(new Vector3(2,-.34,0))).toBeLessThan(1e-5);
  const draws = ctx.fillText.mock.calls.length;
  tick(120);
  expect(ctx.fillText.mock.calls.length).toBe(draws);
  tick(2000);
  expect(edges.visible).toBe(false);
  expect(feedback.summary(2000, false)).toBe("No room surfaces received");
  tick(4500,true);
  expect(feedback.summary(4500, true)).toBe("Room scan access unavailable");
  feedback.observe(scan(0, "floor", false), 5000);
  expect(edges.count).toBe(0);
  feedback.frame(null, 5200, .014, false,false,"Choose your room");
  expect(feedback.group.visible).toBe(false);
  feedback.dispose();
  expect(feedback.group.children).toHaveLength(0);
});
