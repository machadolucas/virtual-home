/**
 * Post-login redirect targets. Pure, so client components (the passkey re-auth prompt) and the
 * server (`src/server/auth/session.ts` re-exports it) apply the same rule.
 */

/** Only same-origin relative paths are valid post-login targets (blocks open redirects). */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/today";
  if (!/^\/(?!\/)/.test(raw)) return "/today";
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return "/today";
  return raw;
}
