import "server-only";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { session } from "@/db/schema";

export interface ActiveSessionRow {
  id: string;
  token: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdMs: number;
  expiresMs: number;
  /** The session making this request. */
  current: boolean;
}

/**
 * Every unexpired session of one user, the current one first and then newest first.
 *
 * Settings -> Security used to read this through Better Auth's `listSessions`, which in 1.7.5 goes
 * through the adapter's `findMany` without a limit, so the default `defaultFindManyLimit` of 100
 * applied: a user with more than 100 session rows saw only the oldest 100, usually without the
 * device they were holding (the same limit `finishRevokeOtherSessions` in `auth.ts` works around).
 * The `session` table is ours and there is no secondary session storage, so it is read directly,
 * with the same filters the endpoint applies: not expired, and not an admin impersonation (the admin
 * plugin hides those from `/list-sessions`).
 */
export function listActiveSessions(db: Db, userId: string, currentToken: string, nowMs: number): ActiveSessionRow[] {
  const rows = db
    .select({
      id: session.id,
      token: session.token,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    })
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date(nowMs)), isNull(session.impersonatedBy)))
    .orderBy(desc(session.createdAt), desc(session.id))
    .all()
    .map((row) => ({
      id: row.id,
      token: row.token,
      userAgent: row.userAgent || null,
      ipAddress: row.ipAddress || null,
      createdMs: row.createdAt.getTime(),
      expiresMs: row.expiresAt.getTime(),
      current: row.token === currentToken,
    }));
  // Stable sort: the current device moves to the top, everything else stays newest first.
  return rows.sort((a, b) => Number(b.current) - Number(a.current));
}
