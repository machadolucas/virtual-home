import { Matrix4, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Furnishing, Room } from "@/house/model/types";
import type { HouseRuntime } from "@/house/runtime";
import type { RoomSurveyMove, RoomSurveySummary } from "@/house/roomSurveyTypes";
import { MAX_ROOM_SURVEY_POINTS } from "@/house/roomSurveyTypes";
import * as api from "@/house/roomSurveyApi";
import { reviewRoomSurveyMove } from "@/house/roomSurveyReview";
import { requestHouseSession } from "@/house/xr/presentation";
import { RoomSurveyPilot } from "@/house/xr/roomSurvey";
import { measurementLength, readFullRoomSurfaces, readRoomSurfaces, surveyBounds, surveyExtent } from "@/house/xr/surveyGeometry";
import { HandConfirmation, trackedIndexTip } from "@/house/xr/surveyInput";
import { FIXTURE_DIR, loadManifest } from "./glb";

vi.mock("@/house/roomSurveyApi", () => ({
  saveRoomSurvey: vi.fn(),
  getRoomSurvey: vi.fn(),
  getRoomSurveyGeometry: vi.fn(),
  listRoomSurveys: vi.fn(),
  proposeRoomSurveyMove: vi.fn(),
  recordRoomSurveyObservation: vi.fn(),
}));
vi.mock("@/house/roomSurveyReview", () => ({ reviewRoomSurveyMove: vi.fn() }));

const fingerprint = "97abcdef";
const room: Room = {
  ...loadManifest(FIXTURE_DIR).rooms[0]!,
  floorElevation: 5,
  ceilingHeight: 2.5,
  footprint: { outer: [[0, 0], [4, 0], [4, 3], [0, 3]], holes: [] },
};
const reference = {} as XRReferenceSpace;
const localFromModel = new Matrix4().makeRotationY(0.3).setPosition(1, -5, 2);
const tracked = (...p: [number, number, number]) => new Vector3(...p).applyMatrix4(localFromModel);

const summary: RoomSurveySummary = {
  id: "saved-reference",
  modelId: "model", fingerprint,
  floorId: room.floorId, roomId: room.id, roomName: room.name,
  registrationErrorM: 0.025, capturedAtMs: 1_000,
  statistics: { extent: { min: [0, 5, 0], max: [2, 6, 1] }, scope: "manual", includesAdjoining: false, sources: { manual: 1 },
    pointCount: 2, triangleCount: 0, measurementCount: 1 },
};

function buildSurvey(initiateRoomCapture?: XRSession["initiateRoomCapture"]) {
  const state = { fingerprint, placements: [] };
  const runtime = { base: "/house", store: { getState: () => state } } as unknown as HouseRuntime;
  const session = { visibilityState: "visible", initiateRoomCapture } as unknown as XRSession;
  const frame = { session } as XRFrame;
  const survey = new RoomSurveyPilot(runtime, session, reference, room);
  survey.frame(frame, localFromModel, 0.025);
  return { survey, frame };
}

function buildAimedSurvey(kind: "native" | "mesh") {
  const state = { fingerprint, placements: [] };
  const runtime = { base: "/house", store: { getState: () => state } } as unknown as HouseRuntime;
  const source = { targetRayMode: "tracked-pointer", targetRaySpace: {}, handedness: "right" } as XRInputSource;
  const hitSource = { cancel: vi.fn() };
  const requestHitTestSource = kind === "native" ? vi.fn().mockResolvedValue(hitSource) : undefined;
  const viewer = tracked(2, 6.65, 0.5);
  const origin = tracked(2, 6.35, 1);
  const pointing = new Matrix4();
  let hit = tracked(1, 5, 1);
  const aim = (point: Vector3) => pointing.lookAt(origin, point, new Vector3(0, 1, 0)).setPosition(origin);
  aim(hit);
  const session = { visibilityState: "visible", requestHitTestSource, inputSources: [source] } as unknown as XRSession;
  const frame = {
    session,
    ...(kind === "mesh" ? { detectedMeshes: new Set([{ meshSpace: {},
      vertices: Float32Array.from([[0, 5, 0], [4, 5, 0], [4, 5, 3], [0, 5, 3]]
        .flatMap(([x, y, z]) => tracked(x!, y!, z!).toArray())),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    }]) } : {}),
    getViewerPose: () => ({ emulatedPosition: false, transform: { position: viewer } }),
    getPose: (spatial: XRSpace) => ({
      emulatedPosition: false, transform: { matrix: (spatial === source.targetRaySpace ? pointing : new Matrix4()).toArray() },
    }),
    getHitTestResults: () => [{ getPose: () => ({ emulatedPosition: false, transform: { position: hit } }) }],
  } as unknown as XRFrame;
  const survey = new RoomSurveyPilot(runtime, session, reference, room);
  const tick = () => survey.frame(frame, localFromModel, 0.025);
  tick();
  return { survey, frame, source, requestHitTestSource, tick, aim,
    setHit: (point: Vector3) => { hit = point; } };
}

