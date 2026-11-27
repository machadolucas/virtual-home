import { LineSegments, Matrix4, Mesh, MeshStandardMaterial, Ray, Vector3, type BufferGeometry, type WebGLRenderer } from "three";
import { describe, expect, it, vi } from "vitest";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import type { Route, Vec3 } from "@/house/model/types";
import { ClipGroups } from "@/house/scene/clipGroups";
import { RouteLayer } from "@/house/scene/routes";
import { createSceneIndex } from "@/house/scene/SceneIndex";
import { RoomWallComparison } from "@/house/xr/roomWallComparison";
import { MixedRealityCalibration } from "@/house/xr/mixed";
import { calibrationError, calibrationFeatures, fitCalibration, independentCheck, type CalibrationFeature } from "@/house/xr/mixedCalibration";
import { buildMixedRealityOverlay, mixedRealityRuns } from "@/house/xr/mixedOverlay";
import { FIXTURE_DIR, loadManifest } from "./glb";

function feature(id: string, point: Vec3): CalibrationFeature {
  return { id, label: id, point };
}

const first = feature("first", [5, 3, 4]);
const second = feature("second", [7, 3, 4]);
const check = feature("check", [5, 3, 6]);
const collinear = feature("collinear", [9, 3, 4]);
const modelToLocal = new Matrix4().makeRotationY(0.7).setPosition(-3, -3, 2);
const physical = (f: CalibrationFeature): Vec3 => new Vector3(...f.point).applyMatrix4(modelToLocal).toArray();
const pair = (f: CalibrationFeature) => ({ feature: f, observed: physical(f) });

function mockXR(options: {
  storage?: Map<string, string>;
  restore?: XRSession["restorePersistentAnchor"];
  denyWrite?: boolean;
} = {}) {
  const storage = options.storage ?? new Map<string, string>();
  const referenceSpace = new EventTarget() as XRReferenceSpace;
  const deletePersistentAnchor = vi.fn().mockResolvedValue(undefined);
  const session = Object.assign(new EventTarget(), {
    visibilityState: "visible", restorePersistentAnchor: options.restore, deletePersistentAnchor,
  }) as unknown as XRSession;
  const grip = {} as XRSpace;
  const calibration = new MixedRealityCalibration({
    session, referenceSpace, userId: "member", fingerprint: "model-fingerprint", floorId: "floor",
    onState: vi.fn(), probeOffset: [0, 0, 0],
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (options.denyWrite) throw new Error("Local storage refused the write.");
        storage.set(key, value);
      },
      removeItem: (key) => { storage.delete(key); },
    },
  });
  const pose = (matrix: Matrix4) => ({ emulatedPosition: false, transform: { matrix: matrix.toArray() } });
  const frame = ({ observed = [0, 0, 0], tracked = true, anchor, anchorMatrix }: {
    observed?: Vec3; tracked?: boolean; anchor?: XRAnchor; anchorMatrix?: Matrix4;
  } = {}) => ({
    session,
    getViewerPose: () => tracked ? { emulatedPosition: false } : undefined,
    getPose: (space: XRSpace) => space === grip ? pose(new Matrix4().makeTranslation(...observed))
      : anchorMatrix ? pose(anchorMatrix) : undefined,
    trackedAnchors: new Set(anchor ? [anchor] : []),
  }) as unknown as XRFrame;
  return {
    calibration, referenceSpace, session, frame, storage, deletePersistentAnchor,
    touch: (observed: Vec3, anchorMatrix?: Matrix4) => calibration.capture(frame({ observed, anchorMatrix }), grip),
  };
}

