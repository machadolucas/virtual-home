import "server-only";
import { z } from "zod";
import type { DbHandle } from "@/db/client";
import { HttpError } from "@/server/api/handler";
import { readEquipmentHaControls } from "@/server/ha/control";
import { writeUrlState,decodeSelection } from "@/house/store/urlSync";
import { hashSecret } from "./auth";

/** SQL identifiers come only from this source-controlled allowlist, never from tool arguments. */
const datasets = {
  equipment: { table: "asset", label: "name", summary: ["category", "status", "location_id", "manufacturer", "model_name"], href: "/equipment/" },
  locations: { table: "location", label: "name", summary: ["kind", "parent_id", "model_node_id"], href: "/house" },
  systems: { table: "system", label: "name", summary: ["kind", "status"], href: "/equipment/systems#" },
  supplies: { table: "part", label: "name", summary: ["spec", "unit", "tracking_mode", "archived_at_ms"], href: "/supplies/" },
  storage: { table: "storage_place", label: "name", summary: ["location_id"], href: "/supplies" },
  procedures: { table: "procedure", label: "title", summary: ["summary", "current_version_id", "archived_at_ms"], href: "/procedures/" },
  plans: { table: "maintenance_plan", label: "title", summary: ["status", "schedule_kind", "asset_id", "location_id"], href: "/plans/" },
  tasks: { table: "maintenance_occurrence", label: "title", summary: ["status", "due_date", "asset_id", "priority"], href: "/tasks/" },
  projects: { table: "project", label: "name", summary: ["kind", "status", "summary"], href: "/projects/" },
  providers: { table: "service_provider", label: "name", summary: ["trade", "is_preferred", "archived_at_ms"], href: "/providers/" },
  bookings: { table: "service_booking", label: "id", summary: ["provider_id", "occurrence_id", "status", "scheduled_local_date"], href: "/providers" },
  documents: { table: "attachment", label: "original_filename", summary: ["kind", "mime", "byte_size", "caption"], href: "/documents/" },
  service_documents: { table: "service_document", label: "id", summary: ["kind", "document_no", "asset_id", "provider_id", "notes"], href: "/documents/" },
  routes: { table: "infra_route", label: "name", summary: ["medium", "lifecycle"], href: "/house" },
  endpoints: { table: "infra_endpoint", label: "name", summary: ["location_id", "asset_id"], href: "/house" },
  annotations: { table: "annotation", label: "title", summary: ["kind", "body"], href: "/house" },
  history: { table: "completion", label: "id", summary: ["occurrence_id", "asset_id", "completed_local_date", "outcome", "notes"], href: "/history?completion=" },
} as const;
export const entityKinds = Object.keys(datasets) as [keyof typeof datasets, ...(keyof typeof datasets)[]];
export const entityKind = z.enum(entityKinds);
export type EntityKind = z.infer<typeof entityKind>;
export const searchInput = z.object({
  kind: entityKind,
  query: z.string().trim().max(200).default(""),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
  includeArchived: z.boolean().default(false),
}).strict();
export const getInput = z.object({ kind: entityKind, id: z.string().min(1).max(128),
  include: z.array(z.enum(["location", "documents", "placements", "maintenance", "consumables", "procedure", "links", "controls"])).max(8).default([]),
}).strict();
function camel(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !["storage_path", "sha256", "created_by", "updated_by"].includes(key))
    .map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]));
}
function compact(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(camel(row)).filter(([, v]) => v !== null)
    .map(([k,v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 297)}…` : v]));
}
/** Only supported UI destinations; a record without a dedicated view has no invented deep link. */
export function recordHref(kind:EntityKind,row:Record<string,unknown>):string|null {
  const id=encodeURIComponent(String(row.id));
  if(kind==="routes"||kind==="annotations"){
    const selection=decodeSelection(`${kind==="routes"?"route":"annotation"}:${row.id}`);
    return selection?`/house${writeUrlState("",{selection})}`:null;
  }
  if(kind==="locations"){
    const selection=typeof row.model_node_id==="string"?decodeSelection(`${row.kind}:${row.model_node_id}`):null;
    return selection?`/house${writeUrlState("",{selection})}`:null;
  }
  if(kind==="endpoints")return null;
  if(kind==="bookings")return row.occurrence_id?`/tasks/${encodeURIComponent(String(row.occurrence_id))}`:row.provider_id?`/providers/${encodeURIComponent(String(row.provider_id))}#booking-${id}`:null;
  if(kind==="storage")return `/supplies?filter=all&q=${encodeURIComponent(String(row.name))}`;
  return `${datasets[kind].href}${id}`;
}

export function searchRecords(handle: DbHandle, raw: unknown) {
  const input = searchInput.parse(raw), ds = datasets[input.kind];
  const fingerprint = hashSecret(JSON.stringify([input.kind, input.query, input.includeArchived])).slice(0, 16);
  let after = "";
  if (input.cursor) {
    try { const c = z.object({ after: z.string().max(128), fingerprint: z.literal(fingerprint) }).parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString())); after = c.after; }
    catch { throw new HttpError(400, "invalid_cursor"); }
  }
  const columns = ["id", ds.label, ...ds.summary, "updated_at_ms"].filter((v,i,a) => a.indexOf(v)===i);
  const predicates = ["id > ?", `${ds.label} LIKE ? ESCAPE '\\'`];
  if (!input.includeArchived && ["supplies", "procedures", "providers"].includes(input.kind)) predicates.push("archived_at_ms IS NULL");
  if (!input.includeArchived && input.kind === "equipment") predicates.push("status IN ('planned','installed')");
  const escaped = input.query.replace(/[\\%_]/g, "\\$&");
  const rows = handle.sqlite.prepare(`SELECT ${columns.join(",")} FROM ${ds.table} WHERE ${predicates.join(" AND ")} ORDER BY id LIMIT ?`)
    .all(after, `%${escaped}%`, input.limit + 1) as Record<string, unknown>[];
  const hasMore = rows.length > input.limit; rows.length = Math.min(rows.length, input.limit);
  return { kind: input.kind, items: rows.map((row):Record<string,unknown> => ({ ...compact(row), href: recordHref(input.kind,row) })),
    nextCursor: hasMore ? Buffer.from(JSON.stringify({ after: rows.at(-1)!.id, fingerprint })).toString("base64url") : null };
}

