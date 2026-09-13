import * as THREE from "three";
import { describe, it, expect } from "vitest";
import { pickEquipmentBody, pickObjectSupport, placementYaw } from "@/house/scene/objectPlacement";
import { ClipGroups } from "@/house/scene/clipGroups";
import type { HouseRuntime } from "@/house/runtime";
import type { Furnishing } from "@/house/model/types";

describe("object placement gestures and support", () => {
  it("snaps yaw around a fixed anchor in 45-degree increments", () => {
    expect(placementYaw([2,0,3], [3,0,4], 0)).toBe(45);
    expect(placementYaw([2,0,3], [3,0,3], 0)).toBe(90);
    expect(placementYaw([2,0,3], [2.01,0,3], 135)).toBe(135);
    expect(placementYaw([2,0,3], [1,0,2], 0)).toBe(-135);
  });
  it("supports visible furniture tops but excludes hidden, clipped and self geometry", () => {
    const scene = new THREE.Scene(); const group = new THREE.Group(); group.name = "furnishings"; scene.add(group);
    const object = new THREE.Group(); object.userData.furnishingId = "table"; group.add(object);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2,1,2), material); mesh.position.y = .5; object.add(mesh);
    scene.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(50,1,.01,100); camera.position.set(0,5,1); camera.lookAt(0,1,0); camera.updateMatrixWorld(true);
    const runtime = { scene, camera3d:camera, canvasEl:{ getBoundingClientRect:()=>({left:0,top:0,width:100,height:100}) },
      index:{ hiddenGroups:new Set() }, store:{getState:()=>({placements:[]})} } as unknown as HouseRuntime;
    const items = [{id:"table",floorId:"floor",roomId:"room"}] as Furnishing[];
    expect(pickObjectSupport(runtime,50,50,items,null)?.point.y).toBeCloseTo(1);
    expect(pickObjectSupport(runtime,50,50,items,"table")).toBeNull();
    object.visible=false; expect(pickObjectSupport(runtime,50,50,items,null)).toBeNull(); object.visible=true;
    material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),.25)];
    expect(pickObjectSupport(runtime,50,50,items,null)).toBeNull();
    mesh.geometry.dispose();material.dispose();
  });
  it("returns outward normals for visible vertical equipment and furniture faces", () => {
    const scene = new THREE.Scene(); const group = new THREE.Group(); group.name = "furnishings"; scene.add(group);
    const object = new THREE.Group(); object.userData.furnishingId = "cabinet"; group.add(object);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), material); mesh.position.y = .5; object.add(mesh);
    scene.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(50,1,.01,100); camera.position.set(0,.5,5); camera.lookAt(0,.5,0); camera.updateMatrixWorld(true);
    const runtime = { scene, camera3d:camera, canvasEl:{ getBoundingClientRect:()=>({left:0,top:0,width:100,height:100}) },
      index:{ hiddenGroups:new Set() }, store:{getState:()=>({placements:[]})} } as unknown as HouseRuntime;
    const items = [{id:"cabinet",floorId:"floor",roomId:"room"}] as Furnishing[];
    const hit = pickObjectSupport(runtime,50,50,items,null);
    expect(hit?.point.z).toBeCloseTo(.5);
    expect(hit?.normal?.toArray()).toEqual([0, 0, 1]);
    mesh.geometry.dispose(); material.dispose();
  });
  it("does not select or attach to a clipped tree crown, while its trunk remains selectable", () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry(.5, 5, .5).translate(0, 2.5, 0);
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 1);
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 2, 0)); scene.add(mesh);
    scene.updateMatrixWorld(true);
    const clip = new ClipGroups(["site"]); clip.attachTree(mesh, "site");
    const camera = new THREE.PerspectiveCamera(50, 1, .01, 100);
    const aim = (y: number) => { camera.position.set(0, y, 5); camera.lookAt(0, y, 0); camera.updateMatrixWorld(true); };
    const runtime = { scene, clip, camera3d: camera,
      canvasEl: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
      markers: { meshes: [mesh], placementAt: () => "tree" }, index: { hiddenGroups: new Set() },
      store: { getState: () => ({ layers: { trees: true, equipment: true }, placements: [{ id: "tree", floorId: null, roomId: null }] }) },
    } as unknown as HouseRuntime;
    aim(5);
    expect(pickEquipmentBody(runtime, 50, 50)?.id).toBe("tree");
    expect(pickObjectSupport(runtime, 50, 50, [], null)).not.toBeNull();
    clip.setTreeContextCut(true);
    expect(pickEquipmentBody(runtime, 50, 50)).toBeNull();
    expect(pickObjectSupport(runtime, 50, 50, [], null)).toBeNull();
    aim(2.5);
    expect(pickEquipmentBody(runtime, 50, 50)?.id).toBe("tree");
    clip.setTreeContextCut(false); aim(5);
    expect(pickEquipmentBody(runtime, 50, 50)?.id).toBe("tree");
    geometry.dispose(); mesh.material.dispose(); mesh.customDepthMaterial?.dispose(); mesh.customDistanceMaterial?.dispose();
  });
});
