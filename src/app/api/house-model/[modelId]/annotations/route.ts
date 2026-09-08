/**
 * GET / PUT / DELETE /api/house-model/[modelId]/annotations
 *
 * The pins that carry the knowledge no geometry can: "the shutoff is behind this panel", "measured
 * 2.34 m here", "do not drill above this line". They are the cheapest and most durable thing in
 * this whole module, so they are also the least fussy: a pin needs a title and a kind, and either a
 * point or a node to hang on.
 *
 * `kind: 'measurement'` requires a value — a measurement with nothing measured is a note, and the
 * table says so with a CHECK constraint; this handler answers `400 measurement_needs_a_value`
 * rather than letting SQLite phrase it.
 *
 * `DELETE ?id=<annotationId>` is a real delete. A pin is a statement someone made; when it is
 * wrong the honest thing is to remove it, not to keep a "removed" note that still reads as advice.
 */
import { and, eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { annotation, attachmentLink } from "@/db/schema";
import { AnnotationPutSchema } from "@/features/projects/wire";
import { authed, badRequest, conflict, HttpError, notFound } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";
import { listAnnotations } from "@/server/queries/infrastructure/annotations";
import {
  assertInBounds,
  assertKnownNode,
  assertPhysicalViewMode,
  mm,
  requireCurrentRevisionId,
  revisionIdsFor,
} from "@/server/queries/infrastructure/model";

type Ctx = { params: Promise<{ modelId: string }> };

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);
  const { annotations, stale } = listAnnotations(getDb().db, modelId, index);
  return Response.json({ annotations, stale }, { headers: NO_STORE });
});

export const PUT = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);

  const body = AnnotationPutSchema.parse(await req.json());
  if (body.fingerprint !== pkg.fingerprint)
    throw conflict("stale_fingerprint", { fingerprint: pkg.fingerprint });
  assertPhysicalViewMode(body.viewMode);

  const a = body.annotation;
  const db = getDb().db;
  const position = a.position ?? null;
  if (position) assertInBounds(pkg, position);
  assertKnownNode(index, a.modelNodeId);
  if (position === null && a.modelNodeId == null && a.targetId == null)
    throw badRequest("annotation_needs_an_anchor", {
      hint: "give a position, a modelNodeId or a targetId — a pin with nothing to point at is not a pin",
    });
  if (a.kind === "measurement" && a.measurementValue == null)
    throw badRequest("measurement_needs_a_value", {
      hint: "a measurement with nothing measured is a note; use kind: 'note'",
    });

  const existing = a.id
    ? db
        .select({ id: annotation.id, modelRevisionId: annotation.modelRevisionId })
        .from(annotation)
        .where(eq(annotation.id, a.id))
        .get()
    : undefined;
  if (existing && !revisionIdsFor(db, modelId).includes(existing.modelRevisionId))
    throw conflict("annotation_belongs_to_other_model", { annotationId: existing.id });

  const revisionId = requireCurrentRevisionId(db, modelId, "annotations");
  const actor = typeof session.user.id === "string" ? session.user.id : null;
  const at = nowMs();
  const id = existing?.id ?? a.id ?? newId();

  const shared = {
    targetKind: a.targetKind,
    targetId: a.targetId ?? null,
    modelRevisionId: revisionId,
    modelNodeId: a.modelNodeId ?? null,
    posX: position ? mm(position[0]) : null,
    posY: position ? mm(position[1]) : null,
    posZ: position ? mm(position[2]) : null,
    kind: a.kind,
    title: a.title,
    body: a.body ?? null,
    measurementValue: a.measurementValue ?? null,
    measurementUnit: a.measurementUnit ?? null,
    needsReconciliation: false,
    updatedAtMs: at,
    updatedBy: actor,
  };

  writeTx(db, (tx) => {
    if (existing) tx.update(annotation).set(shared).where(eq(annotation.id, id)).run();
    else
      tx
        .insert(annotation)
        .values({ id, createdAtMs: at, createdBy: actor, ...shared })
        .run();
  });

  const stored = listAnnotations(db, modelId, index).annotations.find((row) => row.id === id);
  if (!stored) throw new HttpError(500, "annotation_not_stored");
  return Response.json({ annotation: stored }, { headers: NO_STORE });
});

export const DELETE = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId } = await ctx.params;
  await currentPackageForRequest(modelId);

  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw badRequest("missing_id", { hint: "DELETE .../annotations?id=<annotationId>" });

  const db = getDb().db;
  const revisionIds = revisionIdsFor(db, modelId);
  const existing = db
    .select({ id: annotation.id, modelRevisionId: annotation.modelRevisionId })
    .from(annotation)
    .where(eq(annotation.id, id))
    .get();
  if (!existing || !revisionIds.includes(existing.modelRevisionId))
    throw notFound("unknown_annotation");

  writeTx(db, (tx) => {
    // SQLite cannot declare a polymorphic FK, so the links go with the row explicitly.
    tx
      .delete(attachmentLink)
      .where(and(eq(attachmentLink.entityKind, "annotation"), eq(attachmentLink.entityId, id)))
      .run();
    tx.delete(annotation).where(eq(annotation.id, id)).run();
  });
  return new Response(null, { status: 204, headers: NO_STORE });
});
