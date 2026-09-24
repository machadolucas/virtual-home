import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { passkey } from "@/db/schema";
import { passkeyProviderName } from "@/domain/passkeyProviders";
import { getAuth } from "@/server/auth/auth";
import { getFreshSession, requireSessionPage } from "@/server/auth/session";
import { loadEnv } from "@/env";
import { PageHeader } from "@/ui/shell";
import { describeDevice } from "@/domain/deviceLabel";
import { SecurityClient, type PasskeyRow, type SessionListState, type SessionRow } from "./SecurityClient";

export const metadata: Metadata = { title: "Security" };

const SELF = "/settings/security";

export default async function SecuritySettingsPage() {
  await requireSessionPage(SELF);

  // This page shows and revokes sessions, so it must not read a session
  // snapshot that could be up to 60 s out of date (see the cookie-cache
  // tradeoff in docs/design-notes/auth-security-operations.md §3.1).
  const session = await getFreshSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(SELF)}`);

  const list = await loadSessions(session.session.token);
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
    }));
}

async function loadSessions(currentToken: string): Promise<SessionListState> {
  const requestHeaders = await headers();
  try {
    const result = await getAuth().api.listSessions({ headers: requestHeaders });
    const rows = toArray(result)
      .map((entry) => toRow(entry, currentToken))
      .filter((row): row is RowWithSort => row !== null)
      // Current device first, then most recently created.
      .sort((a, b) => Number(b.current) - Number(a.current) || b.createdMs - a.createdMs);
    return { kind: "ok", sessions: rows };
  } catch (error) {
    return { kind: isNotFresh(error) ? "not-fresh" : "failed" };
  }
}

/** `listSessions` returns an array; tolerate a `{ sessions: [] }` envelope. */
function toArray(result: unknown): readonly unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    const nested = (result as Record<string, unknown>)["sessions"];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

interface RowWithSort extends SessionRow {
  createdMs: number;
}

function toRow(entry: unknown, currentToken: string): RowWithSort | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const token = str(record["token"]);
  const id = str(record["id"]) ?? token;
  if (!token || !id) return null;

  const userAgent = str(record["userAgent"]);
  const createdMs = ms(record["createdAt"]);
  const expiresMs = ms(record["expiresAt"]);

  return {
    id,
    token,
    device: describeDevice(userAgent),
    userAgent,
    ipAddress: str(record["ipAddress"]),
    createdLabel: formatInstant(createdMs),
    expiresLabel: formatInstant(expiresMs),
    current: token === currentToken,
    createdMs: createdMs ?? 0,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Instants are epoch milliseconds everywhere in this app (CLAUDE.md rule 4). */
function ms(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
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

/**
 * `/list-sessions` is behind Better Auth's fresh-session middleware, so an
 * ordinary long-lived session gets 403 SESSION_NOT_FRESH rather than a list.
 * That is a normal state for this page, not an error to log.
 */
function isNotFresh(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  if (record["status"] === "FORBIDDEN" || record["statusCode"] === 403) return true;
  const body = record["body"];
  if (body && typeof body === "object") {
    const code = (body as Record<string, unknown>)["code"];
    if (typeof code === "string" && code.includes("FRESH")) return true;
  }
  const message = record["message"];
  return typeof message === "string" && /fresh/i.test(message);
}
