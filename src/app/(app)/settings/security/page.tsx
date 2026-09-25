import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { passkey } from "@/db/schema";
import { passkeyProviderName } from "@/domain/passkeyProviders";
import { getFreshSession, requireSessionPage } from "@/server/auth/session";
import { log } from "@/server/log";
import { listActiveSessions } from "@/server/queries/settings/sessions";
import { loadEnv } from "@/env";
import { PageHeader } from "@/ui/shell";
import { describeDevice } from "@/domain/deviceLabel";
import { SecurityClient, type PasskeyRow, type SessionListState } from "./SecurityClient";

export const metadata: Metadata = { title: "Security" };

const SELF = "/settings/security";

export default async function SecuritySettingsPage() {
  await requireSessionPage(SELF);

  // This page shows and revokes sessions, so it must not read a session
  // snapshot that could be up to 60 s out of date (see the cookie-cache
  // tradeoff in docs/design-notes/auth-security-operations.md §3.1).
  const session = await getFreshSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(SELF)}`);

  const list = loadSessions(session.user.id, session.session.token);
  const passkeys = loadPasskeys(session.user.id);

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Security"
        description="Your password, your passkeys and the devices signed in as you. Owners manage other members' accounts; the recovery tier is shell access to the machine it runs on."
      />
      <SecurityClient list={list} passkeys={passkeys} />
      <p className="text-xs leading-5 text-ink-3">
        Forgotten passwords are reset from the server with{" "}
        <code className="font-mono">pnpm vh-admin set-password</code>. There is no email transport
        here, so there is no reset link to send — and therefore no reset link to steal.
      </p>
    </>
  );
}

/**
 * The signed-in user's own passkeys, read straight from our `passkey` table (the same rows
 * `/passkey/list-user-passkeys` returns). Public keys and credential IDs never leave the server.
 */
function loadPasskeys(userId: string): PasskeyRow[] {
  return getDb()
    .db.select()
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .orderBy(asc(passkey.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name ?? passkeyProviderName(row.aaguid) ?? "Passkey",
      provider: passkeyProviderName(row.aaguid),
      synced: row.deviceType === "multiDevice",
      backedUp: row.backedUp,
      createdLabel: formatInstant(row.createdAt ? row.createdAt.getTime() : null),
      lastUsedLabel: row.lastUsedAt ? formatInstant(row.lastUsedAt.getTime()) : null,
    }));
}

/**
 * Every active session of the signed-in user, read from our `session` table. Not Better Auth's
 * `listSessions`: in 1.7.5 it stops at the adapter's 100-row `findMany` default, so a user with
 * more sessions saw the oldest 100 and usually not the device in hand (see `listActiveSessions`).
 */
function loadSessions(userId: string, currentToken: string): SessionListState {
  try {
    const rows = listActiveSessions(getDb().db, userId, currentToken, Date.now()).map((row) => ({
      id: row.id,
      token: row.token,
      device: describeDevice(row.userAgent),
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      createdLabel: formatInstant(row.createdMs),
      expiresLabel: formatInstant(row.expiresMs),
      current: row.current,
    }));
    return { kind: "ok", sessions: rows };
  } catch (err) {
    log.warn({ err, userId }, "could not read the session list");
    return { kind: "failed" };
  }
}

/** Household-local wall clock, so "signed in 21:40" means what the user saw. */
function formatInstant(value: number | null): string {
  if (value === null) return "unknown";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: loadEnv().VH_HOUSEHOLD_TZ,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
