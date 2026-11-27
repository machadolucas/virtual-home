import { Matrix4, Vector3 } from "three";
import { expect, it } from "vitest";
import type { Room, Vec2, Vec3 } from "@/house/model/types";
import { calibrationFeatures } from "@/house/xr/mixedCalibration";
import {
  buildAlignmentModel, matchRoomAlignment, roomPoseDrift, uniqueRoomAlignment,
  type AlignmentLandmark, type RoomEvidence,
} from "@/house/xr/roomAlignment";
import { RoomDiscovery } from "@/house/xr/roomDiscovery";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = loadManifest(FIXTURE_DIR);
const room: Room = { ...manifest.rooms[0]!, floorElevation: 3.1, ceilingHeight: 2.7,
  footprint: { outer: [[0,0], [5.8,0], [5.8,4.6], [0,4.6]], holes: [] } };
const features = calibrationFeatures({ ...manifest, rooms: [room] }, room.floorId, room.id);
const model = buildAlignmentModel(room, features);
const pose = new Matrix4().makeRotationY(-0.43).setPosition(2, -3.14, 5);
const track = (p: Vec3) => new Vector3(...p).applyMatrix4(pose);
const xz = (p: Vec2): Vec2 => { const v = track([p[0],3.1,p[1]]); return [v.x, v.z]; };
const eye = track([2.2,4.7,2.9]);
const door: AlignmentLandmark = { kind: "door", center: [2.1,4.14,0], rawCenter: [2.1,4.14,-0.075],
  axis: [1,0], width: 0.9, height: 2.08, elementId: "fixture-door" };
const window: AlignmentLandmark = { kind: "window", center: [5.8,4.65,2.3], rawCenter: [5.84,4.65,2.3],
  axis: [0,1], width: 1.45, height: 1.20, elementId: "fixture-window" };
function seen(mark: AlignmentLandmark): AlignmentLandmark {
  const a = new Vector3(mark.axis![0],0,mark.axis![1]).transformDirection(pose);
  return { kind: mark.kind, width: mark.width, height: mark.height, center: track(mark.center).toArray(),
    rawCenter: track(mark.rawCenter!).toArray(), axis: [a.x,a.z] };
}
function elevated(a: Vec2, b: Vec2, high = 2.28) {
  return { a: xz(a), b: xz(b), low: 1.22, high, semanticWall: true };
}
function scene(): RoomEvidence {
  return { floor: { y: -0.04, source: "plane", semanticFloor: true,
    outline: [[1,2], [3,2], [3,3.8], [1,3.8]].map(p => xz(p as Vec2)) },
    walls: [elevated([0.7,0],[3.9,0]), elevated([5.8,0.75],[5.8,2.9])], landmarks: [seen(window)] };
}

it("registers from upper wall pieces and a separately measured raw window centre with the lower walls occluded", () => {
  const result = uniqueRoomAlignment(matchRoomAlignment({ ...model, landmarks: [door,window] }, scene(), eye));
  expect(result?.evidenceKind).toBe("architecture");
  expect(result?.check.point).toEqual(window.rawCenter);
  expect(result?.check.id).toBe(room.id + ":opening:fixture-window");
  expect(result?.fit.matrix.determinant()).toBeCloseTo(1);
  expect(roomPoseDrift(room, result!.fit.matrix, pose)).toBeLessThan(0.001);
  expect(result?.errorM).toBeLessThan(0.001);
});

it("rejects shelving faces, marks projected to fit a wall, missing corroboration, and a conflicting second opening", () => {
  const withMarks = { ...model, landmarks: [door,window] };
  const scan = scene();
  expect(matchRoomAlignment(withMarks, { ...scan, walls: scan.walls.map(w => ({ ...w, semanticWall:false })) }, eye)).toEqual([]);
  expect(matchRoomAlignment(withMarks, { ...scan, landmarks: [] }, eye)).toEqual([]);
  const off = seen(window);
  off.rawCenter![1] += 0.07;
  expect(matchRoomAlignment(withMarks, { ...scan, landmarks: [off] }, eye)).toEqual([]);
  const wrong = seen(door);
  wrong.rawCenter![0] += 0.19;
  expect(matchRoomAlignment(withMarks, { ...scan, landmarks: [seen(window), wrong] }, eye)).toEqual([]);
});

