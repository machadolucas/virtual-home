/**
 * DELETE /api/house-model/[modelId]/placements/[placementId]
 *
 * Removes the *placement*, never the equipment: the asset row, its history and its maintenance
 * schedule are untouched. "This is no longer where it sits" is the only fact being retracted.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { assetPlacement, modelRevision } from "@/db/schema";
import { authed, notFound } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";

type Ctx = { params: Promise<{ modelId: string; placementId: string }> };

export const DELETE = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId, placementId } = await ctx.params;
  await currentPackageForRequest(modelId);

  const db = getDb().db;
  const revisionIds = db
    .select({ id: modelRevision.id })
    .from(modelRevision)
    .where(eq(modelRevision.modelId, modelId))
    .all()
    .map((r) => r.id);
  if (revisionIds.length === 0) throw notFound("unknown_placement");

  const existing = db
    .select({ id: assetPlacement.id })
    .from(assetPlacement)
    .where(
      and(
        eq(assetPlacement.id, placementId),
        inArray(assetPlacement.modelRevisionId, revisionIds),
      ),
    )
    .get();
  if (!existing) throw notFound("unknown_placement");

  writeTx(db, (tx) => {
    tx.delete(assetPlacement).where(eq(assetPlacement.id, placementId)).run();
  });

  return new Response(null, { status: 204, headers: NO_STORE });
});
