import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, writeTx, type Db } from "@/db/client";
import { mcpMutation, mcpRequest } from "@/db/schema/mcp";
import { writeAudit,expectedMaterialsFor } from "@/domain/inventory";
import { maintenanceOccurrence } from "@/db/schema/maintenance";
import { userContext } from "@/server/queries/settings/household";
import { publish, EVENT_TOPICS } from "@/server/events/outbox";
import { HttpError } from "@/server/api/handler";
import { assertConnection, hashSecret, type McpIdentity } from "./auth";
import { operations } from "./operations";

const revision = z.object({ kind:z.enum(["equipment","supplies","projects","plans","procedures","procedure_versions","providers"]), id:z.string().min(1).max(128), updatedAtMs:z.number().int().nonnegative() }).strict();
export const mutationInput = z.object({
  operation:z.string().min(1).max(80),
  arguments:z.record(z.string(),z.unknown()),
  requestKey:z.string().min(8).max(128),
  expectedRevision:revision.optional(),
}).strict();
const tables = { equipment:"asset", supplies:"part", projects:"project", plans:"maintenance_plan", procedures:"procedure", procedure_versions:"procedure_version", providers:"service_provider" } as const;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value!==null && typeof value==="object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
type Snapshot = { table:string; id:string; hash:string; label?:string };
function dependencies(kind:string,id:string):unknown {
  const {db,sqlite}=getDb();
  if(kind==="stock_dependencies")return {
    part:sqlite.prepare("SELECT * FROM part WHERE id=?").get(id),
    stock:sqlite.prepare("SELECT * FROM stock_transaction WHERE part_id=? ORDER BY id").all(id),
    lots:sqlite.prepare("SELECT * FROM part_lot WHERE part_id=? ORDER BY id").all(id),
    kit:sqlite.prepare("SELECT * FROM kit_component WHERE kit_part_id=? ORDER BY component_part_id").all(id),
  };
  if(kind==="occurrence_dependencies"){
    const occurrence=db.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id,id)).get();
    if(!occurrence)return null;
    const materials=expectedMaterialsFor(db,occurrence);
    return {plan:occurrence.planId?sqlite.prepare("SELECT * FROM maintenance_plan WHERE id=?").get(occurrence.planId):null,
      bookings:sqlite.prepare("SELECT * FROM service_booking WHERE occurrence_id=? ORDER BY id").all(id),
      materials,stocks:materials.map(m=>dependencies("stock_dependencies",m.partId))};
  }
  if(kind==="completion_dependencies")return sqlite.prepare("SELECT * FROM completion_material WHERE completion_id=? ORDER BY id").all(id).map(raw=>{
    const row=raw as {part_id:string};return {row,stock:dependencies("stock_dependencies",row.part_id)};
  });
  throw new HttpError(409,"invalid_saved_request");
}
const targetFields: Record<string,string> = { assetId:"asset", oldAssetId:"asset", partId:"part", projectId:"project", planId:"maintenance_plan", procedureId:"procedure", versionId:"procedure_version", occurrenceId:"maintenance_occurrence", completionId:"completion", providerId:"service_provider", transactionId:"stock_transaction" };
function snapshotTargets(args: Record<string,unknown>,operation:string): Snapshot[] {
  const {sqlite}=getDb(); const targets: Snapshot[]=[];
  function captureNested(value:unknown){
    if(Array.isArray(value)){value.forEach(captureNested);return;}
    if(!value||typeof value!=="object")return;
    for(const [key,child]of Object.entries(value)){
      const table=key==="partId"?"stock_dependencies":key==="occurrenceId"?"occurrence_dependencies":key==="completionId"?"completion_dependencies":null;
      if(table&&typeof child==="string")targets.push({table,id:child,hash:hashSecret(stable(dependencies(table,child)))});
      else captureNested(child);
    }
  }
  captureNested(args);
  if(operation==="projects.delete"&&typeof args.id==="string") {
    const row=sqlite.prepare("SELECT * FROM project WHERE id=?").get(args.id) as Record<string,unknown>|undefined;
    if(!row)throw new HttpError(404,"target_not_found");
    targets.push({table:"project",id:args.id,hash:hashSecret(stable(row)),label:String(row.name)});
  }
  if(operation==="documents.delete_service_record"&&typeof args.id==="string") {
    const row=sqlite.prepare("SELECT * FROM service_document WHERE id=?").get(args.id) as Record<string,unknown>|undefined;
    if(!row)throw new HttpError(404,"target_not_found");
    targets.push({table:"service_document",id:args.id,hash:hashSecret(stable(row)),label:String(row.document_no??row.kind)});
  }
  if(operation==="documents.unlink"&&typeof args.linkId==="string") {
    const row=sqlite.prepare("SELECT * FROM attachment_link WHERE id=?").get(args.linkId) as Record<string,unknown>|undefined;
    if(!row)throw new HttpError(404,"target_not_found");
    targets.push({table:"attachment_link",id:args.linkId,hash:hashSecret(stable(row)),label:"Document link"});
  }
  for (const [key,table] of Object.entries(targetFields)) if(typeof args[key]==="string") {
    const id=String(args[key]), row=sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new HttpError(404,"target_not_found",undefined,{field:key,id});
    const fields=row as Record<string,unknown>;
    targets.push({table,id,hash:hashSecret(stable(row)),label:String(fields.name??fields.title??fields.document_no??id)});
    if(table==="part") targets.push({table:"part_stock",id,hash:hashSecret(stable(sqlite.prepare("SELECT * FROM part_stock WHERE part_id=?").get(id)))});
  }
  if(Array.isArray(args.assetIds)) for(const id of args.assetIds) if(typeof id==="string") {
    const row=sqlite.prepare("SELECT * FROM asset WHERE id=?").get(id);
    if(!row) throw new HttpError(404,"target_not_found");
    targets.push({table:"asset",id,hash:hashSecret(stable(row)),label:String((row as {name?:string}).name??id)});
  }
  return targets;
}
function assertSnapshots(snapshots: Snapshot[]) {
  const allowed=new Set([...Object.values(targetFields),"part_stock","service_document","attachment_link"]);
  for(const s of snapshots) {
    if(["stock_dependencies","occurrence_dependencies","completion_dependencies"].includes(s.table)){
      if(hashSecret(stable(dependencies(s.table,s.id)))!==s.hash)throw new HttpError(409,"request_target_changed","A target changed since this request. Ask the agent to prepare a new request.");
      continue;
    }
    if(!allowed.has(s.table)) throw new HttpError(409,"invalid_saved_request");
    const row=getDb().sqlite.prepare(`SELECT * FROM ${s.table} WHERE ${s.table==="part_stock"?"part_id":"id"}=?`).get(s.id);
    if(hashSecret(stable(row))!==s.hash) throw new HttpError(409,"request_target_changed", "A target changed since this request. Ask the agent to prepare a new request.");
  }
}
function assertRevision(input: z.infer<typeof mutationInput>) {
  const needsRevision=/\.(patch|update|consumables|components|save_draft|publish)$/.test(input.operation);
  if(needsRevision&&!input.expectedRevision) throw new HttpError(409,"expected_revision_required");
  if(!input.expectedRevision) return;
  const r=input.expectedRevision;
  const targetByOperation:Record<string,{kind:string;field:string}>={
    "equipment.patch":{kind:"equipment",field:"assetId"},"equipment.consumables":{kind:"equipment",field:"assetId"},
    "supplies.update":{kind:"supplies",field:"partId"},"supplies.components":{kind:"supplies",field:"partId"},
    "projects.update":{kind:"projects",field:"projectId"},"plans.update":{kind:"plans",field:"planId"},
    "procedures.save_draft":{kind:"procedures",field:"procedureId"},"procedures.publish":{kind:"procedures",field:"procedureId"},
    "providers.update":{kind:"providers",field:"providerId"},
  };
  const expected=targetByOperation[input.operation];
  if(expected&&(r.kind!==expected.kind||input.arguments[expected.field]!==r.id)) throw new HttpError(400,"revision_target_mismatch");
  const row=getDb().sqlite.prepare(`SELECT updated_at_ms FROM ${tables[r.kind]} WHERE id=?`).get(r.id) as {updated_at_ms:number}|undefined;
  if(!row) throw new HttpError(404,"not_found");
  if(row.updated_at_ms!==r.updatedAtMs) throw new HttpError(409,"revision_conflict",undefined,{currentUpdatedAtMs:row.updated_at_ms});
  const ids=Object.entries(input.arguments).filter(([k])=>k.endsWith("Id")).map(([,v])=>v);
  if(!ids.includes(r.id)) throw new HttpError(400,"revision_target_mismatch");
}
function audit(tx:Db,identity:McpIdentity,operation:string,id:string) {
  writeAudit(tx,userContext({user:{id:identity.userId}},tx),{entityTable:"mcp_connection",entityId:identity.connectionId,
    action:"mcp_operation",summary:`${identity.name}: ${operation}`,requestId:id});
}
function changed(tx:Db,operation:string) {
  publish(tx,[{topic:EVENT_TOPICS.taskChanged,entityKey:`mcp:${operation}`,payload:{source:"mcp",operation}},
    {topic:EVENT_TOPICS.inventoryChanged,entityKey:`mcp:${operation}`,payload:{source:"mcp",operation}}]);
}

