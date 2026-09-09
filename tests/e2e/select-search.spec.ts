import { expect, test } from "@playwright/test";
import { login, nextClientIp } from "./fixtures";

test("selects search without changing the committed value and keep keyboard focus orderly", async ({
  page,
}) => {
  page.setDefaultTimeout(10_000);
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  await login(page, "lucas", { next: "/settings/household" });

  const timezone = page.getByRole("combobox", { name: /^Time zone/ });
  await expect(timezone).toHaveAttribute("aria-expanded", "false");
  await timezone.click();

  const search = page.getByRole("searchbox", { name: "Search options", exact: true });
  await expect(search).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Options", exact: true })).toBeVisible();

  const original = await timezone.textContent();
  await search.fill("Pacific/Honolulu");
  await expect(page.getByRole("option", { name: "Pacific/Honolulu", exact: true })).toBeVisible();
  await expect(timezone).toHaveText(original ?? "");

  await search.press("Escape");
  await expect(search).toBeHidden();
  await expect(timezone).toBeFocused();
  await expect(timezone).toHaveText(original ?? "");

  // Printable typing on the trigger opens the search and seeds it, while Space opens it blank.
  await timezone.press("P");
  await expect(search).toHaveValue("P");
  await search.fill("definitely-not-a-time-zone");
  await expect(page.getByText("No matching options", { exact: true })).toBeVisible();
  await search.press("Escape");
  await timezone.press("Space");
  await expect(search).toHaveValue("");

  await search.fill("Pacific/Honolulu");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(timezone).toHaveText("Pacific/Honolulu");

  // Tab closes the portalled list and advances within the settings form.
  await timezone.press("Space");
  await search.press("Tab");
  await expect(search).toBeHidden();
  await expect(page.getByLabel(/^Delivery time/)).toBeFocused();
});
