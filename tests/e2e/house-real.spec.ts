/**
 * The 3D workspace against the household's **real** model package.
 *
 * The real package is private and must never enter this repository (CLAUDE.md rule 1), so this file
 * runs only when `VH_REAL_MODEL_DIR` points at a copy on the developer's machine — for example
 * `VH_REAL_MODEL_DIR=$HOME/virtual-home-data/model-incoming/house-model pnpm exec playwright test
 * tests/e2e/house-real.spec.ts --project=desktop`. Without it every test here skips, which is what
 * lets `house.spec.ts` be the CI gate and this file be the acceptance run.
 *
 * ## How the real package gets in front of the running server
 *
 * `tests/e2e/start-server.ts` owns the throwaway `VH_DATA_DIR` and does not publish its path, so
 * this file finds it the same way the bootstrap's own sweeper does: a temp directory named
 * `vh-e2e-*` whose `.bootstrap-pid` names a live process. It then sets `VH_DATA_DIR` to that
 * directory and calls the app's own `installPackage()` — the real import path, validation and all —
 * so the running `next start` sees the new `current.json` on its next 10 s re-check
 * (`getCurrentPackage`). `afterAll` re-installs the fixture, so a later run of `house.spec.ts` or
 * `screenshots.spec.ts` against the same reused server is unaffected and no capture of the real
 * house is left behind by accident.
 *
 * Nothing is copied into the repository: the package is read from `VH_REAL_MODEL_DIR` and installed
 * into the temp data dir, which the bootstrap deletes when it exits.
 *
 * Measured numbers land in `test-results/house-measurements.json` (git-ignored) and are printed, so
 * the rows in `docs/verification.md` are transcribed from a real run rather than estimated.
 */
// MUST be first: `src/server/**` guards itself with `import "server-only"`. See scripts/lib/serverOnly.ts.
import "../../scripts/lib/serverOnly";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  fetchManifest,
  idleFrames,
  measureLoad,
  openHouseSession,
  orbitScripted,
  setSurfaceColour,
  vh,
  waitForStableFrames,
  type ManifestShape,
} from "./helpers/house";

const REAL_MODEL_DIR = process.env["VH_REAL_MODEL_DIR"];
const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURE_MODEL_DIR = path.join(REPO_ROOT, "tests/fixtures/model/house-model");
const PID_FILE = ".bootstrap-pid";
const DATA_DIR_PREFIX = "vh-e2e-";
const MEASUREMENTS_FILE = path.join(REPO_ROOT, "test-results/house-measurements.json");

/** The ids §13 calibrates against. All read out of the shipped package. */
const LIVING = { id: "r-g-living", name: "Living room", floor: "s-r-g-living-floor", datum: -0.3 } as const;
const SAUNA_WALL = {
  sauna: "s-w-g-sauna-e--r-g-sauna",
  shower: "s-w-g-sauna-e--r-g-shower",
  fireplace: "s-w-g-sauna-e--r-g-fireplace",
} as const;
/** `edges-<assetId>` is one object per asset, so a cross-floor asset hides its edges when exploded. */
const STRUCTURE = { asset: "house-structure", edges: "edges-house-structure" } as const;

const measurements: Record<string, unknown> = {
  machine: `${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model ?? "unknown cpu"}`,
  browser: "headless Chromium via Playwright",
  recordedAt: new Date().toISOString(),
};

let installedModelId: string | null = null;


test.skip(
  !REAL_MODEL_DIR,
  "VH_REAL_MODEL_DIR is not set — the real package is private and is never in this repository",
);

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "the acceptance numbers are for the desktop project");
});

// ---------------------------------------------------------------------------
// installing the real package into the harness's data directory
// ---------------------------------------------------------------------------

/**
 * The bootstrap's live temp data directory.
 *
 * Liveness is read from the pid file, exactly as `sweepAbandonedDataDirs()` does, so a concurrent
 * run's directory is never touched; the newest live one is the server Playwright just started.
 */
