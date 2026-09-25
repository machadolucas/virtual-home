/**
 * Browser-side helpers for the 3D House workspace suite.
 *
 * Everything here talks to the workspace through **`window.__vh`** (`src/house/test/testHook.ts`),
 * which the e2e server enables by building with `NEXT_PUBLIC_VH_TEST_HOOK=1`. The hook only reads
 * store/scene state and dispatches actions the UI already offers, so a test that goes through it is
 * still testing the real application — it is not a back door around authentication.
 *
 * Two things need care and are handled once, here, rather than in every spec:
 *
 *  - **`frameloop="demand"`.** Nothing renders unless something asks. A screenshot taken before the
 *    scene has settled can capture a half-drawn frame, so `waitForStableFrames()` waits for
 *    `invalidateCount()` to stop moving.
 *  - **Handles, not JSON.** `pick()` returns live `Object3D`/`Vector3` references, which cannot
 *    cross the `page.evaluate` boundary. The wrappers below project every result to plain data
 *    inside the page.
 */
import type { Browser, BrowserContext, JSHandle, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { VhHook } from "@/house/test/testHook";
import { e2eBaseUrl, login, nextClientIp, type E2eUser, type E2eUserKey } from "../fixtures";

// ---------------------------------------------------------------------------
// plain-data mirrors of the hook's return types
// ---------------------------------------------------------------------------

export interface VhStatus {
  phase: string;
  modelId: string | null;
  fingerprint: string | null;
  loadedAssetIds: string[];
  failedAssetIds: string[];
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export interface VhSelectionValue {
  kind: string;
  id: string;
}

export interface VhCamera {
  position: [number, number, number];
  target: [number, number, number];
  projection: string;
}

export interface VhRenderInfo {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  shadowMapEnabled: boolean;
}

export interface VhFrameSample {
  frames: number;
  avgMs: number;
  p95Ms: number;
}

export interface VhMaterialAuditRow {
  assetId: string;
  materialCount: number;
  cloned: number;
}

/** `PickResult` without the live `Object3D`; `point` is a plain triple. */
export interface VhPick {
  surfaceId: string | null;
  elementId: string | null;
  roomId: string | null;
  floorId: string | null;
  buildingId: string | null;
  point: [number, number, number];
  distance: number;
}

/** Phases at which the workspace is usable. */
export const INTERACTIVE_PHASES = ["interactive", "ready", "degraded"] as const;
/** Phases at which loading has finished, one way or another. */
export const SETTLED_PHASES = ["ready", "degraded", "failed"] as const;

// ---------------------------------------------------------------------------
// evaluating against the hook
// ---------------------------------------------------------------------------

async function hookHandle(page: Page): Promise<JSHandle<VhHook>> {
  return page.evaluateHandle(() => {
    const hook = window.__vh;
    if (!hook)
      throw new Error(
        "window.__vh is missing — the build needs NEXT_PUBLIC_VH_TEST_HOOK=1 (see tests/e2e/start-server.ts)",
      );
    return hook;
  });
}

/**
 * Run `fn` in the page with the live hook and one serialisable argument.
 *
 * The hook is passed as a `JSHandle`, which is why `fn` may touch `Object3D`s and promises as long
 * as what it *returns* is plain data.
 */
export async function evalHook<A, R>(
  page: Page,
  fn: (ctx: { hook: VhHook; arg: A }) => R | Promise<R>,
  arg: A,
): Promise<R> {
  const handle = await hookHandle(page);
  try {
    // The cast defeats Playwright's `Unboxed<>` argument mapping: `arg` really does arrive
    // unchanged, and `hook` arrives as the live object the handle points at.
    const evaluate = page.evaluate.bind(page) as unknown as (
      pageFunction: (ctx: { hook: VhHook; arg: A }) => R | Promise<R>,
      pageArg: unknown,
    ) => Promise<R>;
    return await evaluate(fn, { hook: handle, arg });
  } finally {
    await handle.dispose();
  }
}

/** Typed wrappers over `window.__vh`. One `page.evaluate` per call, no shared state. */
export function vh(page: Page) {
  return {
    /** Escape hatch: `vh(page).eval(({ hook }) => …)`, optionally with an argument. */
    eval: <A, R>(fn: (ctx: { hook: VhHook; arg: A }) => R | Promise<R>, arg?: A): Promise<R> =>
      evalHook(page, fn, arg as A),

    settled: (): Promise<void> => evalHook(page, ({ hook }) => hook.settled, undefined),
    ready: (): Promise<void> => evalHook(page, ({ hook }) => hook.ready, undefined),

    status: (): Promise<VhStatus> => evalHook(page, ({ hook }) => hook.status(), undefined),
    phase: (): Promise<string> => evalHook(page, ({ hook }) => hook.status().phase, undefined),

    materialHex: (surfaceId: string): Promise<string | null> =>
      evalHook(page, ({ hook, arg }) => hook.materialHex(arg), surfaceId),
    allMaterialHex: (): Promise<Record<string, string>> =>
      evalHook(page, ({ hook }) => hook.allMaterialHex(), undefined),
    materialAudit: (): Promise<VhMaterialAuditRow[]> =>
      evalHook(page, ({ hook }) => hook.materialAudit(), undefined),

    visible: (assetId: string, nodeName: string): Promise<boolean> =>
      evalHook(page, ({ hook, arg }) => hook.visible(arg[0], arg[1]), [assetId, nodeName] as const),
    worldY: (assetId: string, nodeName: string): Promise<number | null> =>
      evalHook(page, ({ hook, arg }) => hook.worldY(arg[0], arg[1]), [assetId, nodeName] as const),
    clipPlanes: (surfaceId: string) =>
      evalHook(page, ({ hook, arg }) => hook.clipPlanes(arg), surfaceId),
    pickables: (): Promise<number> => evalHook(page, ({ hook }) => hook.pickables(), undefined),

    select: (selection: VhSelectionValue | null): Promise<void> =>
      evalHook(
        page,
        ({ hook, arg }) => {
          hook.select(arg as Parameters<VhHook["select"]>[0]);
        },
        selection,
      ),
    selection: (): Promise<VhSelectionValue | null> =>
      evalHook(
        page,
        ({ hook }) => {
          const sel = hook.selection();
          return sel ? { kind: sel.kind as string, id: sel.id as string } : null;
        },
        undefined,
      ),
    hover: (): Promise<VhSelectionValue | null> =>
      evalHook(
        page,
        ({ hook }) => {
          const hovered = hook.hover();
          return hovered ? { kind: hovered.kind as string, id: hovered.id as string } : null;
        },
        undefined,
      ),
    placementDraft: (): Promise<{ position: [number, number, number]; rotationYDeg: number } | null> =>
      evalHook(page, ({ hook }) => hook.placementDraft(), undefined),

    controlsEnabled: (): Promise<boolean | null> =>
      evalHook(page, ({ hook }) => hook.controlsEnabled(), undefined),
    controlBindings: () =>
      evalHook(page, ({ hook }) => hook.controlBindings(), undefined),

    camera: (): Promise<VhCamera> =>
      evalHook(
        page,
        ({ hook }) => {
          const c = hook.camera();
          return { position: c.position, target: c.target, projection: c.projection };
        },
        undefined,
      ),
    screenOf: (world: [number, number, number]): Promise<[number, number] | null> =>
      evalHook(page, ({ hook, arg }) => hook.screenOf(arg), world),
    roomAnchor: (roomId: string): Promise<[number, number, number] | null> =>
      evalHook(page, ({ hook, arg }) => hook.roomAnchor(arg), roomId),

    /** `pick()` projected to plain data — the raw result holds live scene objects. */
    pick: (cssX: number, cssY: number): Promise<VhPick | null> =>
      evalHook(
        page,
        ({ hook, arg }) => {
          const hit = hook.pick(arg[0], arg[1]);
          if (!hit) return null;
          return {
            surfaceId: hit.surfaceId,
            elementId: hit.elementId,
            roomId: hit.roomId,
            floorId: hit.floorId,
            buildingId: hit.buildingId,
            point: [hit.point.x, hit.point.y, hit.point.z] as [number, number, number],
            distance: hit.distance,
          };
        },
        [cssX, cssY] as const,
      ),

    renderInfo: (): Promise<VhRenderInfo> =>
      evalHook(page, ({ hook }) => hook.renderInfo(), undefined),

    frameStats: (): Promise<VhFrameSample> =>
      evalHook(
        page,
        ({ hook }) => {
          const s = hook.frameStats();
          return { frames: s.frames, avgMs: s.avgMs, p95Ms: s.p95Ms };
        },
        undefined,
      ),
    resetFrameStats: (): Promise<void> =>
      evalHook(
        page,
        ({ hook }) => {
          hook.frameStats().reset();
        },
        undefined,
      ),

    invalidateCount: (): Promise<number> =>
      evalHook(page, ({ hook }) => hook.invalidateCount(), undefined),
    renderedLights: () => evalHook(page, ({ hook }) => hook.renderedLights(), undefined),
    shadowSurface: (surfaceId: string) =>
      evalHook(page, ({ hook, arg }) => hook.shadowSurface(arg), surfaceId),
    lastSavePayload: (): Promise<unknown> =>
      evalHook(page, ({ hook }) => (hook.lastSavePayload() ?? null) as unknown, undefined),
    disposedInfo: (): Promise<{ geometries: number; textures: number } | null> =>
      evalHook(page, ({ hook }) => hook.disposedInfo(), undefined),
  };
}

// ---------------------------------------------------------------------------
// opening the workspace
// ---------------------------------------------------------------------------

export interface OpenHouseOptions {
  /** `?sel=` — e.g. `"room:r-l-a"`. */
  sel?: string;
  /** `?floor=` */
  floor?: string;
  /** `?view=` */
  view?: string;
  /** `?proj=` */
  proj?: string;
  /** Which seeded household account to sign in as. Defaults to `lucas`. */
  as?: E2eUserKey | E2eUser;
  /**
   * How far to wait. `hook` only waits for `window.__vh`; `settled` (the default) waits for the
   * hook's `settled` promise, which resolves at `ready`, `degraded` **or** `failed`.
   */
  waitFor?: "hook" | "settled";
  /** Network-mocked journeys must bypass the PWA worker, whose fetches evade page routing. */
  serviceWorkers?: "allow" | "block";
}

/** `/house` with the workspace's URL state applied. */
export function houseUrl(options: OpenHouseOptions = {}): string {
  const params = new URLSearchParams();
  if (options.sel) params.set("sel", options.sel);
  if (options.floor) params.set("floor", options.floor);
  if (options.view) params.set("view", options.view);
  if (options.proj) params.set("proj", options.proj);
  const query = params.toString();
  return query ? `/house?${query}` : "/house";
}

/**
 * Keep the PWA's service worker out of the house specs (`pwa.spec.ts` is where it is tested).
 *
 * Once `/sw.js` controls a WebKit page, the page's `fetch()`es no longer reach `page.route()`
 * reliably — even API requests the worker passes straight through — so a spec that fulfils
 * `/placements`, `/controls` or `/furnishings` with synthetic rows silently gets the real, empty
 * responses instead. `serviceWorkers: "block"` is not applied consistently by WebKit either (see
 * `helpers/liveHa.ts`), so registration is refused in the page before the first navigation.
 */
export async function disableServiceWorkerRegistration(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    try {
      Object.defineProperty(navigator.serviceWorker, "register", {
        configurable: true,
        value: () => Promise.reject(new Error("Service workers are disabled in the house specs")),
      });
    } catch {
      // Already refused by `installSyntheticHa`, whose definition is not configurable.
    }
  });
}

