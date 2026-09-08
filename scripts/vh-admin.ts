/**
 * `pnpm vh-admin <command>` — the server-side admin and recovery CLI.
 *
 * This is the only privileged tier in the whole system: there are no roles in the app, and the
 * ability to create a user or reset a password *is* shell access to the machine
 * (`docs/security.md`). Everything runs in-process against the SQLite file — no HTTP, no session,
 * and no network at all except `ha-token-check` and `doctor`'s HA probe.
 *
 * Two rules for anything added here:
 *  1. **Never print a secret.** Not `BETTER_AUTH_SECRET`, not `HA_TOKEN`, not a password, not a
 *     reset token. `ha-token-check` prints an HTTP status, never the token it used.
 *  2. **Never take a password as an argument.** argv is world-readable via `ps` and lands in shell
 *     history; passwords come from a hidden TTY prompt or `--password-from-stdin`.
 */
// MUST be first: `src/server/**` guards itself with `import "server-only"`, which throws outside
// Next's react-server condition. See the file for the flag-based alternative.
import "./lib/serverOnly";

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { openDatabase, setDbForTests, type DbHandle } from "@/db/client";
import { resolveMigrationsFolder } from "@/db/migrate";
import { EnvError, exitOnEnvError, loadEnv, type Env } from "@/env";
import { PromptError, readNewPassword } from "./lib/prompt";

const execFileAsync = promisify(execFile);

const MIN_PASSWORD_LENGTH = 12;
const LAUNCHD_JOBS = ["web", "worker", "backup"] as const;
const LAUNCHD_PREFIX = "net.machadolucas.virtual-home";

/** The two household members `init-users` provisions. Names, not private data. */
const HOUSEHOLD = [
  { username: "lucas", name: "Lucas" },
  { username: "marja", name: "Marja" },
] as const;

interface Options {
  passwordFromStdin: boolean;
}

const USAGE = `Usage: pnpm vh-admin <command> [args]

  init-users                        create the household accounts that are missing (interactive)
  create-user <username> <name>     create one account
  list-users                        accounts with session counts
  set-password <username>           reset a password and revoke that user's sessions
  revoke-sessions <username|--all>  delete session rows
  prune-sessions                    delete expired session rows
  ha-token-check                    GET \${HA_URL}/api/ with the configured token (status only)
  model-import <dir>                validate and install a house-model package
  doctor                            environment, permissions, integrity, migrations, HA, launchd, disk

Options:
  --password-from-stdin             read the password from stdin instead of prompting (no TTY needed)
`;

// ---------------------------------------------------------------------------
// small output helpers
// ---------------------------------------------------------------------------

type Verdict = "ok" | "warn" | "fail" | "info";

const MARK: Record<Verdict, string> = {
  ok: "  ok  ",
  warn: " warn ",
  fail: " FAIL ",
  info: "  --  ",
};

let worst: Verdict = "ok";

function report(verdict: Verdict, label: string, detail?: string): void {
  if (verdict === "fail") worst = "fail";
  else if (verdict === "warn" && worst !== "fail") worst = "warn";
  console.log(`[${MARK[verdict]}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/** ISO minute precision: enough to reason about, short enough to scan in a column. */
const stamp = (ms: number | null): string =>
  ms === null ? "never" : new Date(ms).toISOString().slice(0, 16).replace("T", " ");

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

/**
 * Open the configured database and make it the process-wide handle, so `buildAuthOptions()` (which
 * resolves `getDb()` eagerly) sees it. Callers close it in a `finally`.
 */
function openConfiguredDb(env: Env): DbHandle {
  if (!fs.existsSync(env.dbPath)) {
    throw new Error(`no database at ${env.dbPath} — run \`pnpm db:migrate\` first`);
  }
  const handle = openDatabase(env.dbPath);
  setDbForTests(handle);
  return handle;
}