function findHarnessDataDir(): string {
  const root = os.tmpdir();
  const live: Array<{ dir: string; mtimeMs: number }> = [];
  for (const entry of fs.readdirSync(root)) {
    if (!entry.startsWith(DATA_DIR_PREFIX)) continue;
    const dir = path.join(root, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      const pid = Number(fs.readFileSync(path.join(dir, PID_FILE), "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      process.kill(pid, 0); // throws ESRCH when the owner is gone
    } catch (err) {
      // EPERM means the process is alive but owned by someone else — still a live data dir.
      if ((err as NodeJS.ErrnoException).code !== "EPERM") continue;
      stat = fs.statSync(dir);
    }
    live.push({ dir, mtimeMs: stat.mtimeMs });
  }
  if (live.length === 0)
    throw new Error(
      `no live e2e data directory under ${root} (looked for ${DATA_DIR_PREFIX}*/${PID_FILE}); is tests/e2e/start-server.ts running?`,
    );
  live.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return live[0]!.dir;
}

/** Point the app's env at the harness data dir, then install `dir` through the real import path. */
async function installInto(dataDir: string, dir: string): Promise<{ modelId: string; fingerprint: string }> {
  process.env["VH_DATA_DIR"] = dataDir;
  process.env["VH_ROLE"] = "cli";
  process.env["VH_BASE_URL"] ??= `http://127.0.0.1:${process.env["VH_E2E_PORT"] ?? 3011}`;
  process.env["BETTER_AUTH_SECRET"] ??= "e2e-real-model-spec-secret-that-is-long-enough";
  process.env["HA_URL"] = "";
  process.env["HA_TOKEN"] = "";
  delete process.env["HA_WS_URL"];

  const pkg = await import("@/server/house-model/package");
  const result = await pkg.installPackage(dir);
  return { modelId: result.modelId, fingerprint: result.fingerprint };
}

/**
 * Wait until the running server serves `modelId`.
 *
 * `getCurrentPackage()` caches the pointer with a `stat`-only re-check at most every 10 s, so a
 * freshly installed package becomes visible within that window rather than instantly.
 */
async function waitForServedModel(request: import("@playwright/test").APIRequestContext, modelId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/house-model/${encodeURIComponent(modelId)}/status`);
        if (!res.ok()) return `http ${res.status()}`;
        const body = (await res.json()) as { installed: boolean; modelId: string | null };
        return body.installed ? body.modelId : "not installed";
      },
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(modelId);
}

test.beforeAll(async ({ playwright }) => {
  if (!REAL_MODEL_DIR) return;
  if (!fs.existsSync(path.join(REAL_MODEL_DIR, "model.json")))
    throw new Error(`VH_REAL_MODEL_DIR has no model.json: ${REAL_MODEL_DIR}`);

  const dataDir = findHarnessDataDir();
  const installed = await installInto(dataDir, REAL_MODEL_DIR);
  installedModelId = installed.modelId;
  measurements["modelId"] = installed.modelId;
  measurements["fingerprint"] = installed.fingerprint;
  console.log(`[house-real] installed ${installed.modelId} @ ${installed.fingerprint} into ${dataDir}`);

  // The signed-in workspace is what the tests use; this bare context only waits for the server to
  // notice the new pointer.
  const request = await playwright.request.newContext({
    baseURL: `http://127.0.0.1:${process.env["VH_E2E_PORT"] ?? 3011}`,
  });
  try {
    // `/status` needs a session, so the poll accepts a 401 as "not yet" — the installed-ness we
    // actually care about is confirmed by the first test's `status()` through the hook.
    const res = await request.get(`/api/house-model/${encodeURIComponent(installed.modelId)}/status`);
    if (res.status() !== 401) await waitForServedModel(request, installed.modelId);
    else await new Promise((resolve) => setTimeout(resolve, 11_000));
  } finally {
    await request.dispose();
  }
});

test.afterAll(async () => {
  if (!REAL_MODEL_DIR || !installedModelId) return;
  // Put the fixture back so a later spec (or a reused server) is not looking at the real house.
  try {
    const pkg = await import("@/server/house-model/package");
    const back = await pkg.installPackage(FIXTURE_MODEL_DIR);
    console.log(`[house-real] restored the fixture package (${back.modelId} @ ${back.fingerprint})`);
  } catch (err) {
    console.warn(`[house-real] could not restore the fixture package: ${String(err)}`);
  }

  fs.mkdirSync(path.dirname(MEASUREMENTS_FILE), { recursive: true });
  fs.writeFileSync(MEASUREMENTS_FILE, JSON.stringify(measurements, null, 2) + "\n", "utf8");
  console.log(`[house-real] measurements → ${MEASUREMENTS_FILE}`);
  console.log(JSON.stringify(measurements, null, 2));
});

