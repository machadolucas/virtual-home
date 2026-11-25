import { getDb } from "@/db/client";
import { modelFixListInput } from "@/house/modelFixTypes";
import { authed } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";
import { readModelFixCapture } from "@/server/model-fixes/http";
import { listModelFixes, saveModelFixScreenshot } from "@/server/model-fixes/registry";

type Ctx = { params: Promise<{ modelId: string }> };

export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId } = await ctx.params;
  const query = new URL(req.url).searchParams;
  const input = modelFixListInput.parse({
    modelId,
    status: query.get("status") ?? undefined,
    cursor: query.get("cursor") ?? undefined,
    limit: query.has("limit") ? Number(query.get("limit")) : undefined,
  });
  return Response.json(listModelFixes(getDb().db, input), { headers: NO_STORE });
});

export const POST = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const capture = await readModelFixCapture(req);
  const fix = await saveModelFixScreenshot(getDb().db, { ...capture, modelId, actor: session.user.id });
  return Response.json(fix, { headers: NO_STORE });
});
