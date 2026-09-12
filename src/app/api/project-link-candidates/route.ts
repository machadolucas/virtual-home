import { z } from "zod";
import { getDb } from "@/db/client";
import { authed, HttpError } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";
import { searchLinkCandidates } from "@/server/queries/infrastructure/linkSearch";
import { PROJECT_LINK_KINDS } from "@/features/projects/wire";
export const GET = authed(async (_session, req) => {
  const params = new URL(req.url).searchParams;
  const parsed = z.object({ kind: z.enum([...PROJECT_LINK_KINDS, "project"]), q: z.string().max(200), offset: z.coerce.number().int().min(0).max(100000) }).safeParse({ kind: params.get("kind"), q: params.get("q") ?? "", offset: params.get("offset") ?? 0 });
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid search");
  return Response.json(searchLinkCandidates(getDb().db, parsed.data.kind, parsed.data.q, parsed.data.offset), { headers: NO_STORE });
});
