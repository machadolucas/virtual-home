import { Matrix4, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { RouteFixMeasurement } from "@/house/xr/routeFixMeasurement";
import type { MixedRealityRoutePick } from "@/house/xr/mixedOverlay";
import { FIXTURE_DIR, loadManifest } from "./glb";

const room = {...loadManifest(FIXTURE_DIR).rooms[0]!, floorElevation: 0, ceilingHeight: 3,
  footprint: {outer: [[0,0], [5,0], [5,5], [0,5]] as [number, number][], holes: []}};
const route: MixedRealityRoutePick = {id:"sample-duct", name:"Supply", kind:"duct", label:"Supply", certainty:"inferred",
  approximate:true, distance:2, segment:[[1,2.8,2], [1,2.6,2]]};
const matrix = new Matrix4().makeRotationY(0.4).setPosition(2, -.4, 6);
function fixture(native: boolean) {
  const source = {targetRayMode:"tracked-pointer", targetRaySpace:{}} as XRInputSource;
  const session = {visibilityState:"visible", inputSources:[source], enabledFeatures:native ? ["hit-test"] : [],
    requestHitTestSource:native ? () => Promise.resolve({cancel(){}}) : undefined};
  const space = {} as XRReferenceSpace;
  const measurement = new RouteFixMeasurement(session as unknown as XRSession, space, room, route, "feed1234");
  const target = new Vector3(1.5,2.7,1.7), hand = new Vector3(1.1,1.45,3.3);
  const view = {emulatedPosition:false, transform:{position:{x:1,y:1.6,z:2}}};
  const frame = {session, getViewerPose:() => view,
    getPose: () => ({emulatedPosition:false, transform:{
      matrix:matrix.clone().multiply(new Matrix4().lookAt(hand,target,new Vector3(0,1,0)).setPosition(hand)).toArray()}}),
    getHitTestResults:() => [{getPose:() => ({emulatedPosition:false, transform:{position:target.clone().applyMatrix4(matrix)}})}],
  } as unknown as XRFrame;
  const tick = (error: number | null = .028) => measurement.frame(frame, matrix, error);
  const aim = () => measurement.select(frame, source);
  const preview = () => measurement.preview(frame, source, new Vector3());
  return {measurement, source, target, hand, view, frame, session, tick, aim, preview};
}

describe("measured route fixes", () => {
  it("confirms a displayed physical surface, retains the model point through recheck and saves its validated context", async () => {
    const {measurement, target, session, tick, aim, preview} = fixture(true);
    tick();
    await Promise.resolve(); await Promise.resolve();
    expect(preview()?.distanceTo(target.clone().applyMatrix4(matrix))).toBeLessThan(.0001);
    expect(aim()).toBe(true);
    const mark = measurement.measurement!;
    expect(mark).toMatchObject({method:"tracked_surface", routeId:route.id, selectedSpan:route.segment,
      roomId:room.id, floorId:room.floorId, registrationErrorM:.028});
    expect(new Vector3(...mark.position).distanceTo(target)).toBeLessThan(.0001);
    session.visibilityState = "hidden"; tick();
    expect(measurement.marker.visible).toBe(false);
    expect(aim()).toBe(false);
    session.visibilityState = "visible"; tick(.031);
    expect(measurement.marker.visible).toBe(true);
    const save = vi.fn();
    measurement.menu(save, vi.fn()).rows.find(row => row.label === "Save measured fix")!.act!(0);
    expect(save).toHaveBeenCalledWith(mark);
    measurement.dispose();
  });

  it("triangulates only two separated tracked aims on the same visible part inside the registered room", () => {
    const {measurement, target, hand, tick, aim, frame} = fixture(false);
    tick(.051); expect(aim()).toBe(false);
    tick();
    expect(measurement.select(frame, {targetRayMode:"gaze"} as XRInputSource)).toBe(false);
    expect(aim()).toBe(true); expect(aim()).toBe(false); expect(measurement.measurement).toBeNull();
    hand.x += .5;
    expect(aim()).toBe(true);
    expect(measurement.measurement?.method).toBe("two_aims");
    expect(new Vector3(...measurement.measurement!.position).distanceTo(target)).toBeLessThan(.0001);
    measurement.menu(vi.fn(), vi.fn()).rows.find(row => row.label === "Measure again")!.act!(0);
    target.x = 7; expect(aim()).toBe(true); hand.x += .7;
    expect(aim()).toBe(false); expect(measurement.measurement).toBeNull();
    measurement.dispose();
  });

  it("discards the first sight across emulated tracking and refuses an old or hidden preview", async () => {
    const {measurement, view, hand, tick, aim, preview, source} = fixture(true);
    tick(); await Promise.resolve(); await Promise.resolve(); preview(); measurement.hide(source);
    expect(aim()).toBe(true); expect(measurement.measurement).toBeNull();
    view.emulatedPosition = true; expect(aim()).toBe(false);
    hand.x += .45; view.emulatedPosition = false; tick();
    expect(aim()).toBe(true); expect(measurement.measurement).toBeNull();
    hand.x -= .45;
    expect(aim()).toBe(true); expect(measurement.measurement?.method).toBe("two_aims");
    measurement.dispose();
  });
});
