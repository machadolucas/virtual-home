"use client";
import type { HouseRuntime } from "@/house/runtime";
export type EditSwitchChoice="save"|"discard"|"keep";
export type EditorKind="equipment"|"route"|"furniture";
type EditorActions={save:()=>Promise<boolean>;discard:()=>void;busy?:()=>boolean};
const editors=new WeakMap<HouseRuntime,Map<EditorKind,EditorActions>>();
const prompts=new WeakMap<HouseRuntime,()=>Promise<EditSwitchChoice>>();
const switching=new WeakSet<HouseRuntime>();
export function registerEditorActions(runtime:HouseRuntime,kind:EditorKind,actions:EditorActions){
  let map=editors.get(runtime);if(!map){map=new Map();editors.set(runtime,map);}map.set(kind,actions);
  return ()=>{if(map?.get(kind)===actions)map.delete(kind);};
}
export function registerEditSwitchPrompt(runtime:HouseRuntime,prompt:()=>Promise<EditSwitchChoice>){prompts.set(runtime,prompt);return ()=>{if(prompts.get(runtime)===prompt)prompts.delete(runtime);};}
/** Synchronous primitive for already-cleared transitions; never implicitly discards a dirty draft. */
export function confirmEditSwitch(runtime:HouseRuntime):boolean{
  const state=runtime.store.getState();
  if(state.editorSaving||state.furnishingsEditing||state.editing?.dirty||state.routeDraft)return false;
  if(state.editing)state.cancelEdit();return true;
}
/** Keep the mounted editor alive while asking; continue only after its actual save succeeds. */
export async function requestEditSwitch(runtime:HouseRuntime,continueTo:()=>void|Promise<void>):Promise<boolean>{
  if(switching.has(runtime))return false;
  const state=runtime.store.getState();
  const kind:EditorKind|null=state.furnishingsEditing?"furniture":state.routeDraft?"route":state.editing?.dirty?"equipment":null;
  if(state.editorSaving)return false;
  if(!kind){if(state.editing)state.cancelEdit();await continueTo();return true;}
  const actions=editors.get(runtime)?.get(kind),prompt=prompts.get(runtime);
  if(!actions||!prompt||actions.busy?.()){state.announce("Finish the current save before switching editors.");return false;}
  switching.add(runtime);
  try{
    const choice=await prompt();if(choice==="keep")return false;
    if(actions.busy?.()||runtime.store.getState().editorSaving)return false;
    if(choice==="save"){if(!await actions.save())return false;}else actions.discard();
    await continueTo();return true;
  }catch{runtime.store.getState().announce("The edit could not be saved. Your draft is still open.");return false;}
  finally{switching.delete(runtime);}
}
