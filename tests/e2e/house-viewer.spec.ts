import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { openHouseSession, openRenderingCategory, waitForStableFrames, idleFrames } from "./helpers/house";

async function imageDownload(page: Page): Promise<Buffer> {
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download image", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^house-view-.*\.png$/);
  expect(await download.failure()).toBeNull();
  const file = await download.path();
  return sharp(file!).png().toBuffer();
}

test("PNG includes the rendered scene, background and visible labels", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  try {
    await waitForStableFrames(page, 1000);
    const canvas = page.locator("canvas").first();
    const size = await canvas.evaluate((el) => ({ width: (el as HTMLCanvasElement).width, height: (el as HTMLCanvasElement).height }));
    const png = await imageDownload(page);
    const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info.width).toBe(size.width);
    expect(decoded.info.height).toBe(size.height);
    expect(decoded.data[3]).toBe(255); // CSS background was composited, not left transparent.
    const colors = new Set<string>();
    for (let i = 0; i < decoded.data.length; i += 4 * 97) colors.add(decoded.data.subarray(i, i + 3).toString("hex"));
    expect(colors.size).toBeGreaterThan(15); // A scene, not an empty background.
    const visibleLabels = page.locator(".vh-label:visible, .vh-label-cluster:visible");
    expect(await visibleLabels.count()).toBeGreaterThan(0);
    await page.locator(".vh-label, .vh-label-cluster").evaluateAll((els) => els.forEach((el) => (el as HTMLElement).style.visibility = "hidden"));
    const withoutLabels = await imageDownload(page);
    expect(png.equals(withoutLabels)).toBe(false);
    await page.locator(".vh-label, .vh-label-cluster").evaluateAll((els) => els.forEach((el) => (el as HTMLElement).style.visibility = ""));
    await testInfo.attach("house-image.png", { body: png, contentType: "image/png" });
    await waitForStableFrames(page);
    const idle = await idleFrames(page, 500);
    expect(idle.invalidateAfter).toBe(idle.invalidateBefore);
  } finally { await context.close(); }
});

