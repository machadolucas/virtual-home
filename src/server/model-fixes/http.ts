import "server-only";
import { z } from "zod";
import { MAX_MODEL_FIX_IMAGE_BYTES, modelFixFingerprint, modelFixViewpoint } from "@/house/modelFixTypes";
import { badRequest, HttpError } from "@/server/api/handler";

const MAX_CAPTURE_BYTES = 2 * MAX_MODEL_FIX_IMAGE_BYTES + 32 * 1024;
const captureInput = z.strictObject({ requestId: z.uuid(), fingerprint: modelFixFingerprint, viewpoint: modelFixViewpoint });

async function readBoundedBody(req: Request, maxBytes: number) {
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes)
    throw new HttpError(413, "model_fix_request_too_large");
  const reader = req.body?.getReader();
  if (!reader) throw badRequest("body_required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "model_fix_request_too_large");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw badRequest("invalid_json");
  }
}

export async function readModelFixPatch(req: Request) {
  requireWriteHeader(req);
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new HttpError(415, "json_required");
  return parseJson((await readBoundedBody(req, 24 * 1024)).toString("utf8"));
}

function requireWriteHeader(req: Request) {
  // HTML cross-origin form posts cannot set this header, and these routes do not enable CORS.
  if (req.headers.get("x-vh-model-fix") !== "1") throw new HttpError(403, "model_fix_header_required");
}

async function readMultipartCapture(req: Request, maxImages: number) {
  requireWriteHeader(req);
  const contentType = req.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;"))
    throw new HttpError(415, "multipart_required");
  const bytes = await readBoundedBody(req, maxImages === 2 ? MAX_CAPTURE_BYTES : MAX_MODEL_FIX_IMAGE_BYTES + 32 * 1024);
  const form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType } })
    .formData().catch(() => { throw badRequest("invalid_multipart"); });
  const metadata = form.get("metadata");
  if (typeof metadata !== "string" || metadata.length > 12 * 1024 || form.getAll("metadata").length !== 1)
    throw badRequest("invalid_capture_metadata");
  const images = form.getAll("image");
  if (images.length < 1 || images.length > maxImages)
    throw badRequest("invalid_screenshot_count");
  const buffers = await Promise.all(images.map(async (image) => {
    if (typeof image === "string" || image.size < 1 || image.size > MAX_MODEL_FIX_IMAGE_BYTES)
      throw badRequest("invalid_screenshot_size");
    return Buffer.from(await image.arrayBuffer());
  }));
  return { metadata: parseJson(metadata), images: buffers };
}

export async function readModelFixCapture(req: Request) {
  const { metadata, images } = await readMultipartCapture(req, 2);
  const input = captureInput.parse(metadata);
  if (input.viewpoint.mode === "desktop" && images.length !== 1) throw badRequest("invalid_screenshot_count");
  return { ...input, images };
}

export async function readQuestFixScreenshot(req: Request) {
  const { metadata, images } = await readMultipartCapture(req, 1);
  const { requestId } = z.strictObject({ requestId: z.uuid() }).parse(metadata);
  return { requestId, images, source: "quest_system" as const };
}
