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
import { writeTx } from "@/db/client";
import { PROGRESS_STATES } from "@/db/schema/maintenance";
import { upsertProgress } from "@/server/operations/maintenance/progress";
import { action } from "@/server/api/action";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { domainCall, id, revalidateMaintenance } from "./shared";

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
