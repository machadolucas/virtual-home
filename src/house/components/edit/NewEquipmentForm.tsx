"use client";
import { useState,useEffect,useRef } from "react";
import { Button } from "@/ui/Button";
import type { HouseRuntime } from "@/house/runtime";
import { ASSET_CATEGORIES,type AssetCategory } from "@/db/schema/assets";
import { PLACEMENT_SYMBOLS,SYMBOL_LABEL } from "@/house/scene/symbols";
import { readCreationDraft,keepCreationDraft,clearCreationDraft } from "./creationDrafts";
import { savingEditor } from "@/features/forms/unsaved";
import { requestEditSwitch } from "./confirmSwitch";
import { startPlacement } from "./startPlacement";

/** Draft only. The existing placement editor performs the single atomic save. */
export function NewEquipmentForm({runtime,onStarted,onCancelled,tree=false}:{runtime:HouseRuntime;onStarted?:()=>void;onCancelled?:()=>void;tree?:boolean}){
  const [initial]=useState(()=>readCreationDraft(runtime,tree));const started=useRef(false);
  const [name,setName]=useState(initial.name);const [notes,setNotes]=useState(initial.notes);const [height,setHeight]=useState(initial.height);const [error,setError]=useState("");
  const [category,setCategory]=useState<AssetCategory>(initial.category);
  const [symbol,setSymbol]=useState(initial.symbol);const [locationNote,setLocationNote]=useState(initial.locationNote);
  useEffect(()=>{if(!started.current)keepCreationDraft(runtime,tree,{name,notes,height,category,symbol,locationNote});},[runtime,tree,name,notes,height,category,symbol,locationNote]);
  function begin(){
    const finishPrelude=savingEditor();
    void requestEditSwitch(runtime,()=>{
    const metres=Number(height);if(!name.trim()||(tree&&(!Number.isFinite(metres)||metres<0.5||metres>30))){setError("Enter a name and, for a tree, a height from 0.5 to 30 metres.");return;}
    const id=crypto.randomUUID();
    if(!startPlacement(runtime,{assetId:id,name:name.trim(),category,status:"installed",locationName:null})){setError("Load the house model and finish the current edit first.");return;}
    finishPrelude();started.current=true;clearCreationDraft(runtime,tree);
    const store=runtime.store.getState();
    store.updateDraft({newEquipment:{name:name.trim(),notes:notes.trim()||null,category},symbol:symbol||null,locationNote:locationNote.trim(),treeHeightM:tree?metres:null,dirty:true});
    const layer=symbol==="tree"?"trees":"equipment";if(!store.layers[layer])store.toggleLayer(layer);onStarted?.();
    });
  }
  return <form className="space-y-3" onSubmit={event=>{event.preventDefault();begin();}}>
    <p className="text-sm text-ink-2">Name the {tree?"tree":"equipment"}, then choose its position in the house view. Save creates the record and placement together.</p>
    <label className="block text-sm">{tree?"Tree name":"Equipment name"}<input className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" autoFocus required maxLength={200} value={name} onChange={e=>setName(e.target.value)} placeholder={tree?"e.g. Apple tree":"e.g. Garden pump"}/></label>
    {!tree&&<><label className="block text-sm">Category<select className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" value={category} onChange={e=>setCategory(e.target.value as AssetCategory)}>{ASSET_CATEGORIES.filter(c=>c!=="software").map(c=><option key={c} value={c}>{c[0]?.toUpperCase()}{c.slice(1)}</option>)}</select></label><label className="block text-sm">Shown as<select className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" value={symbol} onChange={e=>setSymbol(e.target.value)}><option value="">Choose automatically</option>{PLACEMENT_SYMBOLS.map(s=><option key={s} value={s}>{SYMBOL_LABEL[s]}</option>)}</select></label></>}
    {tree&&<label className="block text-sm">Height (metres)<input className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" type="number" min="0.5" max="30" step="0.1" required value={height} onChange={e=>setHeight(e.target.value)}/></label>}
    <label className="block text-sm">Location note <span className="text-ink-3">(optional)</span><input className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" maxLength={1000} value={locationNote} onChange={e=>setLocationNote(e.target.value)} placeholder="e.g. Beside the garden shed"/></label>
    <label className="block text-sm">Notes <span className="text-ink-3">(optional)</span><textarea className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" maxLength={10000} rows={3} value={notes} onChange={e=>setNotes(e.target.value)} placeholder={tree?"Species, planting details or care instructions":"Installation details or care instructions"}/></label>
    {error&&<p role="alert" className="text-sm text-overdue">{error}</p>}
    <div className="flex gap-2"><Button type="submit" variant="primary">Place {tree?"tree":"equipment"}</Button><Button type="button" onClick={()=>{
      savingEditor()();clearCreationDraft(runtime,tree);const empty=readCreationDraft(runtime,tree);started.current=false;
      setName(empty.name);setNotes(empty.notes);setHeight(empty.height);setCategory(empty.category);setSymbol(empty.symbol);setLocationNote(empty.locationNote);setError("");onCancelled?.();
    }}>Cancel draft</Button></div>
  </form>;
}
