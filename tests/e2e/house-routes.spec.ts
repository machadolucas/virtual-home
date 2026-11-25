import { expect, test } from "@playwright/test";
import { idleFrames, openHouse, openHouseSession, openViewSection, vh, waitForHook, waitForStableFrames } from "./helpers/house";
import type { Route } from "@/house/model/types";

const MODEL_ID = "fixture-house";

test("route editing previews, crosses floors, persists, and filters by infrastructure type", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name.includes("phone"), "desktop route editing is read-only on phones");
  const { context, page } = await openHouseSession(browser, { serviceWorkers: "block" });
  let stored: Route & { medium: "cold_water" } = {
    id: "route-ux",
    modelId: MODEL_ID,
    name: "Cross-floor water",
    system: "water",
    kind: "pipe",
    medium: "cold_water",
    points: [[1, 0.4, 1], [2, 0.4, 1]] as Array<[number, number, number]>,
    pointPlaces: [
      { floorId: "f-lower", roomId: "r-l-a" },
      { floorId: "f-lower", roomId: "r-l-a" },
    ],
    segments: [{ floorId: "f-lower", roomId: "r-l-a" }],
    certainty: "measured",
    lifecycle: "installed",
    endpoints: [],
    photoIds: [],
  };

  try {
    await context.route(`**/api/house-model/${MODEL_ID}/routes`, async (intercept) => {
      if (intercept.request().method() === "GET") {
        await intercept.fulfill({ json: { routes: [stored], stale: [], partialFields: [] } });
        return;
      }
      const body = (await intercept.request().postDataJSON()) as {
        route: {
          points: Array<{
            position: [number, number, number];
            floorId: string | null;
            roomId: string | null;
          }>;
        };
      };
      const pointPlaces = body.route.points.map(({ floorId, roomId }) => ({ floorId, roomId }));
      stored = {
        ...stored,
        points: body.route.points.map((point) => point.position),
        pointPlaces,
        segments: pointPlaces.slice(0, -1),
      };
      await intercept.fulfill({ json: { route: stored } });
    });

    await page.reload();
    await waitForHook(page);
    await vh(page).settled();
    await page.getByRole("searchbox",{name:"Search the property"}).fill(stored.name);
    await page.getByRole("list",{name:"House items"}).getByRole("button",{name:new RegExp(`^${stored.name}`)}).click();
    await page.getByRole("searchbox",{name:"Search the property"}).clear();
    await page.getByRole("button", { name: "Edit path" }).click();

    expect(await vh(page).eval(({ hook }) => hook.routeGuides())).toEqual({
      pathSegments: 1,
      hoverSegments: 0,
    });
    const beforeHover = await vh(page).eval(({ hook }) => hook.routeDraft());
    const plan = page.getByRole("img", { name: "Plan of Lower floor" });
    await plan.hover({ position: { x: 120, y: 80 } });
    await expect.poll(() => vh(page).eval(({ hook }) => hook.routeGuides())).toMatchObject({
      pathSegments: 1,
      hoverSegments: 1,
    });
    const duringHover = await vh(page).eval(({ hook }) => hook.routeDraft());
    expect(duringHover?.points).toEqual(beforeHover?.points);
    expect(duringHover?.hover).not.toBeNull();

    const floorPicker = page.getByRole("combobox", { name: "Continue on another floor", exact: true });
    await floorPicker.click();
    await page.getByRole("option", { name: "Upper floor" }).click();
    await page.getByRole("button", { name: "Add vertical riser" }).click();
    const crossed = await vh(page).eval(({ hook }) => hook.routeDraft());
    expect(crossed?.points).toHaveLength(3);
    expect(crossed?.pointPlaces.at(-1)?.floorId).toBe("f-upper");
    await testInfo.attach("multi-floor-route-editor", { body: await page.screenshot(), contentType: "image/png" });

    await page.getByRole("button", { name: "Save path" }).click();
    await expect.poll(() => vh(page).eval(({ hook }) => hook.routeDraft())).toBeNull();
    await page.reload();
    await waitForHook(page);
    await vh(page).settled();
    await page.getByRole("searchbox",{name:"Search the property"}).fill(stored.name);
    await page.getByRole("list",{name:"House items"}).getByRole("button",{name:new RegExp(`^${stored.name}`)}).click();
    await page.getByRole("searchbox",{name:"Search the property"}).clear();
    await page.getByRole("button", { name: "Edit path" }).click();
    expect((await vh(page).eval(({ hook }) => hook.routeDraft()))?.pointPlaces.at(-1)?.floorId).toBe("f-upper");
    await page.getByRole("button", { name: "Cancel path edit" }).click();

    await page.getByRole("button", { name: "View",exact:true }).click();
    await expect.poll(() => vh(page).eval(({ hook }) => hook.routeSegments())).toBeGreaterThan(0);
    await page.getByRole("switch", { name: "Pipes", exact: true }).click();
    await expect.poll(() => vh(page).eval(({ hook }) => hook.routeSegments())).toBe(0);
    await expect(page.getByRole("switch", { name: "Ducts", exact: true })).toBeChecked();
  } finally {
    await context.close();
  }
});


