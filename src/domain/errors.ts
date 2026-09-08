/**
 * Domain error types. Deliberately four small classes, not a hierarchy: every caller either maps
 * them to an HTTP status (409 / 404 / 422) or lets them escape as a bug.
 *
 * `code` is a stable machine-readable string (`'successor_touched'`, `'occurrence_not_open'`, …)
 * that the UI and the tests assert on; `message` is for humans and logs.
 */

/** A precondition asserted *inside* the write transaction failed → HTTP 409. */
export class ConflictError extends Error {
  readonly code: string;
  /** Free-form extra context (current status, blocking rows, …) for the API layer. */
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: string, message?: string, detail?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "ConflictError";
    this.code = code;
    this.detail = detail;
  }
}

/** A referenced row does not exist → HTTP 404. */
export class NotFoundError extends Error {
  readonly code: string;
  readonly entity: string | undefined;
  readonly id: string | undefined;

  constructor(entity: string, id?: string, message?: string) {
    super(message ?? (id === undefined ? `${entity} not found` : `${entity} not found: ${id}`));
    this.name = "NotFoundError";
    this.code = "not_found";
    this.entity = entity;
    this.id = id;
  }
}

/** Input the domain refuses (bad LocalDate, unsupported recurrence kind, …) → HTTP 422. */
export class ValidationError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: string, message?: string, detail?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "ValidationError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * An invariant this code is supposed to guarantee was violated — never expected, never caught,
 * always a bug worth a stack trace.
 */
export class ProgrammerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgrammerError";
  }
}

/** `err instanceof ConflictError` as a type guard usable across the esbuild/Next bundle boundary. */
export function isConflictError(err: unknown): err is ConflictError {
  return err instanceof ConflictError;
}
