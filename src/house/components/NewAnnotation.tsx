"use client";
import { useState } from "react";
import { Button, Input, Select } from "@/ui";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";
import { ANNOTATION_KINDS } from "@/features/projects/wire";
import type { AnnotationSave } from "../store/dataApi";

export function NewAnnotation() {
  const runtime=useHouseRuntime();
  const selection=useHouseStore(s=>s.selection);
  const [title,setTitle]=useState("");const [body,setBody]=useState("");
  const [kind,setKind]=useState<AnnotationSave["kind"]>("note");
  const [measurement,setMeasurement]=useState("");const [unit,setUnit]=useState("");
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const node=selection&&["room","floor","building","surface","element"].includes(selection.kind)?selection.id:null;
  return <form className="flex flex-col gap-3 py-3" onSubmit={async e=>{e.preventDefault();const s=runtime.store.getState();if(!s.modelId||!s.fingerprint)return;setBusy(true);setError(null);try{const row=await runtime.dataApi.saveAnnotation(s.modelId,s.fingerprint,{targetKind:"node",targetId:null,modelNodeId:node,position:null,kind,title,body:body||null,measurementValue:kind==="measurement"?Number(measurement):null,measurementUnit:kind==="measurement"?unit:null});setTitle("");setBody("");runtime.select({kind:"annotation",id:row.id});}catch(cause){setError(cause instanceof Error?cause.message:"Could not save note");}finally{setBusy(false);}}}>
    <h3 className="text-sm font-semibold">Add a note or measurement</h3>
    <p className="text-xs text-ink-3">{node?"Attached to the selected place.":"Select a room or surface in the model to attach this note."}</p>
    <label className="text-xs">Type<Select value={kind} options={ANNOTATION_KINDS.map(value=>({value,label:value.replaceAll("_"," ")}))} onValueChange={v=>setKind(v as AnnotationSave["kind"])} /></label>
    <label className="text-xs">Title<Input value={title} onChange={e=>setTitle(e.target.value)} required maxLength={200}/></label>
    <label className="text-xs">Details<textarea className="mt-1 min-h-24 w-full rounded-md border border-line bg-surface p-2" value={body} onChange={e=>setBody(e.target.value)} maxLength={4000}/></label>
    {kind==="measurement"?<div className="grid grid-cols-2 gap-2"><label className="text-xs">Value<Input type="number" step="any" required value={measurement} onChange={e=>setMeasurement(e.target.value)}/></label><label className="text-xs">Unit<Input required value={unit} onChange={e=>setUnit(e.target.value)}/></label></div>:null}
    {error?<p role="alert" className="text-xs text-overdue">{error}</p>:null}
    <Button type="submit" size="sm" loading={busy} disabled={!node||!title.trim()}>Save note</Button>
  </form>;
}