test("documented direction animates and can return to demand idle", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (/shader error|VALIDATE_STATUS|error compiling|linkProgram/i.test(message.text()))
      errors.push(message.text());
  });
  const places = [
    { floorId: "f-lower", roomId: "r-l-a" },
    { floorId: "f-lower", roomId: "r-l-a" },
  ];
  const route: Route = {
    id: "flow-e2e",
    modelId: MODEL_ID,
    name: "Example supply duct",
    system: "ventilation",
    medium: "supply_air",
    kind: "duct",
    points: [[1, 0.4, 1], [3, 0.4, 1], [3, 0.4, 2]],
    segments: places,
    certainty: "observed",
    lifecycle: "installed",
    flowDirection: "reverse",
    flowBasis: "declared",
    flowState: "active",
    diameterM: 0.125,
    endpoints: [],
    photoIds: [],
  };
  const routes: Route[] = [
    route,
    { ...route, id: "flow-intake", airStream: "outdoor_intake", points: [[1, 0.4, 1.4], [3, 0.4, 1.4]] },
    { ...route, id: "flow-extract", medium: "extract_air", points: [[1, 0.4, 1.8], [3, 0.4, 1.8]] },
    { ...route, id: "flow-exhaust", medium: "extract_air", airStream: "outdoor_discharge",
      points: [[1, 0.4, 2.2], [3, 0.4, 2.2]] },
  ];
  await page.route(`**/api/house-model/${MODEL_ID}/routes`, (intercept) =>
    intercept.fulfill({ json: { routes, stale: [], partialFields: [] } }));
  await openHouse(page, { serviceWorkers: "block" });
  await expect.poll(() => vh(page).eval(({ hook }) => hook.routeSegments())).toBe(5);
  await openViewSection(page, "Visibility");
  const legend = page.getByRole("list", { name: "Air streams" });
  await expect(legend.getByRole("listitem")).toHaveText(["Outdoor air intake", "Room supply", "Room extract", "Outdoor exhaust"]);
  const materials = await vh(page).eval(({ hook }) => hook.airRouteMaterials());
  expect(materials).toHaveLength(4);
  expect(materials).toEqual(expect.arrayContaining([
    expect.objectContaining({ airStream: "outdoor_intake", colorHex: "#00b9bb", pulseHex: "#a2faf2" }),
    expect.objectContaining({ airStream: "room_supply", colorHex: "#63a63c", pulseHex: "#cafa83" }),
    expect.objectContaining({ airStream: "room_extract", colorHex: "#c8861b", pulseHex: "#ffe08a" }),
    expect.objectContaining({ airStream: "outdoor_discharge", colorHex: "#8759c7", pulseHex: "#dcc4ff" }),
  ]));
  const ducts = page.getByRole("switch", { name: "Ducts", exact: true });
  await ducts.click();
  await expect(legend).toHaveCount(0);
  await ducts.click();
  await expect(legend).toBeVisible();
  const flow = page.getByRole("checkbox", { name: "Animate documented direction" });
  await expect(flow).toBeChecked();
  const moving = await idleFrames(page, 500);
  expect(moving.invalidateAfter).toBeGreaterThan(moving.invalidateBefore);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(flow).toBeDisabled();
  await waitForStableFrames(page);
  const reduced = await idleFrames(page, 500);
  expect(reduced.invalidateAfter).toBe(reduced.invalidateBefore);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(flow).toBeChecked();
  await flow.uncheck();
  await waitForStableFrames(page);
  const paused = await idleFrames(page, 500);
  expect(paused.invalidateAfter).toBe(paused.invalidateBefore);
  expect(errors).toEqual([]);
});


