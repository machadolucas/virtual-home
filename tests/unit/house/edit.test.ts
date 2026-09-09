/**
 * Edit-mode tests: snapping, the exploded-save invariant, the undo stack, the URL round-trip and
 * package-swap reconciliation.
 *
 * The load-bearing property here is that a coordinate is **never** read out of the presentation:
 * floor snapping derives Y from `room.floorElevation`, and a draft made while the model was
 * exploded still serialises the physical value.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { snapValue } from "@/house/model/geometry2d";
import { coordinateStamp, reconcile } from "@/house/model/reconcile";
import type { PlacementMount, Vec3 } from "@/house/model/types";
import type { PickResult } from "@/house/scene/picker";
import {
  assertPhysicalY,
  isSoffitSurface,
  resolveNumeric,
  resolveSnap,
  WALL_STANDOFF,
} from "@/house/scene/snap";
import { dragCandidates } from "@/house/scene/picker";
import { wallFrame } from "@/house/scene/wallFrame";
import { COALESCE_MS, UNDO_LIMIT, type EditDraft } from "@/house/store/slices/edit";
import { createHouseStore } from "@/house/store/createHouseStore";
import {
  decodeSelection,
  encodeSelection,
  readUrlState,
  writeUrlState,
} from "@/house/store/urlSync";
import { FIXTURE_DIR } from "./glb";
import { buildScene } from "./sceneFromGlb";

const SNAP = { grid: 0.05, rotationStep: 15, enabled: true, wallSnap: true };

const draftAt = (physical: Vec3, floorId: string, mount: PlacementMount = { kind: "floor", height: 0 }) => ({
  physical,
  rotationYDeg: 0,
  mount,
  floorId,
});

function hitOn(
  built: ReturnType<typeof buildScene>,
  surfaceId: string,
  roomId: string | null,
  point: THREE.Vector3,
): PickResult {
  const object = built.index.surfaceMesh.get(surfaceId) ?? new THREE.Object3D();
  const room = roomId ? built.manifestIndex.rooms.get(roomId) : undefined;
  return {
    surfaceId,
    elementId: null,
    roomId,
    floorId: room?.floorId ?? null,
    buildingId: room?.buildingId ?? null,
    point,
    object,
    distance: 1,
  };
}

describe("floor snapping (fixture)", () => {
  const built = buildScene(FIXTURE_DIR);
  // r-l-b sits 0.2 m below its floor datum — the fixture's stand-in for the living-room case.
  const room = built.manifestIndex.rooms.get("r-l-b")!;

  it("puts the marker on the room's own floor, not on the floor datum", () => {
    expect(room.floorElevation).toBe(-0.2);
    expect(built.manifestIndex.floors.get("f-lower")!.elevation).toBe(0);

    const solution = resolveSnap({
      hit: hitOn(built, "s-r-l-b-floor", "r-l-b", new THREE.Vector3(3.77, -0.2, 2.13)),
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower"),
    });

    expect(solution.physical).toEqual([3.75, -0.2, 2.15]);
    expect(solution.mount).toEqual({ kind: "floor", height: 0 });
    expect(solution.roomId).toBe("r-l-b");
    expect(solution.floorId).toBe("f-lower");
  });

  it("measures the mounting height from that same room floor", () => {
    const solution = resolveSnap({
      hit: hitOn(built, "s-r-l-b-floor", "r-l-b", new THREE.Vector3(3.5, -0.2, 2)),
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower", { kind: "floor", height: 1.2 }),
    });
    // −0.2 + 1.2, never 0 + 1.2.
    expect(solution.physical[1]).toBeCloseTo(1, 9);
  });

  it("ignores the hit's own Y, so an exploded view cannot leak into the saved value", () => {
    const flat = resolveSnap({
      hit: hitOn(built, "s-r-l-b-floor", "r-l-b", new THREE.Vector3(3.5, -0.2, 2)),
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower"),
    });
    // The same click while the floor group is offset 2.5 m upwards for presentation.
    const exploded = resolveSnap({
      hit: hitOn(built, "s-r-l-b-floor", "r-l-b", new THREE.Vector3(3.5, -0.2 + 2.5, 2)),
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower"),
    });
    expect(exploded.physical).toEqual(flat.physical);
  });

  it("snaps to the grid, and stops snapping while Alt is held", () => {
    const hit = hitOn(built, "s-r-l-b-floor", "r-l-b", new THREE.Vector3(3.7712, -0.2, 2.1337));
    const snapped = resolveSnap({
      hit,
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower"),
    });
    const free = resolveSnap({
      hit,
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower"),
      modifiers: { alt: true },
    });
    expect(snapped.physical[0]).toBe(3.75);
    // Alt keeps the raw position but still rounds to millimetres for storage.
    expect(free.physical[0]).toBe(3.771);
  });
});

describe("wall snapping (fixture)", () => {
  const built = buildScene(FIXTURE_DIR);
  const surfaceId = "s-w-l-ab--r-l-b";
  const room = built.manifestIndex.rooms.get("r-l-b")!;
  const anchor = built.manifestIndex.roomAnchors.get(room.id)!.point;
  const mesh = built.index.surfaceMesh.get(surfaceId)!;
  const frame = wallFrame(mesh, {
    towards: new THREE.Vector3(anchor[0], anchor[1], anchor[2]),
  });

  it("records the height above the room's floor and stands clear of the face", () => {
    const target = frame.toWorld(0.6, room.floorElevation + 1.1, 0);
    const solution = resolveSnap({
      hit: hitOn(built, surfaceId, room.id, target),
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower"),
      meshOf: (id) => built.index.surfaceMesh.get(id),
      anchorOf: (id) => built.manifestIndex.roomAnchors.get(id)?.point,
    });

    expect(solution.mount.kind).toBe("wall");
    if (solution.mount.kind !== "wall") throw new Error("expected a wall mount");
    expect(solution.mount.surfaceId).toBe(surfaceId);
    expect(solution.mount.height).toBeCloseTo(1.1, 6);
    expect(solution.mount.offset).toBe(WALL_STANDOFF);
    expect(solution.surfaceId).toBe(surfaceId);
    expect(solution.roomId).toBe(room.id);

    // The mount height is above the ROOM floor (−0.2), so the world Y is 0.9, not 1.1.
    expect(solution.physical[1]).toBeCloseTo(room.floorElevation + 1.1, 3);

    // The standoff survives the grid snap: the grid applies to `u`/`height` in the wall's own
    // frame, so re-snapping world X/Z would leave the marker co-planar with the wall.
    const placed = frame.toLocal(new THREE.Vector3(...solution.physical));
    expect(placed.d).toBeCloseTo(WALL_STANDOFF, 3);
  });

  it("faces the marker into the room and snaps the rotation to 15°", () => {
    const target = frame.toWorld(0.6, room.floorElevation + 1.1, 0);
    const solution = resolveSnap({
      hit: hitOn(built, surfaceId, room.id, target),
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower"),
      meshOf: (id) => built.index.surfaceMesh.get(id),
      anchorOf: (id) => built.manifestIndex.roomAnchors.get(id)?.point,
    });
    expect(solution.rotationYDeg % 15).toBe(0);

    // The standoff moved the point towards the room anchor, never into the wall.
    const roomCentre = new THREE.Vector3(anchor[0], target.y, anchor[2]);
    const placed = new THREE.Vector3(...solution.physical);
    const onFace = new THREE.Vector3(target.x, target.y, target.z);
    expect(placed.distanceTo(roomCentre)).toBeLessThan(onFace.distanceTo(roomCentre));
  });

  it("round-trips the wall frame's own coordinates", () => {
    for (const u of [0, 0.35, 1.2]) {
      const world = frame.toWorld(frame.uRange[0] + u, room.floorElevation + 0.8, 0.02);
      const local = frame.toLocal(world);
      expect(local.u).toBeCloseTo(frame.uRange[0] + u, 6);
      expect(local.d).toBeCloseTo(0.02, 6);
    }
  });
});

describe("free placement (fixture)", () => {
  const built = buildScene(FIXTURE_DIR);

  it("resolves the room by point-in-ring on the drafted floor", () => {
    const inside = resolveSnap({
      hit: null,
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([1.5, 0, 2], "f-lower"),
      freePoint: new THREE.Vector3(1.5, 0, 2),
    });
    expect(inside.roomId).toBe("r-l-a");

    // The 0.1 m gap between r-l-a and r-l-b belongs to no room.
    const between = resolveSnap({
      hit: null,
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([3.05, 0, 2], "f-lower"),
      freePoint: new THREE.Vector3(3.05, 0, 2),
    });
    expect(between.roomId).toBeNull();
  });

  it("constrains the drag to the dominant axis while Shift is held", () => {
    const solution = resolveSnap({
      hit: null,
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([1, 0, 1], "f-lower"),
      freePoint: new THREE.Vector3(2.5, 0, 1.2),
      modifiers: { shift: true },
    });
    expect(solution.physical[0]).toBe(2.5);
    expect(solution.physical[2]).toBe(1); // Z pinned to where the drag started
  });

  it("agrees with the numeric path for the same coordinates", () => {
    const dragged = resolveSnap({
      hit: null,
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([1.5, 0, 2], "f-lower"),
      freePoint: new THREE.Vector3(1.5123, 0, 1.9876),
    });
    const typed = resolveNumeric(
      built.manifestIndex,
      draftAt(dragged.physical, "f-lower"),
      SNAP,
    );
    expect(typed.physical).toEqual(dragged.physical);
    expect(typed.roomId).toBe(dragged.roomId);
  });
});

describe("the exploded-save invariant", () => {
  it("collapses and locks the exploded view on entering edit mode", () => {
    const store = createHouseStore();
    store.getState().setExplode({ enabled: true, gap: 2.5 });
    expect(store.getState().explode.gap).toBe(2.5);

    store.getState().beginEdit(draft());
    expect(store.getState().explode).toMatchObject({ enabled: false, gap: 0, locked: true });

    // The control is refused while locked, so no code path can re-separate the floors mid-edit.
    store.getState().setExplode({ gap: 2.5, enabled: true });
    expect(store.getState().explode.gap).toBe(0);

    store.getState().cancelEdit();
    expect(store.getState().explode).toMatchObject({ enabled: true, gap: 2.5, locked: false });
  });

  it("serialises the physical Y even when the lock is forcibly bypassed", () => {
    const store = createHouseStore();
    store.getState().beginEdit(draft());
    // Bypass the lock the way only a bug could: write the slice directly.
    store.setState((s) => ({ explode: { ...s.explode, enabled: true, gap: 2.5, locked: false } }));
    store.getState().updateDraft({ physical: [1.5, -0.2, 2] });

    const editing = store.getState().editing!;
    expect(store.getState().explode.gap).toBe(2.5);
    // The draft is the authority, and it holds physical metres regardless of the presentation.
    expect(editing.physical).toEqual([1.5, -0.2, 2]);
  });

  it("asserts the world position minus the group offset equals the draft", () => {
    expect(() => assertPhysicalY(2.3, 2.5, -0.2)).not.toThrow();
    expect(() => assertPhysicalY(2.3, 0, -0.2)).toThrow(/placement Y mismatch/);
  });
});

describe("undo stack", () => {
  it("coalesces a continuous drag into one step", () => {
    const store = createHouseStore();
    store.getState().beginEdit(draft());
    store.getState().updateDraft({ physical: [1, 0, 1] }, { coalesce: true });
    store.getState().updateDraft({ physical: [1.05, 0, 1] }, { coalesce: true });
    store.getState().updateDraft({ physical: [1.1, 0, 1] }, { coalesce: true });

    const undo = store.getState().undo;
    expect(undo).toHaveLength(1);
    expect(undo[0]!.t).toBe("draft");
    if (undo[0]!.t !== "draft") throw new Error("expected a draft entry");
    expect(undo[0]!.before.physical).toEqual([0, 0, 0]);
    expect(undo[0]!.after.physical).toEqual([1.1, 0, 1]);
    expect(COALESCE_MS).toBeGreaterThan(0);
  });

  it("keeps discrete edits separate and bounds the stack", () => {
    const store = createHouseStore();
    store.getState().beginEdit(draft());
    for (let i = 0; i < UNDO_LIMIT + 10; i++)
      store.getState().updateDraft({ rotationYDeg: i * 15 });
    expect(store.getState().undo).toHaveLength(UNDO_LIMIT);
  });

  it("moves entries between undo and redo", () => {
    const store = createHouseStore();
    store.getState().beginEdit(draft());
    store.getState().updateDraft({ physical: [1, 0, 1] });
    const entry = store.getState().popUndo();
    expect(entry?.t).toBe("draft");
    expect(store.getState().undo).toHaveLength(0);
    expect(store.getState().redo).toHaveLength(1);
    expect(store.getState().popRedo()).toBe(entry);
    expect(store.getState().undo).toHaveLength(1);
  });

  it("drops draft entries on cancel, so undo never rewinds a cancelled edit", () => {
    const store = createHouseStore();
    store.getState().beginEdit(draft());
    store.getState().updateDraft({ physical: [1, 0, 1] });
    store.getState().cancelEdit();
    expect(store.getState().undo).toHaveLength(0);
    expect(store.getState().editing).toBeNull();
  });
});

describe("URL state", () => {
  it("round-trips a selection", () => {
    expect(encodeSelection({ kind: "room", id: "r-l-a" })).toBe("room:r-l-a");
    expect(decodeSelection("room:r-l-a")).toEqual({ kind: "room", id: "r-l-a" });
    // A surface id contains colons; only the first one separates the kind.
    expect(decodeSelection("surface:s-w-l-ab--r-l-b")).toEqual({
      kind: "surface",
      id: "s-w-l-ab--r-l-b",
    });
  });

  it("rejects an unknown kind and an unsafe id", () => {
    expect(decodeSelection("script:alert")).toBeNull();
    expect(decodeSelection("room:../../etc/passwd")).toBeNull();
    expect(decodeSelection("room:")).toBeNull();
    expect(decodeSelection(null)).toBeNull();
  });

  it("omits the defaults so a plain overview has a clean URL", () => {
    expect(
      writeUrlState("", {
        selection: null,
        activeFloorId: null,
        viewMode: "overview",
        projection: "perspective",
      }),
    ).toBe("");
    expect(
      writeUrlState("", {
        selection: { kind: "equipment", id: "p1" },
        activeFloorId: "f-upper",
        viewMode: "plan",
        projection: "ortho",
      }),
    ).toBe("?sel=equipment%3Ap1&floor=f-upper&view=plan&proj=ortho");
  });

  it("reads back what it wrote, and drops a malformed floor id", () => {
    const written = writeUrlState("", {
      selection: { kind: "room", id: "r-u-a" },
      activeFloorId: "f-upper",
      viewMode: "floor",
      projection: "ortho",
    });
    expect(readUrlState(written)).toEqual({
      selection: { kind: "room", id: "r-u-a" },
      activeFloorId: "f-upper",
      viewMode: "floor",
      projection: "ortho",
    });
    expect(readUrlState("?floor=%2Fetc%2Fpasswd").activeFloorId).toBeNull();
    expect(readUrlState("?view=dollhouse").viewMode).toBeNull();
  });
});

describe("reconciliation after a package swap", () => {
  const built = buildScene(FIXTURE_DIR, { assetIds: [] });
  const index = built.manifestIndex;
  const stamp = {
    modelId: index.modelId,
    fingerprint: "aaaaaaaaaaaaaaaa",
    coordinate: coordinateStamp(index),
  };

  it("is clean when every id still resolves", () => {
    const report = reconcile(index, stamp, { modelId: index.modelId, fingerprint: "bbbbbbbbbbbbbbbb" }, {
      surfaceIds: ["s-r-l-a-floor"],
      roomIds: ["r-l-a"],
      floorIds: ["f-lower"],
      positions: [[1, 0, 1]],
    });
    expect(report.clean).toBe(true);
    // A new fingerprint alone is not a reconciliation: the same ids in a new build are fine.
    expect(report.fingerprintChanged).toBe(true);
  });

  it("names every id the new package no longer knows, without migrating anything", () => {
    const report = reconcile(index, stamp, { modelId: index.modelId, fingerprint: "b".repeat(16) }, {
      surfaceIds: ["s-r-l-a-floor", "s-gone", "s-gone"],
      roomIds: ["r-nope"],
      elementIds: ["e-nope"],
      floorIds: ["f-nope"],
      positions: [[1, 0, 1], [999, 0, 0]],
    });
    expect(report.unknownSurfaceIds).toEqual(["s-gone"]);
    expect(report.unknownRoomIds).toEqual(["r-nope"]);
    expect(report.unknownElementIds).toEqual(["e-nope"]);
    expect(report.unknownFloorIds).toEqual(["f-nope"]);
    expect(report.outOfBoundsPositions).toBe(1);
    expect(report.clean).toBe(false);
  });

  it("flags a changed coordinate system, which invalidates every stored metre", () => {
    const moved = { ...stamp, coordinate: { ...stamp.coordinate, siteElevationOffset: 42 } };
    const report = reconcile(index, moved, { modelId: index.modelId, fingerprint: stamp.fingerprint }, {});
    expect(report.coordinateSystemChanged).toBe(true);
    expect(report.clean).toBe(false);
  });

  it("flags a different model id", () => {
    const report = reconcile(index, stamp, { modelId: "someone-elses-house", fingerprint: stamp.fingerprint }, {});
    expect(report.modelIdChanged).toBe(true);
    expect(report.clean).toBe(false);
  });
});

describe("millimetre rounding", () => {
  it("keeps persisted coordinates free of float dust", () => {
    expect(snapValue(0.1 + 0.2, 0.05)).toBe(0.3);
    expect(snapValue(1.23456, 0)).toBe(1.235);
    expect(snapValue(-0.024, 0.05)).toBe(-0);
  });
});

function draft(): EditDraft {
  return {
    placementId: null,
    equipmentId: "asset-1",
    modelId: "fixture-house",
    name: "Test sensor",
    physical: [0, 0, 0],
    rotationYDeg: 0,
    mount: { kind: "floor", height: 0 },
    floorId: "f-lower",
    roomId: "r-l-a",
    surfaceId: null,
    locationNote: "",
    photoId: null,
    symbol: null,
    dirty: false,
  };
}

/**
 * Ceilings and eaves — the mount that used to be impossible.
 *
 * The house has lamps under its eaves, and the package models a roof underside as a surface of
 * kind `other` (`s-e-roof-house-under`). Those were absent from the pick set, and the workspace's
 * mount union only knew `floor` and `wall`, so an eave spot could not be expressed even though the
 * database column and the endpoint both accepted a ceiling mount.
 */
