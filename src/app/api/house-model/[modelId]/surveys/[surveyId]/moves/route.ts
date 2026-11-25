import { z } from "zod";
import { getDb } from "@/db/client";
import { roomSurveyMoveInput } from "@/house/roomSurveyTypes";
import { authed } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { readSurveyJson } from "@/server/room-surveys/http";
import { proposeSurveyMove } from "@/server/room-surveys/moves";

type Ctx = { params: Promise<{ modelId: string; surveyId: string }> };

export const POST = authed<Ctx>(async (session, req, ctx) => {
  const { modelId, surveyId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const input = roomSurveyMoveInput.parse(await readSurveyJson(req, 16 * 1024));
  return Response.json(proposeSurveyMove(getDb().db, pkg, z.uuid().parse(surveyId), session.user.id, input), { headers: NO_STORE });
});
