import { BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Ray, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import type { Room, Vec3 } from "@/house/model/types";
import {
  applyAlignmentHint, buildAlignmentModel, matchRoomAlignment, uniqueRoomAlignment, type RoomEvidence,
} from "@/house/xr/roomAlignment";
import { intersectAlignmentEvidence, readAlignmentEvidence, snapScannedCorner } from "@/house/xr/roomAlignmentEvidence";
import { chooseFacing, FacingHold } from "@/house/xr/roomFacing";
import { fitWallTrace, floorAim, WallTrace } from "@/house/xr/wallTrace";
import { AlignmentRays } from "@/house/xr/roomAlignmentRay";
import { calibrationFeatures } from "@/house/xr/mixedCalibration";
import { MixedRealityCalibration } from "@/house/xr/mixed";
import { MixedPilot } from "@/house/xr/mixedPilot";
import { triangulateFloorCorner } from "@/house/xr/roomAlignmentTriangulation";
import type { HouseRuntime } from "@/house/runtime";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import { applyExplode } from "@/house/scene/explode";
import { createSceneIndex, indexAsset } from "@/house/scene/SceneIndex";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = loadManifest(FIXTURE_DIR);
const room: Room = { ...manifest.rooms[0]!, floorElevation: 3, ceilingHeight: 2.4,
  footprint: { outer: [[0, 0], [4, 0], [4, 3], [0, 3]], holes: [] } };
const roomManifest = { ...manifest, rooms: [room] };
const features = calibrationFeatures(roomManifest, room.floorId, room.id);
const model = buildAlignmentModel(room, features);
const modelToTracking = new Matrix4().makeRotationY(0.71).setPosition(-2, -3, 5);
const tracking = (p: Vec3) => new Vector3(...p).applyMatrix4(modelToTracking);
const point = (x: number, z: number): [number, number] => {
  const v = tracking([x, room.floorElevation, z]); return [v.x, v.z];
};
const viewer = tracking([1.25, 4.6, 1.33]);
const reference = {} as XRReferenceSpace;
const frameWith = (fields: object) => fields as unknown as XRFrame;

function measured(): RoomEvidence {
  return { walls: model.walls.map(({ a, b }) => ({ a: point(...a), b: point(...b), low: 0, high: 2.4 })),
    floor: { y: 0, outline: room.footprint.outer.map(([x, z]) => point(x, z)) }, landmarks: [] };
}

function assertMapsToTracking(matrix: Matrix4) {
  for (const { point } of features)
    expect(new Vector3(...point).applyMatrix4(matrix).distanceTo(tracking(point))).toBeCloseTo(0, 6);
  expect(matrix.determinant()).toBeCloseTo(1);
}

describe("automatic room alignment", () => {
  it("withholds a symmetric room until a known wall resolves orientation", () => {
    const candidates = matchRoomAlignment(model, measured(), viewer);
    expect(candidates).toHaveLength(2);
    expect(uniqueRoomAlignment(candidates)).toBeNull();
    expect(applyAlignmentHint(model, candidates, { kind: "wall", index: 0 }, tracking([2, 4.3, 0.2]))).toBeNull();
    const resolved = applyAlignmentHint(model, candidates, { kind: "wall", index: 0 }, tracking([2, 4.3, 0]));
    expect(resolved?.errorM).toBeLessThan(0.05);
    assertMapsToTracking(resolved!.fit.matrix);
  });

  it("uses a separately observed matching doorway to resolve an orientation without prompting", () => {
    const landmark = { kind: "door" as const, center: [1, 4.05, 0] as Vec3, width: 0.85, height: 2.1 };
    const withDoor = { ...model, landmarks: [landmark] };
    const evidence = measured();
    evidence.landmarks = [{ ...landmark, center: tracking(landmark.center).toArray() }];
    const resolved = uniqueRoomAlignment(matchRoomAlignment(withDoor, evidence, viewer));
    expect(resolved?.landmarkCount).toBe(1);
    assertMapsToTracking(resolved!.fit.matrix);
  });

  it("rejects missing geometry, the wrong floor, and a held-out wall or wall base beyond 5 cm", () => {
    const sorted = measured();
    expect(matchRoomAlignment(model, { ...sorted, walls: sorted.walls.slice(0, 2) }, viewer)).toEqual([]);
    expect(matchRoomAlignment(model, { ...sorted, floor: { ...sorted.floor!, y: 1 } }, viewer)).toEqual([]);
    const oversize = measured();
    const broken = oversize.walls[2]!;
    broken.a = point(4, 3.14);
    broken.b = point(0, 3.14);
    expect(matchRoomAlignment(model, oversize, viewer)).toEqual([]);
    const raised = measured();
    for (const wall of raised.walls) wall.low += 0.08;
    expect(matchRoomAlignment(model, raised, viewer)).toEqual([]);
  });

  it("reads opening geometry in physical coordinates through parent transforms with desktop explode enabled", () => {
    const fixture = loadManifest(FIXTURE_DIR);
    const upper = fixture.floors[1]!;
    const target = { ...room, floorId: upper.id, id: "synthetic-room" };
    const opening = { id: "synthetic-opening", kind: "door" as const, floorId: upper.id, roomIds: [target.id],
      nodeRefs: [{ assetId: fixture.assets[0]!.id, nodeName: "synthetic-opening" }], surfaceIds: ["synthetic-reveal"],
      certainty: "measured" as const, sourceRefs: [] };
    const raw = { ...fixture, rooms: [target], elements: [opening], surfaces: [{
      id: "synthetic-reveal", kind: "other" as const, elementId: opening.id, role: "reveal", defaultColor: "#ffffff",
      nodeRefs: [{ assetId: fixture.assets[0]!.id, nodeName: "synthetic-reveal" }],
    }] };
    const index = createSceneIndex(buildManifestIndex(raw));
    const root = new Group(), floor = new Group(), parent = new Group();
    floor.name = upper.id;
    parent.name = opening.id; parent.position.set(1, 4.0, 0);
    const mesh = new Mesh(new BoxGeometry(0.9, 2, 0.1), new MeshStandardMaterial());
    mesh.name = "synthetic-reveal"; mesh.position.x = 0.25;
    parent.add(mesh); floor.add(parent); root.add(floor);
    root.updateMatrixWorld(true);
    indexAsset(index, fixture.assets[0]!.id, root);
    const explode = { enabled: true, gap: 4 };
    applyExplode(index, explode);
    expect(floor.position.y).not.toBe(0);
    const result = buildAlignmentModel(target, calibrationFeatures(raw, upper.id, target.id), index, explode);
    expect(result.landmarks[0]?.center).toEqual([1.25, 4, 0]);
    expect(result.landmarks[0]?.width).toBeCloseTo(0.9);
    mesh.geometry.dispose();
    mesh.material.dispose();
  });

  it("projects real plane hits and snaps only to nearby scanned corners", () => {
    const planeSpace = {} as XRSpace;
    const make = (p: Vector3) => ({ x: p.x, y: p.y, z: p.z });
    const polygon = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => [a, b, c, d].map((v) => make(tracking(v)));
    const floor = { planeSpace, semanticLabel: "floor", polygon: polygon([0,3,0],[4,3,0],[4,3,3],[0,3,3]) };
    const scanned = { ...floor, semanticLabel: "wall", polygon: polygon([0,3,0],[4,3,0],[4,5.4,0],[0,5.4,0]) };
    const right = { ...scanned, polygon: polygon([4,3,0],[4,3,3],[4,5.4,3],[4,5.4,0]) };
    const back = { ...scanned, polygon: polygon([4,3,3],[0,3,3],[0,5.4,3],[4,5.4,3]) };
    const left = { ...scanned, polygon: polygon([0,3,3],[0,3,0],[0,5.4,0],[0,5.4,3]) };
    const frame = frameWith({ detectedPlanes: new Set([floor, scanned, right, back, left]),
      getPose: () => ({ emulatedPosition: false, transform: { matrix: new Matrix4().toArray() } }) });
    const evidence = readAlignmentEvidence(frame, reference, viewer);
    expect(evidence.walls).toHaveLength(4);
    const expected = tracking([0.03, 3.025, 0]);
    const ray = new Ray(viewer, expected.clone().sub(viewer).normalize());
    const hit = intersectAlignmentEvidence(evidence, ray, new Vector3());
    expect(hit?.distanceTo(expected)).toBeCloseTo(0);
    snapScannedCorner(evidence, hit!);
    expect(hit!.distanceTo(tracking([0, 3, 0]))).toBeCloseTo(0);
    expect(matchRoomAlignment(model, evidence, viewer)).toHaveLength(2);
  });

  it("keeps unlabeled mesh depth available without treating its verticals as independent structural walls", () => {
    const vertices: number[] = [], indices: number[] = [];
    const quad = (...points: Vec3[]) => {
      const i = vertices.length / 3;
      vertices.push(...points.flatMap((p) => tracking(p).toArray()));
      indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    };
    quad([0,3,0],[4,3,0],[4,3,3],[0,3,3]);
    for (const { a: [ax, az], b: [bx, bz] } of model.walls)
      quad([ax,3,az],[bx,3,bz],[bx,5.4,bz],[ax,5.4,az]);
    const frame = frameWith({ detectedMeshes: new Set([{ meshSpace: {}, vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) }]),
      getPose: () => ({ emulatedPosition: false, transform: { matrix: new Matrix4().toArray() } }) });
    const evidence = readAlignmentEvidence(frame, reference, viewer);
    expect(evidence.floor?.y).toBeCloseTo(0);
    expect(evidence.walls).toHaveLength(0);
    expect(matchRoomAlignment(model, evidence, viewer)).toHaveLength(0);
    const target = tracking([2, 4.2, 0]);
    const ray = new Ray(viewer, target.clone().sub(viewer).normalize());
    expect(intersectAlignmentEvidence(evidence, ray, new Vector3())?.distanceTo(target)).toBeLessThan(.001);
  });
});