describe("ceiling and soffit snapping", () => {
  const built = buildScene(FIXTURE_DIR);

  it("recognises a soffit by kind or by the package's id convention", () => {
    expect(isSoffitSurface("s-r-l-a-ceiling", "ceiling")).toBe(true);
    // The real package's roof undersides, which are kind `other`.
    expect(isSoffitSurface("s-e-roof-house-under", "other")).toBe(true);
    expect(isSoffitSurface("s-e-roof-garage-under", "other")).toBe(true);
    expect(isSoffitSurface("s-e-eave-north", "other")).toBe(true);
    // Everything else of kind `other` keeps falling through to the free plane.
    expect(isSoffitSurface("s-e-terrain-fx", "other")).toBe(false);
    expect(isSoffitSurface("s-e-f-ground-ext-out-0-wood", "wall")).toBe(false);
  });

  it("hangs a fixture from the ceiling it was aimed at", () => {
    const solution = resolveSnap({
      hit: hitOn(built, "s-r-l-a-ceiling", "r-l-a", new THREE.Vector3(1.53, 2.4, 1.47)),
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower"),
    });

    expect(solution.mount.kind).toBe("ceiling");
    expect(solution.surfaceId).toBe("s-r-l-a-ceiling");
    // Flush with the surface until a drop is typed.
    expect(solution.physical[1]).toBeCloseTo(2.4, 6);
    expect(solution.roomId).toBe("r-l-a");
  });

  it("drops a pendant by the height given, measured from the surface downwards", () => {
    const solution = resolveSnap({
      hit: hitOn(built, "s-r-l-a-ceiling", "r-l-a", new THREE.Vector3(1.5, 2.4, 1.5)),
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower", {
        kind: "ceiling",
        surfaceId: "s-r-l-a-ceiling",
        height: 0.35,
        offset: 0,
      }),
    });
    expect(solution.physical[1]).toBeCloseTo(2.4 - 0.35, 6);
    expect(solution.mount).toMatchObject({ kind: "ceiling", height: 0.35 });
  });

  it("keeps a ceiling mount out of the way of the wall snap", () => {
    // A wall hit still wall-snaps: the ceiling branch runs before the floor branch, so it has to
    // be narrow enough not to swallow the wall case that comes before it.
    const surfaceId = "s-w-l-ab--r-l-b";
    const room = built.manifestIndex.rooms.get("r-l-b")!;
    const mesh = built.index.surfaceMesh.get(surfaceId)!;
    const anchorPoint = built.manifestIndex.roomAnchors.get(room.id)!.point;
    const frame = wallFrame(mesh, {
      towards: new THREE.Vector3(anchorPoint[0], anchorPoint[1], anchorPoint[2]),
    });
    const target = frame.toWorld(0.6, room.floorElevation + 1.1, 0);

    const wall = resolveSnap({
      hit: hitOn(built, surfaceId, room.id, target),
      config: SNAP,
      manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-lower"),
      meshOf: (id) => built.index.surfaceMesh.get(id),
      anchorOf: (id) => built.manifestIndex.roomAnchors.get(id)?.point,
    });
    expect(wall.mount.kind).toBe("wall");
  });

  it("admits ceilings and soffits to the pick set, whatever floor is isolated", () => {
    const candidates = dragCandidates(built.index, "f-lower");
    const names = candidates.map((c) => c.name);
    // A ceiling of the isolated floor is aimable…
    expect(names.some((n) => n.includes("ceiling"))).toBe(true);
    // …and so are floors and walls, as before.
    expect(names.some((n) => n.includes("floor"))).toBe(true);
  });
});

