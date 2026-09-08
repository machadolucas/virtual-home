/**
 * The 3D House workspace, end to end in a real browser against the **synthetic fixture package**
 * (`tests/fixtures/model/house-model`, modelId `fixture-house`), which the e2e bootstrap installs.
 * This file therefore runs on every machine and in CI; `house-real.spec.ts` re-runs the numeric
 * parts against the household's own package when `VH_REAL_MODEL_DIR` points at it.
 *
 * What only a browser can prove (`docs/design-notes/house-workspace-3d.md` §13.2): that the package
 * survives GLTFLoader and three's colour management with its colours intact, that colour never
 * leaks between the two faces of one wall, that the declarative visibility resolver really does
 * drive `.visible`, that the exploded view is a presentation transform and nothing else, and that
 * `frameloop="demand"` genuinely stops asking for frames when the user stops interacting.
 *
 * Every test opens its own browser context (`openHouseSession`): sign-in is rate limited per client
 * address, and a fresh context is also a fresh store, so no test can inherit another's overrides.
 */
import { expect, test } from "@playwright/test";
import { e2eBaseUrl, nextClientIp } from "./fixtures";
import {
  deviceOptionsOfProject,
  fetchManifest,
  hexDiff,
  idleFrames,
  measureLoad,
  openHouseSession,
  setSurfaceColour,
  vh,
  waitForHook,
  waitForStableFrames,
} from "./helpers/house";

const MODEL_ID = "fixture-house";

/** The fixture's shared wall: one physical wall (`e-w-l-ab`), two independently colourable faces. */
const SHARED_WALL = {
  a: "s-w-l-ab--r-l-a",
  b: "s-w-l-ab--r-l-b",
} as const;

/** Room B's floor sits 0.20 m below the floor datum, like the real package's living room. */
const SUNKEN_ROOM = { id: "r-l-b", name: "Room B", floor: "s-r-l-b-floor", elevation: -0.2 } as const;


test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the desktop workspace (tree, toolbar, inspector) does not render on a phone — see screenshots.spec.ts",
  );
});

// ---------------------------------------------------------------------------
// load and integrity
// ---------------------------------------------------------------------------

test("the fixture package loads clean, with no cloned materials", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const timing = await measureLoad(page);
    const status = await vh(page).status();

    expect(status.phase).toBe("ready");
    expect(status.modelId).toBe(MODEL_ID);
    expect(status.failedAssetIds).toEqual([]);
    expect(status.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    // The four `loadByDefault` assets; `fixture-scan` is opt-in and must not be here.
    expect([...status.loadedAssetIds].sort()).toEqual([
      "fixture-lower",
      "fixture-roof",
      "fixture-terrain",
      "fixture-upper",
    ]);

    // 10 s rather than §13.2's 3 s: this is a headless Chromium software rasteriser on a shared
    // machine, not the target Mac mini. The measured number is recorded in docs/verification.md.
    expect(timing.readyMs).not.toBeNull();
    expect(timing.readyMs!).toBeLessThan(10_000);
    expect(timing.interactiveMs!).toBeLessThanOrEqual(timing.readyMs!);

    // The no-shared-materials guarantee: nothing had to be cloned to be coloured independently.
    const audit = await vh(page).materialAudit();
    expect(audit.length).toBe(4);
    for (const row of audit) expect(row, row.assetId).toMatchObject({ cloned: 0 });

    const render = await vh(page).renderInfo();
    expect(render.geometries).toBeGreaterThan(0);
    expect(render.textures).toBe(0);
    expect(render.programs).toBeLessThanOrEqual(4);

    await testInfo.attach("load-timing.json", {
      body: JSON.stringify({ timing, render, audit }, null, 2),
      contentType: "application/json",
    });
    console.log(
      `[house] fixture load: hook ${fmt(timing.hookMs)} ms, interactive ${fmt(timing.interactiveMs)} ms, ready ${fmt(timing.readyMs)} ms; phases ${timing.phases.join(" → ")}`,
    );
    console.log(
      `[house] renderInfo: geometries ${render.geometries}, textures ${render.textures}, programs ${render.programs}, calls ${render.calls}, triangles ${render.triangles}`,
    );
  } finally {
    await context.close();
  }
});

