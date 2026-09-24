/**
 * Deleting Better Auth rows that are past their `expiresAt`. Shared by the worker's hourly
 * housekeeping pass and `vh-admin prune-sessions`, so the automatic and the on-demand cleanup can
 * never disagree about what "expired" means.
 *
 *  - `session`: Better Auth checks expiry on read, so an expired row can never authenticate.
 *  - `verification`: single-use challenges and tokens — the WebAuthn challenge written by every
 *    `/passkey/generate-*-options` call (5 minutes; the login page asks for one on every load for
 *    autofill), and the password-reset token (15 minutes). The passkey and reset flows consume
 *    theirs through `consumeVerificationValue`, which deletes the row it uses but never sweeps the
 *    others, and it refuses an expired row anyway. So an abandoned challenge is dead weight from
 *    the moment it expires. Better Auth's own `findVerificationValue` runs this same
 *    `expiresAt < now` delete when it is called; nothing on our paths calls it.
 *
 * Neither table holds anything a person entered. `expiresAt` is a `timestamp_ms` column (see
 * `src/db/schema/auth.ts`), so the bound value is a `Date`, not a number.
 */
import { lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { session, verification } from "@/db/schema/auth";

/** Delete sessions whose `expiresAt` is before `nowMs`. Returns the count. Call inside `writeTx`. */
export function deleteExpiredSessions(tx: Db, nowMs: number): number {
  return Number(tx.delete(session).where(lt(session.expiresAt, new Date(nowMs))).run().changes ?? 0);
}

/** Delete verification rows whose `expiresAt` is before `nowMs`. Returns the count. Call inside `writeTx`. */
export function deleteExpiredVerifications(tx: Db, nowMs: number): number {
  return Number(tx.delete(verification).where(lt(verification.expiresAt, new Date(nowMs))).run().changes ?? 0);
}
