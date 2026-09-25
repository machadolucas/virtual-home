"use client";

import { useState } from "react";
import { Move3D } from "lucide-react";
import { Button, Input, Select } from "@/ui";
import type { Furnishing } from "@/house/model/types";
import { FURNISHING_CATALOG } from "@/house/model/furnishingCatalog";
import { useHouseStore } from "../../hooks/useHouseStore";
import { useFurnishings } from "./FurnishingsProvider";
import { useFurnitureEditor } from "./FurnitureEditorContext";
import { FurnitureCatalog } from "./FurnitureCatalog";

export function FurnitureInspector() {
  const editor = useFurnitureEditor();
  const { busy, remove } = useFurnishings();
  const index = useHouseStore((state) => state.index);
  const [removeError, setRemoveError] = useState<string | null>(null);
  if (editor.catalogOpen && !editor.draft) return <FurnitureCatalog onChoose={editor.begin} onClose={() => editor.setCatalogOpen(false)} />;
  if (!editor.draft) return null;
  return <>
    <p className="mb-2 flex items-start gap-2 rounded-md bg-accent-soft p-2 text-xs text-accent-text"><Move3D className="size-4 shrink-0" aria-hidden="true" />{editor.placing ? "Move over a surface to preview. Click to place on the grid; hold and drag to rotate in 45° steps. Alt bypasses the grid. Red means a wall or another object is in the way. Right-drag pans and the wheel zooms." : "Resize here, or choose Reposition in 3D to move this item. Save applies your changes."}</p>
    <FurnishingForm draft={editor.draft} floors={[...(index?.floors.values() ?? [])].map((f) => ({ id:f.id, name:f.name, elevation:f.elevation }))}
      busy={busy} error={editor.error ?? removeError} onChange={editor.change} onUsePick={editor.reposition} onCancel={editor.cancel} onSave={editor.save}
      onRemove={editor.draft.id ? () => {
        if (!window.confirm(`Delete ${editor.draft!.name}?`)) return;
        setRemoveError(null);
        void remove(editor.draft!.id).then(editor.cancel).catch(() => setRemoveError("Could not delete furniture"));
      } : undefined} />
  </>;
}

function FurnishingForm({ draft, floors, busy, error, onChange, onUsePick, onCancel, onSave, onRemove }: {
  draft: Furnishing; floors:Array<{id:string;name:string;elevation:number}>; busy:boolean; error:string|null;
  onChange(d:Furnishing):void; onUsePick():void; onCancel():void; onSave():void; onRemove?:()=>void;
}) {
  const number = (key: "rotationYDeg"|"widthM"|"depthM"|"heightM", value:string) => onChange({...draft,[key]:Number(value)});
  const coordinate = (axis:number,value:string) => { const p=[...draft.position] as [number,number,number]; p[axis]=Number(value); onChange({...draft,position:p}); };
  return <form onSubmit={(e)=>{e.preventDefault();onSave();}} onKeyDown={(e)=>{if(e.key === "Escape" && !busy){e.preventDefault();e.stopPropagation();onCancel();}}} className="flex shrink-0 flex-col gap-3">
    <header><h2 className="text-sm font-semibold text-ink">{draft.id ? "Edit furniture" : "Add furniture"}</h2><p className="text-xs text-ink-3">Physical dimensions and coordinates are metres.</p></header>
    <label className="flex flex-col gap-1 text-xs text-ink-2">Type<Select value={draft.kind} disabled={busy} options={FURNISHING_CATALOG.map(o=>({value:o.kind,label:o.label}))} onValueChange={(value)=>{const o=FURNISHING_CATALOG.find(x=>x.kind===value)!;onChange({...draft,kind:o.kind,name:draft.id?draft.name:o.label,widthM:o.size[0],depthM:o.size[1],heightM:o.size[2]});}} /></label>
    <label className="flex flex-col gap-1 text-xs text-ink-2">Name<Input disabled={busy} value={draft.name} maxLength={100} onChange={(e)=>onChange({...draft,name:e.target.value})} /></label>
    <label className="flex flex-col gap-1 text-xs text-ink-2">Floor<Select value={draft.floorId} disabled={busy} options={floors.map(f=>({value:f.id,label:f.name}))} onValueChange={(value)=>{const f=floors.find(x=>x.id===value)!;onChange({...draft,floorId:f.id,position:[draft.position[0],f.elevation,draft.position[2]]});}} /></label>
    <Button size="sm" variant="secondary" disabled={busy} onClick={onUsePick}>Reposition in 3D</Button>
    <fieldset disabled={busy}><legend className="text-xs font-medium text-ink-2">Position</legend><div className="grid grid-cols-3 gap-2">{(["X","Y","Z"] as const).map((label,i)=><label key={label} className="text-xs text-ink-3">{label}<Input type="number" step="0.001" value={draft.position[i]} onChange={(e)=>coordinate(i,e.target.value)} /></label>)}</div></fieldset>
    <fieldset disabled={busy}><legend className="text-xs font-medium text-ink-2">Size</legend><div className="grid grid-cols-3 gap-2">{(["widthM","depthM","heightM"] as const).map((key)=><label key={key} className="text-xs text-ink-3">{{widthM:"Width",depthM:"Depth",heightM:"Height"}[key]}<Input type="number" min={key === "heightM" ? "0.01" : "0.05"} max={key === "heightM" ? "15" : "30"} step="0.01" value={draft[key]} onChange={(e)=>number(key,e.target.value)} /></label>)}</div></fieldset>
    <label className="flex flex-col gap-1 text-xs text-ink-2">Yaw (degrees)<Input disabled={busy} type="number" step="1" value={draft.rotationYDeg} onChange={(e)=>number("rotationYDeg",e.target.value)} /></label>
    {error ? <p role="alert" className="text-xs text-overdue">{error}</p> : null}
    <div className="sticky bottom-0 flex gap-2 border-t border-line bg-surface py-2"><Button type="submit" variant="primary" size="sm" loading={busy} disabled={!draft.name.trim() || ![...draft.position,draft.widthM,draft.depthM,draft.heightM,draft.rotationYDeg].every(Number.isFinite)}>Save</Button><Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>{onRemove ? <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy} className="ml-auto text-overdue">Delete</Button> : null}</div>
  </form>;
}
