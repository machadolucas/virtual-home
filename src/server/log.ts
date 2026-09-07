import pino, { type Logger } from "pino";
import { loadEnv } from "@/env";

const REDACT_PATHS = [
  "password",
  "newPassword",
  "currentPassword",
  "token",
  "access_token",
  "accessToken",
  "ha_token",
  "HA_TOKEN",
  "authorization",
  "cookie",
  "set-cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.access_token",
  "*.token",
  "*.password",
];

let root: Logger | null = null;

/**
 * Process-wide pino logger. JSON to a rolling file in production, pretty to stdout otherwise.
 * Never log secrets: the redaction list above is the last line of defence, not the first.
 */
export function getLogger(): Logger {
  if (root) return root;
  const env = loadEnv();
  const base = { role: env.role, pid: process.pid };
  if (env.NODE_ENV === "production") {
    root = pino(
      {
        level: env.LOG_LEVEL,
        base,
        redact: { paths: REDACT_PATHS, censor: "[redacted]" },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
      },
      pino.transport({
        target: "pino-roll",
        options: {
          file: `${env.logDir}/${env.role}.log`,
          frequency: "daily",
          size: "20m",
          limit: { count: 14 },
          mkdir: true,
        },
      }),
    );
  } else {
    root = pino({
      level: env.LOG_LEVEL,
      base,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      transport:
        env.NODE_ENV === "test"
          ? undefined
          : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } },
    });
  }
  return root;
}

export const log = new Proxy({} as Logger, {
  get(_t, prop) {
    const l = getLogger();
    const v = (l as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(l) : v;
  },
});
