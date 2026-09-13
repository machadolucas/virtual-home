import { describe,expect,it,vi } from "vitest";
import * as THREE from "three";
import type { HouseRuntime } from "@/house/runtime";
import { pickFurnishingBody,registerFurnishingSelection,selectFurnishing } from "@/house/scene/furnishingSelection";
import { furnishingRaycast } from "@/house/scene/furnishingRaycast";
function fixture(){
  const scene=new THREE.Scene(),group=new THREE.Group(),item=new THREE.Group();group.name="furnishings";item.userData.furnishingId="chair";
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial());mesh.raycast=furnishingRaycast(()=>true);item.add(mesh);group.add(item);scene.add(group);scene.updateMatrixWorld(true);
  const camera=new THREE.PerspectiveCamera(50,1,.1,100);camera.position.set(0,0,5);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
  const state={layers:{furnishings:true}};
  const runtime={scene,camera3d:camera,canvasEl:{getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})},store:{getState:()=>state}}as unknown as HouseRuntime;
  return {runtime,mesh,item,state};
}
describe("single-authority furniture picking",()=>{
  it("returns the exact visible furniture record at its real hit distance",()=>{const {runtime}=fixture();expect(pickFurnishingBody(runtime,50,50)).toEqual({id:"chair",distance:4.5});});
  it("ignores hidden layers, hidden groups, clipping and unsaved previews",()=>{
    const {runtime,mesh,item,state}=fixture();state.layers.furnishings=false;expect(pickFurnishingBody(runtime,50,50)).toBeNull();state.layers.furnishings=true;
    item.visible=false;expect(pickFurnishingBody(runtime,50,50)).toBeNull();item.visible=true;
    mesh.raycast=furnishingRaycast(()=>false);expect(pickFurnishingBody(runtime,50,50)).toBeNull();mesh.raycast=furnishingRaycast(()=>true);
    item.name="vh-furniture-preview";expect(pickFurnishingBody(runtime,50,50)).toBeNull();
  });
  it("explicitly clears furniture even when model selection is already null",()=>{
    const {runtime}=fixture(),select=vi.fn();const remove=registerFurnishingSelection(runtime,select);
    selectFurnishing(runtime,"chair");selectFurnishing(runtime,null);expect(select.mock.calls).toEqual([["chair"],[null]]);remove();selectFurnishing(runtime,"chair");expect(select).toHaveBeenCalledTimes(2);
  });
});
