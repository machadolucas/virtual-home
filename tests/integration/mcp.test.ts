import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { testDb,seedUser } from "../helpers/db";
import { setDbForTests,writeTx,type DbHandle } from "@/db/client";
import { asset,stockTransaction,attachment } from "@/db/schema";
import { mcpConnection,mcpMutation,mcpRequest } from "@/db/schema/mcp";
import { createConnection,rotateConnectionToken,authenticateMcp,assertConnection,type McpIdentity } from "@/server/mcp/auth";
import { mutate,decideRequest,requestStatus } from "@/server/mcp/mutations";
import { entityKinds,searchRecords,getRecord,listRelated,recordHref } from "@/server/mcp/read";
import { readUrlState } from "@/house/store/urlSync";
import { describeOperations } from "@/server/mcp/operations";
import { POST,GET,PUT } from "@/app/mcp/route";

let handle:DbHandle,actor:string,identity:McpIdentity,token:string;
beforeEach(()=>{handle=testDb();setDbForTests(handle);actor=seedUser(handle,{username:"member",name:"Synthetic Member"}).id;
  const c=createConnection(handle.db,actor,{name:"Test agent",scopes:["read","author","request_actions"]});token=c.token;identity=authenticateMcp(handle.db,`Bearer ${token}`);});
afterEach(()=>{setDbForTests(null);handle.close();});
function write(operation:string,args:Record<string,unknown>,extra:Record<string,unknown>={}){return mutate(identity,{operation,arguments:args,requestKey:randomUUID(),...extra}).data;}
function equipment(name="Fixture appliance",extra:Record<string,unknown>={}){
  const r=write("equipment.create",{name,category:"appliance",...extra});return (r.result as {assetId:string}).assetId;
}
function revision(id:string){return {kind:"equipment",id,updatedAtMs:handle.db.select().from(asset).where(eq(asset.id,id)).get()!.updatedAtMs};}
function http(method:string,body?:unknown,headers:Record<string,string>={}){return new Request("http://localhost:3010/mcp",{method,headers:{host:"localhost:3010",authorization:`Bearer ${token}`,accept:"application/json, text/event-stream","content-type":"application/json",...headers},...(body?{body:JSON.stringify(body)}:{})});}