test("every mesh-backed surface carries its manifest defaultColor", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const status = await vh(page).status();
    const manifest = await fetchManifest(page, status.modelId!, status.fingerprint!);
    const hexes = await vh(page).allMaterialHex();

    const loaded = new Set(status.loadedAssetIds);
    const expected = new Map<string, string>();
    for (const surface of manifest.surfaces) {
      if (!surface.nodeRefs.some((ref) => loaded.has(ref.assetId))) continue;
      expected.set(surface.id, surface.defaultColor.toLowerCase());
    }

    // Every surface that reports a material must match its manifest colour, exactly. This is the
    // `baseColorFactor` ↔ `defaultColor` invariant all the way through GLTFLoader, three's colour
    // management and `applyColors`.
    for (const [surfaceId, hex] of Object.entries(hexes)) {
      expect(expected.get(surfaceId), surfaceId).toBe(hex);
    }

    // The only surfaces allowed to be absent are the mesh-less ones (the fixture has exactly one,
    // mirroring the real package's two degenerate garage bands).
    const missing = [...expected.keys()].filter((id) => !(id in hexes));
    expect(missing).toEqual(["s-e-l-ext-out-band"]);
    console.log(
      `[house] allMaterialHex: ${Object.keys(hexes).length} surfaces checked, ${missing.length} mesh-less`,
    );
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

test("selecting in the tree writes the store and the URL, and a reload restores it", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  try {
    // The property node starts expanded, so the building row is already there. Building → floor →
    // room: the tree is the non-3D route to exactly the selection the canvas produces, and each
    // click both expands the row and activates it.
    await page.getByRole("treeitem", { name: /Fixture house/ }).last().click();
    await page.getByRole("treeitem", { name: /Lower floor/ }).click();
    await page.getByRole("treeitem", { name: new RegExp(SUNKEN_ROOM.name) }).click();

    await expect
      .poll(() => vh(page).selection())
      .toEqual({ kind: "room", id: SUNKEN_ROOM.id });
    await expect(page.getByRole("heading", { name: SUNKEN_ROOM.name, level: 2 })).toBeVisible();

    // `history.replaceState`, so the selection is shareable but never enters the back stack.
    await expect.poll(() => new URL(page.url()).searchParams.get("sel")).toBe(
      `room:${SUNKEN_ROOM.id}`,
    );

    await page.reload();
    await waitForHook(page);
    await vh(page).settled();
    await expect.poll(() => vh(page).selection()).toEqual({ kind: "room", id: SUNKEN_ROOM.id });
  } finally {
    await context.close();
  }
});

