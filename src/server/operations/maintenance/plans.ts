import "server-only";
/**
 * Maintenance plans: create, edit, seed the schedule, cancel — plus the live schedule preview the
 * wizard shows.
 *
 * The structural rule these actions exist to protect is §2.4: **seeding writes
 * `schedule_anchor_date`, which is a scheduling input, and never a `completion` row, which is a
 * historical fact.** "Last done sometime in spring 2024" produces an immediately-overdue first
 * task and no history at all. `seedPlanSchedule` enforces that; nothing here works around it.
 */
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { writeTx, type Db } from "@/db/client";
import { newId } from "@/db/ids";
import { part } from "@/db/schema/inventory";
import { PRIORITIES, maintenancePlan, planMaterial, serviceProvider } from "@/db/schema/maintenance";
import { procedure } from "@/db/schema/procedures";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import {
  cancelPlan,
  createOccurrenceForPlan,
  loadPlan,
  openOccurrenceOfPlan,
  seedPlanSchedule,
  writeAuditLog,
  SEED_KINDS,
} from "@/domain/occurrence";
import { recurrenceRuleSchema } from "@/domain/recurrence";
import {
  SCHEDULE_FORM_KINDS,
  previewDueDates,
  scheduleKindOf,
} from "@/features/maintenance/schedule";
import { defineOperation as action } from "@/server/operations/core";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { parseTargetValue } from "@/server/queries/maintenance/targets";
import {
  domainCall,
  id,
  invalid,
  idempotencyKey,
  localDate,
  optionalNote,
  optionalReason,
  positiveQtyMilli,
  revalidateMaintenance,
} from "@/server/operations/maintenance/shared";

const materialInput = z.object({
  partId: id,
  qtyMilli: positiveQtyMilli,
  isRequired: z.boolean(),
  notes: z.string().trim().max(500).nullish(),
});

export const planFields = z.object({
  /** `asset:<id>` | `system:<id>` | `location:<id>` — a plan targets exactly one. */
  target: z.string().min(3).max(80),
  title: z.string().trim().min(1).max(200),
  description: optionalNote.nullish(),
  procedureId: id.nullish(),
  /** Which question the form asked; decides `maintenance_plan.schedule_kind`. */
  scheduleFormKind: z.enum(SCHEDULE_FORM_KINDS),
  rule: recurrenceRuleSchema,
  assignmentMode: z.enum(["user", "shared"]),
  assigneeUserId: id.nullish(),
  priority: z.enum(PRIORITIES),
  estimatedMinutes: z.number().int().min(1).max(100_000).nullish(),
  requiresProfessional: z.boolean(),
  defaultProviderId: id.nullish(),
  materials: z.array(materialInput).max(50),
  status: z.enum(["active", "paused"]),
});

function parseTarget(target: string): NonNullable<ReturnType<typeof parseTargetValue>> {
  const ref = parseTargetValue(target);
  if (ref === null) throw new ValidationError("invalid_target", `not a target: ${target}`);
  return ref;
}

function assertProcedure(tx: Db, procedureId: string | null | undefined): string | null {
  if (procedureId === null || procedureId === undefined) return null;
  const row = tx.select({ id: procedure.id }).from(procedure).where(eq(procedure.id, procedureId)).get();
  if (!row) throw new NotFoundError("procedure", procedureId);
  return row.id;
}

function writeMaterials(
  tx: Db,
  planId: string,
  materials: readonly z.infer<typeof materialInput>[],
): void {
  const partIds = [...new Set(materials.map((line) => line.partId))];
  if (partIds.length > 0) {
    const known = tx
      .select({ id: part.id })
      .from(part)
      .where(inArray(part.id, partIds))
      .all()
      .map((row) => row.id);
    const missing = partIds.filter((partId) => !known.includes(partId));
    if (missing.length > 0) throw new NotFoundError("part", missing[0]);
  }
  tx.delete(planMaterial).where(eq(planMaterial.planId, planId)).run();
  const seen = new Set<string>();
  for (const line of materials) {
    // `ux_plan_material` is one row per (plan, part): the last entry for a part wins rather than
    // the whole save failing on a duplicate the user did not notice.
    if (seen.has(line.partId)) continue;
    seen.add(line.partId);
    tx.insert(planMaterial)
      .values({
        id: newId(),
        planId,
        partId: line.partId,
        qtyMilli: line.qtyMilli,
        isRequired: line.isRequired,
        notes: line.notes ?? null,
      })
      .run();
  }
}

