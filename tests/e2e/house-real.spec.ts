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
 * `vh-e2e-*` whose `.bootstrap-pid` names a live process. It then runs the household's own import
 * command against that directory —
 * `VH_DATA_DIR=<harness dir> pnpm exec tsx scripts/vh-admin.ts model-import <dir>` — so the package
 * goes in through the real path: `validatePackageDir` → `installPackage` → `registerRevision`. A
 * child process rather than an in-process import, because `src/server/**` is written for Next's
 * `react-server` condition and `tsx` is what the repo already uses to run it outside Next.
 *
 * The running `next start` then sees the new `current.json` on its next re-check
 * (`getCurrentPackage` stats the pointer at most every 10 s). `afterAll` re-imports the fixture, so
 * a later run of `house.spec.ts` or `screenshots.spec.ts` against the same reused server is
 * unaffected and no capture of the real house is left behind by accident.
 *
 * Nothing is copied into the repository: the package is read from `VH_REAL_MODEL_DIR` and installed
 * into the temp data dir, which the bootstrap deletes when it exits.
 *
 * Measured numbers land in `test-results/house-measurements.json` (git-ignored) and are printed, so
 * the rows in `docs/verification.md` are transcribed from a real run rather than estimated.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  clickCanvasAt,
  fetchManifest,
  findCanvasPick,
  idleFrames,
  measureLoad,
  openHouseSession,
  orbitOverhead,
  orbitScripted,
  setSurfaceColour,
  vh,
  waitForHook,
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
let harnessDataDir: string | null = null;


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

const run = promisify(execFile);

/** The env the admin CLI needs: the harness's data dir, and nothing from a developer's `.env.local`. */
function cliEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VH_ROLE: "cli",
    VH_DATA_DIR: dataDir,
    VH_BASE_URL: `http://127.0.0.1:${process.env["VH_E2E_PORT"] ?? 3011}`,
    VH_TRUSTED_ORIGINS: `http://127.0.0.1:${process.env["VH_E2E_PORT"] ?? 3011}`,
    BETTER_AUTH_SECRET:
      process.env["BETTER_AUTH_SECRET"] ?? "e2e-real-model-spec-secret-that-is-long-enough",
    LOG_LEVEL: "warn",
    HA_URL: "",
    HA_TOKEN: "",
  };
  delete env["HA_WS_URL"];
  return env;
}

/**
 * Install `dir` into `dataDir` through `pnpm vh-admin model-import`.
 *
 * Deliberately not the npm script: that one passes `--env-file-if-exists=.env.local`, and this has
 * to run against the harness's data directory and nothing else.
 */
async function installInto(dataDir: string, dir: string): Promise<{ modelId: string; fingerprint: string }> {
  const { stdout, stderr } = await run(
    "pnpm",
    ["exec", "tsx", "scripts/vh-admin.ts", "model-import", dir],
    { cwd: REPO_ROOT, env: cliEnv(dataDir), maxBuffer: 8 * 1024 * 1024 },
  );
  const text = `${stdout}\n${stderr}`;
  // "installed <modelId> @ <fingerprint> into <path>" / "already installed: <modelId> @ <fingerprint>"
  const match = /(?:^|\n)(?:already )?installed:? (\S+) @ ([0-9a-f]{8,64})/.exec(text);
  if (!match) throw new Error(`could not read the installed package from vh-admin output:\n${text}`);
  return { modelId: match[1]!, fingerprint: match[2]! };
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
  harnessDataDir = dataDir;
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
    const back = await installInto(harnessDataDir!, FIXTURE_MODEL_DIR);
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
    // Then look straight down — from an oblique pose the ray through a room's anchor leaves through
    // a wall face, which is a correct pick of a different surface (see the `test.fixme` in
    // house.spec.ts about the plan view's camera).
    await page.getByRole("button", { name: "Dollhouse (D)" }).click();
    await page.getByRole("button", { name: "Ground floor", exact: true }).click();
    await waitForStableFrames(page, 1_000);
    await orbitOverhead(page);

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

    // §13.2 #7, selection feedback. The click has to land on bare canvas: the label overlay owns
    // the room anchor itself, and clicking the label selects through the DOM instead of raycasting.
    const target = await findCanvasPick(
      page,
      screen!,
      (candidate) => candidate.roomId === LIVING.id && candidate.surfaceId === LIVING.floor,
    );

    // The listener is on `window` in the bubble phase, so it runs after the workspace's own
    // `pointerup` handler on the canvas: by then the pick, the emissive highlight and the
    // `invalidate()` have all happened, and `performance.now() - event.timeStamp` is the whole
    // pointerup → first-frame-requested latency, measured inside the page with no round trip in it.
    await page.evaluate(() => {
      const w = window as unknown as {
        __vhSelLatency?: { handlerMs: number; invalidateDelta: number } | null;
      };
      w.__vhSelLatency = null;
      const before = window.__vh!.invalidateCount();
      window.addEventListener(
        "pointerup",
        (event) => {
          w.__vhSelLatency = {
            handlerMs: performance.now() - event.timeStamp,
            invalidateDelta: window.__vh!.invalidateCount() - before,
          };
        },
        { once: true },
      );
    });

    const clickedAt = Date.now();
    await clickCanvasAt(page, target.x, target.y);
    await expect.poll(() => vh(page).selection()).toEqual({ kind: "room", id: LIVING.id });
    await expect(page.getByRole("heading", { name: LIVING.name, level: 2 })).toBeVisible();
    const inspectorMs = Date.now() - clickedAt;

    const latency = await page.evaluate(
      () =>
        (window as unknown as { __vhSelLatency: { handlerMs: number; invalidateDelta: number } | null })
          .__vhSelLatency,
    );
    expect(latency).not.toBeNull();
    expect(latency!.invalidateDelta).toBeGreaterThan(0);

    measurements["selectionFeedback"] = {
      pointerUpToInvalidateMs: latency!.handlerMs,
      invalidateDelta: latency!.invalidateDelta,
      // Coarse upper bound: it includes this test's own polling round trips.
      clickToInspectorHeadingMs: inspectorMs,
    };
    console.log(
      `[house-real] selection feedback: pointerup → invalidate ${latency!.handlerMs.toFixed(1)} ms; inspector heading within ${inspectorMs} ms`,
    );
  } finally {
    await context.close();
  }
});

