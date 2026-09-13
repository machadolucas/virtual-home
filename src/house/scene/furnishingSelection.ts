import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import { isVisibleUp } from "./applyVisibility";
const selectors=new WeakMap<HouseRuntime,(id:string|null)=>void>();
export function registerFurnishingSelection(runtime:HouseRuntime,select:(id:string|null)=>void){selectors.set(runtime,select);return()=>{if(selectors.get(runtime)===select)selectors.delete(runtime);};}
export function selectFurnishing(runtime:HouseRuntime,id:string|null){selectors.get(runtime)?.(id);}
/** Furniture participates in the same closest-hit decision as the model and equipment. */
export function pickFurnishingBody(runtime:HouseRuntime,clientX:number,clientY:number):{id:string;distance:number}|null{
  if(!runtime.camera3d||!runtime.canvasEl||!runtime.store.getState().layers.furnishings)return null;
  const group=runtime.scene?.getObjectByName("furnishings");if(!group)return null;
  const rect=runtime.canvasEl.getBoundingClientRect();if(!rect.width||!rect.height)return null;
  const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1),runtime.camera3d);
  for(const hit of ray.intersectObject(group,true)){
    if(!isVisibleUp(hit.object))continue;
    let object:THREE.Object3D|null=hit.object;
    while(object&&object!==group){
      if(object.name==="vh-furniture-preview")break;
      const id=object.userData.furnishingId;
      if(typeof id==="string"&&id)return {id,distance:hit.distance};
      object=object.parent;
    }
  }
  return null;
}
