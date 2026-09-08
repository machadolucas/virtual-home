import "server-only";
import { z } from "zod";
import { and, eq, gte } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { idempotencyKey } from "@/db/schema";
import { log } from "@/server/log";
import { requireSession, UnauthorizedError, type Session } from "@/server/auth/session";
import { HttpError } from "./handler";

export type ActionResult<O> =
  | { ok: true; data: O }
  | { ok: false; error: string; details?: unknown };

/**
 * How long a stored result may be replayed. The worker's housekeeping pass deletes keys past the
 * same age, but it only runs while the worker runs — and a replay is a write that silently does
 * not happen, so the window is enforced here too rather than trusted to a background job.
 */
const REPLAY_WINDOW_MS = 86_400_000;

/**
 * Server-action wrapper: requires a session, validates input with zod, and (when the input carries
 * `idempotencyKey`) replays the stored result instead of running the mutation twice. Clients create
 * the key once per form instance, not per submit.
 *
 * The replay lookup is scoped to the signed-in user and to `REPLAY_WINDOW_MS`. The key column is a
 * bare primary key, so a key chosen from the client's own data — rather than from a random source —
 * can collide across people and across days; a collision replays somebody else's stored response
 * and reports a success for a write that never happened. Scoping does not make a badly chosen key
 * safe, but it stops one household member's key from answering another's request.
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
      const hit = db
        .select()
        .from(idempotencyKey)
        .where(
          and(
            eq(idempotencyKey.key, key),
            eq(idempotencyKey.userId, session.user.id),
            gte(idempotencyKey.createdAtMs, Date.now() - REPLAY_WINDOW_MS),
          ),
        )
        .get();
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
