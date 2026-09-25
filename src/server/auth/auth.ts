import "server-only";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, username } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { and, eq, ne } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import * as schema from "@/db/schema";
import { loadEnv } from "@/env";
import { isActiveMember } from "@/domain/memberAccess";
import { defaultPasskeyName, PASSKEY_REAUTH_REQUIRED } from "@/domain/passkeyProviders";
import { log } from "@/server/log";

/**
 * Variants exist ONLY for the server-side recovery CLI (scripts/vh-admin.ts):
 *  - allowSignUp: lets the CLI create users through the public sign-up endpoint (no session needed).
 *  - captureResetToken: intercepts the password-reset token in-process instead of "emailing" it.
 * The web instance is always built with the defaults (sign-up disabled, tokens dropped).
 */
export interface AuthVariant {
  allowSignUp?: boolean;
  /** Internal provisioning must never replace the acting owner's browser cookie. */
  provisioning?: boolean;
  captureResetToken?: (token: string, email: string) => void;
}

export const SYNTHETIC_EMAIL_DOMAIN = "virtual-home.local";

/**
 * A passkey can only be added from a session that signed in within this window.
 *
 * `session.freshAge` is 0 (list-sessions needs it), so the plugin's own `freshSessionMiddleware`
 * admits any live session. Without this guard a stolen session cookie could register the thief's
 * passkey — a credential that survives the victim changing their password. Requiring a recent
 * sign-in (password or passkey; both create a new session) closes that path without changing
 * `freshAge` for everything else.
 */
export const PASSKEY_REGISTRATION_MAX_SESSION_AGE_MS = 10 * 60 * 1000;
/** `@better-auth/passkey` 1.7.5: the first step of registration; `verify-registration` needs its challenge. */
const PASSKEY_REGISTER_OPTIONS_PATH = "/passkey/generate-register-options";

const passkeyRegistrationGuard = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== PASSKEY_REGISTER_OPTIONS_PATH) return;
  const current = await getSessionFromCtx(ctx);
  if (!current) return; // the endpoint's own session middleware answers 401
  const createdMs = new Date(current.session.createdAt).getTime();
  if (!Number.isFinite(createdMs) || Date.now() - createdMs > PASSKEY_REGISTRATION_MAX_SESSION_AGE_MS) {
    throw new APIError("FORBIDDEN", {
      code: PASSKEY_REAUTH_REQUIRED,
      message: "For security, sign in again to add a passkey.",
    });
  }
});

/** `@better-auth/passkey` 1.7.5: the sign-in step that checks the assertion and mints the session. */
const PASSKEY_VERIFY_AUTHENTICATION_PATH = "/passkey/verify-authentication";

/**
 * Stamp `passkey.lastUsedAt` (our column, not the plugin's) after a passkey sign-in.
 *
 * An after-hook rather than the plugin's `authentication.afterVerification`, because that callback
 * runs *before* the session is created: a deactivated member's valid signature would be recorded
 * as a use even though `session.create.before` then refuses the sign-in. Here the stamp needs
 * `newSession`, which only exists once a session was actually minted, and it is scoped to that
 * session's user (`credentialID` is indexed, not unique). A failed stamp is logged and never fails
 * the sign-in.
 */
type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

async function stampPasskeyLastUsed(ctx: AuthHookContext): Promise<void> {
  if (ctx.path !== PASSKEY_VERIFY_AUTHENTICATION_PATH) return;
  const userId = ctx.context.newSession?.user.id;
  const credentialId: unknown = (ctx.body as { response?: { id?: unknown } } | undefined)?.response?.id;
  if (!userId || typeof credentialId !== "string" || credentialId === "") return;
  try {
    writeTx(getDb().db, (tx) =>
      tx
        .update(schema.passkey)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(schema.passkey.credentialID, credentialId), eq(schema.passkey.userId, userId)))
        .run(),
    );
  } catch (err) {
    log.warn({ err, userId }, "could not record passkey last use");
  }
}

const REVOKE_OTHER_SESSIONS_PATH = "/revoke-other-sessions";

/**
 * Finish "Sign out other devices" for users with more than 100 sessions.
 *
 * Better Auth 1.7.5's `revokeOtherSessions` finds the sessions to delete with `listSessions`, which
 * goes through the adapter's `findMany` without a limit — so the default
 * `advanced.database.defaultFindManyLimit` of 100 applies and any session beyond the first 100 rows
 * survives, typically the newest device. Raising that limit globally would change every other
 * `findMany`; instead, once the endpoint has succeeded, delete the user's remaining sessions except
 * the one making the request, by `userId` in one statement. There is no secondary session storage
 * here, so the table is the whole truth.
 */
