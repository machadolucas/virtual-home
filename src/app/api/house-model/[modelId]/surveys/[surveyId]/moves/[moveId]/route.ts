import { z } from "zod";
import { getDb } from "@/db/client";
import { authed } from "@/server/api/handler";
import { requireFreshSession } from "@/server/auth/session";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { readSurveyJson } from "@/server/room-surveys/http";
import { changeSurveyMove } from "@/server/room-surveys/moves";

type Ctx = { params: Promise<{ modelId: string; surveyId: string; moveId: string }> };

export const PATCH = authed<Ctx>(async (_session, req, ctx) => {
  const actor = (await requireFreshSession()).user.id;
  const { modelId, surveyId, moveId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const { action } = z.strictObject({ action: z.enum(["apply", "undo"]) }).parse(await readSurveyJson(req, 1024));
  return Response.json(changeSurveyMove(getDb().db, pkg, z.uuid().parse(surveyId), z.uuid().parse(moveId), actor, action), { headers: NO_STORE });
});
