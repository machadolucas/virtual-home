import { test, expect } from "@playwright/test";
import { loggedIn } from "./fixtures";

test("owners manage access while members retain ordinary household access", async ({ browser }) => {
  const owner = await loggedIn(browser, "lucas", { next: "/settings/users" });
  const member = await loggedIn(browser, "marja", { next: "/settings/users" });
  try {
    await expect(member.page.getByRole("button", { name: "Add member", exact: true })).toHaveCount(0);
    await expect(member.page.getByRole("button", { name: "Manage member", exact: true })).toHaveCount(0);
    expect((await owner.context.request.post("/api/auth/admin/list-users", { data: {} })).status()).toBe(404);
    await owner.page.getByRole("button", { name: "Add member", exact: true }).click();
    const dialog = owner.page.getByRole("dialog");
    const suffix = Date.now();
    await dialog.getByLabel("Name", { exact: true }).fill(`Test member ${suffix}`);
    await dialog.getByLabel("Username", { exact: true }).fill(`test${suffix}`);
    await dialog.getByLabel("Initial password").fill("synthetic-private-passphrase");
    await dialog.getByRole("button", { name: "Create member", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(owner.page.getByRole("button", { name: "Account: Lucas", exact: true })).toBeVisible();
    await expect(owner.page.getByRole("heading", { name: `Test member ${suffix}`, exact: true })).toBeVisible();
    const createdPanel = owner.page.locator("section").filter({ has: owner.page.getByRole("heading", { name: `Test member ${suffix}`, exact: true }) });
    await createdPanel.getByRole("button", { name: "Manage member", exact: true }).click();
    await dialog.getByLabel("Username", { exact: true }).fill(`renamed${suffix}`);
    await dialog.getByRole("button", { name: "Save member", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(createdPanel).toContainText(`@renamed${suffix}`);
    const marjaPanel = owner.page.locator("section").filter({ has: owner.page.getByRole("heading", { name: "Marja", exact: true }) });
    await marjaPanel.getByRole("button", { name: "Manage member", exact: true }).click();
    await dialog.getByLabel("Active account").uncheck();
    await dialog.getByLabel("Move open work to").selectOption({ label: "Shared household work" });
    await dialog.getByRole("button", { name: "Save member", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await member.page.goto("/today");
    await expect(member.page).toHaveURL(/\/login/);
    await expect(marjaPanel).toContainText("inactive");
    await marjaPanel.getByRole("button", { name: "Manage member", exact: true }).click();
    await dialog.getByLabel("Active account").check();
    await dialog.getByRole("button", { name: "Save member", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(marjaPanel).not.toContainText("inactive");
  } finally { await owner.context.close(); await member.context.close(); }
});

test("Today relationships and reversible HA ignore remain usable on a narrow phone", async ({ browser }) => {
  const { context, page } = await loggedIn(browser, "lucas");
  try {
    await page.setViewportSize({ width: 360, height: 780 });
    await expect(page.getByRole("heading", { name: "Work queue", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Hide guide", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Show guide", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show guide", exact: true }).click();
    await expect(page.getByRole("link", { name: "Trees", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Mine and shared", exact: true }).click();
    await expect(page).toHaveURL(/scope=mine/);
    await page.getByRole("link", { name: /Needs action/ }).click();
    await expect(page).toHaveURL(/queue=attention/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto("/settings/home-assistant?q=E2E%20desktop%20weather");
    const row = page.locator("li").filter({ hasText: "E2E desktop weather" }).filter({ has: page.getByRole("button", { name: /^(Ignore|Restore)$/ }) });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Ignore", exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(row).toHaveCount(0);
    await page.getByRole("switch", { name: /Show ignored items/ }).click();
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(row.getByRole("button", { name: "Ignore", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});
