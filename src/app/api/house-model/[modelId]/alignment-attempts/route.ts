import { getDb } from "@/db/client";
import { alignmentAttemptListInput, MAX_ALIGNMENT_ATTEMPT_BYTES } from "@/house/alignmentAttemptTypes";
import { checkAlignmentOrigin } from "@/server/alignment-attempts/http";
import { listAlignmentAttempts, storeAlignmentAttempt } from "@/server/alignment-attempts/registry";
import { authed } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";
import { readBoundedJson } from "@/server/room-surveys/http";

type Ctx = { params: Promise<{ modelId: string }> };

export const POST = authed<Ctx>(async (session, req, ctx) => {
  checkAlignmentOrigin(req, true);
  const { modelId } = await ctx.params;
  const body = await readBoundedJson(req, MAX_ALIGNMENT_ATTEMPT_BYTES);
  return Response.json(storeAlignmentAttempt(getDb().db, session.user.id, modelId, body), { headers: NO_STORE });
});

export const GET = authed<Ctx>(async (session, req, ctx) => {
  checkAlignmentOrigin(req);
  const { modelId } = await ctx.params;
  const query = new URL(req.url).searchParams;
  const input = alignmentAttemptListInput.parse({ modelId, roomId: query.get("roomId") ?? undefined,
    cursor: query.get("cursor") ?? undefined, limit: query.has("limit") ? Number(query.get("limit")) : undefined });
  return Response.json(listAlignmentAttempts(getDb().db, session.user.id, input), { headers: NO_STORE });
});
