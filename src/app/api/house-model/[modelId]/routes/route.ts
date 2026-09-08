/**
 * GET / PUT /api/house-model/[modelId]/routes
 *
 * Infrastructure runs — pipes, ducts, cables — as a polyline in **physical site metres** plus the
 * honesty fields that decide how they are drawn. This closes the gap recorded in
 * `docs/model-contract.md` §3: routes used to raise `NotPersistedError` and live for one session.
 *
 * The rules are the same three that shape `placements`, for the same reasons (CLAUDE.md rule 7):
 *
 *  - **`viewMode: "normal"` or nothing.** A coordinate read in an exploded or cutaway view is a
 *    presentation value; anything else answers `422 presentation_view_mode`.
 *  - **Semantic ids + metres.** Every point carries the package's own floor/room ids for the span
 *    that starts at it, and the row is stamped with the current `model_revision_id` — which is
 *    what makes a stale id detectable rather than mysterious. No revision yet ⇒ `409
 *    model_revision_missing`, and the workspace keeps the drawing for the session.
 *  - **Nothing is invented.** A `certainty` of `inferred` is stored as inferred; a route whose
 *    lifecycle is `removed` keeps its `removed_on` so the renovation-date filter can answer "was
 *    it there then?" instead of guessing.
 *
 * `partialFields` reports what the tables cannot hold — the workspace's `kind` (derived from
 * `medium`) and its per-endpoint descriptors — so the UI states it rather than pretending.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  asset,
  attachment,
  attachmentLink,
  infraEndpoint,
  infraRoute,
  infraRoutePoint,
  project,
  system as systemTable,
} from "@/db/schema";
import { mediumForSystem, systemOfMedium } from "@/features/projects/infraMedium";
import { formatNominalSize } from "@/features/projects/nominalSize";
import { ROUTE_PARTIAL_FIELDS, RoutePutSchema } from "@/features/projects/wire";
import { authed, badRequest, conflict, HttpError } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";
import {
  assertInBounds,
  assertKnownSurface,
  assertPhysicalViewMode,
  householdToday,
  mm,
  requireCurrentRevisionId,
  resolvePlace,
  revisionIdsFor,
} from "@/server/queries/infrastructure/model";
import { listRoutes, readRoute } from "@/server/queries/infrastructure/routes";

type Ctx = { params: Promise<{ modelId: string }> };

const exists = (row: unknown): boolean => row !== undefined && row !== null;

export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);
  const db = getDb().db;

  // `?options=projects` answers the route inspector's project picker. It lives on this resource
  // rather than a new one because it exists only to fill in a field of *this* resource, and the
  // workspace should not need a second round trip (or a second permission surface) for a dropdown.
  if (new URL(req.url).searchParams.get("options") === "projects") {
    const projects = db
      .select({ id: project.id, name: project.name, status: project.status })
      .from(project)
      .orderBy(asc(project.name))
      .all();
    return Response.json({ projects }, { headers: NO_STORE });
  }

  const { routes, stale } = listRoutes(db, modelId, index);
  return Response.json(
    { routes, stale, partialFields: ROUTE_PARTIAL_FIELDS },
    { headers: NO_STORE },
  );
});

export const PUT = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);

  const body = RoutePutSchema.parse(await req.json());
  if (body.fingerprint !== pkg.fingerprint)
    throw conflict("stale_fingerprint", { fingerprint: pkg.fingerprint });
  assertPhysicalViewMode(body.viewMode);

  const r = body.route;
  const db = getDb().db;

  // ---- geometry ---------------------------------------------------------
  const points = r.points.map((p, i) => {
    assertInBounds(pkg, p.position);
    const place = resolvePlace(index, p, p.position[0], p.position[2]);
    return {
      seq: i,
      posX: mm(p.position[0]),
      posY: mm(p.position[1]),
      posZ: mm(p.position[2]),
      pointKind: p.pointKind,
      floorId: place.floorId,
      roomId: place.roomId,
      modelNodeId: p.modelNodeId ?? place.roomId ?? place.floorId ?? null,
      assetId: p.assetId ?? null,
    };
  });
  assertKnownSurface(index, r.offsetSurfaceId);
  if (r.offsetSurfaceId != null && r.offsetM == null)
    throw badRequest("offset_without_distance", { offsetSurfaceId: r.offsetSurfaceId });

  // ---- references ------------------------------------------------------
  // Checked here rather than left to SQLite, which would only say "FOREIGN KEY constraint failed"
  // and leave the caller guessing which of five references was wrong.
  if (r.systemId != null && !exists(db.select({ id: systemTable.id }).from(systemTable).where(eq(systemTable.id, r.systemId)).get()))
    throw conflict("unknown_system", { systemId: r.systemId });
  if (r.projectId != null && !exists(db.select({ id: project.id }).from(project).where(eq(project.id, r.projectId)).get()))
    throw conflict("unknown_project", { projectId: r.projectId });
  for (const endpointId of [r.fromEndpointId, r.toEndpointId]) {
    if (endpointId == null) continue;
    const found = db
      .select({ id: infraEndpoint.id })
      .from(infraEndpoint)
      .where(eq(infraEndpoint.id, endpointId))
      .get();
    if (!found) throw conflict("unknown_endpoint", { endpointId });
  }
  const assetIds = [...new Set(points.map((p) => p.assetId).filter((v): v is string => v !== null))];
  if (assetIds.length) {
    const found = db
      .select({ id: asset.id })
      .from(asset)
      .where(inArray(asset.id, assetIds))
      .all()
      .map((a) => a.id);
    const missing = assetIds.filter((id) => !found.includes(id));
    if (missing.length) throw conflict("unknown_asset", { assetIds: missing });
  }
  const photoIds = r.photoAttachmentIds ?? [];
  if (photoIds.length) {
    const found = db
      .select({ id: attachment.id })
      .from(attachment)
      .where(inArray(attachment.id, photoIds))
      .all()
      .map((a) => a.id);
    const missing = photoIds.filter((id) => !found.includes(id));
    if (missing.length) throw conflict("unknown_attachment", { attachmentIds: missing });
  }

  const revisionId = requireCurrentRevisionId(db, modelId, "routes");

  // ---- lifecycle and dates ---------------------------------------------
  const existing = r.id
    ? db
        .select({
          id: infraRoute.id,
          medium: infraRoute.medium,
          nominalSize: infraRoute.nominalSize,
          modelRevisionId: infraRoute.modelRevisionId,
        })
        .from(infraRoute)
        .where(eq(infraRoute.id, r.id))
        .get()
    : undefined;
  // A client-supplied id addresses an existing row. It must be a row of *this* model: otherwise a
  // stray id would quietly retarget another model's route.
  if (existing && !revisionIdsFor(db, modelId).includes(existing.modelRevisionId))
    throw conflict("route_belongs_to_other_model", { routeId: existing.id });

  const medium = r.medium ?? mediumForSystem(r.system ?? "other", existing?.medium ?? null);
  if (r.system && systemOfMedium(medium) !== r.system)
    throw badRequest("medium_system_mismatch", { medium, system: r.system });

  const today = householdToday(db);
  // A removed run with no removal date cannot answer "was it there then?"; stamp today rather than
  // store a lifecycle the date filter has to guess about.
  const removedOn = r.lifecycle === "removed" ? (r.removedOn ?? today) : (r.removedOn ?? null);
  const installedOn = r.installedOn ?? null;
  if (removedOn !== null && installedOn !== null && removedOn < installedOn)
    throw badRequest("removed_before_installed", { installedOn, removedOn });
  if (r.lifecycle === "planned" && removedOn !== null)
    throw badRequest("planned_cannot_be_removed", { removedOn });

  const nominalSize =
    formatNominalSize({
      nominalSize: r.nominalSize ?? null,
      diameterM: r.diameterM ?? null,
      widthM: r.widthM ?? null,
    }) ??
    // An update that mentions no size at all keeps the size already on the row.
    (r.nominalSize === undefined && r.diameterM === undefined && r.widthM === undefined
      ? (existing?.nominalSize ?? null)
      : null);

  const actor = typeof session.user.id === "string" ? session.user.id : null;
  const at = nowMs();
  const routeId = existing?.id ?? r.id ?? newId();

  const shared = {
    name: r.name,
    systemId: r.systemId ?? null,
    medium,
    nominalSize,
    fromEndpointId: r.fromEndpointId ?? null,
    toEndpointId: r.toEndpointId ?? null,
    modelRevisionId: revisionId,
    isEstimated: r.isEstimated ?? r.certainty !== "measured",
    certainty: r.certainty,
    lifecycle: r.lifecycle,
    installedOn,
    removedOn,
    depthM: r.depthM == null ? null : mm(r.depthM),
    offsetSurfaceId: r.offsetSurfaceId ?? null,
    offsetM: r.offsetM == null ? null : mm(r.offsetM),
    projectId: r.projectId ?? null,
    notes: r.notes ?? null,
    needsReconciliation: false,
    updatedAtMs: at,
    updatedBy: actor,
  };

  writeTx(db, (tx) => {
    if (existing) {
      tx.update(infraRoute).set(shared).where(eq(infraRoute.id, routeId)).run();
      // The polyline is replaced wholesale: `seq` is dense and a partial update would leave a hole
      // that the unique (route, seq) index turns into a confusing constraint error.
      tx.delete(infraRoutePoint).where(eq(infraRoutePoint.routeId, routeId)).run();
    } else {
      tx
        .insert(infraRoute)
        .values({ id: routeId, createdAtMs: at, createdBy: actor, ...shared })
        .run();
    }

    for (const p of points)
      tx
        .insert(infraRoutePoint)
        .values({ id: newId(), routeId, needsReconciliation: false, ...p })
        .run();

    // Photos are a set, so the write is authoritative: links absent from the payload are removed.
    tx
      .delete(attachmentLink)
      .where(
        and(eq(attachmentLink.entityKind, "infra_route"), eq(attachmentLink.entityId, routeId)),
      )
      .run();
    photoIds.forEach((attachmentId, seq) => {
      tx
        .insert(attachmentLink)
        .values({
          id: newId(),
          attachmentId,
          entityKind: "infra_route",
          entityId: routeId,
          role: "photo",
          seq,
        })
        .onConflictDoNothing()
        .run();
    });
  });

  const stored = readRoute(db, modelId, index, routeId);
  if (!stored) throw new HttpError(500, "route_not_stored");
  return Response.json(
    { route: stored, partialFields: ROUTE_PARTIAL_FIELDS },
    { headers: NO_STORE },
  );
});
