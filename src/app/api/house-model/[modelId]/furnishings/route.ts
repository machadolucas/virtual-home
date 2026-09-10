import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { furnishing, FURNISHING_KINDS } from "@/db/schema";
import type { Furnishing } from "@/house/model/types";
import { roomAt } from "@/house/model/manifestIndex";
import { authed, badRequest, conflict, HttpError } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";
import { requireFreshSession } from "@/server/auth/session";

type Ctx = { params: Promise<{ modelId: string }> };
const finite = z.number().finite();
const id = z.string().trim().min(1).max(128);
const Input = z.object({
  id: id.optional(),
  kind: z.enum(FURNISHING_KINDS),
  name: z.string().trim().min(1).max(100),
  position: z.tuple([finite, finite, finite]),
  rotationYDeg: finite.min(-3600).max(3600),
  widthM: finite.min(0.05).max(30),
  depthM: finite.min(0.05).max(30),
  heightM: finite.min(0.01).max(15),
  floorId: id,
});
const Put = z.object({ fingerprint: z.string().min(8), viewMode: z.string(), furnishing: Input });
const mm = (n: number) => Math.round(n * 1000) / 1000;

function dto(modelId: string, row: typeof furnishing.$inferSelect): Furnishing {
  return {
    id: row.id, modelId, kind: row.kind, name: row.name,
    position: [row.posX, row.posY, row.posZ], rotationYDeg: row.rotYawDeg,
    widthM: row.widthM, depthM: row.depthM, heightM: row.heightM,
    floorId: row.floorId, roomId: row.roomId,
  };
}

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);
  const db = getDb().db;
  const rows = db.select().from(furnishing).where(eq(furnishing.modelId, modelId))
    .orderBy(asc(furnishing.name)).all();
  const stale = rows.filter((row) => !index.floors.has(row.floorId)).map((row) => row.id);
  return Response.json({ furnishings: rows.map((row) => dto(modelId, row)), stale }, { headers: NO_STORE });
});

export const PUT = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const index = manifestIndexOf(pkg);
  const body = Put.parse(await req.json());
  if (body.fingerprint !== pkg.fingerprint) throw conflict("stale_fingerprint", { fingerprint: pkg.fingerprint });
  if (body.viewMode !== "normal") throw new HttpError(422, "presentation_view_mode");
  const input = body.furnishing;
  const floor = index.floors.get(input.floorId);
  if (!floor) throw badRequest("unknown_floor", { floorId: input.floorId });
  const bounds = pkg.manifest.bounds;
  input.position.forEach((value, axis) => {
    if (value < bounds.min[axis]! || value > bounds.max[axis]!)
      throw badRequest("out_of_bounds", { axis: "xyz"[axis], value, bounds });
  });
  const db = getDb().db;
  if (input.id) {
    const old = db.select({ modelId: furnishing.modelId }).from(furnishing)
      .where(eq(furnishing.id, input.id)).get();
    if (!old) throw new HttpError(404, "unknown_furnishing");
    if (old.modelId !== modelId) throw conflict("furnishing_model_mismatch");
  }
  const position = input.position.map(mm) as [number, number, number];
  const roomId = roomAt(index, input.floorId, position[0], position[2]);
  const actor = typeof session.user.id === "string" ? session.user.id : null;
  const at = nowMs();
  const recordId = input.id ?? newId();
  const values = {
    modelId, modelNodeId: roomId ?? input.floorId,
    floorId: input.floorId, roomId, kind: input.kind, name: input.name,
    posX: position[0], posY: position[1], posZ: position[2],
    rotYawDeg: mm(input.rotationYDeg), widthM: mm(input.widthM),
    depthM: mm(input.depthM), heightM: mm(input.heightM),
    updatedAtMs: at, updatedBy: actor,
  };
  const saved = writeTx(db, (tx) => {
    if (input.id) tx.update(furnishing).set(values).where(eq(furnishing.id, input.id)).run();
    else tx.insert(furnishing).values({ id: recordId, ...values, createdAtMs: at, createdBy: actor }).run();
    return tx.select().from(furnishing).where(eq(furnishing.id, recordId)).get();
  });
  if (!saved) throw conflict("furnishing_write_failed");
  return Response.json({ furnishing: dto(modelId, saved) }, { headers: NO_STORE });
});

export const DELETE = authed<Ctx>(async (_session, req, ctx) => {
  await requireFreshSession();
  const { modelId } = await ctx.params;
  await currentPackageForRequest(modelId);
  const furnishingId = new URL(req.url).searchParams.get("id");
  if (!furnishingId) throw badRequest("missing_furnishing_id");
  const db = getDb().db;
  writeTx(db, (tx) => {
    const existing = tx.select({ id: furnishing.id }).from(furnishing)
      .where(and(eq(furnishing.id, furnishingId), eq(furnishing.modelId, modelId))).get();
    if (!existing) throw new HttpError(404, "unknown_furnishing");
    tx.delete(furnishing).where(eq(furnishing.id, existing.id)).run();
  });
  return new Response(null, { status: 204, headers: NO_STORE });
});
