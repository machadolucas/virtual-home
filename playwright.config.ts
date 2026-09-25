import { defineConfig, devices, type PlaywrightTestOptions, type PlaywrightWorkerOptions, type Project } from "@playwright/test";
import { e2eBrowsers } from "./tests/e2e/fixtures";

/**
 * E2E tests run against a production build started by tests/e2e/start-server.ts with an isolated
 * temporary data directory and seeded users (see tests/e2e/README.md).
 */
const PORT = Number(process.env.VH_E2E_PORT ?? 3011);
// `localhost`, not 127.0.0.1: the passkey RP ID is the base URL's hostname, and WebAuthn refuses an
// IP address as an RP ID. The server still binds 127.0.0.1 only (tests/e2e/start-server.ts); the
// health probe below uses that address so it never depends on how `localhost` resolves.
const baseURL = `http://localhost:${PORT}`;

const browsers: ReadonlySet<string> = e2eBrowsers();
type E2eProject = Project<PlaywrightTestOptions, PlaywrightWorkerOptions>;
const ALL_PROJECTS: E2eProject[] = [
  { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } } },
  { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 900 } } },
  { name: "phone-webkit", use: { ...devices["iPhone 14"] } },
  { name: "phone", use: { ...devices["iPhone 14"], browserName: "chromium" } },
];

/** A project's engine: an explicit `browserName`, else the device descriptor's default. */
function engineOf(project: E2eProject): string {
  return project.use?.browserName ?? project.use?.defaultBrowserType ?? "chromium";
}

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // One worker: every project shares one harness database and the same two users, so parallel
  // projects would revoke each other's sessions.
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `pnpm exec tsx tests/e2e/start-server.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { VH_E2E_PORT: String(PORT) },
  },
  // `VH_E2E_BROWSERS=chromium` (or `webkit`) keeps only that engine's projects; the default is all
  // four. See tests/e2e/README.md → "Running on a shared 16 GB home server".
  projects: ALL_PROJECTS.filter((project) => browsers.has(engineOf(project))),
});
