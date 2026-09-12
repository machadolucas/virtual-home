import { test, expect } from "@playwright/test";
import { login, nextClientIp } from "./fixtures";

test("navigation, alerts and fullscreen remain reachable", async ({ page, isMobile }) => {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  await login(page, "lucas");
  await page.goto("/house");
  await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Pan (Shift + drag)" })).toBeVisible();
  await page.getByRole("radio", { name: "Pan (Shift + drag)" }).click();
  await expect(page.getByRole("radio", { name: "Pan (Shift + drag)" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect(page.locator('[data-fullscreen="true"]').first()).toBeVisible();
  await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
  await expect(page.locator('[data-fullscreen="true"]')).toHaveCount(0);
  if (isMobile) {
    await page.getByRole("button", { name: "More sections" }).click();
    await page.getByRole("dialog", { name: "All sections" }).getByRole("link", { name: "Providers", exact: true }).click();
    await expect(page).toHaveURL(/\/providers$/);
  }
});

import { openHouseSession, vh, waitForStableFrames } from "./helpers/house";

test("camera gestures, collapsed panes and fullscreen preserve the placement draft", async ({ browser }, info) => {
  test.skip(info.project.name.includes("phone"), "Desktop pointer and pane workflow.");
  const { context, page } = await openHouseSession(browser);
  try {
    const dismiss = page.getByRole("button", { name: "Dismiss this hint" });
    if (await dismiss.isVisible()) await dismiss.click();
    await page.getByRole("button", { name: /Not placed yet/ }).click();
    await page.getByRole("button", { name: /^Place .+ in the model$/ }).first().click();
    await page.getByLabel("X (m)", { exact: true }).fill("1.25");
    const draft = await vh(page).placementDraft();
    const canvas = page.locator("canvas").first();
    await canvas.evaluate(el => el.setAttribute("data-preserved-canvas", "yes"));
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(page.locator('canvas[data-preserved-canvas="yes"]')).toHaveCount(1);
    expect(await vh(page).placementDraft()).toEqual(draft);
    await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    await expect(page.locator('canvas[data-preserved-canvas="yes"]')).toHaveCount(1);
    await waitForStableFrames(page, 700);
    const box = (await canvas.boundingBox())!;
    const before = await vh(page).camera();
    await page.keyboard.down("Shift");
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await waitForStableFrames(page, 700);
    const after = await vh(page).camera();
    expect(after.target).not.toEqual(before.target);
    expect(await vh(page).placementDraft()).toEqual(draft);
    await page.getByRole("combobox", { name: "Camera input", exact: true }).selectOption("trackpad");
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .3);
    await page.mouse.wheel(80, 40);
    await waitForStableFrames(page, 700);
    expect((await vh(page).camera()).target).not.toEqual(after.target);
    expect(await vh(page).placementDraft()).toEqual(draft);
    await page.getByRole("button", { name: /Collapse.*(?:details|inspector)/i }).click();
    expect(await vh(page).placementDraft()).toEqual(draft);
  } finally { await context.close(); }
});