it("uses a resolved local-floor fit only while viewer tracking is valid and rechecks after loss", () => {
  const ref = new EventTarget() as XRReferenceSpace;
  const session = Object.assign(new EventTarget(), { visibilityState: "visible" }) as unknown as XRSession;
  const cal = new MixedRealityCalibration({ session, referenceSpace: ref, fingerprint: "fixture", floorId: room.floorId,
    userId: "fixture", onState: vi.fn() });
  const tracked = frameWith({ session, getViewerPose: () => ({ emulatedPosition: false }) });
  const lost = frameWith({ session, getViewerPose: () => undefined });
  const candidate = applyAlignmentHint(model, matchRoomAlignment(model, measured(), viewer),
    { kind: "wall", index: 0 }, tracking([2, 4.3, 0]))!;
  expect(cal.acceptScanned(tracked, candidate.fit, candidate.check, candidate.errorM)).toBe(false);
  expect(cal.frame(tracked)).toBeNull();
  expect(cal.acceptScanned(tracked, candidate.fit, candidate.check, 0.07)).toBe(false);
  expect(cal.acceptScanned(tracked, candidate.fit, candidate.check, candidate.errorM)).toBe(true);
  expect(cal.frame(tracked)).toBe(candidate.fit.matrix);
  expect(cal.frame(lost)).toBeNull();
  expect(cal.frame(tracked)).toBeNull();
  expect(cal.state.phase).toBe("verify");
  const shifted = candidate.fit.matrix.clone().premultiply(new Matrix4().makeTranslation(0.11, 0, 0));
  expect(cal.verifyScanned(tracked, { ...candidate.fit, matrix: shifted }, candidate.errorM, features)).toBe(false);
  expect(cal.verifyScanned(tracked, candidate.fit, candidate.errorM, features)).toBe(true);
  expect(cal.frame(tracked)).toBe(candidate.fit.matrix);
  cal.dispose();
});