/**
 * The undo stack, which used to grow as you undid.
 *
 * `UndoBar` applied an entry through `updateDraft`, which pushes a *new* entry and clears the redo
 * stack — so Undo never reached further than one step and Redo could never become enabled. A draft
 * entry also carries its own `placementId`, so a stack surviving `endEdit` could write one
 * placement's numbers onto another's row.
 */
describe("undo and redo", () => {
  const stepsOf = (store: ReturnType<typeof createHouseStore>) => store.getState().undo.length;

  it("walks back through every step, not just the last one", () => {
    const store = createHouseStore();
    store.getState().beginEdit(draft());

    store.getState().updateDraft({ physical: [1, 0, 1] });
    store.getState().updateDraft({ physical: [2, 0, 2] });
    store.getState().updateDraft({ physical: [3, 0, 3] });
    expect(stepsOf(store)).toBe(3);

    // What UndoBar does now: pop, then write the draft *without* recording a new step.
    const first = store.getState().popUndo();
    store.getState().setDraft((first as { before: EditDraft }).before);
    expect(store.getState().editing?.physical).toEqual([2, 0, 2]);
    expect(stepsOf(store)).toBe(2);

    const second = store.getState().popUndo();
    store.getState().setDraft((second as { before: EditDraft }).before);
    expect(store.getState().editing?.physical).toEqual([1, 0, 1]);
    expect(stepsOf(store)).toBe(1);
  });

  it("fills the redo stack as it goes, so a step can be re-applied", () => {
    const store = createHouseStore();
    store.getState().beginEdit(draft());
    store.getState().updateDraft({ physical: [1, 0, 1] });

    const entry = store.getState().popUndo();
    store.getState().setDraft((entry as { before: EditDraft }).before);
    expect(store.getState().redo).toHaveLength(1);

    const back = store.getState().popRedo();
    store.getState().setDraft((back as { after: EditDraft }).after);
    expect(store.getState().editing?.physical).toEqual([1, 0, 1]);
  });

  it("starts each editing session with empty stacks", () => {
    const store = createHouseStore();
    store.getState().beginEdit(draft());
    store.getState().updateDraft({ physical: [9, 0, 9] });
    store.getState().endEdit();

    // Session two must not be able to reach session one's numbers.
    store.getState().beginEdit({ ...draft(), placementId: "other-placement" });
    expect(store.getState().undo).toEqual([]);
    expect(store.getState().redo).toEqual([]);
  });

  it("puts the exploded view back the way it was found", () => {
    const store = createHouseStore();
    store.getState().setExplode({ enabled: true, gap: 2.5 });

    store.getState().beginEdit(draft());
    expect(store.getState().explode.gap).toBe(0);

    store.getState().endEdit();
    // Leaving it at 0 made the On/Off button flip its label and move nothing.
    expect(store.getState().explode.gap).toBe(2.5);
    expect(store.getState().explode.locked).toBe(false);

    store.getState().beginEdit(draft());
    store.getState().cancelEdit();
    expect(store.getState().explode.gap).toBe(2.5);
  });
});

