/**
 * DELETE /api/house-model/[modelId]/routes/[routeId]
 *
 * **Soft by default.** A pipe that was cut out of a wall in 2019 is not a mistake to erase; it is
 * the answer to "why is there a capped stub behind the panel?". So a delete sets
 * `lifecycle = 'removed'` and stamps `removed_on`, which is exactly what the renovation-date
 * filter reads, and the run keeps its polyline, its photos and its project link.
 *
 * `?hard=1` is the escape hatch for a route that was drawn *wrongly* — a mis-click, a duplicate,
 * a run that turned out to be somewhere else entirely. That one really is a mistake, and it takes
 * its points and attachment links with it (`infra_route_point` cascades; the links are deleted
 * here because SQLite cannot declare a polymorphic FK).
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { nowMs } from "@/db/ids";
import { attachmentLink, infraRoute } from "@/db/schema";
import { authed, notFound } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";
import { householdToday, revisionIdsFor } from "@/server/queries/infrastructure/model";
import { readRoute } from "@/server/queries/infrastructure/routes";

type Ctx = { params: Promise<{ modelId: string; routeId: string }> };

export const DELETE = authed<Ctx>(async (session, req, ctx) => {
  const { modelId, routeId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);

  const db = getDb().db;
  const revisionIds = revisionIdsFor(db, modelId);
  if (revisionIds.length === 0) throw notFound("unknown_route");

  const existing = db
    .select({ id: infraRoute.id, lifecycle: infraRoute.lifecycle, removedOn: infraRoute.removedOn })
    .from(infraRoute)
    .where(and(eq(infraRoute.id, routeId), inArray(infraRoute.modelRevisionId, revisionIds)))
    .get();
  if (!existing) throw notFound("unknown_route");

  const hard = new URL(req.url).searchParams.get("hard") === "1";
  const actor = typeof session.user.id === "string" ? session.user.id : null;

  if (hard) {
    writeTx(db, (tx) => {
      tx
        .delete(attachmentLink)
        .where(
          and(eq(attachmentLink.entityKind, "infra_route"), eq(attachmentLink.entityId, routeId)),
        )
        .run();
      tx.delete(infraRoute).where(eq(infraRoute.id, routeId)).run();
    });
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  // Keep an existing removal date: re-deleting an already-removed run must not rewrite history.
  const removedOn = existing.removedOn ?? householdToday(db);
  writeTx(db, (tx) => {
    tx
      .update(infraRoute)
      .set({ lifecycle: "removed", removedOn, updatedAtMs: nowMs(), updatedBy: actor })
      .where(eq(infraRoute.id, routeId))
      .run();
  });

  const route = readRoute(db, modelId, index, routeId);
  return Response.json({ route, softDeleted: true }, { headers: NO_STORE });
});