it("samples an optional native ray hit in local-floor space and disposes the source", async () => {
  const source = { targetRayMode: "tracked-pointer", targetRaySpace: {} } as XRInputSource;
  const native = { cancel: vi.fn() } as XRHitTestSource;
  const session = { requestHitTestSource: vi.fn().mockResolvedValue(native), visibilityState: "visible" } as unknown as XRSession;
  const rays = new AlignmentRays(session, reference);
  rays.sync([source]);
  await vi.waitFor(() => expect(rays.available).toBe(true));
  const position = { x: 2, y: 0.05, z: -1.1 };
  const frame = frameWith({ session,
    getPose: () => ({ emulatedPosition: false, transform: { matrix: new Matrix4().toArray() } }),
    getHitTestResults: () => [{ getPose: () => ({ emulatedPosition: false, transform: { position } }) }],
  });
  expect(rays.hit(frame, source, null, new Vector3())?.toArray()).toEqual([2, 0.05, -1.1]);
  rays.clear();
  expect(native.cancel).toHaveBeenCalledOnce();
});

const aim = (origin: Vector3, target: Vector3) => new Ray(origin, target.clone().sub(origin).normalize());

it("triangulates a fixed floor corner from distinct tracked rays and rejects jitter, skew, and off-floor aims", () => {
  const target = tracking([0, 3, 0]);
  const first = viewer.clone().add(new Vector3(-0.4, -0.35, 0));
  const second = viewer.clone().add(new Vector3(0.4, -0.35, 0));
  const near = first.clone().add(new Vector3(0.03, 0, 0));
  expect(triangulateFloorCorner(aim(first, target), aim(second, target)).point?.distanceTo(target)).toBeCloseTo(0);
  expect(triangulateFloorCorner(aim(first, target), aim(near, target)).point).toBeUndefined();
  expect(triangulateFloorCorner(aim(first, target), aim(second, target.clone().add(new Vector3(0, 0.25, 0)))).point).toBeUndefined();
  const offFloor = target.clone().add(new Vector3(0, 0.4, 0));
  expect(triangulateFloorCorner(aim(first, offFloor), aim(second, offFloor)).point).toBeUndefined();
});

