import { expect, test } from "@playwright/test";
import { login, nextClientIp } from "./fixtures";

test("bulk import readings, link primary, and remove equipment for reimport", async ({ page }, testInfo) => {
  page.setDefaultTimeout(10_000);
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  const viewport = testInfo.project.name;
  const name = `E2E ${viewport} motion`;
  const temperature = `sensor.e2e_${viewport}_temperature`;
  const occupancy = `binary_sensor.e2e_${viewport}_occupancy`;
  await login(page, "lucas", { next: "/settings/home-assistant" });
  await page.getByRole("checkbox", { name: `Select ${name} for bulk import`, exact: true }).check();
  await page.getByRole("combobox", { name: `Role for ${temperature}`, exact: true }).click();
  await page.getByRole("option", { name: /^Status \/ reading/ }).click();
  await page.getByRole("button", { name: "Import 1", exact: true }).click();
  await expect(page.getByText(`Already ${name}`, { exact: true })).toBeVisible();
  await page.goto("/equipment");
  await expect(page.getByRole("link", { name: "Import from Home Assistant", exact: true })).toBeVisible();
  await page.getByRole("link", { name: new RegExp(name) }).click();
  await expect(page.getByText(temperature, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Link an entity", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: /^Entity/ }).click();
  await expect(page.getByRole("option").first()).toContainText(`e2e_${viewport}_`);
  await page.getByRole("option").filter({ hasText: occupancy }).click();
  await dialog.getByRole("button", { name: "Link it", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByText(occupancy, { exact: true })).toBeVisible();
  await expect(page.getByText("Primary", { exact: true })).toBeVisible();

  await page.goto("/equipment");
  const sections = page.getByRole("navigation", { name: "Sections", exact: true }).filter({ visible: true });
  for (const label of ["Equipment", "Projects", "Plans", "Procedures", "Shopping list"]) {
    await expect(sections.getByRole("link", { name: label, exact: true })).toBeAttached();
  }
  await page.getByRole("searchbox", { name: "Filter equipment" }).fill(name);
  await page.getByRole("checkbox", { name: "Select all filtered", exact: true }).check();
  await page.getByRole("button", { name: "Remove selected", exact: true }).click();
  await expect(dialog).toContainText(name);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
  await page.getByRole("button", { name: "Remove selected", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove 1", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("link", { name: new RegExp(name) })).toHaveCount(0);
  await page.getByRole("link", { name: "Import from Home Assistant", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: `Select ${name} for bulk import`, exact: true })).toBeVisible();
  await expect(page.getByText(`Already ${name}`, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