// ---------------------------------------------------------------------------
// load, integrity, timing
// ---------------------------------------------------------------------------

test("the real package loads and the timings are recorded", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const timing = await measureLoad(page, 60_000);
    const status = await vh(page).status();

    expect(status.modelId).toBe(installedModelId);
    expect(status.phase).toBe("ready");
    expect(status.failedAssetIds).toEqual([]);
    expect(status.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    await waitForStableFrames(page);
    const render = await vh(page).renderInfo();
    const audit = await vh(page).materialAudit();
    for (const row of audit) expect(row, row.assetId).toMatchObject({ cloned: 0 });

    measurements["load"] = {
      hookMs: timing.hookMs,
      interactiveMs: timing.interactiveMs,
      readyMs: timing.readyMs,
      phases: timing.phases,
    };
    measurements["renderInfoDefault"] = render;
    measurements["loadedAssetIds"] = status.loadedAssetIds;
    measurements["materialAudit"] = audit;

    console.log(
      `[house-real] interactive ${fmt(timing.interactiveMs)} ms, ready ${fmt(timing.readyMs)} ms; geometries ${render.geometries}, textures ${render.textures}, programs ${render.programs}, triangles ${render.triangles}, calls ${render.calls}`,
    );
    await testInfo.attach("real-load.json", {
      body: JSON.stringify({ timing, render, audit }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await context.close();
  }
});

test("every mesh-backed surface of the nine default assets carries its defaultColor", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  try {
    // The structure assets sit behind their layer (1.5 MB of trusses and footings, off by default),
    // so the layer has to be on before the full 403-surface set is in the scene.
    await page.getByRole("checkbox", { name: "Structure (trusses, footings)" }).check();
    await expect
      .poll(() => vh(page).status().then((s) => s.loadedAssetIds.length), { timeout: 60_000 })
      .toBe(9);
    await waitForStableFrames(page);

    const status = await vh(page).status();
    const manifest: ManifestShape = await fetchManifest(page, status.modelId!, status.fingerprint!);
    const hexes = await vh(page).allMaterialHex();

    const loaded = new Set(status.loadedAssetIds);
    const expected = new Map<string, string>();
    for (const surface of manifest.surfaces) {
      if (!surface.nodeRefs.some((ref) => loaded.has(ref.assetId))) continue;
      expected.set(surface.id, surface.defaultColor.toLowerCase());
    }

    for (const [surfaceId, hex] of Object.entries(hexes)) {
      expect(expected.get(surfaceId), surfaceId).toBe(hex);
    }
    const missing = [...expected.keys()].filter((id) => !(id in hexes));

    measurements["colours"] = {
      surfacesInDefaultAssets: expected.size,
      surfacesWithMaterial: Object.keys(hexes).length,
      meshlessSurfaces: missing,
    };
    console.log(
      `[house-real] ${Object.keys(hexes).length} of ${expected.size} surfaces carry a material; mesh-less: ${missing.join(", ") || "none"}`,
    );
    // Only the known degenerate bands may lack a mesh; anything else is a package change.
    expect(missing.length).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// picking, colour, visibility on the real geometry
// ---------------------------------------------------------------------------

test("the living room picks at its own floor datum", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser);
  try {
    // Dollhouse first: the preset clears the active floor, so isolating afterwards is what sticks.
    await page.getByRole("button", { name: "Dollhouse (D)" }).click();
    await page.getByRole("button", { name: "Ground floor", exact: true }).click();
    await waitForStableFrames(page);

    const anchor = await vh(page).roomAnchor(LIVING.id);
    expect(anchor).not.toBeNull();
    const screen = await vh(page).screenOf(anchor!);
    expect(screen).not.toBeNull();

    const hit = await vh(page).pick(screen![0], screen![1]);
    expect(hit).not.toBeNull();
    expect(hit!.roomId).toBe(LIVING.id);
    expect(hit!.surfaceId).toBe(LIVING.floor);
    // The living room sits 0.30 m below the ground-floor datum; the pick must land on *its* floor.
    expect(hit!.point[1]).toBeCloseTo(LIVING.datum, 2);

    measurements["livingRoomPick"] = { surfaceId: hit!.surfaceId, y: hit!.point[1] };
  } finally {
    await context.close();
  }
});

test("the three faces of the sauna's east wall colour independently", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser, { sel: "room:r-g-sauna" });
  try {
    const before = await vh(page).allMaterialHex();
    for (const id of Object.values(SAUNA_WALL)) expect(before[id], id).toBeDefined();

    await setSurfaceColour(page, SAUNA_WALL.sauna, "#ff00ff");
    await expect.poll(() => vh(page).materialHex(SAUNA_WALL.sauna)).toBe("#ff00ff");

    // One physical wall, three room-facing surfaces: the other two must be untouched.
    expect(await vh(page).materialHex(SAUNA_WALL.shower)).toBe(before[SAUNA_WALL.shower]);
    expect(await vh(page).materialHex(SAUNA_WALL.fireplace)).toBe(before[SAUNA_WALL.fireplace]);
  } finally {
    await context.close();
  }
});