function pilotFixture(roomSetup?: XRSession["initiateRoomCapture"], anchor?: XRAnchor, anchorPose?: Matrix4) {
  const runtime = {
    userId: "fixture", index: null, manifest: buildManifestIndex(roomManifest),
    store: { getState: () => ({ labelPreferences: { names: { [room.id]: "Household room label" } }, fingerprint: "fixture", routes: [],
      explode: { enabled: false, gap: 0 } }) }, base: "/fixture",
  } as unknown as HouseRuntime;
  const ref = new EventTarget() as XRReferenceSpace;
  const source = { targetRayMode: "tracked-pointer", targetRaySpace: {}, handedness: "right" } as XRInputSource;
  const session = Object.assign(new EventTarget(), {
    inputSources: [source], visibilityState: "visible", initiateRoomCapture: roomSetup,
    restorePersistentAnchor: anchor ? vi.fn().mockResolvedValue(anchor) : undefined,
  }) as unknown as XRSession;
  const matrix = new Matrix4();
  const orientation = new Quaternion();
  const frame = frameWith({ session,
    getViewerPose: () => ({ emulatedPosition: false, transform: { position: viewer, orientation } }),
    getPose: (space: XRSpace) => space === anchor?.anchorSpace
      ? anchorPose && { emulatedPosition: false, transform: { matrix: anchorPose.toArray() } }
      : { emulatedPosition: false, transform: { matrix: matrix.toArray() } },
  });
  const pilot = new MixedPilot(runtime, session, ref);
  const menu = () => pilot.menu("", () => {});
  const click = (label: string | RegExp) => {
    const action = menu().rows.find((row) => typeof label === "string" ? row.label === label : label.test(row.label))?.act;
    expect(action, `Missing action ${label}`).toBeTypeOf("function");
    action!(0);
  };
  const tick = (panelHit = false, promptAvailable = true) =>
    pilot.frame(frame, 0.014, false, { supply: 0, extract: 0 }, () => panelHit, promptAvailable);
  const confirm = (origin: Vector3, target: Vector3) => {
    matrix.lookAt(origin, target, new Vector3(0, 1, 0)).setPosition(origin);
    pilot.select(frame, source, aim(origin, target));
  };
  if (!menu().rows.some((row) => row.id === room.id)) click("Choose room myself");
  const roomRow = menu().rows.find((row) => row.id === room.id)!;
  click(roomRow.label);
  const trace = (a: Vec3, b: Vec3) => {
    const origin = viewer.clone().add(new Vector3(0.2, -0.35, 0));
    const sight = (fraction: number) => matrix.lookAt(origin, tracking(a).lerp(tracking(b), fraction),
      new Vector3(0, 1, 0)).setPosition(origin);
    sight(0);
    expect(pilot.beginWallTrace(frame, source)).toBe(true);
    for (let i = 0; i <= 24; i++) { sight(i / 24); tick(); }
    pilot.finishWallTrace(frame, source);
    tick();
  };
  const lookAt = (p: Vec3) => {
    orientation.setFromRotationMatrix(new Matrix4().lookAt(viewer, tracking(p), new Vector3(0, 1, 0)));
  };
  const face = (p: Vec3) => {
    lookAt(p);
    pilot.select(frame, source, null);
    tick();
  };
  return { pilot, ref, session, click, menu, tick, confirm, frame, roomRow, trace, face, lookAt };
}