/**
 * Sign in, land on `/house`, wait for the test hook, then for the load to settle.
 *
 * The load probe is installed *before* the first navigation so `measureLoad()` can report timings
 * for whichever document ends up being the workspace.
 */
/** The skip reason for hosts without WebGL 2; grep for it. */
export const NEEDS_WEBGL =
  "needs WebGL 2 in the test browser (a GPU or software rasteriser) — set VH_E2E_REQUIRE_WEBGL=1 to fail instead of skip";

/**
 * Skip the calling test when the browser cannot create a WebGL 2 context — the House workspace is
 * three.js and renders nothing without one, so every assertion after sign-in would fail for a
 * reason that has nothing to do with the app. A capability probe, not a host check: headless
 * Chromium and WebKit on the Mac mini both have WebGL 2, while a container without a GPU or a
 * software rasteriser does not. `VH_E2E_REQUIRE_WEBGL=1` turns the skip into a failure, for hosts
 * where losing WebGL would itself be the regression.
 */
export async function requireWebGL(page: Page): Promise<void> {
  const available = await page.evaluate(() => {
    try {
      return document.createElement("canvas").getContext("webgl2") !== null;
    } catch {
      return false;
    }
  });
  if (!available && process.env["VH_E2E_REQUIRE_WEBGL"] === "1") {
    throw new Error("VH_E2E_REQUIRE_WEBGL=1, but this browser cannot create a WebGL 2 context");
  }
  test.skip(!available, NEEDS_WEBGL);
}

