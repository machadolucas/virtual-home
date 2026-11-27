"use client";
import { useEffect, useRef, useState } from "react";
import { ScanSearch } from "lucide-react";
import { Button, Dialog } from "@/ui";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";
import type { AlignmentAttemptDetail, AlignmentAttemptSnapshot, AlignmentAttemptSummary, AlignmentDiagnosis } from "../alignmentAttemptTypes";

const outcomes = {aligning:"Last checkpoint", ended:"Ended before alignment", interrupted:"Tracking interrupted", aligned:"Alignment verified"};
const reasons: Record<string,string> = {
  "marked-plan-correspondence-conflict":"A checked position fits different walls from the ones paired on the plan.",
  "missing-viewer-pose":"The headset did not provide a tracked viewpoint.",
  "no-scan-geometry":"No usable room geometry was present in this observation.",
  "room-not-identified":"Room discovery had not identified a room for comparison.",
  "multiple-checked-headings":"Several headings passed the geometric check.",
  "checked-pose-found":"A room position passed the geometric check.",
  "alignment-verified":"The app verified the alignment.",
  "fewer-than-four-marked-walls":"The trace matcher needs four distinct wall marks.",
  "marked-walls-parallel":"The marks do not establish two different wall directions.",
  "marked-wall-endpoints-disagree":"The marked line endpoints do not fit the model walls within tolerance.",
  "observed-wall-crosses-fitted-room":"An observed wall conflicts with the proposed room position.",
  "independent-check-exceeds-tolerance":"The closest independent check exceeded 5 cm.",
  "opening-correspondence-conflict":"A detected opening conflicts with its proposed model counterpart.",
  "outline-heading-ambiguous":"The floor outline fits more than one heading.",
  "local-outline-discrepancy":"One possible heading pairs the outlines but leaves a local shape difference.",
  "no-independent-corroboration":"Wall pairs fit, but independent geometry did not confirm a position.",
  "no-measured-floor-or-opening-pair":"The scan lacked a usable floor or a pair of openings.",
  "insufficient-wall-directions":"The scan lacked distinct wall directions or enough openings.",
  "no-compatible-rigid-fit":"The available measurements did not establish a matching room position.",
};
type Point = readonly [number,number];
const cm = (n:number) => (n * 100).toFixed(1) + " cm";
function ScanPlan({sample, model}: {sample?:AlignmentAttemptSnapshot;model?: readonly Point[]}) {
  const ring = sample?.floor?.outline ?? model ?? [];
  const walls = sample?.walls ?? [], marks = sample?.traces ?? [], openings = sample?.landmarks ?? [];
  const points: Point[] = [...ring,...[...walls,...marks].flatMap(w => [w.a,w.b]),...openings.map(m => [m.center[0],m.center[2]] as const)];
  if (!points.length) return <p className="grid min-h-32 place-items-center rounded-lg border border-line text-xs text-ink-3">No geometry in this observation</p>;
  const xs=points.map(p=>p[0]), zs=points.map(p=>p[1]);
  const left=Math.min(...xs), top=Math.min(...zs), w=Math.max(.2,Math.max(...xs)-left), h=Math.max(.2,Math.max(...zs)-top);
  const margin=Math.max(w,h)*.10;
  const line=(a:Point,b:Point,key:string,color:string,dashed=false) => <line key={key}
    x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={dashed ? 2.5 : 3} strokeDasharray={dashed ? "6 4" : undefined} vectorEffect="non-scaling-stroke"/>;
  return <svg className="h-44 w-full rounded-lg border border-line bg-surface-2" role="img" aria-label={sample ? "Recorded headset geometry in local-floor coordinates" : "Model room footprint"}
    viewBox={`${left-margin} ${top-margin} ${w+2*margin} ${h+2*margin}`}>
    {ring.length>=3 && <polygon points={ring.map(p=>p.join(",")).join(" ")} fill="#60a5fa" fillOpacity=".18" stroke="#60a5fa" strokeWidth={2} vectorEffect="non-scaling-stroke"/>}
    {walls.map((wall,i)=>line(wall.a,wall.b,"w"+i,"var(--color-ink)"))}
    {marks.map((wall,i)=>line(wall.a,wall.b,"t"+i,"#fbbf24",true))}
    {openings.map((m,i)=> <circle key={i} cx={m.center[0]} cy={m.center[2]} r={margin*.24} fill={m.kind==="door"?"#34d399":"#c084fc"}><title>{m.kind}</title></circle>)}
  </svg>;
}
function Result({diagnosis:d}: {diagnosis:AlignmentDiagnosis}) {
  return <div className="space-y-1">
    <p className="font-semibold">{reasons[d.reason] ?? d.reason}</p>
    <p>{d.bestCheckM === null ? "No independent check distance was recorded." : `Closest measured independent check: ${cm(d.bestCheckM)}.`}
      {d.bestTraceGapM !== null && ` Best marked-line gap: ${cm(d.bestTraceGapM)}.`}</p>
    {d.outline && <p>{d.outline.basis === "hypothesis" ? "Provisional outline comparison" : "Checked outline comparison"}
      {d.outline.maxDeviationM !== null ? ` · largest perimeter difference ${cm(d.outline.maxDeviationM)}` : ` · ${d.outline.plausiblePoses} possible headings`}
      {d.outline.walls.length > 0 && ` · model walls ${d.outline.walls.map(w => w.wallIndex+1).join(", ")}`}</p>}
  </div>;
}