it("checks hand-traced walls when a scan supplies a partial floor, and rejects bent or duplicate strokes", () => {
  const trace = new WallTrace();
  const source = {} as XRInputSource;
  try {
    const stroke = (a: Vec3, b: Vec3) => {
      expect(trace.begin(source)).toBe(true);
      for (let i = 0; i <= 24; i++) {
        const pt = tracking(a).lerp(tracking(b), i / 24);
        pt.x += Math.sin(i) * 0.008;
        trace.sample(pt);
      }
      return trace.finish(source);
    };
    expect(stroke([0.7, 3, 0], [3.1, 3, 0])).toBe(true);
    expect(stroke([1.2, 3, 0], [2.4, 3, 0])).toBe(false);
    expect(stroke([4, 3, 0.5], [4, 3, 2.5])).toBe(true);
    const partialFloor: RoomEvidence = {
      walls: [],
      landmarks: [],
      floor: {
        y: 0,
        source: "plane",
        outline: [
          [1, 1],
          [1, 1.2],
          [1.2, 1.2],
          [1.2, 1],
        ],
      },
    };
    expect(matchRoomAlignment(model, trace.evidence(0, partialFloor), viewer)).toHaveLength(0);
    expect(stroke([3.3, 3, 3], [0.7, 3, 3])).toBe(true);
    expect(stroke([0, 3, 2.6], [0, 3, 0.5])).toBe(true);
    const candidates = matchRoomAlignment(model, trace.evidence(0, partialFloor), viewer);
    expect(candidates).toHaveLength(2);
    const mark = { label: "wall", point: [2, 3, 0] as Vec3 };
    expect(chooseFacing(candidates, mark, viewer, new Vector3(0, 1, 0))).toBeNull();
    expect(
      chooseFacing(candidates, mark, viewer, tracking(mark.point).sub(viewer).setY(0).normalize())?.errorM,
    ).toBeLessThan(0.02);
    expect(floorAim(new Ray(viewer, new Vector3(1, -0.01, 0).normalize()), 0, new Vector3())).toBeNull();
    const bent = Array.from({ length: 21 }, (_, i) => new Vector3(i / 10, 0, Math.min(i, 20 - i) / 10));
    expect(fitWallTrace(bent)).toBeNull();
  } finally {
    trace.dispose();
  }
});

it("aligns from a stationary position by tracing broad wall sections with no native scene or point pairing", () => {
  const { pilot, click, menu, tick, trace, face } = pilotFixture();
  try {
    tick();
    click("Trace wall bases");
    trace([0.7, 3, 0], [3.1, 3, 0]);
    trace([4, 3, 0.5], [4, 3, 2.5]);
    expect(pilot.readyTransform).toBeNull();
    trace([3.3, 3, 3], [0.7, 3, 3]);
    if (!menu().title.startsWith("Look toward")) trace([0, 3, 2.6], [0, 3, 0.5]);
    expect(pilot.readyTransform).toBeNull();
    expect(menu()).toMatchObject({ title: "Look toward the highlighted wall", planEdge: 0 });
    // Both ends of this sight line are far from any corner. The trigger passes no target ray.
    face([2, 4.5, 0]);
    assertMapsToTracking(pilot.readyTransform!);
    expect(pilot.scene.getObjectByName("vh-wall-base-traces")).toBeUndefined();
  } finally {
    pilot.dispose();
  }
});

it("uses a marked wall on the plan to resolve a checked heading without another physical action", () => {
  const {pilot,click,menu,tick,trace} = pilotFixture();
  try {
    tick(); click("Trace wall bases");
    trace([0.5,3,0], [3,3,0]);
    trace([4,3,0.4], [4,3,2.6]);
    trace([3.4,3,3], [0.6,3,3]);
    if (menu().title.startsWith("Look toward")) click("Mark another wall");
    trace([0,3,2.6], [0,3,0.4]);
    click("Match saved lines on plan");
    const page = menu();
    expect(page.title).toContain("Match line 1");
    expect(page.wallPicker?.walls.some(w => w.index === 0 && w.enabled)).toBe(true);
    expect(pilot.readyTransform).toBeNull();
    page.wallPicker!.choose(0);
    tick(); tick();
    assertMapsToTracking(pilot.readyTransform!);
    expect(pilot.overlay?.group.visible).toBe(true);
  } finally { pilot.dispose(); }
});

it("reprojects existing strokes after measuring a split floor from one standing position", () => {
  const {pilot,click,menu,tick,trace,confirm,face} = pilotFixture();
  const floor = 2.68;
  try {
    tick(); click("Trace wall bases");
    trace([0.5,floor,0],[3,floor,0]);
    trace([4,floor,0.4],[4,floor,2.6]);
    trace([3.4,floor,3],[0.6,floor,3]);
    trace([0,floor,2.6],[0,floor,0.4]);
    expect(menu().title).toContain("4 marked");
    expect(pilot.readyTransform).toBeNull();
    click("Check floor height");
    const spot=tracking([1.1,floor,1.0]);
    confirm(viewer.clone().add(new Vector3(-.23,-.35,.2)),spot);
    expect(menu().lines.join(" ")).toContain("First aim");
    confirm(viewer.clone().add(new Vector3(.23,-.35,.2)),spot);
    tick(); tick();
    if (menu().title.startsWith("Look toward")) face([2,floor+1.5,0]);
    expect(pilot.readyTransform).toBeTruthy();
    const actual = new Vector3(0,3,0).applyMatrix4(pilot.readyTransform!);
    expect(actual.distanceTo(tracking([0,floor,0]))).toBeLessThan(.05);
  } finally { pilot.dispose(); }
});