/**
 * The WebGL renderer string, e.g. "ANGLE (… SwiftShader driver)" for headless Chromium's default
 * software rasteriser, "Apple GPU" for Playwright's WebKit on a Mac. Probed on whatever page is
 * open (about:blank is fine), so a spec can size its budget before the expensive part starts.
 */
export async function webglRenderer(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  });
}

/** Software rasterisers compile and draw shader-heavy scenes an order of magnitude slower. */
export async function isSoftwareWebGL(page: Page): Promise<boolean> {
  return /SwiftShader|llvmpipe|softpipe|Software/i.test((await webglRenderer(page)) ?? "");
}

export async function openHouse(page: Page, options: OpenHouseOptions = {}): Promise<void> {
  await requireWebGL(page);
  // Specs that use Playwright's own `page` fixture never claimed a client address, so every one of
  // them signed in as the same client and shared one 5-per-minute bucket; a few fast house specs
  // in a row got "Too many attempts" and timed out in `login()`. A page-level address costs
  // nothing for contexts that already set one (`openHouseSession`), and fixes those that did not.
  await page.setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  await disableServiceWorkerRegistration(page);
  await installLoadProbe(page);
  const target = houseUrl(options);
  await login(page, options.as ?? "lucas", { next: target, expectPath: "/house" });
  await waitForHook(page);
  if ((options.waitFor ?? "settled") === "settled") await vh(page).settled();
}

