import { Matrix4, Quaternion, Vector3 } from "three";
import { expect, it } from "vitest";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import type { Room, Vec2 } from "@/house/model/types";
import type { HouseRuntime } from "@/house/runtime";
import { calibrationFeatures } from "@/house/xr/mixedCalibration";
import { MixedPilot } from "@/house/xr/mixedPilot";
import { buildAlignmentModel, matchRoomAlignment, roomPoseDrift, type RoomEvidence } from "@/house/xr/roomAlignment";
import { floorOutlinePoses } from "@/house/xr/roomOutline";
import { RoomPreview, wallPreviewPose } from "@/house/xr/roomPreview";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = loadManifest(FIXTURE_DIR);
const room: Room = {
  ...manifest.rooms[0]!, floorElevation: 3, ceilingHeight: 2.6,
  footprint: { outer: [[0, 0], [6, 0], [6, 3], [4, 3], [4, 5], [0, 5]], holes: [] },
};
const model = buildAlignmentModel(room, calibrationFeatures({ ...manifest, rooms: [room] }, room.floorId, room.id));
const pose = new Matrix4().makeRotationY(0.57).setPosition(-2, -3, 4);
const physical = (x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(pose);
const eye = physical(3, 4.55, 2);
function evidence(outline: Vec2[]): RoomEvidence {
  return {
    walls: [], landmarks: [],
    floor: { y: 0, source: "plane", semanticFloor: true, outline: outline.map(([x, z]) => {
      const point = physical(x, 3, z);
      return [point.x, point.z];
    }) },
  };
}

it("finds the one unit-scale pose of a slightly noisy asymmetric outline with either scan winding", () => {
  const scan = evidence(room.footprint.outer);
  scan.floor!.outline.forEach((p, i) => { p[0] += Math.sin(i) * 0.01; });
  scan.floor!.outline.reverse();
  const found = floorOutlinePoses(room, scan, eye);
  expect(found).toHaveLength(1);
  expect(found[0]!.determinant()).toBeCloseTo(1);
  expect(roomPoseDrift(room, pose, found[0]!)).toBeLessThan(0.03);
  expect(floorOutlinePoses(room, { ...scan, floor: { ...scan.floor!, source: "bounds" } }, eye)).toEqual([]);
  expect(floorOutlinePoses(room, evidence([[0, 0], [6, 0], [6, 3], [0, 3]]), eye)).toEqual([]);
  expect(floorOutlinePoses(room, scan, physical(12, 4.5, 0))).toEqual([]);
});

it("preserves the two genuinely different headings of a rectangle and suppresses incomplete floor outlines", () => {
  const box: Room = { ...room, footprint: { outer: [[0, 0], [6, 0], [6, 5], [0, 5]], holes: [] } };
  expect(floorOutlinePoses(box, evidence(box.footprint.outer), eye)).toHaveLength(2);
  const preview = new RoomPreview(model);
  preview.observe(evidence(box.footprint.outer), eye);
  expect(preview.group.visible).toBe(false);
  preview.observe(evidence(room.footprint.outer), eye);
  expect(preview.group.visible).toBe(true);
  preview.track(physical(14, 4.5, 4));
  expect(preview.group.visible).toBe(false);
  preview.observe({ walls: [], floor: null, landmarks: [] }, eye);
  preview.track(eye);
  expect(preview.group.visible).toBe(false);
  preview.dispose();
});

it("uses the tracked face at a named wall midpoint even from a side angle, and handles reversed plan winding", () => {
  const a = physical(0.8, 3, 0), b = physical(5, 3, 0);
  const midpoint = physical(3, 3, 0);
  const walls = [{ a: [a.x, a.z] as Vec2, b: [b.x, b.z] as Vec2, low: 0, high: 2.6 }];
  const sideEye = physical(2.2, 4.55, 2);
  const estimated = wallPreviewPose(room, model.walls[0]!, midpoint, sideEye, walls);
  expect(roomPoseDrift(room, pose, estimated!)).toBeCloseTo(0);
  const atEyeLevel = midpoint.clone().add(new Vector3(0, 1.65, 0));
  const upperPatch = [{ ...walls[0]!, low: 1.25, high: 2.2 }];
  const aboveSofa = wallPreviewPose(room, model.walls[0]!, atEyeLevel, sideEye, upperPatch, midpoint.y);
  expect(roomPoseDrift(room, pose, aboveSofa!)).toBeCloseTo(0);
  const reversed = { ...room, footprint: { outer: [...room.footprint.outer].reverse(), holes: [] } };
  const base = model.walls[0]!;
  expect(roomPoseDrift(room, pose, wallPreviewPose(reversed, { ...base, a: base.b, b: base.a }, midpoint, eye, [])!)).toBeCloseTo(0);
  expect(wallPreviewPose(room, base, midpoint, physical(3, 4.55, 0.2), [])).toBeNull();
});

it("reuses a preview wall tap only to resolve genuinely checked symmetric headings in the same registration", () => {
  const box: Room = { ...room, footprint: { outer: [[0, 0], [6, 0], [6, 5], [0, 5]], holes: [] } };
  const model = buildAlignmentModel(box, calibrationFeatures({ ...manifest, rooms: [box] }, box.floorId, box.id));
  const scan = evidence(box.footprint.outer);
  const ring = scan.floor!.outline;
  scan.walls = ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length]!, low: 0, high: 2.6 }));
  const checked = matchRoomAlignment(model, scan, eye);
  expect(checked).toHaveLength(2);
  const preview = new RoomPreview(model);
  const place = (point: Vector3) => {
    preview.actions()[0]!.act!(0);
    preview.menu().wallPicker!.choose(0);
    expect(preview.aim(point, eye, [])).toBe(true);
  };
  place(physical(2.8, 3, 0));
  expect(roomPoseDrift(room, pose, preview.resolveWallHeading(checked)!.fit.matrix)).toBeCloseTo(0);
  expect(preview.resolveWallHeading(checked.map(c => ({ ...c, errorM: 0.08 })))).toBeNull();
  expect(preview.resolveWallHeading([])).toBeNull();
  place(physical(3, 3, 0.19));
  expect(preview.resolveWallHeading(checked)).toBeNull();
  place(physical(3, 3, 0));
  preview.reset();
  expect(preview.resolveWallHeading(checked)).toBeNull();
  preview.dispose();
});

