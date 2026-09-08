import "server-only";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { HttpError } from "@/server/api/handler";

/**
 * Map a domain error onto the `HttpError` that `action()` already knows how to turn into
 * `{ ok: false, error: <code> }`.
 *
 * Without this every action would swallow a `ConflictError` into a generic `"internal"`, and the
 * UI would say "something went wrong" where the domain had said something precise
 * (`already_reversed`, `not_a_kit`, `part_not_estimated`). The whole point of the domain's stable
 * `code` strings is that they reach the screen.
 *
 * It lives under `actions/inventory` and is imported by the other action families rather than
 * duplicated four times; there is no shared `actions/` module to put it in yet.
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof NotFoundError) {
    return new HttpError(404, err.code, err.message, { entity: err.entity, id: err.id });
  }
  if (err instanceof ConflictError) {
    return new HttpError(409, err.code, err.message, err.detail);
  }
  if (err instanceof ValidationError) {
    return new HttpError(422, err.code, err.message, err.detail);
  }
  throw err;
}

/**
 * Run `fn`, re-throwing domain errors as `HttpError`.
 *
 * Anything that is not a domain error escapes untouched, so a real bug still produces a stack
 * trace in the log and a generic message on screen — which is the right way round.
 */
export function mapDomainErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw toHttpError(err);
  }
}
