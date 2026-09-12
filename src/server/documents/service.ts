import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { attachment, attachmentLink, asset, project, projectLink, serviceBooking, serviceDocument, serviceProvider, completion, SERVICE_DOCUMENT_KINDS } from "@/db/schema";
import { newId } from "@/db/ids";
import { HttpError } from "@/server/api/handler";
import { publish, EVENT_TOPICS } from "@/server/events/outbox";
import { localDateOf } from "@/domain/time";
import { loadHousehold } from "@/domain/occurrence";
import { auditLog } from "@/db/schema/household";
const id = z.string().min(1).max(200);
const nullableText = z.string().trim().max(10000).nullable().optional();
export const documentMetadataInput = z.strictObject({ id, expectedUpdatedAtMs: z.number().int(), caption: z.string().trim().max(500).nullable().optional(), originalFilename: z.string().trim().min(1).max(240).optional() });
export const documentLinkInput = z.strictObject({ attachmentId: id, entityKind: z.enum(["asset", "project"]), entityId: id, role: z.string().trim().min(1).max(40).default("document") });
export const serviceDocumentInput = z.strictObject({ id: id.optional(), expectedUpdatedAtMs: z.number().int().optional(), kind: z.enum(SERVICE_DOCUMENT_KINDS), attachmentId: id.nullable(), providerId: id.nullable(), assetId: id.nullable(), bookingId: id.nullable(), completionId: id.nullable(), documentNo: nullableText, notes: nullableText, issuedOn: z.iso.date().nullable().optional(), validUntil: z.iso.date().nullable().optional(), amountCents: z.number().int().min(0).nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).default("EUR") }).refine(v => v.assetId || v.bookingId || v.completionId, "Choose equipment, a booking or a completion for this service document.");
export function auditDocument(db: Db, userId: string, table: string, entityId: string, action: string) {
  publish(db, [{topic:EVENT_TOPICS.documentChanged,entityKey:entityId,payload:{id:entityId,table,action}}]);
  db.insert(auditLog).values({ id: newId(), atMs: Date.now(), actorKind: "user", actorUserId: userId, entityTable: table, entityId, action, summary: `${action} document` }).run();
}
export function updateDocumentMetadata(db: Db, userId: string, raw: z.input<typeof documentMetadataInput>) {
  const input = documentMetadataInput.parse(raw);
  const row = db.select().from(attachment).where(eq(attachment.id, input.id)).get();
  if (!row) throw new HttpError(404, "document_not_found");
  if (row.updatedAtMs !== input.expectedUpdatedAtMs) throw new HttpError(409, "document_changed", "This document changed. Refresh before saving.");
  const documentId = input.id;
  const patch = { ...(input.caption !== undefined ? {caption:input.caption} : {}), ...(input.originalFilename !== undefined ? {originalFilename:input.originalFilename} : {}) };
  const updatedAtMs = Math.max(Date.now(), row.updatedAtMs + 1);
  db.update(attachment).set({ ...patch, updatedAtMs, updatedBy: userId }).where(eq(attachment.id, documentId)).run();
  auditDocument(db, userId, "attachment", documentId, "updated");
  return { id: documentId, updatedAtMs };
}
export function linkDocument(db: Db, userId: string, raw: z.input<typeof documentLinkInput>) {
  const input = documentLinkInput.parse(raw);
  if (!db.select({ id: attachment.id }).from(attachment).where(eq(attachment.id, input.attachmentId)).get()) throw new HttpError(404, "document_not_found");
  const target = input.entityKind === "asset" ? db.select({ id: asset.id }).from(asset).where(eq(asset.id, input.entityId)).get() : db.select({ id: project.id }).from(project).where(eq(project.id, input.entityId)).get();
  if (!target) throw new HttpError(404, "target_not_found");
  const old = db.select().from(attachmentLink).where(and(eq(attachmentLink.attachmentId, input.attachmentId), eq(attachmentLink.entityKind, input.entityKind), eq(attachmentLink.entityId, input.entityId), eq(attachmentLink.role, input.role))).get();
  if (old) return { id: old.id };
  const linkId = newId(); db.insert(attachmentLink).values({ id: linkId, ...input }).run(); auditDocument(db, userId, "attachment_link", linkId, "created"); return { id: linkId };
}
export function saveServiceDocument(db: Db, userId: string, raw: z.input<typeof serviceDocumentInput>) {
  const input = serviceDocumentInput.parse(raw);
  const checks = [
    input.attachmentId === null || !!db.select().from(attachment).where(eq(attachment.id, input.attachmentId)).get(),
    input.assetId === null || !!db.select().from(asset).where(eq(asset.id, input.assetId)).get(),
    input.bookingId === null || !!db.select().from(serviceBooking).where(eq(serviceBooking.id, input.bookingId)).get(),
    input.completionId === null || !!db.select().from(completion).where(eq(completion.id, input.completionId)).get(),
    input.providerId === null || !!db.select().from(serviceProvider).where(eq(serviceProvider.id, input.providerId)).get(),
  ];
  if (checks.includes(false)) throw new HttpError(404, "document_relationship_not_found");
  const { id: existingId, expectedUpdatedAtMs, ...values } = input;
  const documentId = existingId ?? newId(); const now = Date.now();
  if (existingId) {
    const old = db.select().from(serviceDocument).where(eq(serviceDocument.id, existingId)).get();
    if (!old) throw new HttpError(404, "document_not_found");
    if (old.updatedAtMs !== expectedUpdatedAtMs) throw new HttpError(409, "document_changed");
    db.update(serviceDocument).set({ ...values, updatedBy: userId, updatedAtMs: Math.max(now, old.updatedAtMs + 1) }).where(eq(serviceDocument.id, existingId)).run();
  } else db.insert(serviceDocument).values({ id: documentId, ...values, createdAtMs: now, updatedAtMs: now, createdBy: userId, updatedBy: userId }).run();
  auditDocument(db, userId, "service_document", documentId, existingId ? "updated" : "created");
  return { id: documentId };
}
export function documentTargets(db: Db) {
  const tz = loadHousehold(db).timezone;
  return { equipment: db.select({ id: asset.id, name: asset.name }).from(asset).all(), projects: db.select({ id: project.id, name: project.name }).from(project).all(), providers: db.select({ id: serviceProvider.id, name: serviceProvider.name }).from(serviceProvider).all(), bookings: db.select().from(serviceBooking).all().map(b => ({id:b.id,name:b.scheduledStartMs ? `Booking ${localDateOf(b.scheduledStartMs,tz)}` : `Booking ${b.id.slice(0,8)}`})), completions: db.select().from(completion).all().map(c => ({id:c.id,name:`Completion ${localDateOf(c.completedAtMs,tz)}`})) };
}

/** Caller authenticates and owns writeTx; shared by fresh browser actions and approved MCP requests. */
export function detachDocumentRecord(db:Db,userId:string,linkId:string){
  const link=db.select().from(attachmentLink).where(eq(attachmentLink.id,linkId)).get();
  if(!link)throw new HttpError(404,"document_link_not_found");
  db.delete(attachmentLink).where(eq(attachmentLink.id,linkId)).run();
  auditDocument(db,userId,"attachment_link",linkId,"deleted");return {id:linkId};
}
export function removeServiceDocumentRecord(db:Db,userId:string,id:string){
  const record=db.select().from(serviceDocument).where(eq(serviceDocument.id,id)).get();
  if(!record)throw new HttpError(404,"document_not_found");
  db.delete(projectLink).where(and(eq(projectLink.entityKind,"service_document"),eq(projectLink.entityId,id))).run();
  db.delete(attachmentLink).where(and(eq(attachmentLink.entityKind,"service_document"),eq(attachmentLink.entityId,id))).run();
  db.delete(serviceDocument).where(eq(serviceDocument.id,id)).run();
  auditDocument(db,userId,"service_document",id,"deleted");return {id};
}
