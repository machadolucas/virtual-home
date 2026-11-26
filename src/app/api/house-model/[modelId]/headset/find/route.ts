import { getDb, readTx } from "@/db/client";
import { headsetFindInput } from "@/house/xr/headsetTasksTypes";
import { authed } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";
import { findHeadsetEquipment } from "@/server/queries/maintenance/headset";

type Ctx = { params: Promise<{ modelId: string }> };

export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId } = await ctx.params;
  const params = new URL(req.url).searchParams;
  const input = headsetFindInput.parse({
    purpose: params.get("purpose") ?? undefined, category: params.get("category") ?? undefined,
    roomId: params.get("roomId") ?? undefined, onlyRoom: params.get("onlyRoom") === "1", q: params.get("q") ?? undefined,
    offset: params.has("offset") ? Number(params.get("offset")) : undefined,
  });
  const index = manifestIndexOf(await currentPackageForRequest(modelId));
  return Response.json(readTx(getDb().db, (db) => findHeadsetEquipment(db, index, input)), { headers: NO_STORE });
});
