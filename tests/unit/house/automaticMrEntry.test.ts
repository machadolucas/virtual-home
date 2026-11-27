import { BoxGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import type { Room, Vec2 } from "@/house/model/types";
import type { HouseRuntime } from "@/house/runtime";
import { MixedPilot } from "@/house/xr/mixedPilot";
import { createSceneIndex, indexAsset } from "@/house/scene/SceneIndex";
import { frameCorners } from "@/house/xr/frameCorners";
import { buildAlignmentModel } from "@/house/xr/roomAlignment";
import { calibrationFeatures } from "@/house/xr/mixedCalibration";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = loadManifest(FIXTURE_DIR);
const room: Room = {
  ...manifest.rooms[0]!,
  id: "sample-room",
  name: "Workshop",
  floorId: "floor-a",
  ceilingHeight: 2.5,
  floorElevation: 0,
  footprint: {
    outer: [
      [0, 0],
      [4, 0],
      [4, 2],
      [3, 2],
      [3, 3],
      [0, 3],
    ],
    holes: [],
  },
};
const upstairs = { ...room, id: "upper-room", name: "Studio", floorId: "floor-b", floorElevation: 3 };
const smaller: Room = {
  ...room,
  id: "small-room",
  name: "Store",
  footprint: {
    outer: [
      [6, 0],
      [8, 0],
      [8, 2],
      [6, 2],
    ],
    holes: [],
  },
};
const identity = new Matrix4().toArray();
function point(p: Vec2, y: number) {
  return { x: p[0], y, z: p[1] };
}
const floor = (ring: Vec2[], y = 0) => ({
  semanticLabel: "floor",
  planeSpace: {},
  polygon: ring.map((p) => point(p, y)),
});
const wall = (a: Vec2, b: Vec2) => ({
  semanticLabel: "wall",
  planeSpace: {},
  polygon: [point(a, 0), point(b, 0), point(b, 2.5), point(a, 2.5)],
});
const outline = room.footprint.outer;
const full = () => [floor(outline), ...outline.map((a, i) => wall(a, outline[(i + 1) % outline.length]!))];
const partial = () => [
  floor([
    [0, 0],
    [2.4, 0],
    [2.4, 2],
    [0, 2],
  ]),
  wall([0, 0], [2.1, 0]),
  wall([0, 0], [0, 2.1]),
];

function fixture(rooms: Room[], saved = false, enabledFeatures?: string[]) {
  let now = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const runtime = {
    userId: "sample-member",
    index: null,
    manifest: buildManifestIndex({ ...manifest, rooms }),
    store: {
      getState: () => ({
        labelPreferences: { names: {} },
        fingerprint: "fingerprint",
        routes: [],
        explode: { enabled: false, gap: 0 },
      }),
    },
  } as unknown as HouseRuntime;
  const anchor = { anchorSpace: {}, delete: vi.fn() } as unknown as XRAnchor;
  const restore = vi.fn().mockResolvedValue(anchor);
  const item = JSON.stringify({
    handle: "sample-handle",
    modelOrigin: [0, 0, 0],
    check: {
      id: room.id + ":corner:0",
      roomId: room.id,
      label: "Fixture wall intersection",
      point: [0, 0, 0],
    },
  });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) =>
        saved && key === 'vh:mr-anchor:v1:["sample-member","fingerprint","floor-a"]' ? item : null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  });
  const session = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    inputSources: [],
    enabledFeatures,
    restorePersistentAnchor: restore,
  });
  const ref = new EventTarget() as XRReferenceSpace;
  const data = {
    session,
    detectedPlanes: new Set<ReturnType<typeof floor>>(),
    trackedAnchors: new Set([anchor]),
    tracked: true,
    anchorPose: new Matrix4(),
    viewer: { x: 1.1, y: 1.7, z: 1.1 },
    getViewerPose: () =>
      data.tracked
        ? {
            emulatedPosition: false,
            transform: { position: data.viewer, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          }
        : null,
    getPose: (space: XRSpace) => ({
      emulatedPosition: false,
      transform: { matrix: space === anchor.anchorSpace ? data.anchorPose.toArray() : identity },
    }),
  };
  const pilot = new MixedPilot(runtime, session as unknown as XRSession, ref);
  const tick = (elapsed = 15) => {
    now += elapsed;
    pilot.frame(data as unknown as XRFrame, elapsed / 1000, true, { supply: 0, extract: 0 });
  };
  const menu = () => pilot.menu("", () => {});
  const click = (label: string) => {
    const button = menu().rows.find((r) => r.label === label);
    expect(button?.act).toBeTypeOf("function");
    button!.act!(0);
  };
  const pass = () => {
    tick(510);
    for (let i = 0; i < rooms.length + 2; i++) tick();
  };
  return { pilot, runtime, data, ref, restore, tick, pass, menu, click };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("aligns by visible frame corners after the model loads, with no headset floor or wall scan", () => {
  const { pilot, runtime, data, pass, menu, click } = fixture([room]);
  const asset = manifest.assets[0]!;
  const elements = (["door", "window"] as const).map(kind => ({
    id: kind, kind, floorId: room.floorId, certainty: "measured" as const, sourceRefs: [],
    nodeRefs: [{ assetId: asset.id, nodeName: kind }], surfaceIds: [kind + "-reveal"],
  }));
  const surfaces = elements.map(element => ({
    id: element.surfaceIds[0]!, elementId: element.id, kind: "other" as const, role: "reveal", defaultColor: "#ffffff",
    nodeRefs: [{ assetId: asset.id, nodeName: element.surfaceIds[0]! }],
  }));
  const index = createSceneIndex(buildManifestIndex({ ...manifest, rooms: [room], elements, surfaces }));
  const root = new Group();
  const door = new Mesh(new BoxGeometry(1, 2, .06), new MeshBasicMaterial());
  const window = new Mesh(new BoxGeometry(.06, 1, .9), new MeshBasicMaterial());
  door.name = "door-reveal"; door.position.set(1, 1, 0);
  window.name = "window-reveal"; window.position.set(0, 1.55, 2);
  root.add(door, window);
  root.updateMatrixWorld(true);
  try {
    pilot.enter(room);
    pass();
    runtime.index = index;
    indexAsset(index, asset.id, root);
    pass();
    const features = frameCorners(buildAlignmentModel(room, calibrationFeatures({ ...manifest, rooms: [room] }, room.floorId), index));
    expect(features).toHaveLength(4);
    expect(features[0]).toMatchObject({ label: "Door 1 · top left", point: [.5, 2, 0] });
    expect(features[2]?.point[2]).toBeCloseTo(2.45);
    click("Use door or window frames");
    const source = { targetRayMode: "tracked-pointer", targetRaySpace: {} } as XRInputSource;
    const frame = data as unknown as XRFrame, ray = new Matrix4(), up = new Vector3(0, 1, 0);
    const getPose = data.getPose;
    data.getPose = space => space === source.targetRaySpace ? { emulatedPosition: false, transform: { matrix: ray.elements } } : getPose(space);
    for (const i of [0, 2, 1]) {
      menu().wallPicker!.choose(i);
      const feature = features[i]!;
      expect(menu().title).toBe(feature.label);
      const target = new Vector3(...feature.point);
      if (i === 0) {
        const shelf = { ...wall([.05,.7], [1.5,.7]), semanticLabel: "shelf" };
        data.detectedPlanes.add(shelf);
        pass();
        const from = new Vector3(.8, 1.3, 1.4);
        ray.lookAt(from, target, up).setPosition(from);
        expect(pilot.select(frame, source, null)).toBe(false);
        expect(menu().lines.join(" ")).toContain("obstructed");
        data.detectedPlanes.clear();
        pass();
      }
      for (const x of [.8, 1.2]) {
        const from = new Vector3(x, 1.3, 1.4);
        ray.lookAt(from, target, up).setPosition(from);
        expect(pilot.select(frame, source, null)).toBe(true);
      }
    }
    pass();
    expect(pilot.calibration?.state.errorM).toBeCloseTo(0);
    expect(pilot.readyTransform?.determinant()).toBeCloseTo(1);
    expect(pilot.overlay?.group.visible).toBe(true);
  } finally {
    pilot.dispose();
    for (const mesh of [door, window]) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
});

it("shows room choices immediately when the browser grants no scene geometry", () => {
  const { pilot, menu, click } = fixture([room], false, ["local-floor"]);
  try {
    expect(menu().rows.some((row) => row.id === room.id)).toBe(true);
    click(room.name);
    expect(pilot.readyTransform).toBeNull();
  } finally {
    pilot.dispose();
  }
});
it("enters a distinct room and reveals a verified unit-scale overlay with no controller or clicks", () => {
  const { pilot, data, pass, menu } = fixture([smaller, room]);
  try {
    data.detectedPlanes = new Set(full());
    expect(menu().title).toBe("Finding your room");
    pass();
    expect(pilot.room).toBeNull();
    expect(pilot.readyTransform).toBeNull();
    pass();
    pass();
    expect(pilot.room?.id).toBe(room.id);
    expect(pilot.calibration?.state.phase).toBe("ready");
    expect(pilot.readyTransform?.determinant()).toBeCloseTo(1);
    expect(pilot.overlay?.group.visible).toBe(true);
  } finally {
    pilot.dispose();
  }
});
it("finishes from a late native scan after a single wall stroke without asking for more marks", () => {
  const { pilot, data, tick, pass, click, menu } = fixture([room]);
  try {
    pilot.enter(room);
    tick();
    click("Trace wall bases");
    const hand = { targetRayMode: "tracked-pointer", targetRaySpace: {} } as XRInputSource;
    Object.assign(data.session, { inputSources: [hand] });
    const frame = data as unknown as XRFrame;
    const ray = new Matrix4();
    const initialPose = data.getPose;
    data.getPose = space => space === hand.targetRaySpace
      ? { emulatedPosition: false, transform: { matrix: ray.toArray() } } : initialPose(space);
    const from = new Vector3(1.1, 1.2, 1.1), up = new Vector3(0, 1, 0);
    const aim = (x: number) => ray.lookAt(from, new Vector3(x, 0, 0), up).setPosition(from);
    aim(0.45);
    expect(pilot.beginWallTrace(frame, hand)).toBe(true);
    for (let i = 1; i <= 12; i++) { aim(0.45 + i / 10); tick(); }
    expect(pilot.finishWallTrace(frame, hand)).toBe(true);
    pass();
    expect(menu().title).toContain("1 marked");
    expect(pilot.readyTransform).toBeNull();
    data.detectedPlanes = new Set(full());
    pass();
    expect(pilot.readyTransform).not.toBeNull();
    expect(pilot.overlay?.group.visible).toBe(true);
  } finally {
    pilot.dispose();
  }
});
it("keeps identical floors in the chooser and respects a manual room selection", () => {
  const { pilot, data, pass, click, menu } = fixture([room, upstairs]);
  try {
    data.detectedPlanes = new Set(full());
    pass();
    pass();
    pass();
    expect(pilot.room).toBeNull();
    expect(menu().rows.map((r) => r.id)).toContain(upstairs.id);
    click(upstairs.name);
    pass();
    expect(pilot.room?.id).toBe(upstairs.id);
    click("Choose another room");
    pass();
    pass();
    expect(pilot.room).toBeNull();
    expect(menu().rows.map((r) => r.id)).toContain(room.id);
  } finally {
    pilot.dispose();
  }
});
it("restores a floor anchor once and checks its saved corner against two native walls and the floor", async () => {
  const { pilot, data, pass, restore, ref, tick } = fixture([room, upstairs], true);
  try {
    await Promise.resolve();
    data.detectedPlanes = new Set(partial());
    pass();
    expect(pilot.room).toBeNull();
    ref.dispatchEvent(new Event("reset"));
    pass();
    expect(pilot.room).toBeNull();
    pass();
    pass();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(pilot.room?.id).toBe(room.id);
    expect(pilot.calibration?.state.phase).toBe("ready");
    data.tracked = false;
    tick();
    expect(pilot.readyTransform).toBeNull();
    data.tracked = true;
    data.detectedPlanes.clear();
    pass();
    expect(pilot.readyTransform).toBeNull();
    data.detectedPlanes = new Set(partial());
    pass();
    expect(pilot.calibration?.state.phase).toBe("ready");
  } finally {
    pilot.dispose();
  }
});
it.each(["offset", "missing floor", "untracked anchor"])(
  "keeps a partial scan hidden with %s",
  async (failure) => {
    const { pilot, data, pass } = fixture([room, upstairs], true);
    try {
      await Promise.resolve();
      data.detectedPlanes = new Set(partial());
      if (failure === "offset") data.anchorPose.makeTranslation(0.08, 0, 0);
      if (failure === "missing floor") data.detectedPlanes = new Set(partial().slice(1));
      if (failure === "untracked anchor") data.trackedAnchors.clear();
      pass();
      pass();
      pass();
      expect(pilot.room).toBeNull();
      expect(pilot.readyTransform).toBeNull();
    } finally {
      pilot.dispose();
    }
  },
);
it("waits for a second independent native fit before replacing a stale anchor in a selected room", async () => {
  const { pilot, data, pass, click } = fixture([room], true);
  try {
    await Promise.resolve();
    data.anchorPose.makeTranslation(0.8, 0, 0);
    data.detectedPlanes = new Set(full());
    click("Choose room myself");
    click(room.name);
    pass();
    expect(pilot.readyTransform).toBeNull();
    pass();
    pass();
    expect(pilot.calibration?.state.phase).toBe("ready");
    expect(pilot.readyTransform?.elements[12]).toBeCloseTo(0);
  } finally {
    pilot.dispose();
  }
});

it("keeps registration through a doorway and stairs, even after leaving the original room scan", () => {
  const next: Room = { ...room, id: "workbench", name: "Workroom", footprint: {
    outer: [[4,0], [7,0], [7,2], [4,2]], holes: [] } };
  const upper = { ...next, floorId: "floor-b", id: "gallery", name: "Gallery", floorElevation: 3 };
  const { pilot, data, pass, tick, menu } = fixture([room, next, upper]);
  const walk = (x: number, y: number, frames = 8) => {
    data.viewer = {x, y, z: 1.1};
    for (let i = 0; i < frames; i++) tick(110);
  };
  try {
    pilot.enter(room);
    data.detectedPlanes = new Set(full());
    pass(); pass();
    const transform = pilot.readyTransform, calibration = pilot.calibration, downstairs = pilot.overlay;
    expect(transform).toBeTruthy();
    data.detectedPlanes.clear();
    walk(4.06, 1.65);
    expect(pilot.room).toBe(room);
    walk(4.65, 1.65, 2);
    expect(pilot.room).toBe(room);
    walk(4.65, 1.65);
    expect(pilot.room).toBe(next);
    expect(pilot.calibration).toBe(calibration);
    expect(pilot.readyTransform).toBe(transform);
    expect(pilot.overlay).toBe(downstairs);
    expect(menu().lines.join(" ")).toContain("Alignment checked in Workshop");
    walk(4.65, .7);
    expect(pilot.room).toBe(next);
    walk(4.65, 3.2, 12);
    expect(pilot.betweenRooms).toBe(true);
    expect(pilot.overlay?.group.visible).toBe(false);
    walk(4.65, 4.69);
    expect(pilot.room).toBe(upper);
    expect(pilot.betweenRooms).toBe(false);
    expect(pilot.overlay).not.toBe(downstairs);
    expect(pilot.overlay?.group.visible).toBe(true);
    expect(pilot.readyTransform).toBe(transform);
    expect(pilot.calibration).toBe(calibration);
    data.tracked = false;
    tick(110);
    expect(pilot.readyTransform).toBeNull();
    expect(pilot.overlay?.group.visible).toBe(false);
    expect(pilot.room).toBe(upper);
  } finally {
    pilot.dispose();
  }
});
