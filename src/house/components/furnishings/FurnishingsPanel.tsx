"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Armchair, Plus } from "lucide-react";
import { Button, Input, Select } from "@/ui";
import type { Furnishing, FurnishingKind } from "@/house/model/types";
import { useHouseRuntime, useHouseStore } from "../../hooks/useHouseStore";
import { useFurnishings } from "./FurnishingsProvider";
import { initialPosition } from "../edit/startPlacement";

const OPTIONS: Array<{ kind: FurnishingKind; label: string; size: [number, number, number] }> = [
  { kind: "sofa", label: "Sofa", size: [2.1,.9,.85] },
  { kind: "sofa_l", label: "L-shaped sofa", size: [2.6,1.7,.85] },
  { kind: "bed_single", label: "Single bed", size: [.9,2,.6] },
  { kind: "bed_double", label: "Double bed", size: [1.6,2,.6] },
  { kind: "bedside_table", label: "Bedside table", size: [.5,.45,.55] },
  { kind: "chair", label: "Chair", size: [.5,.55,.9] },
  { kind: "dining_table", label: "Dining table", size: [1.8,.9,.75] },
  { kind: "computer_desk", label: "Computer desk", size: [1.4,.7,.75] },
  { kind: "bicycle", label: "Bicycle", size: [1.7,.45,1.1] },
  { kind: "shelves", label: "Shelves", size: [1,.35,1.8] },
  { kind: "cabinet", label: "Cabinet / wardrobe", size: [1.2,.6,2] },
  { kind: "kitchen_counter", label: "Kitchen counter", size: [1.8,.65,.92] },
  { kind: "rug", label: "Rug", size: [2,1.4,.02] },
  { kind: "bench", label: "Bench", size: [1.3,.45,.5] },
];
const labelFor = (kind: FurnishingKind) => OPTIONS.find((x) => x.kind === kind)?.label ?? kind;
type Draft = Omit<Furnishing, "modelId"> & { id: string };

export function FurnishingsPanel() {
  const runtime = useHouseRuntime();
  const { items, loading, error, staleIds, busy, retry, save, remove, setPreview, registerEditHandler } = useFurnishings();
  const index = useHouseStore((s) => s.index);
  const activeFloorId = useHouseStore((s) => s.activeFloorId);
  const setExplode = useHouseStore((s) => s.setExplode);
  const setFurnishingsEditing = useHouseStore((s) => s.setFurnishingsEditing);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const priorExplode = useRef<{ enabled: boolean; gap: number; locked: boolean } | null>(null);
  const pickAtOpen = useRef(runtime.lastPick);
  const floors = useMemo(() => [...(index?.floors.values() ?? [])].sort((a,b)=>a.elevation-b.elevation), [index]);

  const begin = useCallback((item?: Furnishing) => {
    if (busy || draft) return;
    const house = runtime.store.getState();
    if (house.editing || house.routeDraft) {
      setFormError("Finish or cancel the current placement or route edit first.");
      return;
    }
    const floor = floors.find((x) => x.id === (item?.floorId ?? activeFloorId)) ?? floors[0];
    if (!floor) return;
    setExpanded(true);
    priorExplode.current ??= runtime.store.getState().explode;
    setFurnishingsEditing(true);
    setExplode({ enabled: false, gap: 0, locked: true });
    pickAtOpen.current = runtime.lastPick;
    const initial = initialPosition(runtime, floor.id);
    const option = OPTIONS[0]!;
    setDraft(item ? { ...item } : {
      id: "", kind: option.kind, name: option.label,
      position: initial.position,
      rotationYDeg: 0, widthM: option.size[0], depthM: option.size[1], heightM: option.size[2],
      floorId: floor.id, roomId: initial.roomId,
    });
    setFormError(null);
  }, [activeFloorId, busy, draft, floors, runtime, setExplode, setFurnishingsEditing]);

  useEffect(() => {
    registerEditHandler((id) => {
      const item = items.find((x) => x.id === id);
      if (item) begin(item);
    });
    return () => registerEditHandler(null);
  }, [begin, items, registerEditHandler]);

  useEffect(() => {
    setPreview(draft ? { ...draft, id: draft.id, modelId: index?.manifest.modelId ?? "" } : null);
    return () => setPreview(null);
  }, [draft, index?.manifest.modelId, setPreview]);

  const finish = () => {
    setDraft(null);
    if (priorExplode.current) {
      setExplode({ locked: false, gap: 0 });
      setExplode(priorExplode.current);
    }
    priorExplode.current = null;
    setFurnishingsEditing(false);
  };

  useEffect(() => () => {
    if (priorExplode.current) {
      runtime.store.getState().setExplode({ locked: false, gap: 0 });
      runtime.store.getState().setExplode(priorExplode.current);
    }
    runtime.store.getState().setFurnishingsEditing(false);
    setPreview(null);
  }, [runtime, setPreview]);

  if (draft) return <FurnishingForm
    draft={draft} floors={floors.map((f)=>({id:f.id,name:f.name,elevation:f.elevation}))}
    busy={busy} error={formError}
    onChange={setDraft}
    onUsePick={() => {
      const hit = runtime.lastPick;
      if (!hit?.floorId || hit === pickAtOpen.current) { setFormError("Click a floor or room in the 3D view first."); return; }
      setDraft((d) => d ? { ...d, position: [hit.point.x, hit.point.y, hit.point.z], floorId: hit.floorId!, roomId: hit.roomId } : d);
      setFormError(null);
    }}
    onCancel={finish}
    onSave={() => {
      setFormError(null);
      const { id, ...rest } = draft;
      void save({ ...rest, ...(id ? { id } : {}) }).then(finish)
        .catch((cause:unknown)=>setFormError(cause instanceof Error ? cause.message : "Could not save furniture"));
    }}
  />;

  return (
    <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)} className="rounded-md border border-line bg-surface-2">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-2 text-sm font-medium text-ink">
        <Armchair className="size-4 text-ink-3" aria-hidden="true" /> Furniture
        <span className="ml-auto text-xs font-normal text-ink-3">{items.length}</span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-line p-2">
        <p className="text-xs text-ink-3">Lightweight objects in the model only.</p>
        {loading ? <p className="text-xs text-ink-3">Loading…</p> : null}
        {error || formError ? <p role="alert" className="text-xs text-overdue">{error ?? formError}</p> : null}
        {error ? <Button size="sm" variant="ghost" onClick={retry}>Retry</Button> : null}
        <Button size="sm" disabled={busy || loading} onClick={() => begin()} icon={<Plus aria-hidden="true" />}>Add furniture</Button>
        {items.length ? <ul className="flex flex-col gap-1">{items.map((item)=><li key={item.id} className="flex min-w-0 items-center gap-1">
          <button type="button" disabled={busy} onClick={()=>begin(item)} className="min-h-11 min-w-0 flex-1 truncate rounded px-2 text-left text-sm text-ink hover:bg-surface-3 disabled:opacity-50">
            {item.name}<span className="ml-1 text-xs text-ink-3">{staleIds.has(item.id) ? "Needs a floor" : labelFor(item.kind)}</span>
          </button>
          <Button size="sm" variant="ghost" onClick={()=>{ if (window.confirm(`Delete ${item.name}?`)) void remove(item.id).catch((cause:unknown)=>setFormError(cause instanceof Error?cause.message:"Could not delete furniture")); }} disabled={busy}>Delete</Button>
        </li>)}</ul> : <p className="text-xs text-ink-3">No furniture added.</p>}
      </div>
    </details>
  );
}

