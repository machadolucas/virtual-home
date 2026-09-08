"use server";
/**
 * Guided-procedure progress: ticking a step or a checklist item while standing in front of the
 * equipment.
 *
 * Rows are created lazily on first interaction and are **retained after completion** as part of
 * the record (`occurrence_progress_item`), which is what makes "resume at the first unfinished
 * step" survive a phone locking itself, a navigation, or a server restart.
 */
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { writeTx, type Db } from "@/db/client";
import { newId } from "@/db/ids";
import {
  PROGRESS_STATES,
  maintenanceOccurrence,
  occurrenceProgressItem,
} from "@/db/schema/maintenance";
import { procedureChecklistItem, procedureStep } from "@/db/schema/procedures";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { action } from "@/server/api/action";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { domainCall, id, revalidateMaintenance } from "./shared";

/**
 * Write one progress row.
 *
 * `stepId` / `checklistItemId` are checked against the occurrence's **frozen** procedure version,
 * so a step id from a newer draft cannot be recorded against work that was generated from an older
 * one.
 *
 * `valueText` / `valueNumber` / `attachmentId` distinguish **omitted** from **cleared**: an
 * omitted field leaves whatever is stored alone, `null` erases it. Without that distinction,
 * un-ticking and re-ticking a box — which says nothing about the reading — would silently destroy
 * a measurement somebody took, and a step update (which never carries values) would wipe them too.
 */
function upsertProgress(
  tx: Db,
  occurrenceId: string,
  actorUserId: string | null,
  nowMs: number,
  values: {
    itemKind: "step" | "checklist";
    stepId: string | null;
    checklistItemId: string | null;
    state: (typeof PROGRESS_STATES)[number];
    valueText?: string | null;
    valueNumber?: number | null;
    attachmentId?: string | null;
  },
): string {
  const occ = tx
    .select({
      id: maintenanceOccurrence.id,
      status: maintenanceOccurrence.status,
      procedureVersionId: maintenanceOccurrence.procedureVersionId,
    })
    .from(maintenanceOccurrence)
    .where(eq(maintenanceOccurrence.id, occurrenceId))
    .get();
  if (!occ) throw new NotFoundError("maintenance_occurrence", occurrenceId);
  if (occ.status !== "pending" && occ.status !== "due") {
    throw new ConflictError("occurrence_not_open", `occurrence is ${occ.status}`, {
      status: occ.status,
    });
  }
  if (occ.procedureVersionId === null) {
    throw new ConflictError("no_procedure", "this task has no procedure to work through");
  }

  if (values.stepId !== null) {
    const step = tx
      .select({ id: procedureStep.id })
      .from(procedureStep)
      .where(
        and(
          eq(procedureStep.id, values.stepId),
          eq(procedureStep.versionId, occ.procedureVersionId),
        ),
      )
      .get();
    if (!step) throw new ValidationError("unknown_step", "that step is not in this task's procedure");
  }
  if (values.checklistItemId !== null) {
    const item = tx
      .select({ id: procedureChecklistItem.id })
      .from(procedureChecklistItem)
      .where(
        and(
          eq(procedureChecklistItem.id, values.checklistItemId),
          eq(procedureChecklistItem.versionId, occ.procedureVersionId),
        ),
      )
      .get();
    if (!item) {
      throw new ValidationError(
        "unknown_checklist_item",
        "that checklist item is not in this task's procedure",
      );
    }
  }

  // The unique index covers NULLable columns, where SQLite treats NULLs as distinct — so the
  // lookup is written out rather than left to `onConflictDoUpdate`.
  const existing = tx
    .select({
      id: occurrenceProgressItem.id,
      valueText: occurrenceProgressItem.valueText,
      valueNumber: occurrenceProgressItem.valueNumber,
      attachmentId: occurrenceProgressItem.attachmentId,
    })
    .from(occurrenceProgressItem)
    .where(
      and(
        eq(occurrenceProgressItem.occurrenceId, occurrenceId),
        eq(occurrenceProgressItem.itemKind, values.itemKind),
        values.stepId === null
          ? isNull(occurrenceProgressItem.stepId)
          : eq(occurrenceProgressItem.stepId, values.stepId),
        values.checklistItemId === null
          ? isNull(occurrenceProgressItem.checklistItemId)
          : eq(occurrenceProgressItem.checklistItemId, values.checklistItemId),
      ),
    )
    .get();

  if (existing) {
    tx.update(occurrenceProgressItem)
      .set({
        state: values.state,
        valueText: values.valueText === undefined ? existing.valueText : values.valueText,
        valueNumber: values.valueNumber === undefined ? existing.valueNumber : values.valueNumber,
        attachmentId:
          values.attachmentId === undefined ? existing.attachmentId : values.attachmentId,
        changedAtMs: nowMs,
        changedBy: actorUserId,
      })
      .where(eq(occurrenceProgressItem.id, existing.id))
      .run();
    return existing.id;
  }

  const rowId = newId();
  tx.insert(occurrenceProgressItem)
    .values({
      id: rowId,
      occurrenceId,
      itemKind: values.itemKind,
      stepId: values.stepId,
      checklistItemId: values.checklistItemId,
      state: values.state,
      valueText: values.valueText ?? null,
      valueNumber: values.valueNumber ?? null,
      attachmentId: values.attachmentId ?? null,
      changedAtMs: nowMs,
      changedBy: actorUserId,
    })
    .run();
  return rowId;
}

export const setStepProgress = action(
  z.object({
    occurrenceId: id,
    stepId: id,
    state: z.enum(PROGRESS_STATES),
  }),
  async (input, session) => {
    const { handle, nowMs } = maintenanceContext(session.user.id);
    const rowId = domainCall("step_progress", () =>
      writeTx(handle.db, (tx) =>
        upsertProgress(tx, input.occurrenceId, session.user.id, nowMs, {
          itemKind: "step",
          stepId: input.stepId,
          checklistItemId: null,
          state: input.state,
        }),
      ),
    );
    revalidateMaintenance(input.occurrenceId);
    return { id: rowId, state: input.state };
  },
);

/**
 * Tick a checklist item, optionally recording the value it requires (a number with a unit, a short
 * text, or a photo attachment).
 */
export const setChecklistProgress = action(
  z.object({
    occurrenceId: id,
    checklistItemId: id,
    stepId: id.nullish(),
    state: z.enum(PROGRESS_STATES),
    valueText: z.string().trim().max(500).nullish(),
    valueNumber: z.number().finite().nullish(),
    attachmentId: id.nullish(),
  }),
  async (input, session) => {
    const { handle, nowMs } = maintenanceContext(session.user.id);
    const rowId = domainCall("checklist_progress", () =>
      writeTx(handle.db, (tx) =>
        upsertProgress(tx, input.occurrenceId, session.user.id, nowMs, {
          itemKind: "checklist",
          stepId: input.stepId ?? null,
          checklistItemId: input.checklistItemId,
          state: input.state,
          // Passed straight through, `undefined` included: the schema is `nullish()`, so a field
          // the form did not send stays as it is and an explicit `null` clears it.
          valueText: input.valueText,
          valueNumber: input.valueNumber,
          attachmentId: input.attachmentId,
        }),
      ),
    );
    revalidateMaintenance(input.occurrenceId);
    return { id: rowId, state: input.state };
  },
);