export function AlignmentReports() {
  const runtime = useHouseRuntime();
  const fingerprint = useHouseStore(s=>s.fingerprint);
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState("");
  const [items,setItems] = useState<AlignmentAttemptSummary[]>([]), [cursor,setCursor] = useState<string|null>(null);
  const [detail,setDetail] = useState<AlignmentAttemptDetail|null>(null), [sampleIndex,setSampleIndex] = useState(0);
  const request = useRef<AbortController|null>(null);
  useEffect(()=>()=>request.current?.abort(),[]);
  const load = async (id?:string, next?:string) => {
    request.current?.abort();
    const controller=new AbortController(); request.current=controller;
    setBusy(true); setError("");
    try {
      const url=runtime.base+"/alignment-attempts"+(id?"/"+encodeURIComponent(id):next?"?cursor="+encodeURIComponent(next):"");
      const res=await fetch(url,{cache:"no-store",signal:controller.signal});
      if (!res.ok) throw new Error("Could not load the alignment report.");
      const data=await res.json();
      if (controller.signal.aborted) return;
      if (id) { const r=data as AlignmentAttemptDetail; setDetail(r); setSampleIndex(Math.max(0,r.snapshots.length-1)); }
      else { setItems(old=>next?[...old,...data.items]:data.items); setCursor(data.nextCursor); setDetail(null); }
    } catch { if (!controller.signal.aborted) setError("Could not load alignment reports. Try again."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const sample=detail?.snapshots[sampleIndex];
  const roomName=(id:string|null)=>id ? runtime.manifest?.rooms.get(id)?.name ?? id : "Room discovery";
  const room = sample?.roomId && detail?.fingerprint === fingerprint ? runtime.manifest?.rooms.get(sample.roomId) : null;
  return <Dialog open={open} onOpenChange={value=>{setOpen(value); if(value) void load(); else {request.current?.abort();setDetail(null);} }}
    title="Alignment reports" size="lg" trigger={<Button variant="ghost" size="sm" icon={<ScanSearch/>}>Alignment reports</Button>}
    description="Private checkpoints saved automatically during mixed reality setup.">
    {error && <p role="alert">{error} <Button size="sm" onClick={()=>void load(detail?.id)}>Retry</Button></p>}
    {busy && <p role="status">Loading reports…</p>}
    {detail ? <div className="grid gap-3 text-sm">
      <div><Button size="sm" variant="ghost" onClick={()=>void load()}>All attempts</Button>
        <h3 className="mt-2 font-semibold">{roomName(detail.roomId)} · {outcomes[detail.status]}</h3>
        <p className="text-ink-3">{new Date(detail.startedAtMs).toLocaleString()}</p></div>
      {sample ? <>
        <label>Observation <select value={sampleIndex} onChange={e=>setSampleIndex(Number(e.target.value))}>
          {detail.snapshots.map((s,i)=><option value={i} key={i}>{i+1} · {Math.round(s.atMs/1000)}s · {roomName(s.roomId)}</option>)}</select></label>
        <div className="grid gap-3 sm:grid-cols-2"><figure><ScanPlan sample={sample}/><figcaption>Quest observation</figcaption></figure>
          {room && <figure><ScanPlan model={room.footprint.outer}/><figcaption>Model footprint · model heading</figcaption></figure>}</div>
        <p className="text-xs">Blue floor outline · Solid walls ({sample.walls.length}) · Green doors ({sample.landmarks.filter(m=>m.kind==="door").length}) · Purple windows ({sample.landmarks.filter(m=>m.kind==="window").length}) · Dashed gold marks ({sample.traces.length})</p>
        {sample.diagnosis && <Result diagnosis={sample.diagnosis}/>}
        {sample.detections && <p className="text-xs text-ink-3">Headset input · planes {sample.detections.planes ?? "unavailable"} · meshes {sample.detections.meshes ?? "unavailable"}</p>}
      </> : <p>The session ended or stopped reporting before a tracked observation was available.</p>}
      <details><summary className="cursor-pointer font-medium">Attempt timeline</summary><ol className="mt-2 grid gap-1">{detail.events.map((e,i)=><li key={i}>{Math.round(e.atMs/1000)}s · {e.detail}</li>)}</ol></details>
    </div> : <div className="grid gap-2">
      {!busy && !error && !items.length && <p>No attempts saved yet. Enter mixed reality on the headset to record one.</p>}
      {items.map(r=><button key={r.id} className="rounded-md border border-line p-3 text-left hover:bg-surface-2" onClick={()=>void load(r.id)}>
        <strong>{roomName(r.roomId)}</strong> · {outcomes[r.status]}<span className="block text-xs text-ink-3">{new Date(r.startedAtMs).toLocaleString()}</span></button>)}
      {cursor && <Button disabled={busy} onClick={()=>void load(undefined,cursor)}>Load older attempts</Button>}
    </div>}
  </Dialog>;
}