it("does not accept an idle head or menu gaze, and re-arms a deliberate hold after hiding the prompt", () => {
  let now = 1_000;
  const time = vi.spyOn(performance, "now").mockImplementation(() => now);
  const { pilot, click, menu, tick, trace, lookAt } = pilotFixture();
  const hold = (frames: number, panelHit = false) => {
    for (let i = 0; i < frames; i++) { now += 100; tick(panelHit); }
  };
  const marker = () => pilot.scene.getObjectByName("vh-facing-progress");
  const cue: Vec3 = [2, 4.5, 0], away: Vec3 = [4, 4.5, 1.5];
  try {
    tick();
    click("Trace wall bases");
    trace([0.7, 3, 0], [3.1, 3, 0]);
    trace([4, 3, 0.5], [4, 3, 2.5]);
    trace([3.3, 3, 3], [0.7, 3, 3]);
    if (!menu().title.startsWith("Look toward")) trace([0, 3, 2.6], [0, 3, 0.5]);
    expect(menu().title).toBe("Look toward the highlighted wall");
    lookAt(cue);
    hold(20);
    expect(pilot.readyTransform).toBeNull();
    expect(marker()?.visible).toBeFalsy();
    lookAt(away); hold(2, true);
    lookAt(cue); hold(20, true);
    expect(pilot.readyTransform).toBeNull();
    expect(marker()?.visible).toBeFalsy();
    hold(5);
    expect(marker()?.visible).toBe(true);
    expect(menu().lines[0]).toBe("Hold your view until the ring fills.");
    click("Choose another direction");
    expect(marker()?.visible).toBe(false);
    click("Look toward the highlighted wall");
    menu(); hold(20);
    expect(pilot.readyTransform).toBeNull();
    lookAt(away); hold(2);
    lookAt(cue); hold(5);
    expect(marker()?.visible).toBe(true);
    tick(false, false);
    expect(marker()?.visible).toBe(false);
    menu(); hold(20);
    expect(pilot.readyTransform).toBeNull();
    lookAt(away); hold(2);
    lookAt(cue); hold(13);
    assertMapsToTracking(pilot.readyTransform!);
    expect(marker()?.visible).toBe(false);
  } finally {
    pilot.dispose();
    time.mockRestore();
  }
});

it("requires stable heading and the same candidate across newly read evidence", () => {
  const candidates = matchRoomAlignment(model, measured(), viewer);
  const [first, other] = candidates;
  const hold = new FacingHold();
  const target = { label: "wall", point: [2, 3, 0] as Vec3 };
  const away = new Vector3(1, 0, 0), ahead = new Vector3(0, 0, -1);
  const sample = (t: number, version: number, candidate = first ?? null, gaze = ahead) =>
    hold.update(target, candidate, viewer, gaze, version, t, false);
  sample(0, 1, null, away);
  for (let t = 100; t <= 1_300; t += 100) expect(sample(t, 1)).toBeNull();
  expect(hold.progress).toBe(0.95);
  const wobble = new Vector3(0.15, 0, -1).normalize();
  expect(sample(1_400, 2, first, wobble)).toBeNull();
  expect(hold.progress).toBe(0);
  expect(sample(1_500, 2, other, wobble)).toBeNull();
  for (let t = 1_600; t <= 2_900; t += 100) expect(sample(t, 3, other, wobble)).toBeNull();
  expect(hold.progress).toBe(0);
  sample(3_000, 3, null, away);
  for (let t = 3_100; t <= 4_000; t += 100) expect(sample(t, 3, other, wobble)).toBeNull();
  expect(sample(4_500, 4, other, wobble)).toBeNull(); // A stalled frame restarts deliberate response.
  expect(hold.progress).toBe(0);
});

