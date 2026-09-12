import { expect, test } from "@playwright/test";
import { openHouseSession, vh, waitForHook } from "./helpers/house";
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
    await vh(page).select({ kind: "route", id: stored.id });
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
    await vh(page).select({ kind: "route", id: stored.id });
    await page.getByRole("button", { name: "Edit path" }).click();
    expect((await vh(page).eval(({ hook }) => hook.routeDraft()))?.pointPlaces.at(-1)?.floorId).toBe("f-upper");
    await page.getByRole("button", { name: "Cancel path edit" }).click();

    await page.getByRole("tab", { name: "Layers" }).click();
    await expect.poll(() => vh(page).eval(({ hook }) => hook.routeSegments())).toBeGreaterThan(0);
    await page.getByRole("switch", { name: "Pipes" }).click();
    await expect.poll(() => vh(page).eval(({ hook }) => hook.routeSegments())).toBe(0);
    await expect(page.getByRole("switch", { name: "Ducts" })).toBeChecked();
  } finally {
    await context.close();
  }
});