test("clicking a room's floor anchor picks that room's floor at its own datum", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  try {
    // Roof and ceilings off first (the dollhouse preset also clears the active floor), then isolate
    // the floor the room is on, so the ray from the anchor reaches its floor face.
    await page.getByRole("button", { name: "Dollhouse (D)" }).click();
    await page.getByRole("button", { name: "Lower floor", exact: true }).click();
    await waitForStableFrames(page);

    const anchor = await vh(page).roomAnchor(SUNKEN_ROOM.id);
    expect(anchor, "the fixture manifest must have an anchor for this room").not.toBeNull();
    const screen = await vh(page).screenOf(anchor!);
    expect(screen).not.toBeNull();

    const hit = await vh(page).pick(screen![0], screen![1]);
    expect(hit, "the anchor's screen position must hit geometry").not.toBeNull();
    expect(hit!.surfaceId).toBe(SUNKEN_ROOM.floor);
    expect(hit!.roomId).toBe(SUNKEN_ROOM.id);
    expect(hit!.point[1]).toBeCloseTo(SUNKEN_ROOM.elevation, 2);

    // And the same point through the real pointer path: a click selects the room.
    const box = await page.locator("canvas").boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + screen![0], box!.y + screen![1]);
    await expect.poll(() => vh(page).selection()).toEqual({ kind: "room", id: SUNKEN_ROOM.id });
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// colour isolation — the highest-value check
// ---------------------------------------------------------------------------

test("a colour override touches exactly one surface, and reset puts every default back", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser, { sel: "room:r-l-a" });
  try {
    await expect(page.getByRole("heading", { name: "Room A", level: 2 })).toBeVisible();
    const before = await vh(page).allMaterialHex();

    await setSurfaceColour(page, "s-r-l-a-floor", "#ff0000");
    await expect.poll(() => vh(page).materialHex("s-r-l-a-floor")).toBe("#ff0000");

    const after = await vh(page).allMaterialHex();
    const diff = hexDiff(before, after);
    expect(diff).toEqual([
      { surfaceId: "s-r-l-a-floor", before: before["s-r-l-a-floor"], after: "#ff0000" },
    ]);

    // Reset the room: every entry is the manifest default again, so the diff closes completely.
    await page.getByRole("button", { name: "Reset room" }).click();
    await expect.poll(() => vh(page).materialHex("s-r-l-a-floor")).toBe(before["s-r-l-a-floor"]);
    expect(hexDiff(before, await vh(page).allMaterialHex())).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the two faces of one shared wall colour independently", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser, { sel: "room:r-l-a" });
  try {
    const before = await vh(page).allMaterialHex();
    expect(before[SHARED_WALL.a]).toBeDefined();
    expect(before[SHARED_WALL.b]).toBeDefined();

    await setSurfaceColour(page, SHARED_WALL.a, "#00ff00");
    await expect.poll(() => vh(page).materialHex(SHARED_WALL.a)).toBe("#00ff00");

    // The neighbour's face of the same physical wall is untouched — the property the per-surface
    // material guarantee exists for.
    expect(await vh(page).materialHex(SHARED_WALL.b)).toBe(before[SHARED_WALL.b]);
    expect(hexDiff(before, await vh(page).allMaterialHex())).toEqual([
      { surfaceId: SHARED_WALL.a, before: before[SHARED_WALL.a], after: "#00ff00" },
    ]);
  } finally {
    await context.close();
  }
});

test("selecting a room changes no material and compiles no new shader", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const before = await vh(page).allMaterialHex();
    const programsBefore = (await vh(page).renderInfo()).programs;

    await vh(page).select({ kind: "room", id: "r-l-a" });
    await waitForStableFrames(page);

    // The emissive highlight must not fight a colour override, and must not recompile.
    expect(hexDiff(before, await vh(page).allMaterialHex())).toEqual([]);
    expect((await vh(page).renderInfo()).programs).toBe(programsBefore);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// visibility and views
// ---------------------------------------------------------------------------

test("isolating a floor hides the other floor and keeps the dormer with its own", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const api = vh(page);
    expect(await api.visible("fixture-lower", "f-lower")).toBe(true);
    expect(await api.visible("fixture-upper", "f-upper")).toBe(true);

    await page.getByRole("button", { name: "Upper floor", exact: true }).click();
    await expect.poll(() => api.visible("fixture-lower", "f-lower")).toBe(false);
    expect(await api.visible("fixture-upper", "f-upper")).toBe(true);
    // The dormer lives in the roof asset but under the upper floor's node: it follows the floor.
    expect(await api.visible("fixture-roof", "f-upper")).toBe(true);
    // The roof planes themselves are floor-less roof geometry, so isolation does not show them.
    expect(await api.visible("fixture-roof", "e-roof-fx")).toBe(true);

    await page.getByRole("button", { name: "Lower floor", exact: true }).click();
    await expect.poll(() => api.visible("fixture-upper", "f-upper")).toBe(false);
    expect(await api.visible("fixture-lower", "f-lower")).toBe(true);

    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect.poll(() => api.visible("fixture-upper", "f-upper")).toBe(true);
    expect(await api.visible("fixture-lower", "f-lower")).toBe(true);
  } finally {
    await context.close();
  }
});

