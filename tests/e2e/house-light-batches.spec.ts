import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { openHouse, waitForStableFrames } from "./helpers/house";
import { emitHaBatch, installSyntheticHa, openSyntheticHa } from "./helpers/liveHa";

test("40 shadowed lights use bounded batches and reuse unchanged contributions", async ({ page }, info) => {

  const errors: string[] = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await installSyntheticHa(page);
  const placements = Array.from({ length: 40 }, (_, i) => ({
    id: `batch-${i}`, modelId: "fixture-house", equipmentId: `batch-${i}`, name: `Batch light ${i}`,
    position: [0.6 + (i % 4) * 0.5, 2.25, 0.5 + Math.floor(i / 4) * 0.2], rotationYDeg: 0,
    lightAim: null, mount: { kind: "free", height: 2.25 }, floorId: "f-lower", roomId: "r-l-a", surfaceId: null,
    locationNote: "", photoId: null, entityId: `light.batch_${i}`, symbol: i % 2 ? "downlight" : "ceiling_lamp", category: "electrical", linkedEntities: [],
  }));
  await page.route("**/api/house-model/fixture-house/placements*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.has("options") ? { placeable: [] } : { placements, stale: [], partialFields: [] } }));
  await openHouse(page, { sel: "room:r-l-a" });
  await openSyntheticHa(page);
  const emit = (i: number, brightness: number) => ({ topic: "ha.state" as const, key: `light.batch_${i}`, payload: { state: "on", attributes: { brightness }, lastUpdated: Date.now() } });
  await emitHaBatch(page, placements.map((_, i) => emit(i, 40)));
  await waitForStableFrames(page, 900);
  const lights = await page.evaluate(() => window.__vh!.renderedLights());
  expect(lights.filter(l => l.castShadow && l.shadowMapAllocated && l.intensity > 0)).toHaveLength(40);
  const before = (await page.evaluate(() => window.__vh!.lightingBatches()))!;
  expect(before.batches).toBeGreaterThan(1);
  expect(before.litSurfaces).toBeGreaterThan(0);
  const shadows = await page.evaluate(() => window.__vh!.shadowPassCount());
  await emitHaBatch(page, [emit(0, 120)]);
  await waitForStableFrames(page, 900);
  const after = (await page.evaluate(() => window.__vh!.lightingBatches()))!;
  expect(after.rendered).toBeGreaterThan(before.rendered);
  expect(after.reused).toBeGreaterThan(before.reused);
  expect(await page.evaluate(() => window.__vh!.shadowPassCount())).toBe(shadows);
  expect(errors.filter(e => /THREE|shader|WebGL|framebuffer/i.test(e))).toEqual([]);
  await expect(page.getByTestId("viewer-frame-rate")).toHaveText("idle").catch(async error => {
    console.log("Frame drivers", await page.evaluate(() => window.__vh!.frameDrivers()));
    throw error;
  });
  if (info.project.name !== "phone") {
  const canvasBox = (await page.locator("canvas").first().boundingBox())!;
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.6, canvasBox.y + canvasBox.height * 0.4, { steps: 10 });
  await page.mouse.up();
  await waitForStableFrames(page, 900);
  expect((await page.evaluate(() => window.__vh!.lightingBatches()))!.rendered).toBeGreaterThan(after.rendered);
  }
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download image", exact: true }).click();
  const download = await downloadEvent;
  expect(await download.failure()).toBeNull();
  const exported = await sharp((await download.path())!).stats();
  expect(exported.channels.some(channel => channel.stdev > 10)).toBe(true);
  await info.attach("forty-detailed-lights.png", { body: await page.screenshot(), contentType: "image/png" });
});

test("batched direct light matches single-pass colours and shadows", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "Desktop pixel comparison.");
  await installSyntheticHa(page);
  const placements = [0, 1].map(i => ({
    id: `compare-${i}`, modelId: "fixture-house", equipmentId: `compare-${i}`, name: `Compare ${i}`,
    position: [1 + i, 2.25, 1], rotationYDeg: 0, lightAim: null, mount: { kind: "free", height: 2.25 },
    floorId: "f-lower", roomId: "r-l-a", surfaceId: null, locationNote: "", photoId: null,
    entityId: `light.compare_${i}`, symbol: "downlight", category: "electrical", linkedEntities: [],
  }));
  await page.route("**/api/house-model/fixture-house/placements*", route => route.fulfill({ json: new URL(route.request().url()).searchParams.has("options") ? { placeable: [] } : { placements, stale: [], partialFields: [] } }));
  await openHouse(page, { sel: "room:r-l-a" });
  await openSyntheticHa(page);
  await emitHaBatch(page, placements.map((p, i) => ({ topic: "ha.state" as const, key: p.entityId, payload: { state: "on", attributes: { brightness: 160, rgb_color: i ? [40, 100, 255] : [255, 80, 30] }, lastUpdated: Date.now() } })));
  await page.getByRole("tab", { name: "Rendering", exact: true }).click();
  await waitForStableFrames(page, 900);
  const canvas = page.locator("canvas").first();
  const batched = await sharp(await canvas.screenshot()).removeAlpha().raw().toBuffer();
  await page.getByRole("switch", { name: "Batched lighting", exact: true }).click();
  await waitForStableFrames(page, 900);
  const single = await sharp(await canvas.screenshot()).removeAlpha().raw().toBuffer();
  expect(single.length).toBe(batched.length);
  let difference = 0;
  for (let i = 0; i < single.length; i++) difference += Math.abs(single[i]! - batched[i]!);
  expect(difference / single.length).toBeLessThan(2);
  await page.getByRole("switch", { name: "Batched lighting", exact: true }).click();
  await page.evaluate(() => window.__vh!.select({ kind: "equipment", id: "compare-0" }));
  await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
  await waitForStableFrames(page, 900);
  const shadows = await page.evaluate(() => window.__vh!.shadowPassCount());
  const passes = (await page.evaluate(() => window.__vh!.lightingBatches()))!.rendered;
  await page.getByLabel("X (m)", { exact: true }).fill("1.4");
  await waitForStableFrames(page, 900);
  expect(await page.evaluate(() => window.__vh!.shadowPassCount())).toBeGreaterThan(shadows);
  expect((await page.evaluate(() => window.__vh!.lightingBatches()))!.rendered).toBeGreaterThan(passes);
  await page.getByRole("button", { name: "Cancel (Esc)", exact: true }).click();
  await info.attach("batched-comparison.png", { body: await canvas.screenshot(), contentType: "image/png" });
});