/**
 * A signed-in workspace in its **own** browser context.
 *
 * Two reasons this is not just `page`: sign-in is rate limited to 5 attempts per minute per client
 * address, so every context claims its own `x-forwarded-for` (see `fixtures.ts`); and
 * `browser.newContext()` inherits nothing from the config, so the project's device shape has to be
 * copied across explicitly — otherwise the phone project would silently run at desktop size and
 * the workspace would never take its phone branch.
 */
export async function openHouseSession(
  browser: Browser,
  options: OpenHouseOptions = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...deviceOptionsOfProject(),
    serviceWorkers: options.serviceWorkers,
    baseURL: e2eBaseUrl(),
    extraHTTPHeaders: { "x-forwarded-for": houseClientIp() },
  });
  const page = await context.newPage();
  await openHouse(page, options);
  return { context, page };
}

export type RenderingCategory = "Light" | "Environment" | "Quality" | "Background";

/** Sections of the View settings popover (desktop) and sheet (phone), in `ViewSettings` order. */
export type ViewSection = "Visibility" | "Cut and separation" | "Lighting" | "Appearance" | "Advanced";

/**
 * Open View settings and expand one section. The old desktop tab strip (Layers, …) is gone: every
 * presentation control now lives in these collapsible sections, and only Visibility starts open.
 */
export async function openViewSection(page: Page, section: ViewSection): Promise<void> {
  // A desktop popover that was just dismissed (an outside click, Escape) stays in the DOM while it
  // animates out, still "visible" but about to detach. Deciding against that ghost made the next
  // click wait forever for a control that had gone, so let the exit finish first. (Only the
  // popover carries this aria-label; the phone sheet is kept mounted and is named by its title.)
  await expect(page.locator('[aria-label="View settings"][data-state="closed"]')).toHaveCount(0);
  const summary = page.locator("summary:visible").filter({hasText:new RegExp(`^${section}$`)});
  if (!await summary.isVisible()) await page.getByRole("button", {name:"View",exact:true}).click();
  const details = summary.locator("..");
  if (await details.getAttribute("open") === null) await summary.click();
}

