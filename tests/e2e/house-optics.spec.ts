import { expect, test } from "@playwright/test";
import { openHouse, openHouseSession, waitForStableFrames } from "./helpers/house";
import { emitHaBatch, installSyntheticHa, openSyntheticHa } from "./helpers/liveHa";

test("LED length and sensor aim survive saves; selection guides and equipment can be hidden", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  let placementId: string | undefined;
  try {
    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/placements`;
    const available = await (await page.request.get(`${endpoint}?options=placeable`)).json();
    const equipment = available.placeable.find((p: { name: string }) => p.name === "Eave spot");
    const response = await page.request.put(endpoint, { data: { fingerprint: status.fingerprint, viewMode: "normal", placement: { equipmentId: equipment.assetId, floorId: "f-lower", roomId: "r-l-a", position: [1, 1, 1], mount: { kind: "free", height: 1 }, symbol: "led_bar_vertical" } } });
    expect(response.ok()).toBe(true);
    placementId = (await response.json()).placement.id;
    const edit = async () => {
      await page.reload();
      await page.waitForFunction(() => window.__vh?.status().phase === "ready");
      await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), placementId);
      await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    };
    await edit();
    await page.getByLabel("LED bar length (m)", { exact: true }).fill("2.4");
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adjust placement", exact: true })).toBeHidden();
    await edit();
    await expect(page.getByLabel("LED bar length (m)", { exact: true })).toHaveValue("2.4");
    await page.getByRole("combobox", { name: "Shown as", exact: true }).click();
    await page.getByRole("option", { name: "Motion sensor", exact: true }).click();
    await page.getByLabel("Detection / viewing range (m)", { exact: true }).fill("3");
    await page.getByLabel("Yaw (°)", { exact: true }).fill("45");
    await page.getByLabel("Pitch (°)", { exact: true }).fill("-20");
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adjust placement", exact: true })).toBeHidden();
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    expect((await (await page.request.get(endpoint)).json()).placements.find((p: { id: string }) => p.id === placementId)).toMatchObject({ symbol: "motion_sensor", detectionRangeM: 3, lightAim: { yawDeg: 45, pitchDeg: -20 } });
    await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), placementId);
    await expect.poll(() => page.evaluate(() => window.__vh!.detectionGuide().visible)).toBe(true);
    const direction = await page.evaluate(() => window.__vh!.detectionGuide().direction);
    expect(direction[1]).toBeCloseTo(-Math.sin(20 * Math.PI / 180));
    await waitForStableFrames(page);
    await testInfo.attach("motion-sensor-guide.png", { body: await page.screenshot(), contentType: "image/png" });
    await page.evaluate(() => window.__vh!.select(null));
    await expect.poll(() => page.evaluate(() => window.__vh!.detectionGuide().visible)).toBe(false);
    await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), placementId);
    if (testInfo.project.name !== "phone") {
      await page.getByRole("tab", { name: "Layers", exact: true }).click();
    }
    await page.getByRole("switch", { name: "Show equipment", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__vh!.equipmentCount())).toBe(0);
    await expect.poll(() => page.evaluate(() => window.__vh!.detectionGuide().visible)).toBe(false);
    await expect(page.locator('[data-anchor^="equipment:"]:visible')).toHaveCount(0);
    await expect(page.locator("[data-placement]")).toHaveCount(0);
    await page.getByRole("switch", { name: "Show equipment", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__vh!.equipmentCount())).toBeGreaterThan(0);
  } finally {
    if (placementId) await page.request.delete(`/api/house-model/fixture-house/placements/${placementId}`);
    await context.close();
  }
});

test("LED light output follows length and climate status reaches equipment labels", async ({ page }) => {
  await installSyntheticHa(page);
  const base = { modelId: "fixture-house", rotationYDeg: 0, lightAim: null, mount: { kind: "free", height: 1 }, floorId: "f-lower", roomId: "r-l-a", surfaceId: null, locationNote: "", photoId: null, category: "electrical", linkedEntities: [] };
  await page.route("**/api/house-model/fixture-house/placements*", async (route) => {
    await route.fulfill({ json: new URL(route.request().url()).searchParams.has("options") ? { placeable: [] } : { placements: [
      { ...base, id: "short", equipmentId: "short", name: "Short LED", position: [1, 1, 1], symbol: "led_bar_vertical", ledLengthM: 1, entityId: "light.short" },
      { ...base, id: "long", equipmentId: "long", name: "Long LED", position: [2, 1, 1], symbol: "led_bar_horizontal", ledLengthM: 2, entityId: "light.long" },
      { ...base, id: "pump", equipmentId: "pump", name: "Test heat pump", position: [1, 1, 2], symbol: "heat_pump_indoor", entityId: "climate.pump" },
    ], stale: [], partialFields: [] } });
  });
  await openHouse(page, { sel: "room:r-l-a" });
  await openSyntheticHa(page);
  await emitHaBatch(page, ["light.short", "light.long", "climate.pump"].map((key) => ({ topic: "ha.state", key, payload: { state: key.startsWith("light") ? "on" : "heat", attributes: key.startsWith("light") ? { brightness: 255 } : { hvac_action: "heating", current_temperature: 21.5, temperature: 23 }, lastUpdated: Date.now() } })));
  await expect.poll(() => page.evaluate(() => window.__vh!.lights().length)).toBe(2);
  const lights = await page.evaluate(() => window.__vh!.lights());
  expect(lights.find((l) => l.id === "long")!.brightness).toBeCloseTo(lights.find((l) => l.id === "short")!.brightness * 2);
  await page.evaluate(() => window.__vh!.select({ kind: "equipment", id: "pump" }));
  await expect(page.locator('[data-anchor="equipment:pump"]:visible')).toContainText("heating · 21.5");
});