test("the dormer follows the upper floor's isolation", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const api = vh(page);
    await page.getByRole("button", { name: "Upper floor", exact: true }).click();

    await expect.poll(() => api.visible("house-ground", "f-ground")).toBe(false);
    expect(await api.visible("house-upper", "f-upper")).toBe(true);
    // The dormer geometry lives in `house-roof` but under that asset's own `f-upper` node.
    expect(await api.visible("house-roof", "f-upper")).toBe(true);

    await page.getByRole("button", { name: "Ground floor", exact: true }).click();
    await expect.poll(() => api.visible("house-roof", "f-upper")).toBe(false);
    expect(await api.visible("house-ground", "f-ground")).toBe(true);
  } finally {
    await context.close();
  }
});

test("the structure asset's edges are hidden while the floors are exploded", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const api = vh(page);
    await page.getByRole("checkbox", { name: "Structure (trusses, footings)" }).check();
    await expect
      .poll(() => vh(page).status().then((s) => s.loadedAssetIds.includes(STRUCTURE.asset)), {
        timeout: 60_000,
      })
      .toBe(true);
    await waitForStableFrames(page);
    expect(await api.visible(STRUCTURE.asset, STRUCTURE.edges)).toBe(true);

    const slider = page.getByLabel("Explode gap in metres");
    await slider.fill("3");
    await slider.dispatchEvent("input");

    // `b-house` floors sort ground (0) then upper (1), so the upper floor rises by exactly one gap.
    await expect.poll(() => api.worldY("house-upper", "f-upper")).toBeCloseTo(3, 6);
    expect(await api.worldY("house-ground", "f-ground")).toBeCloseTo(0, 6);
    // One edges object per asset cannot be split by floor, so it goes away instead of lying.
    expect(await api.visible(STRUCTURE.asset, STRUCTURE.edges)).toBe(false);

    measurements["explode"] = {
      gap: 3,
      upperFloorWorldY: await api.worldY("house-upper", "f-upper"),
      groundFloorWorldY: await api.worldY("house-ground", "f-ground"),
      structureEdgesVisible: await api.visible(STRUCTURE.asset, STRUCTURE.edges),
    };
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// throughput
// ---------------------------------------------------------------------------

test("a scripted orbit reports its frame times", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  try {
    await waitForStableFrames(page);

    const idle = await idleFrames(page, 2_000);
    expect(idle.invalidateAfter).toBe(idle.invalidateBefore);

    await vh(page).resetFrameStats();
    const orbit = await orbitScripted(page, 2_000);
    const stats = await vh(page).frameStats();
    const render = await vh(page).renderInfo();

    expect(stats.frames).toBeGreaterThan(0);

    measurements["idle"] = {
      windowMs: idle.elapsedMs,
      invalidateDelta: idle.invalidateAfter - idle.invalidateBefore,
      rafSamples: idle.frames,
    };
    measurements["orbit"] = {
      windowMs: orbit.elapsedMs,
      keySteps: orbit.steps,
      frames: stats.frames,
      avgMs: stats.avgMs,
      p95Ms: stats.p95Ms,
      renderCalls: render.calls,
      triangles: render.triangles,
    };
    console.log(
      `[house-real] orbit ${orbit.steps} steps / ${orbit.elapsedMs} ms: ${stats.frames} frames, avg ${stats.avgMs.toFixed(2)} ms, p95 ${stats.p95Ms.toFixed(2)} ms, ${render.calls} draw calls, ${render.triangles} triangles`,
    );
    await testInfo.attach("real-orbit.json", {
      body: JSON.stringify({ idle, orbit, stats, render }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await context.close();
  }
});

const fmt = (v: number | null): string => (v === null ? "n/a" : v.toFixed(0));