/**
 * Close View settings if it is open. On desktop it is a popover floating over the canvas, so a
 * scripted drag at the canvas centre would land on the popover instead of orbiting the camera.
 */
export async function closeViewSettings(page: Page): Promise<void> {
  const view = page.getByRole("dialog", { name: "View settings", exact: true });
  if (await view.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(view).toBeHidden();
  }
  await expect(page.locator('[aria-label="View settings"][data-state="closed"]')).toHaveCount(0);
}

/**
 * Press a Floor focus button ("All", "Lower floor", …). They sit on the desktop canvas, and inside
 * the View sheet on phones, which is opened first when the button is not on screen.
 */
export async function focusFloor(page: Page, label: string): Promise<void> {
  const button = page.getByRole("region", { name: "Floor focus" }).getByRole("button", { name: label, exact: true });
  if (!(await button.isVisible())) await openViewSection(page, "Visibility");
  await button.click();
}

/** Open the responsive rendering surface and focus one of its task-sized categories. */
export async function openRenderingCategory(page: Page, category: RenderingCategory): Promise<void> {
  const sections: Record<RenderingCategory, ViewSection> = { Light: "Lighting", Environment: "Lighting", Quality: "Advanced", Background: "Appearance" };
  await openViewSection(page, sections[category]);
}

/**
 * A random client address per context — `fixtures.ts`'s `nextClientIp()`, under the name the house
 * specs read with. The randomness (and why a counter collides across projects and across runs) is
 * documented there.
 */
export function houseClientIp(): string {
  return nextClientIp();
}

/** The device-shaped half of the running project's `use` block. */
export function deviceOptionsOfProject(): Parameters<Browser["newContext"]>[0] {
  const use = test.info().project.use;
  return {
    viewport: use.viewport ?? undefined,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    locale: use.locale,
    timezoneId: use.timezoneId,
    colorScheme: use.colorScheme,
    reducedMotion: use.reducedMotion,
  };
}

/** Re-navigate an already signed-in page (a reload, or a different `?sel=`). */
export async function gotoHouse(page: Page, options: OpenHouseOptions = {}): Promise<void> {
  await page.goto(houseUrl(options));
  await waitForHook(page);
  if ((options.waitFor ?? "settled") === "settled") await vh(page).settled();
}

/** Wait until `window.__vh` exists. Fails loudly rather than timing out inside a wrapper. */
export async function waitForHook(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => typeof window.__vh !== "undefined", undefined, { timeout });
}

/** Wait until `status().phase` is one of `phases`. */
export async function waitForPhase(
  page: Page,
  phases: readonly string[],
  timeout = 20_000,
): Promise<string> {
  await page.waitForFunction(
    (wanted: readonly string[]) => {
      const hook = window.__vh;
      if (!hook) return false;
      return wanted.includes(hook.status().phase);
    },
    phases,
    { timeout },
  );
  return vh(page).phase();
}

// ---------------------------------------------------------------------------
// load timing
// ---------------------------------------------------------------------------

export interface LoadTiming {
  /** `performance.now()` at which `window.__vh` first appeared. */
  hookMs: number | null;
  /** …at which the phase first reached `interactive`/`ready`/`degraded`. */
  interactiveMs: number | null;
  /** …at which it first reached `ready`/`degraded`/`failed`. */
  readyMs: number | null;
  /** The phase sequence actually observed, in order. */
  phases: string[];
  /** `performance.now()` is relative to this document's navigation start. */
  origin: "navigationStart";
}

/**
 * Install the phase poller. It has to be an init script: the phases we care about are reached long
 * before a test can attach anything, and `performance.now()` inside the page is already relative to
 * that document's navigation start, which is the datum §13.3 asks for.
 *
 * A poller rather than a store subscription: the hook exposes promises and `status()`, not a
 * subscribe seam, and 8 ms of resolution is far finer than the thresholds being asserted.
 */