export function getRecord(handle: DbHandle, raw: unknown) {
  const input = getInput.parse(raw), ds = datasets[input.kind];
  const row = handle.sqlite.prepare(`SELECT * FROM ${ds.table} WHERE id = ?`).get(input.id) as Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, "not_found");
  const record: Record<string, unknown> = { ...camel(row), href: recordHref(input.kind,row) };
  const select = (sql: string, ...args: (string | number)[]) => (handle.sqlite.prepare(sql).all(...args) as Record<string, unknown>[]).map(camel);
  if (input.include.includes("location") && typeof row.location_id === "string") {
    record.location = select("SELECT * FROM location WHERE id = ?", row.location_id)[0] ?? null;
  }
  if (input.include.includes("documents")) {
    const targetKind = ({ equipment:"asset", supplies:"part", procedures:"procedure_version", tasks:"occurrence", projects:"project", locations:"location", routes:"infra_route", annotations:"annotation", history:"completion" } as Partial<Record<EntityKind,string>>)[input.kind];
    if (targetKind) record.documents = select("SELECT a.id,a.original_filename,a.kind,a.mime,a.byte_size,a.caption,l.role FROM attachment_link l JOIN attachment a ON a.id=l.attachment_id WHERE l.entity_kind=? AND l.entity_id=? ORDER BY l.seq,a.id LIMIT 100", targetKind, input.kind==="procedures" ? String(row.current_version_id ?? "") : input.id);
  }
  if (input.kind === "equipment") {
    if (input.include.includes("placements")) record.placements = select("SELECT * FROM asset_placement WHERE asset_id=? LIMIT 100", input.id);
    if (input.include.includes("maintenance")) {
      record.plans = select("SELECT id,title,status,schedule_kind FROM maintenance_plan WHERE asset_id=? ORDER BY id LIMIT 100", input.id);
      record.tasks = select("SELECT id,title,status,due_date FROM maintenance_occurrence WHERE asset_id=? AND status IN ('pending','due') ORDER BY due_date,id LIMIT 100", input.id);
    }
    if (input.include.includes("consumables")) record.consumables = select("SELECT ac.*,p.name,p.unit,ps.on_hand_milli FROM asset_consumable ac JOIN part p ON p.id=ac.part_id LEFT JOIN part_stock ps ON ps.part_id=p.id WHERE ac.asset_id=? LIMIT 100", input.id);
    if (input.include.includes("controls")) record.controls = readEquipmentHaControls(handle.db, input.id);
  }
  if (input.kind === "supplies") record.stock = select("SELECT * FROM part_stock WHERE part_id=?", input.id)[0] ?? null;
  if (input.kind === "procedures" && input.include.includes("procedure")) {
    const versions = select("SELECT * FROM procedure_version WHERE procedure_id=? ORDER BY version DESC LIMIT 10", input.id);
    record.versions = versions;
    const versionId = String(row.current_version_id ?? versions.find(v=>v.status==="draft")?.id ?? "");
    for (const table of ["procedure_step", "procedure_checklist_item", "procedure_tool", "procedure_material", "procedure_reference", "procedure_equipment_note"]) record[table.replace("procedure_", "")] = select(`SELECT * FROM ${table} WHERE version_id=? LIMIT 100`, versionId);
  }
  if (input.kind === "projects" && input.include.includes("links")) record.links = select("SELECT * FROM project_link WHERE project_id=? ORDER BY id LIMIT 100", input.id);
  return { kind: input.kind, record };
}

