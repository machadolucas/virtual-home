import { expect, test } from "@playwright/test";
import { login, nextClientIp } from "./fixtures";

test("procedure edits save new versions while earlier instructions remain read-only", async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  await login(page, "lucas", { next: "/procedures" });
  await page.getByRole("button", { name: "New procedure", exact: true }).click();
  await page.getByRole("dialog").getByLabel(/^Title/).fill("E2E filter service");
  await page.getByRole("button", { name: "Create procedure", exact: true }).click();

  await page.getByRole("button", { name: "Add a step", exact: true }).click();
  const stepTitle = page.getByRole("textbox", { name: "Step 1 title", exact: true });
  await stepTitle.fill("Turn the unit off");
  await page.getByRole("button", { name: "Save procedure", exact: true }).click();
  await expect(page.getByText("Version history (1)", { exact: true })).toBeVisible();

  await stepTitle.fill("Turn the unit off at the isolator");
  await page.getByRole("button", { name: "Save procedure", exact: true }).click();
  await expect(page.getByText("Version history (2)", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E filter service", exact: true })).toBeVisible();

  const history = page.getByText("Version history (2)", { exact: true });
  await history.click();
  await page.getByRole("link", { name: "v1", exact: true }).click();
  await expect(page).toHaveURL(/\?version=/);
  await expect(page.getByText(/^1\s*Turn the unit off$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save procedure", exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Edit current procedure", exact: true }).click();
  await expect(page).toHaveURL(/\/procedures\/[0-9a-f-]+$/);
  await expect(page.getByRole("textbox", { name: "Step 1 title", exact: true })).toHaveValue(
    "Turn the unit off at the isolator",
  );
});
