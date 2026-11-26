import { BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import type { Room, Vec3 } from "@/house/model/types";
import { createSceneIndex, indexAsset } from "@/house/scene/SceneIndex";
import { calibrationFeatures } from "@/house/xr/mixedCalibration";
import {
  buildAlignmentModel,
  matchRoomAlignment,
  uniqueRoomAlignment,
  viableRoomAlignments,
  type RoomEvidence,
} from "@/house/xr/roomAlignment";
import { readAlignmentEvidence } from "@/house/xr/roomAlignmentEvidence";
import { FIXTURE_DIR, loadManifest } from "./glb";

const original = loadManifest(FIXTURE_DIR);
const room: Room = {
  ...original.rooms[0]!,
  floorElevation: 3,
  ceilingHeight: 2.5,
  footprint: {
    outer: [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ],
    holes: [],
  },
};
const manifest = { ...original, rooms: [room] };
const corners = calibrationFeatures(manifest, room.floorId, room.id);
const model = buildAlignmentModel(room, corners);
const transform = new Matrix4().makeRotationY(0.34).setPosition(1.1, -3, -1.2);
const physical = (p: Vec3) => new Vector3(...p).applyMatrix4(transform);
const plan = ([x, z]: [number, number]): [number, number] => {
  const p = physical([x, 3, z]);
  return [p.x, p.z];
};
const viewer = physical([2, 4.6, 1.5]);
const sample = (): RoomEvidence => ({
  walls: model.walls.map((wall) => ({ a: plan(wall.a), b: plan(wall.b), low: 0, high: 2.5 })),
  floor: { y: 0, outline: room.footprint.outer.map(plan), source: "plane" },
  landmarks: [],
});

describe("room matching with incomplete headset evidence", () => {
  it("uses measured native floor perimeter as independent evidence, without guessing a rectangular orientation", () => {
    const evidence = sample();
    evidence.walls.splice(2);
    const candidates = matchRoomAlignment(model, evidence, viewer);
    expect(candidates).toHaveLength(2);
    expect(uniqueRoomAlignment(candidates)).toBeNull();
    expect(candidates.every(({ errorM }) => errorM <= 0.05)).toBe(true);
    expect(
      matchRoomAlignment(model, { ...evidence, floor: { ...evidence.floor!, source: "mesh" } }, viewer),
    ).toEqual([]);
    expect(
      matchRoomAlignment(model, { ...evidence, floor: { ...evidence.floor!, source: "bounds" } }, viewer),
    ).toEqual([]);
    const wideFloor = {
      ...evidence.floor!,
      outline: [
        [0, 0],
        [7, 0],
        [7, 3],
        [0, 3],
      ].map((v) => plan(v as [number, number])),
    };
    expect(matchRoomAlignment(model, { ...evidence, floor: wideFloor }, viewer)).toEqual([]);
  });

  it("accepts two partly concealed wall bases when the independent floor outline supports the room, but rejects a lateral contradiction", () => {
    const evidence = sample();
    for (const wall of evidence.walls) wall.low = 0.1;
    expect(matchRoomAlignment(model, evidence, viewer)).toHaveLength(2);
    const corrupt = evidence.walls[2]!;
    corrupt.a = plan([4, 3.1]);
    corrupt.b = plan([0, 3.1]);
    expect(matchRoomAlignment(model, evidence, viewer)).toEqual([]);
  });

  it("requires independent wall traces when there is only a tracked floor datum", () => {
    const evidence = sample();
    evidence.floor = { y: 0, outline: [], source: "bounds" };
    const strokes = [
      [
        [0.5, 0],
        [1.3, 0],
      ],
      [
        [4, 0.5],
        [4, 1.3],
      ],
      [
        [0.5, 3],
        [1.3, 3],
      ],
      [
        [0, 0.5],
        [0, 1.3],
      ],
    ].map(([a, b]) => ({
      a: plan(a as [number, number]),
      b: plan(b as [number, number]),
      low: 0,
      high: 0,
      baseOnly: true,
    }));
    expect(matchRoomAlignment(model, { ...evidence, walls: strokes.slice(0, 2) }, viewer)).toEqual([]);
    const matches = matchRoomAlignment(model, { ...evidence, walls: strokes }, viewer);
    expect(matches).toHaveLength(2);
    expect(uniqueRoomAlignment(matches)).toBeNull();
  });

  it("rejects an orientation that matches one measured opening but contradicts another comparable measured opening", () => {
    const door = { kind: "door" as const, center: [1, 4.05, 0] as Vec3, width: 0.9, height: 2.1 };
    const window = { kind: "window" as const, center: [3, 4.45, 0] as Vec3, width: 1.0, height: 1.05 };
    const evidence = sample();
    evidence.landmarks = [
      { ...door, center: physical(door.center).toArray() },
      { ...window, center: physical([2.75, 4.45, 0]).toArray() },
    ];
    const candidates = matchRoomAlignment({ ...model, landmarks: [door, window] }, evidence, viewer);
    expect(candidates).toHaveLength(2);
    expect(viableRoomAlignments(candidates)).toEqual([]);
    expect(uniqueRoomAlignment(candidates)).toBeNull();
  });

  it("stitches nearby coplanar fragments while leaving separated facade sections distinct", () => {
    const planeSpace = {} as XRSpace;
    const wall = ([a, b]: [[number, number], [number, number]]) => ({
      semanticLabel: "wall_face",
      planeSpace,
      polygon: [
        physical([a[0], 3, a[1]]),
        physical([b[0], 3, b[1]]),
        physical([b[0], 5.5, b[1]]),
        physical([a[0], 5.5, a[1]]),
      ],
    });
    const raw = {
      detectedPlanes: new Set([
        {
          semanticLabel: "floor",
          planeSpace,
          polygon: room.footprint.outer.map(([x, z]) => physical([x, 3, z])),
        },
        wall([
          [0, 0],
          [0.7, 0],
        ]),
        wall([
          [0.82, 0],
          [1.53, 0],
        ]),
        wall([
          [2, 0],
          [2.7, 0],
        ]),
        wall([
          [4, 0],
          [4, 3],
        ]),
        wall([
          [0, 3],
          [4, 3],
        ]),
        wall([
          [0, 0],
          [0, 3],
        ]),
      ]),
      getPose: () => ({ emulatedPosition: false, transform: { matrix: new Matrix4().toArray() } }),
    };
    const evidence = readAlignmentEvidence(raw as unknown as XRFrame, {} as XRReferenceSpace, viewer);
    expect(evidence.floor?.source).toBe("plane");
    expect(evidence.walls).toHaveLength(5);
    const sizes = evidence.walls.map(({ a, b }) => Math.hypot(b[0] - a[0], b[1] - a[1]));
    expect(sizes.some((size) => Math.abs(size - 1.53) < 1e-6)).toBe(true);
    expect(sizes.some((size) => Math.abs(size - 0.7) < 1e-6)).toBe(true);
    expect(
      matchRoomAlignment(model, { ...evidence, floor: { ...evidence.floor!, source: "mesh" } }, viewer),
    ).toHaveLength(2);
  });

  it("includes an unlinked exterior opening only when the physical reveal fits the selected room wall", () => {
    const asset = original.assets[0]!;
    const element = {
      id: "outside-window",
      kind: "window" as const,
      floorId: room.floorId,
      nodeRefs: [{ assetId: asset.id, nodeName: "outside-window" }],
      surfaceIds: ["model-reveal"],
      certainty: "measured" as const,
      sourceRefs: [],
    };
    const index = createSceneIndex(
      buildManifestIndex({
        ...manifest,
        elements: [element],
        surfaces: [
          {
            id: "model-reveal",
            kind: "other",
            role: "reveal",
            elementId: element.id,
            defaultColor: "#ffffff",
            nodeRefs: [{ assetId: asset.id, nodeName: "model-reveal" }],
          },
        ],
      }),
    );
    const root = new Group();
    const mesh = new Mesh(new BoxGeometry(1, 1.1, 0.25), new MeshStandardMaterial());
    mesh.name = "model-reveal";
    mesh.position.set(1.1, 4.5, -0.15);
    mesh.updateMatrix();
    root.add(mesh);
    indexAsset(index, asset.id, root);
    const landmarks = buildAlignmentModel(room, corners, index).landmarks;
    expect(landmarks).toHaveLength(1);
    expect(landmarks[0]).toMatchObject({ kind: "window" });
    expect(landmarks[0]?.center[0]).toBeCloseTo(1.1);
    mesh.position.z = -0.9;
    mesh.updateMatrix();
    expect(buildAlignmentModel(room, corners, index).landmarks).toEqual([]);
    mesh.geometry.dispose();
    mesh.material.dispose();
  });
});