it("fails closed if the final forced scan no longer supports the held direction", () => {
  let now = 1_000;
  const time = vi.spyOn(performance, "now").mockImplementation(() => now);
  const { pilot, click, menu, tick, trace, lookAt } = pilotFixture();
  try {
    tick();
    click("Trace wall bases");
    trace([0.7, 3, 0], [3.1, 3, 0]);
    trace([4, 3, 0.5], [4, 3, 2.5]);
    trace([3.3, 3, 3], [0.7, 3, 3]);
    if (!menu().title.startsWith("Look toward")) trace([0, 3, 2.6], [0, 3, 0.5]);
    expect(menu().title).toBe("Look toward the highlighted wall");
    lookAt([4, 4.5, 1.5]); tick();
    lookAt([2, 4.5, 0]);
    for (let i = 0; i < 11; i++) { now += 100; tick(); }
    expect(pilot.scene.getObjectByName("vh-facing-progress")?.visible).toBe(true);
    expect(pilot.readyTransform).toBeNull();

    // Change evidence between periodic reads. Only the forced confirmation scan sees this change.
    pilot["trace"]?.undo(); pilot["trace"]?.undo();
    pilot["nextScan"] = now + 400;
    now += 100; tick();
    expect(pilot["nextScan"]).toBe(now + 500);
    expect(pilot.calibration?.state.phase).not.toBe("ready");
    expect(pilot.readyTransform).toBeNull();
    expect(pilot.scene.getObjectByName("vh-facing-progress")?.visible).toBe(false);
  } finally {
    pilot.dispose();
    time.mockRestore();
  }
});

it("drops wall strokes at a tracking-origin reset and lets the wearer undo without losing earlier walls", () => {
  const { pilot, ref, click, menu, tick, trace } = pilotFixture();
  try {
    tick();
    click("Trace wall bases");
    trace([0.7, 3, 0], [3.1, 3, 0]);
    trace([4, 3, 0.5], [4, 3, 2.5]);
    click("Undo last wall");
    expect(menu().title).toContain("1 marked");
    ref.dispatchEvent(new Event("reset"));
    tick();
    expect(pilot.readyTransform).toBeNull();
    expect(pilot.scene.getObjectByName("vh-wall-base-traces")).toBeUndefined();
    click("Trace wall bases");
    expect(menu().title).toBe("Trace a wall");
  } finally {
    pilot.dispose();
  }
});

it("starts a wall trace directly from a held trigger after room scanning finds no geometry", () => {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const { pilot, tick, trace, menu } = pilotFixture();
  try {
    tick();
    now += 3500;
    tick();
    trace([0.7, 3, 0], [3.1, 3, 0]);
    expect(menu().title).toContain("1 marked");
    expect(pilot.readyTransform).toBeNull();
  } finally {
    pilot.dispose();
    vi.restoreAllMocks();
  }
});

it("starts with a simple menu and aligns from the same standing point even when no sensor data is exposed", () => {
  const { pilot, click, menu, tick, confirm, roomRow } = pilotFixture();
  expect(roomRow).toMatchObject({ id: room.id, label: "Household room label",
    detail: manifest.floors.find((floor) => floor.id === room.floorId)?.name });
  tick();
  expect(menu().corners).toBeUndefined();
  expect(menu().rows.map((row) => row.label)).toContain("Point to align manually");
  click("Point to align manually");
  const a = viewer.clone().add(new Vector3(-0.42, -0.4, 0));
  const b = viewer.clone().add(new Vector3(0.42, -0.4, 0));
  for (let i = 0; i < 3; i++) {
    click(new RegExp(`^Corner ${i + 1}`));
    expect(pilot.aimingAtRoom).toBe(true);
    const target = tracking(features[i]!.point);
    confirm(a, target);
    expect(menu().lines.join(" ")).toContain("First aim marked");
    expect(pilot.readyTransform).toBeNull();
    confirm(b, target);
  }
  tick();
  expect(pilot.aimingAtRoom).toBe(false);
  assertMapsToTracking(pilot.readyTransform!);
  pilot.dispose();
});

it("offers explicit headset room setup after the discovery grace and retains from-here alignment after a denial", async () => {
  let now = 1_000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const setup = vi.fn().mockRejectedValue(new Error("declined"));
  const { pilot, click, menu, tick } = pilotFixture(setup);
  try {
    tick();
    expect(menu().rows.some(({ label }) => label === "Open headset room setup")).toBe(false);
    now += 3_001;
    tick();
    expect(setup).not.toHaveBeenCalled();
    click("Open headset room setup");
    expect(setup).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(menu().lines.join(" ")).toContain("Room setup did not open"));
    expect(menu().rows.some(({ label }) => label === "Point to align manually")).toBe(true);
    now += 4_000;
    tick();
    expect(menu().rows.some(({ label }) => label === "Open headset room setup")).toBe(false);
  } finally {
    pilot.dispose();
    clock.mockRestore();
  }
});

const otherCheck = { id: "other-corner", roomId: "other-room", label: "Corner in a different room", point: [15, 3, 13] as Vec3 };

