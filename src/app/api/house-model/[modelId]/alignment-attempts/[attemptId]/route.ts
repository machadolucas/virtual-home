import { z } from "zod";
import { getDb } from "@/db/client";
import { checkAlignmentOrigin } from "@/server/alignment-attempts/http";
import { getAlignmentAttempt } from "@/server/alignment-attempts/registry";
import { authed } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";

type Ctx = { params: Promise<{ modelId: string; attemptId: string }> };
export const GET = authed<Ctx>(async (session, req, ctx) => {
  checkAlignmentOrigin(req);
  const { modelId, attemptId } = await ctx.params;
  return Response.json(getAlignmentAttempt(getDb().db, session.user.id, z.uuid().parse(attemptId), modelId), { headers: NO_STORE });
});
