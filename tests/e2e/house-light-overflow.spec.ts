import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { openHouse, openRenderingCategory, waitForStableFrames } from "./helpers/house";
import { emitHaBatch, installSyntheticHa, openSyntheticHa } from "./helpers/liveHa";

test("all active lights remain represented without camera-dependent slot swapping", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Camera rotation and shader validation in the desktop scene.");
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await installSyntheticHa(page);
  const placements = Array.from({ length: 40 }, (_, i) => ({
    id: `lamp-${i}`, modelId: "fixture-house", equipmentId: `lamp-${i}`, name: `Test lamp ${i}`,
    position: [0.6 + (i % 4) * 0.5, 2.25, 0.5 + Math.floor(i / 4) * 0.2], rotationYDeg: 0,
    lightAim: null, mount: { kind: "free", height: 2.25 }, floorId: "f-lower", roomId: "r-l-a", surfaceId: null,
    locationNote: "", photoId: null, entityId: `light.test_${i}`, symbol: i % 2 === 0 ? "ceiling_lamp" : "downlight", category: "electrical", linkedEntities: [],
  }));
  await page.route("**/api/house-model/fixture-house/placements*", async (route) => {
    await route.fulfill({ json: new URL(route.request().url()).searchParams.has("options") ? { placeable: [] } : { placements, stale: [], partialFields: [] } });
  });
  await openHouse(page, { sel: "room:r-l-a" });
  await openRenderingCategory(page, "Light");
  await page.getByRole("switch", { name: "Batched lighting", exact: true }).click();
  const legacySlider = page.getByRole("slider", { name: "Detailed lights", exact: true });
  await legacySlider.fill(String(Math.min(16, Number(await legacySlider.getAttribute("max")))));
  await openSyntheticHa(page);
  await emitHaBatch(page, placements.map((p) => ({ topic: "ha.state", key: p.entityId, payload: { state: "on", attributes: { brightness: 180 }, lastUpdated: Date.now() } })));
  await expect.poll(() => page.evaluate(() => window.__vh!.renderedLights().filter((l) => l.intensity > 0).length)).toBe(40);
  await waitForStableFrames(page, 900);
  const before = await page.evaluate(() => window.__vh!.renderedLights());
  await openRenderingCategory(page, "Light");
  const limit = page.getByRole("slider", { name: "Detailed lights", exact: true });
  const maximum = Number(await limit.getAttribute("max"));
  expect(before.filter((l) => l.castShadow).length).toBe(Math.min(16, maximum));
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
  await limit.fill("0");
  await waitForStableFrames(page, 900);
  expect(await page.evaluate(() => window.__vh!.renderedLights().filter((l) => l.castShadow).length)).toBe(0);
  await page.getByRole("button", { name: "Use recommended", exact: true }).click();
  await waitForStableFrames(page, 900);
  expect(await page.evaluate(() => window.__vh!.renderedLights().filter((l) => l.castShadow).length)).toBe(Math.min(40, maximum));
  expect(errors.filter((error) => /THREE|shader|WebGL/i.test(error))).toEqual([]);
  const baselineImage = await canvas.screenshot();
  await testInfo.attach("baseline.png", { body: baselineImage, contentType: "image/png" });
  const baseline = await sharp(baselineImage).removeAlpha().raw().toBuffer();
  const textureUnits = await canvas.evaluate((element) => {
    const gl = (element as HTMLCanvasElement).getContext("webgl2")!;
    return gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
  });
  await page.getByRole("switch", { name: "Try higher limits", exact: true }).click();
  await expect(limit).toHaveAttribute("max", "64");
  await limit.fill("64");
  await waitForStableFrames(page, 900);
  const rejected = await page.getByRole("alert").filter({ hasText: "WebGL rejected" }).isVisible();
  if (textureUnits < 41) expect(rejected).toBe(true);
  await testInfo.attach("light-trial.json", { body: JSON.stringify({ textureUnits, recommended: maximum, rejected }), contentType: "application/json" });
  if (rejected) {
    await expect(limit).toHaveValue(String(maximum));
    expect(await page.evaluate(() => window.__vh!.renderedLights().filter((l) => l.castShadow).length)).toBe(Math.min(40, maximum));
    // Three caches failed programs: repeating the same budget must also recover.
    await limit.fill("64");
    await expect(limit).toHaveValue(String(maximum));
  } else {
    await expect(limit).toHaveValue("64");
    expect(await page.evaluate(() => window.__vh!.renderedLights().filter((l) => l.castShadow).length)).toBe(40);
  }
  await page.getByRole("switch", { name: "Try higher limits", exact: true }).click();
  await expect(limit).toHaveAttribute("max", String(maximum));
  await waitForStableFrames(page, 900);
  const restoredImage = await canvas.screenshot();
  await testInfo.attach("restored.png", { body: restoredImage, contentType: "image/png" });
  const restored = await sharp(restoredImage).removeAlpha().raw().toBuffer();
  expect(restored.length).toBe(baseline.length);
  let difference = 0;
  for (let i = 0; i < baseline.length; i++) difference += Math.abs(restored[i]! - baseline[i]!);
  expect(difference / baseline.length).toBeLessThan(2);
  await testInfo.attach("all-lights-on.png", { body: await page.screenshot(), contentType: "image/png" });
  await expect(page.getByTestId("viewer-frame-rate")).toHaveText("idle");
});