export async function installLoadProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const INTERACTIVE = ["interactive", "ready", "degraded"];
    const SETTLED = ["ready", "degraded", "failed"];
    const marks = {
      hookMs: null as number | null,
      interactiveMs: null as number | null,
      readyMs: null as number | null,
      phases: [] as string[],
      origin: "navigationStart" as const,
    };
    (window as unknown as { __vhLoad?: typeof marks }).__vhLoad = marks;

    const started = Date.now();
    const timer = setInterval(() => {
      // Give up after a minute so a stray page never keeps a timer alive for the whole run.
      if (Date.now() - started > 60_000) {
        clearInterval(timer);
        return;
      }
      const hook = window.__vh;
      if (!hook) return;
      if (marks.hookMs === null) marks.hookMs = performance.now();
      let phase: string;
      try {
        phase = hook.status().phase;
      } catch {
        return;
      }
      if (marks.phases[marks.phases.length - 1] !== phase) marks.phases.push(phase);
      if (marks.interactiveMs === null && INTERACTIVE.includes(phase))
        marks.interactiveMs = performance.now();
      if (marks.readyMs === null && SETTLED.includes(phase)) {
        marks.readyMs = performance.now();
        clearInterval(timer);
      }
    }, 8);
  });
}

/**
 * Read the load timings, waiting (up to `timeout`) for the settled mark.
 *
 * Requires `installLoadProbe()` to have run before the navigation — `openHouse()` does that.
 */
export async function measureLoad(page: Page, timeout = 30_000): Promise<LoadTiming> {
  await page.waitForFunction(
    () => {
      const marks = (window as unknown as { __vhLoad?: { readyMs: number | null } }).__vhLoad;
      return !!marks && marks.readyMs !== null;
    },
    undefined,
    { timeout },
  );
  return page.evaluate(() => {
    const marks = (window as unknown as { __vhLoad?: LoadTimingShape }).__vhLoad;
    if (!marks) throw new Error("no load probe on this page — call installLoadProbe() first");
    return {
      hookMs: marks.hookMs,
      interactiveMs: marks.interactiveMs,
      readyMs: marks.readyMs,
      phases: [...marks.phases],
      origin: "navigationStart" as const,
    };
  });
}

interface LoadTimingShape {
  hookMs: number | null;
  interactiveMs: number | null;
  readyMs: number | null;
  phases: string[];
}

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

export interface IdleResult extends VhFrameSample {
  /** `invalidateCount()` before and after the idle window. */
  invalidateBefore: number;
  invalidateAfter: number;
  /** How long the window actually was, in wall-clock ms. */
  elapsedMs: number;
}

/**
 * Sit still for `ms` and report what the renderer did.
 *
 * `invalidateAfter - invalidateBefore` is the load-bearing number: under `frameloop="demand"` an
 * idle workspace must not ask for a single new frame.
 */
export async function idleFrames(page: Page, ms: number): Promise<IdleResult> {
  const api = vh(page);
  const invalidateBefore = await api.invalidateCount();
  await api.resetFrameStats();
  const start = Date.now();
  await page.waitForTimeout(ms);
  const sample = await api.frameStats();
  const invalidateAfter = await api.invalidateCount();
  return { ...sample, invalidateBefore, invalidateAfter, elapsedMs: Date.now() - start };
}

/**
 * Wait until nothing is asking for frames any more: `invalidateCount()` unchanged for `stableMs`.
 *
 * This is the "no pending frames" gate §13.4 requires before a screenshot, and it is why the
 * captures cannot catch a half-rendered demand frame.
 */
export async function waitForStableFrames(
  page: Page,
  stableMs = 250,
  timeout = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  const api = vh(page);
  let last = await api.invalidateCount();
  let stableSince = Date.now();
  for (;;) {
    await page.waitForTimeout(50);
    const now = await api.invalidateCount();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return;
    }
    if (Date.now() > deadline)
      throw new Error(`invalidateCount() never settled for ${stableMs} ms within ${timeout} ms`);
  }
}