/** Replay, domain writes, audit and persisted events share the same BEGIN IMMEDIATE. */
export function mutate(identity:McpIdentity,raw:unknown,pending=false) {
  const input=mutationInput.parse(raw),op=operations[input.operation];
  if(!op) throw new HttpError(404,"unknown_operation");
  if(op.consequential!==pending) throw new HttpError(400,pending?"use_author_tool":"approval_required");
  let paths:string[]=[];
  const data=writeTx(getDb().db,tx=>{
    const current=assertConnection(tx,identity.connectionId,pending?"request_actions":"author",Date.now(),identity.credentialHash);
    const payloadHash=hashSecret(stable(input));
    const previous=tx.select().from(mcpMutation).where(and(eq(mcpMutation.connectionId,current.connectionId),eq(mcpMutation.requestKey,input.requestKey))).get();
    if(previous) {
      if(previous.payloadHash!==payloadHash) throw new HttpError(409,"request_key_conflict");
      return JSON.parse(previous.resultJson) as Record<string,unknown>;
    }
    assertRevision(input);
    // Parse before storing: requests contain the exact validated payload the browser will approve.
    const args=op.input.parse(input.arguments) as Record<string,unknown>;
    // Show the exact stock deductions in the approval, including domain defaults omitted by the AI.
    if(pending&&input.operation==="maintenance.complete"&&args.materials===undefined){
      const occurrence=tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id,String(args.occurrenceId))).get();
      if(!occurrence)throw new HttpError(404,"target_not_found");
      args.materials=expectedMaterialsFor(tx,occurrence).map(line=>({partId:line.partId,expectedQtyMilli:line.qtyMilli,actualQtyMilli:line.qtyMilli}));
    }
    const id=randomUUID(); let result:Record<string,unknown>;
    if(pending) {
      const now=Date.now();
      tx.insert(mcpRequest).values({id,connectionId:current.connectionId,operation:input.operation,
        payloadJson:JSON.stringify({arguments:args,expectedRevision:input.expectedRevision,snapshots:snapshotTargets(args,input.operation)}),
        summary:`${current.name}: ${op.description}`,createdAtMs:now,expiresAtMs:now+30*60_000}).run();
      result={requestId:id,status:"pending_approval",expiresAtMs:now+30*60_000,href:`/settings/ai-connections#request-${id}`};
      publish(tx,[{topic:EVENT_TOPICS.alertChanged,entityKey:`mcp:${id}`,payload:{requestId:id,status:"pending"}}]);
    } else {
      const executed=op.run(args,{user:{id:current.userId}}); paths=executed.paths;
      if(input.expectedRevision) {
        const r=input.expectedRevision;
        getDb().sqlite.prepare(`UPDATE ${tables[r.kind]} SET updated_at_ms=MAX(updated_at_ms,?),updated_by=? WHERE id=?`)
          .run(Math.max(Date.now(),r.updatedAtMs+1),current.userId,r.id);
      }
      result={status:"applied",operation:input.operation,result:executed.data};
      changed(tx,input.operation);
    }
    audit(tx,current,input.operation,id);
    tx.insert(mcpMutation).values({id,connectionId:current.connectionId,requestKey:input.requestKey,payloadHash,resultJson:JSON.stringify(result),createdAtMs:Date.now()}).run();
    return result;
  });
  return {data,paths};
}

