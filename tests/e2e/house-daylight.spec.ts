import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { openHouse, waitForStableFrames } from "./helpers/house";

test("daylight preview changes sunlight, shadows and night brightness then returns idle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Desktop rendering controls; shared canvas lighting.");
  await openHouse(page);
  await page.getByRole("tab", { name: "Rendering", exact: true }).click();
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
  await controls.getByRole("switch", { name: "Soft shadows", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.radius)).toBe(0);
  await page.getByRole("switch", { name: /Performance mode/ }).click();
  await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.shadowMapSize)).toBe(512);
  await controls.getByRole("button", { name: "Live time", exact: true }).click();
  await expect(controls.getByRole("button", { name: "Live time", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(date).not.toHaveValue("2026-03-20T00:00");
  await waitForStableFrames(page);
  const before = await page.evaluate(() => window.__vh!.invalidateCount());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__vh!.invalidateCount())).toBe(before);
});
