"use server";

import { revalidatePath } from "next/cache";
import { and, inArray, isNull } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { asset, assetHaLink } from "@/db/schema";
import { writeAudit } from "@/domain/inventory";
import { localDateOf } from "@/domain/time";
import { freshAction } from "@/server/api/action";
import { conflict } from "@/server/api/handler";
import { userContext } from "@/server/queries/settings/household";
import { bulkRemoveAssetsInput } from "./schemas";

/**
 * Remove up to 1,000 current units in one short transaction.
 *
 * "Remove" is the equipment lifecycle transition, never a DELETE: maintenance history and the
 * old HA bindings remain explainable. Retired bindings are ignored by the registry import query,
 * which intentionally makes the same HA devices available to import again.
 */
export const bulkRemoveEquipment = freshAction(bulkRemoveAssetsInput, async (input, session) => {
  const { db } = getDb();
  const result = writeTx(db, (tx) => {
    const ctx = userContext(session, tx);
    const atMs = ctx.clock.now();
    const removedOn = localDateOf(atMs, ctx.tz);
    const rows = tx
      .select({ id: asset.id, name: asset.name, status: asset.status })
      .from(asset)
      .where(
        and(
          inArray(asset.id, input.assetIds),
          isNull(asset.replacedByAssetId),
          inArray(asset.status, ["planned", "installed"]),
        ),
      )
      .all();

    // Refuse the whole request if the list changed between confirmation and submit. No partial
    // batch is surprising, and a refresh gives the household the current set to choose from.
    if (rows.length !== input.assetIds.length) {
      const found = new Set(rows.map((row) => row.id));
      throw conflict("equipment_changed", {
        unavailableAssetIds: input.assetIds.filter((id) => !found.has(id)),
      });
    }

    tx.update(asset)
      .set({
        status: "removed",
        removedOn,
        updatedAtMs: atMs,
        updatedBy: ctx.actorUserId,
      })
      .where(inArray(asset.id, input.assetIds))
      .run();

    tx.update(assetHaLink)
      .set({
        linkState: "retired",
        linkStateChangedAtMs: atMs,
        updatedAtMs: atMs,
        updatedBy: ctx.actorUserId,
      })
      .where(
        and(
          inArray(assetHaLink.assetId, input.assetIds),
          inArray(assetHaLink.linkState, ["active", "renamed", "missing"]),
        ),
      )
      .run();

    for (const row of rows) {
      writeAudit(tx, ctx, {
        entityTable: "asset",
        entityId: row.id,
        action: "updated",
        summary: `${row.name} marked removed on ${removedOn}`,
        changes: { status: [row.status, "removed"] },
        requestId: input.idempotencyKey,
      });
    }

    return { removedCount: rows.length, removedOn };
  });

  revalidatePath("/equipment");
  revalidatePath("/equipment/systems");
  revalidatePath("/settings/home-assistant");
  revalidatePath("/house");
  for (const assetId of input.assetIds) revalidatePath(`/equipment/${assetId}`);
  return result;
});