async function provisioning() {
  // Dynamic so the `server-only` shim above is guaranteed to have run first.
  return import("@/server/auth/provisioning");
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdInitUsers(env: Env, options: Options): Promise<void> {
  const handle = openConfiguredDb(env);
  try {
    const p = await provisioning();
    const existing = new Set(p.listUsers().map((u) => u.username));
    const missing = HOUSEHOLD.filter((h) => !existing.has(h.username));
    if (missing.length === 0) {
      console.log("both household accounts already exist; nothing to do");
      return;
    }
    // stdin can only be drained once, so a piped password cannot serve two accounts.
    if (options.passwordFromStdin && missing.length > 1) {
      throw new PromptError(
        `--password-from-stdin cannot create ${missing.length} accounts in one run; ` +
          "use `create-user <username> <name> --password-from-stdin` once per account",
      );
    }
    for (const member of missing) {
      const password = await readNewPassword(`Password for ${member.username}`, {
        fromStdin: options.passwordFromStdin,
        minLength: MIN_PASSWORD_LENGTH,
      });
      const created = await p.createUser({ username: member.username, name: member.name, password });
      console.log(`created ${created.username} (${created.name}) <${created.email}>`);
    }
  } finally {
    handle.close();
  }
}

async function cmdCreateUser(env: Env, options: Options, username: string, name: string): Promise<void> {
  const handle = openConfiguredDb(env);
  try {
    const p = await provisioning();
    const password = await readNewPassword(`Password for ${username}`, {
      fromStdin: options.passwordFromStdin,
      minLength: MIN_PASSWORD_LENGTH,
    });
    const created = await p.createUser({ username, name, password });
    console.log(`created ${created.username} (${created.name}) <${created.email}>`);
  } finally {
    handle.close();
  }
}

async function cmdListUsers(env: Env): Promise<void> {
  const handle = openConfiguredDb(env);
  try {
    const p = await provisioning();
    const rows = p.listUsers();
    if (rows.length === 0) {
      console.log("no accounts yet — run `pnpm vh-admin init-users`");
      return;
    }
    console.log(
      ["username", "name", "email", "created", "sessions", "last seen"]
        .map((h, i) => h.padEnd([12, 16, 32, 17, 8, 17][i] ?? 12))
        .join(""),
    );
    for (const row of rows) {
      console.log(
        row.username.padEnd(12) +
          row.name.padEnd(16) +
          row.email.padEnd(32) +
          stamp(row.createdAtMs).padEnd(17) +
          String(row.activeSessions).padEnd(8) +
          stamp(row.lastSeenAtMs),
      );
    }
  } finally {
    handle.close();
  }
}

async function cmdSetPassword(env: Env, options: Options, username: string): Promise<void> {
  const handle = openConfiguredDb(env);
  try {
    const p = await provisioning();
    const password = await readNewPassword(`New password for ${username}`, {
      fromStdin: options.passwordFromStdin,
      minLength: MIN_PASSWORD_LENGTH,
    });
    const result = await p.setPassword(username, password);
    console.log(`password updated for ${result.username}; revoked ${result.revokedSessions} session(s)`);
    console.warn(
      "note: the 60 s session cookie cache can keep an already-issued cookie working on read " +
        "paths for up to a minute; security pages and destructive actions re-check immediately",
    );
  } finally {
    handle.close();
  }
}

async function cmdRevokeSessions(env: Env, target: string): Promise<void> {
  const handle = openConfiguredDb(env);
  try {
    const p = await provisioning();
    const all = target === "--all" || target === "*";
    const n = p.revokeSessions(all ? "*" : target);
    console.log(`revoked ${n} session(s)${all ? " (all users)" : ` for ${target}`}`);
  } finally {
    handle.close();
  }
}

async function cmdPruneSessions(env: Env): Promise<void> {
  const handle = openConfiguredDb(env);
  try {
    const p = await provisioning();
    console.log(`pruned ${p.pruneExpiredSessions()} expired session(s)`);
  } finally {
    handle.close();
  }
}

/** Prints the HTTP status and HA's own message. The token itself is never echoed. */
async function cmdHaTokenCheck(env: Env): Promise<void> {
  if (!env.HA_URL) {
    console.log("HA_URL is not configured; nothing to check");
    return;
  }
  if (!env.HA_TOKEN) {
    console.error("HA_TOKEN is not configured");
    process.exitCode = 1;
    return;
  }
  const url = new URL("/api/", env.HA_URL);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.HA_TOKEN}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.text()).slice(0, 200);
    let message = body;
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // HA returned something that is not JSON; the truncated body is the best detail we have.
    }
    console.log(`${url.origin}/api/ → HTTP ${res.status} ${message}`);
    if (!res.ok) process.exitCode = 1;
  } catch (err) {
    console.error(`${url.origin}/api/ → unreachable: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function cmdModelImport(env: Env, dir: string): Promise<void> {
  const handle = openConfiguredDb(env);
  try {
    const pkg = await import("@/server/house-model/package");
    const abs = path.resolve(dir);
    const result = await pkg.installPackage(abs);
    console.log(
      result.alreadyInstalled
        ? `already installed: ${result.modelId} @ ${result.fingerprint}`
        : `installed ${result.modelId} @ ${result.fingerprint} into ${result.dir}`,
    );
    const warnings = result.diagnostics.filter((d) => d.severity !== "error");
    for (const d of warnings) console.warn(`  warn: ${d.code} ${d.message}`);
    // Record the revision so colours/placements/routes can be stamped and reconciled.
    pkg.invalidatePackageCache();
    const current = await pkg.getCurrentPackage();
    if (current) {
      const { registerRevision } = await import("@/server/house-model/revision");
      const reg = registerRevision(handle, current, null);
      console.log(`revision ${reg.status}: ${reg.revisionId}${reg.itemCount ? ` (${reg.itemCount} items need reconciliation)` : ""}`);
    }
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function checkPerms(env: Env): void {
  const expect = (target: string, mode: number, label: string): void => {
    const st = fs.statSync(target, { throwIfNoEntry: false });
    if (!st) {
      report("warn", label, `${target} does not exist`);
      return;
    }
    const actual = st.mode & 0o777;
    if (actual === mode) report("ok", label, `${target} ${actual.toString(8)}`);
    else
      report(
        "fail",
        label,
        `${target} is ${actual.toString(8)}, expected ${mode.toString(8)} (chmod ${mode.toString(8)} it)`,
      );
  };
  expect(env.VH_DATA_DIR, 0o700, "data dir permissions");
  expect(env.secretsDir, 0o700, "secrets dir permissions");
  const secretsFile = path.join(env.secretsDir, "vh.env");
  if (fs.existsSync(secretsFile)) expect(secretsFile, 0o600, "secrets file permissions");
  else report("info", "secrets file permissions", `${secretsFile} not present (dev uses .env.local)`);
}

function checkDatabase(env: Env): void {
  if (!fs.existsSync(env.dbPath)) {
    report("fail", "database", `${env.dbPath} does not exist — run \`pnpm db:migrate\``);
    return;
  }
  const handle = openDatabase(env.dbPath);
  try {
    const integrity = handle.sqlite.pragma("integrity_check", { simple: true });
    if (integrity === "ok") report("ok", "PRAGMA integrity_check", "ok");
    else report("fail", "PRAGMA integrity_check", String(integrity));

    const fk = handle.sqlite.prepare("PRAGMA foreign_key_check").all();
    if (fk.length === 0) report("ok", "PRAGMA foreign_key_check", "no violations");
    else report("fail", "PRAGMA foreign_key_check", `${fk.length} violation(s)`);

    // Pending migrations: what the journal knows about vs what the database recorded.
    const journalPath = path.join(resolveMigrationsFolder(), "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries?: unknown[] };
    const onDisk = journal.entries?.length ?? 0;
    const table = handle.sqlite
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("__drizzle_migrations") as { n: number } | undefined;
    const recorded =
      table && table.n > 0
        ? ((handle.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n)
        : 0;
    const pending = onDisk - recorded;
    if (pending === 0) report("ok", "migrations", `${recorded} applied, none pending`);
    else if (pending > 0) report("fail", "migrations", `${pending} pending — run \`pnpm db:migrate\``);
    else
      report(
        "fail",
        "migrations",
        `the database records ${recorded} migrations but only ${onDisk} exist on disk (older code?)`,
      );

    const sessions = handle.sqlite.prepare("SELECT count(*) AS n FROM session").get() as { n: number };
    const users = handle.sqlite.prepare("SELECT count(*) AS n FROM user").get() as { n: number };
    report(
      users.n > 0 ? "ok" : "warn",
      "accounts",
      `${users.n} user(s), ${sessions.n} session row(s)${users.n === 0 ? " — run `pnpm vh-admin init-users`" : ""}`,
    );
  } finally {
    handle.close();
  }
}

function checkExposure(env: Env): void {
  if (env.cookieSecure) report("ok", "base URL", `${env.VH_BASE_URL} (cookies Secure)`);
  else
    report(
      "warn",
      "base URL",
      `${env.VH_BASE_URL} is not https, so session cookies are not Secure and passwords cross the network in cleartext`,
    );

  if (env.HOST === "127.0.0.1" || env.HOST === "localhost" || env.HOST === "::1") {
    report("ok", "bind address", `${env.HOST} (loopback; the reverse proxy owns the network)`);
  } else {
    report(
      "warn",
      "bind address",
      `HOST=${env.HOST} exposes the app directly, and \`x-forwarded-for\` is trusted for rate ` +
        "limiting — a client can then spoof its address and evade the sign-in limit",
    );
  }
}

async function checkLaunchd(): Promise<void> {
  if (process.platform !== "darwin") {
    report("info", "launchd", `not macOS (${process.platform}); supervision is out of scope here`);
    return;
  }
  const uid = process.getuid?.() ?? 0;
  for (const job of LAUNCHD_JOBS) {
    const label = `gui/${uid}/${LAUNCHD_PREFIX}.${job}`;
    try {
      const { stdout } = await execFileAsync("launchctl", ["print", label], { timeout: 10_000 });
      const state = /^\s*state = (.+)$/m.exec(stdout)?.[1]?.trim() ?? "unknown";
      const exit = /^\s*last exit code = (.+)$/m.exec(stdout)?.[1]?.trim();
      const detail = `state = ${state}${exit ? `, last exit code = ${exit}` : ""}`;
      report(state === "running" || state === "waiting" ? "ok" : "warn", `launchd ${job}`, detail);
    } catch {
      report("info", `launchd ${job}`, "not loaded");
    }
  }
}

async function checkDisk(env: Env): Promise<void> {
  try {
    const { stdout } = await execFileAsync("df", ["-k", env.VH_DATA_DIR], { timeout: 10_000 });
    const line = stdout.trim().split("\n").at(-1) ?? "";
    const parts = line.split(/\s+/);
    const availableKb = Number(parts[3]);
    if (!Number.isFinite(availableKb)) {
      report("warn", "disk free", `could not parse \`df\` output: ${line}`);
      return;
    }
    const gib = availableKb / 1024 / 1024;
    report(gib >= 5 ? "ok" : "warn", "disk free", `${gib.toFixed(1)} GiB available on ${env.VH_DATA_DIR}`);
  } catch (err) {
    report("warn", "disk free", err instanceof Error ? err.message : String(err));
  }
}

async function checkHa(env: Env): Promise<void> {
  if (!env.HA_URL) {
    report("info", "Home Assistant", "HA_URL not configured");
    return;
  }
  if (!env.HA_TOKEN) {
    report("warn", "Home Assistant", "HA_URL is set but HA_TOKEN is empty; the worker will not connect");
    return;
  }
  const url = new URL("/api/", env.HA_URL);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.HA_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    report(res.ok ? "ok" : "fail", "Home Assistant", `${url.origin}/api/ → HTTP ${res.status}`);
  } catch (err) {
    report("fail", "Home Assistant", `${url.origin} unreachable: ${err instanceof Error ? err.message : err}`);
  }
}

