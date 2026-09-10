import { expect, test } from "@playwright/test";
import { openHouseSession, waitForStableFrames } from "./helpers/house";

test("equipment shapes expose aiming and configurable solar/tree dimensions survive reload", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  let placementId: string | undefined;
  try {
    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/placements`;
    const available = await (await page.request.get(`${endpoint}?options=placeable`)).json();
    const equipment = available.placeable.find((p: { name: string }) => p.name === "Eave spot");
    expect(equipment).toBeTruthy();
    const response = await page.request.put(endpoint, { data: { fingerprint: status.fingerprint, viewMode: "normal", placement: { equipmentId: equipment.assetId, floorId: "f-lower", roomId: "r-l-a", position: [1, 2, 1], mount: { kind: "free", height: 2 }, symbol: "wall_spot" } } });
    expect(response.ok()).toBe(true);
    placementId = (await response.json()).placement.id;
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), placementId);
    await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    const picker = page.getByRole("combobox", { name: "Shown as", exact: true });
    for (const label of ["Wall spot", "Floor spot", "Ceiling spot"]) {
      await picker.click();
      await page.getByRole("option", { name: label, exact: true }).click();
      await expect(page.getByLabel("Pitch (°)", { exact: true })).toBeVisible();
    }
    await picker.click();
    await page.getByRole("option", { name: "Solar panel", exact: true }).click();
    await expect(page.getByLabel("Pitch (°)", { exact: true })).toHaveCount(0);
    for (const [label, value] of [["Panel width (m)", "1.2"], ["Panel length (m)", "2"], ["Panel thickness (m)", "0.05"], ["Panel tilt (°)", "30"]]) {
      await page.getByLabel(label!, { exact: true }).fill(value!);
      await page.getByLabel(label!, { exact: true }).press("Tab");
    }
    await page.getByLabel("Rotation around Y (°)", { exact: true }).fill("45");
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adjust placement", exact: true })).toBeHidden();
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    const reloaded = await (await page.request.get(endpoint)).json();
    expect(reloaded.placements.find((p: { id: string }) => p.id === placementId)).toMatchObject({ symbol: "solar_panel", rotationYDeg: 45, solarPanel: { widthM: 1.2, lengthM: 2, thicknessM: 0.05, tiltDeg: 30 } });
    await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), placementId);
    await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    await expect(page.getByLabel("Panel width (m)", { exact: true })).toHaveValue("1.2");
    await expect(page.getByLabel("Panel tilt (°)", { exact: true })).toHaveValue("30");

    await page.getByRole("combobox", { name: "Shown as", exact: true }).click();
    await page.getByRole("option", { name: "Tree", exact: true }).click();
    await expect(page.getByLabel("Tree height (m)", { exact: true })).toHaveValue("5");
    await page.getByLabel("Tree height (m)", { exact: true }).fill("8.4");
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    const treeReloaded = await (await page.request.get(endpoint)).json();
    expect(treeReloaded.placements.find((p: { id: string }) => p.id === placementId)).toMatchObject({
      symbol: "tree",
      treeHeightM: 8.4,
    });
    await waitForStableFrames(page);
    await testInfo.attach("tree-equipment.png", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    if (placementId) await page.request.delete(`/api/house-model/fixture-house/placements/${placementId}`);
    await context.close();
  }
});