describe("MCP access boundary",()=>{
  it("rotates tokens atomically while preserving grants and rejecting old in-flight credentials",()=>{
    const before=handle.db.select().from(mcpConnection).where(eq(mcpConnection.id,identity.connectionId)).get()!;
    const rotated=rotateConnectionToken(handle.db,identity.connectionId);
    expect(()=>authenticateMcp(handle.db,`Bearer ${token}`)).toThrow("invalid_mcp_token");
    expect(()=>write("equipment.create",{name:"Stale credential",category:"appliance"})).toThrow("invalid_mcp_token");
    const current=authenticateMcp(handle.db,`Bearer ${rotated.token}`);
    expect(current.connectionId).toBe(identity.connectionId);expect(current.scopes).toEqual(identity.scopes);
    const after=handle.db.select().from(mcpConnection).where(eq(mcpConnection.id,identity.connectionId)).get()!;
    expect(after).toMatchObject({name:before.name,userId:before.userId,expiresAtMs:before.expiresAtMs,scopesJson:before.scopesJson});
    expect(after.tokenHash).not.toBe(before.tokenHash);expect(JSON.stringify(after)).not.toContain(rotated.token);
  });
  it("stores only a token hash and applies explicit scopes",()=>{
    const row=handle.db.select().from(mcpConnection).where(eq(mcpConnection.id,identity.connectionId)).get()!;
    expect(row.tokenHash).toHaveLength(64);expect(JSON.stringify(row)).not.toContain(token);
    const read=createConnection(handle.db,actor,{name:"Read only",scopes:["read"]});const r=authenticateMcp(handle.db,`Bearer ${read.token}`);
    expect(()=>mutate(r,{operation:"equipment.create",arguments:{name:"X",category:"appliance"},requestKey:randomUUID()})).toThrow("scope_required");
  });
  it("enforces immediate expiry and revocation even with a previously authenticated identity",()=>{
    writeTx(handle.db,tx=>tx.update(mcpConnection).set({revokedAtMs:Date.now()}).where(eq(mcpConnection.id,identity.connectionId)).run());
    expect(()=>write("equipment.create",{name:"X",category:"appliance"})).toThrow("connection_expired_or_revoked");
    const c=createConnection(handle.db,actor,{name:"Expired",scopes:["read"]},1);
    expect(()=>authenticateMcp(handle.db,`Bearer ${c.token}`)).toThrow("connection_expired_or_revoked");
    expect(()=>assertConnection(handle.db,identity.connectionId,"read")).toThrow();
  });
  it("rejects missing auth, hostile origins and hosts, oversized bodies",async()=>{
    expect((await POST(http("POST",{}, {authorization:""}))).status).toBe(401);
    expect((await POST(http("POST",{}, {origin:"https://attacker.example"}))).status).toBe(403);
    expect((await POST(http("POST",{}, {host:"attacker.example"}))).status).toBe(403);
    expect((await POST(http("POST",{padding:"x".repeat(128*1024)}))).status).toBe(413);
    expect((await GET(http("GET"))).status).toBe(405);
  });
  it("initializes the real Streamable HTTP transport and lists compact tools",async()=>{
    const init=await POST(http("POST",{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"test",version:"1"}}}));
    expect(init.status).toBe(200);expect((await init.json()).result.serverInfo.name).toBe("virtual-home");
    const response=await POST(http("POST",{jsonrpc:"2.0",id:2,method:"tools/list",params:{}}));
    const result=await response.json();expect(result.result.tools.map((t:{name:string})=>t.name)).toContain("request_action");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("connects the real stdio bridge through HTTP without printing its credential",async()=>{
    const proxy=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(","):value);
      headers.set("host","localhost:3010");
      const request=new Request("http://localhost:3010/mcp",{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
      const response=await(req.method==="POST"?POST(request):GET(request));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve,reject)=>{proxy.once("error",reject);proxy.listen(0,"127.0.0.1",resolve);});
    const address=proxy.address();if(!address||typeof address==="string")throw new Error("no test port");
    const dir=await mkdtemp(path.join(os.tmpdir(),"vh-mcp-bridge-")),config=path.join(dir,"connection.json");
    await writeFile(config,JSON.stringify({url:`http://127.0.0.1:${address.port}/mcp`,token}),{mode:0o600});
    const child=spawn(process.execPath,[path.resolve("scripts/mcp-bridge.mjs")],{env:{...process.env,VH_MCP_CONFIG:config},stdio:["pipe","pipe","pipe"]});
    let output="",stderr="";child.stderr.on("data",chunk=>{stderr+=String(chunk);});
    try{
      const initialized=new Promise<Record<string,unknown>>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`bridge did not initialize: ${stderr}`)),8000);
        child.once("exit",code=>{clearTimeout(timer);reject(new Error(`bridge exited ${code}: ${stderr}`));});
        child.stdout.on("data",chunk=>{output+=String(chunk);const line=output.split("\n").find(l=>l.trim());if(line){try{const parsed=JSON.parse(line);if(parsed.id===1){clearTimeout(timer);resolve(parsed);}}catch{}}});
      });
      child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"stdio-test",version:"1"}}})+"\n");
      const response=await initialized;expect(response).toHaveProperty("result.serverInfo.name","virtual-home");
      expect(output).not.toContain(token);expect(stderr).not.toContain(token);
    }finally{child.kill("SIGTERM");proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
  });
});

