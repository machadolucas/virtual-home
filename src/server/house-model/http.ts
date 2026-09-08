import "server-only";
import { HttpError } from "@/server/api/handler";
import { ModelPackageError, requireCurrentPackage, type CurrentPackage } from "./package";

/**
 * Cache headers for content-addressed package files. `private` (never `public`): these are
 * authenticated household files, and a shared cache must never hold them.
 */
export function immutableHeaders(etag: string): Record<string, string> {
  return {
    ETag: etag,
    "Cache-Control": "private, max-age=31536000, immutable",
    Vary: "Cookie",
  };
}

/** Runtime data endpoints answer from the database and the live package; never cache them. */
export const NO_STORE = { "Cache-Control": "private, no-store", Vary: "Cookie" } as const;

/** RFC 9110 `If-None-Match`: `*`, or any (weakly compared) entity tag in the list. */
export function notModified(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match");
  if (!header) return false;
  if (header.trim() === "*") return true;
  const want = strip(etag);
  return header
    .split(",")
    .map((t) => strip(t.trim()))
    .some((t) => t === want);
}

const strip = (tag: string): string => tag.replace(/^W\//, "").replace(/^"|"$/g, "");

/**
 * The installed package for a request, with `ModelPackageError` mapped to a status instead of
 * falling through to a generic 500. "Nothing installed yet" is a setup state the client renders,
 * so it answers `409 no_package`; an unreadable package on disk is a `503`.
 */
export async function currentPackageForRequest(modelId: string): Promise<CurrentPackage> {
  let pkg: CurrentPackage;
  try {
    pkg = await requireCurrentPackage();
  } catch (err) {
    if (err instanceof ModelPackageError)
      throw new HttpError(err.code === "no_package" ? 409 : 503, err.code, err.message, err.details);
    throw err;
  }
  if (pkg.modelId !== modelId) throw new HttpError(404, "unknown_model");
  return pkg;
}