test("compact controls are separate and collapsing placement cancels it", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Desktop panels; phone retains its numeric editor.");
  const { context, page } = await openHouseSession(browser);
  try {
    const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
    const controls = page.getByRole("region", { name: "View controls", exact: true });
    const wallModes = page.getByRole("radiogroup", { name: "Wall display", exact: true });
    await expect(wallModes).toBeVisible();
    await expect(controls.getByRole("radiogroup", { name: "Wall display", exact: true })).toHaveCount(0);
    await wallModes.getByRole("radio", { name: "Contextual", exact: true }).click();
    await expect(wallModes.getByRole("radio", { name: "Contextual", exact: true })).toHaveAttribute("aria-checked", "true");
    const treeRows = page.getByRole("tree", { name: "Property structure", exact: true }).getByRole("treeitem");
    expect((await treeRows.first().boundingBox())!.height).toBeLessThanOrEqual(29);
    await expect(inspector.getByRole("switch", { name: "Roof (H)" })).toHaveCount(0);
    await controls.getByRole("tab", { name: "Layers", exact: true }).click();
    await expect(controls.getByRole("switch", { name: "Roof (H)" })).toBeVisible();
    await openRenderingCategory(page, "Light");
    await expect(controls.getByRole("slider", { name: "Detailed lights" })).toBeVisible();
    await controls.getByRole("tab", { name: "Background", exact: true }).click();
    await expect(controls.getByRole("radiogroup", { name: "3D background" })).toBeVisible();
    await page.getByRole("button", { name: "Collapse the view controls", exact: true }).click();
    await expect(controls.getByRole("button", { name: "Download image", exact: true })).toBeVisible();
    await expect(controls.getByRole("button", { name: "Overview (R)" })).toBeVisible();
    await page.getByRole("button", { name: "Collapse the inspector", exact: true }).click();
    await page.getByRole("button", { name: /Not placed yet/ }).click();
    const place = page.getByRole("button", { name: "Place Viewer test lamp in the model", exact: true });
    await place.click();
    await page.getByLabel("X (m)", { exact: true }).fill("8");
    await page.getByRole("button", { name: "Collapse the inspector", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Place equipment", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Show the inspector", exact: true })).toBeVisible();
    await place.click();
    await expect(page.getByLabel("X (m)", { exact: true })).not.toHaveValue("8");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/house-model/*/placements", async (route) => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      await gate;
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "test_save_rejected" }) });
    });
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect(page.getByRole("button", { name: "Collapse the inspector", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancel (Esc)", exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole("button", { name: "Save placement", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Cancel (Esc)", exact: true }).click();
    await testInfo.attach("compact-controls.png", { body: await page.screenshot(), contentType: "image/png" });
  } finally { await context.close(); }
});

test("solid and gradient backgrounds are baked into the PNG", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Background settings live in the desktop controls.");
  const { context, page } = await openHouseSession(browser);
  try {
    await openRenderingCategory(page, "Background");
    await page.getByRole("button", { name: "Warm paper, light", exact: true }).click();
    await expect(page.getByTestId("vh-canvas-host")).toHaveAttribute("style", /background-color/);
    await waitForStableFrames(page);
    const solid = await sharp(await imageDownload(page)).ensureAlpha().raw().toBuffer();
    expect([...solid.subarray(0, 4)]).toEqual([244, 244, 242, 255]);
    await page.getByRole("button", { name: "Cool fade, dark", exact: true }).click();
    await expect(page.getByTestId("vh-canvas-host")).toHaveAttribute("style", /linear-gradient/);
    await waitForStableFrames(page);
    const gradient = await sharp(await imageDownload(page)).ensureAlpha().raw().toBuffer();
    expect(gradient[0]).toBeGreaterThan(gradient[gradient.length - 4]!);
    expect(gradient[3]).toBe(255);
  } finally {
    await page.getByRole("button", { name: "Follows the theme", exact: true }).click();
    await expect(page.getByTestId("vh-canvas-host")).not.toHaveAttribute("style", /background/);
    // Background persistence is debounced; leave it time to complete before the next test.
    await page.waitForTimeout(1000);
    await context.close();
  }
});


test("hovering an elevated surface shows a ground projection without changing the draft", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Pointer placement is desktop only.");
  const { context, page } = await openHouseSession(browser);
  try {
    await page.getByRole("button", { name: /Not placed yet/ }).click();
    await page.getByRole("button", { name: "Place Viewer test lamp in the model", exact: true }).click();
    await waitForStableFrames(page, 1000);
    const initialY = await page.getByLabel("Y (m)", { exact: true }).inputValue();
    const box = (await page.locator("canvas").first().boundingBox())!;
    const readout = page.locator("p.font-mono", { hasText: /m above/ });
    // Search screen points for a roof/ceiling/wall hit; the fixture is fully synthetic.
    for (let row = 2; row < 8 && !(await readout.isVisible()); row++) {
      for (let column = 2; column < 8; column++) {
        await page.mouse.move(box.x + box.width * column / 10, box.y + box.height * row / 10);
        if (await readout.isVisible()) break;
      }
    }
    await expect(readout).toBeVisible();
    await expect(page.getByLabel("Y (m)", { exact: true })).toHaveValue(initialY);
    await testInfo.attach("elevation-preview.png", { body: await page.screenshot(), contentType: "image/png" });
    await page.mouse.move(0, 0);
    await expect(readout).toBeHidden();
  } finally { await context.close(); }
});

test("rendering controls use focused keyboard-accessible categories without desktop panel scrolling", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Phone has its compact floor and equipment view.");
  const { context, page } = await openHouseSession(browser);
  try {
    const controls = page.getByRole("region", { name: "View controls", exact: true });
    await openRenderingCategory(page, "Light");
    const categories = controls.getByRole("tablist", { name: "Rendering settings", exact: true });
    await expect(categories.getByRole("tab")).toHaveCount(4);
    await expect(controls.getByRole("slider", { name: "Detailed lights", exact: true })).toBeVisible();
    await expect(controls.getByRole("radiogroup", { name: "3D background" })).toBeHidden();
    await categories.getByRole("tab", { name: "Light", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(categories.getByRole("tab", { name: "Environment", exact: true })).toHaveAttribute("data-state", "active");
    await categories.getByRole("tab", { name: "Quality", exact: true }).click();
    const performance = controls.getByRole("switch", { name: "Performance mode (pixel ratio 1)", exact: true });
    await expect(performance).toBeVisible();
    const renderingPanel = controls.getByRole("tabpanel", { name: "Quality", exact: true });
    expect(await renderingPanel.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    const palette = (await page.getByRole("radiogroup", { name: "Pointer tool", exact: true }).boundingBox())!;
    expect(palette.width).toBeLessThan(60);
    await testInfo.attach("compact-rendering-controls.png", { body: await page.screenshot(), contentType: "image/png" });
  } finally { await context.close(); }
});

test("phone keeps light detail and daylight overrides in a collapsed rendering disclosure", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "Phone-only rendering controls.");
  const { context, page } = await openHouseSession(browser);
  try {
    const lighting = page.getByText("Rendering", { exact: true });
    const shadows = page.getByRole("switch", { name: "Soft shadows", exact: true });
    const detail = page.getByRole("slider", { name: "Detailed lights", exact: true });
    await expect(lighting).toBeVisible();
    await expect(shadows).toBeHidden();
    await expect(detail).toBeHidden();
    await lighting.click();
    await expect(detail).toBeVisible();
    const categories = page.getByRole("tablist", { name: "Rendering settings", exact: true });
    const categoryBox = (await categories.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(categoryBox.x).toBeGreaterThanOrEqual(0);
    expect(categoryBox.x + categoryBox.width).toBeLessThanOrEqual(viewport.width);
    await detail.fill("2");
    await expect(detail).toHaveValue("2");
    await page.getByRole("switch", { name: "Batched lighting", exact: true }).click();
    await page.getByRole("button", { name: "Use recommended", exact: true }).click();
    await expect(detail).toHaveValue((await detail.getAttribute("max"))!);
    await page.getByRole("switch", { name: "Try higher limits", exact: true }).click();
    await expect(detail).toHaveAttribute("max", "64");
    await detail.fill("48");
    await expect(detail).toHaveValue("48");
    await page.getByRole("tab", { name: "Environment", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Live time", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Quality", exact: true }).click();
    await expect(shadows).toBeVisible();
    await expect(page.getByRole("button", { name: "All", exact: true }).locator("svg")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("global illumination intensity scales scene lighting and settles back to idle", async ({ browser }) => {
  const { context, page } = await openHouseSession(browser);
  try {
    await openRenderingCategory(page, "Environment");
    await page.getByRole("radio", { name: "Studio", exact: true }).click();
    const intensity = page.getByRole("slider", { name: "Global illumination intensity", exact: true });
    await expect(intensity).toHaveValue("100");
    await intensity.fill("50");
    const sunlight = () => page.evaluate(() => (window as unknown as { __vh: import("@/house/test/testHook").VhHook }).__vh.daylight()?.intensity);
    await expect.poll(sunlight).toBeCloseTo(0.825);
    await intensity.fill("0");
    await expect.poll(sunlight).toBe(0);
    await intensity.fill("100");
    await expect.poll(sunlight).toBeCloseTo(1.65);
    await waitForStableFrames(page, 1000);
    const idle = await idleFrames(page, 500);
    expect(idle.invalidateAfter).toBe(idle.invalidateBefore);
  } finally { await context.close(); }
});
