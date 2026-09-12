import "server-only";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { asset,part,project,maintenancePlan,planMaterial,serviceProvider,serviceDocument } from "@/db/schema";
import { HttpError } from "@/server/api/handler";
import { runOperation, type Operation, type OperationActor } from "@/server/operations/core";
import * as equipment from "@/server/operations/assets/equipment";
import * as trash from "@/server/operations/assets/trash";
import * as supplies from "@/server/operations/inventory/parts";
import * as stock from "@/server/operations/inventory/stock";
import * as projects from "@/server/operations/infrastructure/projects";
import * as plans from "@/server/operations/maintenance/plans";
import * as procedures from "@/server/operations/maintenance/procedures";
import * as complete from "@/server/operations/maintenance/complete";
import { assetFields } from "@/server/actions/assets/schemas";
import { partFields } from "@/server/actions/inventory/schemas";
import { projectFields } from "@/server/actions/infrastructure/schemas";
import { formKindOf } from "@/features/maintenance/schedule";
import { recurrenceRuleSchema } from "@/domain/recurrence";
import { queueHaControl } from "@/server/operations/ha/control";
import { providerInput,createProviderRecord,updateProviderRecord,archiveProviderRecord } from "@/server/services/providers";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { documentMetadataInput,documentLinkInput,serviceDocumentInput,updateDocumentMetadata,linkDocument,saveServiceDocument,detachDocumentRecord,removeServiceDocumentRecord } from "@/server/documents/service";

interface McpOperation {
  input: z.ZodType;
  consequential: boolean;
  description: string;
  run: (raw: unknown, actor: OperationActor) => { data: unknown; paths: string[] };
}
function registered<I extends z.ZodType, O>(op: Operation<I,O>, description: string, consequential = false): McpOperation {
  return { input: op.input instanceof z.ZodObject ? op.input.strict() : op.input, consequential, description, run: (raw,actor) => runOperation(op, raw, actor) };
}

