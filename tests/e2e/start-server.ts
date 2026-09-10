/**
 * Playwright's `webServer`: a production build of the app on a throwaway data directory.
 *
 * Everything the browser talks to here is real — a `next start` server, the real migrations, the
 * real provisioning path, the real file store. Only the *data* is synthetic: `VH_DATA_DIR` is a
 * fresh temp directory that is deleted again when this process exits, so an e2e run can never see
 * or damage the household's own database, photos or model package (CLAUDE.md rule 1).
 *
 * Sequence: temp data dir → migrations → seed the two accounts through `provisioning` → install
 * the synthetic fixture model if it has been generated, register its revision and seed one
 * unplaced piece of equipment → `next build` → `next start`.
 *
 * Environment:
 *  - `VH_E2E_PORT` (default 3011) — must match `playwright.config.ts`.
 *  - `VH_E2E_SKIP_BUILD=1` — reuse an existing `.next` build instead of rebuilding. Only safe when
 *    that build is current *and* was produced with `NEXT_PUBLIC_VH_TEST_HOOK=1`, since public env
 *    vars are inlined at build time.
 *  - `VH_E2E_KEEP_DATA_DIR=1` — leave the temp data directory behind for inspection.
 *
 * Home Assistant is deliberately not configured: `HA_URL`/`HA_TOKEN` are blanked so a developer's
 * `.env.local` cannot make the e2e server talk to a real house. (Next only fills env vars that are
 * *absent* from the process environment, and an empty string counts as present.) The worker is not
 * started at all, so nothing in an e2e run has an HA connection to lose.
 */
// MUST be first: `src/server/**` guards itself with `import "server-only"`, which throws outside
// Next's react-server condition. See scripts/lib/serverOnly.ts.
import "../../scripts/lib/serverOnly";

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2E_PLACEABLE_NAMES, E2E_USERS } from "./fixtures";
import type { DbHandle } from "@/db/client";

const PORT = Number(process.env["VH_E2E_PORT"] ?? 3011);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURE_MODEL_DIR = path.join(REPO_ROOT, "tests/fixtures/model/house-model");
const DATA_DIR_MODE = 0o700;
const DATA_DIR_PREFIX = "vh-e2e-";
/** Written into each data dir so a later run can tell an abandoned one from a live one. */
const PID_FILE = ".bootstrap-pid";

/** Subdirectories `src/env.ts` derives and the app expects to exist. */
const DATA_SUBDIRS = [
  "db",
  "model",
  "model-incoming",
  "attachments",
  "tmp",
  "backups/daily",
  "backups/weekly",
  "exports",
  "secrets",
  "logs",
];

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

function makeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), DATA_DIR_PREFIX));
  fs.chmodSync(dir, DATA_DIR_MODE);
  for (const sub of DATA_SUBDIRS) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: DATA_DIR_MODE });
  }
  fs.writeFileSync(path.join(dir, PID_FILE), String(process.pid));
  return dir;
}

/**
 * Delete data directories whose owning bootstrap is no longer alive.
 *
 * The signal handlers below clean up after an ordinary shutdown, but Playwright tears its
 * `webServer` down by killing the process tree, and a SIGKILL runs no handler — so without this,
 * every e2e run would leave a copy of the seeded database in the temp directory. Liveness is read
 * from the pid file rather than from a timestamp, so a concurrent run is never touched.
 */
function sweepAbandonedDataDirs(): void {
  const root = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(DATA_DIR_PREFIX)) continue;
    const dir = path.join(root, entry);
    try {
      const pid = Number(fs.readFileSync(path.join(dir, PID_FILE), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0); // throws ESRCH when the owner is gone
        continue; // still running: leave it alone
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") continue; // alive, someone else's
    }
    fs.rmSync(dir, { recursive: true, force: true });
    log(`swept abandoned data dir ${dir}`);
  }
}

/**
 * The environment both `next build` and `next start` run with. Explicit rather than inherited:
 * an e2e run must not depend on what happens to be in the developer's `.env.local`.
 */
function serverEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VH_DATA_DIR: dataDir,
    VH_BASE_URL: BASE_URL,
    VH_TRUSTED_ORIGINS: BASE_URL,
    VH_HOUSEHOLD_TZ: "Europe/Helsinki",
    VH_DELIVERY_TIME: "09:00",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    LOG_LEVEL: "warn",
    BETTER_AUTH_SECRET: randomBytes(48).toString("base64"),
    // No Home Assistant in e2e: the worker is not started and nothing may reach a real instance.
    // An empty value is what blocks it — `src/env.ts` reads an empty `HA_URL`/`HA_TOKEN` as absent,
    // and Next only fills env vars that are *missing*, so `.env.local` cannot put a real house back.
    HA_URL: "",
    HA_TOKEN: "",
    // Inlined into the client bundle at build time; the viewer's `window.__vh` hooks need it.
    NEXT_PUBLIC_VH_TEST_HOOK: "1",
    VH_SHOW_ACCOUNT_HINTS: "true",
  };
  // `HA_WS_URL` is the exception: `src/env.ts` validates it as a URL whenever it is set *at all*,
  // so an empty string is a configuration error rather than a blank. It has to be genuinely
  // absent. Nothing derives from it unless `HA_URL` is set, and only the worker dials it.
  delete env["HA_WS_URL"];
  return env;
}

