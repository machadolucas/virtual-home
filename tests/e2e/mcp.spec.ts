import { test, expect } from "@playwright/test";
import { login, nextClientIp } from "./fixtures";

test("a browser-created credential initializes the compiled MCP endpoint and revokes immediately", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Protocol boundary is independent of viewport.");
  await page.setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  await login(page, "lucas");
  await page.goto("/settings/ai-connections");
  if (!await page.getByLabel("Connection name", { exact: true }).isVisible()) await page.getByRole("button", { name: "Add connection", exact: true }).click();
  const name = `Synthetic protocol check ${Date.now()}`;
  await page.getByLabel("Connection name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create connection", exact: true }).click();
  const secretPanel = page.getByRole("heading", { name: "Save this token now", exact: true }).locator("..");
  await expect(secretPanel).toBeVisible();
  const token = (await secretPanel.locator("code").textContent())!;
  const call = (id: number, method: string, params?: object) => page.request.post("/mcp", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
  });
  const initialized = await call(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-browser-test", version: "1" } });
  expect(initialized.status()).toBe(200);
  expect((await initialized.json()).result.serverInfo.name).toBeTruthy();
  const discovery = await call(2, "tools/list");
  expect(discovery.status()).toBe(200);
  expect((await discovery.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain("search");
  const read = await call(3, "tools/call", { name: "search", arguments: { kind: "equipment", limit: 1 } });
  expect(read.status()).toBe(200);
  expect((await read.json()).result.isError).not.toBe(true);
  await page.getByRole("button", { name: "I saved it · hide", exact: true }).click();
  await page.getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Connection revoked");
  expect((await call(4, "tools/list")).status()).toBe(401);
});
