import { getDb } from "@/db/client";
import { MAX_ROOM_SURVEY_BODY_BYTES, roomSurveyCapture, roomSurveyListInput } from "@/house/roomSurveyTypes";
import { authed } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { readSurveyJson } from "@/server/room-surveys/http";
import { listRoomSurveys, storeRoomSurvey } from "@/server/room-surveys/registry";

type Ctx = { params: Promise<{ modelId: string }> };

export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId } = await ctx.params;
  const query = new URL(req.url).searchParams;
  const input = roomSurveyListInput.parse({
    modelId, roomId: query.get("roomId") ?? undefined, cursor: query.get("cursor") ?? undefined,
    limit: query.has("limit") ? Number(query.get("limit")) : undefined,
  });
  return Response.json(listRoomSurveys(getDb().db, input), { headers: NO_STORE });
});

export const POST = authed<Ctx>(async (session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  const input = roomSurveyCapture.parse(await readSurveyJson(req, MAX_ROOM_SURVEY_BODY_BYTES));
  return Response.json(storeRoomSurvey(getDb().db, pkg, session.user.id, input), { headers: NO_STORE });
});
