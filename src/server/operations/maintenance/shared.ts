import "server-only";
import { z } from "zod";
import { revalidatePath } from "@/server/operations/core";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { isInsufficientStockError } from "@/domain/completion";
import { isValidLocalDate } from "@/domain/time";
import { HttpError } from "@/server/api/handler";
import { log } from "@/server/log";

/**
 * Domain error → `HttpError`, so `action()` reports a stable `code` and its `details` instead of
 * collapsing everything to `internal`.
 *
 * This mapping is what makes §5.3's contract work end to end: `insufficient_stock` has to reach
 * the browser **with its lines**, otherwise the form cannot offer the per-line radio group and the
 * user is left with "something went wrong".
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (isInsufficientStockError(err)) {
    return new HttpError(409, "insufficient_stock", err.message, { lines: err.lines });
  }
  if (err instanceof ConflictError) {
    return new HttpError(409, err.code, err.message, err.detail);
  }
  if (err instanceof NotFoundError) {
    return new HttpError(404, "not_found", err.message, { entity: err.entity, id: err.id });
  }
  if (err instanceof ValidationError) {
    return new HttpError(422, err.code, err.message, err.detail);
  }
  return new HttpError(500, "internal", "unexpected failure");
}

/**
 * A validation failure raised *before* the write transaction opens, mapped to the same shape a
 * domain `ValidationError` would produce — so the client sees one vocabulary of error codes
 * whether the check ran in the action or in the domain.
 */
export function invalid(code: string, message: string, detail?: Record<string, unknown>): HttpError {
  return toHttpError(new ValidationError(code, message, detail));
}

/**
 * Run `fn`, converting domain errors into `HttpError`. Anything unrecognised is logged and
 * re-thrown as `internal`, so a genuine bug still leaves a stack trace in the log.
 */
export function domainCall<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const mapped = toHttpError(err);
    if (mapped.status === 500) log.error({ err, what }, "maintenance action failed");
    throw mapped;
  }
}

/** Revalidate the screens a maintenance write can change. */
export function revalidateMaintenance(occurrenceId?: string, planId?: string): void {
  revalidatePath("/today");
  revalidatePath("/history");
  revalidatePath("/plans");
  if (occurrenceId !== undefined) revalidatePath(`/tasks/${occurrenceId}`);
  if (planId !== undefined) revalidatePath(`/plans/${planId}`);
}

/* -------------------------------------------------------------------------------------------------
 * Shared zod pieces
 * ---------------------------------------------------------------------------------------------- */

/** `YYYY-MM-DD` validated by the domain's own predicate, so the two can never disagree. */
export const localDate = z.string().refine(isValidLocalDate, { message: "not a YYYY-MM-DD date" });

export const id = z.string().min(1).max(64);

/**
 * The idempotency key `action()` looks for. Optional on reads-that-write-nothing, required
 * wherever a double-tap must not produce two rows.
 */
export const idempotencyKey = z.string().min(8).max(128);

export const reason = z.string().trim().min(1).max(500);
export const optionalReason = z.string().trim().max(500).optional();
export const optionalNote = z.string().trim().max(4000).optional();

/** Quantities are integers in thousandths (CLAUDE.md rule 5). */
export const qtyMilli = z.number().int().min(0).max(1_000_000_000);
export const positiveQtyMilli = z.number().int().min(1).max(1_000_000_000);
export const minutes = z.number().int().min(0).max(100_000);
