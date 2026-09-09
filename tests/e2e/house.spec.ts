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
import { e2eBaseUrl } from "./fixtures";
import {
  clickCanvasAt,
  deviceOptionsOfProject,
  findCanvasPick,
  fetchManifest,
  hexDiff,
  houseClientIp,
  idleFrames,
  measureLoad,
  openHouseSession,
  orbitOverhead,
  setSurfaceColour,
  vh,
  waitForHook,
  waitForStableFrames,
} from "./helpers/house";
import { E2E_PLACEABLE_NAMES } from "./fixtures";

// One placeable per test: placing one consumes it, and the suite shares a database.
const [PLACE_ME, LOCK_ME, HOVER_ME] = E2E_PLACEABLE_NAMES;

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
    const manifest = await fetchManifest(page, status.modelId!, status.fingerprint!);
    const hexes = await vh(page).allMaterialHex();
    const edgeNodes = manifest.assets.filter(
      (a) => a.edgesNode && status.loadedAssetIds.includes(a.id),
    ).length;

    // One geometry per mesh-backed surface plus one edges overlay per loaded asset, and nothing
    // else: shadows reuse the same geometry, with no duplicated scene.
    expect(render.geometries).toBe(Object.keys(hexes).length + edgeNodes);
    // The package remains texture-free. The fixed 4 point / 4 spot shadow pool allocates bounded
    // depth targets (including Three's internal shadow sampler resources), plus an empty sampler.
    expect(render.textures).toBeLessThanOrEqual(13);
    // Surface, edge and shadow-depth/distance programs are a fixed inventory.
    expect(render.programs).toBeLessThanOrEqual(8);

    await testInfo.attach("load-timing.json", {
      body: JSON.stringify({ timing, render, audit, edgeNodes }, null, 2),
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
    // the floor the room is on, then orbit straight overhead with the arrow keys.
    //
    // The overhead pose is the point: from an oblique angle the ray through a room's anchor leaves
    // through a wall face, which is a *correct* pick of a different surface. Looking down, the
    // anchor resolves to the floor directly beneath it — the datum this test is about. The
    // workspace's own "Plan view (P)" would be the natural way to get there and does not work; see
    // the `test.fixme` below.
    await page.getByRole("button", { name: "Show inside (D)" }).click();
    await page.getByRole("button", { name: "Lower floor", exact: true }).click();
    await waitForStableFrames(page, 1_000);
    await orbitOverhead(page);

    const anchor = await vh(page).roomAnchor(SUNKEN_ROOM.id);
    expect(anchor, "the fixture manifest must have an anchor for this room").not.toBeNull();
    const screen = await vh(page).screenOf(anchor!);
    expect(screen).not.toBeNull();

    const hit = await vh(page).pick(screen![0], screen![1]);
    expect(hit, "the anchor's screen position must hit geometry").not.toBeNull();
    expect(hit!.surfaceId).toBe(SUNKEN_ROOM.floor);
    expect(hit!.roomId).toBe(SUNKEN_ROOM.id);
    // The room's floor sits below the floor datum, and the pick lands on *its* floor, not the
    // slab the rest of the storey shares.
    expect(hit!.point[1]).toBeCloseTo(SUNKEN_ROOM.elevation, 2);

    // The same surface through the real pointer path. The click has to be on bare canvas: the
    // label overlay owns the anchor itself (see `findCanvasPick`), and a click on the label would
    // select the room through the DOM without ever raycasting.
    const target = await findCanvasPick(
      page,
      screen!,
      (candidate) =>
        candidate.roomId === SUNKEN_ROOM.id && candidate.surfaceId === SUNKEN_ROOM.floor,
    );
    expect(target.pick.point[1]).toBeCloseTo(SUNKEN_ROOM.elevation, 2);
    await clickCanvasAt(page, target.x, target.y);
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
    // Start from the manifest defaults, so the test is independent of anything a previous run left
    // behind. (Against the plain harness nothing persists — no model revision is registered — but
    // the same file also runs against a server that has one.)
    await page.getByRole("button", { name: "Reset room" }).click();
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
    await page.getByRole("button", { name: "Reset room" }).click();
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

    // Leave no override behind, so a rerun against a reused server starts from the defaults again.
    await page.getByRole("button", { name: "Reset room" }).click();
    await expect.poll(() => vh(page).materialHex(SHARED_WALL.a)).toBe(before[SHARED_WALL.a]);
  } finally {
    await context.close();
  }
});

