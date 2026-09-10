/**
 * Starting and editing a route draft in the workspace store.
 *
 * The behaviour under test is the one that was missing entirely: a run that does not exist yet can
 * be started, drawn and discarded. Two properties matter more than the plumbing:
 *
 *  - the seeded polyline lands **inside** the place the user is looking at, not at the site origin;
 *  - a draft edit reaches the route list, because the 3D line geometry is built from that list and
 *    not from the draft — a point whose handle moves and whose line does not is the bug this
 *    guards.
 */
import { describe, expect, it } from "vitest";
import { seedPoints, startRouteDraft } from "@/house/components/routeEditor/startRouteDraft";
import { buildManifestIndex, roomAt } from "@/house/model/manifestIndex";
import { createRuntime } from "@/house/runtime";
import { createHouseStore } from "@/house/store/createHouseStore";
import { createMemoryDataApi } from "@/house/store/dataApi";
import type { NewRouteSpec } from "@/house/components/routeEditor/startRouteDraft";
import { FIXTURE_DIR, loadManifest } from "./glb";

const index = buildManifestIndex(loadManifest(FIXTURE_DIR));

const SPEC: NewRouteSpec = {
  name: "Kitchen extract duct",
  medium: "extract_air",
  certainty: "inferred",
  lifecycle: "installed",
  nominalSize: "Ø125 mm",
};

function runtimeWithPackage() {
  const store = createHouseStore();
  store.getState().setPackage({
    modelId: index.modelId,
    fingerprint: "fixture-fingerprint",
    index,
    diagnostics: [],
    issues: [],
    missingAssetIds: [],
    tier0AssetIds: [],
  });
  return createRuntime({ store, dataApi: createMemoryDataApi(), base: "" });
}

describe("seedPoints", () => {
  it("puts both points inside the selected room", () => {
    const { points, roomIds } = seedPoints(index, "f-lower", "r-l-a");
    expect(roomIds).toEqual(["r-l-a", "r-l-a"]);
    for (const p of points) expect(roomAt(index, "f-lower", p[0], p[2])).toBe("r-l-a");
  });

  it("falls back to the middle of the floor, never the origin", () => {
    const { points } = seedPoints(index, "f-lower", null);
    expect(points).toHaveLength(2);
    for (const p of points) expect(Math.hypot(p[0], p[2])).toBeGreaterThan(0);
    // Two distinct points: `infra_route` needs at least two, and a zero-length run is not a run.
    expect(points[0]).not.toEqual(points[1]);
  });

  it("keeps the run at the room's own floor elevation, not the floor datum", () => {
    const room = index.rooms.get("r-l-b");
    const { points } = seedPoints(index, "f-lower", "r-l-b");
    expect(points[0][1]).toBeCloseTo((room?.floorElevation ?? 0) + 0.4, 6);
  });
});

describe("startRouteDraft", () => {
  it("opens a draft and draws it, deriving the system and kind from the medium", () => {
    const runtime = runtimeWithPackage();
    runtime.store.getState().setSelection({ kind: "room", id: "r-l-a" });

    const draft = startRouteDraft(runtime, SPEC);
    expect(draft).not.toBeNull();

    const s = runtime.store.getState();
    expect(s.routeDraft?.id).toBe(draft?.id);
    expect(s.routeDraftIsNew).toBe(true);
    expect(s.routeDraft?.system).toBe("ventilation");
    expect(s.routeDraft?.kind).toBe("duct");
    // In the list as well as in the draft: the 3D line is built from the list.
    expect(s.routes.map((r) => r.id)).toEqual([draft?.id]);
    expect(s.routes[0]?.segments).toEqual([{ floorId: "f-lower", roomId: "r-l-a" }]);
  });

  it("carries the stored medium, not just the presentation system", () => {
    // `Route` has no medium field, so a draft that dropped it would be saved back as the system's
    // default — an extract-air duct silently becoming supply air.
    const runtime = runtimeWithPackage();
    const draft = startRouteDraft(runtime, SPEC);
    expect(draft?.medium).toBe("extract_air");
    expect(draft?.nominalSize).toBe("Ø125 mm");
    // `inferred` is not measured, so the run says so.
    expect(draft?.isEstimated).toBe(true);
  });

  it("refuses when no package is loaded, rather than appearing to do nothing", () => {
    const runtime = createRuntime({
      store: createHouseStore(),
      dataApi: createMemoryDataApi(),
      base: "",
    });
    expect(startRouteDraft(runtime, SPEC)).toBeNull();
    expect(runtime.store.getState().routeDraft).toBeNull();
  });
});

