/**
 * The §13.4 screenshot set, captured against the synthetic fixture package.
 *
 * These are a **regression aid reviewed by eye**, not an automated pass/fail gate: a software-
 * rasterised headless render is not the target machine's GPU, so there is no pixel comparison here.
 * What the suite does guarantee is that each capture is of a fully-resolved scene — every shot
 * waits for `__vh.settled` and then for `invalidateCount()` to hold still for 250 ms, so
 * `frameloop="demand"` cannot hand back a half-drawn frame.
 *
 * Files land in `test-results/screenshots/<name>.png` (git-ignored — the real package's geometry
 * must never reach this repository, and neither must a render of it).
 *
 * Several entries on the §13.4 list need data or geometry the e2e harness does not have (equipment
 * placements, infrastructure routes, a Home Assistant connection, a garage or a structure asset in
 * the fixture). Those are skipped individually, each with the reason, rather than quietly dropped.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { e2eBaseUrl, login } from "./fixtures";
import {
  deviceOptionsOfProject,
  houseClientIp,
  openHouse,
  openHouseSession,
  setSurfaceColour,
  vh,
  waitForStableFrames,
} from "./helpers/house";

const OUT_DIR = path.resolve(__dirname, "../../test-results/screenshots");


test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

/** Capture the viewport once the scene has stopped asking for frames. */
async function capture(page: Page, name: string): Promise<void> {
  await waitForStableFrames(page, 250);
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  expect(fs.statSync(file).size).toBeGreaterThan(1_000);
  console.log(`[screenshots] ${name}.png`);
}

// ---------------------------------------------------------------------------
// desktop, 1600 × 1000, dpr 1
// ---------------------------------------------------------------------------

