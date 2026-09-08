/**
 * GET / PATCH /api/house-model/[modelId]/colors
 *
 * Surface colour overrides. Colouring mutates only the surface's own material (CLAUDE.md rule 7),
 * so a row here is `(modelId, surfaceId) → #rrggbb` and nothing else: no geometry, no transform.
 *
 * A row references the `model_revision` it was chosen against, which is what makes a stale surface
 * id detectable after a package swap. That revision is created by the model import pipeline, so
 * until an import has run this endpoint answers `409 model_revision_missing` and the workspace
 * keeps the user's colours in its store for the session (and says so).
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { modelRevision, surfaceColorOverride } from "@/db/schema";
import { authed, badRequest, conflict } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";

type Ctx = { params: Promise<{ modelId: string }> };

const WriteSchema = z.object({
  surfaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  roomId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    .nullish(),
  /** `null` deletes the override, restoring the manifest's `defaultColor`. */
  colorHex: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .nullable(),
});

const PatchSchema = z.object({
  fingerprint: z.string().min(8),
  writes: z.array(WriteSchema).min(1).max(500),
});

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);

  const db = getDb().db;
  const rows = db
    .select({
      surfaceId: surfaceColorOverride.surfaceId,
      colorHex: surfaceColorOverride.colorHex,
      needsReconciliation: surfaceColorOverride.needsReconciliation,
    })
    .from(surfaceColorOverride)
    .where(eq(surfaceColorOverride.modelId, modelId))
    .all();

  const overrides: Record<string, string> = {};
  const stale: string[] = [];
  for (const row of rows) {
    // A colour for a surface this package no longer knows about is reported, never applied.
    if (!pkg.manifest.surfaces.some((s) => s.id === row.surfaceId)) {
      stale.push(row.surfaceId);
      continue;
    }
    overrides[row.surfaceId] = row.colorHex;
  }
  return Response.json({ overrides, stale }, { headers: NO_STORE });
});

export const PATCH = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);

  const body = PatchSchema.parse(await req.json());
  if (body.fingerprint !== pkg.fingerprint)
    throw conflict("stale_fingerprint", { fingerprint: pkg.fingerprint });

  const known = new Map(pkg.manifest.surfaces.map((s) => [s.id, s]));
  const unknown = body.writes.filter((w) => !known.has(w.surfaceId)).map((w) => w.surfaceId);
  if (unknown.length) throw badRequest("unknown_surface", { surfaceIds: unknown });

  const db = getDb().db;
  const revision = db
    .select({ id: modelRevision.id })
    .from(modelRevision)
    .where(and(eq(modelRevision.modelId, modelId), eq(modelRevision.status, "current")))
    .get();
  if (!revision)
    throw conflict("model_revision_missing", {
      hint: "import the model package first (pnpm vh-admin model-import <dir>); colours stay local until then",
    });

  const actor = typeof session.user.id === "string" ? session.user.id : null;
  const at = nowMs();

  writeTx(db, (tx) => {
    const removals = body.writes.filter((w) => w.colorHex === null).map((w) => w.surfaceId);
    if (removals.length)
      tx
        .delete(surfaceColorOverride)
        .where(
          and(
            eq(surfaceColorOverride.modelId, modelId),
            inArray(surfaceColorOverride.surfaceId, removals),
          ),
        )
        .run();

    for (const w of body.writes) {
      if (w.colorHex === null) continue;
      const roomId = w.roomId ?? known.get(w.surfaceId)?.roomId ?? null;
      tx
        .insert(surfaceColorOverride)
        .values({
          id: newId(),
          modelId,
          modelRevisionId: revision.id,
          surfaceId: w.surfaceId,
          roomId,
          colorHex: w.colorHex,
          needsReconciliation: false,
          createdAtMs: at,
          createdBy: actor,
          updatedAtMs: at,
          updatedBy: actor,
        })
        .onConflictDoUpdate({
          target: [surfaceColorOverride.modelId, surfaceColorOverride.surfaceId],
          set: {
            colorHex: w.colorHex,
            roomId,
            modelRevisionId: revision.id,
            needsReconciliation: false,
            updatedAtMs: at,
            updatedBy: actor,
          },
        })
        .run();
    }
  });

  const rows = db
    .select({
      surfaceId: surfaceColorOverride.surfaceId,
      colorHex: surfaceColorOverride.colorHex,
    })
    .from(surfaceColorOverride)
    .where(eq(surfaceColorOverride.modelId, modelId))
    .all();

  const overrides: Record<string, string> = {};
  for (const row of rows) overrides[row.surfaceId] = row.colorHex;
  return Response.json({ overrides }, { headers: NO_STORE });
});
