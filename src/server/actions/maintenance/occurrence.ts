"use server";
/**
 * Occurrence transitions, one server action each.
 *
 * Every one of these is a thin shell: validate, open one `writeTx`, call the domain function that
 * already enforces the §3.2 preconditions inside that transaction, revalidate. No transition logic
 * lives here — duplicating a guard in the UI layer is how the two drift apart.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { maintenanceOccurrence } from "@/db/schema/maintenance";
import { block, loadOccurrence, postpone, reopen, skip, snooze, unblock } from "@/domain/occurrence";
import { ensureRecipientStates, recipientsFor } from "@/domain/notify/recipients";
import { ConflictError } from "@/domain/errors";
import { addDaysLocal, instantOf, localDateOf } from "@/domain/time";
import { action } from "@/server/api/action";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import {
  domainCall,
  id,
  idempotencyKey,
  localDate,
  optionalReason,
  reason,
  revalidateMaintenance,
} from "./shared";

/** Move the due date. `original_due_date` and the plan's interval are untouched (§3.2). */
export const postponeTask = action(
  z.object({
    occurrenceId: id,
    newDueDate: localDate,
    reason: optionalReason,
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const planId = domainCall("postpone", () =>
      writeTx(handle.db, (tx) => {
        postpone(tx, ctx, input.occurrenceId, input.newDueDate, input.reason);
        return loadOccurrence(tx, input.occurrenceId).planId;
      }),
    );
    revalidateMaintenance(input.occurrenceId, planId ?? undefined);
    return { occurrenceId: input.occurrenceId, dueDate: input.newDueDate };
  },
);

export const SNOOZE_PRESETS = ["tomorrow", "three_days", "pick"] as const;

/**
 * Snooze **this user's** reminders. Deliberately harmless: no completion, no stock movement, no
 * due-date change (CLAUDE.md rule 6). The other member keeps their own reminder series.
 *
 * The snooze lands at the household delivery time on the chosen date, computed through
 * `instantOf` so a DST boundary cannot shift it an hour (rule 4).
 */
export const snoozeTask = action(
  z.object({
    occurrenceId: id,
    preset: z.enum(SNOOZE_PRESETS),
    until: localDate.optional(),
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx, settings, today } = maintenanceContext(session.user.id);
    const untilDate =
      input.preset === "tomorrow"
        ? addDaysLocal(today, 1)
        : input.preset === "three_days"
          ? addDaysLocal(today, 3)
          : (input.until ?? addDaysLocal(today, 1));
    const untilMs = instantOf(untilDate, settings.deliveryTime, settings.timezone);

    domainCall("snooze", () =>
      writeTx(handle.db, (tx) => {
        const occ = loadOccurrence(tx, input.occurrenceId);
        if (!recipientsFor(tx, occ).includes(session.user.id)) {
          throw new ConflictError(
            "not_a_recipient",
            "this task is assigned to the other member, so there is no reminder of yours to snooze",
          );
        }
        // The worker creates recipient states when a task becomes due; snoozing before that has to
        // create the row rather than fail, or "snooze" is unavailable exactly when it is wanted.
        ensureRecipientStates(tx, ctx, occ);
        snooze(tx, ctx, input.occurrenceId, session.user.id, untilMs);
      }),
    );
    revalidateMaintenance(input.occurrenceId);
    return { occurrenceId: input.occurrenceId, untilDate, untilMs };
  },
);

/**
 * Close without a completion. The successor is generated from the **due date**, with
 * `schedule_anchor_source='skipped_due_date'` — so no history is fabricated (§3.2).
 */
export const skipTask = action(
  z.object({
    occurrenceId: id,
    reason: reason,
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const result = domainCall("skip", () =>
      writeTx(handle.db, (tx) => {
        const planId = loadOccurrence(tx, input.occurrenceId).planId;
        const { next } = skip(tx, ctx, input.occurrenceId, input.reason);
        return { planId, nextOccurrenceId: next?.id ?? null, nextDueDate: next?.dueDate ?? null };
      }),
    );
    revalidateMaintenance(input.occurrenceId, result.planId ?? undefined);
    return result;
  },
);

/** "Waiting for filters". A decorator: the due date and the reminder series stay as they are. */
export const blockTask = action(
  z.object({
    occurrenceId: id,
    reason: reason,
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    domainCall("block", () =>
      writeTx(handle.db, (tx) => block(tx, ctx, input.occurrenceId, input.reason)),
    );
    revalidateMaintenance(input.occurrenceId);
    return { occurrenceId: input.occurrenceId };
  },
);

export const unblockTask = action(
  z.object({ occurrenceId: id, idempotencyKey: idempotencyKey.optional() }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    domainCall("unblock", () =>
      writeTx(handle.db, (tx) => unblock(tx, ctx, input.occurrenceId)),
    );
    revalidateMaintenance(input.occurrenceId);
    return { occurrenceId: input.occurrenceId };
  },
);

/**
 * Reopen a skipped or cancelled occurrence inside the reopen window. An untouched successor is
 * cancelled; a successor somebody has already worked on refuses the reopen rather than being
 * deleted.
 */
export const reopenTask = action(
  z.object({ occurrenceId: id, idempotencyKey: idempotencyKey.optional() }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const planId = domainCall("reopen", () =>
      writeTx(handle.db, (tx) => {
        reopen(tx, ctx, input.occurrenceId);
        return loadOccurrence(tx, input.occurrenceId).planId;
      }),
    );
    revalidateMaintenance(input.occurrenceId, planId ?? undefined);
    return { occurrenceId: input.occurrenceId };
  },
);

/**
 * Reassign an open occurrence between the two members (or to both).
 *
 * The occurrence is a snapshot of the plan at generation time, so this changes *this* task only —
 * editing the plan is a separate, explicit action. Recipient states are re-derived, which
 * suppresses reminders for whoever is no longer on the hook.
 */
export const reassignTask = action(
  z
    .object({
      occurrenceId: id,
      assignmentMode: z.enum(["user", "shared"]),
      assigneeUserId: id.nullable(),
      idempotencyKey: idempotencyKey.optional(),
    })
    // `ck_occ_assignment_mode` pairs the two columns; rejecting the mismatch here gives the form a
    // field-level message instead of a constraint failure.
    .refine((value) => value.assignmentMode !== "user" || value.assigneeUserId !== null, {
      message: "pick who this is assigned to",
      path: ["assigneeUserId"],
    }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    domainCall("reassign", () =>
      writeTx(handle.db, (tx) => {
        const occ = loadOccurrence(tx, input.occurrenceId);
        if (occ.status !== "pending" && occ.status !== "due") {
          throw new ConflictError("occurrence_not_open", `occurrence is ${occ.status}`);
        }
        const now = ctx.clock.now();
        tx.update(maintenanceOccurrence)
          .set({
            assignmentMode: input.assignmentMode,
            assigneeUserId: input.assignmentMode === "user" ? input.assigneeUserId : null,
            updatedAtMs: now,
            updatedBy: ctx.actorUserId,
          })
          .where(eq(maintenanceOccurrence.id, occ.id))
          .run();
        ensureRecipientStates(tx, ctx, {
          ...occ,
          assignmentMode: input.assignmentMode,
          assigneeUserId: input.assignmentMode === "user" ? input.assigneeUserId : null,
        });
      }),
    );
    revalidateMaintenance(input.occurrenceId);
    return { occurrenceId: input.occurrenceId };
  },
);

/** Today's quick action: snooze until tomorrow, for the person clicking. */
export const snoozeUntilTomorrow = action(
  z.object({ occurrenceId: id }),
  async (input, session) => {
    const { handle, ctx, settings } = maintenanceContext(session.user.id);
    const untilDate = addDaysLocal(localDateOf(ctx.clock.now(), settings.timezone), 1);
    const untilMs = instantOf(untilDate, settings.deliveryTime, settings.timezone);
    domainCall("snooze", () =>
      writeTx(handle.db, (tx) => {
        const occ = loadOccurrence(tx, input.occurrenceId);
        if (!recipientsFor(tx, occ).includes(session.user.id)) {
          throw new ConflictError(
            "not_a_recipient",
            "this task is assigned to the other member, so there is no reminder of yours to snooze",
          );
        }
        ensureRecipientStates(tx, ctx, occ);
        snooze(tx, ctx, input.occurrenceId, session.user.id, untilMs);
      }),
    );
    revalidateMaintenance(input.occurrenceId);
    return { occurrenceId: input.occurrenceId, untilDate };
  },
);
