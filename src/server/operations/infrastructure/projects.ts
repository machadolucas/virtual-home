import "server-only";

import { revalidatePath } from "@/server/operations/core";
import { and, eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { attachment, attachmentLink, project, projectLink } from "@/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { writeAudit } from "@/domain/inventory";
import { defineOperation as action } from "@/server/operations/core";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import { userContext } from "@/server/queries/settings/household";
import { linkTargetExists } from "@/server/queries/infrastructure/projects";
import {
  addProjectAttachmentInput,
  addProjectLinkInput,
  createProjectInput,
  deleteProjectInput,
  removeProjectAttachmentInput,
  removeProjectLinkInput,
  updateProjectInput,
} from "@/server/actions/infrastructure/schemas";

/**
 * Project writes: the renovation, repair or installation a set of facts belongs to.
 *
 * A project is a **container**, never a source of truth about work. It links to completions that
 * were recorded elsewhere; it does not create them, back-date them or infer them from its own
 * dates (CLAUDE.md rule 6). Setting a project to `done` therefore changes nothing about
 * maintenance history — that is the whole reason the timeline is built from links.
 *
 * Every link is checked for existence before it is written, because `project_link` is polymorphic
 * and SQLite cannot declare the FK; a dangling link would otherwise be a lie the detail page
 * repeats.
 */

function revalidateProjects(projectId?: string): void {
  revalidatePath("/projects");
  if (projectId !== undefined) revalidatePath(`/projects/${projectId}`);
}

/** `ck_project_dates`: an end date with no start date is not a range, it is a typo. */
function assertDates(startedOn: string | null, endedOn: string | null): void {
  if (endedOn !== null && startedOn === null)
    throw new ValidationError(
      "ended_without_started",
      "an end date needs a start date — otherwise the project has no span at all",
    );
  if (startedOn !== null && endedOn !== null && endedOn < startedOn)
    throw new ValidationError("ended_before_started", "the project cannot end before it started", {
      startedOn,
      endedOn,
    });
}

export const createProject = action(createProjectInput, (input, session) => {
  const { db } = getDb();
  const startedOn = input.startedOn ?? null;
  const endedOn = input.endedOn ?? null;
  // Inside `mapDomainErrors` so the domain's own code reaches the form, not a generic "internal".
  mapDomainErrors(() => assertDates(startedOn, endedOn));

  const id = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const at = nowMs();
      const projectId = newId();
      tx
        .insert(project)
        .values({
          id: projectId,
          name: input.name,
          kind: input.kind,
          status: input.status,
          startedOn,
          endedOn,
          budgetCents: input.budgetCents ?? null,
          actualCostCents: input.actualCostCents ?? null,
          currency: input.currency ?? "EUR",
          summary: input.summary ?? null,
          notes: input.notes ?? null,
          createdAtMs: at,
          createdBy: ctx.actorUserId,
          updatedAtMs: at,
          updatedBy: ctx.actorUserId,
        })
        .run();
      writeAudit(tx, ctx, {
        entityTable: "project",
        entityId: projectId,
        action: "create",
        summary: `created project “${input.name}”`,
      });
      return projectId;
    }),
  );

  revalidateProjects(id);
  return { id };
});

export const updateProject = action(updateProjectInput, (input, session) => {
  const { db } = getDb();
  const startedOn = input.startedOn ?? null;
  const endedOn = input.endedOn ?? null;
  mapDomainErrors(() => assertDates(startedOn, endedOn));

  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const existing = tx.select().from(project).where(eq(project.id, input.id)).get();
      if (!existing) throw new NotFoundError("project", input.id);
      tx
        .update(project)
        .set({
          name: input.name,
          kind: input.kind,
          status: input.status,
          startedOn,
          endedOn,
          budgetCents: input.budgetCents ?? null,
          actualCostCents: input.actualCostCents ?? null,
          currency: input.currency ?? "EUR",
          summary: input.summary ?? null,
          notes: input.notes ?? null,
          updatedAtMs: nowMs(),
          updatedBy: ctx.actorUserId,
        })
        .where(eq(project.id, input.id))
        .run();
      writeAudit(tx, ctx, {
        entityTable: "project",
        entityId: input.id,
        action: "update",
        summary: `updated project “${input.name}”`,
        changes: { status: [existing.status, input.status], name: [existing.name, input.name] },
      });
    }),
  );

  revalidateProjects(input.id);
  return { id: input.id };
});

/**
 * Deleting a project removes the container and its links. It removes **nothing** it linked to:
 * `project_link` cascades, `infra_route.project_id` is `ON DELETE SET NULL`, and the attachment
 * rows survive because the files may be referenced elsewhere — only this project's links go.
 */
