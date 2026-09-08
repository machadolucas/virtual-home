"use server";
/**
 * Procedure authoring: one editable draft, publish to freeze, edit again to fork a new draft.
 *
 * Immutability of a published version is a service-layer invariant (`src/db/schema/procedures.ts`),
 * and this is the service layer. Every write here refuses to touch a version whose status is not
 * `draft`; `startProcedureDraft` is the only way forward from a published version, and it copies
 * rather than mutates — which is what lets an occurrence generated last April still show the steps
 * that were in force last April.
 */
import { z } from "zod";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { writeTx, type Db } from "@/db/client";
import { newId } from "@/db/ids";
import { part } from "@/db/schema/inventory";
import {
  CHECKLIST_VALUE_KINDS,
  PROCEDURE_REFERENCE_KINDS,
  procedure,
  procedureChecklistItem,
  procedureEquipmentNote,
  procedureMaterial,
  procedureReference,
  procedureStep,
  procedureTool,
  procedureVersion,
} from "@/db/schema/procedures";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { writeAuditLog } from "@/domain/occurrence";
import { action } from "@/server/api/action";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import {
  domainCall,
  id,
  idempotencyKey,
  optionalNote,
  positiveQtyMilli,
  revalidateMaintenance,
} from "./shared";

const checklistItem = z.object({
  text: z.string().trim().min(1).max(300),
  requiresValue: z.enum(CHECKLIST_VALUE_KINDS).nullish(),
  unit: z.string().trim().max(30).nullish(),
});

const step = z.object({
  title: z.string().trim().min(1).max(200),
  bodyMd: optionalNote.nullish(),
  expectedMinutes: z.number().int().min(1).max(100_000).nullish(),
  isOptional: z.boolean(),
  warning: z.string().trim().max(1000).nullish(),
  checklist: z.array(checklistItem).max(40),
});

const draftContent = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(1000).nullish(),
  defaultEffortMinutes: z.number().int().min(1).max(100_000).nullish(),
  prerequisites: optionalNote.nullish(),
  safetyNotes: optionalNote.nullish(),
  steps: z.array(step).max(60),
  /** Checklist items that belong to the whole procedure rather than to one step. */
  looseChecklist: z.array(checklistItem).max(40),
  tools: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        isRequired: z.boolean(),
        notes: z.string().trim().max(300).nullish(),
      }),
    )
    .max(40),
  materials: z
    .array(
      z.object({
        partId: id,
        qtyMilli: positiveQtyMilli,
        isRequired: z.boolean(),
        notes: z.string().trim().max(300).nullish(),
      }),
    )
    .max(40),
  references: z
    .array(
      z.object({
        kind: z.enum(PROCEDURE_REFERENCE_KINDS),
        label: z.string().trim().min(1).max(200),
        url: z.string().trim().max(1000).nullish(),
        manualName: z.string().trim().max(200).nullish(),
        pageFrom: z.number().int().min(1).max(10_000).nullish(),
        pageTo: z.number().int().min(1).max(10_000).nullish(),
        attachmentId: id.nullish(),
      }),
    )
    .max(40),
  equipmentNotes: z
    .array(
      z.object({
        assetId: id.nullish(),
        assetModelName: z.string().trim().max(200).nullish(),
        note: z.string().trim().min(1).max(2000),
      }),
    )
    .max(40),
});

