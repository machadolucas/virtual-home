/**
 * Runtime configuration for every process (web, worker, cli).
 *
 * Rules:
 *  - Validate once at startup; exit 78 (EX_CONFIG) on invalid config so launchd does not thrash-restart.
 *  - Never print values (HA_TOKEN may be among them), only field names.
 *  - Derived paths live here so nobody hard-codes a data-dir layout elsewhere.
 */
import path from "node:path";
import { z } from "zod";

export type ProcessRole = "web" | "worker" | "cli" | "test";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  VH_DATA_DIR: z
    .string()
    .min(1)
    .refine((p) => path.isAbsolute(p), "VH_DATA_DIR must be an absolute path"),
  VH_BASE_URL: z.string().url(),
  VH_TRUSTED_ORIGINS: z.string().optional(),
  VH_HOUSEHOLD_TZ: z
    .string()
    .default("Europe/Helsinki")
    .refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz), "unknown IANA time zone"),
  VH_DELIVERY_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM")
    .default("09:00"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  HA_URL: z.string().url().optional(),
  HA_TOKEN: z.string().min(20).optional(),
  HA_WS_URL: z.string().url().optional(),
  VH_EVENT_POLL_MS: z.coerce.number().int().min(200).max(10_000).default(1000),
  VH_SSE_MAX_CLIENTS: z.coerce.number().int().min(1).max(64).default(8),
  VH_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(5_000).default(15_000),
  VH_METRICS_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  VH_UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(26_214_400),
  VH_BACKUP_RETAIN_DAILY: z.coerce.number().int().min(1).default(14),
  VH_BACKUP_RETAIN_WEEKLY: z.coerce.number().int().min(1).default(8),
  VH_SHOW_ACCOUNT_HINTS: bool.default("true"),
  VH_HA_HISTORY_ENABLED: bool.default("true"),
  /** Enables window.__vh test hooks in the browser bundle (build-time). */
  NEXT_PUBLIC_VH_TEST_HOOK: z.string().optional(),
});

export type RawEnv = z.infer<typeof schema>;

export interface Env extends RawEnv {
  role: ProcessRole;
  /** ws(s)://host/api/websocket derived from HA_URL unless HA_WS_URL is given. */
  haWsUrl: string | null;
  /** Secure cookies iff the public base URL is https. */
  cookieSecure: boolean;
  trustedOrigins: string[];
  dbPath: string;
  modelDir: string;
  modelIncomingDir: string;
  attachDir: string;
  tmpDir: string;
  backupDir: string;
  exportDir: string;
  secretsDir: string;
  logDir: string;
}

export class EnvError extends Error {
  constructor(public readonly fieldErrors: Record<string, string[] | undefined>) {
    super("invalid configuration: " + Object.keys(fieldErrors).join(", "));
    this.name = "EnvError";
  }
}

/**
 * Parse an environment object into a validated Env. Throws EnvError; callers that own a process
 * (web instrumentation, worker main, cli) convert that into exit code 78.
 */
export function parseEnv(source: NodeJS.ProcessEnv, role: ProcessRole): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>);
  }
  const e = parsed.data;
  if (role === "worker" && !e.HA_URL) {
    // The worker can run without HA (scheduling still works) but must say so loudly.
    // Missing HA_URL is allowed; missing HA_TOKEN with HA_URL set is a configuration error.
  }
  if (e.HA_URL && role === "worker" && !e.HA_TOKEN) {
    throw new EnvError({ HA_TOKEN: ["HA_TOKEN is required for the worker when HA_URL is set"] });
  }
  let haWsUrl: string | null = null;
  if (e.HA_WS_URL) haWsUrl = e.HA_WS_URL;
  else if (e.HA_URL) {
    const u = new URL(e.HA_URL);
    haWsUrl = `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/api/websocket`;
  }
  const base = new URL(e.VH_BASE_URL);
  const d = e.VH_DATA_DIR;
  return {
    ...e,
    role,
    haWsUrl,
    cookieSecure: base.protocol === "https:",
    trustedOrigins: (e.VH_TRUSTED_ORIGINS ?? e.VH_BASE_URL)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dbPath: path.join(d, "db", "app.db"),
    modelDir: path.join(d, "model"),
    modelIncomingDir: path.join(d, "model-incoming"),
    attachDir: path.join(d, "attachments"),
    tmpDir: path.join(d, "tmp"),
    backupDir: path.join(d, "backups"),
    exportDir: path.join(d, "exports"),
    secretsDir: path.join(d, "secrets"),
    logDir: path.join(d, "logs"),
  };
}

let cached: Env | null = null;

/** Process-wide singleton. The role is fixed by the first caller (web instrumentation, worker, cli). */
export function loadEnv(role?: ProcessRole): Env {
  if (cached) return cached;
  cached = parseEnv(process.env, role ?? (process.env.VH_ROLE as ProcessRole | undefined) ?? "web");
  return cached;
}

/** For tests: replace the singleton. */
export function setEnvForTests(env: Env): void {
  cached = env;
}

/** Print field errors (never values) and exit with EX_CONFIG. */
export function exitOnEnvError(err: unknown): never {
  if (err instanceof EnvError) {
    console.error("[env] invalid configuration:", JSON.stringify(err.fieldErrors, null, 2));
  } else {
    console.error("[env] failed to load configuration:", err instanceof Error ? err.message : err);
  }
  process.exit(78);
}