describe("MCP authoring and bounded reads",()=>{
  it("uses supported exact record links and the actual House selection codec",()=>{
    for(const [kind,selectionKind]of [["routes","route"],["annotations","annotation"]]as const){
      const href=recordHref(kind,{id:"fixture-123"})!;
      expect(readUrlState(href.slice(href.indexOf("?"))).selection).toEqual({kind:selectionKind,id:"fixture-123"});
    }
    const location=recordHref("locations",{id:"database-id",kind:"room",model_node_id:"r-kitchen"})!;
    expect(readUrlState(location.slice(location.indexOf("?"))).selection).toEqual({kind:"room",id:"r-kitchen"});
    expect(recordHref("locations",{id:"unmapped",kind:"room"})).toBeNull();
    expect(recordHref("endpoints",{id:"endpoint"})).toBeNull();
    expect(recordHref("bookings",{id:"booking",occurrence_id:"task"})).toBe("/tasks/task");
    expect(recordHref("bookings",{id:"booking",provider_id:"provider"})).toBe("/providers/provider#booking-booking");
    expect(recordHref("systems",{id:"system"})).toBe("/equipment/systems#system");
    expect(recordHref("storage",{id:"bin",name:"Tool cupboard"})).toBe("/supplies?filter=all&q=Tool%20cupboard");
  });
  it("reads every supported dataset using actual migrations",()=>{
    for(const kind of entityKinds) expect(searchRecords(handle,{kind}).items).toEqual([]);
  });
  it("provides bounded relationship pages for every supported family",()=>{
    const pairs=["locations.equipment","locations.children","equipment.plans","equipment.tasks","equipment.history","equipment.consumables","equipment.placements","equipment.systems","equipment.documents","supplies.stock_movements","supplies.suppliers","supplies.equipment","procedures.versions","projects.links","providers.bookings","providers.documents","plans.tasks","tasks.history","routes.points","documents.links","systems.equipment"];
    for(const pair of pairs){const [kind,relation]=pair.split(".");expect(listRelated(handle,{kind,relation,id:"missing"}).items).toEqual([]);}
    const created=write("procedures.create",{title:"Fixture procedure"});
    const id=String((created.result as {procedureId:string}).procedureId);
    expect(getRecord(handle,{kind:"procedures",id,include:["procedure"]}).record.versions).toBeInstanceOf(Array);
  });
  it("creates, discovers and patches equipment without clearing omitted fields",()=>{
    const id=equipment("Fixture appliance",{manufacturer:"Fixture maker",isVirtual:true,notes:"Existing instructions"});
    const old=revision(id);
    write("equipment.patch",{assetId:id,patch:{modelName:"Model B"}},{expectedRevision:old});
    const row=handle.db.select().from(asset).where(eq(asset.id,id)).get()!;
    expect(row.manufacturer).toBe("Fixture maker");expect(row.notes).toBe("Existing instructions");expect(row.isVirtual).toBe(true);
    expect(row.modelName).toBe("Model B");expect(row.updatedAtMs).toBeGreaterThan(old.updatedAtMs);
    write("equipment.patch",{assetId:id,patch:{notes:null}},{expectedRevision:revision(id)});
    expect(getRecord(handle,{kind:"equipment",id}).record.notes).toBeNull();
    expect(searchRecords(handle,{kind:"equipment",query:"Fixture"}).items).toHaveLength(1);
  });
  it("rejects stale/mismatched revisions and unrecognized patch fields",()=>{
    const id=equipment(),old=revision(id);
    write("equipment.patch",{assetId:id,patch:{name:"Changed"}},{expectedRevision:old});
    expect(()=>write("equipment.patch",{assetId:id,patch:{name:"Stale"}},{expectedRevision:old})).toThrow("revision_conflict");
    expect(()=>write("equipment.patch",{assetId:id,patch:{manufacturer:"Missing revision"}})).toThrow("expected_revision_required");
    expect(()=>write("equipment.patch",{assetId:id,patch:{misspelled:"oops"}},{expectedRevision:revision(id)})).toThrow();
  });
  it("atomically replays an identical write and rejects key reuse for a different payload",()=>{
    const raw={operation:"equipment.create",arguments:{name:"Once",category:"appliance"},requestKey:randomUUID()};
    const first=mutate(identity,raw).data;expect(mutate(identity,raw).data).toEqual(first);
    expect(handle.db.select().from(asset).all()).toHaveLength(1);
    expect(()=>mutate(identity,{...raw,arguments:{name:"Twice",category:"appliance"}})).toThrow("request_key_conflict");
  });
  it("rolls back the domain write when replay persistence fails",()=>{
    handle.sqlite.exec("CREATE TRIGGER test_replay_failure BEFORE INSERT ON mcp_mutation BEGIN SELECT RAISE(ABORT,'forced replay failure'); END");
    expect(()=>equipment()).toThrow("forced replay failure");
    expect(handle.db.select().from(asset).all()).toHaveLength(0);expect(handle.db.select().from(mcpMutation).all()).toHaveLength(0);
  });
  it("paginates without duplicates, binds cursors to filters and escapes query wildcards",()=>{
    equipment("One");equipment("Two");equipment("Three");
    const page=searchRecords(handle,{kind:"equipment",limit:2});expect(page.items).toHaveLength(2);expect(page.nextCursor).not.toBeNull();
    const next=searchRecords(handle,{kind:"equipment",limit:2,cursor:page.nextCursor});expect(next.items).toHaveLength(1);
    expect(new Set([...page.items,...next.items].map(r=>r.id)).size).toBe(3);
    expect(()=>searchRecords(handle,{kind:"equipment",query:"changed",cursor:page.nextCursor})).toThrow("invalid_cursor");
    expect(searchRecords(handle,{kind:"equipment",query:"%"}).items).toHaveLength(0);
  });
  it("exposes precise operation schemas on demand rather than in every tools list",()=>{
    const catalog=describeOperations();expect(catalog.find(o=>o.name==="equipment.patch")?.approvalRequired).toBe(false);
    expect(catalog.every(o=>!("inputSchema"in o))).toBe(true);
    expect(describeOperations(["equipment.patch"])[0]).toHaveProperty("inputSchema");
  });
  it("preserves omitted supply, provider, project and plan fields during patches",()=>{
    const p=write("supplies.create",{name:"Filters",spec:"Keep specification",trackingMode:"discrete",unit:"pcs",tracksLots:true});const partId=(p.result as {partId:string}).partId;
    const s=getRecord(handle,{kind:"supplies",id:partId}).record;
    write("supplies.update",{partId,patch:{name:"Renamed filters"}},{expectedRevision:{kind:"supplies",id:partId,updatedAtMs:s.updatedAtMs}});
    const saved=getRecord(handle,{kind:"supplies",id:partId}).record;expect(saved.spec).toBe("Keep specification");expect(saved.tracksLots).toBe(1);
    const provider=write("providers.create",{name:"Fixture provider",phone:"123",notes:"Keep note"});const providerId=(provider.result as {providerId:string}).providerId;
    const v=getRecord(handle,{kind:"providers",id:providerId}).record;
    write("providers.update",{providerId,patch:{name:"Renamed provider"}},{expectedRevision:{kind:"providers",id:providerId,updatedAtMs:v.updatedAtMs}});
    expect(getRecord(handle,{kind:"providers",id:providerId}).record.phone).toBe("123");
    const project=write("projects.create",{name:"Fixture project",kind:"installation",status:"in_progress",notes:"Keep project notes"});const projectId=(project.result as {id:string}).id;
    const j=getRecord(handle,{kind:"projects",id:projectId}).record;
    write("projects.update",{projectId,patch:{name:"Renamed project"}},{expectedRevision:{kind:"projects",id:projectId,updatedAtMs:j.updatedAtMs}});
    expect(getRecord(handle,{kind:"projects",id:projectId}).record.status).toBe("in_progress");
    const assetId=equipment();
    const plan=write("plans.create",{plan:{target:`asset:${assetId}`,title:"Original plan",description:"Keep instructions",scheduleFormKind:"interval_from_completion",rule:{v:1,kind:"interval_from_completion",every:6,unit:"month"},assignmentMode:"shared",priority:"normal",requiresProfessional:false,materials:[],status:"active"},seed:{kind:"ask_later"}});
    const planId=(plan.result as {planId:string}).planId;const b=getRecord(handle,{kind:"plans",id:planId}).record;
    write("plans.update",{planId,patch:{title:"Renamed plan"}},{expectedRevision:{kind:"plans",id:planId,updatedAtMs:b.updatedAtMs}});
    const after=getRecord(handle,{kind:"plans",id:planId}).record;expect(after.description).toBe("Keep instructions");expect(after.recurrenceJson).toBe(b.recurrenceJson);expect(after.status).toBe("paused");
  });
  it("enforces document/service-document revisions and authors textual reports",()=>{
    const assetId=equipment();const created=write("documents.service_record",{kind:"report",notes:"Installation instructions",assetId,attachmentId:null,providerId:null,bookingId:null,completionId:null});
    const id=(created.result as {id:string}).id;const original=getRecord(handle,{kind:"service_documents",id}).record;
    expect(original.notes).toBe("Installation instructions");
    expect(()=>write("documents.service_record",{id,kind:"report",notes:"No revision",assetId,attachmentId:null,providerId:null,bookingId:null,completionId:null})).toThrow("document_changed");
    write("documents.service_record",{id,expectedUpdatedAtMs:original.updatedAtMs,kind:"report",notes:"Updated installation instructions",assetId,attachmentId:null,providerId:null,bookingId:null,completionId:null});
    expect(getRecord(handle,{kind:"service_documents",id}).record.notes).toBe("Updated installation instructions");
    const current=getRecord(handle,{kind:"service_documents",id}).record;
    write("documents.patch_service_record",{id,expectedUpdatedAtMs:current.updatedAtMs,patch:{documentNo:"DOC-1"}});
    const patched=getRecord(handle,{kind:"service_documents",id}).record;expect(patched.notes).toBe("Updated installation instructions");expect(patched.assetId).toBe(assetId);
  });
});