test("an overflow wall lamp visibly illuminates several surfaces at night", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Desktop pixel comparison; shared renderer.");
  await installSyntheticHa(page);
  const placements = Array.from({ length: 7 }, (_, i) => ({
    id: `lamp-${i}`, modelId: "fixture-house", equipmentId: `lamp-${i}`, name: `Lamp ${i}`,
    position: i < 6 ? [50 + i, 2, 50] : [1.2, 1.8, 1.2], rotationYDeg: 0,
    lightAim: null, mount: { kind: "free", height: 1.8 }, floorId: "f-lower", roomId: "r-l-a", surfaceId: null,
    locationNote: "", photoId: null, entityId: `light.test_${i}`, symbol: "wall_lamp", category: "electrical", linkedEntities: [],
  }));
  await page.route("**/api/house-model/fixture-house/placements*", async (route) => {
    await route.fulfill({ json: new URL(route.request().url()).searchParams.has("options") ? { placeable: [] } : { placements, stale: [], partialFields: [] } });
  });
  await openHouse(page, { sel: "room:r-l-a" });
  await openRenderingCategory(page, "Light");
  await page.getByRole("slider", { name: "Detailed lights", exact: true }).fill("6");
  await page.getByRole("tab", { name: "Environment", exact: true }).click();
  const controls = page.getByRole("group", { name: "Daylight and shadows", exact: true });
  await controls.getByText("Location and north", { exact: true }).click();
  await controls.getByLabel("Latitude", { exact: true }).fill("45");
  await controls.getByLabel("Longitude", { exact: true }).fill("0");
  await controls.getByLabel(/Preview date and time/).fill("2026-03-20T00:00");
  await openSyntheticHa(page);
  await emitHaBatch(page, placements.map((p, i) => ({ topic: "ha.state", key: p.entityId, payload: { state: i < 6 ? "on" : "off", attributes: { brightness: 255 }, lastUpdated: Date.now() } })));
  await waitForStableFrames(page, 900);
  const canvas = page.locator("canvas").first();
  const off = await sharp(await canvas.screenshot()).removeAlpha().raw().toBuffer();
  await emitHaBatch(page, [{ topic: "ha.state", key: "light.test_6", payload: { state: "on", attributes: { brightness: 255 }, lastUpdated: Date.now() } }]);
  await waitForStableFrames(page, 900);
  const patches = await page.evaluate(() => window.__vh!.lightProjections().filter((p) => p.sourceId === "lamp-6"));
  expect(new Set(patches.map((p) => p.surfaceId)).size).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.__vh!.renderedLights().find((l) => l.id === "lamp-6")?.kind)).toBe("projection");
  const lit = await canvas.screenshot();
  const on = await sharp(lit).removeAlpha().raw().toBuffer();
  let brighter = 0;
  for (let i = 0; i < off.length; i += 3) if (on[i]! + on[i + 1]! + on[i + 2]! - off[i]! - off[i + 1]! - off[i + 2]! > 25) brighter++;
  expect(brighter).toBeGreaterThan(1_000);
  await testInfo.attach("overflow-lamp-night.png", { body: lit, contentType: "image/png" });
});