test("selecting a room changes no material and compiles no new shader", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const before = await vh(page).allMaterialHex();

    // The first selection also creates the outline `LineSegments` (§3.4's non-colour signal), and
    // its `LineBasicMaterial` is one new program — so the invariant §13.2 #12 is really about
    // selection *changes* once the outline exists, not about the first one.
    await vh(page).select({ kind: "room", id: "r-l-a" });
    await waitForStableFrames(page, 1_000);
    const programsAfterFirst = (await vh(page).renderInfo()).programs;

    await vh(page).select({ kind: "room", id: "r-l-b" });
    await waitForStableFrames(page, 1_000);
    await vh(page).select({ kind: "surface", id: "s-w-l-ab--r-l-a" });
    await waitForStableFrames(page, 1_000);

    // The emissive highlight is a uniform write: it can never fight a colour override…
    expect(hexDiff(before, await vh(page).allMaterialHex())).toEqual([]);
    // …and it recompiles nothing.
    expect((await vh(page).renderInfo()).programs).toBe(programsAfterFirst);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// visibility and views
// ---------------------------------------------------------------------------

test("floor focus keeps lower support and hides only higher floors in that building", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const api = vh(page);
    expect(await api.visible("fixture-lower", "f-lower")).toBe(true);
    expect(await api.visible("fixture-upper", "f-upper")).toBe(true);

    await page.getByRole("button", { name: "Upper floor", exact: true }).click();
    await expect.poll(() => api.visible("fixture-lower", "f-lower")).toBe(true);
    expect(await api.visible("fixture-upper", "f-upper")).toBe(true);
    // The dormer lives in the roof asset but under the upper floor's node: it follows the floor.
    expect(await api.visible("fixture-roof", "f-upper")).toBe(true);
    // Floor focus opens the shell for a readable top-down view.
    expect(await api.visible("fixture-roof", "e-roof-fx")).toBe(false);

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

test("wall modes open the shell, cut context without a selection, and fully close it again", async ({
  browser,
}) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const api = vh(page);
    const walls = ["s-e-l-ext--r-l-a", "s-w-l-ab--r-l-a", "s-w-l-bc--r-l-b"];
    const cutWalls = async () => {
      const rows = await Promise.all(walls.map(async (id) => ({ id, planes: await api.clipPlanes(id) })));
      return rows.filter((row) => (row.planes[2]?.constant ?? 10_000) < 1_000).map((row) => row.id);
    };

    await page.getByRole("button", { name: "Show inside (D)" }).click();
    await expect.poll(cutWalls).not.toEqual([]);
    expect(await api.visible("fixture-roof", "s-e-dormer-fx-ceiling")).toBe(false);
    expect(await api.visible("fixture-roof", "s-e-dormer-fx-wall")).toBe(true);

    await page.getByRole("radio", { name: "All cut" }).click();
    await expect.poll(cutWalls).toEqual(walls);

    await page.getByRole("radio", { name: "All up + roof/ceiling" }).click();
    await expect.poll(cutWalls).toEqual([]);
    expect(await api.visible("fixture-roof", "e-roof-fx")).toBe(true);
    expect(await api.visible("fixture-roof", "s-e-dormer-fx-ceiling")).toBe(true);
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
    const hiddenShell = manifest.surfaces.filter(
      (s) =>
        s.kind === "ceiling" &&
        s.nodeRefs.some((ref) => loaded.has(ref.assetId)),
    );
    expect(hiddenShell.length).toBeGreaterThan(0);

    const before = await vh(page).pickables();
    await page.getByRole("tab", { name: "Layers", exact: true }).click();
    await page.getByRole("switch", { name: "Ceilings (G)" }).click();
    await expect.poll(() => vh(page).pickables()).toBe(before - hiddenShell.length);

    await page.getByRole("tab", { name: "Layers", exact: true }).click();
    await page.getByRole("switch", { name: "Ceilings (G)" }).click();
    await expect.poll(() => vh(page).pickables()).toBe(before);
    console.log(`[house] pickables ${before} → ${before - hiddenShell.length} with the shell open`);
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

    // A floor shortcut is an orthographic top-down focus in one action.
    await page.getByRole("button", { name: "Upper floor", exact: true }).click();
    await expect.poll(() => vh(page).camera().then((c) => c.projection)).toBe("ortho");
    expect(await vh(page).visible("fixture-lower", "f-lower")).toBe(true);
  } finally {
    await context.close();
  }
});

