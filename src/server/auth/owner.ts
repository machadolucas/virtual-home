import "server-only";
import type { z } from "zod";
import { getDb, type Db } from "@/db/client";
import { readMemberAccess } from "@/domain/memberAccess";
import { HttpError } from "@/server/api/handler";
import { freshAction, type ActionResult } from "@/server/api/action";
import { requireFreshSession, UnauthorizedError, type Session } from "./session";

export function assertOwner(db: Db, userId: string): void {
  const access = readMemberAccess(db, userId);
  if (!access?.active || access.role !== "owner") throw new HttpError(403, "owner_required", "Only a household owner can manage members.");
}
export function ownerAction<I extends z.ZodTypeAny, O>(input: I, run: (value: z.infer<I>, session: Session) => Promise<O> | O): (raw: unknown) => Promise<ActionResult<O>> {
  const wrapped = freshAction(input, (value, session) => { assertOwner(getDb().db, session.user.id); return run(value, session); });
  return async raw => {
    try { const session = await requireFreshSession(); assertOwner(getDb().db, session.user.id); }
    catch (error) { return { ok: false, error: error instanceof UnauthorizedError ? "unauthorized" : "owner_required" }; }
    return wrapped(raw);
  };
}
