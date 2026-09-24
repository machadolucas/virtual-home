import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isActiveMember } from "@/domain/memberAccess";
import { getAuth } from "./auth";

export type Session = NonNullable<Awaited<ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>>>;
export type SessionUser = Session["user"];

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** Session for the current request; deduplicated per render via React cache(). May use the cookie cache (≤60 s stale). */
export const getSession = cache(async (): Promise<Session | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session && isActiveMember(getDb().db, session.user.id) ? session : null;
});

/** Bypasses the cookie cache: for destructive operations and the security settings page. */
export async function getFreshSession(): Promise<Session | null> {
  const session = await getAuth().api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  return session && isActiveMember(getDb().db, session.user.id) ? session : null;
}

/** Route handlers and server actions: throws UnauthorizedError (→ 401). */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new UnauthorizedError();
  return s;
}

export async function requireFreshSession(): Promise<Session> {
  const s = await getFreshSession();
  if (!s) throw new UnauthorizedError();
  return s;
}

/** Pages: redirects to /login?next=… when there is no session. */
export async function requireSessionPage(nextPath: string): Promise<Session> {
  const s = await getSession();
  if (!s) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return s;
}

/** Only same-origin relative paths are valid post-login targets (blocks open redirects). */
export { safeNextPath } from "@/domain/nextPath";