test("the plan view looks straight down at the active floor", async ({ browser }) => {
  /**
   * APP BUG — two of them, both in the camera layer, neither fixed here (this suite does not edit
   * application code). Measured on this run against the fixture package, headless Chromium:
   *
   * 1. `src/house/hooks/useCameraApi.ts:132-135` — `planFor(floorId)` is only
   *    `fitBox(planBox3(...))`, and `fitBox` (same file, lines 77-98) frames with
   *    `controls.fitToBox()`, which by design fits along the **current** view direction. Nothing on
   *    the path ever rotates the polar angle to 0, so "Plan view (P)" produces an orthographic view
   *    from whatever angle the camera happened to hold. Measured: isolate the lower floor in
   *    orthographic (pose [3, 1.15, 38.28] → target [3, 1.15, 2], polar 90° — a pure side
   *    elevation), then press Plan view; the pose does not change at all. §4.2 and §13.2 #16 both
   *    require polar 0. The `minPolarAngle = maxPolarAngle = 0` lock in
   *    `src/house/components/Rig.tsx:88-108` only constrains later user input; it never moves the
   *    camera. Re-measured 2026-09-08 by running this test: the assertion below reports
   *    **polar 63.83°** where it requires < 1°.
   *
   * 2. `src/house/components/Rig.tsx:54-81` — the pose is not carried across a projection switch.
   *    `<CameraControls key={projection}>` (lines 118-126) remounts, and the capture/restore pair
   *    does not land: measured, toggling "Orthographic" from the overview pose
   *    ([19.15, 17, 20.05] → target [3.15, 3, 2.05]) leaves the camera at the freshly-mounted
   *    orthographic camera's declared default, [22, 16, 24] → target [0, 0, 0]. Because
   *    `ViewToolbar.planFor` (`src/house/components/ViewToolbar.tsx:51-56`) calls `setProjection`
   *    and then `runtime.camera?.planFor()` synchronously, the fit runs against the outgoing
   *    controls instance and is discarded — so entering the plan view from perspective (button or
   *    the `P` shortcut) lands on that same default pose, polar 63.8°.
   *
   * The projection half of both paths *is* asserted and passes, in the test above. What this test
   * would assert once the camera is fixed: polar 0 and a target over the active floor's centre.
   */
  const { context, page } = await openHouseSession(browser);
  try {
    await page.getByRole("button", { name: "Upper floor", exact: true }).click();
    await waitForStableFrames(page, 1_000);

    const camera = await vh(page).camera();
    expect(camera.projection).toBe("ortho");
    const dx = camera.position[0] - camera.target[0];
    const dy = camera.position[1] - camera.target[1];
    const dz = camera.position[2] - camera.target[2];
    const polarDeg = (Math.atan2(Math.hypot(dx, dz), dy) * 180) / Math.PI;
    expect(polarDeg).toBeLessThan(1);
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

test("equipment that is not placed yet can be placed, outdoors, from the tree panel", async ({
  browser,
}) => {
  /**
   * The flow that used to be impossible, end to end.
   *
   * Two separate bugs met here: edit mode could only be entered from an existing *placement*
   * (`E` was a no-op otherwise, and search only listed placements), so equipment imported from
   * Home Assistant was unreachable; and saving refused any point that resolved to no room, which
   * is every outdoor fixture, because the package's `rooms` are interior only.
   */
  const { context, page } = await openHouseSession(browser);
  try {
    // The panel states the count rather than hiding when there is nothing to place.
    const notPlaced = page.getByRole("button", { name: /Not placed yet/ });
    await expect(notPlaced).toBeVisible();
    await notPlaced.click();

    await page.getByRole("button", { name: `Place ${PLACE_ME} in the model` }).click();

    // Edit mode is open on a new draft. (That entering it locks the explode gap flat is asserted
    // without a browser, in tests/unit/house/edit.test.ts.)
    await expect(page.getByRole("heading", { name: "Place equipment" })).toBeVisible();

    // A point outside every room footprint: the fixture's rooms all sit within x/z 0.2–5.8.
    const inspector = page.getByRole("region", { name: "Equipment placement" });
    await inspector.getByLabel("X (m)").fill("8");
    await inspector.getByLabel("Z (m)").fill("6.5");

    await page.getByRole("button", { name: "Save placement" }).click();

    // Saved, with no room — anchored to the floor instead, and never refused.
    await expect(page.getByRole("heading", { name: "Place equipment" })).toBeHidden();
    const payload = (await vh(page).lastSavePayload()) as {
      roomId: string | null;
      floorId: string;
      position: [number, number, number];
    } | null;
    expect(payload).not.toBeNull();
    expect(payload?.roomId).toBeNull();
    expect(payload?.floorId).toBeTruthy();
    expect(payload?.position?.[0]).toBeCloseTo(8, 3);

    // And it is reachable again: the tree grows an "Outside" branch for it.
    await expect(page.getByRole("treeitem", { name: /Outside/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the place tool reserves left-drag for aiming while other navigation remains available", async ({
  browser,
}) => {
  /**
   * The complaint this fixes, verbatim: "when dragging it in the grid, the camera moves at the
   * same time".
   *
   * The cause was ordering, not intent: `camera-controls` binds its own `pointerdown` on the
   * canvas and keeps a gesture it has already captured, so disabling the controls inside the app's
   * own `pointerdown` — which is what the editor used to do — was always one handler too late.
   * Ownership is now decided by the tool, before any gesture starts.
   */
  const { context, page } = await openHouseSession(browser);
  try {
    await page.getByRole("button", { name: /Not placed yet/ }).click();
    await page.getByRole("button", { name: `Place ${LOCK_ME} in the model` }).click();
    await expect(page.getByRole("heading", { name: "Place equipment" })).toBeVisible();

    // Entering the editor takes the camera off the left button.
    await expect(page.getByRole("radio", { name: /^Place \(M\)/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // The camera glides after any programmatic move (`smoothTime` 0.25), so settle first:
    // otherwise this measures the tail of the last animation rather than the drag.
    const settled = async () => {
      let previous = await vh(page).camera();
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(100);
        const next = await vh(page).camera();
        const still = ([0, 1, 2] as const).every(
          (axis) => Math.abs(next.position[axis] - previous.position[axis]) < 1e-4,
        );
        if (still) return next;
        previous = next;
      }
      return previous;
    };

    const before = await settled();
    const canvas = page.locator("canvas").first();
    const box = (await canvas.boundingBox())!;

    // A real drag across the middle of the view — the gesture that used to spin the house.
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45, { steps: 12 });
    await page.mouse.up();

    // The mechanism, asserted directly: the camera does not hold the left button, while the
    // controls instance keeps wheel zoom and right-button trucking available.
    expect(await vh(page).controlsEnabled()).toBe(false);
    const bindings = await vh(page).controlBindings();
    expect(bindings?.left).toBe(0); // CameraControls.ACTION.NONE
    expect(bindings?.right).not.toBe(0);
    expect(bindings?.wheel).not.toBe(0);

    const after = await vh(page).camera();
    for (const axis of [0, 1, 2] as const) {
      // A 2 cm tolerance on a 25 m camera distance: this is "did not orbit", not "did not move a
      // float", so it cannot be defeated by the smoothing tail.
      expect(Math.abs(after.position[axis] - before.position[axis])).toBeLessThan(0.02);
      expect(Math.abs(after.target[axis] - before.target[axis])).toBeLessThan(0.02);
    }

    // Holding Space hands the camera back, so the tool is never a dead end.
    await page.keyboard.down("Space");
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up("Space");

    expect(await vh(page).controlsEnabled()).toBe(false); // left button released again on key-up

    const orbited = await vh(page).camera();
    const moved = ([0, 1, 2] as const).some(
      (axis) => Math.abs(orbited.position[axis] - before.position[axis]) > 0.1,
    );
    expect(moved).toBe(true);
  } finally {
    await context.close();
  }
});

test("aiming shows the position on hover, before anything is clicked", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser);
  try {
    await page.getByRole("button", { name: /Not placed yet/ }).click();
    await page.getByRole("button", { name: `Place ${HOVER_ME} in the model` }).click();

    const canvas = page.locator("canvas").first();
    const box = (await canvas.boundingBox())!;
    // No button pressed: the readout used to appear only once a drag was under way, so the only
    // way to find out where a click would land was to click.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const readout = page.getByLabel("Placement preview", { exact: true });
    await expect(readout).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// on-demand rendering
// ---------------------------------------------------------------------------

test("an idle workspace asks for no further frames", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  try {
    // A full second of stability first: the last frame of the opening camera transition lands
    // about 1.7 s after `settled`, and that tail is not what this test is about.
    await waitForStableFrames(page, 1_000);
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
    extraHTTPHeaders: { "x-forwarded-for": houseClientIp() },
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
