import { z } from "zod";
import { getDb } from "@/db/client";
import { authed } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";
import { getModelFixImage } from "@/server/model-fixes/registry";
import { readScreenshotImage } from "@/server/model-fixes/screenshotFiles";

type Ctx = { params: Promise<{ modelId: string; fixId: string; screenshotId: string; imageIndex: string }> };

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId, fixId, screenshotId, imageIndex } = await ctx.params;
  const index = Number(z.enum(["0", "1"]).parse(imageIndex));
  const { image } = getModelFixImage(getDb().db, z.uuid().parse(fixId), z.uuid().parse(screenshotId), index, modelId);
  const bytes = await readScreenshotImage(image);
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...NO_STORE,
      "Content-Type": image.mime,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
});