/**
 * A scripted orbit for `ms`, through the real keyboard path: `ArrowLeft`/`ArrowRight` on the canvas
 * region drive `camera.orbit(±5°)`, exactly as a keyboard-only user would.
 *
 * The camera region has to be focused first — the shortcut listener lives on the workspace root,
 * not on `window` (`useKeyboardShortcuts`), which is the property that keeps the rest of the app
 * unaffected.
 *
 * The keys then go through `page.keyboard`, not `locator.press()`. `locator.press()` re-resolves the
 * selector and re-focuses on every call, which costs ~190 ms per step against a scene that is busy
 * rendering: measured, it produced 11 steps in a 2 s window instead of the ~60 §13.3 asks for, so
 * most of the sampled frame times were idle cadence rather than orbit frames.
 */
export async function orbitScripted(
  page: Page,
  ms: number,
  opts: { stepMs?: number } = {},
): Promise<{ steps: number; elapsedMs: number }> {
  const region = page.getByRole("application", { name: "House 3D view" });
  await region.focus();
  const stepMs = opts.stepMs ?? 32;
  const start = Date.now();
  let steps = 0;
  while (Date.now() - start < ms) {
    await page.keyboard.press(steps % 2 === 0 ? "ArrowRight" : "ArrowLeft");
    steps += 1;
    const spent = Date.now() - start;
    const target = steps * stepMs;
    if (target > spent) await page.waitForTimeout(target - spent);
  }
  return { steps, elapsedMs: Date.now() - start };
}

export interface CanvasPickPoint {
  /** CSS pixels inside the canvas rect. */
  x: number;
  y: number;
  /** What `__vh.pick()` resolves at that point. */
  pick: VhPick;
}

/**
 * Find a point inside the canvas that (a) nothing in the DOM covers and (b) picks what `predicate`
 * wants, starting from `base` and trying small offsets.
 *
 * Both halves matter. The label overlay draws each room's name as a real `<button>` centred on
 * `roomAnchor(roomId)` with `pointer-events: auto` (the `[&>*]:pointer-events-auto` overlay at
 * `src/house/components/LabelOverlay.tsx:120`, the button at 125), so a click at `screenOf(roomAnchor(…))`
 * lands on the label — which selects the room, but through the DOM path, not through the 3D pick,
 * and it also re-frames the camera. Offsetting a little finds bare canvas over the same floor.
 */
/**
 * A page point near `fraction` (of the canvas box) where nothing covers the canvas, for scripted
 * drags. The overlays are responsive — at 1280 px the view-controls bar wraps onto a second row,
 * and room labels are real buttons — so a hard-coded offset can start a drag on a control.
 */
export async function bareCanvasPoint(page: Page, fraction: readonly [number, number]): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(([fx, fy]) => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const x0 = box.left + box.width * fx, y0 = box.top + box.height * fy;
    for (let radius = 0; radius <= Math.max(box.width, box.height); radius += 16) {
      for (let step = 0; step < Math.max(1, radius / 4); step++) {
        const angle = (step / Math.max(1, radius / 4)) * Math.PI * 2;
        const x = x0 + Math.cos(angle) * radius, y = y0 + Math.sin(angle) * radius;
        if (x < box.left + 4 || y < box.top + 4 || x > box.right - 4 || y > box.bottom - 4) continue;
        if (document.elementFromPoint(x, y) === canvas) return { x, y };
      }
    }
    return null;
  }, fraction);
  if (!point) throw new Error(`no uncovered canvas point near ${fraction.join(", ")}`);
  return point;
}

export async function findCanvasPick(
  page: Page,
  base: readonly [number, number],
  predicate: (hit: VhPick) => boolean,
  offsets: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [0, 28],
    [28, 0],
    [0, -28],
    [-28, 0],
    [0, 56],
    [56, 0],
    [0, -56],
    [-56, 0],
  ],
): Promise<CanvasPickPoint> {
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("the canvas has no bounding box");
  const tried: string[] = [];
  for (const [dx, dy] of offsets) {
    const x = base[0] + dx;
    const y = base[1] + dy;
    if (x < 0 || y < 0 || x > box.width || y > box.height) continue;
    const covering = await elementAt(page, box.x + x, box.y + y);
    if (covering !== "canvas") {
      tried.push(`(${dx},${dy}) covered by <${covering}>`);
      continue;
    }
    const hit = await vh(page).pick(x, y);
    if (hit && predicate(hit)) return { x, y, pick: hit };
    tried.push(`(${dx},${dy}) picked ${hit?.surfaceId ?? "nothing"}`);
  }
  throw new Error(`no clickable canvas point near (${base[0]}, ${base[1]}): ${tried.join("; ")}`);
}

