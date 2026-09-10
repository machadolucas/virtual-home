import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { emitHaBatch, installSyntheticHa, openSyntheticHa } from "./helpers/liveHa";
import { openHouse, openRenderingCategory, waitForStableFrames } from "./helpers/house";

test("daylight preview changes sunlight, shadows and night brightness then returns idle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Desktop rendering controls; shared canvas lighting.");
  await openHouse(page);
  await openRenderingCategory(page, "Environment");
  const controls = page.getByRole("group", { name: "Daylight and shadows", exact: true });
  await controls.getByText("Location and north", { exact: true }).click();
  await controls.getByLabel("Latitude", { exact: true }).fill("45");
  await controls.getByLabel("Longitude", { exact: true }).fill("0");
  const date = controls.getByLabel(/Preview date and time/);
  await date.fill("2026-03-20T12:00");
  await waitForStableFrames(page);
  const noon = await page.evaluate(() => window.__vh!.daylight());
  expect(noon?.shadowMapAllocated).toBe(true);
  expect(noon?.shadowMapSize).toBe(2048);
  expect(noon?.intensity).toBeGreaterThan(0.5);
  const canvas = page.getByTestId("vh-canvas-host");
  const noonImage = await canvas.screenshot();
  await date.fill("2026-03-20T00:00");
  await waitForStableFrames(page);
  const night = await page.evaluate(() => window.__vh!.daylight());
  expect(night?.intensity).toBeLessThan(noon!.intensity / 2);
  expect(night?.position).not.toEqual(noon?.position);
  const nightImage = await canvas.screenshot();
  // Compare changed model pixels, not the independent CSS background filling most of the canvas.
  const dayPixels = await sharp(noonImage).removeAlpha().raw().toBuffer();
  const nightPixels = await sharp(nightImage).removeAlpha().raw().toBuffer();
  let dayTotal = 0, nightTotal = 0, changed = 0;
  for (let i = 0; i < dayPixels.length; i += 3) {
    const day = dayPixels[i]! + dayPixels[i + 1]! + dayPixels[i + 2]!;
    const nightValue = nightPixels[i]! + nightPixels[i + 1]! + nightPixels[i + 2]!;
    if (Math.abs(day - nightValue) < 20) continue;
    dayTotal += day; nightTotal += nightValue; changed++;
  }
  expect(changed).toBeGreaterThan(1_000);
  expect(nightTotal).toBeLessThan(dayTotal * 0.75);
  await testInfo.attach("daylight-noon.png", { body: noonImage, contentType: "image/png" });
  await testInfo.attach("daylight-night.png", { body: nightImage, contentType: "image/png" });
  await page.getByRole("tab", { name: "Quality", exact: true }).click();
  await page.getByRole("switch", { name: "Soft shadows", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.radius)).toBe(0);
  await page.getByRole("switch", { name: /Performance mode/ }).click();
  await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.shadowMapSize)).toBe(512);
  await page.getByRole("tab", { name: "Environment", exact: true }).click();
  await controls.getByRole("radio", { name: "Live time", exact: true }).click();
  await expect(controls.getByRole("radio", { name: "Live time", exact: true })).toBeChecked();
  await expect(date).not.toHaveValue("2026-03-20T00:00");
  await waitForStableFrames(page);
  const before = await page.evaluate(() => window.__vh!.invalidateCount());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__vh!.invalidateCount())).toBe(before);
});

test("outdoor lux and weather tune Live time, fall back safely, and survive reload by registry id", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Desktop rendering controls; the phone uses the same daylight component.");
  await installSyntheticHa(page);
  // The fixture deliberately has no private location. Give this test a synthetic coordinate whose
  // longitude puts the current instant near solar noon, so Live time exercises daylight on every
  // CI clock and the override remains in force when the page reloads below.
  const instant = new Date();
  const utcHour = instant.getUTCHours() + instant.getUTCMinutes() / 60;
  const syntheticLongitude = (12 - utcHour) * 15;
  await page.route("**/api/house-model/*/manifest*", async (route) => {
    const response = await route.fetch();
    const manifest = await response.json() as { coordinateSystem: Record<string, unknown> };
    manifest.coordinateSystem.geoAnchor = {
      lat: 0,
      lon: syntheticLongitude,
      certainty: "inferred",
      description: "synthetic e2e daylight coordinate",
    };
    await route.fulfill({ response, json: manifest });
  });
  await openHouse(page);
  await openRenderingCategory(page, "Environment");
  const controls = page.getByRole("group", { name: "Daylight and shadows", exact: true });
  await controls.getByText("Outdoor conditions", { exact: true }).click();
  const calculated = (await page.evaluate(() => window.__vh!.daylight()))!.intensity;

  await controls.getByRole("combobox", { name: "Outdoor illuminance source" }).click();
  await page.getByRole("option", { name: /E2E desktop motion/ }).click();
  await controls.getByRole("combobox", { name: "Weather source" }).click();
  await page.getByRole("option", { name: /E2E desktop weather/ }).click();
  await openSyntheticHa(page);

  const emitConditions = (lux: string, weather: string) => emitHaBatch(page, [
    { topic: "ha.state", key: "sensor.e2e_desktop_illuminance", payload: { state: lux, attributes: { device_class: "illuminance", unit_of_measurement: "lx" }, lastUpdated: Date.now() } },
    { topic: "ha.state", key: "weather.e2e_desktop_home", payload: { state: weather, lastUpdated: Date.now() } },
  ]);
  await emitConditions("100000", "sunny");
  await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.intensity ?? 0)).toBeGreaterThan(calculated);
  const bright = (await page.evaluate(() => window.__vh!.daylight()))!.intensity;
  await emitConditions("1", "rainy");
  await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.intensity ?? Infinity)).toBeLessThan(bright / 2);

  await controls.getByRole("radio", { name: "Studio", exact: true }).click();
  const studio = (await page.evaluate(() => window.__vh!.daylight()))!.intensity;
  await emitConditions("100000", "sunny");
  await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.intensity ?? 0)).toBeCloseTo(studio);
  await controls.getByRole("radio", { name: "Live time", exact: true }).click();

  await emitConditions("unavailable", "unavailable");
  await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.intensity ?? 0)).toBeCloseTo(calculated);
  expect(await page.evaluate(() => localStorage.getItem("vh-daylight-lux-registry-id"))).toBe("e2e-desktop-motion-illuminance");
  expect(await page.evaluate(() => localStorage.getItem("vh-daylight-weather-registry-id"))).toBe("e2e-desktop-weather-entity");

  await page.reload();
  await page.waitForFunction(() => window.__vh?.status().phase === "ready");
  await openSyntheticHa(page);
  await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.intensity ?? Infinity)).toBeLessThan(calculated * 0.8);
  await openRenderingCategory(page, "Environment");
  await page.getByRole("group", { name: "Daylight and shadows", exact: true }).getByText("Outdoor conditions", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Outdoor illuminance source" })).toContainText("E2E desktop motion");
  await expect(page.getByRole("combobox", { name: "Weather source" })).toContainText("E2E desktop weather");
});