describe("MCP binary uploads",()=>{
  const pdf="%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
  function upload(body:string|ReadableStream<Uint8Array>,secret=token){return new Request("http://localhost:3010/mcp",{method:"PUT",headers:{host:"localhost:3010",authorization:`Bearer ${secret}`,"content-type":"application/octet-stream","x-vh-filename":"fixture.pdf"},body,...(typeof body!=="string"?{duplex:"half"}:{})} as RequestInit);}
  it("stores sniffed bytes with scope enforcement, deduplication and safe metadata",async()=>{
    const ro=createConnection(handle.db,actor,{name:"Read upload",scopes:["read"]});expect((await PUT(upload(pdf,ro.token))).status).toBe(403);
    const response=await PUT(upload(pdf));expect(response.status).toBe(201);const first=await response.json();expect(first.mime).toBe("application/pdf");expect(first.storagePath).toBeUndefined();
    const repeated=await PUT(upload(pdf));expect(repeated.status).toBe(200);expect((await repeated.json()).id).toBe(first.id);
    expect(handle.db.select().from(attachment).all()).toHaveLength(1);
  });
  it("rechecks revocation after streaming before committing attachment metadata",async()=>{
    let step=0;const encoder=new TextEncoder();
    const stream=new ReadableStream<Uint8Array>({pull(controller){if(step++===0){controller.enqueue(encoder.encode(pdf.slice(0,10)));return;}
      writeTx(handle.db,tx=>tx.update(mcpConnection).set({revokedAtMs:Date.now()}).where(eq(mcpConnection.id,identity.connectionId)).run());controller.enqueue(encoder.encode(pdf.slice(10)));controller.close();}});
    const response=await PUT(upload(stream));expect(response.status).toBe(401);expect(handle.db.select().from(attachment).all()).toHaveLength(0);
  });
});

