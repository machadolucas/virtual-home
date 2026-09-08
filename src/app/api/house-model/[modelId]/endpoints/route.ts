/**
 * GET / PUT / DELETE /api/house-model/[modelId]/endpoints
 *
 * The fixed things a route runs between: a manifold, a shutoff valve, a water meter, a
 * distribution board, a patch port. They exist independently of any route — the shutoff behind the
 * washing machine is worth recording even before the pipe to it is drawn — which is why they are
 * their own resource rather than a nested field.
 *
 * `DELETE ?id=<endpointId>` is a real delete, not a soft one: an endpoint carries no history of its
 * own, and `infra_route.from/to_endpoint_id` are `ON DELETE SET NULL`, so a route survives losing
 * one and simply stops claiming where it ends.
 *
 * A position, when given, follows the same rule as every other coordinate: physical site metres in
 * `viewMode: "normal"`, in bounds, stamped with the current revision (CLAUDE.md rule 7).
 */
import { eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { asset, infraEndpoint, location } from "@/db/schema";
import { EndpointPutSchema } from "@/features/projects/wire";
import { authed, badRequest, conflict, HttpError, notFound } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";
import {
  assertInBounds,
  assertKnownNode,
  assertPhysicalViewMode,
  mm,
  requireCurrentRevisionId,
  revisionIdsFor,
} from "@/server/queries/infrastructure/model";
import { listEndpoints } from "@/server/queries/infrastructure/endpoints";

type Ctx = { params: Promise<{ modelId: string }> };

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);
  const { endpoints, stale } = listEndpoints(getDb().db, modelId, index);
  return Response.json({ endpoints, stale }, { headers: NO_STORE });
});

export const PUT = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);

  const body = EndpointPutSchema.parse(await req.json());
  if (body.fingerprint !== pkg.fingerprint)
    throw conflict("stale_fingerprint", { fingerprint: pkg.fingerprint });
  assertPhysicalViewMode(body.viewMode);

  const e = body.endpoint;
  const db = getDb().db;
  const position = e.position ?? null;
  if (position) assertInBounds(pkg, position);
  assertKnownNode(index, e.modelNodeId);
  if (position === null && e.locationId == null && e.modelNodeId == null)
    throw badRequest("endpoint_needs_a_place", {
      hint: "give a position, a locationId or a modelNodeId — an endpoint nobody can find is not a record",
    });

  if (e.locationId != null) {
    const found = db
      .select({ id: location.id })
      .from(location)
      .where(eq(location.id, e.locationId))
      .get();
    if (!found) throw conflict("unknown_location", { locationId: e.locationId });
  }
  if (e.assetId != null) {
    const found = db.select({ id: asset.id }).from(asset).where(eq(asset.id, e.assetId)).get();
    if (!found) throw conflict("unknown_asset", { assetId: e.assetId });
  }

  const existing = e.id
    ? db
        .select({ id: infraEndpoint.id, modelRevisionId: infraEndpoint.modelRevisionId })
        .from(infraEndpoint)
        .where(eq(infraEndpoint.id, e.id))
        .get()
    : undefined;
  const revisionIds = revisionIdsFor(db, modelId);
  if (existing && existing.modelRevisionId !== null && !revisionIds.includes(existing.modelRevisionId))
    throw conflict("endpoint_belongs_to_other_model", { endpointId: existing.id });

  // A coordinate is what needs a revision to be interpretable; a location-only endpoint does not,
  // so it is accepted before the first model import instead of being blocked by it.
  const revisionId = position ? requireCurrentRevisionId(db, modelId, "endpoints") : null;

  const actor = typeof session.user.id === "string" ? session.user.id : null;
  const at = nowMs();
  const id = existing?.id ?? e.id ?? newId();
  const shared = {
    name: e.name,
    kind: e.kind,
    locationId: e.locationId ?? null,
    assetId: e.assetId ?? null,
    modelRevisionId: revisionId,
    modelNodeId: e.modelNodeId ?? null,
    posX: position ? mm(position[0]) : null,
    posY: position ? mm(position[1]) : null,
    posZ: position ? mm(position[2]) : null,
    needsReconciliation: false,
    notes: e.notes ?? null,
    updatedAtMs: at,
    updatedBy: actor,
  };

  writeTx(db, (tx) => {
    if (existing) tx.update(infraEndpoint).set(shared).where(eq(infraEndpoint.id, id)).run();
    else
      tx
        .insert(infraEndpoint)
        .values({ id, createdAtMs: at, createdBy: actor, ...shared })
        .run();
  });

  const stored = listEndpoints(db, modelId, index).endpoints.find((row) => row.id === id);
  if (!stored) throw new HttpError(500, "endpoint_not_stored");
  return Response.json({ endpoint: stored }, { headers: NO_STORE });
});

export const DELETE = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId } = await ctx.params;
  await currentPackageForRequest(modelId);

  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw badRequest("missing_id", { hint: "DELETE .../endpoints?id=<endpointId>" });

  const db = getDb().db;
  const revisionIds = revisionIdsFor(db, modelId);
  const existing = db
    .select({ id: infraEndpoint.id, modelRevisionId: infraEndpoint.modelRevisionId })
    .from(infraEndpoint)
    .where(eq(infraEndpoint.id, id))
    .get();
  if (
    !existing ||
    (existing.modelRevisionId !== null && !revisionIds.includes(existing.modelRevisionId))
  )
    throw notFound("unknown_endpoint");

  writeTx(db, (tx) => {
    tx.delete(infraEndpoint).where(eq(infraEndpoint.id, id)).run();
  });
  return new Response(null, { status: 204, headers: NO_STORE });
});
