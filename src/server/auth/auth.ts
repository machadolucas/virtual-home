import "server-only";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, username } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { loadEnv } from "@/env";
import { log } from "@/server/log";

/**
 * Variants exist ONLY for the server-side recovery CLI (scripts/vh-admin.ts):
 *  - allowSignUp: lets the CLI create users through the public sign-up endpoint (no session needed).
 *  - captureResetToken: intercepts the password-reset token in-process instead of "emailing" it.
 * The web instance is always built with the defaults (sign-up disabled, tokens dropped).
 */
export interface AuthVariant {
  allowSignUp?: boolean;
  captureResetToken?: (token: string, email: string) => void;
}

export const SYNTHETIC_EMAIL_DOMAIN = "virtual-home.local";

export function buildAuthOptions(variant: AuthVariant = {}): BetterAuthOptions {
  const env = loadEnv();
  return {
    appName: "virtual-home",
    baseURL: env.VH_BASE_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    telemetry: { enabled: false },
    database: drizzleAdapter(getDb().db, { provider: "sqlite", schema }),

    emailAndPassword: {
      enabled: true,
      disableSignUp: variant.allowSignUp !== true,
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
      nextCookies(), // must be last
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
