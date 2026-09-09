import { getDb } from "@/db/client";
import { authed, notFound } from "@/server/api/handler";
import { readHaControlStatus } from "@/server/ha/control";

type Ctx = { params: Promise<{ assetId: string; commandId: string }> };

export const dynamic = "force-dynamic";

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { assetId, commandId } = await ctx.params;
  const command = readHaControlStatus(getDb().db, assetId, commandId);
  if (!command) throw notFound("control_command_not_found");
  return Response.json(
    {
      commandId: command.id,
      status: command.status,
      ...(command.error ? { error: command.error } : {}),
      observed: false as const,
    },
    { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } },
  );
});
