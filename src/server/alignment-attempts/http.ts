import "server-only";
import { loadEnv } from "@/env";
import { HttpError } from "@/server/api/handler";

export function checkAlignmentOrigin(req: Request, write = false) {
  const origin = req.headers.get("origin"), site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "invalid_origin");
  if (origin) {
    const host = req.headers.get("host") ?? new URL(req.url).host;
    if (!loadEnv().trustedOrigins.some(allowed => {
      const url = new URL(allowed);
      return url.origin === origin && url.host === host;
    })) throw new HttpError(403, "invalid_origin");
  }
  if (write && (req.headers.get("x-vh-alignment") !== "1" || (!origin && site !== "same-origin")))
    throw new HttpError(403, "alignment_same_origin_required");
}