test("turning the ceilings off removes exactly the ceiling surfaces from the pick set", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const status = await vh(page).status();
    const manifest = await fetchManifest(page, status.modelId!, status.fingerprint!);
    const loaded = new Set(status.loadedAssetIds);
    const ceilings = manifest.surfaces.filter(
      (s) => s.kind === "ceiling" && s.nodeRefs.some((ref) => loaded.has(ref.assetId)),
    );
    expect(ceilings.length).toBeGreaterThan(0);

    const before = await vh(page).pickables();
    await page.getByRole("checkbox", { name: "Ceilings (G)" }).uncheck();
    await expect.poll(() => vh(page).pickables()).toBe(before - ceilings.length);

    await page.getByRole("checkbox", { name: "Ceilings (G)" }).check();
    await expect.poll(() => vh(page).pickables()).toBe(before);
    console.log(`[house] pickables ${before} → ${before - ceilings.length} with ceilings off`);
  } finally {
    await context.close();
  }
});

test("the orthographic and plan views switch the projection", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser);
  try {
    expect((await vh(page).camera()).projection).toBe("perspective");

    await page.getByRole("button", { name: "Orthographic" }).click();
    await expect.poll(() => vh(page).camera().then((c) => c.projection)).toBe("ortho");

    await page.getByRole("button", { name: "Orthographic" }).click();
    await expect.poll(() => vh(page).camera().then((c) => c.projection)).toBe("perspective");

    // A floor's plan view is ortho + isolation in one action.
    await page.getByRole("button", { name: "Upper floor", exact: true }).click();
    await page.getByRole("button", { name: "Plan view (P)" }).click();
    await expect.poll(() => vh(page).camera().then((c) => c.projection)).toBe("ortho");
    expect(await vh(page).visible("fixture-lower", "f-lower")).toBe(false);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// explode
// ---------------------------------------------------------------------------

test("the explode gap moves each floor by its own offset and hides split edge overlays", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const api = vh(page);
    expect(await api.worldY("fixture-upper", "f-upper")).toBeCloseTo(0, 6);
    expect(await api.visible("fixture-roof", "edges-fixture-roof")).toBe(true);

    const slider = page.getByLabel("Explode gap in metres");
    await slider.fill("3");
    await slider.dispatchEvent("input");

    // Stack order comes from the manifest: lower floor 0, upper floor 1, roof 2. `offset = order × gap`.
    await expect.poll(() => api.worldY("fixture-upper", "f-upper")).toBeCloseTo(3, 6);
    expect(await api.worldY("fixture-lower", "f-lower")).toBeCloseTo(0, 6);
    expect(await api.worldY("fixture-roof", "e-roof-fx")).toBeCloseTo(6, 6);
    // The dormer node is the upper floor's copy inside the roof asset, so it rides the upper offset.
    expect(await api.worldY("fixture-roof", "f-upper")).toBeCloseTo(3, 6);

    // `edges-<assetId>` is one object per asset and cannot be split by floor, so an asset whose
    // nodes span two explode groups hides its edges while exploded. `fixture-upper` spans one.
    expect(await api.visible("fixture-roof", "edges-fixture-roof")).toBe(false);
    expect(await api.visible("fixture-lower", "edges-fixture-lower")).toBe(false);
    expect(await api.visible("fixture-upper", "edges-fixture-upper")).toBe(true);

    await slider.fill("0");
    await slider.dispatchEvent("input");
    await expect.poll(() => api.worldY("fixture-upper", "f-upper")).toBeCloseTo(0, 6);
    expect(await api.visible("fixture-roof", "edges-fixture-roof")).toBe(true);
  } finally {
    await context.close();
  }
});