it("checks the full labeled floor perimeter and a withheld vertex in 3D when tagged wall tops reach the known ceiling", () => {
  const scan = scene();
  scan.floor!.outline = room.footprint.outer.map(xz);
  scan.walls = [elevated([0.7,0],[3.9,0],2.66),elevated([5.8,0.75],[5.8,2.9],2.66)];
  scan.landmarks = [];
  const fits = matchRoomAlignment(model, scan, eye);
  expect(fits.length).toBeGreaterThan(0);
  expect(fits.every(f => f.evidenceKind === "architecture" && f.errorM <= 0.05)).toBe(true);
  expect(uniqueRoomAlignment(fits)).toBeNull();
  expect(matchRoomAlignment(model,{ ...scan, floor:{ ...scan.floor!,semanticFloor:false } },eye)).toEqual([]);
  expect(matchRoomAlignment(model,{ ...scan, walls:scan.walls.map(w => ({ ...w, high:w.high-0.08 })) },eye)).toEqual([]);
});

it("aligns at life size from two separated fixed openings with no exposed floor or walls", () => {
  const withMarks = { ...model, landmarks: [door,window] };
  const scan: RoomEvidence = { floor:null,walls:[],landmarks:[seen(door),seen(window)] };
  const fit = uniqueRoomAlignment(matchRoomAlignment(withMarks,scan,eye));
  expect(fit?.landmarkCount).toBe(2);
  expect(roomPoseDrift(room, fit!.fit.matrix, pose)).toBeLessThan(0.001);
  expect(matchRoomAlignment(withMarks,{ ...scan,landmarks:[seen(door)] },eye)).toEqual([]);
  const noisy = seen(window);
  noisy.rawCenter![1] += 0.068;
  expect(matchRoomAlignment(withMarks,{ ...scan,landmarks:[seen(door),noisy] },eye)).toEqual([]);
  const wrongFloor = scene().floor!;
  expect(matchRoomAlignment(withMarks,{ ...scan,floor:{ ...wrongFloor,y:0.12 } },eye)).toEqual([]);
});

it("retains both headings when a symmetric pair is indistinguishable and ignores distant cross-room openings", () => {
  const first: AlignmentLandmark = { ...door, center:[2.9,4.14,0], rawCenter:[2.9,4.14,-0.075] };
  const second: AlignmentLandmark = { ...first, elementId:"opposite-door", center:[2.9,4.14,4.6], rawCenter:[2.9,4.14,4.675] };
  const distant = Array.from({ length: 18 }, (_, i) => {
    const mark = seen(window);
    mark.rawCenter![0] += 20 + i * 2;
    return mark;
  });
  const scan: RoomEvidence = { floor:null, walls:[], landmarks:[seen(first),seen(second),...distant] };
  const candidates = matchRoomAlignment({ ...model, landmarks:[first,second] },scan,eye);
  expect(candidates).toHaveLength(2);
  expect(uniqueRoomAlignment(candidates)).toBeNull();
});

it("identifies a room across two captures using separated fixed openings while retaining competing rooms and unindexed assets", () => {
  const current = { ...model, openingInventoryComplete:true, landmarks: [door,window] };
  const otherRoom = { ...room, id:"other-synthetic-room" };
  const neighbor = { ...current, room:otherRoom };
  const scan = () => ({ floor:null,walls:[],landmarks:[seen(door),seen(window)] });
  const named = new RoomDiscovery([room], () => current);
  expect(named.submit(scan(),eye,0)).toBe(true);
  expect(named.step(eye).phase).toBe("confirming");
  named.submit(scan(),eye,470);
  expect(named.step(eye).match?.orientation?.evidenceKind).toBe("architecture");
  for (const other of [neighbor, { ...neighbor, openingInventoryComplete:false, landmarks:[] }]) {
    const obscured = new RoomDiscovery([room,otherRoom], r => r === room ? current : other);
    for (const time of [0,470]) {
      obscured.submit(scan(),eye,time);
      while (obscured.state.phase === "checking") obscured.step(eye);
      expect(obscured.state.match).toBeNull();
    }
  }
});
