/**
 * GET /api/house-model/[modelId]/manifest?v=<fingerprint>
 *
 * Content-addressed: `?v=` must equal the currently installed fingerprint, otherwise the client is
 * holding a stale pointer and gets a 409 telling it to re-read `/status`.
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { authed, conflict, notFound } from "@/server/api/handler";
import { MANIFEST_FILE } from "@/server/house-model/package";
import { currentPackageForRequest, immutableHeaders, notModified } from "@/server/house-model/http";

type Ctx = { params: Promise<{ modelId: string }> };

export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { modelId } = await ctx.params;
  const pkg = await currentPackageForRequest(modelId);

  const v = new URL(req.url).searchParams.get("v");
  if (v !== pkg.fingerprint) throw conflict("stale_fingerprint", { fingerprint: pkg.fingerprint });

  const etag = `"${pkg.fingerprint}-manifest"`;
  if (notModified(req, etag)) return new Response(null, { status: 304, headers: immutableHeaders(etag) });

  const abs = path.join(pkg.dir, MANIFEST_FILE);
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isFile()) throw notFound("manifest_missing");

  return new Response(Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream, {
    headers: {
      ...immutableHeaders(etag),
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(st.size),
    },
  });
});
