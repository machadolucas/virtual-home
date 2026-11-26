import { and, desc, eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { assetPlacement, furnishing, fitProposal } from "@/db/schema";
import { requireCurrentRevisionId } from "@/server/queries/infrastructure/model";
import { fitInput } from "@/house/model/fitProposal";
import { pointInFootprint } from "@/house/model/geometry2d";
import { authed, badRequest, conflict, HttpError } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";
import { readBoundedJson } from "@/server/room-surveys/http";

type Ctx = { params: Promise<{ modelId: string }> };
const fields = { id: fitProposal.id, createdAtMs: fitProposal.createdAtMs, draft: fitProposal.draft };
export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const roomId = new URL(req.url).searchParams.get("roomId");
  if (!roomId || !manifestIndexOf(pkg).rooms.has(roomId)) throw badRequest("unknown_room");
  const proposals = getDb()
    .db.select(fields)
    .from(fitProposal)
    .where(
      and(
        eq(fitProposal.modelId, modelId),
        eq(fitProposal.fingerprint, pkg.fingerprint),
        eq(fitProposal.roomId, roomId),
      ),
    )
    .orderBy(desc(fitProposal.createdAtMs), desc(fitProposal.id))
    .limit(40)
    .all();
  return Response.json({ proposals }, { headers: NO_STORE });
});

export const POST = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  if (req.headers.get("x-vh-fit-proposal") !== "1") throw new HttpError(403, "proposal_header_required");
  const input = fitInput.parse(await readBoundedJson(req, 8192));
  if (pkg.fingerprint !== input.fingerprint) throw conflict("stale_fingerprint");
  const room = manifestIndexOf(pkg).rooms.get(input.roomId);
  if (!room || input.draft.arrangements.some((p) => !pointInFootprint(p.x, p.z, room.footprint)))
    throw badRequest("proposal_outside_room");
  const id = writeTx(getDb().db, (tx) => {
    const previous = tx
      .select()
      .from(fitProposal)
      .where(and(eq(fitProposal.createdBy, session.user.id), eq(fitProposal.requestId, input.requestId)))
      .get();
    if (previous) {
      if (
        previous.modelId !== modelId ||
        previous.fingerprint !== input.fingerprint ||
        previous.roomId !== input.roomId ||
        JSON.stringify(previous.draft) !== JSON.stringify(input.draft)
      )
        throw conflict("request_reused");
      return previous.id;
    }
    const replaces = input.draft.replaces;
    if (replaces) {
      const exists =
        replaces.kind === "furnishing"
          ? tx
              .select({ id: furnishing.id })
              .from(furnishing)
              .where(
                and(
                  eq(furnishing.id, replaces.id),
                  eq(furnishing.modelId, modelId),
                  eq(furnishing.roomId, input.roomId),
                ),
              )
              .get()
          : tx
              .select({ id: assetPlacement.id })
              .from(assetPlacement)
              .where(
                and(
                  eq(assetPlacement.id, replaces.id),
                  eq(assetPlacement.modelRevisionId, requireCurrentRevisionId(tx, modelId, "proposals")),
                  eq(assetPlacement.modelNodeId, input.roomId),
                  eq(assetPlacement.mountKind, "floor"),
                  eq(assetPlacement.needsReconciliation, false),
                ),
              )
              .get();
      if (!exists) throw conflict("replaced_item_changed");
    }
    const id = newId();
    tx.insert(fitProposal)
      .values({ id, modelId, ...input, createdAtMs: nowMs(), createdBy: session.user.id })
      .run();
    return id;
  });
  return Response.json({ id }, { headers: NO_STORE });
});