test.skip("entering edit mode zeroes the gap and the save payload is physical", async () => {
  /**
   * Not exercisable against the e2e harness, and deliberately skipped rather than faked.
   *
   * Edit mode is entered from an **equipment selection** (`E` is a no-op unless
   * `selection.kind === 'equipment'`, see `useShortcutHandlers` → `toggleEdit` in
   * `src/house/components/HouseWorkspace.tsx`), and a placement only exists once there is an
   * `asset` row plus a registered `model_revision` for the package. `tests/e2e/start-server.ts`
   * installs the fixture package but seeds no equipment and registers no revision, so
   * `listPlacements()` answers `NotPersistedError` and the workspace has nothing to edit —
   * `lastSavePayload()` can therefore never be non-null here.
   *
   * The invariants themselves are covered without a browser:
   *  - `beginEdit` sets `explode: { enabled: false, gap: 0, locked: true }` — `tests/unit/house/edit.test.ts`;
   *  - the endpoint refuses any write that is not `viewMode: "normal"` — `src/app/api/house-model/[modelId]/placements/route.ts`.
   *
   * To make this runnable, the harness would have to seed one equipment asset and call
   * `registerRevision`, which is a change to `tests/e2e/start-server.ts` (not owned by this file).
   */
});

// ---------------------------------------------------------------------------
// on-demand rendering
// ---------------------------------------------------------------------------

test("an idle workspace asks for no further frames", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  try {
    await waitForStableFrames(page);
    const idle = await idleFrames(page, 2_000);

    // The load-bearing assertion: `frameloop="demand"` means nothing may ask to render while the
    // user does nothing. A stray `invalidate()` (an animation, a subscription firing on a
    // temperature reading) shows up here as a non-zero delta.
    expect(idle.invalidateAfter).toBe(idle.invalidateBefore);

    await testInfo.attach("idle-frames.json", {
      body: JSON.stringify(idle, null, 2),
      contentType: "application/json",
    });
    console.log(
      `[house] idle ${idle.elapsedMs} ms: invalidate ${idle.invalidateBefore} → ${idle.invalidateAfter}, rAF samples ${idle.frames}, p95 ${idle.p95Ms.toFixed(1)} ms`,
    );
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// resilience
// ---------------------------------------------------------------------------

test("an asset needs the session cookie, and answers 304 to a matching ETag", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  const anonymous = await browser.newContext({
    ...deviceOptionsOfProject(),
    baseURL: e2eBaseUrl(),
    extraHTTPHeaders: { "x-forwarded-for": nextClientIp() },
  });
  try {
    const status = await vh(page).status();
    const url = `/api/house-model/${MODEL_ID}/assets/fixture-lower?v=${status.fingerprint}`;

    // Without the cookie: 401 and no bytes. Private household geometry is never public.
    const denied = await anonymous.request.get(url);
    expect(denied.status()).toBe(401);

    const ok = await page.request.get(url);
    expect(ok.status()).toBe(200);
    expect(ok.headers()["content-type"]).toBe("model/gltf-binary");
    expect(ok.headers()["cache-control"]).toContain("private");
    expect((await ok.body()).byteLength).toBeGreaterThan(0);

    const etag = ok.headers()["etag"];
    expect(etag).toBeTruthy();
    const cached = await page.request.get(url, { headers: { "if-none-match": etag! } });
    expect(cached.status()).toBe(304);
  } finally {
    await anonymous.close();
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test("leaving and re-entering the workspace disposes everything and rebuilds the same scene", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  try {
    await waitForStableFrames(page);
    const first = await vh(page).renderInfo();
    expect(first.geometries).toBeGreaterThan(0);

    // A client-side navigation, so the document (and therefore the hook) survives the unmount and
    // `disposedInfo()` is still readable.
    await page.getByRole("link", { name: "Today" }).click();
    await page.waitForURL(/\/today$/);
    await expect
      .poll(() => vh(page).disposedInfo(), { timeout: 10_000 })
      .toEqual({ geometries: 0, textures: 0 });

    await page.getByRole("link", { name: "House" }).click();
    await page.waitForURL(/\/house/);
    await waitForHook(page);
    await vh(page).settled();
    await waitForStableFrames(page);

    const second = await vh(page).renderInfo();
    expect(second.geometries).toBe(first.geometries);
    expect(second.textures).toBe(first.textures);
    console.log(
      `[house] lifecycle: geometries ${first.geometries} → 0 on unmount → ${second.geometries} on remount`,
    );
  } finally {
    await context.close();
  }
});

const fmt = (v: number | null): string => (v === null ? "n/a" : v.toFixed(0));
