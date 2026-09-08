"use server";
/**
 * The one condition-task decision the app is allowed to make: none of them.
 *
 * §6.5 — a battery reading coming back up is **not** evidence that anyone replaced anything. The
 * episode closes, the occurrence stays open, reminders are *snoozed* (not cleared, because
 * clearing would imply "done"), and the task page offers exactly three choices, all of which the
 * user makes:
 *
 *  - **Record replacement** — the ordinary completion flow, which consumes the battery part;
 *  - **Close without maintenance** — a `skip`, no completion, no stock movement, honest history;
 *  - **Keep open** — nothing at all, which is why there is no action for it here.
 *
 * There is no auto-close, ever.
 */
import { z } from "zod";
import { closeEpisodeWithoutMaintenance } from "@/domain/condition";
import { action } from "@/server/api/action";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { domainCall, id, idempotencyKey, revalidateMaintenance } from "./shared";

/**
 * "The reading recovered and nobody did anything." Closes the episode as `manual` and skips the
 * occurrence with reason `condition_recovered` — no `completion` row, no stock transaction, and
 * `plan.last_completion_id` untouched.
 */
export const closeConditionWithoutMaintenance = action(
  z.object({ occurrenceId: id, idempotencyKey: idempotencyKey.optional() }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const result = domainCall("close_without_maintenance", () =>
      closeEpisodeWithoutMaintenance(handle, ctx, input.occurrenceId),
    );
    revalidateMaintenance(input.occurrenceId);
    return result;
  },
);