it("places a rough outline with one aim, keeps inspection locked, and removes the estimate on tracking loss", () => {
  const runtime = {
    userId: "fixture", index: null, manifest: buildManifestIndex({ ...manifest, rooms: [room] }),
    store: { getState: () => ({ labelPreferences: { names: {} }, fingerprint: "fixture", routes: [], explode: { enabled: false, gap: 0 } }) },
  } as unknown as HouseRuntime;
  const space = new EventTarget() as XRReferenceSpace;
  const source = { targetRayMode: "tracked-pointer", targetRaySpace: {}, handedness: "right" } as XRInputSource;
  const session = Object.assign(new EventTarget(), { inputSources: [source], enabledFeatures: [], visibilityState: "visible" }) as unknown as XRSession;
  const origin = physical(3.1, 4.2, 2);
  const ray = new Matrix4().lookAt(origin, physical(3, 3, 0), new Vector3(0, 1, 0)).setPosition(origin);
  let tracked = true;
  const frame = {
    session, getViewerPose: () => ({ emulatedPosition: !tracked, transform: { position: eye, orientation: new Quaternion() } }),
    getPose: () => ({ emulatedPosition: false, transform: { matrix: ray.toArray() } }),
  } as unknown as XRFrame;
  const pilot = new MixedPilot(runtime, session, space);
  const menu = () => pilot.menu("", () => {});
  const tick = () => pilot.frame(frame, 0.013, false, { supply: 0, extract: 0 });
  try {
    pilot.enter(room);
    tick();
    menu().rows.find(r => r.label === "Preview room outline")!.act!(0);
    menu().wallPicker!.choose(0);
    expect(menu().title).toBe("Aim at the wall midpoint");
    expect(pilot.aimingAtRoom).toBe(true);
    expect(pilot.beginWallTrace(frame, source)).toBe(false);
    expect(pilot.select(frame, source, null)).toBe(true);
    tick();
    const outline = pilot.scene.getObjectByName("vh-estimated-room-outline")!;
    expect(outline.visible).toBe(true);
    expect(roomPoseDrift(room, pose, outline.matrix)).toBeCloseTo(0);
    expect(menu().lines.join(" ")).toMatch(/estimated/);
    expect(pilot.readyTransform).toBeNull();
    expect(pilot.showHouseTools).toBe(false);
    expect(pilot.overlay?.group.visible).toBe(false);
    tracked = false;
    tick();
    expect(outline.visible).toBe(false);
    tracked = true;
    tick();
    expect(outline.visible).toBe(false);
    expect(pilot.readyTransform).toBeNull();
  } finally {
    pilot.dispose();
  }
});
