import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { emitHaBatch, installSyntheticHa, openSyntheticHa } from "./helpers/liveHa";
import { openHouse, openHouseSession, waitForStableFrames } from "./helpers/house";

test("spotlight aim previews independently and survives saving and reopening", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Mouse aiming; phone uses numeric beam angles.");
  const { context, page } = await openHouseSession(browser);
  let placementId: string | undefined;
  try {
    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/placements`;
    const available = await (await page.request.get(`${endpoint}?options=placeable`)).json();
    const equipment = available.placeable.find((p: { name: string }) => p.name === "Eave spot");
    expect(equipment).toBeTruthy();
    const response = await page.request.put(endpoint, { data: { fingerprint: status.fingerprint, viewMode: "normal", placement: { equipmentId: equipment.assetId, floorId: "f-lower", roomId: "r-l-a", position: [1, 2, 1], mount: { kind: "free", height: 2 }, symbol: "downlight" } } });
    expect(response.ok()).toBe(true);
    placementId = (await response.json()).placement.id;
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), placementId);
    await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Shown as", exact: true })).toContainText("Downlight");
    const coordinates = await Promise.all(["X", "Y", "Z"].map((axis) => page.getByLabel(`${axis} (m)`, { exact: true }).inputValue()));
    await page.getByRole("button", { name: "Aim in 3D view", exact: true }).click();
    const target = await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!.getBoundingClientRect();
      for (let y = canvas.top + 80; y < canvas.bottom - 50; y += 40) {
        for (let x = canvas.left + 100; x < canvas.right - 80; x += 40) {
          const hit = window.__vh!.pick(x - canvas.left, y - canvas.top);
          if (hit?.surfaceId) return { x, y };
        }
      }
      return null;
    });
    expect(target).not.toBeNull();
    await page.mouse.move(target!.x, target!.y);
    await expect(page.getByLabel("Pitch (°)", { exact: true })).toHaveValue("-90");
    expect(await Promise.all(["X", "Y", "Z"].map((axis) => page.getByLabel(`${axis} (m)`, { exact: true }).inputValue()))).toEqual(coordinates);
    await page.mouse.click(target!.x, target!.y);
    await expect(page.getByRole("button", { name: "Aim in 3D view", exact: true })).toBeVisible();
    expect(await Promise.all(["X", "Y", "Z"].map((axis) => page.getByLabel(`${axis} (m)`, { exact: true }).inputValue()))).toEqual(coordinates);
    await page.getByLabel("Yaw (°)", { exact: true }).fill("35");
    await page.getByLabel("Pitch (°)", { exact: true }).fill("-40");
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adjust placement", exact: true })).toBeHidden();
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    const reloaded = await (await page.request.get(endpoint)).json();
    expect(reloaded.placements.find((p: { id: string }) => p.id === placementId)).toMatchObject({ symbol: "downlight", lightAim: { yawDeg: 35, pitchDeg: -40 }, position: coordinates.map(Number) });
    await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), placementId);
    await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    await expect(page.getByLabel("Yaw (°)", { exact: true })).toHaveValue("35");
    await expect(page.getByLabel("Pitch (°)", { exact: true })).toHaveValue("-40");
    await waitForStableFrames(page);
    await testInfo.attach("spotlight-aim.png", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "Cancel (Esc)", exact: true }).click();
  } finally {
    if (placementId) await page.request.delete(`/api/house-model/fixture-house/placements/${placementId}`);
    await context.close();
  }
});

test("HA lights illuminate model surfaces and update colour and brightness without shader churn", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Pixel comparison of desktop room framing.");
  await installSyntheticHa(page);
  const placement = {
    id: "live-light", modelId: "fixture-house", equipmentId: "live-light-equipment", name: "Live test downlight",
    position: [1.5, 2.3, 1.5], rotationYDeg: 0, lightAim: null,
    mount: { kind: "free", height: 2.3 }, floorId: "f-lower", roomId: "r-l-a", surfaceId: null,
    locationNote: "", photoId: null, entityId: "light.live_test", symbol: "downlight", category: "electrical",
    linkedEntities: [{ entityId: "light.live_test", role: "primary", name: "Light", deviceClass: null, unit: null }],
  };
  await page.route("**/api/house-model/fixture-house/placements*", async (route) => {
    const placeable = new URL(route.request().url()).searchParams.has("options");
    await route.fulfill({ json: placeable ? { placeable: [] } : { placements: [placement], stale: [], partialFields: [] } });
  });
  await openHouse(page, { sel: "room:r-l-a" });
  await openSyntheticHa(page);
  const emit = (state: string, brightness = 255, rgb = [255, 60, 20]) => emitHaBatch(page, [{ topic: "ha.state", key: "light.live_test", payload: { state, attributes: { brightness, rgb_color: rgb }, lastUpdated: Date.now() } }]);
  await emit("off");
  await waitForStableFrames(page, 900);
  const canvas = page.locator("canvas").first();
  const off = await sharp(await canvas.screenshot()).removeAlpha().raw().toBuffer();
  const programs = await page.evaluate(() => window.__vh!.renderInfo().programs);
  await emit("on");
  await expect.poll(() => page.evaluate(() => window.__vh!.lights().length)).toBe(1);
  await waitForStableFrames(page);
  const litImage = await canvas.screenshot();
  const on = await sharp(litImage).removeAlpha().raw().toBuffer();
  let changed = 0;
  for (let i = 0; i < off.length; i += 3) if (Math.abs(off[i]! - on[i]!) + Math.abs(off[i + 1]! - on[i + 1]!) + Math.abs(off[i + 2]! - on[i + 2]!) > 15) changed++;
  expect(changed).toBeGreaterThan(100);
  await testInfo.attach("live-downlight.png", { body: litImage, contentType: "image/png" });
  await emit("on", 64, [20, 80, 255]);
  await expect.poll(() => page.evaluate(() => window.__vh!.lights()[0]?.brightness)).toBeCloseTo(64 / 255);
  expect(await page.evaluate(() => window.__vh!.lights()[0]?.color)).toEqual([20 / 255, 80 / 255, 1]);
  await emit("unavailable");
  await expect.poll(() => page.evaluate(() => window.__vh!.lights().length)).toBe(0);
  await waitForStableFrames(page);
  expect(await page.evaluate(() => window.__vh!.renderInfo().programs)).toBe(programs);
  const beforeIdle = await page.evaluate(() => window.__vh!.invalidateCount());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__vh!.invalidateCount())).toBe(beforeIdle);
});