describe("mixed reality registration", () => {
  it("labels the numbered points relative to the drawn plan and omits a closing duplicate", () => {
    const manifest = loadManifest(FIXTURE_DIR);
    const room = manifest.rooms[0]!;
    room.footprint.outer = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
    expect(calibrationFeatures(manifest, room.floorId, room.id).map((f) => f.planLabel)).toEqual([
      "Corner 1 · upper left on plan",
      "Corner 2 · upper right on plan",
      "Corner 3 · lower right on plan",
      "Corner 4 · lower left on plan",
    ]);
  });

  it("fits yaw, translation and height at unit scale and withholds a collinear check", () => {
    const result = fitCalibration(pair(first), pair(second));
    expect(result.fit).toBeDefined();
    expect(calibrationError(result.fit!.matrix, pair(check))).toBeCloseTo(0);
    expect(result.fit!.matrix.determinant()).toBeCloseTo(1);
    expect(independentCheck(pair(first), pair(second), pair(collinear))).toBe(false);
    expect(independentCheck(pair(first), pair(second), pair(check))).toBe(true);
  });

  it("rejects short baselines and disagreements instead of scaling the model", () => {
    expect(fitCalibration(pair(first), pair(feature("close", [6, 3, 4]))).message).toContain("1.5 m");
    const stretch = pair(second);
    stretch.observed[1] += 0.12;
    expect(fitCalibration(pair(first), stretch).message).toContain("12 cm");
  });

  it("keeps measured walls in headset space, excludes another level, and hides comparison on pose loss", () => {
    const room = {...loadManifest(FIXTURE_DIR).rooms[0]!, floorElevation:0};
    const [a,b] = room.footprint.outer;
    const wall = {a:a!,b:b!,low:0,high:2.4,semanticWall:true};
    const compare = new RoomWallComparison(room,{
      floor:{y:0,outline:room.footprint.outer,semanticFloor:true,source:"plane"},
      walls:[wall,{...wall,low:.32},{...wall,semanticWall:false}],landmarks:[],
    },new Matrix4());
    compare.enabled = true;
    const pose = new Matrix4().makeRotationY(.06).setPosition(.01,0,0);
    compare.frame(pose);
    const [measured,model] = compare.group.children as LineSegments[];
    expect(measured!.geometry.getAttribute("position").count).toBe(2);
    expect(measured!.matrix.equals(new Matrix4())).toBe(true);
    expect(model!.matrix.equals(pose)).toBe(true);
    expect(compare.group.visible).toBe(true);
    compare.frame(null);
    expect(compare.group.visible).toBe(false);
    compare.dispose();
  });

  it("can reuse the latest measured feature when the first pair disagrees", () => {
    const {calibration, frame, touch} = mockXR();
    calibration.frame(frame());
    calibration.select(first);
    const offset = physical(first);
    offset[0] += .35;
    touch(offset);
    calibration.select(second);
    touch(physical(second));
    expect(calibration.state.phase).toBe("select");
    expect(calibration.canKeepLatestPoint).toBe(true);
    calibration.keepLatestPoint();
    expect(calibration.state.sampleCount).toBe(1);
    expect(calibration.canChoose(second)).toBe(false);
    calibration.select(first);
    touch(physical(first));
    calibration.select(check);
    touch(physical(check));
    expect(calibration.state.phase).toBe("ready");
    calibration.dispose();
  });

  it("checks saved manual observations before accepting a passive room registration", () => {
    const {calibration, frame, touch} = mockXR();
    calibration.frame(frame());
    calibration.select(first);
    touch(physical(first));
    const fit = fitCalibration(pair(first),pair(second)).fit!;
    const conflicting = {...fit, matrix:fit.matrix.clone()};
    conflicting.matrix.elements[12]! += .25;
    expect(calibration.acceptScanned(frame(),conflicting,check,.02,true)).toBe(false);
    expect(calibration.state.sampleCount).toBe(1);
    expect(calibration.acceptScanned(frame(),fit,check,.02,true)).toBe(true);
    expect(calibration.state.phase).toBe("ready");
    calibration.dispose();
  });

  it("withholds routes until the held-out check passes and until tracking is rechecked", () => {
    const { calibration, frame, touch, referenceSpace } = mockXR();
    for (const f of [first, second]) {
      expect(calibration.frame(frame())).toBeNull();
      calibration.select(f);
      touch(physical(f));
    }
    const wrongCheck = physical(check);
    wrongCheck[1] += 0.08;
    calibration.select(check);
    touch(wrongCheck);
    expect(calibration.state.errorM).toBeCloseTo(0.08);
    expect(calibration.frame(frame())).toBeNull();
    touch(physical(check));
    expect(calibration.frame(frame())).toBeInstanceOf(Matrix4);
    expect(calibration.frame(frame({ tracked: false }))).toBeNull();
    expect(calibration.state.phase).toBe("tracking-lost");
    expect(calibration.frame(frame())).toBeNull();
    expect(calibration.state.phase).toBe("verify");
    touch(physical(check));
    expect(calibration.frame(frame())).toBeInstanceOf(Matrix4);
    referenceSpace.dispatchEvent(new Event("reset"));
    expect(calibration.frame(frame())).toBeNull();
    expect(calibration.state.sampleCount).toBe(0);
    calibration.dispose();
  });

  it.each(["viewer pose", "visibility", "reference space"])("discards unanchored calibration points after losing %s", (interruption) => {
    const { calibration, frame, touch, referenceSpace, session } = mockXR();
    for (const f of [first, second]) {
      calibration.frame(frame());
      calibration.select(f);
      touch(physical(f));
    }
    calibration.select(check);
    expect(calibration.state.sampleCount).toBe(2);
    if (interruption === "viewer pose") calibration.frame(frame({ tracked: false }));
    if (interruption === "visibility") {
      Object.assign(session, { visibilityState: "hidden" });
      session.dispatchEvent(new Event("visibilitychange"));
      Object.assign(session, { visibilityState: "visible" });
    }
    if (interruption === "reference space") referenceSpace.dispatchEvent(new Event("reset"));
    expect(calibration.state.sampleCount).toBe(0);
    expect(calibration.state.selected).toBeNull();
    expect(calibration.frame(frame())).toBeNull();
    touch(physical(check));
    expect(calibration.frame(frame())).toBeNull();
    calibration.dispose();
  });

  it("scopes a saved handle and requires a real-world check after relocalization", async () => {
    const anchor = { anchorSpace: {}, delete: vi.fn() } as unknown as XRAnchor;
    const origin = first.point;
    const storage = new Map([[
      'vh:mr-anchor:v1:["member","model-fingerprint","floor"]',
      JSON.stringify({ handle: "anchor-1", modelOrigin: origin, check }),
    ]]);
    const restore = vi.fn().mockResolvedValue(anchor);
    const xr = mockXR({ storage, restore });
    const { calibration, frame } = xr;
    expect(calibration.state.phase).toBe("restoring");
    expect(calibration.frame(frame())).toBeNull();
    await Promise.resolve();
    expect(restore).toHaveBeenCalledWith("anchor-1");
    const anchorMatrix = modelToLocal.clone().multiply(new Matrix4().makeTranslation(...origin));
    const trackedFrame = frame({ anchor, anchorMatrix });
    expect(calibration.frame(trackedFrame)).toBeNull();
    expect(calibration.state.phase).toBe("verify");
    xr.touch(physical(check), anchorMatrix);
    expect(calibration.frame(trackedFrame)).toBeInstanceOf(Matrix4);
    expect(calibration.state.phase).toBe("ready");
    expect(calibration.frame(frame())).toBeNull();
    expect(calibration.state.phase).toBe("tracking-lost");
    expect(calibration.state.persistence).toBe("saved");
    calibration.reset();
    expect(storage.size).toBe(0);
    expect(xr.deletePersistentAnchor).toHaveBeenCalledWith("anchor-1");
    expect(calibration.state.phase).toBe("select");
    calibration.dispose();
  });

  it.each([true, false])("falls back to full manual calibration when the saved handle is absent (%s)", async (rejects) => {
    const storage = new Map([[
      'vh:mr-anchor:v1:["member","model-fingerprint","floor"]',
      JSON.stringify({ handle: "old-anchor", modelOrigin: first.point, check }),
    ]]);
    const restore = rejects ? vi.fn().mockRejectedValue(new Error("Expired")) : vi.fn().mockResolvedValue(undefined);
    const { calibration, frame } = mockXR({ storage, restore });
    expect(calibration.state.phase).toBe("restoring");
    await Promise.resolve();
    expect(calibration.state).toMatchObject({ phase: "select", sampleCount: 0, selected: null, persistence: "session" });
    expect(calibration.frame(frame())).toBeNull();
    calibration.dispose();
  });

  it.each(["saved", "denied", "reset"])("requests persistence after verification and retires handles that cannot be used (%s)", async (outcome) => {
    const anchor = {
      anchorSpace: {}, delete: vi.fn(),
      requestPersistentHandle: vi.fn().mockResolvedValue("native-anchor"),
    } as unknown as XRAnchor;
    const xr = mockXR({ restore: vi.fn(), denyWrite: outcome === "denied" });
    const { calibration, frame, storage } = xr;
    const createAnchor = vi.fn().mockResolvedValue(anchor);
    const renderFrame = Object.assign(frame(), { createAnchor });
    vi.stubGlobal("XRRigidTransform", class {
      constructor(readonly position: DOMPointInit, readonly orientation: DOMPointInit) {}
    });
    try {
      for (const f of [first, second]) {
        calibration.frame(renderFrame);
        calibration.select(f);
        xr.touch(physical(f));
      }
      expect(calibration.frame(renderFrame)).toBeNull();
      expect(createAnchor).not.toHaveBeenCalled();
      calibration.select(check);
      xr.touch(physical(check));
      expect(calibration.frame(renderFrame)).toBeInstanceOf(Matrix4);
      expect(createAnchor).toHaveBeenCalledOnce();
      if (outcome === "reset") {
        await Promise.resolve();
        expect(anchor.requestPersistentHandle).toHaveBeenCalledOnce();
        calibration.reset();
        await vi.waitFor(() => expect(xr.deletePersistentAnchor).toHaveBeenCalledWith("native-anchor"));
        expect(calibration.state.phase).toBe("select");
        expect(storage.size).toBe(0);
      } else if (outcome === "denied") {
        await vi.waitFor(() => expect(xr.deletePersistentAnchor).toHaveBeenCalledWith("native-anchor"));
        expect(calibration.state.persistence).toBe("session");
        expect(calibration.frame(frame())).toBeInstanceOf(Matrix4);
        expect(storage.size).toBe(0);
      } else {
        await vi.waitFor(() => expect(calibration.state.persistence).toBe("saved"));
        expect(JSON.parse([...storage.values()][0]!)).toEqual({ handle: "native-anchor", modelOrigin: first.point, check });
        expect(xr.deletePersistentAnchor).not.toHaveBeenCalled();
      }
    } finally {
      calibration.dispose();
      vi.unstubAllGlobals();
    }
  });
});

