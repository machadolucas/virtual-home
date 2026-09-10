import { expect, test, type Page } from "@playwright/test";
import { idleFrames, openHouseSession, waitForStableFrames } from "./helpers/house";

test("furniture catalog creates, edits, reloads, cancels and controls the layer", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  let furnishingId: string | null = null;
  try {
    await page.locator("summary").filter({ hasText: "Furniture" }).click();
    await page.getByRole("button", { name: "Add furniture" }).click();
    await expect(page.getByRole("region", { name: "Furniture catalog" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search furniture" }).fill("sofa");
    await expect(page.getByRole("button", { name: "Place Sofa", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Place Chair", exact: true })).toBeHidden();
    await testInfo.attach("furniture-catalog", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "Place Sofa", exact: true }).click();

    // A numeric edit leaves pointer-placement mode. This clear point stays inside fixture Room A.
    await page.getByLabel("X", { exact: true }).fill("2.3");
    await page.getByLabel("Y", { exact: true }).fill("0");
    await page.getByLabel("Z", { exact: true }).fill("2.7");
    await page.getByLabel("Name", { exact: true }).fill("E2E sofa");
    await page.getByLabel("Width", { exact: true }).fill("1.2");
    await page.getByLabel("Depth", { exact: true }).fill("0.7");
    await page.getByLabel("Height", { exact: true }).fill("0.8");
    await page.getByLabel("Yaw (degrees)", { exact: true }).fill("35");

    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings().find((item) => item.preview)?.size))
      .toEqual([1.2, 0.8, 0.7]);
    await testInfo.attach("furniture-editor", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("E2E sofa", { exact: false })).toBeVisible();

    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/furnishings`;
    let body = await (await page.request.get(endpoint)).json();
    furnishingId = body.furnishings.find((item: { name: string }) => item.name === "E2E sofa")?.id ?? null;
    expect(furnishingId).toBeTruthy();
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await expect.poll(async () => (await (await page.request.get(endpoint)).json()).furnishings.some((item: { id: string }) => item.id === furnishingId)).toBe(true);

    await page.locator("summary").filter({ hasText: "Furniture" }).click();
    await page.getByText("E2E sofa", { exact: false }).click();
    await page.getByLabel("Width", { exact: true }).fill("1.4");
    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings().find((item) => item.preview)?.size[0])).toBeCloseTo(1.4, 2);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings().find((item) => !item.preview)?.size[0])).toBeCloseTo(1.2, 2);

    const toggleName = testInfo.project.name === "phone" ? "Show furniture" : "Furniture";
    const toggle = page.getByRole("switch", { name: toggleName, exact: true });
    if (testInfo.project.name !== "phone") await page.getByRole("tab", { name: "Layers" }).click();
    await toggle.click();
    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings().length)).toBe(0);
    await toggle.click();
    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings().find((item) => !item.preview)?.visible)).toBe(true);

    if (testInfo.project.name === "desktop") {
      await page.getByRole("button", { name: "Lower floor", exact: true }).click();
      await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings().find((item) => !item.preview)?.visible)).toBe(true);
    }
    await waitForStableFrames(page, 700);
    await expect.poll(async () => {
      const idle = await idleFrames(page, 1_000);
      return idle.invalidateAfter - idle.invalidateBefore;
    }, { timeout: 10_000 }).toBe(0);
    body = await (await page.request.get(endpoint)).json();
    expect(body.furnishings.find((item: { id: string }) => item.id === furnishingId)).toMatchObject({
      position: [2.3, 0, 2.7], widthM: 1.2, depthM: 0.7, heightM: 0.8, rotationYDeg: 35,
    });
    await testInfo.attach("furniture-controls", { body: await page.screenshot(), contentType: "image/png" });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(endpoint)).json()).furnishings.some((item: { id: string }) => item.id === furnishingId)).toBe(false);
    furnishingId = null;
  } finally {
    if (furnishingId) await page.request.delete(`/api/house-model/fixture-house/furnishings?id=${furnishingId}`);
    await context.close();
  }
});

test("desktop pointer placement previews without mutating fields and rejects wall collisions", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Pointer placement is exercised on desktop; phone uses numeric coordinates.");
  const { context, page } = await openHouseSession(browser);
  let furnishingId: string | null = null;
  try {
    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/furnishings`;
    const created = await page.request.put(endpoint, { data: {
      fingerprint: status.fingerprint,
      viewMode: "normal",
      furnishing: {
        kind: "chair", name: "E2E pointer chair", floorId: "f-lower",
        position: [2.3, 0, 2.7], rotationYDeg: 0, widthM: 0.5, depthM: 0.55, heightM: 0.9,
      },
    } });
    expect(created.ok()).toBe(true);
    furnishingId = (await created.json()).furnishing.id;
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await page.getByRole("button", { name: "Show inside (D)" }).click();
    await page.getByRole("button", { name: "Lower floor", exact: true }).click();
    await waitForStableFrames(page, 1_000);

    await page.locator("summary").filter({ hasText: "Furniture" }).click();
    await page.getByRole("button", { name: "Add furniture" }).click();
    await page.getByRole("button", { name: "Place Chair", exact: true }).click();
    const originalDraft = await coordinateValues(page);
    const newTarget = await floorTarget(page, [[2.05, 0, 3.1], [2.2, 0, 3.15], [2.35, 0, 3.2]]);
    expect(newTarget).not.toBeNull();
    await page.mouse.move(newTarget!.x, newTarget!.y);
    await expect.poll(async () => {
      const position = await page.evaluate(() => window.__vh!.furnishings().find((item) => item.preview)?.position);
      return position ? Math.max(...position.map((value, axis) => Math.abs(value - newTarget!.point[axis]!))) : Infinity;
    }).toBeLessThan(0.02);
    expect(await coordinateValues(page)).toEqual(originalDraft);
    await page.mouse.click(newTarget!.x, newTarget!.y);
    // A click may quantize the canvas pointer differently from hover by a CSS pixel.
    await expect.poll(async () => {
      const fields = (await coordinateValues(page)).map(Number);
      return Math.max(...fields.map((value, axis) => Math.abs(value - newTarget!.point[axis]!)));
    }).toBeLessThan(0.02);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(async () => page.evaluate(() => window.__vh!.furnishings().filter((item) => item.preview).length)).toBe(0);

    // Clicking the rendered furnishing itself opens the right-side editor.
    const chair = await canvasPoint(page, [2.3, 0.45, 2.7]);
    await page.mouse.click(chair.x, chair.y);
    await expect(page.getByRole("heading", { name: "Edit furniture", exact: true })).toBeVisible();
    await page.getByLabel("Width", { exact: true }).fill("1.2");
    await page.getByRole("button", { name: "Reposition in 3D", exact: true }).click();
    const beforeReposition = await coordinateValues(page);
    const blocked = await floorTarget(page, [[2.75, 0, 2.2], [2.72, 0, 2.6], [2.7, 0, 3.1]]);
    expect(blocked).not.toBeNull();
    await page.mouse.move(blocked!.x, blocked!.y);
    await expect(page.getByRole("alert").filter({ hasText: "Overlaps a wall or door" })).toContainText("Overlaps a wall or door");
    expect(await coordinateValues(page)).toEqual(beforeReposition);
    await testInfo.attach("furniture-invalid-preview", { body: await page.screenshot(), contentType: "image/png" });
    await page.mouse.click(blocked!.x, blocked!.y);
    expect(await coordinateValues(page)).toEqual(beforeReposition);
    await expect(page.getByRole("alert").filter({ hasText: "Overlaps a wall or door" })).toContainText("Overlaps a wall or door");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    const stored = await (await page.request.get(endpoint)).json();
    expect(stored.furnishings.find((item: { id: string }) => item.id === furnishingId)).toMatchObject({
      position: [2.3, 0, 2.7], widthM: 0.5,
    });
  } finally {
    if (furnishingId) await page.request.delete(`/api/house-model/fixture-house/furnishings?id=${furnishingId}`);
    await context.close();
  }
});

async function coordinateValues(page: Page): Promise<string[]> {
  return Promise.all(["X", "Y", "Z"].map((axis) => page.getByLabel(axis, { exact: true }).inputValue()));
}

async function canvasPoint(page: Page, world: [number, number, number]) {
  return page.evaluate((position) => {
    const canvas = document.querySelector("canvas")!;
    const box = canvas.getBoundingClientRect();
    const point = window.__vh!.screenOf(position);
    if (!point) throw new Error(`Could not project ${position.join(",")}`);
    return { x: box.left + point[0], y: box.top + point[1] };
  }, world);
}

async function floorTarget(page: Page, candidates: Array<[number, number, number]>) {
  return page.evaluate((positions) => {
    const canvas = document.querySelector("canvas")!;
    const box = canvas.getBoundingClientRect();
    for (const position of positions) {
      const screen = window.__vh!.screenOf(position);
      if (!screen || document.elementFromPoint(box.left + screen[0], box.top + screen[1]) !== canvas) continue;
      // Use physical CSS pixels for consistent pointermove/pointerup coordinates.
      const x = Math.round(box.left + screen[0]);
      const y = Math.round(box.top + screen[1]);
      const hit = window.__vh!.pick(x - box.left, y - box.top);
      if (hit?.surfaceId !== "s-r-l-a-floor") continue;
      return {
        x, y,
        point: hit.point.toArray().map((value) => {
          const rounded = Math.round(value * 1000) / 1000;
          return Object.is(rounded, -0) ? 0 : rounded;
        }),
      };
    }
    return null;
  }, candidates);
}
