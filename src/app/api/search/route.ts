import { getDb } from "@/db/client";
import { authed } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";
import { searchRecords } from "@/server/queries/search";
export type { SearchHit, SearchGroup, SearchGroupKind } from "@/server/queries/search";
export const GET = authed(async (_session, req) => {
  const params = new URL(req.url).searchParams;
  const query = (params.get("q") ?? "").trim().slice(0, 200);
  const numeric = (key: string, fallback: number) => { const value = Number(params.get(key) ?? fallback); return Number.isSafeInteger(value) && value >= 0 ? value : fallback; };
  const groups = searchRecords(getDb().db, query, { limit: numeric("limit", 8), offset: Math.min(100000, numeric("offset", 0)), kind: params.get("kind") ?? undefined });
  return Response.json({ query, groups }, { headers: NO_STORE });
});
