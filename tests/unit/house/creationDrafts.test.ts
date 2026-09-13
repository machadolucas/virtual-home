import {describe,expect,it} from "vitest";
import {readCreationDraft,keepCreationDraft,clearCreationDraft} from "@/house/components/edit/creationDrafts";
describe("pre-placement creation drafts",()=>{
  it("preserves separate equipment and tree fields across form unmounts",()=>{
    const runtime={};const equipment={...readCreationDraft(runtime,false),name:"Pump",notes:"Instructions",locationNote:"Beside shed"};
    const tree={...readCreationDraft(runtime,true),name:"Apple tree",height:"3.5"};keepCreationDraft(runtime,false,equipment);keepCreationDraft(runtime,true,tree);
    expect(readCreationDraft(runtime,false)).toEqual(equipment);expect(readCreationDraft(runtime,true)).toEqual(tree);
    clearCreationDraft(runtime,true);expect(readCreationDraft(runtime,true).name).toBe("");expect(readCreationDraft(runtime,false)).toEqual(equipment);
  });
  it("never shares drafts across household workspace instances",()=>{
    const first={},second={};keepCreationDraft(first,false,{...readCreationDraft(first,false),name:"Private local draft"});expect(readCreationDraft(second,false).name).toBe("");
  });
});
