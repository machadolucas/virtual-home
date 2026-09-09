import { expect, test } from "@playwright/test";
import { openHouse, waitForStableFrames } from "./helpers/house";

test("equipment occlusion hides downstairs markers and labels behind the upstairs floor", async ({ page }, testInfo) => {
  const base = { modelId: "fixture-house", rotationYDeg: 0, lightAim: null, locationNote: "", photoId: null, entityId: null, symbol: "sensor", category: "safety", linkedEntities: [], surfaceId: null };
  await page.route("**/api/house-model/fixture-house/placements*", async (route) => {
    await route.fulfill({ json: new URL(route.request().url()).searchParams.has("options") ? { placeable: [] } : { placements: [
      { ...base, id: "downstairs", equipmentId: "downstairs", name: "Downstairs test sensor", position: [1, 1, 1], floorId: "f-lower", roomId: "r-l-a", mount: { kind: "free", height: 1 } },
      { ...base, id: "upstairs", equipmentId: "upstairs", name: "Upstairs test sensor", position: [1.5, 3.2, 1], floorId: "f-upper", roomId: "r-u-a", mount: { kind: "free", height: 0.5 } },
    ], stale: [], partialFields: [] } });
  });
  await openHouse(page);
  await page.getByRole("button", { name: "Upper floor", exact: true }).click();
  await waitForStableFrames(page);
  await page.evaluate(() => window.__vh!.select({ kind: "equipment", id: "downstairs" }));
  const downstairs = page.locator('[data-placement="downstairs"]');
  const upstairs = page.locator('[data-placement="upstairs"]');
  await expect(downstairs).toBeVisible();
  await expect(upstairs).toBeVisible();
  expect(await page.evaluate(() => window.__vh!.equipmentCount())).toBe(2);
  await expect(page.locator('[data-anchor="equipment:downstairs"]:visible')).toHaveCount(1);
  if (testInfo.project.name !== "phone") await page.getByRole("tab", { name: "Layers", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Hide occluded equipment", exact: true });
  await toggle.click();
  await expect(downstairs).toBeHidden();
  await expect(upstairs).toBeVisible();
  await expect(page.locator('[data-anchor="equipment:downstairs"]:visible')).toHaveCount(0);
  await waitForStableFrames(page);
  await expect(page.getByTestId("viewer-frame-rate")).toHaveText("idle");
  const occlusionBefore = await page.evaluate(() => window.__vh!.occlusionStats());
  const before = await page.evaluate(() => window.__vh!.invalidateCount());
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__vh!.invalidateCount())).toBe(before);
  expect(await page.evaluate(() => window.__vh!.occlusionStats())).toEqual(occlusionBefore);
  await testInfo.attach("upstairs-equipment-occlusion.png", { body: await page.screenshot(), contentType: "image/png" });
  await toggle.click();
  await expect(downstairs).toBeVisible();
  await expect(page.locator('[data-anchor="equipment:downstairs"]:visible')).toHaveCount(1);
  await toggle.click();
  if (testInfo.project.name !== "phone") {
    await page.getByRole("button", { name: "Orthographic", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__vh!.camera().projection)).toBe("ortho");
    await expect(downstairs).toBeHidden();
  }
  await page.getByRole("button", { name: "Lower floor", exact: true }).click();
  await expect(downstairs).toBeVisible();
  await expect(upstairs).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__vh!.equipmentCount())).toBe(1);
  await toggle.click(); // Hidden-floor models stay hidden even with occlusion disabled.
  await expect.poll(() => page.evaluate(() => window.__vh!.equipmentCount())).toBe(1);
});
