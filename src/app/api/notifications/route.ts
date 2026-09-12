import { z } from "zod";
import { authed } from "@/server/api/handler";
import { notificationSnapshot } from "@/server/queries/notifications";
const paging = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  includeAcknowledged: z.enum(["0", "1"]).default("0"),
});
export const GET = authed(async (_session, req) => {
  const params = new URL(req.url).searchParams;
  const options = paging.parse({ page: params.get("page") ?? undefined, limit: params.get("limit") ?? undefined, includeAcknowledged: params.get("includeAcknowledged") ?? undefined });
  return Response.json(notificationSnapshot({ ...options, includeAcknowledged: options.includeAcknowledged === "1" }), { headers: { "Cache-Control": "private, no-store" } });
});
