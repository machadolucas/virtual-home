/**
 * GET /api/house-model/[modelId]/status
 *
 * The discovery hop: hands the client the current fingerprint, server-side asset presence and the
 * package's diagnostics. Never cached — every other model URL is content-addressed off this one.
 */
import { authed, notFound } from "@/server/api/handler";
import { getCurrentPackage, packageStatus } from "@/server/house-model/package";

type Ctx = { params: Promise<{ modelId: string }> };

export const dynamic = "force-dynamic";

export const GET = authed<Ctx>(async (_session, _req, ctx) => {
  const { modelId } = await ctx.params;
  const status = await packageStatus();
  if (status.installed && status.modelId !== modelId) throw notFound("unknown_model");
  if (!status.installed) {
    // Not an error: the setup state renders the diagnostics and tells the user to import a package.
    const pkg = await getCurrentPackage().catch(() => null);
    if (pkg && pkg.modelId !== modelId) throw notFound("unknown_model");
  }
  return Response.json(status, {
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
});