function FurnishingForm({ draft, floors, busy, error, onChange, onUsePick, onCancel, onSave }: {
  draft: Draft; floors:Array<{id:string;name:string;elevation:number}>; busy:boolean; error:string|null;
  onChange(d:Draft):void; onUsePick():void; onCancel():void; onSave():void;
}) {
  const number = (key: "rotationYDeg"|"widthM"|"depthM"|"heightM", value:string) => onChange({...draft,[key]:Number(value)});
  const coordinate = (axis:number,value:string) => { const p=[...draft.position] as [number,number,number]; p[axis]=Number(value); onChange({...draft,position:p}); };
  return <form onSubmit={(e)=>{e.preventDefault();onSave();}} onKeyDown={(e)=>{if(e.key === "Escape" && !busy){e.preventDefault();e.stopPropagation();onCancel();}}} className="flex flex-col gap-3">
    <header><h2 className="text-sm font-semibold text-ink">{draft.id ? "Edit furniture" : "Add furniture"}</h2><p className="text-xs text-ink-3">Physical dimensions and coordinates are metres.</p></header>
    <label className="flex flex-col gap-1 text-xs text-ink-2">Type<Select value={draft.kind} disabled={busy} options={OPTIONS.map(o=>({value:o.kind,label:o.label}))} onValueChange={(value)=>{const o=OPTIONS.find(x=>x.kind===value)!;onChange({...draft,kind:o.kind,name:draft.id?draft.name:o.label,widthM:o.size[0],depthM:o.size[1],heightM:o.size[2]});}} /></label>
    <label className="flex flex-col gap-1 text-xs text-ink-2">Name<Input disabled={busy} value={draft.name} maxLength={100} onChange={(e)=>onChange({...draft,name:e.target.value})} /></label>
    <label className="flex flex-col gap-1 text-xs text-ink-2">Floor<Select value={draft.floorId} disabled={busy} options={floors.map(f=>({value:f.id,label:f.name}))} onValueChange={(value)=>{const f=floors.find(x=>x.id===value)!;onChange({...draft,floorId:f.id,position:[draft.position[0],f.elevation,draft.position[2]]});}} /></label>
    <Button size="sm" variant="secondary" disabled={busy} onClick={onUsePick}>Use last 3D click</Button>
    <fieldset disabled={busy}><legend className="text-xs font-medium text-ink-2">Position</legend><div className="grid grid-cols-3 gap-2">{(["X","Y","Z"] as const).map((label,i)=><label key={label} className="text-xs text-ink-3">{label}<Input type="number" step="0.001" value={draft.position[i]} onChange={(e)=>coordinate(i,e.target.value)} /></label>)}</div></fieldset>
    <fieldset disabled={busy}><legend className="text-xs font-medium text-ink-2">Size</legend><div className="grid grid-cols-3 gap-2">{(["widthM","depthM","heightM"] as const).map((key)=><label key={key} className="text-xs text-ink-3">{{widthM:"Width",depthM:"Depth",heightM:"Height"}[key]}<Input type="number" min={key === "heightM" ? "0.01" : "0.05"} max={key === "heightM" ? "15" : "30"} step="0.01" value={draft[key]} onChange={(e)=>number(key,e.target.value)} /></label>)}</div></fieldset>
    <label className="flex flex-col gap-1 text-xs text-ink-2">Yaw (degrees)<Input disabled={busy} type="number" step="1" value={draft.rotationYDeg} onChange={(e)=>number("rotationYDeg",e.target.value)} /></label>
    {error ? <p role="alert" className="text-xs text-overdue">{error}</p> : null}
    <div className="flex gap-2"><Button type="submit" variant="primary" size="sm" loading={busy} disabled={!draft.name.trim() || ![...draft.position,draft.widthM,draft.depthM,draft.heightM,draft.rotationYDeg].every(Number.isFinite)}>Save</Button><Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button></div>
  </form>;
}