/** Called only by the fresh-session browser action, never exposed as an MCP tool. */
export function decideRequest(requestId:string,userId:string,decision:"approve"|"reject") {
  let paths:string[]=[];
  const data=writeTx(getDb().db,tx=>{
    const request=tx.select().from(mcpRequest).where(eq(mcpRequest.id,requestId)).get();
    if(!request) throw new HttpError(404,"not_found");
    if(request.state!=="pending") return {state:request.state};
    const now=Date.now();
    if(request.expiresAtMs<=now) {
      tx.update(mcpRequest).set({state:"expired",decidedAtMs:now}).where(eq(mcpRequest.id,requestId)).run();
      return {state:"expired"};
    }
    const identity=assertConnection(tx,request.connectionId,"request_actions",now);
    const op=operations[request.operation]; if(!op?.consequential) throw new HttpError(409,"operation_no_longer_available");
    let result:unknown=null;
    if(decision==="approve") {
      const saved=JSON.parse(request.payloadJson) as {arguments:Record<string,unknown>;snapshots:Snapshot[];expectedRevision?:z.infer<typeof revision>};
      assertSnapshots(saved.snapshots);
      assertRevision({operation:request.operation,arguments:saved.arguments,expectedRevision:saved.expectedRevision,requestKey:request.id});
      const executed=op.run(saved.arguments,{user:{id:userId}}); result=executed.data; paths=executed.paths;
      changed(tx,request.operation);
    }
    const state=decision==="approve"?"approved":"rejected";
    tx.update(mcpRequest).set({state,decidedAtMs:now,decidedBy:userId,resultJson:JSON.stringify(result)}).where(eq(mcpRequest.id,requestId)).run();
    audit(tx,{...identity,userId},`${decision}:${request.operation}`,request.id);
    publish(tx,[{topic:EVENT_TOPICS.alertChanged,entityKey:`mcp:${request.id}`,payload:{requestId:request.id,status:state}}]);
    return {state,result};
  });
  return {data,paths};
}

export function requestStatus(identity:McpIdentity,requestId:string) {
  assertConnection(getDb().db,identity.connectionId,"read",Date.now(),identity.credentialHash);
  const row=getDb().db.select().from(mcpRequest).where(and(eq(mcpRequest.id,requestId),eq(mcpRequest.connectionId,identity.connectionId))).get();
  if(!row) throw new HttpError(404,"not_found");
  return {requestId:row.id,status:row.state==="pending"&&row.expiresAtMs<=Date.now()?"expired":row.state,
    result:row.resultJson?JSON.parse(row.resultJson):null,href:`/settings/ai-connections#request-${row.id}`};
}