async function seed(env: NodeJS.ProcessEnv): Promise<void> {
  // Publish the environment before anything reads it: `loadEnv()` is a process-wide singleton and
  // `buildAuthOptions()` resolves the database handle eagerly.
  Object.assign(process.env, env);
  process.env["VH_ROLE"] = "cli";
  delete process.env["HA_WS_URL"];

  const { loadEnv } = await import("@/env");
  const { openDatabase, setDbForTests } = await import("@/db/client");
  const { runMigrations } = await import("@/db/migrate");
  const cfg = loadEnv("cli");

  const handle = openDatabase(cfg.dbPath);
  try {
    setDbForTests(handle);
    const { applied } = runMigrations(handle);
    log(`migrations applied: ${applied}`);

    const provisioning = await import("@/server/auth/provisioning");
    for (const user of Object.values(E2E_USERS)) {
      await provisioning.createUser({
        username: user.username,
        name: user.name,
        password: user.password,
        displayColor: user.displayColor,
      });
      log(`seeded ${user.username}`);
    }

    await installFixtureModel(handle);
    await seedHaImportDevices(handle);
  } finally {
    setDbForTests(null);
    handle.close();
  }
}

/**
 * The fixture package is generated by `pnpm fixture:model` and may legitimately be absent; the
 * auth suite does not need it, so a missing fixture is a note rather than a failure.
 */