async function finishRevokeOtherSessions(ctx: AuthHookContext): Promise<void> {
  if (ctx.path !== REVOKE_OTHER_SESSIONS_PATH) return;
  if (ctx.context.returned instanceof APIError) return;
  const current = await getSessionFromCtx(ctx, { disableCookieCache: true });
  if (!current) return;
  writeTx(getDb().db, (tx) =>
    tx
      .delete(schema.session)
      .where(and(eq(schema.session.userId, current.user.id), ne(schema.session.token, current.session.token)))
      .run(),
  );
}

const afterAuthEndpoint = createAuthMiddleware(async (ctx) => {
  await stampPasskeyLastUsed(ctx);
  await finishRevokeOtherSessions(ctx);
});

export function buildAuthOptions(variant: AuthVariant = {}): BetterAuthOptions {
  const env = loadEnv();
  return {
    appName: "virtual-home",
    baseURL: env.VH_BASE_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    telemetry: { enabled: false },
    database: drizzleAdapter(getDb().db, { provider: "sqlite", schema }),

    // Every session is minted through this hook — password sign-in, passkey sign-in
    // (`/passkey/verify-authentication`) and CLI provisioning alike — so an inactive or banned
    // member can hold a password or a passkey and still never get a session.
    // Applies to every instance built here, the CLI variants included (they never register
    // passkeys: registration needs a browser ceremony).
    hooks: { before: passkeyRegistrationGuard, after: afterAuthEndpoint },

    databaseHooks: { session: { create: { before: async data => { if (!isActiveMember(getDb().db, data.userId)) throw new APIError("UNAUTHORIZED", { message: "Invalid username or password" }); return { data }; } } } },

    emailAndPassword: {
      enabled: true,
      disableSignUp: variant.allowSignUp !== true,
      autoSignIn: variant.provisioning !== true,
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 15,
      sendResetPassword: async ({ user, token }) => {
        if (variant.captureResetToken) {
          variant.captureResetToken(token, user.email);
          return;
        }
        log.warn({ userId: user.id }, "password reset requested; use `pnpm vh-admin set-password`");
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // 0 disables the "fresh session" gate: with it, list-sessions returns 403 for any session
      // older than freshAge. Password change still requires the current password.
      freshAge: 0,
      cookieCache: { enabled: true, maxAge: 60 },
    },

    trustedOrigins: env.trustedOrigins,

    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "rateLimit",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/username": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 5 },
        "/reset-password": { window: 300, max: 5 },
        "/request-password-reset": { window: 300, max: 3 },
        // Passkey sign-in. The options call runs on every login page load (conditional UI) and
        // again for the button, so it gets more room than the verify step, which is the actual
        // credential check. Each options call also writes a short-lived verification row.
        "/passkey/generate-authenticate-options": { window: 60, max: 20 },
        "/passkey/verify-authentication": { window: 60, max: 5 },
        // Registration, list, rename, delete: all need a session; this only caps a runaway client.
        "/passkey/*": { window: 60, max: 30 },
      },
    },

    advanced: {
      useSecureCookies: env.cookieSecure,
      cookiePrefix: "vh",
      defaultCookieAttributes: {
        sameSite: "lax", // HA notification links are cross-site top-level navigations
        secure: env.cookieSecure,
        httpOnly: true,
        path: "/",
      },
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },

    user: {
      additionalFields: {
        displayColor: { type: "string", required: false, input: false },
      },
    },

    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 30 }),
      admin(),
      passkey({
        // A passkey is bound to this exact hostname, which is the point: password autofill matches
        // the registrable domain and mixes sibling apps, a passkey never does. The RP ID cannot be
        // an IP address, so development must use `localhost`, not 127.0.0.1.
        rpID: new URL(env.VH_BASE_URL).hostname,
        rpName: "Virtual Home",
        origin: new URL(env.VH_BASE_URL).origin,
        // Discoverable credentials only: sign-in starts with no username (the passkey button and
        // conditional UI), so a non-resident key could be registered but never used.
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        registration: {
          // `generate-register-options` and `verify-registration` use `freshSessionMiddleware`,
          // which `session.freshAge: 0` above keeps open to any signed-in session.
          afterVerification: ({ ctx, verification }) => ({
            name: defaultPasskeyName(verification.registrationInfo?.aaguid, ctx.headers?.get("user-agent")),
          }),
        },
      }),
      ...(variant.provisioning ? [] : [nextCookies()]), // browser integration must be last
    ],
  };
}

let instance: ReturnType<typeof betterAuth> | null = null;

/** The web process's auth instance (lazy so importing this module has no side effects). */
export function getAuth() {
  if (!instance) instance = betterAuth(buildAuthOptions());
  return instance;
}

export type Auth = ReturnType<typeof getAuth>;