const seedInput = z.object({
  kind: z.enum(SEED_KINDS),
  date: localDate.optional(),
  note: z.string().trim().max(500).optional(),
});

function assertActiveProvider(tx:Db,providerId:string|null|undefined):void {
  if(providerId==null)return;
  const provider=tx.select().from(serviceProvider).where(eq(serviceProvider.id,providerId)).get();
  if(!provider)throw new NotFoundError("service_provider",providerId);
  if(provider.archivedAtMs!==null)throw new ValidationError("provider_archived","Choose an active provider.");
}

/**
 * Create a plan and seed its schedule in one transaction, so a plan never exists in a state where
 * nobody has been asked "when was this last done?".
 */
export const createPlan = action(
  z.object({
    plan: planFields,
    seed: seedInput,
    idempotencyKey: idempotencyKey.optional(),
  }),
  (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const { plan, seed } = input;
    if (plan.assignmentMode === "user" && (plan.assigneeUserId ?? null) === null) {
      throw invalid("assignee_required", "pick who this plan is assigned to");
    }

    const result = domainCall("create_plan", () =>
      writeTx(handle.db, (tx) => {
        const ref = parseTarget(plan.target);
        assertActiveProvider(tx,plan.defaultProviderId);
        const procedureId = assertProcedure(tx, plan.procedureId);
        const planId = newId();
        const now = ctx.clock.now();

        tx.insert(maintenancePlan)
          .values({
            id: planId,
            title: plan.title,
            description: plan.description ?? null,
            assetId: ref.assetId,
            systemId: ref.systemId,
            locationId: ref.locationId,
            procedureId,
            scheduleKind: scheduleKindOf(plan.scheduleFormKind),
            recurrenceJson: JSON.stringify(plan.rule),
            scheduleAnchorDate: null,
            scheduleAnchorSource: "none",
            assignmentMode: plan.assignmentMode,
            assigneeUserId: plan.assignmentMode === "user" ? (plan.assigneeUserId ?? null) : null,
            priority: plan.priority,
            estimatedMinutes: plan.estimatedMinutes ?? null,
            requiresProfessional: plan.requiresProfessional,
            defaultProviderId: plan.defaultProviderId ?? null,
            status: plan.status,
            createdAtMs: now,
            updatedAtMs: now,
            createdBy: ctx.actorUserId,
            updatedBy: ctx.actorUserId,
          })
          .run();

        writeMaterials(tx, planId, plan.materials);
        writeAuditLog(tx, ctx, {
          entityTable: "maintenance_plan",
          entityId: planId,
          action: "created",
          summary: `Created plan "${plan.title}"`,
        });

        const first = seedPlanSchedule(tx, ctx, planId, seed);
        return {
          planId,
          firstOccurrenceId: first?.id ?? null,
          firstDueDate: first?.dueDate ?? null,
        };
      }),
    );
    revalidateMaintenance(undefined, result.planId);
    return result;
  },
);

/**
 * Edit a plan. Open work is **not** rewritten: an occurrence snapshots the plan at generation
 * time, so somebody standing in front of the equipment keeps the task they started.
 *
 * Changing the rule therefore takes effect on the next occurrence, which the UI says out loud.
 */
