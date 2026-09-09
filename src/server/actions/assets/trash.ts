"use server";

import { revalidatePath } from "next/cache";
import { inArray } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { asset } from "@/db/schema";
import { writeAudit } from "@/domain/inventory";
import { freshAction } from "@/server/api/action";
import { conflict } from "@/server/api/handler";
import { assetDeletionBlockers } from "@/server/queries/assets/trash";
import { userContext } from "@/server/queries/settings/household";
import { permanentlyDeleteAssetsInput } from "./schemas";

export const permanentlyDeleteEquipment = freshAction(
  permanentlyDeleteAssetsInput,
  async (input, session) => {
    const { db } = getDb();
    const result = writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const rows = tx
        .select({ id: asset.id, name: asset.name, status: asset.status })
        .from(asset)
        .where(inArray(asset.id, input.assetIds))
        .all();
      const unavailable = rows.filter(
        (row) => !["removed", "retired", "lost"].includes(row.status),
      );
      const blockers = assetDeletionBlockers(tx, input.assetIds);
      if (rows.length !== input.assetIds.length || unavailable.length > 0 || blockers.size > 0) {
        const found = new Set(rows.map((row) => row.id));
        throw conflict("equipment_not_deletable", {
          missingAssetIds: input.assetIds.filter((id) => !found.has(id)),
          activeAssetIds: unavailable.map((row) => row.id),
          blockers: Object.fromEntries(blockers),
        });
      }

      for (const row of rows) {
        writeAudit(tx, ctx, {
          entityTable: "asset",
          entityId: row.id,
          action: "permanently_deleted",
          summary: `${row.name} permanently deleted from equipment trash`,
          requestId: input.idempotencyKey,
        });
      }
      tx.delete(asset).where(inArray(asset.id, input.assetIds)).run();
      return { deletedCount: rows.length };
    });

    revalidatePath("/equipment");
    revalidatePath("/equipment/systems");
    revalidatePath("/settings/home-assistant");
    revalidatePath("/house");
    for (const assetId of input.assetIds) revalidatePath(`/equipment/${assetId}`);
    return result;
  },
);