async function installFixtureModel(handle: DbHandle): Promise<void> {
  if (!fs.existsSync(path.join(FIXTURE_MODEL_DIR, "model.json"))) {
    log(`no fixture model at ${FIXTURE_MODEL_DIR} — skipping the model install`);
    return;
  }
  try {
    const pkg = await import("@/server/house-model/package");
    const result = await pkg.installPackage(FIXTURE_MODEL_DIR);
    log(`installed fixture model ${result.modelId} @ ${result.fingerprint}`);

    // Register the revision, exactly as `vh-admin model-import` does. Without it there is no
    // `model_revision` row, so `listPlacements()` answers `NotPersistedError` and nothing in the
    // workspace can be placed or saved — which is why the placement e2e test used to be skipped.
    pkg.invalidatePackageCache();
    const current = await pkg.getCurrentPackage();
    if (!current) return;
    const { registerRevision } = await import("@/server/house-model/revision");
    const registered = registerRevision(handle, current, null);
    log(`registered revision ${registered.status}: ${registered.revisionId}`);

    await seedPlaceableEquipment(handle);
  } catch (err) {
    // A half-generated fixture must not take the whole auth suite down with it.
    log(`fixture model install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * One piece of equipment with no placement, so the workspace has something to place.
 *
 * Deliberately an *outdoor* fixture: the flow it exercises — place something that resolves to no
 * room — is the one that used to be impossible, and a yard lamp is the honest example of it.
 */
async function seedPlaceableEquipment(handle: DbHandle): Promise<void> {
  const { asset } = await import("@/db/schema");
  const { newId, nowMs } = await import("@/db/ids");
  const { writeTx } = await import("@/db/client");
  const at = nowMs();
  for (const name of E2E_PLACEABLE_NAMES) {
  writeTx(handle.db, (tx) => {
    tx.insert(asset)
      .values({
        id: newId(),
        name,
        category: "outdoor",
        manufacturer: null,
        modelName: null,
        serialNumber: null,
        productCode: null,
        locationId: null,
        parentAssetId: null,
        isVirtual: false,
        status: "installed",
        installedOn: null,
        installedOnPrecision: "unknown",
        currency: "EUR",
        notes: null,
        createdAtMs: at,
        createdBy: null,
        updatedAtMs: at,
        updatedBy: null,
      })
      .run();
  });
  }
  log(`seeded placeable equipment: ${E2E_PLACEABLE_NAMES.join(", ")}`);
}

/** Synthetic registry rows only; no worker or real HA connection is used. */
async function seedHaImportDevices(handle: DbHandle): Promise<void> {
  const { haDevice, haEntity, haEntityState } = await import("@/db/schema");
  const { writeTx } = await import("@/db/client");
  const at = Date.now();
  writeTx(handle.db, (tx) => {
    for (const viewport of ["desktop", "phone"]) {
      const deviceId = `e2e-${viewport}-motion`;
      tx.insert(haDevice).values({ deviceId, name: `E2E ${viewport} motion`, manufacturer: "Synthetic", model: "Test sensor", firstSeenMs: at, lastSeenMs: at }).run();
      for (const kind of ["occupancy", "temperature", "humidity", "illuminance", "battery", "signal"]) {
        const entityId = `${kind === "occupancy" ? "binary_sensor" : "sensor"}.e2e_${viewport}_${kind}`;
        tx.insert(haEntity).values({ registryId: `${deviceId}-${kind}`, deviceId,
          entityId,
          domain: kind === "occupancy" ? "binary_sensor" : "sensor", deviceClass: kind,
          entityCategory: kind === "battery" || kind === "signal" ? "diagnostic" : null,
          disabledBy: kind === "signal" ? "user" : null,
          unitOfMeasurement: ({ temperature: "°C", humidity: "%", illuminance: "lx", battery: "%" } as Record<string, string>)[kind] ?? null,
          liveState: kind === "occupancy" ? "off" : kind === "humidity" ? "unavailable" : "23", liveRestored: false, liveAtMs: at,
          firstSeenMs: at, lastSeenMs: at }).run();
        if (kind === "illuminance") {
          tx.insert(haEntityState).values({
            entityId,
            registryId: `${deviceId}-${kind}`,
            state: "100",
            attributesJson: JSON.stringify({ device_class: "illuminance", unit_of_measurement: "lx" }),
            lastChangedMs: at,
            lastUpdatedMs: at,
            observedAtMs: at,
          }).run();
        }
      }
      const weatherDeviceId = `e2e-${viewport}-weather`;
      const weatherEntityId = `weather.e2e_${viewport}_home`;
      tx.insert(haDevice).values({ deviceId: weatherDeviceId, name: `E2E ${viewport} weather`, manufacturer: "Synthetic", model: "Test forecast", firstSeenMs: at, lastSeenMs: at }).run();
      tx.insert(haEntity).values({ registryId: `${weatherDeviceId}-entity`, deviceId: weatherDeviceId,
        entityId: weatherEntityId, domain: "weather", liveState: "cloudy", liveRestored: false,
        liveAtMs: at, firstSeenMs: at, lastSeenMs: at }).run();
      tx.insert(haEntityState).values({ entityId: weatherEntityId, registryId: `${weatherDeviceId}-entity`,
        state: "cloudy", attributesJson: JSON.stringify({ friendly_name: `E2E ${viewport} weather` }),
        lastChangedMs: at, lastUpdatedMs: at, observedAtMs: at }).run();
    }
  });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

async function build(env: NodeJS.ProcessEnv): Promise<void> {
  const built = fs.existsSync(path.join(REPO_ROOT, ".next", "BUILD_ID"));
  if (process.env["VH_E2E_SKIP_BUILD"] === "1" && built) {
    log("VH_E2E_SKIP_BUILD=1 and .next exists — reusing the existing build");
    return;
  }
  log("next build …");
  await run("pnpm", ["exec", "next", "build"], env);
}

let server: ChildProcess | null = null;
let dataDir: string | null = null;
let cleaned = false;

function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (dataDir && process.env["VH_E2E_KEEP_DATA_DIR"] === "1") {
    log(`keeping data dir ${dataDir}`);
    return;
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  // The production launchd service reads .next from its checkout. Even with synthetic data,
  // rebuilding there would replace its live assets with an e2e build. Fail before any bootstrap.
  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library/LaunchAgents/net.machadolucas.virtual-home.web.plist");
    if (fs.existsSync(plist)) {
      const installedRoot = execFileSync("/usr/bin/plutil", ["-extract", "WorkingDirectory", "raw", "-o", "-", plist], { encoding: "utf8" }).trim();
      if (fs.realpathSync(installedRoot) === fs.realpathSync(REPO_ROOT)) {
        throw new Error("This checkout serves production. Run Playwright from an isolated checkout; rebuilding .next here would replace live production assets.");
      }
    }
  }
  sweepAbandonedDataDirs();
  dataDir = makeDataDir();
  log(`data dir ${dataDir}`);
  const env = serverEnv(dataDir);

  await seed(env);
  await build(env);

  log(`next start on ${BASE_URL}`);
  server = spawn("pnpm", ["exec", "next", "start", "-H", "127.0.0.1", "-p", String(PORT)], {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });

  server.on("exit", (code, signal) => {
    log(`server exited (${signal ?? code})`);
    cleanup();
    process.exit(typeof code === "number" ? code : 1);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}
process.on("exit", cleanup);

main().catch((err: unknown) => {
  console.error("[e2e] bootstrap failed:", err instanceof Error ? err.stack : err);
  cleanup();
  process.exit(1);
});
