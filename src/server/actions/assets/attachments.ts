"use server";
/**
 * Linking uploaded files to a piece of equipment.
 *
 * Mirrors `src/server/actions/maintenance/attachments.ts`: the bytes never travel through a server
 * action. The client posts the file to `/api/upload`, which sniffs the type, strips GPS, dedupes by
 * sha256 and returns an `attachment.id`; this action only records the `attachment_link` row
 * (`entityKind: 'asset'`) — which keeps the upload's 25 MiB path out of the action body-size limit
 * and keeps one auditable place where files enter the data directory.
 */
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, writeTx } from "@/db/client";
import { newId } from "@/db/ids";
import { asset, attachment, attachmentLink } from "@/db/schema";
import { NotFoundError } from "@/domain/errors";
import { writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { userContext } from "@/server/queries/settings/household";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import { ASSET_ATTACHMENT_ROLES } from "@/features/assets/labels";

function revalidateAsset(assetId: string): void {
  revalidatePath(`/equipment/${assetId}`);
}

export const linkAssetAttachment = action(
  z.object({
    assetId: z.string().min(1),
    attachmentId: z.string().min(1),
    role: z.enum(ASSET_ATTACHMENT_ROLES),
    caption: z
      .string()
      .trim()
      .max(500)
      .transform((value) => (value === "" ? null : value))
      .nullish(),
    idempotencyKey: z.string().min(8).max(200).optional(),
  }),
  async (input, session) => {
    const { db } = getDb();
    const linkId = mapDomainErrors(() =>
      writeTx(db, (tx) => {
        const ctx = userContext(session, tx);

        const assetRow = tx.select({ id: asset.id }).from(asset).where(eq(asset.id, input.assetId)).get();
        if (!assetRow) throw new NotFoundError("asset", input.assetId);

        const file = tx
          .select({ id: attachment.id, kind: attachment.kind })
          .from(attachment)
          .where(eq(attachment.id, input.attachmentId))
          .get();
        if (!file) throw new NotFoundError("attachment", input.attachmentId);

        if (input.caption !== undefined) {
          tx.update(attachment)
            .set({ caption: input.caption })
            .where(eq(attachment.id, input.attachmentId))
            .run();
        }

        // `ux_attachment_link` cannot dedupe rows whose `role` is NULL, but every asset link here
        // carries a role, so the same (attachment, asset, role) triple is the natural same-file
        // check — re-posting the same upload with the same role is a no-op, not a duplicate row.
        const existing = tx
          .select({ id: attachmentLink.id })
          .from(attachmentLink)
          .where(
            and(
              eq(attachmentLink.attachmentId, input.attachmentId),
              eq(attachmentLink.entityKind, "asset"),
              eq(attachmentLink.entityId, input.assetId),
              eq(attachmentLink.role, input.role),
            ),
          )
          .get();
        if (existing) return existing.id;

        const next = tx
          .select({ maxSeq: sql<number>`COALESCE(MAX(${attachmentLink.seq}), -1)` })
          .from(attachmentLink)
          .where(
            and(
              eq(attachmentLink.entityKind, "asset"),
              eq(attachmentLink.entityId, input.assetId),
            ),
          )
          .get();

        const rowId = newId();
        tx.insert(attachmentLink)
          .values({
            id: rowId,
            attachmentId: input.attachmentId,
            entityKind: "asset",
            entityId: input.assetId,
            role: input.role,
            seq: (next?.maxSeq ?? -1) + 1,
          })
          .run();

        writeAudit(tx, ctx, {
          entityTable: "attachment_link",
          entityId: rowId,
          action: "created",
          summary: `Attached ${file.kind} (${input.role}) to equipment ${input.assetId}`,
        });
        return rowId;
      }),
    );
    revalidateAsset(input.assetId);
    return { linkId };
  },
);

/**
 * Detach a file from a piece of equipment.
 *
 * Only the *link* is deleted; the blob and its `attachment` row stay, because the same file may be
 * linked elsewhere and reclaiming orphaned blobs is an operations job, not a click.
 */
export const unlinkAssetAttachment = action(
  z.object({
    assetId: z.string().min(1),
    attachmentId: z.string().min(1),
    idempotencyKey: z.string().min(8).max(200).optional(),
  }),
  async (input, session) => {
    const { db } = getDb();
    mapDomainErrors(() =>
      writeTx(db, (tx) => {
        const ctx = userContext(session, tx);
        const row = tx
          .select({ id: attachmentLink.id })
          .from(attachmentLink)
          .where(
            and(
              eq(attachmentLink.attachmentId, input.attachmentId),
              eq(attachmentLink.entityKind, "asset"),
              eq(attachmentLink.entityId, input.assetId),
            ),
          )
          .get();
        if (!row) throw new NotFoundError("attachment_link", input.attachmentId);

        tx.delete(attachmentLink).where(eq(attachmentLink.id, row.id)).run();

        writeAudit(tx, ctx, {
          entityTable: "attachment_link",
          entityId: row.id,
          action: "deleted",
          summary: `Detached a file from equipment ${input.assetId} (the file itself is kept)`,
        });
      }),
    );
    revalidateAsset(input.assetId);
    return { assetId: input.assetId, attachmentId: input.attachmentId };
  },
);
