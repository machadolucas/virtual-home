/**
 * GET /api/house-model/[modelId]/assets/[assetId]?v=<fingerprint>
 *
 * Private household files: served only through this authenticated handler, never from `public/`.
 * `assetId` is an allow-list lookup in the manifest; the resolved path is asserted to stay inside
 * the package directory and to contain no symlink (see `safeJoin`).
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { authed, conflict, notFound } from "@/server/api/handler";
import { assetPath, ModelPackageError } from "@/server/house-model/package";
import { currentPackageForRequest, immutableHeaders, notModified } from "@/server/house-model/http";

type Ctx = { params: Promise<{ modelId: string; assetId: string }> };

export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId, assetId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);
  if (!pkg.assetFiles.has(assetId)) throw notFound("unknown_asset");

  const v = new URL(req.url).searchParams.get("v");
  if (v !== pkg.fingerprint) throw conflict("stale_fingerprint", { fingerprint: pkg.fingerprint });

  const etag = `"${pkg.fingerprint}-${assetId}"`;
  if (notModified(req, etag)) return new Response(null, { status: 304, headers: immutableHeaders(etag) });

  let abs: string;
  try {
    abs = await assetPath(assetId);
  } catch (err) {
    if (err instanceof ModelPackageError) throw notFound("asset_missing");
    throw err;
  }
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isFile()) throw notFound("asset_missing");

  return new Response(Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream, {
    headers: {
      ...immutableHeaders(etag),
      "Content-Type": "model/gltf-binary",
      "Content-Length": String(st.size),
    },
  });
});