/** A compact catalog is discoverable without injecting every form schema into every AI turn. */
export const operations: Record<string, McpOperation> = {
  "equipment.create": registered(equipment.createEquipment, "Create equipment, optional consumables and explicit HA links; no maintenance completion."),
  "equipment.patch": {
    input: z.object({ assetId:z.string().min(1), patch:assetFields.omit({status:true}).extend({isVirtual:z.boolean().optional()}).partial().strict() }).strict(),
    consequential:false, description:"Patch equipment fields. Omitted fields stay unchanged; null explicitly clears a nullable field. Requires expectedRevision.",
    run: (raw, actor) => {
      const input = z.object({assetId:z.string(),patch:z.record(z.string(),z.unknown())}).parse(raw);
      const row = getDb().db.select().from(asset).where(eq(asset.id,input.assetId)).get();
      if (!row) throw new HttpError(404,"not_found");
      return runOperation(equipment.updateEquipment,{...row,...input.patch,assetId:row.id},actor);
    },
  },
  "equipment.consumables":registered(equipment.setConsumables,"Replace equipment consumable links with the supplied complete list. Requires expectedRevision."),
  "equipment.retire":registered(equipment.retireEquipment,"Retire equipment and active HA links; preserve history.",true),
  "equipment.replace":registered(equipment.replaceEquipment,"Record an actual equipment replacement and repoint active plans.",true),
  "equipment.delete":registered(trash.permanentlyDeleteEquipment,"Permanently delete eligible equipment already in trash, respecting deletion blockers.",true),
  "supplies.create":registered(supplies.createPart,"Create supply catalog item; does not create any stock."),
  "supplies.update":{input:z.object({partId:z.string().min(1),patch:partFields.extend({isKit:z.boolean().optional(),stocked:z.boolean().optional(),tracksLots:z.boolean().optional()}).partial().strict()}).strict(),
    consequential:false,description:"Patch supply catalog metadata. Omitted fields stay unchanged; explicit null clears nullable fields. Requires expectedRevision.",run:(raw,actor)=>{
      const input=z.object({partId:z.string(),patch:z.record(z.string(),z.unknown())}).parse(raw);
      const row=getDb().db.select().from(part).where(eq(part.id,input.partId)).get();if(!row)throw new HttpError(404,"not_found");
      return runOperation(supplies.updatePart,{...row,stocked:row.stockMode==="stocked",...input.patch,partId:row.id},actor);
  }},
  "supplies.supplier":registered(supplies.upsertSupplier,"Add or edit a product supplier link."),
  "supplies.components":registered(supplies.setKitComponents,"Set kit recipe; does not explode stock. Requires expectedRevision."),
  "supplies.archive":registered(supplies.setPartArchived,"Archive or restore a supply definition, preserving ledger.",true),
  "stock.purchase":registered(stock.addPurchase,"Record actual received stock with quantities in thousandths and prices in cents.",true),
  "stock.count":registered(stock.stockTake,"Record an actual stock count as an audited ledger delta.",true),
  "stock.estimate":registered(stock.setEstimate,"Record an actual stock estimate.",true),
  "stock.explode":registered(stock.explodeKit,"Open kits and record component stock movements.",true),
  "stock.undo_explode":registered(stock.undoExplode,"Reverse a kit opening with its validated compensating movements.",true),
  "stock.correct":registered(stock.correctTransaction,"Correct a recorded stock transaction by reversal, never delete history.",true),
  "projects.create":registered(projects.createProject,"Create a project container; project completion never creates maintenance history."),
  "projects.update":{input:z.object({projectId:z.string().min(1),patch:projectFields.extend({status:projectFields.shape.status.unwrap().optional()}).partial().strict()}).strict(),
    consequential:false,description:"Patch project fields, preserving omitted values. Explicit null clears nullable fields. Requires expectedRevision.",run:(raw,actor)=>{
      const input=z.object({projectId:z.string(),patch:z.record(z.string(),z.unknown())}).parse(raw);
      const row=getDb().db.select().from(project).where(eq(project.id,input.projectId)).get();if(!row)throw new HttpError(404,"not_found");
      return runOperation(projects.updateProject,{...row,...input.patch,id:row.id},actor);
  }},
  "projects.link":registered(projects.addProjectLink,"Link an existing validated record into a project."),
  "projects.unlink":registered(projects.removeProjectLink,"Unlink a record from a project; preserve source record."),
  "projects.delete":registered(projects.deleteProject,"Delete a project container, respecting existing application rules.",true),
  "plans.create":registered(plans.createPlan,"Create a maintenance plan and schedule anchor. Never invent a completion."),
  "plans.update":{input:z.object({planId:z.string().min(1),patch:plans.planFields.partial().strict()}).strict(),
    consequential:false,description:"Patch a plan, preserving omitted fields, recurrence and material links. Explicit materials replaces the whole list. Requires expectedRevision.",run:(raw,actor)=>{
      const input=z.object({planId:z.string(),patch:z.record(z.string(),z.unknown())}).parse(raw),db=getDb().db;
      const row=db.select().from(maintenancePlan).where(eq(maintenancePlan.id,input.planId)).get();if(!row)throw new HttpError(404,"not_found");
      const rule=recurrenceRuleSchema.parse(JSON.parse(row.recurrenceJson));
      const formKind=formKindOf(rule);if(!formKind)throw new HttpError(409,"condition_plan_use_ha_settings");
      const materials=db.select().from(planMaterial).where(eq(planMaterial.planId,row.id)).all();
      const target=row.assetId?`asset:${row.assetId}`:row.systemId?`system:${row.systemId}`:`location:${row.locationId}`;
      const patchRule=input.patch.rule===undefined?rule:recurrenceRuleSchema.parse(input.patch.rule);
      return runOperation(plans.updatePlan,{planId:row.id,plan:{...row,target,rule,scheduleFormKind:formKind,materials,...input.patch,...(input.patch.rule!==undefined&&input.patch.scheduleFormKind===undefined?{scheduleFormKind:formKindOf(patchRule)}:{})}},actor);
  }},
  "plans.cancel":registered(plans.cancelPlanAction,"Cancel a maintenance plan and its open work according to domain rules.",true),
  "procedures.create":registered(procedures.createProcedure,"Create a procedure and editable draft."),
  "procedures.start_draft":registered(procedures.startProcedureDraft,"Start a new editable version from a published procedure."),
  "procedures.save_draft":registered(procedures.saveProcedureDraft,"Save complete procedure draft: steps, tools, references, materials, equipment notes. Requires expectedRevision."),
  "procedures.publish":registered(procedures.publishProcedureDraft,"Publish a validated immutable procedure version. Requires expectedRevision."),
  "procedures.discard_draft":registered(procedures.discardProcedureDraft,"Discard an unpublished procedure draft.",true),
  "maintenance.complete":registered(complete.completeTask,"Record work that really happened, including actual performer and materials.",true),
  "maintenance.void":registered(complete.voidTaskCompletion,"Void an incorrect completion through existing domain policy.",true),
  "maintenance.correct":registered(complete.correctTaskCompletion,"Correct recorded history through existing domain policy.",true),
  "ha.command":registered(queueHaControl,"Queue a supported linked equipment command after checking current connection, availability and capabilities. Queued is not observed physical success.",true),
  "providers.create":{input:providerInput,consequential:false,description:"Create a professional service provider.",run:(raw,actor)=>({data:createProviderRecord(getDb().db,maintenanceContext(actor.user.id).ctx,providerInput.parse(raw)),paths:["/providers","/plans"]})},
  "providers.update":{input:z.object({providerId:z.string().min(1),patch:providerInput.partial().strict()}).strict(),consequential:false,description:"Patch provider contact fields; omitted fields are preserved and null clears nullable values. Requires expectedRevision.",run:(raw,actor)=>{
    const input=z.object({providerId:z.string(),patch:z.record(z.string(),z.unknown())}).parse(raw);
    const row=getDb().db.select().from(serviceProvider).where(eq(serviceProvider.id,input.providerId)).get();if(!row)throw new HttpError(404,"not_found");
    return {data:updateProviderRecord(getDb().db,maintenanceContext(actor.user.id).ctx,input.providerId,providerInput.parse({...row,...input.patch})),paths:["/providers",`/providers/${input.providerId}`]};
  }},
  "providers.archive":{input:z.object({providerId:z.string().min(1),archived:z.boolean()}).strict(),consequential:true,description:"Archive or restore a provider. Archiving clears plan defaults and preserves booking/history records.",run:(raw,actor)=>{
    const input=z.object({providerId:z.string(),archived:z.boolean()}).parse(raw);return {data:archiveProviderRecord(getDb().db,maintenanceContext(actor.user.id).ctx,input.providerId,input.archived),paths:["/providers","/plans"]};
  }},
  "documents.metadata":{input:documentMetadataInput,consequential:false,description:"Update a document caption or filename with expectedUpdatedAtMs; preserve original bytes.",run:(raw,actor)=>({data:updateDocumentMetadata(getDb().db,actor.user.id,documentMetadataInput.parse(raw)),paths:["/documents","/equipment"]})},
  "documents.link":{input:documentLinkInput,consequential:false,description:"Link an existing document to equipment or a project.",run:(raw,actor)=>({data:linkDocument(getDb().db,actor.user.id,documentLinkInput.parse(raw)),paths:["/documents","/equipment","/projects"]})},
  "documents.unlink":{input:z.object({linkId:z.string().min(1)}).strict(),consequential:true,description:"Remove one document relationship, preserving the file and other links.",run:(raw,actor)=>({data:detachDocumentRecord(getDb().db,actor.user.id,z.object({linkId:z.string()}).parse(raw).linkId),paths:["/documents","/equipment","/projects"]})},
  "documents.delete_service_record":{input:z.object({id:z.string().min(1)}).strict(),consequential:true,description:"Delete a textual service report or invoice/certificate record and its links; preserve any uploaded file bytes.",run:(raw,actor)=>({data:removeServiceDocumentRecord(getDb().db,actor.user.id,z.object({id:z.string()}).parse(raw).id),paths:["/documents","/providers","/equipment","/projects"]})},
  "documents.service_record":{input:serviceDocumentInput,consequential:false,description:"Create a textual report (kind report, notes containing authored instructions) or invoice/quote/certificate metadata linked to existing records. Existing record edits use complete relationship fields and require expectedUpdatedAtMs; prefer documents.patch_service_record for a partial edit. Does not claim work was completed.",run:(raw,actor)=>({data:saveServiceDocument(getDb().db,actor.user.id,serviceDocumentInput.parse(raw)),paths:["/documents","/providers","/equipment"]})},
  "documents.patch_service_record":{input:z.object({id:z.string().min(1),expectedUpdatedAtMs:z.number().int(),patch:z.object(serviceDocumentInput.shape).omit({id:true,expectedUpdatedAtMs:true}).extend({currency:z.string().regex(/^[A-Z]{3}$/).optional()}).partial().strict()}).strict(),
    consequential:false,description:"Patch an authored service report or invoice metadata. Preserves omitted fields/relationships; null clears explicitly. Requires expectedUpdatedAtMs from get service_documents.",run:(raw,actor)=>{
      const input=z.object({id:z.string(),expectedUpdatedAtMs:z.number(),patch:z.record(z.string(),z.unknown())}).parse(raw);
      const row=getDb().db.select().from(serviceDocument).where(eq(serviceDocument.id,input.id)).get();if(!row)throw new HttpError(404,"document_not_found");
      const existing=Object.fromEntries(Object.keys(serviceDocumentInput.shape).map(key=>[key,(row as unknown as Record<string,unknown>)[key]]));
      return {data:saveServiceDocument(getDb().db,actor.user.id,serviceDocumentInput.parse({...existing,...input.patch,id:row.id,expectedUpdatedAtMs:input.expectedUpdatedAtMs})),paths:["/documents","/providers","/equipment"]};
  }},
};

export function describeOperations(names?: string[]) {
  const selected = names ?? Object.keys(operations);
  return selected.map(name => {
    const op = operations[name]; if (!op) throw new HttpError(404,"unknown_operation");
    return { name, description:op.description, approvalRequired:op.consequential,
      ...(names ? { inputSchema:z.toJSONSchema(op.input,{io:"input",unrepresentable:"any"}) } : {}) };
  });
}