export const deleteProject = action(deleteProjectInput, (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const existing = tx
        .select({ id: project.id, name: project.name })
        .from(project)
        .where(eq(project.id, input.id))
        .get();
      if (!existing) throw new NotFoundError("project", input.id);
      tx
        .delete(attachmentLink)
        .where(
          and(eq(attachmentLink.entityKind, "project"), eq(attachmentLink.entityId, input.id)),
        )
        .run();
      tx.delete(project).where(eq(project.id, input.id)).run();
      writeAudit(tx, ctx, {
        entityTable: "project",
        entityId: input.id,
        action: "delete",
        summary: `deleted project “${existing.name}”`,
      });
    }),
  );

  revalidateProjects();
  return { id: input.id };
});

export const addProjectLink = action(addProjectLinkInput, (input, session) => {
  const { db } = getDb();
  const id = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const owner = tx.select({ id: project.id }).from(project).where(eq(project.id, input.projectId)).get();
      if (!owner) throw new NotFoundError("project", input.projectId);
      // The existence check that SQLite cannot express as a constraint.
      if (!linkTargetExists(tx, input.entityKind, input.entityId))
        throw new NotFoundError(input.entityKind, input.entityId);

      const linkId = newId();
      const inserted = tx
        .insert(projectLink)
        .values({
          id: linkId,
          projectId: input.projectId,
          entityKind: input.entityKind,
          entityId: input.entityId,
          role: input.role ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: projectLink.id })
        .all();
      if (inserted.length === 0)
        throw new ConflictError("link_exists", "that is already linked to this project", {
          entityKind: input.entityKind,
          entityId: input.entityId,
        });
      writeAudit(tx, ctx, {
        entityTable: "project_link",
        entityId: linkId,
        action: "create",
        summary: `linked ${input.entityKind} to a project`,
      });
      return linkId;
    }),
  );

  revalidateProjects(input.projectId);
  return { id };
});

export const removeProjectLink = action(removeProjectLinkInput, (input, session) => {
  const { db } = getDb();
  const projectId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const existing = tx
        .select({ id: projectLink.id, projectId: projectLink.projectId, entityKind: projectLink.entityKind })
        .from(projectLink)
        .where(eq(projectLink.id, input.linkId))
        .get();
      if (!existing) throw new NotFoundError("project_link", input.linkId);
      tx.delete(projectLink).where(eq(projectLink.id, input.linkId)).run();
      writeAudit(tx, ctx, {
        entityTable: "project_link",
        entityId: input.linkId,
        action: "delete",
        summary: `unlinked ${existing.entityKind} from a project`,
      });
      return existing.projectId;
    }),
  );

  revalidateProjects(projectId);
  return { projectId };
});

/**
 * Attach an already-uploaded file. Uploading happens at `POST /api/upload`, which sniffs the type,
 * strips GPS from photos and dedupes by hash; this action only records what the file *is to this
 * project* — the before shot, the after shot, the receipt.
 */
export const addProjectAttachment = action(addProjectAttachmentInput, (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const owner = tx.select({ id: project.id }).from(project).where(eq(project.id, input.projectId)).get();
      if (!owner) throw new NotFoundError("project", input.projectId);
      const file = tx
        .select({ id: attachment.id })
        .from(attachment)
        .where(eq(attachment.id, input.attachmentId))
        .get();
      if (!file) throw new NotFoundError("attachment", input.attachmentId);

      const seq = tx
        .select({ id: attachmentLink.id })
        .from(attachmentLink)
        .where(
          and(
            eq(attachmentLink.entityKind, "project"),
            eq(attachmentLink.entityId, input.projectId),
          ),
        )
        .all().length;

      tx
        .insert(attachmentLink)
        .values({
          id: newId(),
          attachmentId: input.attachmentId,
          entityKind: "project",
          entityId: input.projectId,
          role: input.role,
          seq,
        })
        .onConflictDoNothing()
        .run();
      writeAudit(tx, ctx, {
        entityTable: "attachment_link",
        entityId: input.attachmentId,
        action: "create",
        summary: `attached a ${input.role} file to a project`,
      });
    }),
  );

  revalidateProjects(input.projectId);
  return { attachmentId: input.attachmentId };
});

/**
 * Unlink a file from the project. The `attachment` row and the bytes on disk are untouched: the
 * same photo may be a project's "after" shot and a piece of equipment's nameplate, and deleting
 * blobs is a separate, deliberate operation.
 */
export const removeProjectAttachment = action(
  removeProjectAttachmentInput,
  (input, session) => {
    const { db } = getDb();
    mapDomainErrors(() =>
      writeTx(db, (tx) => {
        const ctx = userContext(session, tx);
        tx
          .delete(attachmentLink)
          .where(
            and(
              eq(attachmentLink.entityKind, "project"),
              eq(attachmentLink.entityId, input.projectId),
              eq(attachmentLink.attachmentId, input.attachmentId),
              eq(attachmentLink.role, input.role),
            ),
          )
          .run();
        writeAudit(tx, ctx, {
          entityTable: "attachment_link",
          entityId: input.attachmentId,
          action: "delete",
          summary: `detached a ${input.role} file from a project`,
        });
      }),
    );

    revalidateProjects(input.projectId);
    return { attachmentId: input.attachmentId };
  },
);
