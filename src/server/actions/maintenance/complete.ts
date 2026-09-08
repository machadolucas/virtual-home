"use server";
/**
 * Completion, void and correction.
 *
 * `requestId` is the load-bearing field here. It is generated once per form instance on the client
 * and **reused verbatim** when the form is resubmitted after an `insufficient_stock` response
 * (§5.3), so a first attempt that actually committed but lost its response replays idempotently
 * instead of double-completing and double-deducting stock.
 */
import { z } from "zod";
import { ASSET_CATEGORIES, REPLACEMENT_REASONS } from "@/db/schema/assets";
import { COMPLETION_OUTCOMES, COMPLETION_PRECISIONS } from "@/db/schema/maintenance";
import {
  SHORT_RESOLUTION_OPTIONS,
  completeOccurrence,
  correctCompletion,
  voidCompletion,
  type CompletionInput,
} from "@/domain/completion";
import { instantOf } from "@/domain/time";
import { action } from "@/server/api/action";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import {
  domainCall,
  id,
  idempotencyKey,
  localDate,
  minutes,
  optionalNote,
  qtyMilli,
  reason,
  revalidateMaintenance,
} from "./shared";

const materialLine = z.object({
  partId: id,
  lotId: id.nullish(),
  expectedQtyMilli: qtyMilli.nullish(),
  /** `0` is legitimate: "we expected to use one, we did not." */
  actualQtyMilli: qtyMilli,
  resolutionIfShort: z.enum(SHORT_RESOLUTION_OPTIONS).optional(),
  notes: z.string().trim().max(500).nullish(),
});

const replacement = z.object({
  reason: z.enum(REPLACEMENT_REASONS),
  cloneConsumables: z.boolean().optional(),
  cloneHaLinks: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullish(),
  /** Either an existing spare that is being installed… */
  existingAssetId: id.optional(),
  /** …or the details of a brand-new unit. */
  newAsset: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      category: z.enum(ASSET_CATEGORIES).optional(),
      manufacturer: z.string().trim().max(200).nullish(),
      modelName: z.string().trim().max(200).nullish(),
      serialNumber: z.string().trim().max(200).nullish(),
      productCode: z.string().trim().max(200).nullish(),
      notes: z.string().trim().max(2000).nullish(),
    })
    .optional(),
});

/**
 * Record that work happened.
 *
 * Insufficient stock surfaces as `{ ok: false, error: 'insufficient_stock', details: { lines } }` —
 * the form keeps every field the user typed, shows the three honest choices per short line, and
 * resubmits with the same `requestId`.
 */
export const completeTask = action(
  z.object({
    occurrenceId: id,
    /** Client-generated, stable across retries of the same form. */
    requestId: z.string().min(8).max(128),
    /**
     * "Now", or a household-local date (with an optional wall-clock time). The instant is computed
     * on the server through `instantOf`, because the browser's zone is not the household's and a
     * date turned into an instant in the wrong zone is a day out (CLAUDE.md rule 4).
     */
    completedAt: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("now") }),
      z.object({
        mode: z.literal("date"),
        date: localDate,
        time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      }),
    ]),
    completedAtPrecision: z.enum(COMPLETION_PRECISIONS).optional(),
    performedByUserId: id.nullish(),
    performedByProviderId: id.nullish(),
    notes: optionalNote,
    effortMinutes: minutes.nullish(),
    outcome: z.enum(COMPLETION_OUTCOMES).optional(),
    materials: z.array(materialLine).max(50).optional(),
    replacement: replacement.optional(),
  }),
  async (input, session) => {
    const { handle, ctx, settings, nowMs } = maintenanceContext(session.user.id);
    const completedAtMs =
      input.completedAt.mode === "now"
        ? nowMs
        : instantOf(input.completedAt.date, input.completedAt.time ?? "12:00", settings.timezone);

    const payload: CompletionInput = {
      requestId: input.requestId,
      occurrenceId: input.occurrenceId,
      completedAtMs,
      completedAtPrecision: input.completedAtPrecision,
      performedByUserId: input.performedByUserId ?? null,
      performedByProviderId: input.performedByProviderId ?? null,
      recordedByUserId: session.user.id,
      notes: input.notes ?? null,
      effortMinutes: input.effortMinutes ?? null,
      outcome: input.outcome,
      materials: input.materials?.map((line) => ({
        partId: line.partId,
        lotId: line.lotId ?? null,
        expectedQtyMilli: line.expectedQtyMilli ?? null,
        actualQtyMilli: line.actualQtyMilli,
        resolutionIfShort: line.resolutionIfShort,
        notes: line.notes ?? null,
      })),
      source: "web",
      ...(input.replacement === undefined
        ? {}
        : {
            replacement: {
              reason: input.replacement.reason,
              cloneConsumables: input.replacement.cloneConsumables,
              cloneHaLinks: input.replacement.cloneHaLinks,
              notes: input.replacement.notes ?? null,
              newAsset:
                input.replacement.existingAssetId !== undefined
                  ? { existingAssetId: input.replacement.existingAssetId }
                  : {
                      ...(input.replacement.newAsset ?? {}),
                      manufacturer: input.replacement.newAsset?.manufacturer ?? null,
                      modelName: input.replacement.newAsset?.modelName ?? null,
                      serialNumber: input.replacement.newAsset?.serialNumber ?? null,
                      productCode: input.replacement.newAsset?.productCode ?? null,
                      notes: input.replacement.newAsset?.notes ?? null,
                    },
            },
          }),
    };

    const result = domainCall("complete", () => completeOccurrence(handle, ctx, payload));
    revalidateMaintenance(input.occurrenceId, result.completion.planId ?? undefined);
    return {
      completionId: result.completion.id,
      idempotentReplay: result.idempotentReplay,
      stockResolution: result.stockResolution,
      nextOccurrenceId: result.next?.id ?? null,
      nextDueDate: result.next?.dueDate ?? null,
      replacement: result.replacement,
      lines: result.lines,
    };
  },
);