test("active pipe and duct scope composes with independent kind and system switches", async ({ page }) => {
  const base: Route = {
    id: "active-pipe",
    modelId: MODEL_ID,
    name: "In-service water pipe",
    system: "water",
    kind: "pipe",
    medium: "cold_water",
    points: [[1, 0.4, 1], [2, 0.4, 1]],
    segments: [{ floorId: "f-lower", roomId: "r-l-a" }],
    certainty: "inferred",
    lifecycle: "installed",
    flowState: "active",
    flowDirection: "unknown",
    flowBasis: "unknown",
    endpoints: [],
    photoIds: [],
  };
  const routes: Route[] = [
    base,
    { ...base, id: "active-duct", name: "In-service test duct", kind: "duct", system: "ventilation", medium: "supply_air" },
    { ...base, id: "retained", name: "Retained test water pipe", flowState: "inactive" },
    { ...base, id: "legacy", name: "Legacy test pipe", flowState: undefined },
    { ...base, id: "unknown", name: "Test pipe with unknown service", flowState: "unknown" },
    { ...base, id: "historical", name: "Historical test heating route", system: "heating", medium: "heating_water", lifecycle: "planned" },
    { ...base, id: "removed", name: "Removed test pipe", lifecycle: "removed" },
    { ...base, id: "cable", name: "In-service test cable", kind: "cable", system: "electrical", medium: "electricity" },
  ];
  await page.route(`**/api/house-model/${MODEL_ID}/routes`, (intercept) =>
    intercept.fulfill({ json: { routes, stale: [], partialFields: [] } }));
  await openHouse(page, { serviceWorkers: "block" });
  await openViewSection(page, "Visibility");
  const count = () => vh(page).eval(({ hook }) => hook.routeSegments());
  const active = page.getByRole("switch", { name: "Active pipes and ducts only", exact: true });
  const pipes = page.getByRole("switch", { name: "Pipes", exact: true });
  const ducts = page.getByRole("switch", { name: "Ducts", exact: true });
  const water = page.getByRole("checkbox", { name: "Water", exact: true });
  const heating = page.getByRole("checkbox", { name: "Heating", exact: true });

  await expect.poll(count).toBe(7);
  await expect(heating).toBeVisible();
  await active.click();
  await expect.poll(count).toBe(2);
  await expect(heating).toHaveCount(0);
  await pipes.click();
  await expect.poll(count).toBe(1);
  await ducts.click();
  await expect.poll(count).toBe(0);
  await pipes.click();
  await expect.poll(count).toBe(1);
  await water.uncheck();
  await expect.poll(count).toBe(0);
  await water.check();
  await expect.poll(count).toBe(1);

  await active.click();
  await expect(ducts).not.toBeChecked();
  await expect(heating).toBeVisible();
  await expect.poll(count).toBe(6);

  await active.click();
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search the property" }).fill("Retained test water pipe");
  await page.getByRole("list", { name: "House items" })
    .getByRole("button", { name: /^Retained test water pipe/ }).click();
  await expect(page.getByText("hidden by view settings", { exact: true })).toBeVisible();
});
