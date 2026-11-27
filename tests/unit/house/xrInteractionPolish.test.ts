import { afterEach, describe, expect, it, vi } from "vitest";
import * as T from "three";
import { TargetHighlight } from "@/house/xr/pointers";
import { HeadsetPanel, type PanelPage } from "@/house/xr/panel";
import { layoutPanel, PANEL_WIDTH, scrollThumb } from "@/house/xr/panelLayout";
import { WalkWorld } from "@/house/xr/walkWorld";
import { landFacing, WalkElevation } from "@/house/xr/navigation";
import { FrameBudget, WalkAppearance } from "@/house/xr/visuals";
import { HouseSession } from "@/house/xr/session";
import { createRuntime } from "@/house/runtime";
import { createHouseStore } from "@/house/store/createHouseStore";
import { createMemoryDataApi } from "@/house/store/dataApi";
import { Tabletop } from "@/house/xr/tabletop";
import { TeleportArc } from "@/house/xr/travel";
import { MixedPilot } from "@/house/xr/mixedPilot";
import { WalkHistory } from "@/house/xr/wayfinding";
import { SolidInterior } from "@/house/xr/solidInterior";
import { buildScene } from "./sceneFromGlb";
import { FIXTURE_DIR } from "./glb";
import type { Surface } from "@/house/model/types";

