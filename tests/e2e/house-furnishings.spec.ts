import { expect, test } from "@playwright/test";
import { idleFrames, openHouseSession, waitForStableFrames } from "./helpers/house";

test("furniture previews, saves, reloads, cancels and has its own layer", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  let furnishingId: string | null = null;
  try {
    await page.locator("summary").filter({ hasText: "Furniture" }).click();
    await page.getByRole("button", { name: "Add furniture" }).click();
    await page.getByLabel("Name", { exact: true }).fill("E2E sofa");
    await page.getByLabel("Width", { exact: true }).fill("2.4");
    await page.getByLabel("Depth", { exact: true }).fill("1.1");
    await page.getByLabel("Height", { exact: true }).fill("0.8");
    await page.getByLabel("Yaw (degrees)", { exact: true }).fill("35");

    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings()[0]?.size))
      .toEqual([2.4, 0.8, 1.1]);
    await testInfo.attach("furniture-editor", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("E2E sofa", { exact: false })).toBeVisible();

    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/furnishings`;
    let body = await (await page.request.get(endpoint)).json();
    furnishingId = body.furnishings.find((x: { name: string }) => x.name === "E2E sofa")?.id ?? null;
    expect(furnishingId).toBeTruthy();
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await expect.poll(async () => (await (await page.request.get(endpoint)).json()).furnishings.some((x: { id: string }) => x.id === furnishingId)).toBe(true);

    await page.locator("summary").filter({ hasText: "Furniture" }).click();
    await page.getByText("E2E sofa", { exact: false }).click();
    await page.getByLabel("Width", { exact: true }).fill("3.3");
    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings()[0]?.size[0])).toBeCloseTo(3.3, 2);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings()[0]?.size[0])).toBeCloseTo(2.4, 2);

    const toggleName = testInfo.project.name === "phone" ? "Show furniture" : "Furniture";
    const toggle = page.getByRole("switch", { name: toggleName, exact: true });
    if (testInfo.project.name !== "phone") {
      await page.getByRole("tab", { name: "Layers" }).click();
    }
    await toggle.click();
    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings().length)).toBe(0);
    await toggle.click();
    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings()[0]?.visible)).toBe(true);

    if (testInfo.project.name === "desktop") {
      await page.getByRole("button", { name: "Lower floor", exact: true }).click();
      await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings()[0]?.visible)).toBe(true);
    }
    await waitForStableFrames(page, 700);
    await expect.poll(async () => {
      const idle = await idleFrames(page, 1_000);
      return idle.invalidateAfter - idle.invalidateBefore;
    }, { timeout: 10_000 }).toBe(0);
    body = await (await page.request.get(endpoint)).json();
    expect(body.furnishings.find((x: { id: string }) => x.id === furnishingId)).toMatchObject({
      widthM: 2.4, depthM: 1.1, heightM: 0.8, rotationYDeg: 35,
    });
    await testInfo.attach("furniture-controls", { body: await page.screenshot(), contentType: "image/png" });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(endpoint)).json()).furnishings.some((x: { id: string }) => x.id === furnishingId)).toBe(false);
    furnishingId = null;
  } finally {
    if (furnishingId) await page.request.delete(`/api/house-model/fixture-house/furnishings?id=${furnishingId}`);
    await context.close();
  }
});
