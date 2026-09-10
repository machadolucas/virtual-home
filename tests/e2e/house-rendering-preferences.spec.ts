import { expect, test } from "@playwright/test";
import { openHouseSession, waitForStableFrames } from "./helpers/house";

test("rendering choices survive reload and reset without saving camera or edits", async ({ browser }, info) => {
  const { context, page } = await openHouseSession(browser);
  try {
    const openRendering = async () => {
      if (info.project.name === "phone") await page.locator("summary").filter({ hasText: /^Rendering$/ }).click();
      else await page.getByRole("tab", { name: "Rendering", exact: true }).click();
    };
    await openRendering();
    await page.getByRole("switch", { name: "All installed lights", exact: true }).click();
    await page.getByRole("tab", { name: "Quality", exact: true }).click();
    await page.getByRole("switch", { name: "Soft shadows", exact: true }).click();
    await page.getByRole("switch", { name: /Performance mode/ }).click();
    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    await page.getByRole("radio", { name: "Studio", exact: true }).click();
    await page.getByRole("slider", { name: "Global illumination intensity", exact: true }).fill("175");
    await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.intensity)).toBeCloseTo(2.8875);
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    // Restoration happens while controls are closed, before the user opens a category.
    await expect.poll(() => page.evaluate(() => window.__vh!.daylight()?.intensity)).toBeCloseTo(2.8875);
    await openRendering();
    await expect(page.getByRole("switch", { name: "All installed lights", exact: true })).toBeChecked();
    await expect(page.getByRole("slider", { name: "Detailed lights", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "Quality", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Soft shadows", exact: true })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: /Performance mode/ })).toBeChecked();
    await page.getByRole("button", { name: "Reset device settings", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Soft shadows", exact: true })).toBeChecked();
    await expect(page.getByRole("switch", { name: /Performance mode/ })).not.toBeChecked();
    await page.getByRole("tab", { name: "Light", exact: true }).click();
    await expect(page.getByRole("switch", { name: "All installed lights", exact: true })).not.toBeChecked();
    await expect(page.getByRole("slider", { name: "Detailed lights", exact: true })).toHaveValue("64");
    await waitForStableFrames(page);
  } finally { await context.close(); }
});