describe("the not-placed-yet list", () => {
  const equipment = {
    assetId: "asset-1",
    name: "Yard lamp",
    category: "outdoor",
    status: "installed",
    locationName: null,
  };

  it("drops equipment when it is placed and takes it back when the placement is removed", () => {
    const store = createHouseStore();
    store.getState().setPlaceable([equipment]);

    store.getState().markPlaced("asset-1");
    expect(store.getState().placeable).toEqual([]);

    // Removing a placement says "it is not here", not "it does not exist".
    store.getState().restorePlaceable(equipment);
    expect(store.getState().placeable.map((e) => e.assetId)).toEqual(["asset-1"]);
  });

  it("does not list the same equipment twice", () => {
    const store = createHouseStore();
    store.getState().setPlaceable([equipment]);
    store.getState().restorePlaceable(equipment);
    expect(store.getState().placeable).toHaveLength(1);
  });
});

/**
 * Typed numbers move the marker.
 *
 * `resolveNumeric` used to derive the position from the mount only for a floor mount with a room,
 * so typing a height on a wall, ceiling or free mount changed `mount` and nothing else — and the
 * row was saved with the old `pos_y` beside the new `mount_height_m`. The inspector then read one
 * number while the marker sat at another.
 */
describe("numeric editing across mount kinds", () => {
  const built = buildScene(FIXTURE_DIR);
  const room = built.manifestIndex.rooms.get("r-l-b")!; // floor at −0.2

  it("puts a floor mount at the room's own floor plus the height", () => {
    const solution = resolveNumeric(
      built.manifestIndex,
      draftAt([3.5, 0, 2], "f-lower", { kind: "floor", height: 1.2 }),
      SNAP,
    );
    expect(solution.physical[1]).toBeCloseTo(room.floorElevation + 1.2, 6);
  });

  it("moves a free mount too, instead of leaving the height as a lonely number", () => {
    const solution = resolveNumeric(
      built.manifestIndex,
      draftAt([3.5, 0, 2], "f-lower", { kind: "free", height: 2 }),
      SNAP,
    );
    expect(solution.physical[1]).toBeCloseTo(room.floorElevation + 2, 6);
  });

  it("drops a ceiling mount from the surface it hangs on, using the previous drop to find it", () => {
    // The marker is at 2.4 with no drop, so the surface is at 2.4; a 0.5 m drop puts it at 1.9.
    const solution = resolveNumeric(
      built.manifestIndex,
      draftAt([1.5, 2.4, 1.5], "f-lower", {
        kind: "ceiling",
        surfaceId: "s-r-l-a-ceiling",
        height: 0.5,
        offset: 0,
      }),
      SNAP,
      { previousMount: { kind: "ceiling", surfaceId: "s-r-l-a-ceiling", height: 0, offset: 0 } },
    );
    expect(solution.physical[1]).toBeCloseTo(1.9, 6);
    expect(solution.surfaceId).toBe("s-r-l-a-ceiling");
  });

  it("projects a wall mount onto its wall, so the standoff moves the marker", () => {
    const surfaceId = "s-w-l-ab--r-l-b";
    const mesh = built.index.surfaceMesh.get(surfaceId)!;
    const anchor = built.manifestIndex.roomAnchors.get(room.id)!.point;
    const frame = wallFrame(mesh, {
      towards: new THREE.Vector3(anchor[0], anchor[1], anchor[2]),
    });
    const onFace = frame.toWorld(0.6, room.floorElevation + 1.1, WALL_STANDOFF);

    const solution = resolveNumeric(
      built.manifestIndex,
      {
        physical: [onFace.x, onFace.y, onFace.z],
        rotationYDeg: 0,
        mount: { kind: "wall", surfaceId, height: 1.4, offset: WALL_STANDOFF },
        floorId: "f-lower",
      },
      SNAP,
      {
        meshOf: (id) => built.index.surfaceMesh.get(id),
        anchorOf: (id) => built.manifestIndex.roomAnchors.get(id)?.point,
      },
    );

    // The height is measured from the room's own floor, and the point stays on the wall plane.
    expect(solution.physical[1]).toBeCloseTo(room.floorElevation + 1.4, 3);
    const local = frame.toLocal(
      new THREE.Vector3(solution.physical[0], solution.physical[1], solution.physical[2]),
    );
    expect(local.d).toBeCloseTo(WALL_STANDOFF, 3);
  });
});

