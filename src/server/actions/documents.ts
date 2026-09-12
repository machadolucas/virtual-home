"use server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, writeTx } from "@/db/client";
import { documentText } from "@/db/schema/documentText";
import { action, freshAction } from "@/server/api/action";
import { documentMetadataInput, documentLinkInput, serviceDocumentInput, updateDocumentMetadata, linkDocument, saveServiceDocument,detachDocumentRecord,removeServiceDocumentRecord } from "@/server/documents/service";
export const editDocument = action(documentMetadataInput, (input, session) => {
  const result = writeTx(getDb().db, db => updateDocumentMetadata(db, session.user.id, input));
  revalidatePath("/documents", "layout"); revalidatePath(`/documents/${input.id}`); return result;
});
export const attachDocument = action(documentLinkInput, (input, session) => {
  const result = writeTx(getDb().db, db => linkDocument(db, session.user.id, input));
  revalidatePath("/documents", "layout"); revalidatePath(input.entityKind === "asset" ? `/equipment/${input.entityId}` : `/projects/${input.entityId}`); return result;
});
export const editServiceDocument = action(serviceDocumentInput, (input, session) => {
  const result = writeTx(getDb().db, db => saveServiceDocument(db, session.user.id, input));
  revalidatePath("/documents", "layout"); if (input.providerId) revalidatePath(`/providers/${input.providerId}`); return result;
});
export const detachDocument = freshAction(z.object({ linkId: z.string().min(1) }), (input, session) => {
  const result=writeTx(getDb().db, db => detachDocumentRecord(db,session.user.id,input.linkId)); revalidatePath("/documents", "layout"); return result;
});
export const removeServiceDocument = freshAction(z.object({ id: z.string().min(1) }), (input, session) => {
  const result=writeTx(getDb().db, db => removeServiceDocumentRecord(db,session.user.id,input.id)); revalidatePath("/documents", "layout"); return result;
});
export const retryDocumentText = action(z.object({ id: z.string().min(1) }), input => {
  writeTx(getDb().db, db => db.delete(documentText).where(eq(documentText.attachmentId, input.id)).run()); revalidatePath(`/documents/${input.id}`); return { id: input.id };
});
