"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/ui/Button";
import { addConnection, rotateConnection, revokeConnection, reviewRequest } from "./actions";

interface Connection {id:string;name:string;userName:string;tokenPrefix:string;scopesJson:string;expiresAtMs:number;revokedAtMs:number|null;lastUsedAtMs:number|null}
interface Review {id:string;operation:string;payloadJson:string;summary:string;state:string;expiresAtMs:number;createdAtMs:number;resultJson:string|null;connectionName:string;revokedAtMs:number|null}
const field="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm";
const errors:Record<string,string>={unauthorized:"Sign in again to manage AI connections.",request_target_changed:"This record changed after the agent prepared its request. Reject this request and ask for a new one.",connection_expired_or_revoked:"This connection has expired or was revoked. Its actions cannot run.",revision_conflict:"The record changed. Ask the agent to refresh and prepare a new request.",internal:"The change could not be saved. Try again."};

const fieldNames:Record<string,string>={assetId:"Equipment",oldAssetId:"Equipment being replaced",assetIds:"Equipment",partId:"Supply",projectId:"Project",procedureId:"Procedure",providerId:"Professional",occurrenceId:"Task",completionId:"Recorded work",qtyMilli:"Quantity",countedMilli:"Counted quantity",unitPriceCents:"Unit price",notes:"Notes",removedOn:"Out of service on",completedAt:"When work happened",performedByUserId:"Performed by member",performedByProviderId:"Performed by professional",command:"Equipment command",registryId:"Linked Home Assistant entity"};
function RequestFields({value,labels,fieldName=""}:{value:unknown;labels:Record<string,string>;fieldName?:string}){
  if(value===null)return <span className="text-ink-3">None</span>;
  if(typeof value==="boolean")return <span>{value?"Yes":"No"}</span>;
  if(typeof value==="number")return <span>{fieldName.endsWith("Milli")?`${value/1000} units`:fieldName.endsWith("Cents")?(value/100).toFixed(2):String(value)}</span>;
  if(typeof value==="string")return <span className="whitespace-pre-wrap break-words">{labels[value]??value}</span>;
  if(Array.isArray(value))return value.length===0?<span className="text-ink-3">None</span>:<ol className="space-y-2">{value.map((item,index)=><li key={index}><RequestFields value={item} labels={labels} fieldName={fieldName}/></li>)}</ol>;
  if(value&&typeof value==="object")return <dl className="space-y-2">{Object.entries(value).filter(([key])=>!["requestId","idempotencyKey"].includes(key)).map(([key,item])=><div key={key} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-3"><dt className="text-ink-3">{fieldNames[key]??key.replace(/([A-Z])/g," $1").replace(/^./,c=>c.toUpperCase())}</dt><dd className="min-w-0"><RequestFields value={item} labels={labels} fieldName={key}/></dd></div>)}</dl>;
  return <span>—</span>;
}

export function AiConnections({connections,requests,endpoint,now}:{connections:Connection[];requests:Review[];endpoint:string;now:number}){
  const router=useRouter();const [pending,start]=useTransition();const [feedback,setFeedback]=useState("");const [secret,setSecret]=useState<string|null>(null);
  const [name,setName]=useState("");const [author,setAuthor]=useState(true);const [requestActions,setRequestActions]=useState(false);
  const [days,setDays]=useState("90");const [createOpen,setCreateOpen]=useState(connections.length===0);
  const pendingRequests=requests.filter(r=>r.state==="pending"&&r.expiresAtMs>now&&r.revokedAtMs===null);
  function run(fn:()=>Promise<{ok:boolean;error?:string}>,success:string){setFeedback("");start(async()=>{try{const r=await fn();setFeedback(r.ok?success:errors[r.error??""]??`Could not save: ${r.error??"unknown error"}`);if(r.ok)router.refresh();}catch{setFeedback(errors.internal!);}});}
  async function copy(value:string){try{await navigator.clipboard.writeText(value);setFeedback("Copied.");}catch{setFeedback("Copy was unavailable. Select and copy the text below.");}}
  return <div className="space-y-6">
    <div role="status" aria-live="polite" className="text-sm text-ink-2">{feedback}</div>
    <section className="rounded-lg border border-line bg-surface p-4 space-y-3" aria-labelledby="ai-review-heading">
      <h2 id="ai-review-heading" className="font-semibold">Needs your approval {pendingRequests.length>0&&`(${pendingRequests.length})`}</h2>
      {pendingRequests.length===0?<p className="text-sm text-ink-3">No actions waiting. Routine edits appear in history; consequential actions wait here before anything changes.</p>:pendingRequests.map(r=>{
        const payload=JSON.parse(r.payloadJson) as {arguments:unknown;snapshots?:{id:string;label?:string}[]};
        const labels=Object.fromEntries((payload.snapshots??[]).filter(s=>s.label).map(s=>[s.id,s.label!]));
        return <article id={`request-${r.id}`} key={r.id} className="rounded-md border border-line p-3 space-y-3">
          <div><h3 className="font-medium">{r.operation.replaceAll("."," · ").replaceAll("_"," ")}</h3><p className="text-sm text-ink-2">{r.summary}</p><p className="text-xs text-ink-3">Expires {new Date(r.expiresAtMs).toLocaleString()}</p></div>
          <p className="text-sm">Review the exact fields below. Approving applies this request once. Recording work means you confirm it actually happened.</p>
          <div className="max-h-80 overflow-auto rounded bg-surface-2 p-3 text-sm"><RequestFields value={payload.arguments} labels={labels}/></div>
          <details><summary className="cursor-pointer text-xs text-ink-3">Exact request data</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(payload.arguments,null,2)}</pre></details>
          <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={pending} onClick={()=>run(()=>reviewRequest({id:r.id,decision:"approve"}),"Request approved.")}>Approve and apply</Button><Button disabled={pending} onClick={()=>run(()=>reviewRequest({id:r.id,decision:"reject"}),"Request rejected.")}>Reject</Button></div>
        </article>;
      })}
    </section>
    <section className="space-y-3" aria-labelledby="ai-connections-heading">
      <div className="flex items-center justify-between gap-3"><h2 id="ai-connections-heading" className="font-semibold">Connections</h2><Button onClick={()=>setCreateOpen(v=>!v)}>{createOpen?"Close form":"Add connection"}</Button></div>
      {createOpen&&<form className="rounded-lg border border-line p-4 space-y-4" onSubmit={e=>{e.preventDefault();setFeedback("");start(async()=>{try{
        const r=await addConnection({name,scopes:["read",...(author?["author" as const]:[]),...(requestActions?["request_actions" as const]:[])],expiresInDays:Number(days)});
        if(r.ok){setSecret(r.data.token);setName("");setCreateOpen(false);router.refresh();}else setFeedback(errors[r.error]??r.error);
      }catch{setFeedback(errors.internal!);}});}}>
        <label className="block text-sm font-medium">Connection name<input required maxLength={80} className={`${field} mt-1`} placeholder="Claude on my laptop" value={name} onChange={e=>setName(e.target.value)}/></label>
        <fieldset className="space-y-2 text-sm"><legend className="font-medium mb-1">Access</legend><p className="text-ink-2">Read equipment, plans, supplies and documents is always included.</p>
          <label className="flex gap-2 items-start"><input type="checkbox" checked={author} onChange={e=>setAuthor(e.target.checked)} className="mt-1"/><span>Edit catalog and instructions<span className="block text-xs text-ink-3">Create and update equipment, supplies, plans, procedures and project records.</span></span></label>
          <label className="flex gap-2 items-start"><input type="checkbox" checked={requestActions} onChange={e=>setRequestActions(e.target.checked)} className="mt-1"/><span>Prepare actions for my approval<span className="block text-xs text-ink-3">Stock movements, recorded work, deletion and supported Home Assistant commands wait for approval here.</span></span></label>
        </fieldset>
        <label className="block text-sm">Expires after<select value={days} onChange={e=>setDays(e.target.value)} className={`${field} mt-1`}><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></label>
        <Button type="submit" variant="primary" loading={pending}>Create connection</Button>
      </form>}
      {secret&&<div className="rounded-lg border border-accent bg-surface p-4 space-y-3"><h3 className="font-medium">Save this token now</h3><p className="text-sm text-ink-2">It is shown once. Keep it in your AI app’s private configuration; anyone with it has this connection’s access.</p><code className="block break-all select-all text-sm">{secret}</code><div className="flex gap-2"><Button onClick={()=>void copy(secret)}>Copy token</Button><Button onClick={()=>setSecret(null)}>I saved it · hide</Button></div></div>}
      {connections.length===0?<p className="text-sm text-ink-3">No AI apps are connected yet.</p>:<ul className="divide-y divide-line rounded-lg border border-line">{connections.map(c=>{
        const active=c.revokedAtMs===null&&c.expiresAtMs>now;
        return <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 p-3"><div className="min-w-0"><p className="font-medium break-words">{c.name}<span className="ml-2 text-xs font-normal text-ink-3">{active?"Active":c.revokedAtMs?"Revoked":"Expired"}</span></p><p className="text-xs text-ink-3">{c.userName} · {JSON.parse(c.scopesJson).map((s:string)=>s==="author"?"edit records":s==="request_actions"?"request approval":"read").join(" · ")}</p><p className="text-xs text-ink-3">{c.lastUsedAtMs?`Last used ${new Date(c.lastUsedAtMs).toLocaleString()}`:"Not used yet"} · {c.tokenPrefix}…</p></div>{active&&<div className="flex gap-2"><Button size="sm" disabled={pending} onClick={()=>run(async()=>{const result=await rotateConnection({id:c.id});if(result.ok)setSecret(result.data.token);return result;},"Token rotated. Update your AI app configuration; the previous token no longer works.")}>Rotate token</Button><Button size="sm" variant="danger" disabled={pending} onClick={()=>run(()=>revokeConnection({id:c.id}),"Connection revoked.")}>Revoke</Button></div>}</li>;
      })}</ul>}
    </section>
    <details className="rounded-lg border border-line p-4"><summary className="cursor-pointer font-medium">Connect Claude or Codex</summary><div className="mt-3 space-y-3 text-sm text-ink-2">
      <p>Use the MCP address below with a Bearer token in your app’s private configuration.</p><code className="block break-all select-all">{endpoint}</code><Button size="sm" onClick={()=>void copy(endpoint)}>Copy address</Button>
      <p>For desktop apps that require a local command, use <code>scripts/mcp-bridge.mjs</code>. Put the URL and token in a private JSON file with permissions 0600, then set <code>VH_MCP_CONFIG</code> to that file. Start the bridge with the app’s Node runtime and the script’s absolute path.</p>
      <pre className="overflow-auto rounded bg-surface-2 p-3 text-xs">{JSON.stringify({url:endpoint,token:"PASTE_YOUR_TOKEN_HERE"},null,2)}</pre>
      <p>The bridge connects to this app over your existing local network address. Your AI provider receives the household records you ask the connected app to read.</p>
    </div></details>
    {requests.some(r=>!pendingRequests.includes(r))&&<details className="rounded-lg border border-line p-4"><summary className="cursor-pointer font-medium">Recent requests</summary><ul className="mt-3 space-y-2 text-sm">{requests.filter(r=>!pendingRequests.includes(r)).slice(0,30).map(r=><li id={`request-${r.id}`} key={r.id}><span className="font-medium">{r.operation}</span> · {r.state==="pending"?(r.revokedAtMs?"Connection revoked":"Expired"):r.state}<span className="block text-xs text-ink-3">{r.connectionName} · {new Date(r.createdAtMs).toLocaleString()}</span></li>)}</ul></details>}
  </div>;
}
