import { describe,expect,it,vi } from "vitest";
import type { HouseRuntime } from "@/house/runtime";
import { registerEditorActions,registerEditSwitchPrompt,requestEditSwitch,type EditSwitchChoice,type EditorKind } from "@/house/components/edit/confirmSwitch";
function fixture(kind:EditorKind="equipment"){
  const state={editorSaving:false,furnishingsEditing:kind==="furniture",editing:kind==="equipment"?{dirty:true}:null,routeDraft:kind==="route"?{}:null,cancelEdit:vi.fn(),announce:vi.fn()};
  return {state,runtime:{store:{getState:()=>state}} as unknown as HouseRuntime};
}
describe("shared editor transition guard",()=>{
  for(const kind of ["equipment","route","furniture"]as const)for(const choice of ["keep","discard","save"]as const){
    it(`${kind}: ${choice} preserves explicit transition semantics`,async()=>{
      const {runtime}=fixture(kind),next=vi.fn(),save=vi.fn(async()=>true),discard=vi.fn();
      registerEditorActions(runtime,kind,{save,discard});registerEditSwitchPrompt(runtime,async()=>choice);
      expect(await requestEditSwitch(runtime,next)).toBe(choice!=="keep");
      expect(next).toHaveBeenCalledTimes(choice==="keep"?0:1);expect(save).toHaveBeenCalledTimes(choice==="save"?1:0);expect(discard).toHaveBeenCalledTimes(choice==="discard"?1:0);
    });
  }
  it("does not switch or discard after failed actual save",async()=>{
    const {runtime}=fixture(),next=vi.fn(),discard=vi.fn();
    registerEditorActions(runtime,"equipment",{save:async()=>false,discard});registerEditSwitchPrompt(runtime,async()=>"save");
    expect(await requestEditSwitch(runtime,next)).toBe(false);expect(next).not.toHaveBeenCalled();expect(discard).not.toHaveBeenCalled();
  });
  it("waits for save completion and blocks another transition while deciding",async()=>{
    const {runtime}=fixture("furniture"),next=vi.fn();let decide!:(choice:EditSwitchChoice)=>void,finish!:(saved:boolean)=>void;
    registerEditorActions(runtime,"furniture",{save:()=>new Promise(done=>{finish=done;}),discard:vi.fn()});
    registerEditSwitchPrompt(runtime,()=>new Promise(done=>{decide=done;}));
    const pending=requestEditSwitch(runtime,next);expect(await requestEditSwitch(runtime,next)).toBe(false);
    decide("save");await Promise.resolve();expect(next).not.toHaveBeenCalled();finish(true);expect(await pending).toBe(true);expect(next).toHaveBeenCalledTimes(1);
  });
  it("never silently discards without mounted editor registration or while saving",async()=>{
    const {runtime,state}=fixture(),next=vi.fn();expect(await requestEditSwitch(runtime,next)).toBe(false);
    state.editorSaving=true;expect(await requestEditSwitch(runtime,next)).toBe(false);expect(next).not.toHaveBeenCalled();
  });
});
