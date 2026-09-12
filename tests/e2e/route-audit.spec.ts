import { expect, test, webkit, type Page, type BrowserContextOptions } from "@playwright/test";
import { login, nextClientIp, e2eBaseUrl } from "./fixtures";

const STATIC_ROUTES = [
  "/today", "/house", "/equipment", "/equipment/new", "/equipment/systems",
  "/projects", "/projects/new", "/plans", "/plans/new", "/procedures",
  "/supplies", "/supplies/new", "/supplies/shopping", "/history",
  "/providers", "/providers/new", "/documents", "/notifications", "/search",
  "/settings", "/settings/security", "/settings/household", "/settings/users",
  "/settings/home-assistant", "/settings/model", "/settings/system",
  "/settings/system/integrity", "/settings/ai-connections",
];
const DYNAMIC_ROUTE = /^\/(equipment|supplies|projects|plans|procedures|providers|documents|tasks)\/[0-9a-f-]{36}(?:[?#].*)?$/;

async function choose(page: Page, name: string | RegExp, label: string | RegExp) {
  await page.getByRole("combobox", { name }).click();
  await page.getByRole("option", { name: label, exact: typeof label === "string" }).click();
}
async function open(page: Page, route: string) {
  const response = new URL(page.url()).pathname === route ? null : await page.goto(route);
  if (response) expect(response.status(), route).toBeLessThan(400);
  await expect(page.getByRole("main")).toBeVisible();
  if (route === "/house") await expect(page.getByRole("application", { name: "House 3D view" })).toBeVisible();
  else await expect(page.getByRole("main").getByRole("heading", { level: 1 }).first()).toBeVisible();
  // Capture settled client layouts and let initial link prefetches finish before replacing
  // the document; workflow interactions below use locator readiness instead.
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll("main .overflow-y-auto").forEach(element => { element.scrollTop = 0; }); });
}

