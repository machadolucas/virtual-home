import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a production build started by tests/e2e/start-server.ts with an isolated
 * temporary data directory and seeded users (see tests/e2e/README.md).
 */
const PORT = Number(process.env.VH_E2E_PORT ?? 3011);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `pnpm exec tsx tests/e2e/start-server.ts`,
    url: `${baseURL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { VH_E2E_PORT: String(PORT) },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } } },
    { name: "phone", use: { ...devices["iPhone 14"], browserName: "chromium" } },
  ],
});