/** `Replace the ventilation filters` → `replace-the-ventilation-filters`, made unique. */
function slugFor(tx: Db, title: string): string {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "procedure";
  const taken = new Set(
    tx
      .select({ slug: procedure.slug })
      .from(procedure)
      .all()
      .map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i < 200; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${newId().slice(0, 8)}`;
}

function nextVersionNumber(tx: Db, procedureId: string): number {
  const latest = tx
    .select({ version: procedureVersion.version })
    .from(procedureVersion)
    .where(eq(procedureVersion.procedureId, procedureId))
    .orderBy(desc(procedureVersion.version))
    .get();
  return (latest?.version ?? 0) + 1;
}

function draftOf(tx: Db, procedureId: string): typeof procedureVersion.$inferSelect | null {
  return (
    tx
      .select()
      .from(procedureVersion)
      .where(
        and(eq(procedureVersion.procedureId, procedureId), eq(procedureVersion.status, "draft")),
      )
      .get() ?? null
  );
}

/** Replace every child row of a draft version with the submitted content. */
function writeDraftChildren(
  tx: Db,
  versionId: string,
  content: z.infer<typeof draftContent>,
): void {
  const partIds = [...new Set(content.materials.map((line) => line.partId))];
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

  // Children first: `procedure_checklist_item.step_id` cascades from the step, so deleting steps
  // before checklist items would take step-level items with them and leave the loose ones behind.
  tx.delete(procedureChecklistItem).where(eq(procedureChecklistItem.versionId, versionId)).run();
  tx.delete(procedureStep).where(eq(procedureStep.versionId, versionId)).run();
  tx.delete(procedureTool).where(eq(procedureTool.versionId, versionId)).run();
  tx.delete(procedureMaterial).where(eq(procedureMaterial.versionId, versionId)).run();
  tx.delete(procedureReference).where(eq(procedureReference.versionId, versionId)).run();
  tx.delete(procedureEquipmentNote).where(eq(procedureEquipmentNote.versionId, versionId)).run();

  content.steps.forEach((row, index) => {
    const stepId = newId();
    tx.insert(procedureStep)
      .values({
        id: stepId,
        versionId,
        seq: index,
        title: row.title,
        bodyMd: row.bodyMd ?? null,
        expectedMinutes: row.expectedMinutes ?? null,
        isOptional: row.isOptional,
        warning: row.warning ?? null,
      })
      .run();
    row.checklist.forEach((item, itemIndex) => {
      tx.insert(procedureChecklistItem)
        .values({
          id: newId(),
          versionId,
          stepId,
          seq: itemIndex,
          text: item.text,
          requiresValue: item.requiresValue ?? null,
          unit: item.unit ?? null,
        })
        .run();
    });
  });

  content.looseChecklist.forEach((item, index) => {
    tx.insert(procedureChecklistItem)
      .values({
        id: newId(),
        versionId,
        stepId: null,
        seq: index,
        text: item.text,
        requiresValue: item.requiresValue ?? null,
        unit: item.unit ?? null,
      })
      .run();
  });

  for (const tool of content.tools) {
    tx.insert(procedureTool)
      .values({
        id: newId(),
        versionId,
        name: tool.name,
        isRequired: tool.isRequired,
        notes: tool.notes ?? null,
      })
      .run();
  }

  const seenParts = new Set<string>();
  for (const line of content.materials) {
    if (seenParts.has(line.partId)) continue;
    seenParts.add(line.partId);
    tx.insert(procedureMaterial)
      .values({
        id: newId(),
        versionId,
        partId: line.partId,
        qtyMilli: line.qtyMilli,
        isRequired: line.isRequired,
        notes: line.notes ?? null,
      })
      .run();
  }

  for (const ref of content.references) {
    if (ref.pageTo !== null && ref.pageTo !== undefined && (ref.pageFrom ?? null) === null) {
      throw new ValidationError("page_range", "a page range needs a first page");
    }
    tx.insert(procedureReference)
      .values({
        id: newId(),
        versionId,
        kind: ref.kind,
        label: ref.label,
        url: ref.url ?? null,
        manualName: ref.manualName ?? null,
        pageFrom: ref.pageFrom ?? null,
        pageTo: ref.pageTo ?? null,
        attachmentId: ref.attachmentId ?? null,
      })
      .run();
  }

  for (const note of content.equipmentNotes) {
    if ((note.assetId ?? null) === null && (note.assetModelName ?? null) === null) {
      throw new ValidationError(
        "equipment_note_target",
        "an equipment note needs either a specific unit or a model name",
      );
    }
    tx.insert(procedureEquipmentNote)
      .values({
        id: newId(),
        versionId,
        assetId: note.assetId ?? null,
        assetModelName: note.assetModelName ?? null,
        note: note.note,
      })
      .run();
  }
}

/** Create a procedure with an empty first draft. Nothing is published until someone says so. */
export const createProcedure = action(
  z.object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(1000).nullish(),
    defaultEffortMinutes: z.number().int().min(1).max(100_000).nullish(),
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const result = domainCall("create_procedure", () =>
      writeTx(handle.db, (tx) => {
        const now = ctx.clock.now();
        const procedureId = newId();
        const versionId = newId();
        tx.insert(procedure)
          .values({
            id: procedureId,
            title: input.title,
            slug: slugFor(tx, input.title),
            summary: input.summary ?? null,
            defaultEffortMinutes: input.defaultEffortMinutes ?? null,
            createdAtMs: now,
            updatedAtMs: now,
            createdBy: ctx.actorUserId,
            updatedBy: ctx.actorUserId,
          })
          .run();
        tx.insert(procedureVersion)
          .values({
            id: versionId,
            procedureId,
            version: 1,
            status: "draft",
            createdAtMs: now,
            updatedAtMs: now,
            createdBy: ctx.actorUserId,
            updatedBy: ctx.actorUserId,
          })
          .run();
        writeAuditLog(tx, ctx, {
          entityTable: "procedure",
          entityId: procedureId,
          action: "created",
          summary: `Created procedure "${input.title}" (draft v1)`,
        });
        return { procedureId, versionId };
      }),
    );
    revalidateMaintenance();
    return result;
  },
);

/**
 * Save the draft. Creates the draft first when the procedure only has published versions, so
 * "edit" from a published procedure is one click rather than two concepts.
 */
export const saveProcedureDraft = action(
  z.object({
    procedureId: id,
    content: draftContent,
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const versionId = domainCall("save_draft", () =>
      writeTx(handle.db, (tx) => {
        const row = tx.select().from(procedure).where(eq(procedure.id, input.procedureId)).get();
        if (!row) throw new NotFoundError("procedure", input.procedureId);
        const now = ctx.clock.now();

        let draft = draftOf(tx, input.procedureId);
        if (draft === null) {
          const draftId = newId();
          tx.insert(procedureVersion)
            .values({
              id: draftId,
              procedureId: input.procedureId,
              version: nextVersionNumber(tx, input.procedureId),
              status: "draft",
              createdAtMs: now,
              updatedAtMs: now,
              createdBy: ctx.actorUserId,
              updatedBy: ctx.actorUserId,
            })
            .run();
          draft = tx.select().from(procedureVersion).where(eq(procedureVersion.id, draftId)).get()!;
        }

        tx.update(procedure)
          .set({
            title: input.content.title,
            summary: input.content.summary ?? null,
            defaultEffortMinutes: input.content.defaultEffortMinutes ?? null,
            updatedAtMs: now,
            updatedBy: ctx.actorUserId,
          })
          .where(eq(procedure.id, input.procedureId))
          .run();

        tx.update(procedureVersion)
          .set({
            prerequisites: input.content.prerequisites ?? null,
            safetyNotes: input.content.safetyNotes ?? null,
            updatedAtMs: now,
            updatedBy: ctx.actorUserId,
          })
          .where(eq(procedureVersion.id, draft.id))
          .run();

        writeDraftChildren(tx, draft.id, input.content);
        writeAuditLog(tx, ctx, {
          entityTable: "procedure_version",
          entityId: draft.id,
          action: "updated",
          summary: `Saved draft v${draft.version} of "${input.content.title}"`,
        });
        return draft.id;
      }),
    );
    revalidateMaintenance();
    return { versionId };
  },
);

/**
 * Publish the draft: it becomes the version in force and freezes. Existing occurrences keep
 * whichever version they were generated with — publishing never rewrites open work.
 */
export const publishProcedureDraft = action(
  z.object({
    procedureId: id,
    changeNote: z.string().trim().max(1000).nullish(),
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const result = domainCall("publish", () =>
      writeTx(handle.db, (tx) => {
        const row = tx.select().from(procedure).where(eq(procedure.id, input.procedureId)).get();
        if (!row) throw new NotFoundError("procedure", input.procedureId);
        const draft = draftOf(tx, input.procedureId);
        if (draft === null) {
          throw new ConflictError("no_draft", "there is no draft to publish");
        }
        const steps = tx
          .select({ id: procedureStep.id })
          .from(procedureStep)
          .where(eq(procedureStep.versionId, draft.id))
          .all();
        if (steps.length === 0) {
          throw new ValidationError(
            "no_steps",
            "a published procedure needs at least one step — otherwise a task shows empty instructions",
          );
        }
        const now = ctx.clock.now();

        // Whatever was in force becomes `superseded`; nothing is deleted, so an occurrence that
        // froze it still resolves.
        tx.update(procedureVersion)
          .set({ status: "superseded", updatedAtMs: now, updatedBy: ctx.actorUserId })
          .where(
            and(
              eq(procedureVersion.procedureId, input.procedureId),
              eq(procedureVersion.status, "published"),
              ne(procedureVersion.id, draft.id),
            ),
          )
          .run();

        tx.update(procedureVersion)
          .set({
            status: "published",
            publishedAtMs: now,
            publishedBy: ctx.actorUserId,
            changeNote: input.changeNote ?? null,
            updatedAtMs: now,
            updatedBy: ctx.actorUserId,
          })
          .where(eq(procedureVersion.id, draft.id))
          .run();

        tx.update(procedure)
          .set({ currentVersionId: draft.id, updatedAtMs: now, updatedBy: ctx.actorUserId })
          .where(eq(procedure.id, input.procedureId))
          .run();

        writeAuditLog(tx, ctx, {
          entityTable: "procedure_version",
          entityId: draft.id,
          action: "published",
          summary: `Published "${row.title}" v${draft.version}${input.changeNote ? ` — ${input.changeNote}` : ""}`,
        });
        return { versionId: draft.id, version: draft.version };
      }),
    );
    revalidateMaintenance();
    return result;
  },
);

/**
 * Fork the version in force into a new editable draft, copying every child row. The published
 * version is left exactly as it is — that is what "frozen" means.
 */
export const startProcedureDraft = action(
  z.object({ procedureId: id, idempotencyKey: idempotencyKey.optional() }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const result = domainCall("start_draft", () =>
      writeTx(handle.db, (tx) => {
        const row = tx.select().from(procedure).where(eq(procedure.id, input.procedureId)).get();
        if (!row) throw new NotFoundError("procedure", input.procedureId);
        const existing = draftOf(tx, input.procedureId);
        if (existing !== null) return { versionId: existing.id, created: false };
        if (row.currentVersionId === null) {
          throw new ConflictError("nothing_to_copy", "this procedure has no published version yet");
        }

        const source = tx
          .select()
          .from(procedureVersion)
          .where(eq(procedureVersion.id, row.currentVersionId))
          .get();
        if (!source) throw new NotFoundError("procedure_version", row.currentVersionId);

        const now = ctx.clock.now();
        const draftId = newId();
        tx.insert(procedureVersion)
          .values({
            id: draftId,
            procedureId: input.procedureId,
            version: nextVersionNumber(tx, input.procedureId),
            status: "draft",
            prerequisites: source.prerequisites,
            safetyNotes: source.safetyNotes,
            createdAtMs: now,
            updatedAtMs: now,
            createdBy: ctx.actorUserId,
            updatedBy: ctx.actorUserId,
          })
          .run();

        copyVersionChildren(tx, source.id, draftId);
        writeAuditLog(tx, ctx, {
          entityTable: "procedure_version",
          entityId: draftId,
          action: "created",
          summary: `Started a draft from "${row.title}" v${source.version}`,
        });
        return { versionId: draftId, created: true };
      }),
    );
    revalidateMaintenance();
    return result;
  },
);

function copyVersionChildren(tx: Db, fromVersionId: string, toVersionId: string): void {
  const stepIdMap = new Map<string, string>();
  for (const row of tx
    .select()
    .from(procedureStep)
    .where(eq(procedureStep.versionId, fromVersionId))
    .orderBy(asc(procedureStep.seq))
    .all()) {
    const newStepId = newId();
    stepIdMap.set(row.id, newStepId);
    tx.insert(procedureStep)
      .values({ ...row, id: newStepId, versionId: toVersionId })
      .run();
  }
  for (const row of tx
    .select()
    .from(procedureChecklistItem)
    .where(eq(procedureChecklistItem.versionId, fromVersionId))
    .orderBy(asc(procedureChecklistItem.seq))
    .all()) {
    tx.insert(procedureChecklistItem)
      .values({
        ...row,
        id: newId(),
        versionId: toVersionId,
        stepId: row.stepId === null ? null : (stepIdMap.get(row.stepId) ?? null),
      })
      .run();
  }
  for (const row of tx
    .select()
    .from(procedureTool)
    .where(eq(procedureTool.versionId, fromVersionId))
    .all()) {
    tx.insert(procedureTool).values({ ...row, id: newId(), versionId: toVersionId }).run();
  }
  for (const row of tx
    .select()
    .from(procedureMaterial)
    .where(eq(procedureMaterial.versionId, fromVersionId))
    .all()) {
    tx.insert(procedureMaterial).values({ ...row, id: newId(), versionId: toVersionId }).run();
  }
  for (const row of tx
    .select()
    .from(procedureReference)
    .where(eq(procedureReference.versionId, fromVersionId))
    .all()) {
    tx.insert(procedureReference).values({ ...row, id: newId(), versionId: toVersionId }).run();
  }
  for (const row of tx
    .select()
    .from(procedureEquipmentNote)
    .where(eq(procedureEquipmentNote.versionId, fromVersionId))
    .all()) {
    tx.insert(procedureEquipmentNote).values({ ...row, id: newId(), versionId: toVersionId }).run();
  }
}

/** Discard the draft, keeping the published version in force. */
export const discardProcedureDraft = action(
  z.object({ procedureId: id, idempotencyKey: idempotencyKey.optional() }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    domainCall("discard_draft", () =>
      writeTx(handle.db, (tx) => {
        const draft = draftOf(tx, input.procedureId);
        if (draft === null) throw new ConflictError("no_draft", "there is no draft to discard");
        if (draft.version === 1) {
          // A v1 draft is the whole procedure; discarding it would leave a procedure with no
          // versions at all, which nothing else in the app expects.
          throw new ConflictError(
            "first_draft",
            "the first draft cannot be discarded — publish it or archive the procedure",
          );
        }
        tx.delete(procedureVersion).where(eq(procedureVersion.id, draft.id)).run();
        writeAuditLog(tx, ctx, {
          entityTable: "procedure_version",
          entityId: draft.id,
          action: "deleted",
          summary: `Discarded draft v${draft.version}`,
        });
      }),
    );
    revalidateMaintenance();
    return { procedureId: input.procedureId };
  },
);
