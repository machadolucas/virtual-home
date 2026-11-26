import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createRuntime } from "@/house/runtime";
import { createHouseStore } from "@/house/store/createHouseStore";
import { createMemoryDataApi } from "@/house/store/dataApi";
import { fitPresets } from "@/house/model/fitProposal";
import type { Room, Route } from "@/house/model/types";
import { assessFit, fitBody, fitOpening, insideRoom } from "@/house/xr/fitGeometry";
import { Tabletop } from "@/house/xr/tabletop";
import { GuidanceMarker, inspectionLanding } from "@/house/xr/guidance";
import type { HeadsetLocateTarget } from "@/house/xr/headsetTasksTypes";
import { rebuildPickables } from "@/house/scene/applyVisibility";
import { WalkWorld } from "@/house/xr/walkWorld";
import { FIXTURE_DIR } from "./glb";
import { buildScene } from "./sceneFromGlb";

const room = {
  id: "fixture",
  floorElevation: 0,
  footprint: {
    outer: [
      [0, 0],
      [5, 0],
      [5, 5],
      [0, 5],
    ],
    holes: [],
  },
} as unknown as Room;
const spec = fitPresets.Cabinet;
const pose = { x: 2, z: 2, yaw: 0 };

describe("life-size clearance comparisons", () => {
  it("measures remaining space from the open drawer and rotates it with the cabinet", () => {
    const c = assessFit(pose, spec, room, []);
    expect(c).toMatchObject({ bodyClear: true, openingClear: true });
    expect(c.gap).toBeCloseTo(5 - 2 - spec.depth / 2 - spec.reach - 0.019, 2);
    const ob = fitBody({ x: 3, z: 2, yaw: 0 }, { ...spec, width: 0.1, depth: 1 }, 0);
    expect(assessFit({ ...pose, yaw: 90 }, spec, room, [ob]).gap).toBeLessThan(0.25);
    expect(assessFit(pose, spec, room, [ob]).gap).toBeCloseTo(c.gap, 2);
  });
  it("detects a swept door between its endpoints, a floor hole wholly inside a body and raised obstacles", () => {
    const washer = fitPresets.Washer,
      leaf = fitOpening(pose, washer, 0, 0.5);
    const obstacle = { ...leaf, widthM: 0.05, depthM: 0.05 };
    expect(assessFit(pose, washer, room, [obstacle])).toMatchObject({
      openingClear: false,
      bodyClear: true,
    });
    expect(assessFit(pose, washer, room, [{ ...obstacle, position: [2, 3, 2] }]).openingClear).toBe(true);
    const withHole = {
      ...room,
      footprint: {
        ...room.footprint,
        holes: [
          [
            [1.96, 1.96],
            [2.02, 1.96],
            [2.02, 2.02],
            [1.96, 2.02],
          ],
        ],
      },
    } as Room;
    expect(insideRoom(fitBody(pose, spec, 0), withHole)).toBe(false);
  });
});

describe("tabletop and in-room guidance", () => {
  it("lands on the selected floor in model metres, rotates on release and traces an active duct", () => {
    const { index } = buildScene(FIXTURE_DIR);
    rebuildPickables(index);
    const runtime = createRuntime({ store: createHouseStore(), base: "", dataApi: createMemoryDataApi() });
    runtime.index = index;
    runtime.manifest = index.manifest;
    const local = index.manifest.rooms.get("r-l-a")!,
      point = new THREE.Vector3(2.2, local.floorElevation, 2.5);
    const route = {
      id: "fixture-duct",
      name: "Fixture transfer",
      system: "ventilation",
      kind: "duct",
      lifecycle: "installed",
      points: [
        [2, 2, 2],
        [2.5, 2, 3],
      ],
      segments: [{ roomId: local.id, floorId: local.floorId }],
      flowState: "active",
    } as unknown as Route;
    runtime.store.setState({ routes: [route] });
    const travel = vi.fn(),
      world = new WalkWorld(index);
    const table = new Tabletop(
      runtime,
      world,
      new THREE.Vector3(12, 2, 3),
      1.5,
      local.floorId,
      travel,
      () => {},
    );
    const miniature = table.group.children[0]!;
    const rayAt = (p: THREE.Vector3) =>
      new THREE.Ray(
        miniature.localToWorld(p.clone()).add(new THREE.Vector3(0, 1, 0)),
        new THREE.Vector3(0, -1, 0),
      );
    const hit = table.hit(rayAt(point))!;
    expect(hit.room?.id).toBe(local.id);
    expect(hit.local.x).toBeCloseTo(point.x);
    table.begin(hit, 1.6, 0);
    table.orient(rayAt(point), { x: 1, y: 0 }, 0);
    table.release(hit);
    expect(travel).toHaveBeenCalledTimes(1);
    expect(travel.mock.calls[0]![1]).toBeCloseTo(-Math.PI / 2);
    expect(travel.mock.calls[0]![0].distanceTo(point)).toBeLessThan(1.3);
    // An oblique controller resting on the top of a raised room must preserve its initial bearing.
    const oblique = new THREE.Ray(hit.point.clone().add(new THREE.Vector3(0,.18,.8)),new THREE.Vector3(0,-.18,-.8).normalize());
    table.begin(hit,1.6,Math.PI/2);
    table.orient(oblique,{x:0,y:0},Math.PI/2);
    table.release(hit);
    expect(travel.mock.calls[1]![1]).toBeCloseTo(Math.PI/2);
    table.menu().rows[0]!.act!(0);
    const duct = table.hit(rayAt(new THREE.Vector3(2.25, 2, 2.5)))!;
    expect(duct.route?.id).toBe(route.id);
    table.release(duct, route.id);
    expect(table.menu().lines.join(" ")).toContain("Fixture transfer");
    table.dispose();
    world.dispose();
  });
  it("requires a verified room transform for the marker and chooses a standable viewing spot", () => {
    const marker = new GuidanceMarker();
    marker.set({ position: [2, 1.2, 2], roomId: "r" } as HeadsetLocateTarget);
    marker.update(null, "r", new THREE.Vector3());
    expect(marker.group.visible).toBe(false);
    marker.update(new THREE.Matrix4().makeTranslation(1, 0, 3), "wrong", new THREE.Vector3());
    expect(marker.group.visible).toBe(false);
    marker.update(new THREE.Matrix4().makeTranslation(1, 0, 3), "r", new THREE.Vector3());
    expect(marker.group.position.toArray()).toEqual([3, 1.2, 5]);
    marker.dispose();
    const { index } = buildScene(FIXTURE_DIR);
    rebuildPickables(index);
    const world = new WalkWorld(index),
      local = index.manifest.rooms.get("r-l-a")!;
    const view = inspectionLanding(
      world,
      new THREE.Vector3(2.4, 0.8, 2.5),
      local,
      local.floorElevation,
      1.6,
    );
    expect(view && world.canStand(view.point, 1.6)).toBe(true);
    world.dispose();
  });
});
