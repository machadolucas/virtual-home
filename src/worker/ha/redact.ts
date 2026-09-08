/**
 * Secret redaction for anything that may end up in a log line, an error message, or the
 * `integration_status.last_error` column.
 *
 * `HA_TOKEN` is a long-lived access token: leaking it into a log file is equivalent to leaking
 * the whole Home Assistant instance. Every error path in `src/worker/ha` funnels through here.
 */

const ACCESS_TOKEN_FIELD = /("?(?:access_token|accessToken|token|password)"?\s*[:=]\s*)"?[^\s",}]+"?/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Replace known secrets and token-shaped substrings with `[redacted]`.
 * Secrets shorter than 8 characters are ignored: they are not real tokens and blindly replacing
 * a short string would mangle unrelated text.
 */
export function redactSecrets(text: string, ...secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out.replace(ACCESS_TOKEN_FIELD, '$1"[redacted]"').replace(BEARER, "Bearer [redacted]");
}

/** Best-effort message extraction that never stringifies an object graph containing a token. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  return "unknown error";
}
