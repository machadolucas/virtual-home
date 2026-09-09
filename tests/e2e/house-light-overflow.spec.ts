import { expect, test } from "@playwright/test";
import { openHouse, waitForStableFrames } from "./helpers/house";
import { emitHaBatch, installSyntheticHa, openSyntheticHa } from "./helpers/liveHa";

test("all active lights remain represented without camera-dependent slot swapping", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Camera rotation and shader validation in the desktop scene.");
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await installSyntheticHa(page);
  const placements = Array.from({ length: 10 }, (_, i) => ({
    id: `lamp-${i}`, modelId: "fixture-house", equipmentId: `lamp-${i}`, name: `Test lamp ${i}`,
    position: [0.6 + (i % 5) * 0.4, 2.25, 0.7 + Math.floor(i / 5)], rotationYDeg: 0,
    lightAim: null, mount: { kind: "free", height: 2.25 }, floorId: "f-lower", roomId: "r-l-a", surfaceId: null,
    locationNote: "", photoId: null, entityId: `light.test_${i}`, symbol: "ceiling_lamp", category: "electrical", linkedEntities: [],
  }));
  await page.route("**/api/house-model/fixture-house/placements*", async (route) => {
    await route.fulfill({ json: new URL(route.request().url()).searchParams.has("options") ? { placeable: [] } : { placements, stale: [], partialFields: [] } });
  });
  await openHouse(page, { sel: "room:r-l-a" });
  await openSyntheticHa(page);
  await emitHaBatch(page, placements.map((p) => ({ topic: "ha.state", key: p.entityId, payload: { state: "on", attributes: { brightness: 180 }, lastUpdated: Date.now() } })));
  await expect.poll(() => page.evaluate(() => window.__vh!.renderedLights().filter((l) => l.intensity > 0).length)).toBe(10);
  await waitForStableFrames(page, 900);
  const before = await page.evaluate(() => window.__vh!.renderedLights());
  expect(before.filter((l) => l.castShadow).length).toBeLessThanOrEqual(4);
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35, { steps: 24 });
  await page.mouse.up();
  await waitForStableFrames(page, 900);
  const after = await page.evaluate(() => window.__vh!.renderedLights());
  expect(after.map((l) => l.id).sort()).toEqual(before.map((l) => l.id).sort());
  expect(after.filter((l) => l.castShadow).map((l) => l.id).sort()).toEqual(before.filter((l) => l.castShadow).map((l) => l.id).sort());
  expect(after.every((l) => l.intensity > 0)).toBe(true);
  expect(errors.filter((error) => /THREE|shader|WebGL/i.test(error))).toEqual([]);
  await testInfo.attach("all-lights-on.png", { body: await page.screenshot(), contentType: "image/png" });
  await expect(page.getByTestId("viewer-frame-rate")).toHaveText("idle");
});
