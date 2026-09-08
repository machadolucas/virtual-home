/**
 * POST /api/upload — the only way a file enters the data directory.
 *
 * `req.formData()` buffers the parts in memory, which is acceptable *because* the cap is 25 MiB and
 * this app has two users on a LAN; the point that matters is that the cap is enforced on the
 * **actual** size (`storeUpload` counts bytes as it stages) and not only on the client's
 * `Content-Length`, which is checked first purely to reject an obvious flood cheaply.
 *
 * Everything else — type sniffing, GPS stripping, dedupe, derivatives — lives in
 * `src/server/files/store.ts`, so this handler stays a thin, auditable boundary.
 */
import { Readable } from "node:stream";
import { z } from "zod";
import { authed, badRequest, HttpError } from "@/server/api/handler";
import { loadEnv } from "@/env";
import { SniffError } from "@/server/files/sniff";
import { storeUpload, UploadError } from "@/server/files/store";
import { ImageError } from "@/server/files/images";
import { ATTACHMENT_KINDS } from "@/db/schema";

export const dynamic = "force-dynamic";

/** Room for the multipart envelope (boundaries, part headers) on top of the file itself. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/** The wrappers only surface `error` + `details`, so a human-readable reason travels in details. */
const explained = (status: number, code: string, message: string): HttpError =>
  new HttpError(status, code, message, { message });

const tooLarge = (message: string): HttpError => explained(413, "upload_too_large", message);

const fields = z.object({
  kind: z.enum(ATTACHMENT_KINDS).optional(),
  caption: z.string().trim().max(500).optional(),
});

export const POST = authed(async (session, req) => {
  const maxBytes = loadEnv().VH_UPLOAD_MAX_BYTES;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes + MULTIPART_OVERHEAD_BYTES) {
    throw tooLarge(`The request is larger than the ${maxBytes}-byte upload limit.`);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest("invalid_multipart");
  }

  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("missing_file");
  // A second, cheap rejection before any bytes are staged. `storeUpload` still counts.
  if (file.size > maxBytes) {
    throw tooLarge(`That file is larger than the ${maxBytes}-byte upload limit.`);
  }

  const parsed = fields.parse({
    kind: form.get("kind") ?? undefined,
    caption: form.get("caption") ?? undefined,
  });

  try {
    const stored = await storeUpload({
      stream: Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]),
      origName: file.name,
      uploadedBy: session.user.id,
      kind: parsed.kind,
      caption: parsed.caption,
      maxBytes,
    });
    const { row } = stored;
    return Response.json(
      {
        id: row.id,
        kind: row.kind,
        mime: row.mime,
        byteSize: row.byteSize,
        width: row.width,
        height: row.height,
        hasWebCopy: row.hasWebCopy,
        originalFilename: row.originalFilename,
        deduped: stored.deduped,
        /** True when the stored original may still carry EXIF the UI should warn about. */
        privateMetadataRetained: stored.exif?.residual ?? false,
        url: `/api/attachments/${row.id}`,
      },
      { status: stored.deduped ? 200 : 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    if (err instanceof UploadError) throw explained(err.status, err.code, err.message);
    // 415: the bytes are not one of the six allow-listed types (or are a PDF with active content).
    if (err instanceof SniffError) throw explained(415, err.reason, err.message);
    // A HEIC nobody on this machine can decode is the user's problem to fix, not a server error.
    if (err instanceof ImageError) throw explained(415, err.code, err.message);
    throw err;
  }
});