const relationships:Record<string,string>={
  "locations.equipment":"SELECT id,name,category,status,updated_at_ms FROM asset WHERE location_id=?",
  "locations.children":"SELECT id,name,kind,updated_at_ms FROM location WHERE parent_id=?",
  "equipment.plans":"SELECT id,title,status,schedule_kind,updated_at_ms FROM maintenance_plan WHERE asset_id=?",
  "equipment.tasks":"SELECT id,title,status,due_date,updated_at_ms FROM maintenance_occurrence WHERE asset_id=?",
  "equipment.history":"SELECT id,completed_local_date,outcome,notes,updated_at_ms FROM completion WHERE asset_id=?",
  "equipment.consumables":"SELECT ac.id,ac.part_id,p.name,ac.role,ac.qty_milli,p.unit FROM asset_consumable ac JOIN part p ON p.id=ac.part_id WHERE ac.asset_id=?",
  "equipment.placements":"SELECT * FROM asset_placement WHERE asset_id=?",
  "equipment.systems":"SELECT s.id,s.name,s.kind,s.status FROM system_asset sa JOIN system s ON s.id=sa.system_id WHERE sa.asset_id=?",
  "supplies.stock_movements":"SELECT id,kind,qty_milli,occurred_at_ms,notes,storage_place_id,lot_id FROM stock_transaction WHERE part_id=?",
  "supplies.suppliers":"SELECT * FROM part_supplier WHERE part_id=?",
  "supplies.equipment":"SELECT a.id,a.name,a.location_id FROM asset_consumable ac JOIN asset a ON a.id=ac.asset_id WHERE ac.part_id=?",
  "procedures.versions":"SELECT * FROM procedure_version WHERE procedure_id=?",
  "projects.links":"SELECT * FROM project_link WHERE project_id=?",
  "providers.bookings":"SELECT * FROM service_booking WHERE provider_id=?",
  "providers.documents":"SELECT * FROM service_document WHERE provider_id=?",
  "plans.tasks":"SELECT id,title,status,due_date,updated_at_ms FROM maintenance_occurrence WHERE plan_id=?",
  "tasks.history":"SELECT * FROM completion WHERE occurrence_id=?",
  "routes.points":"SELECT * FROM infra_route_point WHERE route_id=?",
  "documents.links":"SELECT * FROM attachment_link WHERE attachment_id=?",
  "systems.equipment":"SELECT a.id,a.name,a.status,a.location_id FROM system_asset sa JOIN asset a ON a.id=sa.asset_id WHERE sa.system_id=?",
};
const documentKinds:Partial<Record<EntityKind,string>>={equipment:"asset",supplies:"part",projects:"project",tasks:"occurrence",history:"completion",locations:"location",annotations:"annotation",routes:"infra_route"};
export const relatedInput=z.object({kind:entityKind,id:z.string().min(1).max(128),
  relation:z.enum(["equipment","children","plans","tasks","history","consumables","placements","systems","stock_movements","suppliers","versions","links","bookings","documents","points"]),
  limit:z.number().int().min(1).max(100).default(20),cursor:z.string().max(600).optional()}).strict();
export function listRelated(handle:DbHandle,raw:unknown){
  const input=relatedInput.parse(raw),key=`${input.kind}.${input.relation}`;
  const fingerprint=hashSecret(JSON.stringify([key,input.id])).slice(0,16);
  let after="";
  if(input.cursor)try{after=z.object({after:z.string().max(128),fingerprint:z.literal(fingerprint)}).parse(JSON.parse(Buffer.from(input.cursor,"base64url").toString())).after;}catch{throw new HttpError(400,"invalid_cursor");}
  let query=relationships[key];const args:string[]=[];
  if(input.relation==="documents"&&documentKinds[input.kind]){
    query="SELECT l.id,a.id AS document_id,a.original_filename,a.caption,a.kind,a.mime,a.byte_size,l.role FROM attachment_link l JOIN attachment a ON a.id=l.attachment_id WHERE l.entity_kind=? AND l.entity_id=?";
    args.push(documentKinds[input.kind]!);
  }
  if(!query)throw new HttpError(400,"unsupported_relationship",undefined,{available:[...Object.keys(relationships).filter(k=>k.startsWith(`${input.kind}.`)).map(k=>k.split(".")[1]),...(documentKinds[input.kind]?["documents"]:[])]});
  args.push(input.id);
  const rows=handle.sqlite.prepare(`SELECT * FROM (${query}) WHERE id>? ORDER BY id LIMIT ?`).all(...args,after,input.limit+1) as Record<string,unknown>[];
  const more=rows.length>input.limit;rows.length=Math.min(rows.length,input.limit);
  return {kind:input.kind,id:input.id,relation:input.relation,items:rows.map(compact),nextCursor:more?Buffer.from(JSON.stringify({after:rows.at(-1)!.id,fingerprint})).toString("base64url"):null};
}
