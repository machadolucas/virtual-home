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
import { assertPhysicalY, resolveNumeric, resolveSnap, WALL_STANDOFF } from "@/house/scene/snap";
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
    expect(store.getState().explode.locked).toBe(false);
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
    dirty: false,
  };
}