describe("editing the draft", () => {
  it("mirrors moved, inserted and deleted points into the drawn route", () => {
    const runtime = runtimeWithPackage();
    const draft = startRouteDraft(runtime, SPEC);
    const id = draft?.id ?? "";
    const drawn = () => runtime.store.getState().routes.find((r) => r.id === id);

    runtime.store.getState().setRoutePoint(1, [4, 1.1, 2]);
    expect(drawn()?.points[1]).toEqual([4, 1.1, 2]);

    runtime.store.getState().insertRoutePoint(1, [3, 1.1, 2]);
    expect(drawn()?.points).toHaveLength(3);
    expect(drawn()?.points[1]).toEqual([3, 1.1, 2]);
    // One segment per span, so the inserted point brings its own.
    expect(drawn()?.segments).toHaveLength(2);

    runtime.store.getState().deleteRoutePoint(1);
    expect(drawn()?.points).toHaveLength(2);
    expect(drawn()?.points[1]).toEqual([4, 1.1, 2]);
  });

  it("never lets a run fall below two points", () => {
    const runtime = runtimeWithPackage();
    startRouteDraft(runtime, SPEC);
    runtime.store.getState().deleteRoutePoint(0);
    expect(runtime.store.getState().routeDraft?.points).toHaveLength(2);
  });

  it("holds the previous route so an edit to a stored run can be reverted", () => {
    const runtime = runtimeWithPackage();
    const draft = startRouteDraft(runtime, SPEC);
    const stored = draft as NonNullable<typeof draft>;
    // Re-open it the way the inspector does: an existing run, not a new one.
    runtime.store.getState().endRouteDraft();
    runtime.store.getState().beginRouteDraft(stored);

    const s = runtime.store.getState();
    expect(s.routeDraftIsNew).toBe(false);
    expect(s.routeDraftOrigin).toEqual(stored);

    s.setRoutePoint(0, [9, 9, 9]);
    // The origin snapshot is the pre-edit route, which is what "revert" puts back.
    expect(runtime.store.getState().routeDraftOrigin?.points[0]).toEqual(stored.points[0]);
  });

  it("does not draw a draft the caller never added to the list", () => {
    const runtime = runtimeWithPackage();
    const draft = startRouteDraft(runtime, SPEC);
    const id = draft?.id ?? "";
    runtime.store.getState().removeRoute(id);
    runtime.store.getState().setRoutePoint(0, [1, 1, 1]);
    expect(runtime.store.getState().routes).toHaveLength(0);
    expect(runtime.store.getState().routeDraft?.points[0]).toEqual([1, 1, 1]);
  });

  it("keeps a hovered next point transient until it is explicitly inserted", () => {
    const runtime = runtimeWithPackage();
    startRouteDraft(runtime, SPEC);
    const before = runtime.store.getState().routeDraft?.points;
    runtime.store.getState().setRouteDraftHover({
      point: [7, 3.4, 2],
      floorId: "f-upper",
      roomId: "r-u-a",
    });
    expect(runtime.store.getState().routeDraft?.points).toEqual(before);
    expect(runtime.store.getState().routeDraftHover?.floorId).toBe("f-upper");
  });

  it("preserves per-span floor ownership when inserting and deleting a middle point", () => {
    const runtime = runtimeWithPackage();
    startRouteDraft(runtime, SPEC);
    const store = runtime.store.getState();
    store.setRouteSegmentPlace(0, { floorId: "f-lower", roomId: "r-l-a" });
    store.updateRouteDraft({ pointKinds: ["junction", "outlet"] });
    store.insertRoutePoint(1, [3, 3.4, 2], { floorId: "f-upper", roomId: "r-u-a" });
    expect(runtime.store.getState().routeDraft?.segments).toEqual([
      { floorId: "f-lower", roomId: "r-l-a" },
      { floorId: "f-upper", roomId: "r-u-a" },
    ]);
    expect(runtime.store.getState().routeDraft?.pointKinds).toEqual([
      "junction",
      "vertex",
      "outlet",
    ]);
    runtime.store.getState().deleteRoutePoint(1);
    expect(runtime.store.getState().routeDraft?.segments).toEqual([
      { floorId: "f-lower", roomId: "r-l-a" },
    ]);
    expect(runtime.store.getState().routeDraft?.pointKinds).toEqual(["junction", "outlet"]);
  });

  it("filters route kinds independently", () => {
    const runtime = runtimeWithPackage();
    expect(runtime.store.getState().visibleRouteKinds.duct).toBe(true);
    runtime.store.getState().toggleRouteKind("duct");
    expect(runtime.store.getState().visibleRouteKinds).toMatchObject({ duct: false, pipe: true });
  });
});

describe("canceling route edits", () => {
  it("removes a new draft from the scene", () => {
    const runtime = runtimeWithPackage();
    const route = startRouteDraft(runtime, SPEC)!;
    runtime.store.getState().cancelRouteDraft();
    expect(runtime.store.getState().routeDraft).toBeNull();
    expect(runtime.store.getState().routes.some((r) => r.id === route.id)).toBe(false);
  });
  it("restores the original path and refuses cancellation during a save", () => {
    const runtime = runtimeWithPackage();
    const route = startRouteDraft(runtime, SPEC)!;
    runtime.store.getState().endRouteDraft();
    runtime.store.getState().beginRouteDraft(route);
    runtime.store.getState().setRoutePoint(0, [8, 8, 8]);
    runtime.store.getState().setEditorSaving(true);
    runtime.store.getState().cancelRouteDraft();
    expect(runtime.store.getState().routeDraft).not.toBeNull();
    runtime.store.getState().setEditorSaving(false);
    runtime.store.getState().cancelRouteDraft();
    expect(runtime.store.getState().routes[0]?.points).toEqual(route.points);
  });
});