async function cmdDoctor(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv("cli");
    report("ok", "configuration", `validated (role=cli, tz=${env.VH_HOUSEHOLD_TZ})`);
  } catch (err) {
    if (err instanceof EnvError) {
      report("fail", "configuration", `invalid: ${Object.keys(err.fieldErrors).join(", ")}`);
      console.log("\ndoctor: FAIL (fix the configuration before anything else)");
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  checkPerms(env);
  checkExposure(env);
  checkDatabase(env);
  await checkHa(env);
  await checkLaunchd();
  await checkDisk(env);
  console.log(`\ndoctor: ${worst === "ok" ? "all good" : worst.toUpperCase()}`);
  if (worst === "fail") process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { command: string | undefined; args: string[]; options: Options } {
  const args: string[] = [];
  const options: Options = { passwordFromStdin: false };
  for (const arg of argv) {
    if (arg === "--password-from-stdin") options.passwordFromStdin = true;
    else args.push(arg);
  }
  return { command: args.shift(), args, options };
}

function need(args: string[], count: number, usage: string): void {
  if (args.length < count) {
    console.error(`usage: pnpm vh-admin ${usage}`);
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const { command, args, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === "doctor") {
    await cmdDoctor();
    return;
  }

  let env: Env;
  try {
    env = loadEnv("cli");
  } catch (err) {
    exitOnEnvError(err);
  }

  switch (command) {
    case "init-users":
      await cmdInitUsers(env, options);
      return;
    case "create-user":
      need(args, 2, "create-user <username> <name>");
      await cmdCreateUser(env, options, args[0]!, args.slice(1).join(" "));
      return;
    case "list-users":
      await cmdListUsers(env);
      return;
    case "set-password":
      need(args, 1, "set-password <username>");
      await cmdSetPassword(env, options, args[0]!);
      return;
    case "revoke-sessions":
      need(args, 1, "revoke-sessions <username|--all>");
      await cmdRevokeSessions(env, args[0]!);
      return;
    case "prune-sessions":
      await cmdPruneSessions(env);
      return;
    case "ha-token-check":
      await cmdHaTokenCheck(env);
      return;
    case "model-import":
      need(args, 1, "model-import <dir>");
      await cmdModelImport(env, args[0]!);
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  if (err instanceof PromptError) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
});
