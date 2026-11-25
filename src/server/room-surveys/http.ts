import "server-only";
import { badRequest, HttpError } from "@/server/api/handler";

export async function readSurveyJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get("x-vh-room-survey") !== "1") throw new HttpError(403, "survey_header_required");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new HttpError(415, "json_required");
  if (Number(request.headers.get("content-length") ?? 0) > limit)
    throw new HttpError(413, "survey_body_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw badRequest("body_required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "survey_body_too_large");
    }
    chunks.push(chunk.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw badRequest("invalid_json");
  }
}
