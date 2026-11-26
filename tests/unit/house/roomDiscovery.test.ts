import { Matrix4, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import type { Room, Vec2, Vec3 } from "@/house/model/types";
import { calibrationFeatures } from "@/house/xr/mixedCalibration";
import {
  buildAlignmentModel,
  matchRoomAlignment,
  type AlignmentModel,
  type RoomEvidence,
} from "@/house/xr/roomAlignment";
import { RoomDiscovery } from "@/house/xr/roomDiscovery";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = loadManifest(FIXTURE_DIR);
function model(id: string, width: number, depth: number, x = 0, elevation = 3): AlignmentModel {
  const room: Room = {
    ...manifest.rooms[0]!,
    id,
    name: id,
    floorId: `floor-${elevation}`,
    floorElevation: elevation,
    ceilingHeight: 2.5,
    footprint: {
      outer: [
        [x, 0],
        [x + width, 0],
        [x + width, depth],
        [x, depth],
      ],
      holes: [],
    },
  };
  return buildAlignmentModel(room, calibrationFeatures({ ...manifest, rooms: [room] }, room.floorId, id));
}
function sample(model: AlignmentModel, opts: { shift?: number; viewer?: Vec3 } = {}) {
  const { room, walls, landmarks } = model;
  const matrix = new Matrix4()
    .makeRotationY(0.34)
    .setPosition(1.2 + (opts.shift ?? 0), -room.floorElevation, -2.2);
  const project = (p: Vec3) => new Vector3(...p).applyMatrix4(matrix);
  const plan = ([x, z]: Vec2): Vec2 => {
    const p = project([x, room.floorElevation, z]);
    return [p.x, p.z];
  };
  const evidence: RoomEvidence = {
    floor: { y: 0, source: "plane", outline: room.footprint.outer.map(plan) },
    walls: walls.map((wall) => ({ a: plan(wall.a), b: plan(wall.b), low: 0, high: 2.5 })),
    landmarks: landmarks.map((mark) => ({ ...mark, center: project(mark.center).toArray() })),
  };
  const viewer = project(opts.viewer ?? [2, room.floorElevation + 1.6, 1.1]);
  return { evidence, viewer, matrix, plan };
}
function stepAll(discovery: RoomDiscovery, viewer?: Vector3) {
  for (let i = 0; i < 20 && discovery.state.phase === "checking"; i++) discovery.step(viewer);
  expect(discovery.state.phase).not.toBe("checking");
  return discovery.state;
}
function run(discovery: RoomDiscovery, snapshot: ReturnType<typeof sample>, now: number) {
  expect(discovery.submit(snapshot.evidence, snapshot.viewer, now)).toBe(true);
  return stepAll(discovery);
}

const door = (x: number, elevation: number) => ({
  kind: "door" as const,
  center: [x, elevation + 1.05, 0] as Vec3,
  width: 0.9,
  height: 2.1,
});

describe("cross-room recognition", () => {
  it("checks candidates incrementally and requires two independent complete passes", () => {
    const models = [
      model("matching", 4, 3),
      model("too-wide", 9, 3),
      model("too-deep", 4, 9),
      model("far-larger", 8, 8),
    ];
    const provider = vi.fn((room: Room) => models.find((m) => m.room.id === room.id) ?? null);
    const discovery = new RoomDiscovery(
      models.map(({ room }) => room),
      provider,
    );
    const original = sample(models[0]!);
    expect(discovery.submit(original.evidence, original.viewer, 100)).toBe(true);
    expect(provider).not.toHaveBeenCalled();
    expect(discovery.step()).toEqual({ phase: "checking", options: [], match: null });
    expect(provider.mock.calls.length).toBeGreaterThan(0);
    expect(provider.mock.calls.length).toBeLessThanOrEqual(2);
    expect(stepAll(discovery)).toMatchObject({ phase: "confirming", match: null });
    expect(provider).toHaveBeenCalledTimes(4);
    expect(discovery.submit(original.evidence, original.viewer, 500)).toBe(false);
    expect(discovery.submit(sample(models[0]!).evidence, original.viewer, 400)).toBe(false);
    const state = run(discovery, sample(models[0]!), 500);
    expect(state.phase).toBe("recognized");
    expect(state.match?.room.id).toBe("matching");
    expect(state.match?.candidates).toHaveLength(2);
    expect(state.match?.orientation).toBeNull();
  });

  it("retains room/floor ties even when one competing room has a named opening or the input order changes", () => {
    const first = { ...model("with-cue", 4, 3), landmarks: [door(1, 3)] };
    const second = model("other-floor", 4, 3, 12, 6);
    for (const models of [
      [first, second],
      [second, first],
    ]) {
      const discovery = new RoomDiscovery(
        models.map(({ room }) => room),
        (room) => models.find((m) => m.room.id === room.id)!,
      );
      run(discovery, sample(first), 0);
      const state = run(discovery, sample(first), 400);
      expect(state.phase).toBe("ambiguous");
      expect(state.match).toBeNull();
      expect(state.options.map(({ room }) => room.id).sort()).toEqual(["other-floor", "with-cue"]);
    }
    const incompatible = { ...second, landmarks: [door(13.6, 6)] };
    const discovery = new RoomDiscovery([first.room, incompatible.room], (room) =>
      room === first.room ? first : incompatible,
    );
    expect(run(discovery, sample(first), 0).phase).toBe("confirming");
    expect(run(discovery, sample(first), 400).match?.orientation).not.toBeNull();
    const negativeOnly = new RoomDiscovery([second.room, incompatible.room], (room) =>
      room === second.room ? second : incompatible,
    );
    expect(run(negativeOnly, sample(first), 0).phase).toBe("ambiguous");
    expect(run(negativeOnly, sample(first), 400).match).toBeNull();
  });

  it("rejects a smaller modeled subset even when a scan line could make its geometry fit", () => {
    const large = model("large", 4, 4),
      small = model("small", 4, 2);
    const snapshot = sample(large);
    snapshot.evidence.walls.push({ a: snapshot.plan([0, 2]), b: snapshot.plan([4, 2]), low: 0, high: 2.5 });
    expect(matchRoomAlignment(small, snapshot.evidence, snapshot.viewer).length).toBeGreaterThan(0);
    const discovery = new RoomDiscovery([small.room, large.room], (room) =>
      room === small.room ? small : large,
    );
    expect(run(discovery, snapshot, 0).options.map(({ room }) => room.id)).toEqual(["large"]);
  });

  it("withholds a clipped native floor patch until scans prove the room's enclosing walls", () => {
    const small = model("partial", 4, 2);
    const discovery = new RoomDiscovery([small.room], () => small);
    for (const time of [0, 400]) {
      const snapshot = sample(small);
      snapshot.evidence.walls.splice(2, 1);
      expect(matchRoomAlignment(small, snapshot.evidence, snapshot.viewer).length).toBeGreaterThan(0);
      const state = run(discovery, snapshot, time);
      expect(state.match).toBeNull();
      expect(state.options[0]?.sameExtent).toBe(false);
    }
  });

  it("can use enclosing walls on a mesh with a floor hull covering adjoining areas", () => {
    const m = model("room", 4, 3);
    const discovery = new RoomDiscovery([m.room], () => m);
    const frame = () => {
      const snapshot = sample(m);
      snapshot.evidence.floor = {
        source: "mesh",
        y: 0,
        outline: [
          [-2, -2],
          [7, -2],
          [7, 6],
          [-2, 6],
        ].map((point) => snapshot.plan(point as Vec2)),
      };
      return snapshot;
    };
    expect(run(discovery, frame(), 0).phase).toBe("confirming");
    expect(run(discovery, frame(), 400).match?.room.id).toBe(m.room.id);
  });

  it("blocks a sole known candidate when a competing model is unavailable", () => {
    const known = model("known", 4, 3),
      unknown = model("loading", 4, 3);
    const discovery = new RoomDiscovery([known.room, unknown.room], (room) =>
      room === known.room ? known : null,
    );
    for (const time of [0, 400]) {
      const state = run(discovery, sample(known), time);
      expect(state.phase).toBe("ambiguous");
      expect(state.options).toHaveLength(1);
      expect(state.match).toBeNull();
    }
  });

  it("requires consistent poses across independent passes and resets when the wearer moves before completion", () => {
    const m = model("candidate", 4, 3);
    const discovery = new RoomDiscovery([m.room], () => m);
    expect(run(discovery, sample(m), 0).phase).toBe("confirming");
    expect(run(discovery, sample(m, { shift: 0.15 }), 400).phase).toBe("confirming");
    const shifted = sample(m, { shift: 0.15 });
    expect(discovery.submit(shifted.evidence, shifted.viewer, 800)).toBe(true);
    expect(stepAll(discovery, shifted.viewer.clone().add(new Vector3(1, 0, 0))).phase).toBe("waiting");
    expect(run(discovery, sample(m, { shift: 0.15 }), 1200).phase).toBe("confirming");
    discovery.reset();
    expect(discovery.state.phase).toBe("waiting");
    expect(run(discovery, sample(m), 1300).phase).toBe("confirming");
  });
});
