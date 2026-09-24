/**
 * Account provisioning and recovery — the only path that creates users or resets passwords.
 *
 * There is no email transport and no public sign-up, so every account operation happens on the
 * machine itself (`scripts/vh-admin.ts`, and the e2e bootstrap). The mechanism is deliberately
 * built out of **documented public endpoints only**
 * (`docs/design-notes/auth-security-operations.md` §4.1), because the alternative —
 * `auth.$context.internalAdapter` + `ctx.password.hash` — is not stable API, and a silent change
 * to hashing or account shape would lock the household out of its own house.
 *
 *  - **create** — a variant auth instance built with `allowSignUp: true` flips `disableSignUp` off
 *    for this process only, which makes `api.signUpEmail` (session-free by design) legal.
 *  - **set password** — a variant with `captureResetToken` intercepts the reset token in-process,
 *    so `api.requestPasswordReset` + `api.resetPassword` run the library's real reset flow with no
 *    mail involved.
 *  - **sessions** — plain Drizzle reads and deletes on `session`. That table is part of *our*
 *    schema (we generate its migration), so this is ordinary data access, not an internals gamble.
 *  - **passkeys** — the same, on `passkey`. Removing a user's passkeys is always an explicit act
 *    (`remove-passkeys`, or the owner's "Remove passkeys"): a password reset and a deactivation
 *    both keep them, because a deactivated member cannot get a session anyway (the
 *    `session.create.before` hook in `buildAuthOptions`) and a forgotten password says nothing
 *    about whether a passkey was compromised.
 *
 * `tests/unit/auth/provisioning.test.ts` is the contract test that makes a Better Auth version
 * bump fail the build instead of the household (§4.2). `better-auth` is pinned exactly.
 *
 * Callers must have the database ready: `buildAuthOptions()` resolves `getDb()` eagerly, so tests
 * call `setDbForTests(handle)` (and the CLI lets `getDb()` open the configured file) *before* any
 * function here runs.
 */
import "server-only";
import { betterAuth } from "better-auth";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { passkey, session, user } from "@/db/schema";
import { passkeyProviderName } from "@/domain/passkeyProviders";
import { buildAuthOptions, SYNTHETIC_EMAIL_DOMAIN, type AuthVariant } from "./auth";
import { deleteExpiredSessions, deleteExpiredVerifications } from "./expiry";

/** Mirrors `emailAndPassword.minPasswordLength` in `buildAuthOptions`. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** Mirrors the `username()` plugin bounds; lowercase because usernames are compared lowercased. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,29}$/;

export class ProvisioningError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/** `<username>@virtual-home.local` — `emailAndPassword` requires an email; nothing sends mail. */
export function syntheticEmail(username: string): string {
  return `${username}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

function assertUsername(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new ProvisioningError(
      `invalid username '${username}': 3–30 characters, lowercase letters, digits, '.', '_' or '-', starting with a letter or digit`,
      "invalid_username",
    );
  }
}

function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ProvisioningError(
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      "password_too_short",
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ProvisioningError(
      `password must be at most ${MAX_PASSWORD_LENGTH} characters`,
      "password_too_long",
    );
  }
}

/**
 * A short-lived auth instance for one provisioning operation. Not cached: a variant instance has
 * sign-up enabled or a reset-token tap installed, and neither should outlive the call that needs
 * it. Building one is cheap (no I/O beyond the already-open database handle).
 */
function variantAuth(variant: AuthVariant) {
  return betterAuth(buildAuthOptions({ ...variant, provisioning: true }));
}

export interface UserRow {
  id: string;
  username: string;
  name: string;
  email: string;
  displayColor: string | null;
  createdAtMs: number;
  /** Session rows that have not expired yet. */
  activeSessions: number;
  /** `session.updatedAt` of the most recently touched session, or null when there is none. */
  lastSeenAtMs: number | null;
  /** Registered passkeys. */
  passkeys: number;
}

function findByUsername(username: string) {
  return getDb()
    .db.select()
    .from(user)
    .where(eq(sql`lower(${user.username})`, username))
    .get();
}

export interface CreateUserInput {
  username: string;
  name: string;
  password: string;
  /** `#rrggbb`; the login avatars and attribution chips use it. */
  displayColor?: string;
}

