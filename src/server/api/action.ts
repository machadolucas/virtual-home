import "server-only";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { idempotencyKey } from "@/db/schema";
import { log } from "@/server/log";
import { requireSession, UnauthorizedError, type Session } from "@/server/auth/session";
import { HttpError } from "./handler";

export type ActionResult<O> =
  | { ok: true; data: O }
  | { ok: false; error: string; details?: unknown };

/**
 * Server-action wrapper: requires a session, validates input with zod, and (when the input carries
 * `idempotencyKey`) replays the stored result instead of running the mutation twice. Clients create
 * the key once per form instance, not per submit.
 */
export function action<I extends z.ZodTypeAny, O>(
  input: I,
  run: (value: z.infer<I>, session: Session) => Promise<O> | O,
): (raw: unknown) => Promise<ActionResult<O>> {
  return async (raw) => {
    let session: Session;
    try {
      session = await requireSession();
    } catch (err) {
      if (err instanceof UnauthorizedError) return { ok: false, error: "unauthorized" };
      throw err;
    }
    const parsed = input.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid_request", details: parsed.error.flatten() };
    const key = (parsed.data as { idempotencyKey?: string }).idempotencyKey;
    const { db } = getDb();
    if (key) {
      const hit = db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key)).get();
      if (hit) return JSON.parse(hit.responseJson) as ActionResult<O>;
    }
    try {
      const data = await run(parsed.data, session);
      const result: ActionResult<O> = { ok: true, data };
      if (key) {
        writeTx(db, (tx) => {
          tx.insert(idempotencyKey)
            .values({
              key,
              userId: session.user.id,
              responseJson: JSON.stringify(result),
              createdAtMs: Date.now(),
            })
            .onConflictDoNothing()
            .run();
        });
      }
      return result;
    } catch (err) {
      if (err instanceof HttpError) return { ok: false, error: err.code, details: err.details };
      log.error({ err }, "server action failed");
      return { ok: false, error: "internal" };
    }
  };
}
