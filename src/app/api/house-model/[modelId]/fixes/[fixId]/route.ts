import { z } from "zod";
import { getDb } from "@/db/client";
import { modelFixPatch } from "@/house/modelFixTypes";
import { authed } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";
import { readModelFixPatch } from "@/server/model-fixes/http";
import { getModelFix, updateModelFix } from "@/server/model-fixes/registry";

type Ctx = { params: Promise<{ modelId: string; fixId: string }> };

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId, fixId } = await ctx.params;
  const fix = getModelFix(getDb().db, z.uuid().parse(fixId), modelId);
  return Response.json(fix, { headers: NO_STORE });
});

export const PATCH = authed<Ctx>(async (session, req, ctx) => {
  const { modelId, fixId } = await ctx.params;
  const patch = modelFixPatch.parse(await readModelFixPatch(req));
  const fix = updateModelFix(getDb().db, modelId, z.uuid().parse(fixId), session.user.id, patch);
  return Response.json(fix, { headers: NO_STORE });
});
