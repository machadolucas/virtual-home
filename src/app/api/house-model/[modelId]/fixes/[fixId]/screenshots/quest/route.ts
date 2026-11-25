import { z } from "zod";
import { getDb } from "@/db/client";
import { authed } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";
import { readQuestFixScreenshot } from "@/server/model-fixes/http";
import { saveModelFixScreenshot } from "@/server/model-fixes/registry";

type Ctx = { params: Promise<{ modelId: string; fixId: string }> };

export const POST = authed<Ctx>(async (session, req, ctx) => {
  const { modelId, fixId } = await ctx.params;
  const capture = await readQuestFixScreenshot(req);
  const fix = await saveModelFixScreenshot(getDb().db, {
    ...capture, modelId, fixId: z.uuid().parse(fixId), actor: session.user.id,
  });
  return Response.json(fix, { headers: NO_STORE });
});
