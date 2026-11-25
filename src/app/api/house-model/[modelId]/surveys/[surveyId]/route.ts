import { z } from "zod";
import { getDb } from "@/db/client";
import { authed } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";
import { getRoomSurvey } from "@/server/room-surveys/registry";

type Ctx = { params: Promise<{ modelId: string; surveyId: string }> };

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId, surveyId } = await ctx.params;
  return Response.json(getRoomSurvey(getDb().db, z.uuid().parse(surveyId), modelId), { headers: NO_STORE });
});