function canvas() {
  const ctx = {
    fillRect: vi.fn(),
    fillText: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    measureText: (s: string) => ({ width: s.length * 10 }),
  };
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => ctx }) });
  return ctx;
}
function flat() {
  const { index, scene } = buildScene(FIXTURE_DIR);
  index.pickables = [];
  index.surfaceMesh.clear();
  function box(id: string, size: T.Vector3, position: T.Vector3, role: string) {
    const mesh = new T.Mesh(new T.BoxGeometry(size.x, size.y, size.z), new T.MeshStandardMaterial());
    mesh.position.copy(position);
    scene.add(mesh);
    mesh.updateWorldMatrix(true, false);
    index.pickables.push(mesh);
    index.meshSurfaceId.set(mesh, id);
    index.surfaceMesh.set(id, mesh);
    index.manifest.surfaces.set(id, { id, kind: role === "paving" ? "floor" : "other", role } as Surface);
    return mesh;
  }
  const floor = box("paved-test", new T.Vector3(100, 0.1, 100), new T.Vector3(0, -0.05, 0), "paving");
  return { index, scene, box, floor };
}
function sessionFixture(configure?: (layout: ReturnType<typeof flat>) => void, mode: "vr" | "mr" | "survey" = "vr") {
  canvas();
  const layout = flat();
  configure?.(layout);
  const { scene, index } = layout;
  const store = createHouseStore(),
    runtime = createRuntime({ base: "/fixture", store, dataApi: createMemoryDataApi() });
  runtime.index = index;
  runtime.manifest = index.manifest;
  runtime.scene = scene;
  const axes = [0, 0, 0, 0],
    source = { targetRayMode: "tracked-pointer", handedness: "right", gamepad: { axes }, targetRaySpace: {} };
  const inputs = Object.assign(new EventTarget(), { inputSources: [source], visibilityState: "visible" });
  const matrix = new T.Matrix4().makeRotationX(-0.45).setPosition(0, 1.25, -0.1).toArray();
  const frame = {
    session: inputs,
    getViewerPose: () => ({
      transform: { position: { x: 0, y: 1.7, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      views: [],
    }),
    getPose: () => ({ transform: { matrix } }),
  };
  const active = new HouseSession(
    runtime,
    inputs as unknown as XRSession,
    mode,
    new EventTarget() as XRReferenceSpace,
  );
  let time = 2000;
  vi.spyOn(performance, "now").mockImplementation(() => time);
  const render = (dt = 0.014) => {
    time += dt * 1000;
    active.frame({ render() {} } as unknown as T.WebGLRenderer, frame as unknown as XRFrame, dt, {
      motion: true,
      rates: { supply: 0, extract: 0 },
      fans: "",
    });
  };
  return { active, render, axes, inputs, source, frame, scene, index };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Quest motion and pointing", () => {
  it("undoes completed teleports one at a time with right B and preserves the original heading", () => {
    const { active, source, render, axes, inputs, frame } = sessionFixture();
    const buttons = Array.from({length: 6}, () => ({pressed: false}));
    Object.assign(source, {profiles: ["meta-quest-touch-plus"]});
    Object.assign(source.gamepad, {mapping: "xr-standard", buttons});
    render();
    const origin = active.rig.position.clone();
    for (let i = 0; i < 2; i++) {
      axes[3] = -1; render(); render();
      axes[3] = 0; render(); render(.12); render(.15);
    }
    const after = active.rig.position.clone();
    buttons[5]!.pressed = true;
    render(); render(.12); render(.15);
    const returned = active.rig.position.clone();
    expect(returned.z).toBeGreaterThan(after.z + .5);
    expect(returned.z).toBeLessThan(origin.z - .5);
    render(.5);
    expect(active.rig.position.toArray()).toEqual(returned.toArray());
    buttons[5]!.pressed = false; render();
    axes[2] = 1; for (let i = 0; i < 30; i++) render(.014);
    axes[2] = 0; render();
    expect(Math.abs(active.rig.rotation.y)).toBeGreaterThan(.4);
    buttons[5]!.pressed = true; render(); render(.12); render(.15);
    expect(active.rig.position.distanceTo(origin)).toBeLessThan(.0001);
    expect(active.rig.rotation.y).toBeCloseTo(0);
    buttons[5]!.pressed = false; render();
    inputs.dispatchEvent(Object.assign(new Event("squeeze"), {inputSource: source, frame}));
    render();
    const panel = active.rig.getObjectByName("vh-headset-menu")!;
    expect(panel.visible).toBe(true);
    buttons[5]!.pressed = true; render(); render(.1); // closing the menu does not travel
    expect(panel.visible).toBe(false);
    expect(active.rig.position.distanceTo(origin)).toBeLessThan(.0001);
    active.dispose();
  });

  it("keeps eight distinct return points in model space and copies the tracked position", () => {
    const history = new WalkHistory(), feet = new T.Vector3();
    const place = {id: "outside", name: "Yard", area: "Yard" as const};
    for (let i = 0; i < 10; i++) history.remember(feet.set(i, 0, 0), 0, place);
    history.remember(feet, 0, place);
    feet.set(30, 0, 0);
    const saved = []; while (history.previous) {
      const stop = history.previous; saved.push(stop.feet.x); history.returned(stop);
    }
    expect(saved).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it("rechecks a return point after the scene changes, and ignores B held while connecting", () => {
    let geometry!: ReturnType<typeof flat>;
    const {active, source, axes, render} = sessionFixture(layout => { geometry = layout; });
    const buttons = Array.from({length: 6}, () => ({pressed: false}));
    Object.assign(source.gamepad, {mapping: "xr-standard", buttons});
    render();
    const original = active.rig.position.clone();
    axes[3] = -1; render(); render(); axes[3] = 0; render(); render(.12); render(.15);
    const landed = active.rig.position.clone();
    expect(landed.distanceTo(original)).toBeGreaterThan(.6);
    buttons[5]!.pressed = true; render();
    Object.assign(source, {profiles: ["oculus-touch-v3"]});
    render(); render(.25);
    expect(active.rig.position.distanceTo(landed)).toBeLessThan(.001);
    buttons[5]!.pressed = false; render();
    geometry.box("new-obstacle", new T.Vector3(.35, 2, .35), original.clone().add(new T.Vector3(0, 1, 0)), "wall");
    geometry.index.pickables = [...geometry.index.pickables];
    render();
    buttons[5]!.pressed = true; render(); render(.12); render(.15);
    expect(active.rig.position.distanceTo(landed)).toBeLessThan(.001);
    expect(active.rig.getObjectByName("vh-xr-notice")?.visible).toBe(true);
    active.dispose();
  });

  it("respects open shells and hollow space within a closed collider", () => {
    const faces = (size: number) => {
      const geometry = new T.BoxGeometry(size, size, size).toNonIndexed();
      const positions = geometry.getAttribute("position");
      const triangles: T.Triangle[] = [];
      const vertex = (i: number) => new T.Vector3().fromBufferAttribute(positions, i);
      for (let i = 0; i < positions.count; i += 3)
        triangles.push(new T.Triangle(vertex(i), vertex(i + 1), vertex(i + 2)));
      geometry.dispose();
      return triangles;
    };
    const bounds = new T.Box3(new T.Vector3(-2,-2,-2), new T.Vector3(2,2,2));
    const body = new T.Box3(new T.Vector3(-.16,-.5,-.16), new T.Vector3(.16,.7,.16));
    const outer = faces(4);
    expect(new SolidInterior(bounds, outer).containsBody(body)).toBe(true);
    expect(new SolidInterior(bounds, outer.slice(2)).containsBody(body)).toBe(false);
    expect(new SolidInterior(bounds, [...outer, ...faces(2)]).containsBody(body)).toBe(false);
  });

  it.each(["mr", "survey"] as const)("handles the transition to verified %s and reopens setup when registration drops", mode => {
    let ready = true;
    vi.spyOn(MixedPilot.prototype, "frame").mockImplementation(function (this: MixedPilot) {
      this.room = this.rooms[0]!;
      this.readyTransform = ready ? new T.Matrix4() : null;
      Object.assign(this, {calibration: {state: {phase: ready ? "ready" : "verify", errorM: .024}, dispose() {}}});
    });
    vi.spyOn(MixedPilot.prototype, "menu").mockReturnValue({title: "Room", lines: [], rows: []});
    vi.spyOn(MixedPilot.prototype, "probePosition").mockReturnValue(null);
    const { active, render, inputs } = sessionFixture(undefined, mode);
    render();
    const panel = active.rig.getObjectByName("vh-headset-menu")!;
    const notice = active.rig.getObjectByName("vh-xr-notice")!;
    expect(panel.visible).toBe(mode === "survey");
    expect(notice.visible).toBe(mode === "mr");
    if (mode === "mr") {
      inputs.dispatchEvent(new Event("squeeze")); render();
      expect(panel.visible).toBe(true); // tools can stay open while already aligned
    }
    inputs.dispatchEvent(new Event("squeeze")); render();
    expect(panel.visible).toBe(false);
    ready = false; render();
    expect(panel.visible).toBe(true);
    expect(notice.visible).toBe(false);
    active.dispose();
  });

  it("ticks an actionable menu row once, confirms a click, and restores the vibration preference", () => {
    const prefs = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => prefs.get(key),
      setItem: (key: string, value: string) => prefs.set(key, value),
    });
    const { active, frame, inputs, source, render } = sessionFixture();
    const pulse = vi.fn();
    Object.assign(source.gamepad, { hapticActuators: [{ pulse }] });
    const send = (type: string) => inputs.dispatchEvent(Object.assign(new Event(type), { frame, inputSource: source }));
    render();
    send("squeeze");
    expect(pulse).toHaveBeenCalledExactlyOnceWith(0.7, 38);
    render();
    const panel = active["panel"];
    const layout = panel["layout"]!;
    const row = layout.rows.find(r => r.id === "rooms")!;
    const hit = { point: new T.Vector3(), x: row.x + row.width / 2, y: row.y + row.height / 2, row, scrollbar: false };
    const panelHit = vi.spyOn(panel, "hit").mockReturnValue(hit);
    for (let i = 0; i < 24; i++) render();
    expect(pulse.mock.calls).toEqual([[0.7, 38], [0.24, 16]]);
    send("selectstart");
    send("select");
    send("selectend");
    expect(active["page"]).toBe("destinations");
    expect(pulse.mock.calls.at(-1)).toEqual([0.7, 38]);
    panelHit.mockRestore();
    active["page"] = "comfort";
    const setting = active["menu"]({ motion: true, rates: { supply: 0, extract: 0 }, fans: "" })
      .rows.find(r => r.id === "controller-haptics")!;
    setting.act!(0);
    expect(prefs.get("vh.xr.haptics")).toBe("light");
    active.dispose();
  });

  it("finishes a held wall stroke on select and cancels a released or interrupted press", () => {
    const { active, frame, inputs, source, render } = sessionFixture(undefined, "mr");
    const pulse = vi.fn();
    Object.assign(source.gamepad, { hapticActuators: [{ pulse }] });
    render();
    const pilot = active["mixed"]!;
    vi.spyOn(pilot, "beginWallTrace").mockReturnValue(true);
    const finish = vi.spyOn(pilot, "finishWallTrace").mockReturnValue(true);
    const cancel = vi.spyOn(pilot, "cancelWallTrace");
    active["panel"].hide();
    const send = (name: string) =>
      inputs.dispatchEvent(Object.assign(new Event(name), { frame, inputSource: source }));
    send("selectstart");
    send("select");
    send("selectend");
    expect(finish).toHaveBeenCalledTimes(1);
    send("selectstart");
    send("selectend");
    expect(cancel).toHaveBeenCalled();
    send("selectstart");
    send("inputsourceschange");
    send("select");
    expect(finish).toHaveBeenCalledTimes(1);
    expect(pulse).toHaveBeenCalledExactlyOnceWith(0.7, 38);
    active.dispose();
  });
  it("restores both fit arrangements and the pinned step only after the original room verifies again", async () => {
    let verified = true,
      roomIndex = 0;
    const registration = new T.Matrix4();
    vi.spyOn(MixedPilot.prototype, "frame").mockImplementation(function (this: MixedPilot) {
      this.room = this.rooms[roomIndex]!;
      this.readyTransform = verified ? registration : null;
    });
    vi.spyOn(MixedPilot.prototype, "probePosition").mockReturnValue(null);
    vi.spyOn(MixedPilot.prototype, "menu").mockImplementation(() => ({
      title: "Check this room",
      lines: [],
      rows: [],
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(url.endsWith("/furnishings") ? { furnishings: [] } : { proposals: [] }),
      ),
    );
    const { active, render } = sessionFixture(undefined, "mr");
    const draw = vi.spyOn(HeadsetPanel.prototype, "draw");
    const current = () => draw.mock.lastCall![0];
    render();
    const room = active["mixed"]!.room!;
    active["pinStep"]({
      target: {
        kind: "equipment",
        id: "unit",
        name: "Fixture",
        assetId: "asset",
        placementId: "unit",
        endpointId: null,
        routeIds: [],
        roomId: room.id,
        floorId: room.floorId,
        position: [2, 1, 2],
        roomName: room.name,
        floorName: null,
        category: null,
        modelName: null,
        servedFixtures: [],
      },
      title: "Keep this step",
      taskTitle: "Service",
      body: "Fixture instructions",
      index: 0,
      total: 1,
    });
    active["openPlanner"](room);
    render();
    const planner = active["planner"]!;
    await vi.waitFor(() =>
      expect(planner.menu(() => {}).rows.find((r) => r.id === "A")?.detail).not.toBe("Awaiting records"),
    );
    current().rows.find((r) => r.id === "yaw")!.act!(0.75);
    current().rows.find((r) => r.id === "B")!.act!(0);
    render(0.25);
    current().rows.find((r) => r.id === "yaw")!.act!(0.25);
    render(0.25);
    expect(current().rows.find((r) => r.id === "yaw")?.label).toContain("-90°");

    verified = false;
    render();
    expect(current().title).toBe("Check this room");
    expect(current().lines.join(" ")).toContain("Fit planner is paused");
    expect(planner.group.visible).toBe(false);
    expect(active["pinSpace"].visible).toBe(false);
    expect(current().rows.some((r) => r.id === "place")).toBe(false);
    // The recovery footer and even a verified neighbouring room cannot apply this room's work.
    draw.mock.lastCall![1]();
    render();
    roomIndex = 1;
    verified = true;
    render();
    expect(current().title).toBe("Resume your work");
    expect(planner.group.visible).toBe(false);
    expect(active["pinSpace"].visible).toBe(false);

    roomIndex = 0;
    registration.makeTranslation(3, 0, -2);
    render();
    expect(current().title).toBe("Fit and clearance");
    expect(current().rows.find((r) => r.id === "B")?.active).toBe(true);
    expect(current().rows.find((r) => r.id === "yaw")?.label).toContain("-90°");
    expect(planner.group.visible).toBe(true);
    expect(planner.group.matrix.equals(registration)).toBe(true);
    expect(active["pinSpace"].visible).toBe(true);
    expect(active["pinSpace"].matrix.equals(registration)).toBe(true);
    expect(active["pinned"]?.title).toBe("Keep this step");
    current().rows.find((r) => r.id === "A")!.act!(0);
    render(0.25);
    expect(current().rows.find((r) => r.id === "yaw")?.label).toContain("90°");

    // Placing with the menu out of view also resumes with the menu out of view.
    current().rows.find((r) => r.id === "place")!.act!(0);
    verified = false;
    render();
    expect(planner.point(new T.Ray())).toBeNull();
    verified = true;
    render();
    expect(active["panel"].mesh.visible).toBe(false);
    expect(planner.moving).toBe(true);
    active.dispose();
  });

  it("puts a blocked marker at the tabletop ray and confirms only a completed landing", () => {
    const { active, inputs, source, frame, render, index } = sessionFixture();
    const buzz = vi.fn(async () => true);
    Object.assign(source.gamepad, { hapticActuators: [{ pulse: buzz }] });
    render();
    active["openTabletop"]();
    render();
    active["panel"].hide();
    const table = active["map"]!,
      world = active["world"]!;
    const destination = new T.Vector3(3, 0, 3);
    const hit = {
      point: new T.Vector3(0.12, 1, -0.7),
      local: destination,
      room: index.manifest.rooms.values().next().value!,
      label: "Test room",
    };
    vi.spyOn(Tabletop.prototype, "hit").mockReturnValue(hit);
    const landing = vi.spyOn(world, "landingAt").mockReturnValue(null);
    const send = (kind: string) =>
      inputs.dispatchEvent(Object.assign(new Event(kind), { inputSource: source, frame }));
    const click = () => {
      send("selectstart");
      send("select");
      send("selectend");
    };
    render();
    const marker = table.group.getObjectByName("vh-blocked-landing")!;
    expect(marker.visible).toBe(true);
    expect(marker.getWorldPosition(new T.Vector3()).distanceTo(hit.point)).toBeLessThan(1e-6);
    click();
    render(0.12);
    expect(buzz).not.toHaveBeenCalled();
    expect(active["map"]).toBe(table);
    landing.mockReturnValue(destination);
    render(0.3);
    expect(marker.visible).toBe(false);
    const stand = vi.spyOn(world, "canStand").mockReturnValue(true);
    send("selectstart");
    stand.mockReturnValue(false);
    send("select");
    send("selectend");
    expect(active["map"]).toBe(table);
    expect(buzz).not.toHaveBeenCalled();
    stand.mockReturnValue(true);
    click();
    expect(buzz).not.toHaveBeenCalled();
    // Even a previously valid release may be obstructed at the last clearance check during the fade.
    stand.mockReturnValue(false);
    render(0.12);
    render(0.2);
    expect(buzz).not.toHaveBeenCalled();
    stand.mockReturnValue(true);
    active["openTabletop"]();
    render();
    active["panel"].hide();
    click();
    expect(buzz).not.toHaveBeenCalled();
    render(0.12);
    expect(buzz).toHaveBeenCalledTimes(1);
    active.dispose();
  });

  it("uses a blocked symbol for a full-size arc intersecting an obstacle", () => {
    const layout = flat(),
      world = new WalkWorld(layout.index),
      arc = new TeleportArc();
    const ray = new T.Ray(new T.Vector3(0, 1.2, 0), new T.Vector3(0, -0.8, -0.6));
    const check = vi.spyOn(world, "canStand").mockReturnValue(false);
    arc.aim(world, ray, 1.7);
    const blocked = arc.group.getObjectByName("vh-blocked-landing")!;
    expect(blocked.visible).toBe(true);
    expect(arc.landing).toBeNull();
    check.mockReturnValue(true);
    arc.aim(world, ray, 1.7);
    expect(blocked.visible).toBe(false);
    expect(arc.landing).toBeTruthy();
    arc.dispose();
    world.dispose();
  });

  it("repeats five stick teleports without panel or trigger, cancels on source change, and cleans up", () => {
    const { active, render, axes, inputs } = sessionFixture();
    render();
    const start = active.rig.position.clone();
    for (let i = 0; i < 5; i++) {
      const before = active.rig.position.z;
      axes[3] = -1;
      render();
      render();
      axes[3] = 0;
      render();
      render(0.12);
      render(0.13);
      expect(active.rig.position.z).toBeLessThan(before - 0.5);
    }
    expect(active.rig.position.z).toBeLessThan(start.z - 5);
    const before = active.rig.position.clone();
    axes[3] = -1;
    render();
    inputs.dispatchEvent(new Event("inputsourceschange"));
    axes[3] = 0;
    render();
    render(0.24);
    expect(active.rig.position.toArray()).toEqual(before.toArray());
    active.dispose();
  });
  it("previews travel on a held hand pinch, ignores a tap or cancelled pinch, and travels on release", () => {
    const { active, render, source, frame, inputs } = sessionFixture();
    Object.assign(source, { hand: new Map(), gamepad: undefined });
    const event = (type: string) =>
      inputs.dispatchEvent(Object.assign(new Event(type), { inputSource: source, frame }));
    render();
    const initial = active.rig.position.clone();
    event("selectstart");
    render(0.055);
    event("select");
    event("selectend");
    render(0.24);
    expect(active.rig.position.toArray()).toEqual(initial.toArray());
    event("selectstart");
    render(0.26);
    event("selectend");
    render(0.24);
    expect(active.rig.position.toArray()).toEqual(initial.toArray());
    event("selectstart");
    render(0.26);
    event("select");
    event("selectend");
    render(0.11);
    render(0.14);
    expect(initial.z - active.rig.position.z).toBeGreaterThan(0.5);
    active.dispose();
  });
  it("previews from the left ray, steers the arrival arrow during a trigger hold, and lands facing that heading", () => {
    const { active, render, source, frame, inputs, axes, scene } = sessionFixture();
    source.handedness = "left";
    const event = (type: string) =>
      inputs.dispatchEvent(Object.assign(new Event(type), { inputSource: source, frame }));
    render();
    const landing = scene.getObjectByName("vh-teleport-landing")!;
    expect(landing.parent?.visible).toBe(true);
    expect(landing.visible).toBe(true);
    const before = active.rig.position.clone();
    event("selectstart");
    axes[2] = 1;
    render();
    const arrow = new T.Vector3(0, 1, 0).applyQuaternion(landing.quaternion);
    expect(arrow.x).toBeCloseTo(1, 5);
    expect(active.rig.position.toArray()).toEqual(before.toArray());
    axes[2] = 0;
    render();
    const aim = landing.position.clone();
    event("select");
    event("selectend");
    render(0.12);
    render(0.13);
    expect(active.rig.position.x).toBeCloseTo(aim.x, 5);
    expect(active.rig.position.z).toBeCloseTo(aim.z, 5);
    expect(new T.Vector3(0, 0, -1).applyQuaternion(active.rig.quaternion).x).toBeCloseTo(1, 5);
    const landed = active.rig.position.clone();
    event("selectstart");
    inputs.dispatchEvent(new Event("inputsourceschange"));
    event("select");
    event("selectend");
    render(0.26);
    expect(active.rig.position.toArray()).toEqual(landed.toArray());
    active.dispose();
  });
  it("keeps the actual tracked head over the landing when rotating a room-scale rig", () => {
    const rig = new T.Group();
    rig.rotation.y = -0.8;
    const head = new T.Vector3(1.2, 1.65, -0.7);
    const orientation = new T.Quaternion().setFromEuler(new T.Euler(0.12, 0.7, 0, "YXZ"));
    landFacing(rig, head, orientation, new T.Vector3(-4, 3, 10), Math.PI);
    expect(rig.localToWorld(head.clone()).toArray()).toEqual([
      expect.closeTo(-4, 6),
      expect.closeTo(4.65, 6),
      expect.closeTo(10, 6),
    ]);
    const gaze = new T.Vector3(0, 0, -1).applyQuaternion(orientation).applyQuaternion(rig.quaternion);
    expect(gaze.z).toBeGreaterThan(0.98);
  });
  it("moves with the left stick while retaining head height", () => {
    const { active, render, source, axes } = sessionFixture();
    source.handedness = "left";
    render();
    const before = active.rig.position.clone();
    axes[3] = -1;
    for (let i = 0; i < 15; i++) render(0.02);
    expect(before.z - active.rig.position.z).toBeCloseTo(0.465, 2);
    expect(active.rig.position.y).toBeCloseTo(0);
    active.dispose();
  });

  it("smooth-turns at the same speed at 72 and 90 Hz about the tracked head and pauses for the menu", () => {
    function turnFor(hz: number) {
      const { active, axes, frame, render, inputs } = sessionFixture();
      const head = new T.Vector3(0.42, 1.7, -0.28);
      frame.getViewerPose = () => ({
        transform: { position: head, orientation: { x: 0, y: 0, z: 0, w: 1 } },
        views: [],
      });
      render(1 / hz);
      const standing = active.rig.localToWorld(head.clone());
      axes[2] = 1;
      for (let i = 0; i < hz / 2; i++) render(1 / hz);
      expect(active.rig.localToWorld(head.clone()).distanceTo(standing)).toBeLessThan(1e-7);
      const yaw = active.rig.rotation.y;
      inputs.dispatchEvent(new Event("squeeze"));
      render(1 / hz);
      expect(active.rig.rotation.y).toBe(yaw);
      inputs.dispatchEvent(new Event("squeeze"));
      render(1 / hz);
      expect(active.rig.rotation.y).toBe(yaw);
      axes[2] = 0;
      render(1 / hz);
      axes[2] = -1;
      render(1 / hz);
      expect(active.rig.rotation.y).toBeGreaterThan(yaw);
      active.dispose();
      return yaw;
    }
    expect(turnFor(72)).toBeCloseTo(-Math.PI / 4, 6);
    expect(turnFor(90)).toBeCloseTo(-Math.PI / 4, 6);
  });

  it("loads the saved snap mode and saves the turn controls from the comfort menu", () => {
    const storage = new Map([
      ["vh.xr.turnMode", "snap"],
      ["vh.xr.turnSpeed", "50"],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const { active, render, axes } = sessionFixture();
    render();
    axes[2] = 1;
    render();
    render(0.12);
    render(0.15);
    expect(active.rig.rotation.y).toBeCloseTo(-Math.PI / 6);
    render(0.12);
    render(0.15);
    expect(active.rig.rotation.y).toBeCloseTo(-Math.PI / 6);
    const menu = () => active["menu"]({ motion: true, rates: { supply: 0, extract: 0 }, fans: "" });
    menu()
      .rows.find(({ id }) => id === "comfort")
      ?.act?.(0.5);
    expect(menu().rows.find(({ id }) => id === "snap-turn")?.active).toBe(true);
    menu()
      .rows.find(({ id }) => id === "smooth-turn")
      ?.act?.(0.5);
    const slider = menu().rows.find(({ id }) => id === "smooth-turn-speed");
    expect(slider?.label).toBe("Turn speed · 50°/s");
    slider?.act?.(0.5);
    expect(storage.get("vh.xr.turnMode")).toBe("smooth");
    expect(storage.get("vh.xr.turnSpeed")).toBe("80");
    active.dispose();
  });

  it.each([72, 90, 120])("walks real stepped collision geometry both ways and settles at %i Hz", (hz) => {
    const { active, render, axes, source } = sessionFixture(({ index, box }) => {
      const room = index.manifest.rooms.values().next().value!;
      index.manifest.rooms.clear();
      index.manifest.rooms.set(room.id, { ...room, kind: "room", floorElevation: 0, footprint: {
        outer: [[-1, -1], [1, -1], [1, 1], [-1, 1]], holes: [],
      } });
      for (let i = 0; i < 4; i++) {
        const height = .18 * (i + 1), depth = i === 3 ? 1.5 : .32;
        box(`tread-${i}`, new T.Vector3(1.6, height, depth), new T.Vector3(0, height / 2, -.42 - i * .32 - depth / 2), "step");
      }
    });
    source.handedness = "left";
    const dt = 1 / hz;
    render(dt);
    const elevation = active["elevation"];
    const origin = active.rig.position.clone();
    expect(origin.y).toBeCloseTo(0, 8);
    axes[3] = -1;
    for (let i = 0; i < hz && elevation.floor < .1; i++) render(dt);
    expect(elevation.floor).toBeCloseTo(.18);
    expect(active.rig.position.y).toBeGreaterThan(0);
    // A full-sized riser starts gently, accelerates, then settles even if the stick is released.
    const onset = active.rig.position.y;
    expect(onset).toBeLessThan(.012);
    axes[3] = 0;
    const stopped = active.rig.position.z;
    render(dt);
    expect(active.rig.position.y - onset).toBeGreaterThan(onset);
    for (let i = 0; i < hz / 3; i++) render(dt);
    expect(active.rig.position.z).toBe(stopped);
    expect(active.rig.position.y).toBe(elevation.floor);
    axes[3] = -1;
    for (let i = 0; i < hz; i++) render(dt);
    expect(elevation.floor).toBeCloseTo(.72);
    expect(active.rig.position.y).toBe(elevation.floor);
    axes[3] = 1;
    for (let i = 0; i < hz && elevation.floor > .55; i++) render(dt);
    expect(elevation.floor).toBeCloseTo(.54);
    expect(.72 - active.rig.position.y).toBeLessThan(.012);
    for (let i = 0; i < hz; i++) render(dt);
    axes[3] = 0;
    for (let i = 0; i < hz / 3; i++) render(dt);
    expect(elevation.floor).toBeCloseTo(0, 8);
    expect(active.rig.position.y).toBe(elevation.floor);
    active["blink"](new T.Vector3(0, .72, -2));
    render(.12);
    expect(elevation.floor).toBe(.72);
    expect(active.rig.position.y).toBe(.72);
    active.dispose();
  });

  it("brakes gradually on a mid-step reversal, then cancels that motion on teleport", () => {
    const elevation = new WalkElevation();
    const dt = 1 / 90;
    elevation.floor = .20;
    for (let i = 0; i < 4; i++) elevation.follow(dt);
    const atReversal = elevation.rendered;
    elevation.floor = 0;
    // Momentum carries over from the ascent, then eases into the new direction.
    expect(elevation.follow(dt)).toBeGreaterThan(atReversal);
    for (let i = 0; i < 10; i++) elevation.follow(dt);
    expect(elevation.rendered).toBeLessThan(atReversal);
    expect(elevation.rendered).toBeGreaterThan(0);
    elevation.arrive(2.5);
    expect(elevation.follow(dt)).toBe(2.5);
  });

  it("checks transitional eye height before descending under a low lintel", () => {
    const { index, box } = flat();
    box("lower-step", new T.Vector3(.8, .18, 1), new T.Vector3(-.4, .09, 0), "step");
    box("low-lintel", new T.Vector3(.4, .1, 1), new T.Vector3(.4, 1.9, 0), "roof");
    const world = new WalkWorld(index);
    const edge = new T.Vector3(.09, 0, 0);
    expect(world.step(edge, .04, 0, 1.7, .14)).toBeNull();
    expect(world.step(edge, .04, 0, 1.7, 0)?.y).toBeCloseTo(0);
  });

  it("keeps landing inside the terrain boundary and reserves headroom and wall clearance", () => {
    const { index, box } = flat();
    box("wall", new T.Vector3(0.1, 2.7, 4), new T.Vector3(2, 1.35, 0), "exterior");
    box("lintel", new T.Vector3(2, 0.2, 2), new T.Vector3(0, 1.6, 3), "roof");
    box("step", new T.Vector3(0.3, 0.2, 2), new T.Vector3(-2, 0.1, 0), "step");
    const w = new WalkWorld(index);
    expect(w.yard).not.toBeNull();
    expect(w.step(new T.Vector3(49.9, 0, 0), 0.1, 0, 1.7)).toBeNull();
    expect(w.step(new T.Vector3(1.7, 0, 0), 0.14, 0, 1.7)).toBeNull();
    // A named destination can pick a nearby clear spot. A tabletop pin must land exactly where aimed.
    expect(w.landingAt(1.95, 0, 0, 1.7)).toBeNull();
    expect(w.landing(new T.Vector3(1.95, 0, 0), 1.7)).not.toBeNull();
    expect(w.canStand(new T.Vector3(0, 0, 3), 1.7)).toBe(false);
    expect(w.step(new T.Vector3(-1.82, 0, 0), -0.14, 0, 1.7)?.y).toBeCloseTo(0.2);
  });
  it("chooses open-sky yard ground beyond every storey, with traversable exits in eight directions", () => {
    const { index, box } = flat();
    const upper = [...index.manifest.rooms.values()][0]!;
    index.manifest.rooms.clear();
    index.manifest.rooms.set(upper.id, {
      ...upper,
      floorElevation: 3,
      footprint: {
        holes: [],
        outer: [
          [-3, -3],
          [-3, 3],
          [3, 3],
          [3, -3],
        ],
      },
    });
    box("canopy", new T.Vector3(12, 0.15, 12), new T.Vector3(0, 3.3, 0), "roof");
    const world = new WalkWorld(index);
    const yard = world.yardLanding(1.8)!;
    expect(Math.max(Math.abs(yard.x), Math.abs(yard.z))).toBeGreaterThan(6);
    for (let i = 0; i < 8; i++) {
      let p = yard;
      for (let j = 0; j < 5; j++) {
        const next = world.step(
          p,
          0.22 * Math.sin((i * Math.PI) / 4),
          0.22 * Math.cos((i * Math.PI) / 4),
          1.8,
        );
        expect(next).not.toBeNull();
        p = next!;
      }
    }
    box("covered-site", new T.Vector3(105, 0.1, 105), new T.Vector3(0, 4, 0), "roof");
    const covered = new WalkWorld(index);
    expect(covered.yardLanding(1.7)).toBeNull();
    world.dispose();
    covered.dispose();
  });
  it("clears low foundation overlap only beside an authored threshold and preserves tall obstacles", () => {
    const { index, box } = flat();
    box("plinth", new T.Vector3(5, 0.55, 0.3), new T.Vector3(0, 0.1, 0), "plinth");
    const before = new WalkWorld(index);
    expect(before.canStand(new T.Vector3(), 1.7)).toBe(false);
    box("sill", new T.Vector3(0.85, 0.03, 0.32), new T.Vector3(0, 0.17, 0), "door-threshold");
    const after = new WalkWorld(index);
    expect(after.canStand(new T.Vector3(), 1.7)).toBe(true);
    expect(after.canStand(new T.Vector3(2, 0, 0), 1.7)).toBe(false);
    box("wall", new T.Vector3(0.15, 2.3, 1), new T.Vector3(0, 1, 0), "exterior");
    const wall = new WalkWorld(index);
    expect(wall.canStand(new T.Vector3(), 1.7)).toBe(false);
    before.dispose();
    after.dispose();
    wall.dispose();
  });
  it("latches a multi-part door open without changing its transform or shared material, including across a scene refresh", () => {
    const { index, box } = flat();
    const door = box("door", new T.Vector3(1, 2, 0.07), new T.Vector3(2, 1, 0), "door-leaf");
    const parent = new T.Group();
    parent.position.set(-2, 0, 0);
    door.parent!.add(parent);
    parent.add(door);
    const original = door.material,
      before = door.matrix.clone(),
      opened = new Set<string>();
    let w = new WalkWorld(index, opened);
    expect(w.canStand(new T.Vector3(), 1.7)).toBe(false);
    w.updateDoors(new T.Vector3(0, 1.7, 0.9), 0.4);
    expect(door.matrix.equals(before)).toBe(true);
    expect(door.material.visible).toBe(false);
    expect(original.visible).toBe(true);
    w.updateDoors(new T.Vector3(8, 1.7, 0), 1);
    expect(w.canStand(new T.Vector3(), 1.7)).toBe(true);
    w.dispose();
    expect(door.material).toBe(original);
    w = new WalkWorld(index, opened);
    expect(door.material.visible).toBe(false);
    expect(w.canStand(new T.Vector3(), 1.7)).toBe(true);
    w.dispose();
    expect(door.matrix.toArray()).toEqual(before.toArray());
    expect(door.material).toBe(original);
  });
  it("opens a distant VR door on trigger without moving the viewer or operating equipment", () => {
    let leaf!: T.Mesh<T.BoxGeometry, T.MeshStandardMaterial>;
    const { active, source, inputs, frame, render } = sessionFixture((layout) => {
      layout.index.manifest.rooms.clear();
      leaf = layout.box("entry", new T.Vector3(2, 2.3, 0.06), new T.Vector3(0, 1.15, -2), "door-leaf");
    });
    source.handedness = "left";
    render();
    expect(leaf.material.visible).toBe(true);
    const before = active.rig.position.clone();
    for (const name of ["selectstart", "select", "selectend"])
      inputs.dispatchEvent(Object.assign(new Event(name), { inputSource: source, frame }));
    for (let i = 0; i < 8; i++) render(0.04);
    expect(leaf.material.visible).toBe(false);
    expect(active.rig.position.toArray()).toEqual(before.toArray());
    active.dispose();
    expect(leaf.material.visible).toBe(true);
  });
  it("adds ground grain and returns original materials", () => {
    const { index, floor } = flat(),
      m = floor.material;
    const visual = new WalkAppearance(index);
    expect(floor.material).not.toBe(m);
    visual.detail(false);
    expect(floor.material).toBe(m);
    visual.detail(true);
    visual.dispose();
    expect(floor.material).toBe(m);
  });
  it("shades the VR sky from authored daylight, twilight and night without adding any lights", () => {
    const { index, scene } = flat();
    const visual = new WalkAppearance(index);
    let environment = new T.HemisphereLight("#dbe9f4", "#b8b8aa", 1.08);
    scene.add(environment, visual.sky);
    const horizon = visual.sky.material.uniforms.vhHorizon!.value as T.Color;
    const zenith = visual.sky.material.uniforms.vhZenith!.value as T.Color;
    const energy = (color: T.Color) => color.r + color.g + color.b;
    visual.updateSky(scene, 0);
    const day = energy(horizon);
    const dayZenith = energy(zenith);

    environment.color.set("#9890ac");
    environment.groundColor.set("#7b7580");
    environment.intensity = 0.51;
    visual.updateSky(scene, 100);
    expect(energy(horizon)).toBe(day);
    visual.updateSky(scene, 500);
    const twilight = energy(horizon);
    expect(twilight).toBeLessThan(day);
    expect(energy(zenith)).toBeLessThan(dayZenith);

    environment.removeFromParent();
    environment = new T.HemisphereLight("#7187ad", "#56647a", 0.42);
    scene.add(environment);
    visual.updateSky(scene, 1_000);
    expect(energy(horizon)).toBeLessThan(twilight);
    expect(horizon.b).toBeGreaterThan(horizon.r);
    expect(scene.children.filter((child) => child instanceof T.Light)).toEqual([environment]);
    visual.dispose();
  });
  it("adds threshold and door-reveal contrast while preserving authored colors and maps", () => {
    const { index, box } = flat();
    const at = new T.Vector3();
    const size = new T.Vector3(1, 0.02, 0.2);
    const threshold = box("fixture-threshold", size, at, "door-threshold");
    const frame = box("fixture-frame", size, at, "reveal");
    const glass = box("fixture-window", size, at, "reveal");
    const door = [...index.manifest.elements.values()].find((element) => element.kind === "door")!;
    const window = [...index.manifest.elements.values()].find((element) => element.kind === "window")!;
    index.manifest.surfaces.get("fixture-frame")!.elementId = door.id;
    index.manifest.surfaces.get("fixture-window")!.elementId = window.id;
    const originals = [threshold.material, frame.material, glass.material];
    const map = new T.Texture();
    for (const m of originals) {
      m.color.set("#916e4e");
      m.map = map;
    }
    const visual = new WalkAppearance(index);
    expect(glass.material).toBe(originals[2]);
    for (const [i, mesh] of [threshold, frame].entries()) {
      expect(mesh.material).not.toBe(originals[i]);
      expect(mesh.material.map).toBe(map);
      expect(mesh.material.color.getHex()).toBe(originals[i]!.color.getHex());
      const shader = { uniforms: {}, fragmentShader: "#include <color_fragment>" } as Parameters<
        typeof mesh.material.onBeforeCompile
      >[0];
      mesh.material.onBeforeCompile(shader, {} as T.WebGLRenderer);
      expect(shader.fragmentShader).toContain(
        i === 0 ? "diffuseColor.rgb *= 1.14" : "diffuseColor.rgb *= 0.90",
      );
    }
    visual.detail(false);
    expect([threshold.material, frame.material, glass.material]).toEqual(originals);
    visual.detail(true);
    visual.dispose();
    expect([threshold.material, frame.material, glass.material]).toEqual(originals);
    map.dispose();
  });
  it("highlights the exact equipment instance or estimated span in the rig's coordinates", () => {
    const highlight = new TargetHighlight(),
      rig = new T.Group();
    rig.position.x = 3;
    rig.add(highlight.group);
    const geometry = new T.BoxGeometry(1, 1, 1);
    const material = new T.MeshBasicMaterial();
    const instances = new T.InstancedMesh(geometry, material, 2);
    instances.position.x = 1;
    instances.setMatrixAt(1, new T.Matrix4().makeTranslation(7, 0, -2));
    instances.updateMatrixWorld();
    highlight.equipment(instances, 1);
    const [body, line] = highlight.group.children as [T.Mesh, T.Line];
    highlight.group.updateWorldMatrix(true, true);
    expect(new T.Vector3().setFromMatrixPosition(body.matrixWorld).toArray()).toEqual([8, 0, -2]);
    expect(body.geometry).toBe(geometry);
    highlight.clear();
    highlight.route(
      rig,
      [
        [0, 1, -2],
        [3, 1, -2],
      ],
      true,
    );
    expect(body.visible).toBe(false);
    expect(line.visible).toBe(true);
    expect(line.material).toBeInstanceOf(T.LineDashedMaterial);
    expect(line.geometry.getAttribute("lineDistance").getX(1)).toBe(3);
    const released = vi.spyOn(geometry, "dispose");
    highlight.dispose();
    expect(released).not.toHaveBeenCalled();
    geometry.dispose();
    material.dispose();
    instances.dispose();
  });
  function panelFixture(page: PanelPage) {
    const paint = canvas();
    const panel = new HeadsetPanel();
    const home = vi.fn();
    const exit = vi.fn();
    const draw = () => panel.draw(page, home, exit);
    draw();
    const layout = layoutPanel(page, (value) => value.length * 10, home, exit);
    const ray = (x: number, y: number) => {
      const world = panel.mesh.localToWorld(new T.Vector3(x / PANEL_WIDTH - 0.5, 0.5 - y / layout.height, 0));
      return new T.Raycaster(world.clone().add(new T.Vector3(0, 0, 1)), new T.Vector3(0, 0, -1));
    };
    return { panel, draw, paint, layout, ray, home, exit };
  }
  const center = (rect: { x: number; y: number; width: number; height: number }) =>
    [rect.x + rect.width / 2, rect.y + rect.height / 2] as const;

  it("uses one layout for hover and click, retains small release jitter and cancels by tracking loss", () => {
    const first = vi.fn(),
      second = vi.fn();
    const { panel, paint, draw, ray, layout } = panelFixture({
      title: "Fixture menu",
      lines: [],
      rows: [
        { label: "One", act: first },
        { label: "Two", act: second },
      ],
    });
    const source = {} as XRInputSource;
    const row = layout.rows[0]!;
    const initial = panel.hit(ray(...center(row)))!;
    expect(initial.row?.label).toBe("One");
    const paints = paint.clearRect.mock.calls.length;
    panel.cursor(0, initial);
    draw();
    panel.tick(1 / 72);
    expect(paint.clearRect).toHaveBeenCalledTimes(paints);
    panel.start(source, initial);
    expect(panel.end(source, panel.hit(ray(initial.x, row.y - 5), true))).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    panel.start(source, initial);
    panel.drag(source, null);
    expect(panel.end(source, initial)).toBe(false);
    panel.start(source, initial);
    panel.drag(source, panel.hit(ray(...center(layout.rows[1]!)), true));
    expect(panel.end(source, initial)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    expect(panel.hit(ray(row.x + 1, row.y + 1))?.row).toBeUndefined();
    expect(panel.hit(ray(2, initial.y))?.row).toBeUndefined();
    panel.dispose();
  });

  it("captures a slider across a drag, then releases its owner on hide", () => {
    const change = vi.fn(),
      clicked = vi.fn();
    const { panel, ray, layout } = panelFixture({
      title: "Fixture",
      lines: [],
      rows: [
        { label: "Brightness", act: change, value: 0.2 },
        { label: "Turn off", act: clicked },
      ],
    });
    const source = {} as XRInputSource,
      another = {} as XRInputSource;
    const hit = panel.hit(ray(...center(layout.rows[0]!)))!;
    panel.start(source, hit);
    panel.drag(another, { ...hit, x: PANEL_WIDTH + 10, y: 240 });
    expect(change.mock.lastCall).toEqual([0.5]);
    panel.drag(source, { ...hit, x: PANEL_WIDTH + 10, y: 240 });
    expect(change.mock.lastCall).toEqual([1]);
    panel.hide();
    expect(panel.end(source, hit)).toBe(false);
    expect(panel.hit(ray(...center(layout.rows[0]!)))).toBeNull();
    expect(clicked).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("hits the painted headset keys without activating a neighbour on release", () => {
    const typeQ = vi.fn(),
      typeW = vi.fn();
    const { panel, ray, layout } = panelFixture({
      title: "Search equipment",
      lines: [],
      rows: [],
      keyboard: {
        text: "",
        placeholder: "Equipment name or model",
        keys: [
          [
            { id: "q", label: "q", act: typeQ },
            { id: "w", label: "w", act: typeW },
          ],
        ],
      },
    });
    const [q, w] = layout.rows;
    const y = center(q!)[1];
    const first = panel.hit(ray(q!.x + q!.width - 2, y))!;
    const second = panel.hit(ray(w!.x + 2, y))!;
    expect(first.row?.id).toBe("q");
    expect(second.row?.id).toBe("w");
    expect(panel.hit(ray((q!.x + q!.width + w!.x) / 2, y))?.row).toBeUndefined();
    const source = {} as XRInputSource;
    panel.start(source, first);
    expect(panel.end(source, second)).toBe(false);
    expect(typeQ).not.toHaveBeenCalled();
    expect(typeW).not.toHaveBeenCalled();
    panel.start(source, second);
    expect(panel.end(source, second)).toBe(true);
    expect(typeW).toHaveBeenCalledOnce();
    panel.dispose();
  });

  it("scrolls long menus continuously, clips partially visible rows and keeps navigation pinned", () => {
    const back = vi.fn();
    const { panel, ray, layout, exit } = panelFixture({
      title: "Long fixture menu",
      lines: [],
      rows: [
        ...Array.from({ length: 45 }, (_, i) => ({ label: "Room " + i, act: vi.fn() })),
        { label: "Back to room tools", act: back },
      ],
    });
    const source = {} as XRInputSource;
    const first = layout.rows[0]!;
    expect(panel.hit(ray(...center(first)))?.row?.label).toBe("Room 0");
    expect(layout.maxScroll).toBeGreaterThan(1_000);
    expect(panel.scroll(0.1, 1 / 72)).toBe(false);
    for (let i = 0; i < 2; i++) {
      panel.scroll(1, 0.05);
      panel.tick(0.05);
    }
    const clipped = panel.hit(ray(300, layout.body.y + 5))?.row;
    expect(clipped?.y).toBe(layout.body.y);
    expect(panel.hit(ray(300, layout.body.y - 8))?.row).toBeUndefined();

    const backHit = panel.hit(ray(...center(layout.footer[0]!)))!;
    expect(backHit.row?.label).toBe("Back");
    panel.start(source, backHit);
    expect(panel.end(source, backHit)).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 150; i++) {
      panel.scroll(1, 0.05);
      panel.tick(0.05);
    }
    const last = layout.rows.at(-1)!;
    const lastHit = panel.hit(ray(...center({ ...last, y: last.y - layout.maxScroll })));
    expect(lastHit?.row?.label).toBe("Room 44");
    const exitHit = panel.hit(ray(...center(layout.footer.at(-1)!)))!;
    panel.start(source, exitHit);
    panel.end(source, exitHit);
    expect(exit).toHaveBeenCalledTimes(1);
    panel.dispose();
  });

  it("promotes a row press to drag scrolling, coasts and captures the scrollbar through release", () => {
    const click = vi.fn();
    const { panel, ray, layout } = panelFixture({
      title: "Rooms",
      lines: [],
      rows: Array.from({ length: 35 }, (_, i) => ({ label: "Room " + i, act: click })),
    });
    const source = {} as XRInputSource;
    const original = panel.hit(ray(...center(layout.rows[4]!)))!;
    panel.start(source, original);
    const drag = panel.hit(ray(original.x, original.y - 115), true)!;
    panel.drag(source, drag);
    expect(panel.end(source, drag)).toBe(false);
    const beforeCoast = panel.hit(ray(original.x, original.y))?.row?.label;
    for (let i = 0; i < 12; i++) panel.tick(1 / 72);
    expect(panel.hit(ray(original.x, original.y))?.row?.label).not.toBe(beforeCoast);
    expect(click).not.toHaveBeenCalled();

    const top = scrollThumb(layout, 0);
    const thumb = panel.hit(ray(top.x + top.width / 2, layout.track.y + layout.track.height - 5))!;
    expect(thumb.scrollbar).toBe(true);
    panel.start(source, thumb);
    const beyond = panel.hit(ray(PANEL_WIDTH + 25, layout.height + 45), true)!;
    panel.drag(source, beyond);
    expect(panel.owns(source)).toBe(true);
    expect(panel.end(source, beyond)).toBe(false);
    expect(click).not.toHaveBeenCalled();
    const final = layout.rows.at(-1)!;
    expect(panel.hit(ray(...center({ ...final, y: final.y - layout.maxScroll })))?.row?.label).toBe(
      "Room 34",
    );
    panel.dispose();
  });

  it("targets adjacent quick-travel cards individually even when their top edge is clipped", () => {
    const yard = vi.fn(),
      garage = vi.fn(),
      close = vi.fn();
    const { panel, ray, layout } = panelFixture({
      title: "Virtual Home",
      lines: [],
      close,
      rows: [
        { label: "Yard", style: "travel", icon: "yard", act: yard },
        { label: "Garage", style: "travel", icon: "garage", act: garage },
        { label: "Rooms and floors", style: "primary", icon: "rooms", act: vi.fn() },
        ...Array.from({ length: 14 }, (_, i) => ({
          label: "Fixture room " + i,
          detail: "Synthetic floor",
          act: vi.fn(),
        })),
      ],
    });
    const [left, right] = layout.rows;
    const source = {} as XRInputSource;
    expect(left?.y).toBe(right?.y);
    expect(layout.footer.map((row) => row.label)).toEqual(["Close menu", "Exit immersive view"]);
    const gap = (left!.x + left!.width + right!.x) / 2;
    expect(panel.hit(ray(gap, center(left!)[1]))?.row).toBeUndefined();
    panel.scroll(1, 0.05);
    panel.tick(0.05);
    for (const [card, expected] of [
      [left!, "Yard"],
      [right!, "Garage"],
    ] as const) {
      const x = center(card)[0];
      const hit = panel.hit(ray(x, layout.body.y + 9))!;
      expect(hit.row).toMatchObject({ label: expected, y: layout.body.y });
      expect(panel.hit(ray(x, layout.body.y - 1))?.row).toBeUndefined();
      panel.start(source, hit);
      expect(panel.end(source, hit)).toBe(true);
    }
    expect(yard).toHaveBeenCalledTimes(1);
    expect(garage).toHaveBeenCalledTimes(1);
    panel.dispose();
  });

  it("aligns short home cards with the panel insets and reserves the gutter only for overflow", () => {
    const act = () => {};
    const page: PanelPage = {
      title: "Virtual Home", close: act, lines: [],
      rows: [
        { label: "Yard", style: "travel", icon: "yard", act },
        { label: "Garage", style: "travel", icon: "garage", act },
        { label: "Rooms and floors", style: "primary", icon: "rooms", act },
      ],
    };
    const measure = (value: string) => value.length * 10;
    const layout = layoutPanel(page, measure, act, act);
    const [left, right, full] = layout.rows;
    const inward = (rect: { x: number; width: number }) => PANEL_WIDTH - rect.x - rect.width;
    expect(layout.maxScroll).toBe(0);
    expect(left?.width).toBe(right?.width);
    expect(left?.x).toBe(layout.footer[0]?.x);
    expect([inward(right!), inward(full!), inward(layout.footer.at(-1)!)]).toEqual([left?.x, left?.x, left?.x]);
    const long = layoutPanel({ ...page, rows: [...page.rows, ...Array.from({ length: 15 }, () => ({ label: "Room", act }))] }, measure, act, act);
    expect(long.maxScroll).toBeGreaterThan(0);
    expect(long.rows[1]!.x + long.rows[1]!.width).toBeLessThan(long.track.x);
  });
  it("reduces optional detail on sustained missed frames and excludes a suspended interval", () => {
    const s = {
      frameRate: 72,
      supportedFrameRates: new Float32Array([72, 90]),
      updateTargetFrameRate: vi.fn(async () => {}),
    };
    const budget = new FrameBudget(s as unknown as XRSession);
    let now = 100;
    for (let i = 0; i < 245; i++) budget.tick((now += 28), "House");
    expect(budget.low).toBe(true);
    expect(budget.p95).toBe(28);
    expect(s.updateTargetFrameRate).toHaveBeenCalledWith(72);
    budget.resetClock();
    for (let i = 0; i < 605; i++) budget.tick((now += 14), "Garage");
    expect(budget.low).toBe(false);
    expect(budget.canTry90).toBe(true);
  });
});