test("project links and booking changes work by named records, without copied IDs", async ({ page }, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  await login(page, "lucas");
  const suffix = `${info.project.name} ${Date.now()}`;
  const provider = `Audit provider ${suffix}`, project = `Audit project ${suffix}`, task = `Audit inspection ${suffix}`, doc = `Audit invoice ${suffix}`;

  await open(page, "/providers/new");
  await page.getByLabel(/^Name/).fill(provider);
  await page.getByRole("button", { name: "Save provider", exact: true }).click();
  await expect(page.getByRole("heading", { name: provider, exact: true })).toBeVisible();

  await open(page, "/projects/new");
  await page.getByLabel(/^Name/).fill(project);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("heading", { name: project, exact: true })).toBeVisible();
  const projectUrl = page.url();

  await open(page, "/plans/new");
  await page.getByLabel(/^What needs doing/).fill(task);
  await choose(page, /^What it is attached to/, /Yard lamp/);
  await page.getByRole("radio", { name: /^Once only/ }).check();
  await page.getByLabel(/^Due date/).fill("2026-09-13");
  await page.getByRole("button", { name: "Create the plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/);
  await page.locator('main a[href^="/tasks/"]').first().click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]+$/);
  const taskUrl = page.url();

  await page.getByRole("button", { name: "Book a professional", exact: true }).click();
  await choose(page, /^Provider/, provider);
  await page.getByRole("dialog").getByLabel("Date", { exact: true }).fill("2030-01-20");
  await page.getByRole("dialog").getByLabel("From", { exact: true }).fill("09:30");
  await page.getByRole("dialog").getByLabel("To", { exact: true }).fill("11:00");
  await page.getByRole("button", { name: "Record the booking", exact: true }).click();
  await expect(page.getByRole("button", { name: "Change or cancel the booking" })).toBeVisible();
  await page.getByRole("button", { name: "Change or cancel the booking" }).click();
  await choose(page, /^Where this booking stands/, /^Rescheduled/);
  await page.getByRole("dialog").getByLabel("Date", { exact: true }).fill("2030-01-21");
  await page.getByRole("dialog").getByLabel("From", { exact: true }).fill("10:00");
  await page.getByRole("button", { name: "Save the booking", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Change or cancel the booking" }).click();
  await expect(page.getByRole("dialog").getByLabel("Date", { exact: true })).toHaveValue("2030-01-21");
  await expect(page.getByRole("dialog").getByLabel("From", { exact: true })).toHaveValue("10:00");
  await choose(page, /^Where this booking stands/, /^Cancelled/);
  await page.getByRole("button", { name: "Cancel the booking", exact: true }).click();
  await expect(page.getByRole("button", { name: "Book a professional", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Complete…", exact: true }).click();
  await page.getByRole("button", { name: "Record completion", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Complete…", exact: true })).toHaveCount(0);

  await open(page, "/documents");
  await page.getByRole("button", { name: "New service record", exact: true }).click();
  await page.getByLabel("Document number", { exact: true }).fill(doc);
  await page.getByRole("main").locator("select[name=assetId]").selectOption({ label: "Yard lamp" });
  await page.getByRole("button", { name: "Save service record", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/);

  await page.goto(projectUrl);
  for (const [kind, query] of [["Task", task], ["Completed work", task], ["Service document", doc]]) {
    await choose(page, "What kind", kind!);
    await page.getByRole("searchbox", { name: "Search records", exact: true }).fill(query!);
    await choose(page, "Matching record", new RegExp(query!));
    await page.getByRole("button", { name: "Add link", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add link", exact: true })).toBeDisabled();
  }
  await expect(page.getByRole("link", { name: task, exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(doc) })).toBeVisible();
  const completedLink = page.locator('main a[href^="/history?completion="]').first();
  await completedLink.click();
  await expect(page.getByText("Showing one recorded completion.", { exact: false })).toBeVisible();
  await page.goto(taskUrl);
  await expect(page.getByRole("heading", { name: task, exact: true })).toBeVisible();

  // Give the route audit representative dynamic supply and procedure pages, created through UI.
  await open(page, "/supplies/new");
  await page.getByLabel(/^Name/).fill(`Audit filter ${suffix}`);
  await page.getByRole("button", { name: "Add the item", exact: true }).click();
  await expect(page).toHaveURL(/\/supplies\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: `Audit filter ${suffix}`, exact: true })).toBeVisible();
  await open(page, "/procedures");
  await page.getByRole("button", { name: "New procedure", exact: true }).first().click();
  await page.getByRole("dialog").getByLabel(/^Title/).fill(`Audit procedure ${suffix}`);
  await page.getByRole("button", { name: "Create the draft", exact: true }).click();
  await expect(page).toHaveURL(/\/procedures\/[0-9a-f-]+$/);
});

const surfaces: { name: string; engine?: "webkit"; context: BrowserContextOptions }[] = [
  { name: "desktop", context: { viewport: { width: 1600, height: 1000 } } },
  { name: "narrow-phone", context: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true } },
  { name: "tablet", context: { viewport: { width: 1024, height: 768 }, hasTouch: true } },
  { name: "webkit-phone", engine: "webkit", context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];
for (const surface of surfaces) test(`route/layout audit: ${surface.name}`, async ({ browser }, info) => {
  test.setTimeout(240000);
  const ownedBrowser = surface.engine === "webkit" ? await webkit.launch() : null;
  const context = await (ownedBrowser ?? browser).newContext({ ...surface.context, baseURL: e2eBaseUrl(), extraHTTPHeaders: { "x-forwarded-for": nextClientIp() } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors: string[] = [], serverErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(`${new URL(page.url()).pathname}: ${error.message}`));
  page.on("response", response => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });
  const visited: string[] = [];
  const dynamic = new Set<string>();
  try {
    await login(page, "lucas");
    expect((await context.request.get("/")).status()).toBe(200);
    for (const route of STATIC_ROUTES) {
      await test.step(route, async () => {
        await open(page, route);
        if (route === "/supplies") {
          await page.getByRole("radio", { name: /^Everything/ }).click();
          await expect(page).toHaveURL(/filter=all/);
          await expect(page.locator('main a[href^="/supplies/"]').filter({ hasText: /Audit filter|Private supply/ }).first()).toBeVisible();
        }
        const links = await page.getByRole("main").locator("a[href]").evaluateAll(elements => elements.filter(el => el.getClientRects().length > 0).map(el => el.getAttribute("href") ?? ""));
        for (const link of links) if (DYNAMIC_ROUTE.test(link)) dynamic.add(link);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: `${route} must not horizontally scroll the document` }).toBeLessThanOrEqual(1);
        await expect(page.getByText(/Application error: a (client|server)-side exception/)).toHaveCount(0);
        if (route === "/supplies/shopping") await expect(page.getByText("Nothing to buy", { exact: true })).toBeVisible();
        if (route === "/notifications") await expect(page.getByText(/^No unseen alerts\./)).toBeVisible();
        if (route === "/settings/system/integrity") {
          await expect(page.getByText("All registered attachment files are present.", { exact: true })).toBeVisible();
          await expect(page.getByText("No unreferenced files found.", { exact: true })).toBeVisible();
        }
        await page.screenshot({ path: info.outputPath(`${surface.name}-${route.slice(1).replaceAll("/", "-")}.png`) });
        visited.push(route);
      });
    }
    // One accessible detail for each record family; extra task links are included for their workflow state.
    const sampled = new Map<string, string>();
    for (const route of dynamic) { const family = route.split("/")[1]!; if (!sampled.has(family)) sampled.set(family, route); }
    for (const route of sampled.values()) {
      await open(page, route);
      // Completed tasks may only be reachable through a linked project, so also follow
      // record links discovered on detail pages. Sampling one per family keeps this bounded.
      const nestedLinks = await page.getByRole("main").locator("a[href]").evaluateAll(elements => elements.map(element => element.getAttribute("href") ?? ""));
      for (const link of nestedLinks) {
        const family = link.split("/")[1]!;
        if (DYNAMIC_ROUTE.test(link) && !sampled.has(family)) sampled.set(family, link);
      }
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: `${route}: document overflow` }).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(`${surface.name}-detail-${route.split("/")[1]}.png`) });
      visited.push(route);
    }
    expect([...sampled.keys()].sort(), "all eight fixture record families were audited").toEqual(["documents", "equipment", "plans", "procedures", "projects", "providers", "supplies", "tasks"]);
    await info.attach("route-audit", { body: JSON.stringify({ surface: surface.name, visited, pageErrors, serverErrors }, null, 2), contentType: "application/json" });
    expect(pageErrors, "uncaught browser errors").toEqual([]);
    expect(serverErrors, "HTTP server errors").toEqual([]);
  } finally { await context.close(); await ownedBrowser?.close(); }
});

test("private equipment, supply and project metadata stays private without a valid session", async ({ browser }, info) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ baseURL: e2eBaseUrl(), extraHTTPHeaders: { "x-forwarded-for": nextClientIp() } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const targets: { route: string; name: string }[] = [];
  try {
    await login(page, "lucas");
    const privateSuffix = `Metadata ${Date.now()}`;
    await open(page, "/supplies/new");
    await page.getByLabel(/^Name/).fill(`Private supply ${privateSuffix}`);
    await page.getByRole("button", { name: "Add the item", exact: true }).click();
    await expect(page).toHaveURL(/\/supplies\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: `Private supply ${privateSuffix}`, exact: true })).toBeVisible();
    targets.push({ route: new URL(page.url()).pathname, name: `Private supply ${privateSuffix}` });
    await open(page, "/projects/new");
    await page.getByLabel(/^Name/).fill(`Private project ${privateSuffix}`);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: `Private project ${privateSuffix}`, exact: true })).toBeVisible();
    targets.push({ route: new URL(page.url()).pathname, name: `Private project ${privateSuffix}` });
    await open(page, "/equipment");
    await page.getByRole("link", { name: /^Yard lamp/ }).click();
    await expect(page.getByRole("heading", { name: "Yard lamp", exact: true })).toBeVisible();
    targets.push({ route: new URL(page.url()).pathname, name: "Yard lamp" });
    for (const target of targets) {
      const response = await context.request.get(target.route);
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain(target.name);
    }
    const token = (await context.cookies()).find(cookie => cookie.name.endsWith(".session_token"));
    expect(token).toBeDefined();
    // Retain the real signed token, then revoke its session. Omit the short cookie-cache blob.
    const signedOut = await context.request.post("/api/auth/sign-out", { data: {}, headers: { origin: e2eBaseUrl() } });
    expect(signedOut.ok()).toBe(true);
    for (const mode of ["no-cookie", "revoked-cookie"] as const) {
      const attacker = await browser.newContext({ baseURL: e2eBaseUrl(), extraHTTPHeaders: { "x-forwarded-for": nextClientIp() } });
      try {
        if (mode === "revoked-cookie") await attacker.addCookies([token!]);
        for (const target of targets) {
          const response = await attacker.request.get(target.route, { maxRedirects: 0, headers: { "sec-fetch-mode": "navigate", accept: "text/html" } });
          const body = await response.text();
          expect(response.status(), `${mode} ${target.route}`).toBeLessThan(500);
          expect(body, `${mode}: metadata/body must not expose ${target.name}`).not.toContain(target.name);
          expect(response.headers()["location"] ?? body, `${mode}: rejected session redirects to login`).toContain("/login");
        }
      } finally { await attacker.close(); }
    }
    await info.attach("private-metadata-cases", { body: JSON.stringify({ families: targets.map(target => target.route.split("/")[1]), modes: ["no-cookie", "revoked-cookie"] }), contentType: "application/json" });
  } finally { await context.close(); }
});
