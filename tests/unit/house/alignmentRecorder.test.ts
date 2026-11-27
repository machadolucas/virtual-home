import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AlignmentRecorder } from "@/house/xr/alignmentRecorder";
import { alignmentAttemptInput, type AlignmentAttempt } from "@/house/alignmentAttemptTypes";
import { retryAlignmentAttempts } from "@/house/alignmentAttemptApi";

const base="/api/house-model/fixture";
const floor={y:0,outline:[[0,0],[3,0],[3,2],[0,2]] as [number,number][],source:"plane" as const};
const empty={viewer:[1,1.6,1] as [number,number,number],floor:null,walls:[],traces:[],landmarks:[],diagnosis:null};
const store: Record<string,string>={};
const saved: AlignmentAttempt[]=[];
function acknowledge(_url: unknown, init: RequestInit) {
  const report=alignmentAttemptInput.parse(JSON.parse(init.body as string));
  saved.push(report);
  return Promise.resolve(Response.json({id:report.id,revision:report.revision}));
}
beforeEach(()=>{
  vi.useFakeTimers();
  for(const k of Object.keys(store)) delete store[k];
  saved.length=0;
  Object.defineProperties(store,{
    getItem:{value:(key:string)=>store[key]??null,configurable:true},
    setItem:{value:(key:string,value:string)=>{store[key]=value;},configurable:true},
    removeItem:{value:(key:string)=>{delete store[key];},configurable:true},
  });
  vi.stubGlobal("localStorage",store); vi.stubGlobal("window",new EventTarget()); vi.stubGlobal("fetch",vi.fn(acknowledge));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("checkpoints discovery, retains failed marks across tracking resets, and keeps an ended attempt",async ()=>{
  const r=new AlignmentRecorder(base,"owner","abcdef12","mr",["plane-detection"]);
  r.observe(()=>empty);
  await vi.advanceTimersByTimeAsync(400);
  expect(saved[0]?.snapshots[0]?.walls).toEqual([]);
  expect(r.notice).toBe("Alignment report saved");
  r.selectRoom("room-a");
  const observed={...empty,floor,traces:[{a:[0,0] as [number,number],b:[1,0] as [number,number],low:0,high:0,baseOnly:true}]};
  r.observe(()=>observed,true);
  r.event("paired-wall","Marked line 1 → model wall 2. Four marks could not verify a position.");
  r.interrupt("reference-reset");
  r.observe(()=>empty,true);
  r.finish();
  await vi.advanceTimersByTimeAsync(100);
  const last=saved.at(-1)!;
  expect(last.status).toBe("ended");
  expect(last.events.map(e=>e.kind)).toEqual(["started","room","paired-wall","reference-reset","resumed","ended"]);
  expect(last.snapshots.at(-1)?.space).toBe(1);
  expect(last.snapshots.some(s=>s.traces.length===1 && s.space===0)).toBe(true);
  expect(Object.keys(store)).toHaveLength(0);
});
it("queues an offline exit and replays only on the same account and model endpoint",async ()=>{
  vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
  const r=new AlignmentRecorder(base,"owner","abcdef12","mr",[]);
  r.observe(()=>({...empty,floor}));
  r.finish(); await vi.advanceTimersByTimeAsync(100);
  expect(r.notice).toMatch(/saved on headset/);
  vi.stubGlobal("fetch",vi.fn(acknowledge));
  await retryAlignmentAttempts(base,"other"); await retryAlignmentAttempts(base+"2","owner");
  expect(saved).toHaveLength(0);
  await retryAlignmentAttempts(base,"owner");
  expect(saved[0]?.status).toBe("ended");
  expect(saved[0]?.snapshots[0]?.floor).toEqual(floor);
  expect(Object.keys(store)).toHaveLength(0);
});
it("persists the newest revision while a prior checkpoint awaits acknowledgement",async ()=>{
  let resolve!: (response:Response)=>void;
  const original=vi.fn(acknowledge);
  vi.stubGlobal("fetch",original.mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;})));
  const r=new AlignmentRecorder(base,"owner","abcdef12","mr",[]);
  await vi.advanceTimersByTimeAsync(400);
  const firstRevision=r.report.revision;
  r.observe(()=>({...empty,floor}),true); r.aligned("Independent check passed"); r.finish();
  const queued=JSON.parse(Object.values(store)[0]!);
  expect(queued.revision).toBeGreaterThan(firstRevision);
  resolve(Response.json({id:r.report.id,revision:firstRevision}));
  await vi.advanceTimersByTimeAsync(50);
  expect(saved.at(-1)?.status).toBe("aligned");
  expect(saved.at(-1)?.revision).toBe(queued.revision);
  expect(Object.keys(store)).toHaveLength(0);
});
