import { getDb, readTx } from "@/db/client";
import { headsetId, headsetTaskWrite } from "@/house/xr/headsetTasksTypes";
import { authed, badRequest, HttpError } from "@/server/api/handler";
import { currentPackageForRequest, NO_STORE } from "@/server/house-model/http";
import { manifestIndexOf } from "@/server/house-model/package";
import { writeHeadsetTask } from "@/server/operations/maintenance/headset";
import { revalidateMaintenance } from "@/server/operations/maintenance/shared";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { headsetEquipmentByPlacement, headsetMaintenanceOverview, headsetTask } from "@/server/queries/maintenance/headset";

type Ctx = { params: Promise<{ modelId: string; placementId: string }> };

export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId, placementId: rawPlacement } = await ctx.params;
  const placementId = headsetId.parse(rawPlacement);
  const task = new URL(req.url).searchParams.get("task");
  const index = manifestIndexOf(await currentPackageForRequest(modelId));
  const response = readTx(getDb().db, (db) => task === null
    ? headsetMaintenanceOverview(db, index, placementId)
    : headsetTask(db, headsetEquipmentByPlacement(db, index, placementId).assetId!, headsetId.parse(task)));
  return Response.json(response, { headers: NO_STORE });
});

const MAX_BODY = 24 * 1024;

async function body(req: Request) {
  if (req.headers.get("x-vh-headset-task") !== "1" || !req.headers.get("content-type")?.includes("application/json"))
    throw new HttpError(415, "headset_json_required");
  if (Number(req.headers.get("content-length")) > MAX_BODY) throw new HttpError(413, "headset_request_too_large");
  const reader = req.body?.getReader();
  if (!reader) throw badRequest("headset_json_required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "headset_request_too_large");
    }
    chunks.push(next.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw badRequest("headset_json_invalid"); }
}

export const PATCH = authed<Ctx>(async (session, req, ctx) => {
  const { modelId, placementId } = await ctx.params;
  const input = headsetTaskWrite.parse(await body(req));
  const index = manifestIndexOf(await currentPackageForRequest(modelId));
  const { db, ctx: domain } = maintenanceContext(session.user.id);
  const result = writeHeadsetTask(db, domain, index, headsetId.parse(placementId), input);
  revalidateMaintenance(input.occurrenceId);
  return Response.json(result, { headers: NO_STORE });
});
