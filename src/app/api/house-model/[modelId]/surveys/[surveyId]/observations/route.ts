import { z } from "zod";
import { getDb } from "@/db/client";
import { roomSurveyObservationInput } from "@/house/roomSurveyTypes";
import { authed } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { readSurveyJson } from "@/server/room-surveys/http";
import { storeSurveyObservation } from "@/server/room-surveys/registry";

type Ctx = { params: Promise<{ modelId: string; surveyId: string }> };

export const POST = authed<Ctx>(async (session, req, ctx) => {
  const { modelId, surveyId } = await ctx.params;
  const input = roomSurveyObservationInput.parse(await readSurveyJson(req, 32 * 1024));
  const pkg = input.kind === "discrepancy" ? await currentPackageForRequest(modelId) : undefined;
  return Response.json(storeSurveyObservation(getDb().db, modelId, z.uuid().parse(surveyId), session.user.id, input, pkg), { headers: NO_STORE });
});