export interface CreatedUser {
  id: string;
  username: string;
  name: string;
  email: string;
}

/**
 * Create a household member through the public sign-up endpoint.
 *
 * `signUpEmail` signs the new user in (Better Auth's `autoSignIn` default), which would leave a
 * live session row created by a CLI nobody is sitting in front of — so the session is deleted
 * again before returning. `displayColor` is `input: false` in the auth options (a client must not
 * be able to set it), so it is written straight to our own column afterwards.
 */
export async function createUser(input: CreateUserInput): Promise<CreatedUser> {
  const username = normalizeUsername(input.username);
  const name = input.name.trim();
  assertUsername(username);
  if (name === "") throw new ProvisioningError("name must not be empty", "invalid_name");
  assertPassword(input.password);
  if (input.displayColor !== undefined && !/^#[0-9a-f]{6}$/.test(input.displayColor)) {
    throw new ProvisioningError("displayColor must be a lowercase #rrggbb colour", "invalid_color");
  }
  if (findByUsername(username)) {
    throw new ProvisioningError(`user '${username}' already exists`, "user_exists");
  }

  const email = syntheticEmail(username);
  const auth = variantAuth({ allowSignUp: true });
  // `username` and `displayUsername` come from the username plugin's sign-up extension. The cast
  // is only about the inferred body type of a plugin-extended endpoint, not about the values.
  await auth.api.signUpEmail({
    body: { email, password: input.password, name, username, displayUsername: name } as never,
  });

  const row = findByUsername(username);
  if (!row) {
    throw new ProvisioningError(
      "sign-up reported success but no user row exists — check the Better Auth adapter wiring",
      "create_failed",
    );
  }

  writeTx(getDb().db, (tx) => {
    if (input.displayColor !== undefined) {
      tx.update(user).set({ displayColor: input.displayColor }).where(eq(user.id, row.id)).run();
    }
    // Sign-up auto-signs-in; a provisioning run must not leave a usable session behind.
    tx.delete(session).where(eq(session.userId, row.id)).run();
  });

  return { id: row.id, username, name, email: row.email };
}

export interface SetPasswordResult {
  userId: string;
  username: string;
  /** Sessions deleted as part of the reset. */
  revokedSessions: number;
}

/**
 * Reset a password with the library's own reset flow, capturing the token in-process.
 *
 * Better Auth's `resetPassword` does not itself revoke sessions, so this deletes them: a password
 * reset is a recovery action, and the old device must not stay signed in. The 60 s cookie cache
 * (`session.cookieCache.maxAge`) means an already-issued cookie can still resolve for up to a
 * minute on read paths — `requireFreshSession()` is what closes that window on security pages.
 */
export async function setPassword(rawUsername: string, newPassword: string): Promise<SetPasswordResult> {
  const username = normalizeUsername(rawUsername);
  assertPassword(newPassword);
  const row = findByUsername(username);
  if (!row) throw new ProvisioningError(`no such user: ${username}`, "unknown_user");

  let token: string | undefined;
  const auth = variantAuth({
    captureResetToken: (captured) => {
      token = captured;
    },
  });

  await auth.api.requestPasswordReset({ body: { email: row.email, redirectTo: "/login" } });
  if (!token) {
    throw new ProvisioningError(
      "the password-reset token was not produced — check the `sendResetPassword` wiring in buildAuthOptions",
      "no_reset_token",
    );
  }
  await auth.api.resetPassword({ body: { newPassword, token } });

  const revokedSessions = writeTx(
    getDb().db,
    (tx) => tx.delete(session).where(eq(session.userId, row.id)).run().changes,
  );
  return { userId: row.id, username, revokedSessions };
}

