import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createHouseStore } from "@/house/store/createHouseStore";
import { createRuntime } from "@/house/runtime";
import { createMemoryDataApi } from "@/house/store/dataApi";
import { WalkWorld } from "@/house/xr/walkWorld";
import { EquipmentPicker } from "@/house/xr/travel";
import { roomLanding, teleport, turnAroundHead, walkable } from "@/house/xr/navigation";
import { presentedHouse, probeModes, requestHouseSession } from "@/house/xr/presentation";
import { captureEye } from "@/house/xr/captureEye";
import { HouseSession } from "@/house/xr/session";
import { HeadsetEquipment } from "@/house/xr/equipment";
import { HeadsetNotice } from "@/house/xr/headsetNotice";
import { haStore } from "@/house/store/haStore";
import type { Placement, Room } from "@/house/model/types";
import { walkthroughStart } from "@/house/xr/wayfinding";
import { buildScene } from "./sceneFromGlb";
import { FIXTURE_DIR } from "./glb";

afterEach(() => { vi.unstubAllGlobals(); haStore.getState().reset(); });

describe("immersive walkthrough", () => {
  it("checks each mode independently, with secure context and permission failures", async () => {
    const api = {isSessionSupported: vi.fn(async (mode: string) => {
      if (mode === "immersive-ar") throw new Error("unavailable");
      return true;
    })} as unknown as XRSystem;
    expect(await probeModes(api, true)).toEqual({vr: true, mr: false});
    expect(await probeModes(api, false)).toEqual({vr: false, mr: false});
    expect(await probeModes(undefined, true)).toEqual({vr: false, mr: false});
    expect(api.isSessionSupported).toHaveBeenCalledTimes(2);
    const denied = {requestSession: vi.fn().mockRejectedValue(new DOMException("Permission denied","NotAllowedError"))};
    await expect(requestHouseSession(denied as unknown as XRSystem, "mr")).rejects.toMatchObject({name:"NotAllowedError"});
    expect(denied.requestSession).toHaveBeenCalledExactlyOnceWith("immersive-ar", {requiredFeatures:["local-floor"],optionalFeatures:["anchors","plane-detection","mesh-detection","hit-test","hand-tracking"]});
  });

  it("retains room-scale displacement, eye height and head pivot across floor changes", () => {
    const rig = new THREE.Group();
    const head = new THREE.Vector3(0.48, 1.71, -0.25);
    const destination = new THREE.Vector3(8, 2.8, 5);
    teleport(rig, head, destination);
    const standing = rig.localToWorld(head.clone());
    expect(standing.toArray()).toEqual([8, 4.51, 5]);
    turnAroundHead(rig, head, Math.PI / 6);
    expect(rig.localToWorld(head.clone()).distanceTo(standing)).toBeLessThan(1e-8);
    expect(rig.localToWorld(head.clone().add(new THREE.Vector3(1,0,0))).distanceTo(standing)).toBeCloseTo(1);
    expect(rig.scale.toArray()).toEqual([1,1,1]);
  });

  it("uses a visible equipment body's placement ID and only lands on walkable upward faces", () => {
    const {index, manifest} = buildScene(FIXTURE_DIR);
    const floor = manifest.surfaces.find(s => s.kind === "floor")!;
    expect(walkable(floor, 1)).toBe(true);
    expect(walkable(floor, 0)).toBe(false);
    expect(walkable(manifest.surfaces.find(s => s.kind === "wall"), 1)).toBe(false);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.userData.vhPlacementId = "fixture-placement"; mesh.updateMatrixWorld();
    index.pickables = [mesh];
    const ray = new THREE.Raycaster(new THREE.Vector3(0,0,3),new THREE.Vector3(0,0,-1));
    const world = new WalkWorld(index);
    expect(new EquipmentPicker().target(world, ray, null)?.id).toBe("fixture-placement");
    world.dispose();
    expect(manifest.rooms.map(roomLanding).some(Boolean)).toBe(true);
    mesh.geometry.dispose(); mesh.material.dispose();
  });

  it("renders from tracked local-floor frames and restores desktop presentation and draft on exit", () => {
    const ctx = { measureText: () => ({width: 40}), fillRect() {}, fillText() {} };
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => ctx }) });
    const {index} = buildScene(FIXTURE_DIR);
    const store = createHouseStore();
    const runtime = createRuntime({store, base: "", dataApi: createMemoryDataApi()});
    runtime.index = index; runtime.manifest = index.manifest; runtime.scene = new THREE.Scene();
    const selection = {kind: "floor" as const, id: "my-floor"};
    const cut = {enabled: true, y: 2, vertical: null};
    store.setState({selection, cut, explode: {enabled:true,gap:3,locked:true}, wallMode:"cut", projection:"ortho", viewMode:"floor"});
    store.getState().setLayer("equipment", false);
    const before = store.getState();
    const session = Object.assign(new EventTarget(), {inputSources: [], visibilityState:"visible"}) as unknown as XRSession;
    const active = new HouseSession(runtime, session, "vr", {} as XRReferenceSpace);
    const frame = {session, getViewerPose: () => ({transform:{position:{x:0,y:1.6,z:0},orientation:{x:0,y:0,z:0,w:1}},views:[]})} as unknown as XRFrame;
    const render = vi.fn();
    active.frame({render} as unknown as THREE.WebGLRenderer, frame, 0.014, {motion:true,rates:{supply:0,extract:0.6},fans:""});
    expect(render).toHaveBeenCalledWith(runtime.scene, active.camera);
    expect(presentedHouse(store.getState())).toMatchObject({cut:{enabled:false}, wallMode:"closed", activeFloorId:null, layers:{equipment:true}});
    active.dispose(); active.dispose();
    expect(store.getState()).toEqual(before);
    expect(runtime.scene.children).toHaveLength(0);
  });

  it("waits for the shell and starts the tracked head in the living room at its own floor height", () => {
    const arrival = vi.spyOn(HeadsetNotice.prototype, "show").mockImplementation(() => {});
    vi.stubGlobal("document", { createElement: () => ({ getContext: () =>
      ({ measureText: () => ({ width: 40 }), fillRect() {}, fillText() {} }) }) });
    const { index, manifest } = buildScene(FIXTURE_DIR);
    const living = manifest.rooms[1]!;
    living.nameFi = "Olohuone";
    const store = createHouseStore();
    const runtime = createRuntime({ store, base: "", dataApi: createMemoryDataApi() });
    runtime.index = index; runtime.manifest = index.manifest; runtime.scene = new THREE.Scene();
    const [x, y, z] = roomLanding(living)!;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial());
    floor.rotation.x = -Math.PI / 2; floor.position.set(x, y, z);
    index.meshSurfaceId.set(floor, manifest.surfaces.find(s => s.kind === "floor")!.id);
    index.pickables = [floor];
    const session = Object.assign(new EventTarget(), {inputSources: [], visibilityState: "visible"}) as unknown as XRSession;
    const active = new HouseSession(runtime, session, "vr", {} as XRReferenceSpace);
    const position = new THREE.Vector3(.4, 1.72, -.6);
    const frame = { session, getViewerPose: () => ({transform: {position, orientation: new THREE.Quaternion()}}) } as unknown as XRFrame;
    const gl = { clear: vi.fn(), render: vi.fn() } as unknown as THREE.WebGLRenderer;
    const options = {motion: true, rates: {supply: 0, extract: 0}, fans: ""};
    try {
      store.getState().setPhase("loading");
      active.frame(gl, frame, 1/90, options);
      expect(gl.render).not.toHaveBeenCalled();
      store.getState().setPhase("interactive");
      active.frame(gl, frame, 1/90, options);
      const head = active.rig.localToWorld(position.clone());
      expect(head.distanceTo(new THREE.Vector3(x, y + position.y, z))).toBeLessThan(.001);
      expect(arrival.mock.calls.at(-1)?.[0].title).toBe(living.name);
      position.x += .34;
      active.frame(gl, frame, 1/90, options);
      expect(active.rig.localToWorld(position.clone()).x).toBeCloseTo(x + .34);
    } finally {
      arrival.mockRestore(); active.dispose(); floor.geometry.dispose(); floor.material.dispose();
    }
  });

  it("searches the rest of a named living room before falling back to another clear room", () => {
    const { manifest } = buildScene(FIXTURE_DIR);
    const rooms = manifest.rooms.slice(0, 2).map(room => ({room, position: roomLanding(room)!}));
    const first = rooms[0]!.room, preferred = rooms[1]!.room;
    const fallback = new THREE.Vector3(...rooms[0]!.position);
    const corner = new THREE.Vector3(...rooms[1]!.position);
    const world = {
      landing: vi.fn((_p: THREE.Vector3, _height: number, room: Room) => room === first ? fallback : null),
      landingAt: vi.fn((): THREE.Vector3 | null => corner), yardLanding: vi.fn(),
    };
    const labels = { [preferred.id]: "Living room" };
    expect(walkthroughStart(rooms, labels, world as unknown as WalkWorld, 1.75)).toBe(corner);
    expect(world.landing.mock.calls.map(call => call[2])).toEqual([preferred]);
    world.landingAt.mockReturnValue(null);
    expect(walkthroughStart(rooms, labels, world as unknown as WalkWorld, 1.75)).toBe(fallback);
    expect(walkthroughStart(rooms, {}, world as unknown as WalkWorld, 1.75)).toBe(fallback);
  });

  it("captures one eye to an owned target, preserves transparency and restores stereo rendering", async () => {
    const eye = new THREE.PerspectiveCamera(60, 2, 0.05, 100);
    eye.position.set(4.5, 1.8, 3);
    const scene = new THREE.Scene(), previous = new THREE.WebGLRenderTarget(2,2);
    const output = new Uint8ClampedArray(1024 * 512 * 4);
    const context = { createImageData: () => ({data:output}), putImageData: vi.fn() };
    vi.stubGlobal("document", {createElement: () => ({ getContext: () => context,
      toBlob: (done: (b: Blob) => void) => done(new Blob(["fixture"], {type:"image/png"})) })});
    const gl = { xr: {enabled: true}, getRenderTarget: () => previous,
      getViewport: (v: THREE.Vector4) => v, getScissor: (v: THREE.Vector4) => v, getScissorTest: () => true,
      setRenderTarget: vi.fn(), setViewport: vi.fn(), setScissor: vi.fn(), setScissorTest: vi.fn(), render: vi.fn(),
      readRenderTargetPixels: (_target: THREE.WebGLRenderTarget, _x: number, _y: number, width: number, height: number, pixels: Uint8Array) => {
        expect(gl.xr.enabled).toBe(false);
        pixels.set([11,22,33,255], (height - 1) * width * 4);
      }};
    expect((await captureEye(gl as unknown as THREE.WebGLRenderer, scene, eye)).type).toBe("image/png");
    expect(gl.render).toHaveBeenCalledWith(scene,eye);
    expect([...output.slice(0, 8)]).toEqual([11,22,33,255,0,0,0,0]);
    expect(gl.xr.enabled).toBe(true);
    expect(gl.setRenderTarget).toHaveBeenLastCalledWith(previous);
    expect(gl.setScissorTest).toHaveBeenLastCalledWith(true);
    previous.dispose();
  });

  it("routes headset actions through the equipment API and keeps its reported state after acknowledgement", async () => {
    const item = {id:"fixture-placement",equipmentId:"fixture-device",entityId:"switch.fixture",name:"Fixture",linkedEntities:[]} as unknown as Placement;
    const entity = {registryId:"stable",name:"Fixture switch",entityId:"switch.fixture",available:true,state:"off",
      capabilities:{color:false,colorTemperature:false,brightness:false}};
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === "POST" ?
      {commandId:"receipt",status:"sent"} : {connected:true,entities:[entity]}));
    vi.stubGlobal("fetch",fetcher);
    const control = new HeadsetEquipment(item);
    await control.refresh();
    control.menu().rows.find(r => r.label === "Control · Fixture switch")!.act!(0);
    control.menu().rows.find(r => r.label === "Turn on")!.act!(0);
    await vi.waitFor(() => expect(control.menu().lines.join(" ")).toContain("Sent to Home Assistant"));
    const sent = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(sent[0]).toBe("/api/equipment/fixture-device/controls");
    expect(JSON.parse(sent[1]!.body as string)).toMatchObject({registryId:"stable",command:{type:"turn_on"}});
    expect(control.menu().lines[0]).toBe("Reported: off");
    entity.available = false; await control.refresh();
    expect(control.menu().rows.find(r => r.label === "Turn on")?.act).toBeUndefined();
    control.dispose();
  });
});
