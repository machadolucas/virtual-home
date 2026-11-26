import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { writeTx, type Db } from "@/db/client";
import { attachment, attachmentLink, completion, maintenanceOccurrence, maintenancePlan, procedureChecklistItem, procedureStep, serviceProvider } from "@/db/schema";
import { completeOccurrenceInTx } from "@/domain/completion";
import type { DomainCtx } from "@/domain/occurrence";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import type { HeadsetTaskWrite } from "@/house/xr/headsetTasksTypes";
import { badRequest, conflict, notFound } from "@/server/api/handler";
import { headsetEquipmentByPlacement } from "@/server/queries/maintenance/headset";
import { loadFrozenProcedure, loadMaterialLines, loadProgress } from "@/server/queries/maintenance/task";
import { upsertProgress } from "./progress";
import { domainCall } from "./shared";

function checkPhoto(db: Db, occurrenceId: string, id: string) {
  return db.select({ id: attachment.id, mime: attachment.mime }).from(attachment)
    .innerJoin(attachmentLink, eq(attachment.id, attachmentLink.attachmentId)).where(and(
      eq(attachment.id, id), eq(attachmentLink.entityKind, "occurrence"), eq(attachmentLink.entityId, occurrenceId),
    )).get()?.mime.startsWith("image/") === true;
}

export function writeHeadsetTask(db: Db, ctx: DomainCtx, index: ManifestIndex, placementId: string, input: HeadsetTaskWrite) {
  return domainCall("headset_task", () => writeTx(db, (tx) => {
    const target = headsetEquipmentByPlacement(tx, index, placementId);
    const occurrence = tx.select().from(maintenanceOccurrence).where(and(eq(maintenanceOccurrence.id, input.occurrenceId),
      eq(maintenanceOccurrence.assetId, target.assetId!))).get();
    if (!occurrence) throw notFound("unknown_headset_task");
    const requestId = input.kind === "complete" ? "xr:" + input.requestId : null;
    if (requestId) {
      const replay = tx.select({ id: completion.id, occurrenceId: completion.occurrenceId, actor: completion.recordedBy })
        .from(completion).where(eq(completion.requestId, requestId)).get();
      if (replay) {
        if (replay.occurrenceId !== occurrence.id || replay.actor !== ctx.actorUserId) throw conflict("headset_request_reused");
        return { completionId: replay.id, replayed: true };
      }
    }
    if (occurrence.status !== "due" && occurrence.status !== "pending") throw conflict("occurrence_not_open");
    const at = ctx.clock.now();
    if (input.kind === "step") {
      const step = occurrence.procedureVersionId ? tx.select().from(procedureStep).where(and(
        eq(procedureStep.id, input.stepId), eq(procedureStep.versionId, occurrence.procedureVersionId),
      )).get() : null;
      if (!step) throw notFound("unknown_headset_step");
      if (input.state === "skipped" && !step.isOptional) throw badRequest("headset_required_step");
      return { progressId: upsertProgress(tx, occurrence.id, ctx.actorUserId, at, {
        itemKind: "step", stepId: step.id, checklistItemId: null, state: input.state,
      }) };
    }
    if (input.kind === "checklist") {
      const item = occurrence.procedureVersionId ? tx.select().from(procedureChecklistItem).where(and(
        eq(procedureChecklistItem.id, input.itemId), eq(procedureChecklistItem.versionId, occurrence.procedureVersionId),
      )).get() : null;
      if (!item) throw notFound("unknown_headset_checklist");
      const text = typeof input.value === "string" ? input.value : undefined;
      const numeric = typeof input.value === "number" ? input.value : undefined;
      if (input.state === "done" && ((item.requiresValue === "number" && numeric === undefined) ||
        (item.requiresValue === "text" && !text) || (item.requiresValue === "photo" && (!text || !checkPhoto(tx, occurrence.id, text)))))
        throw badRequest("headset_checklist_value_required");
      return { progressId: upsertProgress(tx, occurrence.id, ctx.actorUserId, at, {
        itemKind: "checklist", stepId: item.stepId, checklistItemId: item.id, state: input.state,
        ...(item.requiresValue === "number" && { valueNumber: numeric }),
        ...(item.requiresValue === "text" && { valueText: text }),
        ...(item.requiresValue === "photo" && { attachmentId: text }),
      }) };
    }

    const plan = occurrence.planId ? tx.select({ professional: maintenancePlan.requiresProfessional }).from(maintenancePlan)
      .where(eq(maintenancePlan.id, occurrence.planId)).get() : null;
    if (plan?.professional && !input.providerId) throw badRequest("headset_provider_required");
    if (input.providerId) {
      const provider = tx.select({ id: serviceProvider.id }).from(serviceProvider)
        .where(and(eq(serviceProvider.id, input.providerId), isNull(serviceProvider.archivedAtMs))).get();
      if (!provider) throw badRequest("headset_provider_required");
    }
    if (input.outcome !== "partial") {
      const procedure = loadFrozenProcedure(tx, occurrence.procedureVersionId);
      const progress = loadProgress(tx, occurrence.id);
      const steps = new Map(progress.filter((item) => item.itemKind === "step").map((item) => [item.stepId, item.state]));
      const checklist = new Map(progress.filter((item) => item.itemKind === "checklist").map((item) => [item.checklistItemId, item]));
      const fields = [...(procedure?.looseChecklist ?? [])];
      for (const step of procedure?.steps ?? []) {
        if (!step.isOptional && steps.get(step.id) !== "done") throw badRequest("headset_required_step");
        if (!step.isOptional || steps.get(step.id) === "done") fields.push(...step.checklist);
      }
      for (const item of fields) {
        const row = checklist.get(item.id);
        if (row?.state !== "done" || (item.requiresValue === "number" && row.valueNumber === null) ||
          (item.requiresValue === "text" && !row.valueText) ||
          (item.requiresValue === "photo" && (!row.attachmentId || !checkPhoto(tx, occurrence.id, row.attachmentId))))
          throw badRequest("headset_checklist_value_required");
      }
    }
    const expected = loadMaterialLines(tx, occurrence.id);
    const byPart = new Map(input.materials.map((line) => [line.partId, line]));
    if (byPart.size !== input.materials.length || byPart.size !== expected.length || expected.some((line) => !byPart.has(line.partId)))
      throw conflict("headset_materials_changed");
    const result = completeOccurrenceInTx(tx, ctx, {
      requestId: requestId!, occurrenceId: occurrence.id, completedAtMs: at, source: "web",
      recordedByUserId: ctx.actorUserId, performedByProviderId: input.providerId ?? null, outcome: input.outcome,
      materials: expected.map((line) => ({ ...byPart.get(line.partId)!, expectedQtyMilli: line.expectedQtyMilli })),
    });
    return { completionId: result.completion.id, replayed: false, nextDueDate: result.next?.dueDate ?? null };
  }));
}
