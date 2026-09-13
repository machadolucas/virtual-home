import type { AssetCategory } from "@/db/schema/assets";
export interface EquipmentCreationDraft {name:string;notes:string;height:string;category:AssetCategory;symbol:string;locationNote:string}
const drafts=new WeakMap<object,Partial<Record<"tree"|"equipment",EquipmentCreationDraft>>>();
export function readCreationDraft(owner:object,tree:boolean):EquipmentCreationDraft{
  return drafts.get(owner)?.[tree?"tree":"equipment"]??{name:"",notes:"",height:"5",category:tree?"outdoor":"other",symbol:tree?"tree":"",locationNote:""};
}
export function keepCreationDraft(owner:object,tree:boolean,value:EquipmentCreationDraft){const current=drafts.get(owner)??{};current[tree?"tree":"equipment"]={...value};drafts.set(owner,current);}
export function clearCreationDraft(owner:object,tree:boolean){const current=drafts.get(owner);if(current)delete current[tree?"tree":"equipment"];}