function click(survey: RoomSurveyPilot, label: string | RegExp) {
  const row = survey.menu().rows.find((r) => typeof label === "string" ? r.label === label : label.test(r.label));
  expect(row?.act, `Missing action ${label}`).toBeTypeOf("function");
  row!.act!(0);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("survey room WebXR", () => {
  it("asks for survey capabilities optionally on the entry gesture", () => {
    const session = vi.fn();
    requestHouseSession({ requestSession: session } as unknown as XRSystem, "survey");
    expect(session).toHaveBeenCalledWith("immersive-ar", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["anchors", "plane-detection", "mesh-detection", "hit-test", "hand-tracking"],
    });
  });

  it("clips supplied planes and mesh triangles to the selected room volume, including adjoining extent", () => {
    const wallSpace = {} as XRSpace;
    const awaySpace = {} as XRSpace;
    const meshSpace = {} as XRSpace;
    const samplePlane = {
      orientation: "horizontal",
      polygon: [[-3, 5, 0], [1, 5, 0], [1, 5, 2], [-3, 5, 2]].map(([x, y, z]) => ({ x, y, z })),
    };
    const recorded = {
      detectedPlanes: new Set([{ planeSpace: wallSpace, ...samplePlane }, { planeSpace: awaySpace, ...samplePlane }]),
      detectedMeshes: new Set([{ meshSpace, vertices: new Float32Array([3, 6, 1, 8, 6, 1, 3, 6, 2]),
        indices: new Uint32Array([0, 1, 2]) }]),
      getPose: (space: XRSpace) => ({ emulatedPosition: false, transform: {
        matrix: space === awaySpace
          ? localFromModel.clone().multiply(new Matrix4().makeTranslation(0, 30, 0)).toArray()
          : localFromModel.toArray(),
      } }),
    } as unknown as XRFrame;
    const bounds = surveyBounds(room);
    const surfaces = readRoomSurfaces(recorded, reference, localFromModel.clone().invert(), bounds);
    expect(surfaces.map(({ source }) => source)).toEqual(["plane", "mesh"]);
    const extent = surveyExtent({ surfaces, measurements: [] }, room);
    expect(extent.adjoining).toBe(true);
    expect(extent.bounds.min.x).toBeCloseTo(-0.8);
    expect(extent.bounds.max.x).toBeCloseTo(4.8);
    expect(surfaces[1]?.indices).toHaveLength(6);
  });

  it("falls back when the browser denies both geometry providers", () => {
    const denied = Object.defineProperties({}, {
      detectedPlanes: { get() { throw new Error("denied"); } },
      detectedMeshes: { get() { throw new Error("denied"); } },
    }) as XRFrame;
    expect(readRoomSurfaces(denied, reference, new Matrix4(), surveyBounds(room))).toEqual([]);
  });

  it("only invokes headset room setup on an explicit action after an empty preview", async () => {
    let finish!: () => void;
    const open = vi.fn(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    const { survey, frame } = buildSurvey(open);
    const setupLabel = "Open headset room setup";
    expect(survey.menu().rows.some((row) => row.label === setupLabel)).toBe(false);
    click(survey, "Preview full headset room / scene");
    survey.frame(frame, localFromModel, 0.025);
    expect(open).not.toHaveBeenCalled();
    click(survey, setupLabel);
    expect(open).toHaveBeenCalledOnce();
    survey.frame(frame, localFromModel, 0.025);
    expect(survey.display.group.visible).toBe(false);
    finish();
    await vi.waitFor(() => expect(survey.menu().lines.join(" ")).toContain("preview geometry again"));
    survey.frame(frame, null, null);
    expect(survey.display.group.visible).toBe(false);
    survey.frame(frame, localFromModel, 0.025);
    expect(survey.display.group.visible).toBe(true);
    click(survey, "Preview bounded, simplified room");
    survey.frame(frame, localFromModel, 0.025);
    expect(survey.menu().rows.some((row) => row.label === setupLabel)).toBe(false);
    expect(open).toHaveBeenCalledOnce();
    survey.dispose();
  });

  it("keeps manual points available when opening headset room setup is unsupported or denied", async () => {
    const unsupported = buildSurvey();
    click(unsupported.survey, "Preview bounded, simplified room");
    unsupported.survey.frame(unsupported.frame, localFromModel, 0.025);
    expect(unsupported.survey.menu().lines.join(" ")).toContain("find Space Setup in Settings");
    expect(unsupported.survey.menu().rows.some((row) => row.label === "Open headset room setup")).toBe(false);
    unsupported.survey.dispose();

    const deny = vi.fn().mockRejectedValue(new Error("denied"));
    const supported = buildSurvey(deny);
    click(supported.survey, "Preview bounded, simplified room");
    supported.survey.frame(supported.frame, localFromModel, 0.025);
    click(supported.survey, "Open headset room setup");
    await vi.waitFor(() => expect(supported.survey.menu().lines.join(" ")).toContain("Headset room setup did not open"));
    supported.survey.frame(supported.frame, localFromModel, 0.025);
    click(supported.survey, "Measure or mark points");
    click(supported.survey, "Mark a physical point");
    supported.survey.capture(tracked(1, 5, 1));
    expect(supported.survey.menu().lines.join(" ")).toContain("Point included");
    supported.survey.dispose();
  });

  it("retains full device vertices, triangle indices and adjoining extent in the surveyed model frame", () => {
    const meshSpace = {} as XRSpace;
    const indices = [0, 2, 1, 1, 2, 3];
    const sensorToModel = new Matrix4().makeRotationY(0.7).setPosition(18, 5, 2);
    const mesh = {
      meshSpace,
      vertices: new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 3, 2, 0, 3]),
      indices: new Uint32Array(indices),
    };
    const frame = {
      detectedMeshes: new Set([mesh]),
      getPose: () => ({ emulatedPosition: false, transform: { matrix: localFromModel.clone().multiply(sensorToModel).toArray() } }),
    } as unknown as XRFrame;
    const result = readFullRoomSurfaces(frame, reference, localFromModel.clone().invert());
    expect(result.kind).toBe("full");
    if (result.kind !== "full") throw new Error("Expected the complete mesh");
    expect(result.surfaces[0]?.points).toHaveLength(4);
    expect(result.surfaces[0]?.indices).toEqual(indices);
    expect(result.surfaces[0]?.points[0]?.[0]).toBeCloseTo(18);
    const expected = new Vector3(2, 0, 3).applyMatrix4(sensorToModel);
    expect(new Vector3(...result.surfaces[0]!.points[3]!).distanceTo(expected)).toBeCloseTo(0);
    expect(surveyExtent({ surfaces: result.surfaces, measurements: [] }, room).adjoining).toBe(true);
  });

  it("rejects oversized full input and only saves simplified geometry after a separately chosen preview", async () => {
    const { survey, frame } = buildSurvey();
    const vertices = new Float32Array((MAX_ROOM_SURVEY_POINTS + 1) * 3);
    vertices.set([0, 5, 0, 1, 5, 0, 0, 5, 1]);
    const sensorFrame = Object.assign(frame, {
      detectedMeshes: new Set([{ meshSpace: {}, vertices, indices: new Uint32Array([0, 1, 2]) }]),
      getPose: () => ({ emulatedPosition: false, transform: { matrix: localFromModel.toArray() } }),
    });
    vi.mocked(api.saveRoomSurvey).mockResolvedValue(summary);
    click(survey, "Preview full headset room / scene");
    survey.frame(sensorFrame, localFromModel, 0.025);
    expect(survey.menu().lines.join(" ")).toContain("Full scene exceeds capture limits");
    click(survey, "Save the preview as a room reference");
    expect(api.saveRoomSurvey).not.toHaveBeenCalled();
    click(survey, "Preview bounded, simplified room");
    survey.frame(sensorFrame, localFromModel, 0.025);
    expect(survey.menu().lines.join(" ")).toContain("Bounded · 3 vertices · 1 mesh triangle");
    click(survey, "Save the preview as a room reference");
    await vi.waitFor(() => expect(api.saveRoomSurvey).toHaveBeenCalledWith("/house", expect.objectContaining({
      geometry: expect.objectContaining({ scope: "bounded" }),
    })));
    survey.dispose();
  });

  it("samples the aiming index joint and requires a different hand to confirm", () => {
    const joint = {} as XRJointSpace;
    const input = (handedness: XRHandedness) => ({ hand: new Map([["index-finger-tip", joint]]), handedness }) as unknown as XRInputSource;
    const left = input("left"), right = input("right");
    const confirmation = new HandConfirmation();
    expect(confirmation.select(left)).toBeNull();
    expect(confirmation.select(left)).toBeNull();
    expect(confirmation.select(input("left"))).toBeNull();
    expect(confirmation.select({ handedness: "left" } as XRInputSource)).toBeNull();
    expect(confirmation.select(right)).toBe(left);
    const getJointPose = vi.fn().mockReturnValue({ emulatedPosition: false, transform: { position: { x: 1, y: 2, z: 3 } } });
    const frame = { getJointPose } as unknown as XRFrame;
    expect(trackedIndexTip(frame, reference, left, new Vector3())?.toArray()).toEqual([1, 2, 3]);
    expect(getJointPose).toHaveBeenCalledWith(joint, reference);
  });

  it("captures the exact controller preview, then keeps point A while switching to touch for point B", async () => {
    const { survey, frame, source, requestHitTestSource, tick, setHit } = buildAimedSurvey("native");
    vi.mocked(api.saveRoomSurvey).mockResolvedValue(summary);
    click(survey, "Measure or mark points");
    click(survey, "Ceiling height");
    expect(survey.aiming).toBe(true);
    tick();
    const preview = new Vector3();
    await vi.waitFor(() => expect(survey.previewAim(frame, source, preview)).toBe(preview));
    expect(requestHitTestSource).toHaveBeenCalledWith(expect.objectContaining({ space: source.targetRaySpace }));
    expect(preview.distanceTo(tracked(1, 5, 1))).toBeCloseTo(0);
    // A newer platform hit must not silently replace the point the wearer saw.
    setHit(tracked(2, 5.3, 1));
    survey.captureAim(frame, source);
    expect(survey.menu().lines.join(" ")).toContain("Point A marked");
    click(survey, "Use touch instead");
    expect(survey.menu().lines.join(" ")).toContain("point B");
    survey.capture(tracked(1, 7.5, 1));
    click(survey, "Survey tools");
    click(survey, "Save the preview as a room reference");
    await vi.waitFor(() => expect(api.saveRoomSurvey).toHaveBeenCalledWith("/house", expect.objectContaining({
      geometry: { scope: "manual", surfaces: [], measurements: [{ kind: "ceiling_height", a: [1, 5, 1], b: [1, 7.5, 1] }] },
    })));
    survey.dispose();
  });

  it("aims at measured mesh without native hit tests, and discards an occluded or lost preview", async () => {
    const { survey, frame, source, tick, aim } = buildAimedSurvey("mesh");
    vi.mocked(api.saveRoomSurvey).mockResolvedValue(summary);
    click(survey, "Measure or mark points");
    click(survey, "Mark a physical point");
    tick();
    expect(survey.previewAim(frame, source, new Vector3())?.distanceTo(tracked(1, 5, 1))).toBeCloseTo(0);
    survey.hideAimPreview(source);
    survey.captureAim(frame, source);
    expect(survey.menu().lines.join(" ")).toContain("orange point is steady");
    expect(survey.previewAim(frame, source, new Vector3())).not.toBeNull();
    expect(survey.menu().back).toBeTypeOf("function");
    survey.menu().back!();
    survey.captureAim(frame, source);
    expect(survey.sampling).toBe(false);
    click(survey, "Mark a physical point");
    tick();
    expect(survey.previewAim(frame, source, new Vector3())).not.toBeNull();
    aim(tracked(2, 5, 2));
    survey.captureAim(frame, source);
    expect(survey.menu().lines.join(" ")).toContain("orange point is steady");
    expect(survey.previewAim(frame, source, new Vector3())).not.toBeNull();
    survey.frame(frame, null, null);
    survey.captureAim(frame, source);
    expect(survey.sampling).toBe(false);
    tick();
    click(survey, "Mark a physical point");
    tick();
    expect(survey.previewAim(frame, source, new Vector3())).not.toBeNull();
    survey.captureAim(frame, source);
    click(survey, "Survey tools");
    click(survey, "Save the preview as a room reference");
    await vi.waitFor(() => expect(api.saveRoomSurvey).toHaveBeenCalledWith("/house", expect.objectContaining({
      geometry: { scope: "manual", measurements: [], surfaces: [{ source: "hit-test", points: [[2, 5, 2]] }] },
    })));
    survey.dispose();
  });

  it("samples floor-to-ceiling in physical coordinates, drops unfinished touches on lost alignment, and reopens stored evidence", async () => {
    const { survey, frame } = buildSurvey();
    const measured = { kind: "ceiling_height", a: [1, 5, 1], b: [1.5, 7.5, 1] } as const;
    vi.mocked(api.saveRoomSurvey).mockResolvedValue(summary);
    vi.mocked(api.listRoomSurveys).mockResolvedValue({ items: [summary], nextCursor: null });
    vi.mocked(api.getRoomSurvey).mockResolvedValue({ ...summary, moves: [], observations: [], surfaces: [], measurements: [] });
    vi.mocked(api.getRoomSurveyGeometry).mockResolvedValue({ surfaces: [], measurements: [
      { ...measured, a: [...measured.a], b: [...measured.b] },
    ] });
    click(survey, "Measure or mark points");
    click(survey, "Ceiling height");
    survey.capture(tracked(1, 5, 1));
    survey.frame(frame, null, null);
    survey.capture(tracked(1.5, 7.5, 1));
    expect(vi.mocked(api.saveRoomSurvey)).not.toHaveBeenCalled();
    survey.frame(frame, localFromModel, 0.025);
    click(survey, "Ceiling height");
    survey.capture(tracked(1, 5, 1));
    survey.capture(tracked(1.5, 7.5, 1));
    expect(survey.menu().lines.join(" ")).toContain("2.500 m");
    expect(measurementLength({ ...measured, a: [...measured.a], b: [...measured.b] })).toBe(2.5);
    click(survey, "Survey tools");
    click(survey, "Save the preview as a room reference");
    await vi.waitFor(() => expect(survey.menu().lines.join(" ")).toContain("Room reference saved"));
    expect(api.saveRoomSurvey).toHaveBeenCalledWith("/house", expect.objectContaining({
      fingerprint, roomId: room.id, floorId: room.floorId, registrationErrorM: 0.025,
      geometry: { scope: "manual", surfaces: [], measurements: [measured] },
    }));
    click(survey, "Saved room references");
    await vi.waitFor(() => expect(survey.menu().title).toBe("Saved room references"));
    click(survey, /points/);
    await vi.waitFor(() => expect(survey.menu().title).toBe("Saved survey preview"));
    expect(survey.display.group.getObjectsByProperty("isPoints", true)).toHaveLength(1);
    survey.dispose();
  });

  it.each(["touch", "aim"] as const)("keeps a %s furniture correction pending until explicit Apply and supports Undo", async (mode) => {
    const aimed = mode === "aim" ? buildAimedSurvey("native") : null;
    const { survey } = aimed ?? buildSurvey();
    const capture = async (point: Vector3) => {
      if (!aimed) { survey.capture(point); return; }
      aimed.aim(point);
      aimed.setHit(point);
      aimed.tick();
      await vi.waitFor(() => expect(survey.previewAim(aimed.frame, aimed.source, new Vector3())?.distanceTo(point)).toBeCloseTo(0));
      survey.captureAim(aimed.frame, aimed.source);
    };
    const furniture: Furnishing = {
      id: "chair", modelId: "model", name: "Chair", kind: "chair", floorId: room.floorId, roomId: room.id,
      position: [1, 5, 1], rotationYDeg: 0, widthM: 0.5, heightM: 0.9, depthM: 0.5,
    };
    const proposal: RoomSurveyMove = {
      id: "move", surveyId: summary.id, target: { id: furniture.id, name: furniture.name, kind: "furnishing" },
      before: { position: furniture.position, yawDeg: 0 }, after: { position: [2, 5, 1], yawDeg: 90 },
      status: "proposed", registrationErrorM: 0.025, displacementCm: 100, headingChangeDeg: 90,
      createdAtMs: 1_000, appliedAtMs: null, undoneAtMs: null, applyBlockedReason: null,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ furnishings: [furniture] })));
    vi.mocked(api.saveRoomSurvey).mockResolvedValue(summary);
    vi.mocked(api.proposeRoomSurveyMove).mockResolvedValue(proposal);
    vi.mocked(reviewRoomSurveyMove).mockResolvedValueOnce({ ...proposal, status: "applied" })
      .mockResolvedValueOnce({ ...proposal, status: "undone" });
    click(survey, "Correct an existing object");
    await vi.waitFor(() => expect(survey.menu().title).toBe("Choose an existing object"));
    click(survey, "Chair");
    click(survey, "Mark the physical position");
    await capture(tracked(2, 5, 1));
    click(survey, "Mark optional heading");
    await capture(tracked(1, 5, 1));
    click(survey, "Mark position again");
    await capture(tracked(2, 5, 1));
    click(survey, "Mark and save a room reference first");
    await vi.waitFor(() => expect(survey.menu().rows.some((r) => r.label === "Save as pending move")).toBe(true));
    click(survey, "Save as pending move");
    await vi.waitFor(() => expect(survey.menu().rows.some((r) => r.label === "Apply measured move")).toBe(true));
    expect(api.proposeRoomSurveyMove).toHaveBeenCalledWith("/house", summary.id, expect.objectContaining({
      sample: { position: [2, 5, 1], yawDeg: 90 },
    }));
    expect(reviewRoomSurveyMove).not.toHaveBeenCalled();
    click(survey, "Apply measured move");
    await vi.waitFor(() => expect(survey.menu().rows.some((r) => r.label === "Undo measured move")).toBe(true));
    expect(reviewRoomSurveyMove).toHaveBeenLastCalledWith(expect.anything(), summary, proposal, "apply");
    click(survey, "Undo measured move");
    await vi.waitFor(() => expect(survey.menu().lines.join(" ")).toContain("Original pose restored."));
    expect(reviewRoomSurveyMove).toHaveBeenLastCalledWith(expect.anything(), summary, expect.objectContaining({ status: "applied" }), "undo");
    survey.dispose();
  });

  it("refuses sampling with an invalid registration and records a new object only as a pending fix", async () => {
    const { survey, frame } = buildSurvey();
    vi.mocked(api.saveRoomSurvey).mockResolvedValue(summary);
    vi.mocked(api.recordRoomSurveyObservation).mockResolvedValue({
      fixId: "fix", surveyId: summary.id, kind: "new_object", position: [2, 5, 1], createdAtMs: 1_000,
    });
    click(survey, "Measure or mark points");
    click(survey, "Mark a physical point");
    survey.frame(frame, localFromModel, 0.051);
    expect(survey.display.group.visible).toBe(false);
    survey.capture(tracked(1, 5, 1));
    survey.frame(frame, localFromModel, 0.025);
    click(survey, "Mark a physical point");
    survey.capture(tracked(1, 5, 1));
    click(survey, "Survey tools");
    click(survey, "Save the preview as a room reference");
    await vi.waitFor(() => expect(survey.menu().lines.join(" ")).toContain("Room reference saved"));
    click(survey, "Record structure or a new object");
    click(survey, "Mark a new object");
    survey.capture(tracked(2, 5, 1));
    expect(api.recordRoomSurveyObservation).not.toHaveBeenCalled();
    click(survey, "Save as pending model fix");
    await vi.waitFor(() => expect(api.recordRoomSurveyObservation).toHaveBeenCalledWith("/house", summary.id,
      expect.objectContaining({ kind: "new_object", position: [2, 5, 1] })));
    expect(api.proposeRoomSurveyMove).not.toHaveBeenCalled();
    survey.dispose();
  });
});