function otherRoomAnchor() {
  const anchor = { anchorSpace: {}, delete: vi.fn() } as unknown as XRAnchor;
  const saved = JSON.stringify({ handle: "same-floor-handle", modelOrigin: otherCheck.point, check: otherCheck });
  return {
    anchor, saved,
    anchorPose: modelToTracking.clone().multiply(new Matrix4().makeTranslation(...otherCheck.point)),
  };
}

it("offers full current-room aiming when a same-floor saved anchor has a foreign check point", async () => {
  const { anchor, anchorPose, saved } = otherRoomAnchor();
  const removeItem = vi.fn();
  vi.stubGlobal("window", { localStorage: { getItem: () => saved, removeItem, setItem: vi.fn() } });
  const { pilot, click, menu, tick, confirm } = pilotFixture(undefined, anchor, anchorPose);
  try {
    await vi.waitFor(() => { tick(); expect(pilot.calibration?.state.phase).toBe("verify"); });
    expect(pilot.calibration?.state.selected).toBeNull();
    expect(pilot.readyTransform).toBeNull();
    expect(menu().title).toContain(room.name);
    expect(JSON.stringify(menu())).not.toContain(otherCheck.label);
    expect(pilot.aimingAtRoom).toBe(false);
    click("Point to align manually");
    expect(removeItem).not.toHaveBeenCalled();
    expect(pilot.calibration?.state.phase).toBe("select");
    const a = viewer.clone().add(new Vector3(-0.42, -0.4, 0));
    const b = viewer.clone().add(new Vector3(0.42, -0.4, 0));
    for (let i = 0; i < 3; i++) {
      click(new RegExp(`^Corner ${i + 1}`));
      expect(pilot.calibration?.state.selected?.roomId).toBe(room.id);
      const target = tracking(features[i]!.point);
      confirm(a, target);
      expect(pilot.readyTransform).toBeNull();
      confirm(b, target);
    }
    tick();
    assertMapsToTracking(pilot.readyTransform!);
  } finally {
    pilot.dispose();
    vi.unstubAllGlobals();
  }
});

it.each([true, false])("verifies or replaces a foreign anchor only with an independently checked current-room scan (locatable: %s)", async (locatable) => {
  const { anchor, anchorPose, saved } = otherRoomAnchor();
  const ref = new EventTarget() as XRReferenceSpace;
  const session = Object.assign(new EventTarget(), {
    visibilityState: "visible", restorePersistentAnchor: vi.fn().mockResolvedValue(anchor),
  }) as unknown as XRSession;
  const cal = new MixedRealityCalibration({
    session, referenceSpace: ref, fingerprint: "fixture", floorId: room.floorId, roomId: room.id, userId: "fixture",
    onState: vi.fn(), storage: { getItem: () => saved, removeItem: vi.fn(), setItem: vi.fn() },
  });
  try {
    await vi.waitFor(() => expect(cal.state.persistence).toBe("saved"));
    const frame = frameWith({ session, getViewerPose: () => ({ emulatedPosition: false }),
      getPose: () => locatable && { emulatedPosition: false, transform: { matrix: anchorPose.toArray() } },
      trackedAnchors: new Set(locatable ? [anchor] : []),
    });
    expect(cal.frame(frame)).toBeNull();
    expect(cal.state.phase).toBe(locatable ? "verify" : "restoring");
    expect(cal.state.selected).toBeNull();
    const resolved = applyAlignmentHint(model, matchRoomAlignment(model, measured(), viewer),
      { kind: "wall", index: 0 }, tracking([2, 4.3, 0]))!;
    if (locatable) {
      expect(cal.verifyScanned(frame, resolved.fit, 0.02, [otherCheck, ...features], resolved.check)).toBe(false);
      expect(cal.verifyScanned(frame, { ...resolved.fit, matrix: resolved.fit.matrix.clone().setPosition(0, 0, 0) },
        0.02, features, resolved.check)).toBe(false);
      expect(cal.verifyScanned(frame, { ...resolved.fit,
        matrix: resolved.fit.matrix.clone().premultiply(new Matrix4().makeTranslation(0.03, 0, 0)) },
      0.03, features, resolved.check)).toBe(false);
      expect(cal.verifyScanned(frame, resolved.fit, resolved.errorM, features, resolved.check)).toBe(true);
    } else {
      expect(cal.acceptScanned(frame, resolved.fit, otherCheck, 0.02)).toBe(false);
      expect(cal.acceptScanned(frame, resolved.fit, resolved.check, resolved.errorM)).toBe(true);
      expect(cal.state.persistence).toBe("session");
    }
    assertMapsToTracking(cal.frame(frame)!);
  } finally {
    cal.dispose();
  }
});