/** Every household member with session activity, oldest account first. */
export function listUsers(): UserRow[] {
  const db = getDb().db;
  const rows = db.select().from(user).orderBy(user.createdAt).all();
  const now = new Date();
  return rows.map((row) => {
    const active = db
      .select({ n: sql<number>`count(*)` })
      .from(session)
      .where(and(eq(session.userId, row.id), sql`${session.expiresAt} > ${now.getTime()}`))
      .get();
    const latest = db
      .select({ updatedAt: session.updatedAt })
      .from(session)
      .where(eq(session.userId, row.id))
      .orderBy(desc(session.updatedAt))
      .limit(1)
      .get();
    const keys = db
      .select({ n: sql<number>`count(*)` })
      .from(passkey)
      .where(eq(passkey.userId, row.id))
      .get();
    return {
      id: row.id,
      username: row.username ?? row.displayUsername ?? "",
      name: row.name,
      email: row.email,
      displayColor: row.displayColor,
      createdAtMs: row.createdAt.getTime(),
      activeSessions: active?.n ?? 0,
      lastSeenAtMs: latest?.updatedAt ? latest.updatedAt.getTime() : null,
      passkeys: keys?.n ?? 0,
    };
  });
}

/** Delete session rows for one user, or for everybody when `target` is `'*'`. Returns the count. */
export function revokeSessions(target: string): number {
  const db = getDb().db;
  if (target === "*") {
    return writeTx(db, (tx) => tx.delete(session).run().changes);
  }
  const username = normalizeUsername(target);
  const row = findByUsername(username);
  if (!row) throw new ProvisioningError(`no such user: ${username}`, "unknown_user");
  return writeTx(db, (tx) => tx.delete(session).where(eq(session.userId, row.id)).run().changes);
}

/** Housekeeping: drop expired session rows (the worker does this hourly too). */
export function pruneExpiredSessions(nowMs: number = Date.now()): number {
  return writeTx(getDb().db, (tx) => deleteExpiredSessions(tx, nowMs));
}

/**
 * Housekeeping: drop expired `verification` rows — abandoned WebAuthn challenges and unused reset
 * tokens (the worker does this hourly too; see `src/server/auth/expiry.ts`). Live rows are kept,
 * so a sign-in or reset in progress is never interrupted.
 */
export function pruneExpiredVerifications(nowMs: number = Date.now()): number {
  return writeTx(getDb().db, (tx) => deleteExpiredVerifications(tx, nowMs));
}

export interface PasskeyInfo {
  id: string;
  /** The stored label; null only for rows written before a default name existed. */
  name: string | null;
  /** From the AAGUID when it is one we know (`src/domain/passkeyProviders.ts`). */
  provider: string | null;
  /** `singleDevice` (bound to one authenticator) or `multiDevice` (synced, e.g. iCloud Keychain). */
  deviceType: string;
  backedUp: boolean;
  createdAtMs: number | null;
  /** Last passkey sign-in (`passkey.lastUsedAt`); null when none has been recorded. */
  lastUsedAtMs: number | null;
}

/**
 * One user's passkeys, oldest first. Never returns the public key or the credential ID: neither is
 * a secret, but nothing an operator does needs them, and a list that prints less leaks less.
 */
export function listPasskeys(target: string): PasskeyInfo[] {
  const username = normalizeUsername(target);
  const row = findByUsername(username);
  if (!row) throw new ProvisioningError(`no such user: ${username}`, "unknown_user");
  return getDb()
    .db.select()
    .from(passkey)
    .where(eq(passkey.userId, row.id))
    .orderBy(passkey.createdAt)
    .all()
    .map((key) => ({
      id: key.id,
      name: key.name,
      provider: passkeyProviderName(key.aaguid),
      deviceType: key.deviceType,
      backedUp: key.backedUp,
      createdAtMs: key.createdAt ? key.createdAt.getTime() : null,
      lastUsedAtMs: key.lastUsedAt ? key.lastUsedAt.getTime() : null,
    }));
}

/**
 * Delete every passkey of one user. Returns the count. Sessions are untouched: this is about which
 * credentials can sign in *next*, and `revoke-sessions` / `set-password` handle the devices that
 * are signed in now.
 */
export function removePasskeys(target: string): number {
  const username = normalizeUsername(target);
  const row = findByUsername(username);
  if (!row) throw new ProvisioningError(`no such user: ${username}`, "unknown_user");
  return writeTx(getDb().db, (tx) => tx.delete(passkey).where(eq(passkey.userId, row.id)).run().changes);
}
