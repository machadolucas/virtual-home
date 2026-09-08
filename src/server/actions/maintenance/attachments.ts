"use server";
/**
 * Linking uploaded files to a task.
 *
 * The bytes never travel through a server action: the client posts the file to `/api/upload`,
 * which sniffs the type, strips GPS, dedupes by sha256 and returns an `attachment.id`. This action
 * only records the relationship — which keeps the 25 MiB path out of the action body-size limit
 * and keeps one auditable place where files enter the data directory.
 */
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { newId } from "@/db/ids";
import { attachment, attachmentLink } from "@/db/schema/attachments";
import { completion, maintenanceOccurrence } from "@/db/schema/maintenance";
import { NotFoundError } from "@/domain/errors";
import { writeAuditLog } from "@/domain/occurrence";
import { action } from "@/server/api/action";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { domainCall, id, idempotencyKey, revalidateMaintenance } from "./shared";

const scope = z.enum(["occurrence", "completion"]);

export const linkTaskPhoto = action(
  z.object({
    attachmentId: id,
    scope,
    entityId: id,
    /** `'before'`, `'after'`, `'nameplate'`, `'receipt'` — free text, small vocabulary. */
    role: z.string().trim().max(40).nullish(),
    /** For revalidation, and so the caller does not have to look it up again. */
    occurrenceId: id,
    idempotencyKey: idempotencyKey.optional(),
  }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    const linkId = domainCall("link_photo", () =>
      writeTx(handle.db, (tx) => {
        const file = tx
          .select({ id: attachment.id, kind: attachment.kind })
          .from(attachment)
          .where(eq(attachment.id, input.attachmentId))
          .get();
        if (!file) throw new NotFoundError("attachment", input.attachmentId);

        if (input.scope === "occurrence") {
          const occ = tx
            .select({ id: maintenanceOccurrence.id })
            .from(maintenanceOccurrence)
            .where(eq(maintenanceOccurrence.id, input.entityId))
            .get();
          if (!occ) throw new NotFoundError("maintenance_occurrence", input.entityId);
        } else {
          const row = tx
            .select({ id: completion.id })
            .from(completion)
            .where(eq(completion.id, input.entityId))
            .get();
          if (!row) throw new NotFoundError("completion", input.entityId);
        }

        // `ux_attachment_link` cannot dedupe rows whose `role` is NULL (SQLite treats NULLs as
        // distinct), so the same-file check is explicit.
        const existing = tx
          .select({ id: attachmentLink.id })
          .from(attachmentLink)
          .where(
            and(
              eq(attachmentLink.attachmentId, input.attachmentId),
              eq(attachmentLink.entityKind, input.scope),
              eq(attachmentLink.entityId, input.entityId),
            ),
          )
          .all();
        if (existing.length > 0) return existing[0]!.id;

        const next = tx
          .select({ maxSeq: sql<number>`COALESCE(MAX(${attachmentLink.seq}), -1)` })
          .from(attachmentLink)
          .where(
            and(
              eq(attachmentLink.entityKind, input.scope),
              eq(attachmentLink.entityId, input.entityId),
            ),
          )
          .get();

        const rowId = newId();
        tx.insert(attachmentLink)
          .values({
            id: rowId,
            attachmentId: input.attachmentId,
            entityKind: input.scope,
            entityId: input.entityId,
            role: input.role ?? null,
            seq: (next?.maxSeq ?? -1) + 1,
          })
          .run();
        writeAuditLog(tx, ctx, {
          entityTable: "attachment_link",
          entityId: rowId,
          action: "created",
          summary: `Attached ${file.kind} to ${input.scope} ${input.entityId}`,
        });
        return rowId;
      }),
    );
    revalidateMaintenance(input.occurrenceId);
    return { linkId };
  },
);

/**
 * Remove a photo from a task.
 *
 * Only the *link* is deleted; the blob and its `attachment` row stay, because the same file may be
 * linked elsewhere and because deleting household photos from a UI button is not a thing this app
 * does. Reclaiming orphaned blobs is an operations job, not a click.
 */
export const unlinkTaskPhoto = action(
  z.object({ linkId: id, occurrenceId: id, idempotencyKey: idempotencyKey.optional() }),
  async (input, session) => {
    const { handle, ctx } = maintenanceContext(session.user.id);
    domainCall("unlink_photo", () =>
      writeTx(handle.db, (tx) => {
        const row = tx
          .select()
          .from(attachmentLink)
          .where(eq(attachmentLink.id, input.linkId))
          .get();
        if (!row) throw new NotFoundError("attachment_link", input.linkId);
        tx.delete(attachmentLink).where(eq(attachmentLink.id, input.linkId)).run();
        writeAuditLog(tx, ctx, {
          entityTable: "attachment_link",
          entityId: input.linkId,
          action: "deleted",
          summary: `Detached a file from ${row.entityKind} ${row.entityId} (the file itself is kept)`,
        });
      }),
    );
    revalidateMaintenance(input.occurrenceId);
    return { linkId: input.linkId };
  },
);