describe("outdoor mounts", () => {
  it("snaps a roomless exterior face on the picked side and preserves it during numeric edits", () => {
    const built = buildScene(FIXTURE_DIR);
    const hit = hitOn(built, "s-e-l-ext-out", null, new THREE.Vector3(0, 1.35, 1.4));
    hit.normal = new THREE.Vector3(-1, 0, 0);
    const solution = resolveSnap({ hit, config: SNAP, manifest: built.manifestIndex,
      draft: draftAt([0, 0, 0], "f-upper"), meshOf: (id) => built.index.surfaceMesh.get(id) });
    expect(solution).toMatchObject({ mount: { kind: "wall", height: 1.35 }, floorId: "f-lower", roomId: null,
      surfaceId: "s-e-l-ext-out" });
    expect(solution.physical[0]).toBeCloseTo(-WALL_STANDOFF);
    const numeric = resolveNumeric(built.manifestIndex, { ...solution, physical: solution.physical }, SNAP,
      { meshOf: (id) => built.index.surfaceMesh.get(id) });
    expect(numeric.physical).toEqual(solution.physical);
    expect(numeric.mount).toEqual(solution.mount);
    expect(numeric.roomId).toBeNull();
    expect(numeric.floorId).toBe("f-lower");
    if (numeric.mount.kind !== "wall") throw new Error("Expected a wall mount");
    const flush = resolveNumeric(built.manifestIndex, { ...numeric, mount: { ...numeric.mount, offset: 0 } }, SNAP,
      { meshOf: (id) => built.index.surfaceMesh.get(id) });
    const raised = resolveNumeric(built.manifestIndex, { ...flush, mount: { ...numeric.mount, offset: 0.1 } }, SNAP,
      { meshOf: (id) => built.index.surfaceMesh.get(id) });
    expect(raised.physical[0]).toBeCloseTo(-0.1);
    expect(dragCandidates(built.index, "f-lower")).toContain(hit.object);
  });

  it("keeps a soffit identity for saving", () => {
    const built = buildScene(FIXTURE_DIR);
    const solution = resolveSnap({ hit: hitOn(built, "s-e-roof-fx-under", null, new THREE.Vector3(-0.2, 4.95, 1)),
      config: SNAP, manifest: built.manifestIndex, draft: draftAt([0, 0, 0], "f-upper") });
    expect(solution.mount).toMatchObject({ kind: "ceiling", surfaceId: "s-e-roof-fx-under" });
    expect(solution.physical[1]).toBe(4.95);
  });

  it("does not dismiss or change a placement while its save is pending", () => {
    const store = createHouseStore();
    store.getState().beginEdit(draft());
    store.getState().setEditorSaving(true);
    store.getState().cancelEdit();
    store.getState().updateDraft({ physical: [2, 3, 4] });
    expect(store.getState().editing?.physical).toEqual([0, 0, 0]);
    store.getState().setEditorSaving(false);
    store.getState().cancelEdit();
    expect(store.getState().editing).toBeNull();
  });
});
