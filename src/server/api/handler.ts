import "server-only";
import { z } from "zod";
import { log } from "@/server/log";
import { requireSession, UnauthorizedError, type Session } from "@/server/auth/session";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export const notFound = (code = "not_found") => new HttpError(404, code);
export const conflict = (code = "conflict", details?: unknown) => new HttpError(409, code, undefined, details);
export const badRequest = (code = "invalid_request", details?: unknown) =>
  new HttpError(400, code, undefined, details);

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export function jsonError(status: number, code: string, details?: unknown): Response {
  return Response.json(details === undefined ? { error: code } : { error: code, details }, {
    status,
    headers: NO_STORE,
  });
}

/**
 * Wrap a route handler so that (1) a session is required, (2) zod and domain errors map to
 * consistent JSON responses, (3) nothing but a generic message leaks on unexpected failures.
 */
export function authed<Ctx>(
  fn: (session: Session, req: Request, ctx: Ctx) => Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    const started = performance.now();
    try {
      const session = await requireSession();
      return await fn(session, req, ctx);
    } catch (err) {
      if (err instanceof UnauthorizedError) return jsonError(401, "unauthorized");
      if (err instanceof HttpError) return jsonError(err.status, err.code, err.details);
      if (err instanceof z.ZodError) return jsonError(400, "invalid_request", err.flatten());
      log.error({ err, url: req.url }, "route handler failed");
      return jsonError(500, "internal");
    } finally {
      log.debug({ url: req.url, ms: Math.round(performance.now() - started) }, "request");
    }
  };
}

/** Public (unauthenticated) handler with the same error mapping. Use sparingly (health only). */
export function publicHandler<Ctx>(
  fn: (req: Request, ctx: Ctx) => Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return jsonError(err.status, err.code, err.details);
      log.error({ err, url: req.url }, "public handler failed");
      return jsonError(500, "internal");
    }
  };
}