test.describe("desktop scenes", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "3D scenes are captured on the desktop project");
  });

  test("01 property overview", async ({ browser }) => {
    const { context, page } = await openHouseSession(browser);
    try {
      await page.getByRole("button", { name: "Overview (R)" }).click();
      await capture(page, "01-property-overview");
    } finally {
      await context.close();
    }
  });

  test("02–04 dollhouse and floor isolation", async ({ browser }) => {
    const { context, page } = await openHouseSession(browser);
    try {
      // 2. Dollhouse, lower floor (the fixture's analogue of the ground floor).
      await page.getByRole("button", { name: "Dollhouse (D)" }).click();
      await page.getByRole("button", { name: "Lower floor", exact: true }).click();
      await capture(page, "02-dollhouse-lower-floor");

      // 3. Dollhouse, upper floor.
      await page.getByRole("button", { name: "Upper floor", exact: true }).click();
      await capture(page, "03-dollhouse-upper-floor");

      // 4. Floor isolation in perspective, roof and ceilings back on.
      await page.getByRole("button", { name: "Overview (R)" }).click();
      await page.getByRole("button", { name: "Upper floor", exact: true }).click();
      await capture(page, "04-floor-isolation-upper-perspective");
    } finally {
      await context.close();
    }
  });

  test("05–07 plan views and the section cuts", async ({ browser }) => {
    const { context, page } = await openHouseSession(browser);
    try {
      const region = page.getByRole("application", { name: "House 3D view" });

      // 5. Top-down ortho plan of the lower floor with a horizontal cut. `S` puts the cut 1.2 m
      // above the active floor's own elevation rather than at a hard-coded height, so the same
      // action is meaningful for any package.
      await page.getByRole("button", { name: "Lower floor", exact: true }).click();
      await page.getByRole("button", { name: "Plan view (P)" }).click();
      await region.press("s");
      await capture(page, "05-plan-lower-floor-cut");

      // 6. The same for the upper floor; its cut follows its own datum.
      await region.press("s");
      await page.getByRole("button", { name: "Upper floor", exact: true }).click();
      await page.getByRole("button", { name: "Plan view (P)" }).click();
      await region.press("s");
      await capture(page, "06-plan-upper-floor-cut");

      // 7. A vertical section. The X midpoint comes from the manifest bounds.
      await page.getByRole("button", { name: "Overview (R)" }).click();
      await page.getByRole("button", { name: "Cut along X" }).click();
      await capture(page, "07-section-vertical-x");
    } finally {
      await context.close();
    }
  });

  test("08 exploded floors", async ({ browser }) => {
    const { context, page } = await openHouseSession(browser);
    try {
      // The toggle, not the slider: the gap already sits at `DEFAULT_EXPLODE_GAP` (2.5 m), so
      // filling the range with 2.5 changes no value and therefore fires no `input` event.
      await page.getByRole("button", { name: /^(On|Off) \(X\)$/ }).click();
      await expect.poll(() => vh(page).worldY("fixture-upper", "f-upper")).toBeCloseTo(2.5, 6);
      await capture(page, "08-exploded-floors-2.5m");
    } finally {
      await context.close();
    }
  });

  test.skip("09 garage isolated with the roof off", () => {
    /**
     * The fixture package has one building with two floors and no garage (`f-garage` exists only in
     * the household's own package), so there is nothing to isolate. Capturing this needs
     * `VH_REAL_MODEL_DIR`, and a render of the real house must not be written by a default run.
     */
  });

  test("10–11 selection and a colour override", async ({ browser }) => {
    const { context, page } = await openHouseSession(browser, { sel: "room:r-l-a" });
    try {
      // 10. Room selected, inspector open, highlight and outline visible.
      await expect(page.getByRole("heading", { name: "Room A", level: 2 })).toBeVisible();
      await capture(page, "10-room-selected-inspector");

      // 11. One surface recoloured; the neighbouring room's faces are visibly unchanged.
      await page.getByRole("button", { name: "Reset room" }).click();
      await setSurfaceColour(page, "s-r-l-a-floor", "#c2185b");
      await expect.poll(() => vh(page).materialHex("s-r-l-a-floor")).toBe("#c2185b");
      await capture(page, "11-colour-override-one-room");
      // Leave the defaults behind for the next run.
      await page.getByRole("button", { name: "Reset room" }).click();
    } finally {
      await context.close();
    }
  });

  test.skip("12 equipment layer at semantic-zoom tier C", () => {
    /**
     * Needs at least one `asset_placement` row, which needs an equipment asset and a registered
     * `model_revision`. `tests/e2e/start-server.ts` seeds neither, so the equipment layer has
     * nothing to draw and there are no clustering badges to show.
     */
  });

  test.skip("13 ventilation and water layers with mixed certainty", () => {
    /**
     * Needs stored infrastructure routes. The harness registers no model revision, so
     * `listRoutes()` answers `NotPersistedError` and the routes layer is empty.
     */
  });

  test.skip("14 edit mode with the wall snap and the numeric fields", () => {
    /**
     * Edit mode is entered from an equipment selection (`toggleEdit` in
     * `src/house/components/HouseWorkspace.tsx` returns early unless `selection.kind === 'equipment'`),
     * and the harness has no placements. Same root cause as 12.
     */
  });

  test.skip("15 the 2D plan route editor", () => {
    /**
     * The route editors open from `beginRouteDraft(route)` on an existing route
     * (`src/house/components/inspector/RouteInspector.tsx`), so they need the stored routes that
     * 13 also needs.
     */
  });

  test.skip("16 the wall-elevation route editor", () => {
    /** Same as 15: it needs a route draft, and a wall surface selected inside it. */
  });

  test.skip("17 the structure layer with the edges on", () => {
    /**
     * The fixture package has no structure asset (no trusses or footings), so switching the layer
     * on loads nothing and the capture would be identical to 01.
     */
  });

  test("18 scan reference on", async ({ browser }) => {
    const { context, page } = await openHouseSession(browser);
    try {
      // The one opt-in asset the fixture does have: `fixture-scan`, `loadByDefault: false`.
      await page.getByRole("checkbox", { name: "Scan reference" }).check();
      await expect
        .poll(() => vh(page).status().then((s) => s.loadedAssetIds.includes("fixture-scan")), {
          timeout: 30_000,
        })
        .toBe(true);
      await capture(page, "18-scan-reference-on");
    } finally {
      await context.close();
    }
  });

  test("19 a missing asset degrades the workspace", async ({ browser }) => {
    const context = await browser.newContext({
      ...deviceOptionsOfProject(),
      baseURL: e2eBaseUrl(),
      extraHTTPHeaders: { "x-forwarded-for": houseClientIp() },
    });
    try {
      const page = await context.newPage();
      // Route-level fault injection: one asset 404s, the rest load.
      await page.route("**/api/house-model/*/assets/fixture-upper*", (route) =>
        route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' }),
      );
      await openHouse(page, {});

      const status = await vh(page).status();
      expect(status.phase).toBe("degraded");
      expect(status.failedAssetIds).toEqual(["fixture-upper"]);
      await capture(page, "19-degraded-missing-asset");
    } finally {
      await context.close();
    }
  });

  test("20 an invalid manifest is a setup state, not a crash", async ({ browser }) => {
    const context = await browser.newContext({
      ...deviceOptionsOfProject(),
      baseURL: e2eBaseUrl(),
      extraHTTPHeaders: { "x-forwarded-for": houseClientIp() },
    });
    try {
      const page = await context.newPage();
      // Serve a manifest with `rooms` dropped: the zod schema must reject it by path.
      await page.route("**/api/house-model/*/manifest*", async (route) => {
        const response = await route.fetch();
        const manifest = (await response.json()) as Record<string, unknown>;
        delete manifest["rooms"];
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify(manifest),
        });
      });

      // Deliberately **not** `openHouse()`: a fatal package short-circuits `WorkspaceBody` to
      // `<SetupState>` before the canvas mounts, so `window.__vh` is never installed. That is the
      // behaviour under test — the failure is contained, not instrumented.
      await login(page, "lucas", { next: "/house", expectPath: "/house" });
      await expect(
        page.getByRole("heading", { name: "The house model needs attention", level: 2 }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "manifest_invalid", level: 3 })).toBeVisible();
      // The zod issue path, so the user is told *which* field is wrong.
      await expect(page.getByText(/rooms/).first()).toBeVisible();

      const file = path.join(OUT_DIR, "20-setup-state-invalid-manifest.png");
      await page.screenshot({ path: file, animations: "disabled" });
      expect(fs.statSync(file).size).toBeGreaterThan(1_000);
      console.log("[screenshots] 20-setup-state-invalid-manifest.png");

      // Containment: the rest of the app still works with a broken package.
      await page.getByRole("link", { name: "Today" }).click();
      await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test.skip("21 the Home Assistant disconnected banner", () => {
    /**
     * `HA_URL`/`HA_TOKEN` are deliberately blank in the e2e server (`tests/e2e/start-server.ts`) so
     * a run can never reach a real house, and the SSE layer only connects when a placement links an
     * entity. With no placements there are no markers to style `unavailable` or `stale`.
     */
  });

  test("22 reduced-motion run of 04", async ({ browser }) => {
    const context = await browser.newContext({
      ...deviceOptionsOfProject(),
      baseURL: e2eBaseUrl(),
      extraHTTPHeaders: { "x-forwarded-for": houseClientIp() },
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      await openHouse(page, {});
      await page.getByRole("button", { name: "Upper floor", exact: true }).click();
      // Same framing as 04, with instant camera cuts instead of transitions.
      await capture(page, "22-floor-isolation-upper-reduced-motion");
    } finally {
      await context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// phone, 390 × 844
// ---------------------------------------------------------------------------

test.describe("phone scenes", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone scenes are captured on the phone project");
  });

  test.skip("23 task detail with the Locate card collapsed", () => {
    /**
     * Needs a seeded maintenance task; the e2e bootstrap seeds only the two user accounts and the
     * model package, and the task pages are outside this suite's scope.
     */
  });

  test("24 phone house view", async ({ browser }) => {
    const { context, page } = await openHouseSession(browser);
    try {
      // On a phone the workspace takes its `PhoneHouse` branch: single column, the 3D view demoted
      // to context, and the written note plus the photo carrying the actual locating.
      await expect(page.getByRole("heading", { name: "Fixture house", level: 1 })).toBeVisible();
      await capture(page, "24-phone-house-plan");

      // Isolating a floor from the phone's floor chips is the same store write as the desktop's.
      // Numbered `24b` deliberately: it is a second view of §13.4 #24, not §13.4 #25 (which is a
      // Locate-mode capture needing a placement and a close-up photo — skipped below).
      await page.getByRole("button", { name: "Lower floor", exact: true }).click();
      await capture(page, "24b-phone-house-floor-isolated");
    } finally {
      await context.close();
    }
  });

  test.skip("25 locate mode scrolled to the location note and close-up photo", () => {
    /**
     * Needs an `asset_placement` with a location note and a close-up photo attachment, which needs
     * an equipment asset and a registered `model_revision`; the bootstrap seeds neither. Same root
     * cause as 23 and 26–28.
     */
  });

  test.skip("26 equipment inspector with battery and linked task", () => {
    /** Needs a placement with an `asset_ha_link`; the harness has neither. */
  });

  test.skip("27 the numeric placement sheet", () => {
    /** Needs a placement to edit — same root cause as 26. */
  });

  test.skip("28 supplies list reached from a task", () => {
    /**
     * Needs a seeded task and its supply links. The non-3D path this proves is exercised instead by
     * the property tree and the colour list in `house.spec.ts`.
     */
  });
});
