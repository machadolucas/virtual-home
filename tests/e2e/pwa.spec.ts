import { expect, test } from "@playwright/test";
import { login, openContext } from "./fixtures";

test("the tablet PWA installs a public shell without caching household pages", async ({ browser }) => {
  const context = await openContext(browser);
  const page = await context.newPage();

  try {
    // Installation metadata and every declared Android icon are public. The generated icon names
    // may change, so the browser test follows the manifest rather than duplicating them here.
    const manifestResponse = await context.request.get("/manifest.webmanifest");
    expect(manifestResponse.status()).toBe(200);
    expect(manifestResponse.headers()["content-type"]).toContain("manifest");
    const manifest = (await manifestResponse.json()) as {
      display?: string;
      start_url?: string;
      icons?: { src: string; sizes?: string; purpose?: string }[];
    };
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/today");
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );
    for (const icon of manifest.icons ?? []) {
      const response = await context.request.get(icon.src);
      expect(response.status(), icon.src).toBe(200);
      expect(response.headers()["content-type"], icon.src).toBe("image/png");
      expect((await response.body()).subarray(1, 4).toString("ascii"), icon.src).toBe("PNG");
    }

    await login(page, "lucas");

    const appleIconHref = await page
      .locator('link[rel="apple-touch-icon"]')
      .getAttribute("href");
    expect(appleIconHref).toBeTruthy();
    const appleIcon = await context.request.get(appleIconHref!);
    expect(appleIcon.status()).toBe(200);
    expect(appleIcon.headers()["content-type"]).toBe("image/png");

    // `ready` plus a controller proves that registration, install, activation and claim all ran in
    // the production browser. The worker itself must never be served from an HTTP cache.
    const worker = await context.request.get("/sw.js");
    expect(worker.status()).toBe(200);
    expect(worker.headers()["cache-control"]).toContain("no-store");
    expect(worker.headers()["service-worker-allowed"]).toBe("/");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
      .toContain("/sw.js");

    // Exercise a second authenticated document navigation, then inspect the real Cache Storage
    // contents. Only public artwork/shell files and hashed Next build assets are allowed there.
    await page.goto("/settings/system");
    await expect(page.getByRole("heading", { name: "System", level: 1 })).toBeVisible();
    const cachedBeforeOffline = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls = (
        await Promise.all(
          names.map(async (name) => (await (await caches.open(name)).keys()).map((entry) => entry.url)),
        )
      ).flat();
      return {
        urls,
        today: Boolean(await caches.match("/today")),
        system: Boolean(await caches.match("/settings/system")),
        events: Boolean(await caches.match("/api/events")),
      };
    });
    expect(cachedBeforeOffline.today).toBe(false);
    expect(cachedBeforeOffline.system).toBe(false);
    expect(cachedBeforeOffline.events).toBe(false);
    for (const value of cachedBeforeOffline.urls) {
      const pathname = new URL(value).pathname;
      expect(
        pathname === "/offline.html" ||
          pathname === "/manifest.webmanifest" ||
          pathname.startsWith("/icons/") ||
          pathname.startsWith("/_next/static/"),
        `unexpected service-worker cache entry: ${value}`,
      ).toBe(true);
    }

    await context.setOffline(true);
    await page.goto("/house", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Connection required", level: 1 })).toBeVisible();
    await expect(page.getByText(/keeps household information on the home server/)).toBeVisible();
    expect(await page.evaluate(() => caches.match("/house").then(Boolean))).toBe(false);
  } finally {
    await context.setOffline(false);
    await context.close();
  }
});