test("the three faces of the sauna's east wall colour independently", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser, { sel: "room:r-g-sauna" });
  try {
    // Start from the manifest defaults. With a registered model revision, colours really are
    // persisted, so a previous run's override can still be in the database — and, because of the
    // bug the `test.fixme` below records, an override that is in the store but not in the scene is
    // exactly the state in which `setOverride` becomes a no-op. Resetting first makes this test
    // about the shared wall rather than about leftover data.
    await page.getByRole("button", { name: "Reset room" }).click();
    await expect
      .poll(() => vh(page).materialHex(SAUNA_WALL.sauna))
      .toBe(await defaultColorOf(page, SAUNA_WALL.sauna));

    const before = await vh(page).allMaterialHex();
    for (const id of Object.values(SAUNA_WALL)) expect(before[id], id).toBeDefined();

    await setSurfaceColour(page, SAUNA_WALL.sauna, "#ff00ff");
    await expect.poll(() => vh(page).materialHex(SAUNA_WALL.sauna)).toBe("#ff00ff");

    // One physical wall, three room-facing surfaces: the other two must be untouched.
    expect(await vh(page).materialHex(SAUNA_WALL.shower)).toBe(before[SAUNA_WALL.shower]);
    expect(await vh(page).materialHex(SAUNA_WALL.fireplace)).toBe(before[SAUNA_WALL.fireplace]);

    // Leave the household's data as it was found.
    await page.getByRole("button", { name: "Reset room" }).click();
    await expect.poll(() => vh(page).materialHex(SAUNA_WALL.sauna)).toBe(before[SAUNA_WALL.sauna]);
  } finally {
    await context.close();
  }
});

test("a saved colour comes back on the next page load", async ({ browser }) => {
  /**
   * APP BUG — `src/house/hooks/useSceneSync.ts:74-86` (the colour subscription).
   *
   * Symptom: a colour override that was saved in an earlier session is hydrated into the store and
   * shown in the inspector, but is **never applied to the scene**. The room renders its manifest
   * default until the user touches the picker again — and because `setOverride`
   * (`src/house/store/slices/color.ts:28-41`) returns `{}` when the value is unchanged, re-picking
   * the *same* colour does not fix it either.
   *
   * Measured 2026-09-08 by running this test against the real installed package,
   * one override persisted for `s-w-g-sauna-e--r-g-sauna`):
   *   fresh load        → the inspector's colour input reads `#ff00ff` (so the value *was* saved and
   *                       hydrated) while `materialHex` reads `#d9c3a5`, the manifest default
   *   change to #00ffff → `materialHex` `#00ffff`   (the subscription path works)
   *   Reset room        → `materialHex` `#d9c3a5`
   *
   * Cause: that effect applies the plan once on mount and then only when `overrides` changes. On
   * mount the GLBs have not arrived yet, so `index.surfaceMesh` is empty and `applyColors` touches
   * nothing (the guard at line 77, and then an empty scene index). The visibility subscription
   * (lines 56-70) and the cutaway/explode one (lines 103-107) both include `loaded:
   * s.loadedAssetIds` in their selector for exactly this reason; the colour one does not, so
   * nothing re-applies the plan once the meshes exist.
   *
   * It needs a registered `model_revision` to reproduce, which is why it lives here and not in
   * `house.spec.ts`: the fixture harness never persists a colour at all.
   */
  const { context, page } = await openHouseSession(browser, { sel: "room:r-g-sauna" });
  try {
    await setSurfaceColour(page, SAUNA_WALL.sauna, "#ff00ff");
    await expect.poll(() => vh(page).materialHex(SAUNA_WALL.sauna)).toBe("#ff00ff");
    // Long enough for the 600 ms debounced PATCH to land.
    await page.waitForTimeout(1_500);

    // A reload is a fresh document, so the hook has to be waited for again before anything reads
    // through it — `waitForStableFrames` would otherwise throw "window.__vh is missing" and hide
    // the actual symptom.
    await page.reload();
    await waitForHook(page);
    await vh(page).settled();
    await waitForStableFrames(page, 1_000);

    // The inspector shows the saved colour…
    await expect(
      page.locator(`input[type=color][aria-label$="${SAUNA_WALL.sauna}"]`),
    ).toHaveValue("#ff00ff");
    // …and this is what fails today: the scene still shows the manifest default.
    await expect.poll(() => vh(page).materialHex(SAUNA_WALL.sauna)).toBe("#ff00ff");

    await page.getByRole("button", { name: "Reset room" }).click();
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
    // A full second of stability first: the last frame of the opening camera transition lands well
    // after `settled`, and that tail is not what the idle window is about.
    await waitForStableFrames(page, 1_000);

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

/** The manifest's `defaultColor` for one surface, read through the authenticated route. */
async function defaultColorOf(page: import("@playwright/test").Page, surfaceId: string): Promise<string> {
  const status = await vh(page).status();
  const manifest = await fetchManifest(page, status.modelId!, status.fingerprint!);
  const surface = manifest.surfaces.find((s) => s.id === surfaceId);
  if (!surface) throw new Error(`no surface ${surfaceId} in the manifest`);
  return surface.defaultColor.toLowerCase();
}
