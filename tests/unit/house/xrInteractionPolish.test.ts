import { afterEach, describe, expect, it, vi } from "vitest";
import * as T from "three";
import { TargetHighlight } from "@/house/xr/pointers";
import { HeadsetPanel } from "@/house/xr/panel";
import { WalkWorld } from "@/house/xr/walkWorld";
import { FrameBudget, WalkAppearance } from "@/house/xr/visuals";
import { HouseSession } from "@/house/xr/session";
import { createRuntime } from "@/house/runtime";
import { createHouseStore } from "@/house/store/createHouseStore";
import { createMemoryDataApi } from "@/house/store/dataApi";
import { buildScene } from "./sceneFromGlb";
import { FIXTURE_DIR } from "./glb";
import type { Surface } from "@/house/model/types";

function canvas() {
  const ctx = {
    fillRect: vi.fn(),
    fillText: vi.fn(),
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
function sessionFixture() {
  canvas();
  const { scene, index } = flat();
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
    "vr",
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
  return { active, render, axes, inputs, source, frame };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Quest motion and pointing", () => {
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
  it("keeps landing inside the terrain boundary and reserves headroom and wall clearance", () => {
    const { index, box } = flat();
    box("wall", new T.Vector3(0.1, 2.7, 4), new T.Vector3(2, 1.35, 0), "exterior");
    box("lintel", new T.Vector3(2, 0.2, 2), new T.Vector3(0, 1.6, 3), "roof");
    box("step", new T.Vector3(0.3, 0.2, 2), new T.Vector3(-2, 0.1, 0), "step");
    const w = new WalkWorld(index);
    expect(w.yard).not.toBeNull();
    expect(w.step(new T.Vector3(49.9, 0, 0), 0.1, 0, 1.7)).toBeNull();
    expect(w.step(new T.Vector3(1.7, 0, 0), 0.14, 0, 1.7)).toBeNull();
    expect(w.canStand(new T.Vector3(0, 0, 3), 1.7)).toBe(false);
    expect(w.step(new T.Vector3(-1.82, 0, 0), -0.14, 0, 1.7)?.y).toBeCloseTo(0.2);
  });
  it("opens a model door on approach and restores its original transform at exit", () => {
    const { index, box } = flat();
    const door = box("door", new T.Vector3(1, 2, 0.07), new T.Vector3(0, 1, 0), "door-leaf");
    const before = door.matrix.clone(),
      w = new WalkWorld(index);
    expect(w.canStand(new T.Vector3(), 1.7)).toBe(false);
    w.updateDoors(new T.Vector3(0, 1.7, 0.9), 0.4);
    expect(door.matrix.equals(before)).toBe(false);
    expect(w.canStand(new T.Vector3(), 1.7)).toBe(true);
    w.dispose();
    expect(door.matrix.toArray()).toEqual(before.toArray());
    expect(door.matrixAutoUpdate).toBe(true);
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
      const shader = { uniforms: {}, fragmentShader: "#include <color_fragment>" } as Parameters<typeof mesh.material.onBeforeCompile>[0];
      mesh.material.onBeforeCompile(shader, {} as T.WebGLRenderer);
      expect(shader.fragmentShader).toContain(i === 0 ? "diffuseColor.rgb *= 1.14" : "diffuseColor.rgb *= 0.90");
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
  it("uses one layout for hover and click, retains small release jitter and cancels a drag to another button", () => {
    const paint = canvas(),
      panel = new HeadsetPanel(),
      first = vi.fn(),
      second = vi.fn(),
      source = {} as XRInputSource;
    const draw = () =>
      panel.draw(
        {
          title: "Fixture menu",
          lines: [],
          rows: [
            { label: "One", act: first },
            { label: "Two", act: second },
          ],
        },
        () => {},
        () => {},
      );
    draw();
    const rayAt = (x: number, y: number) => {
      const canvas = (panel.mesh.material.map as T.CanvasTexture).image as HTMLCanvasElement;
      const world = panel.mesh.localToWorld(new T.Vector3(x / 768 - 0.5, 0.5 - y / canvas.height, 0));
      return new T.Raycaster(world.clone().add(new T.Vector3(0, 0, 1)), new T.Vector3(0, 0, -1));
    };
    const initial = panel.hit(rayAt(300, 104))!;
    expect(initial.row?.label).toBe("One");
    const paints = paint.fillRect.mock.calls.length;
    panel.cursor(0, initial);
    draw();
    expect(paint.fillRect).toHaveBeenCalledTimes(paints);
    panel.start(source, initial);
    expect(panel.end(source, panel.hit(rayAt(300, 89), true))).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    panel.start(source, initial);
    panel.drag(source, panel.hit(rayAt(300, 210), true));
    expect(panel.end(source, initial)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    expect(panel.hit(rayAt(2, 104))?.row).toBeUndefined();
    panel.dispose();
  });
  it("captures a slider across a drag and drops the gesture when tracking is interrupted", () => {
    canvas();
    const panel = new HeadsetPanel(),
      change = vi.fn(),
      clicked = vi.fn(),
      source = {} as XRInputSource;
    panel.draw(
      {
        title: "Fixture",
        lines: [],
        rows: [
          { label: "Brightness", act: change, value: 0.2 },
          { label: "Turn off", act: clicked },
        ],
      },
      () => {},
      () => {},
    );
    const hit = panel.hit(
      new T.Raycaster(
        new T.Vector3(
          0,
          panel.mesh.scale.y * (0.5 - 125 / (panel.mesh.material.map!.image as HTMLCanvasElement).height),
          1,
        ),
        new T.Vector3(0, 0, -1),
      ),
    )!;
    panel.start(source, hit);
    panel.drag(source, { ...hit, x: 900, y: 245 });
    expect(change.mock.lastCall).toEqual([1]);
    panel.cancel();
    expect(panel.end(source, hit)).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    panel.dispose();
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