/**
 * Undo a completion. Nothing is deleted: the completion row and its material lines stay, every
 * stock row is reversed by a mirror row, and the occurrence reopens (§5.4).
 *
 * A successor somebody has already worked on refuses the void with `successor_touched` rather than
 * being quietly cancelled.
 */
export const voidTaskCompletion = action(
  z.object({
    completionId: id,
    occurrenceId: id,
    reason: reason,
    requestId: z.string().min(8).max(128),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const result = domainCall("void", () =>
      voidCompletion(handle, ctx, {
        completionId: input.completionId,
        reason: input.reason,
        requestId: input.requestId,
      }),
    );
    revalidateMaintenance(input.occurrenceId, result.completion.planId ?? undefined);
    return {
      completionId: result.completion.id,
      reversals: result.reversals.length,
      idempotentReplay: result.idempotentReplay,
    };
  },
);

/**
 * Fix a typo without voiding: notes, effort, outcome, who did it, the date, and quantities. A
 * changed quantity writes a `correction` row for the delta — the original consumption row is never
 * touched.
 */
export const correctTaskCompletion = action(
  z.object({
    completionId: id,
    occurrenceId: id,
    notes: optionalNote.nullish(),
    effortMinutes: minutes.nullish(),
    outcome: z.enum(COMPLETION_OUTCOMES).optional(),
    performedByUserId: id.nullish(),
    performedByProviderId: id.nullish(),
    /** "It was actually done on Tuesday" — a household-local date, converted server-side. */
    completedDate: localDate.optional(),
    completedTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    materials: z
      .array(z.object({ partId: id, lotId: id.nullish(), actualQtyMilli: qtyMilli }))
      .max(50)
      .optional(),
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx, settings } = maintenanceContext(session.user.id);
    const result = domainCall("correct", () =>
      correctCompletion(handle, ctx, {
        completionId: input.completionId,
        notes: input.notes ?? undefined,
        effortMinutes: input.effortMinutes ?? undefined,
        outcome: input.outcome,
        performedByUserId: input.performedByUserId ?? undefined,
        performedByProviderId: input.performedByProviderId ?? undefined,
        completedAtMs:
          input.completedDate === undefined
            ? undefined
            : instantOf(input.completedDate, input.completedTime ?? "12:00", settings.timezone),
        materials: input.materials?.map((line) => ({
          partId: line.partId,
          lotId: line.lotId ?? null,
          actualQtyMilli: line.actualQtyMilli,
        })),
        requestId: input.idempotencyKey ?? null,
      }),
    );
    revalidateMaintenance(input.occurrenceId, result.completion.planId ?? undefined);
    return {
      completionId: result.completion.id,
      corrections: result.corrections.length,
      regeneratedSuccessor: result.regeneratedSuccessor,
    };
  },
);

