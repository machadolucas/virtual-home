import { expect, test } from "@playwright/test";
import { openHouseSession } from "./helpers/house";

test("other model objects accept precise attachment without changing the draft on hover", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Mouse placement; phone uses numeric coordinates.");
  const { context, page } = await openHouseSession(browser);
  let id: string | undefined;
  try {
    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/placements`;
    const options = await (await page.request.get(`${endpoint}?options=placeable`)).json();
    const equipment = options.placeable.find((item: { name: string }) => item.name === "Eave spot");
    expect(equipment).toBeTruthy();
    const created = await page.request.put(endpoint, { data: {
      fingerprint: status.fingerprint, viewMode: "normal",
      placement: { equipmentId: equipment.assetId, floorId: "f-lower", position: [1, 1, 1], mount: { kind: "free", height: 1 }, symbol: "sensor" },
    } });
    expect(created.ok()).toBe(true);
    id = (await created.json()).placement.id;
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), id);
    await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    const coordinates = () => Promise.all(["X", "Y", "Z"].map((axis) => page.getByLabel(`${axis} (m)`, { exact: true }).inputValue()));
    const before = await coordinates();
    const target = await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const box = canvas.getBoundingClientRect();
      const surfaces = new Set(["s-o-l-door-leaf", "s-o-l-door-reveal", "s-e-l-step", "s-e-roof-fx-north", "s-e-roof-fx-south"]);
      for (let y = 40; y < box.height - 40; y += 12) for (let x = 40; x < box.width - 40; x += 12) {
        if (document.elementFromPoint(box.left + x, box.top + y) !== canvas) continue;
        const hit = window.__vh!.pick(x, y);
        if (hit?.surfaceId && surfaces.has(hit.surfaceId)) return { x: box.left + x, y: box.top + y, surfaceId: hit.surfaceId };
      }
      return null;
    });
    expect(target).not.toBeNull();
    await page.mouse.move(target!.x, target!.y);
    expect(await coordinates()).toEqual(before);
    await page.mouse.click(target!.x, target!.y);
    await expect(page.getByRole("radio", { name: "Free / other surface", exact: true })).toBeChecked();
    await expect(page.getByText(target!.surfaceId, { exact: false }).first()).toBeVisible();
    const attached = await coordinates();
    expect(attached).not.toEqual(before);
    await page.getByLabel("Rotation around Y (°)", { exact: true }).fill("45");
    expect(await coordinates()).toEqual(attached);
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adjust placement", exact: true })).toBeHidden();
    const stored = await (await page.request.get(endpoint)).json();
    expect(stored.placements.find((item: { id: string }) => item.id === id)).toMatchObject({
      symbol: "sensor", mount: { kind: "free", surfaceId: target!.surfaceId }, position: attached.map(Number),
    });
  } finally {
    if (id) await page.request.delete(`/api/house-model/fixture-house/placements/${id}`);
    await context.close();
  }
});