describe("mixed reality runs", () => {
  const manifest = buildManifestIndex(loadManifest(FIXTURE_DIR));
  const lower = { floorId: "f-lower", roomId: null };
  const upper = { floorId: "f-upper", roomId: null };
  const route: Route = {
    id: "pipe", name: "Test pipe", modelId: manifest.modelId,
    kind: "pipe", system: "water", lifecycle: "installed", flowState: "active", certainty: "inferred",
    points: [[0, 0, 0], [1, 0, 0], [1, 3, 0], [2, 3, 0], [2, 0, 0], [3, 0, 0]],
    segments: [lower, lower, upper, upper, lower],
    pointPlaces: [lower, lower, upper, upper, lower, lower],
    endpoints: [], photoIds: [],
  };

  it("keeps only continuous active documented spans on the selected floor", () => {
    const inactive = { ...route, flowState: "inactive" } as const;
    const stale = { ...route, needsReconciliation: true };
    const cable = { ...route, kind: "cable" } as const;
    const duct = { ...route, id: "duct", kind: "duct" } as const;
    const runs = mixedRealityRuns([route, inactive, stale, cable, duct], "f-lower", "pipes");
    expect(runs.map((r) => r.points)).toEqual([route.points.slice(0, 2), route.points.slice(4)]);
    expect(mixedRealityRuns([route], "f-upper", "both").map((r) => r.points)).toEqual([route.points.slice(2, 4)]);
  });

  it("reports a route by the calibrated ray, and hides picks before calibration or after filtering", () => {
    const overlay = buildMixedRealityOverlay(manifest, [route], "f-lower");
    const ray = new Ray(new Vector3(0.5, 2, 0), new Vector3(0, -1, 0));
    expect(overlay.count).toBe(1);
    expect(overlay.pick(ray)).toBeNull();
    overlay.applyTransform(new Matrix4());
    expect(overlay.pick(ray)?.label).toBe("Test pipe · Approximate concealed route");
    overlay.applyTransform(new Matrix4().makeTranslation(2, 0, 0));
    expect(overlay.pick(ray)).toBeNull();
    ray.origin.x += 2;
    expect(overlay.pick(ray)?.id).toBe("pipe");
    overlay.setFilter("ducts");
    expect(overlay.count).toBe(0);
    expect(overlay.pick(ray)).toBeNull();
    overlay.dispose();
  });

  it("isolates every on-floor span of a picked route and restores the current overlay on repeat or empty selection", () => {
    const other: Route = { ...route, id: "other", name: "Other pipe",
      points: route.points.map(([x, y, z]) => [x, y, z + 1]),
    };
    const read = (x: number, z: number) => new Ray(new Vector3(x, 2, z), new Vector3(0, -1, 0));
    const overlay = buildMixedRealityOverlay(manifest, [route, other], "f-lower");
    expect(overlay.toggleFocus("pipe")).toBeNull();
    overlay.applyTransform(new Matrix4());
    expect(overlay.count).toBe(2);
    expect(overlay.toggleFocus(overlay.pick(read(0.5, 0))?.id ?? null)).toBe("pipe");
    expect(overlay.focusedId).toBe("pipe");
    expect(overlay.count).toBe(1);
    expect(overlay.pick(read(0.5, 1))).toBeNull();
    expect(overlay.pick(read(1.5, 0))).toBeNull();
    expect(overlay.pick(read(2.5, 0))).toMatchObject({ id: "pipe", approximate: true, certainty: "inferred" });
    expect(overlay.toggleFocus("pipe")).toBeNull();
    expect(overlay.pick(read(0.5, 1))?.id).toBe("other");
    overlay.toggleFocus("pipe");
    expect(overlay.toggleFocus(overlay.pick(read(0.5, 1))?.id ?? null)).toBeNull();
    expect(overlay.count).toBe(2);
    expect(route.points).toEqual([[0, 0, 0], [1, 0, 0], [1, 3, 0], [2, 3, 0], [2, 0, 0], [3, 0, 0]]);
    overlay.dispose();
  });

  it("clears tracing on filter choice, lost verification and disappearance of the focused route", () => {
    const duct: Route = { ...route, id: "duct", kind: "duct" };
    const overlay = buildMixedRealityOverlay(manifest, [route, duct], "f-lower");
    overlay.applyTransform(new Matrix4());
    overlay.toggleFocus("pipe");
    overlay.setFilter("both");
    expect(overlay.focusedId).toBeNull();
    expect(overlay.count).toBe(2);
    overlay.toggleFocus("pipe");
    overlay.setFilter("ducts");
    expect(overlay.focusedId).toBeNull();
    expect(overlay.toggleFocus("pipe")).toBeNull();
    overlay.toggleFocus("duct");
    overlay.applyTransform(null);
    expect(overlay.focusedId).toBeNull();
    expect(overlay.group.visible).toBe(false);
    overlay.applyTransform(new Matrix4());
    overlay.toggleFocus("duct");
    overlay.setRoutes([route, { ...duct, flowState: "inactive" }]);
    expect(overlay.focusedId).toBeNull();
    expect(overlay.count).toBe(0);
    overlay.dispose();
  });

  it("switches tracing visibility without rebuilding full geometry and keeps only one cached trace", () => {
    const other: Route = { ...route, id: "other", kind: "duct" };
    const overlay = buildMixedRealityOverlay(manifest, [route, other], "f-lower");
    overlay.applyTransform(new Matrix4());
    const floor = overlay.group.getObjectByName("vh-mr-floor-routes")!;
    const geometryIn = (root: { getObjectsByProperty(name: string, value: unknown): unknown[] }) =>
      (root.getObjectsByProperty("isMesh", true)[0] as Mesh).geometry;
    const geometry = geometryIn(floor);
    const disposeFloor = vi.spyOn(geometry, "dispose");

    overlay.toggleFocus("pipe");
    const trace = overlay.group.getObjectByName("vh-mr-focused-route")!;
    const traceGeometry = geometryIn(trace);
    const disposeTrace = vi.spyOn(traceGeometry, "dispose");
    expect(floor.visible).toBe(false);
    expect(trace.visible).toBe(true);
    overlay.clearFocus();
    expect(floor.visible).toBe(true);
    expect(trace.visible).toBe(false);
    expect(geometryIn(floor)).toBe(geometry);
    expect(disposeFloor).not.toHaveBeenCalled();
    expect(disposeTrace).not.toHaveBeenCalled();

    overlay.toggleFocus("pipe");
    expect(overlay.group.getObjectByName(trace.name)).toBe(trace);
    expect(geometryIn(trace)).toBe(traceGeometry);
    overlay.clearFocus();
    overlay.toggleFocus("other");
    expect(disposeTrace).toHaveBeenCalledOnce();
    expect(trace.parent).toBeNull();
    const replacement = overlay.group.getObjectByName(trace.name)!;
    const disposeReplacement = vi.spyOn(geometryIn(replacement), "dispose");
    expect(overlay.group.children).toHaveLength(2);

    overlay.setRoutes([{ ...route }, other]);
    expect(disposeReplacement).toHaveBeenCalledOnce();
    expect(disposeFloor).toHaveBeenCalledOnce();
    expect(overlay.focusedId).toBeNull();
    expect(overlay.group.children).toHaveLength(1);
    overlay.toggleFocus("pipe");
    const beforeFilter = overlay.group.getObjectByName(trace.name)!;
    const disposeBeforeFilter = vi.spyOn(geometryIn(beforeFilter), "dispose");
    overlay.setFilter("ducts");
    expect(disposeBeforeFilter).toHaveBeenCalledOnce();
    expect(overlay.group.children).toHaveLength(1);

    overlay.toggleFocus("other");
    const disposeLastTrace = vi.spyOn(geometryIn(overlay.group.getObjectByName(trace.name)!), "dispose");
    const disposeLastFloor = vi.spyOn(geometryIn(floor), "dispose");
    overlay.dispose();
    expect(disposeLastTrace).toHaveBeenCalledOnce();
    expect(disposeLastFloor).toHaveBeenCalledOnce();
    expect(overlay.group.children).toHaveLength(0);
  });

  it("represents observed-but-estimated routes as approximate only in the mixed reality overlay", () => {
    const observed: Route = { ...route, certainty: "observed", isEstimated: true };
    const overlay = buildMixedRealityOverlay(manifest, [observed], "f-lower");
    overlay.applyTransform(new Matrix4());
    const ray = new Ray(new Vector3(0.5, 2, 0), new Vector3(0, -1, 0));
    const approximation = overlay.group.getObjectsByProperty("isMesh", true)[0];
    expect(approximation).toBeInstanceOf(Mesh);
    expect(approximation?.userData.vhApproximatePath).toBe(true);
    expect(approximation?.userData.vhRouteSpanCount).toBeGreaterThan(2);
    expect(overlay.pick(ray)).toMatchObject({ label: "Test pipe · Approximate concealed route", certainty: "observed" });

    const desktop = createSceneIndex(manifest);
    const layer = new RouteLayer(desktop, new ClipGroups(["f-lower", "f-upper"]));
    layer.set([observed], { tubes: true });
    const desktopTubes = desktop.overlay.root.getObjectsByProperty("isMesh", true);
    expect(desktopTubes).not.toHaveLength(0);
    expect(desktopTubes.every((tube) => !tube.userData.vhApproximatePath)).toBe(true);

    overlay.setRoutes([{ ...observed, isEstimated: false }]);
    const knownTubes = overlay.group.getObjectsByProperty("isMesh", true);
    expect(knownTubes).not.toHaveLength(0);
    expect(knownTubes.every((tube) => !tube.userData.vhApproximatePath)).toBe(true);
    expect(overlay.pick(ray)?.label).toBe("Test pipe · observed path");
    overlay.dispose();
    layer.dispose();
  });

  it("advances approximate supply and extract flow bands at independent live fan rates", () => {
    const supply: Route = {
      ...route, id: "supply", system: "ventilation", kind: "duct", medium: "supply_air",
      certainty: "inferred", isEstimated: true, flowDirection: "forward", flowBasis: "inferred",
    };
    const extract: Route = { ...supply, id: "extract", medium: "extract_air" };
    const overlay = buildMixedRealityOverlay(manifest, [supply, extract], "f-lower");
    overlay.applyTransform(new Matrix4());

    const uniforms = (stream: string) => {
      const tube = overlay.group.getObjectsByProperty("isMesh", true).find((o) => o.userData.vhAirStream === stream);
      expect(tube).toBeInstanceOf(Mesh);
      expect(tube?.userData.vhApproximatePath).toBe(true);
      expect(tube?.userData.vhRouteSpanCount).toBeGreaterThan(2);
      const { material, geometry } = tube as Mesh<BufferGeometry, MeshStandardMaterial>;
      expect(geometry.getAttribute("vhRouteDistance")).toBeDefined();
      const shader = {
        uniforms: {}, vertexShader: "", fragmentShader: "#include <emissivemap_fragment>",
      } as Parameters<typeof material.onBeforeCompile>[0];
      material.onBeforeCompile(shader, {} as WebGLRenderer);
      expect(shader.fragmentShader).toContain("fract(vhDistance - vhRoutePhase)");
      return shader.uniforms;
    };
    const supplyBand = uniforms("room_supply");
    const extractBand = uniforms("room_extract");
    expect(overlay.tick(0.025, true, { supply: 0.4, extract: 0.8 })).toBe(true);
    expect(supplyBand.vhRoutePhase?.value).toBeCloseTo(0.01);
    expect(extractBand.vhRoutePhase?.value).toBeCloseTo(0.02);
    overlay.tick(0.025, true, { supply: 1, extract: 0 });
    expect(supplyBand.vhRoutePhase?.value).toBeCloseTo(0.035);
    expect(extractBand.vhRoutePhase?.value).toBeCloseTo(0.02);
    expect(extractBand.vhRouteMotion?.value).toBe(0);
    overlay.toggleFocus("supply");
    overlay.tick(0.025, true, { supply: 1, extract: 1 });
    expect(supplyBand.vhRoutePhase?.value).toBeCloseTo(0.06);
    expect(extractBand.vhRoutePhase?.value).toBeCloseTo(0.02);
    overlay.clearFocus();
    overlay.tick(0.025, true, { supply: 0, extract: 0.4 });
    expect(supplyBand.vhRoutePhase?.value).toBeCloseTo(0.06);
    expect(extractBand.vhRoutePhase?.value).toBeCloseTo(0.03);
    overlay.dispose();
  });
});