/** The tag name of the topmost element at a viewport position. */
async function elementAt(page: Page, clientX: number, clientY: number): Promise<string> {
  return page.evaluate((p: readonly [number, number]) => {
    const el = document.elementFromPoint(p[0], p[1]);
    return el ? el.tagName.toLowerCase() : "none";
  }, [clientX, clientY] as const);
}

/** Click a point given in canvas CSS pixels. */
export async function clickCanvasAt(page: Page, cssX: number, cssY: number): Promise<void> {
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("the canvas has no bounding box");
  await page.mouse.click(box.x + cssX, box.y + cssY);
}

/**
 * Orbit the camera to straight overhead through the real keyboard path (`ArrowUp` = −5° polar,
 * clamped at 0 by the rig).
 *
 * Needed because a pick "through a room's anchor" only resolves to that room's **floor** when the
 * ray is vertical: from an oblique pose the ray leaves through a wall face, which is a correct pick
 * of a different surface. The workspace's own top-down plan view cannot be used for this — see the
 * `test.fixme` in `house.spec.ts` about `planFor()` never rotating to polar 0.
 */
export async function orbitOverhead(page: Page, presses = 20): Promise<void> {
  const region = page.getByRole("application", { name: "House 3D view" });
  await region.focus();
  for (let i = 0; i < presses; i++) await page.keyboard.press("ArrowUp");
  await waitForStableFrames(page, 500);
}

// ---------------------------------------------------------------------------
// small conveniences
// ---------------------------------------------------------------------------

/** The manifest as the browser sees it: through the authenticated, content-addressed route. */
export async function fetchManifest(
  page: Page,
  modelId: string,
  fingerprint: string,
): Promise<ManifestShape> {
  const res = await page.request.get(
    `/api/house-model/${encodeURIComponent(modelId)}/manifest?v=${encodeURIComponent(fingerprint)}`,
  );
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as ManifestShape;
}

/** Only the parts of the manifest the browser suite asserts against. */
export interface ManifestShape {
  modelId: string;
  name?: string;
  rooms: Array<{
    id: string;
    name: string;
    floorId: string;
    floorElevation: number;
    surfaceIds: string[];
  }>;
  surfaces: Array<{
    id: string;
    kind: string;
    role?: string;
    roomId?: string;
    defaultColor: string;
    nodeRefs: Array<{ assetId: string; nodeName: string }>;
  }>;
  floors: Array<{ id: string; name: string; elevation: number }>;
  assets: Array<{ id: string; kind: string; loadByDefault: boolean; edgesNode?: string | null }>;
}

/** Isolate a floor through the toolbar button, the way the household does. */
export async function isolateFloorByName(page: Page, floorName: string): Promise<void> {
  await page.getByRole("button", { name: floorName, exact: true }).click();
}

/**
 * Set a surface's colour through the inspector's own `<input type="color">`.
 *
 * `fill` alone does not notify React for a colour input, so an explicit `input` event follows; the
 * store write is what the assertions then observe.
 */
export async function setSurfaceColour(
  page: Page,
  surfaceId: string,
  hex: string,
): Promise<void> {
  const input = page.locator(`input[type=color][aria-label$="${surfaceId}"]`);
  await expect(input).toHaveCount(1);
  await input.fill(hex);
  await input.dispatchEvent("input");
}

/** Keys that differ between two `allMaterialHex()` snapshots. */
export function hexDiff(
  before: Record<string, string>,
  after: Record<string, string>,
): Array<{ surfaceId: string; before: string | undefined; after: string | undefined }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: Array<{ surfaceId: string; before: string | undefined; after: string | undefined }> = [];
  for (const key of [...keys].sort()) {
    if (before[key] !== after[key]) out.push({ surfaceId: key, before: before[key], after: after[key] });
  }
  return out;
}