export const updatePlan = action(
  z.object({
    planId: id,
    plan: planFields,
    idempotencyKey: idempotencyKey.optional(),
  }),
  (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const { plan } = input;
    if (plan.assignmentMode === "user" && (plan.assigneeUserId ?? null) === null) {
      throw invalid("assignee_required", "pick who this plan is assigned to");
    }

    domainCall("update_plan", () =>
      writeTx(handle.db, (tx) => {
        const existing = loadPlan(tx, input.planId);
        if (existing.status === "cancelled") {
          throw new ConflictError("plan_cancelled", "a cancelled plan cannot be edited");
        }
        const ref = parseTarget(plan.target);
        assertActiveProvider(tx,plan.defaultProviderId);
        const procedureId = assertProcedure(tx, plan.procedureId);
        const now = ctx.clock.now();

        tx.update(maintenancePlan)
          .set({
            title: plan.title,
            description: plan.description ?? null,
            assetId: ref.assetId,
            systemId: ref.systemId,
            locationId: ref.locationId,
            procedureId,
            scheduleKind: scheduleKindOf(plan.scheduleFormKind),
            recurrenceJson: JSON.stringify(plan.rule),
            assignmentMode: plan.assignmentMode,
            assigneeUserId: plan.assignmentMode === "user" ? (plan.assigneeUserId ?? null) : null,
            priority: plan.priority,
            estimatedMinutes: plan.estimatedMinutes ?? null,
            requiresProfessional: plan.requiresProfessional,
            defaultProviderId: plan.defaultProviderId ?? null,
            status: plan.status,
            updatedAtMs: now,
            updatedBy: ctx.actorUserId,
          })
          .where(eq(maintenancePlan.id, input.planId))
          .run();

        writeMaterials(tx, input.planId, plan.materials);
        writeAuditLog(tx, ctx, {
          entityTable: "maintenance_plan",
          entityId: input.planId,
          action: "updated",
          summary: `Edited plan "${plan.title}"`,
          changes: {
            title: [existing.title, plan.title],
            recurrenceJson: [existing.recurrenceJson, JSON.stringify(plan.rule)],
            status: [existing.status, plan.status],
          },
        });

        // Pausing a plan should stop nagging about work nobody intends to schedule; the open
        // occurrence is left alone, because pausing is not cancelling.
        if (plan.status === "active" && openOccurrenceOfPlan(tx, input.planId) === null) {
          createOccurrenceForPlan(tx, ctx, input.planId);
        }
      }),
    );
    revalidateMaintenance(undefined, input.planId);
    return { planId: input.planId };
  },
);

/**
 * Answer "when was this last done?" for a plan that was saved with "ask me later", or re-anchor an
 * existing one. Writes an anchor, never a completion.
 */
export const seedPlan = action(
  z.object({ planId: id, seed: seedInput, idempotencyKey: idempotencyKey.optional() }),
  (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const result = domainCall("seed_plan", () =>
      writeTx(handle.db, (tx) => {
        const occ = seedPlanSchedule(tx, ctx, input.planId, input.seed);
        return { occurrenceId: occ?.id ?? null, dueDate: occ?.dueDate ?? null };
      }),
    );
    revalidateMaintenance(result.occurrenceId ?? undefined, input.planId);
    return result;
  },
);

/** Cancel a plan: its open occurrence closes, both recipients are cleared, nothing regenerates. */
export const cancelPlanAction = action(
  z.object({ planId: id, reason: optionalReason, idempotencyKey: idempotencyKey.optional() }),
  (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    domainCall("cancel_plan", () =>
      writeTx(handle.db, (tx) => cancelPlan(tx, ctx, input.planId, input.reason)),
    );
    revalidateMaintenance(undefined, input.planId);
    return { planId: input.planId };
  },
);

/**
 * Generate the plan's next occurrence now, for a plan that has an anchor but (because it was
 * paused, or because its last occurrence was closed while paused) no open work.
 */
export const generateNextOccurrence = action(
  z.object({ planId: id, idempotencyKey: idempotencyKey.optional() }),
  (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const result = domainCall("generate", () =>
      writeTx(handle.db, (tx) => {
        const occ = createOccurrenceForPlan(tx, ctx, input.planId);
        return { occurrenceId: occ?.id ?? null, dueDate: occ?.dueDate ?? null };
      }),
    );
    revalidateMaintenance(result.occurrenceId ?? undefined, input.planId);
    return result;
  },
);

/**
 * The wizard's live preview: the next three due dates for a rule that has not been saved.
 *
 * Runs on the server so it uses the household time zone and the same `computeNextDue` the
 * scheduler uses — a preview computed in the browser's zone would be a different answer.
 */
export const previewSchedule = action(
  z.object({
    rule: recurrenceRuleSchema,
    anchorDate: localDate.nullish(),
    count: z.number().int().min(1).max(6).optional(),
  }),
  (input, session) => {
    const { settings, nowMs, today } = maintenanceContext(session.user.id);
    const preview = previewDueDates({
      rule: input.rule,
      anchorDate: input.anchorDate ?? null,
      nowMs,
      tz: settings.timezone,
      count: input.count ?? 3,
    });
    return { ...preview, today, tz: settings.timezone };
  },
);