describe("consequential action approval",()=>{
  it("invalidates completion approval when plan materials or nested material stock change",()=>{
    const assetId=equipment();
    const supply=write("supplies.create",{name:"Fixture material",trackingMode:"discrete",unit:"pcs"});const partId=String((supply.result as {partId:string}).partId);
    const created=write("plans.create",{plan:{target:`asset:${assetId}`,title:"Fixture maintenance",scheduleFormKind:"interval_from_completion",rule:{v:1,kind:"interval_from_completion",every:6,unit:"month"},assignmentMode:"shared",priority:"normal",requiresProfessional:false,materials:[],status:"active"},seed:{kind:"start_now"}});
    const planId=String((created.result as {planId:string}).planId);
    const task=handle.sqlite.prepare("SELECT id FROM maintenance_occurrence WHERE plan_id=?").get(planId) as {id:string};
    const prepare=(materials?:unknown[])=>mutate(identity,{operation:"maintenance.complete",arguments:{occurrenceId:task.id,requestId:randomUUID(),completedAt:{mode:"now"},...(materials?{materials}:{})},requestKey:randomUUID()},true).data;
    const implicit=prepare();const row=getRecord(handle,{kind:"plans",id:planId}).record;
    write("plans.update",{planId,patch:{materials:[{partId,qtyMilli:1000,isRequired:true}]}},{expectedRevision:{kind:"plans",id:planId,updatedAtMs:row.updatedAtMs}});
    expect(handle.db.select().from(stockTransaction).all()).toHaveLength(0);
    expect(()=>decideRequest(String(implicit.requestId),actor,"approve")).toThrow("A target changed since this request");
    const explicit=prepare([{partId,actualQtyMilli:1000}]);
    const purchase=mutate(identity,{operation:"stock.purchase",arguments:{partId,qtyMilli:2000},requestKey:randomUUID()},true).data;
    decideRequest(String(purchase.requestId),actor,"approve");
    expect(()=>decideRequest(String(explicit.requestId),actor,"approve")).toThrow("A target changed since this request");
    expect(handle.sqlite.prepare("SELECT count(*) AS n FROM completion").get()).toEqual({n:0});
  });
  it("requires approval for report deletion and refuses to delete a subsequently edited report",()=>{
    const assetId=equipment();
    const saved=write("documents.service_record",{kind:"report",notes:"Installation instructions",assetId,attachmentId:null,providerId:null,bookingId:null,completionId:null});
    const id=String((saved.result as {id:string}).id);
    expect(()=>write("documents.delete_service_record",{id})).toThrow("approval_required");
    const prepare=()=>mutate(identity,{operation:"documents.delete_service_record",arguments:{id},requestKey:randomUUID()},true).data;
    const stale=prepare();
    const current=getRecord(handle,{kind:"service_documents",id}).record;
    write("documents.patch_service_record",{id,expectedUpdatedAtMs:current.updatedAtMs,patch:{notes:"Revised instructions"}});
    expect(()=>decideRequest(String(stale.requestId),actor,"approve")).toThrow("A target changed since this request");
    const ready=prepare();
    expect(getRecord(handle,{kind:"service_documents",id}).record.notes).toBe("Revised instructions");
    expect(decideRequest(String(ready.requestId),actor,"approve").data.state).toBe("approved");
    expect(searchRecords(handle,{kind:"service_documents"}).items).toHaveLength(0);
    expect(decideRequest(String(ready.requestId),actor,"approve").data.state).toBe("approved");
  });
  it("snapshots project deletion targets using their actual id field",()=>{
    const created=write("projects.create",{name:"Fixture project",kind:"installation"});
    const id=String((created.result as {id:string}).id);
    const request=mutate(identity,{operation:"projects.delete",arguments:{id},requestKey:randomUUID()},true).data;
    const row=getRecord(handle,{kind:"projects",id}).record;
    write("projects.update",{projectId:id,patch:{notes:"New work"}},{expectedRevision:{kind:"projects",id,updatedAtMs:row.updatedAtMs}});
    expect(()=>decideRequest(String(request.requestId),actor,"approve")).toThrow("A target changed since this request");
    expect(searchRecords(handle,{kind:"projects"}).items).toHaveLength(1);
  });
  it("prepares immutable stock movements without execution, then applies exactly once",()=>{
    const created=write("supplies.create",{name:"Fixture filters",trackingMode:"discrete",unit:"pcs"});const partId=(created.result as {partId:string}).partId;
    const prepared=mutate(identity,{operation:"stock.purchase",arguments:{partId,qtyMilli:2000},requestKey:randomUUID()},true).data;
    const id=String(prepared.requestId);expect(handle.db.select().from(stockTransaction).all()).toHaveLength(0);
    expect(requestStatus(identity,id).status).toBe("pending");
    expect(decideRequest(id,actor,"approve").data.state).toBe("approved");
    expect(decideRequest(id,actor,"approve").data.state).toBe("approved");
    expect(handle.db.select().from(stockTransaction).all()).toHaveLength(1);
  });
  it("rejects direct consequential execution and blocks changed/revoked approval targets",()=>{
    const id=equipment();
    expect(()=>write("equipment.retire",{assetId:id,status:"retired",removedOn:"2026-09-12"})).toThrow("approval_required");
    const req=mutate(identity,{operation:"equipment.retire",arguments:{assetId:id,status:"retired",removedOn:"2026-09-12"},requestKey:randomUUID()},true).data;
    write("equipment.patch",{assetId:id,patch:{notes:"Changed since request"}},{expectedRevision:revision(id)});
    expect(()=>decideRequest(String(req.requestId),actor,"approve")).toThrow("A target changed since this request");
    writeTx(handle.db,tx=>tx.update(mcpConnection).set({revokedAtMs:Date.now()}).where(eq(mcpConnection.id,identity.connectionId)).run());
    expect(()=>decideRequest(String(req.requestId),actor,"approve")).toThrow("connection_expired_or_revoked");
    expect(handle.db.select().from(asset).where(eq(asset.id,id)).get()!.status).toBe("installed");
  });
  it("expires or rejects requests without applying their writes",()=>{
    const id=equipment();const req=mutate(identity,{operation:"equipment.retire",arguments:{assetId:id,status:"retired",removedOn:"2026-09-12"},requestKey:randomUUID()},true).data;
    const requestId=String(req.requestId);
    writeTx(handle.db,tx=>tx.update(mcpRequest).set({expiresAtMs:1}).where(eq(mcpRequest.id,requestId)).run());
    expect(decideRequest(requestId,actor,"approve").data.state).toBe("expired");
    expect(handle.db.select().from(asset).where(eq(asset.id,id)).get()!.status).toBe("installed");
  });
});
