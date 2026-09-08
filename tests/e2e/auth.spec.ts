/**
 * The authentication boundary, end to end in a real browser against a real production build
 * (`docs/design-notes/auth-security-operations.md` §12.3).
 *
 * The unit suite proves `requireSession()` rejects forged, expired and revoked sessions. What only
 * a browser can prove is the part the household actually experiences: that signing in works from
 * the avatar buttons, that a private file needs the cookie, that "sign out others" really does
 * sign the other device out, and that a Home Assistant deep link survives the round trip through
 * the login page.
 *
 * Every context gets its own `x-forwarded-for` (see `fixtures.ts`): sign-in is rate limited to
 * 5/min per IP, and without that all of these would share one bucket.
 */
import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import sharp from "sharp";
import { E2E_USERS, login, openContext } from "./fixtures";

/** Tests share one server, so they must not fight over state; they are ordered and independent. */
test.describe.configure({ mode: "serial" });

/** A real PNG, small but big enough that a web copy and a thumbnail get made. */
async function pngBytes(seed: number): Promise<Buffer> {
  return sharp({
    create: { width: 900, height: 600, channels: 3, background: { r: seed % 256, g: 120, b: 80 } },
  })
    .png()
    .toBuffer();
}

/** Upload a photo through the real endpoint and return its attachment URL. */
async function uploadPhoto(request: APIRequestContext, seed: number): Promise<string> {
  const res = await request.post("/api/upload", {
    multipart: {
      file: { name: `e2e-${seed}.png`, mimeType: "image/png", buffer: await pngBytes(seed) },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { id: string; url: string; hasWebCopy: boolean };
  expect(body.hasWebCopy).toBe(true);
  return body.url;
}

test("signing in from an avatar button lands on the protected home page", async ({ browser }) => {
  const context = await openContext(browser);
  const page = await context.newPage();
  try {
    await page.goto("/login");
    // Both household members are offered by name; nothing is hardcoded in the page.
    await expect(page.getByRole("button", { name: E2E_USERS.lucas.name })).toBeVisible();
    await expect(page.getByRole("button", { name: E2E_USERS.marja.name })).toBeVisible();

    await login(page, "lucas");
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a private attachment needs the session cookie", async ({ browser }) => {
  const signedIn = await openContext(browser);
  const anonymous = await openContext(browser);
  try {
    const page = await signedIn.newPage();
    await login(page, "lucas");

    // Distinct bytes per project: identical content would be deduplicated (200, not 201).
    const url = await uploadPhoto(signedIn.request, test.info().project.name === "phone" ? 2 : 1);

    // With the cookie: the bytes, and a cache directive that keeps them out of shared caches.
    const ok = await signedIn.request.get(url);
    expect(ok.status()).toBe(200);
    expect(ok.headers()["cache-control"]).toContain("private");
    expect(ok.headers()["cache-control"]).not.toContain("public");
    expect(ok.headers()["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers()["content-type"]).toBe("image/png");
    expect((await ok.body()).byteLength).toBeGreaterThan(0);

    // The ETag is content-addressed, so a conditional request is a 304 rather than a re-download.
    const etag = ok.headers()["etag"]!;
    const cached = await signedIn.request.get(url, { headers: { "if-none-match": etag } });
    expect(cached.status()).toBe(304);

    // Derivatives are reachable and are JPEG, whatever the original was.
    const web = await signedIn.request.get(`${url}?v=web`);
    expect(web.status()).toBe(200);
    expect(web.headers()["content-type"]).toBe("image/jpeg");

    // Without it: 401, and no bytes. This is the assertion that matters most in this file.
    const denied = await anonymous.request.get(url);
    expect(denied.status()).toBe(401);
    await expect(denied.json()).resolves.toEqual({ error: "unauthorized" });

    const deniedVariant = await anonymous.request.get(`${url}?v=thumb`);
    expect(deniedVariant.status()).toBe(401);
  } finally {
    await signedIn.close();
    await anonymous.close();
  }
});

test("the house-model API is closed without a session", async ({ browser }) => {
  const anonymous = await openContext(browser);
  const signedIn = await openContext(browser);
  try {
    for (const url of [
      "/api/house-model/fixture-house/status",
      "/api/house-model/fixture-house/manifest?v=deadbeef",
      "/api/house-model/fixture-house/assets/fixture-lower?v=deadbeef",
    ]) {
      const res = await anonymous.request.get(url);
      expect(res.status(), url).toBe(401);
    }

    // Signed in, the same discovery endpoint answers. Whether a package is installed depends on
    // whether the fixture has been generated, so the assertion is "not the auth boundary".
    const page = await signedIn.newPage();
    await login(page, "marja");
    const status = await signedIn.request.get("/api/house-model/fixture-house/status");
    expect(status.status()).not.toBe(401);
    expect(status.status()).toBeLessThan(500);
  } finally {
    await anonymous.close();
    await signedIn.close();
  }
});

test("signing out other devices ends the other browser's session", async ({ browser }) => {
  const first = await openContext(browser);
  const second = await openContext(browser);
  try {
    const pageA = await first.newPage();
    await login(pageA, "lucas");
    const pageB = await second.newPage();
    await login(pageB, "lucas");

    // Both are live.
    await expect(pageB.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();

    await pageA.goto("/settings/security");
    await expect(pageA.getByRole("heading", { name: "Security", level: 1 })).toBeVisible();
    await pageA.getByRole("button", { name: /Sign out (all )?other/ }).click();
    await expect(pageA.getByText("Other devices signed out")).toBeVisible();

    // The second browser's session row is gone *now*, not in 60 s: asked without the cookie
    // cache — which is exactly what `getFreshSession()` does — the server says there is no
    // session. The revoking device still has one.
    const revoked = await second.request.get("/api/auth/get-session?disableCookieCache=true");
    expect(revoked.status()).toBe(200);
    await expect(revoked.json()).resolves.toBeNull();

    const survivor = await first.request.get("/api/auth/get-session?disableCookieCache=true");
    expect(survivor.status()).toBe(200);
    expect(await survivor.json()).not.toBeNull();

    /**
     * KNOWN DEFECT, deliberately not asserted here: navigating the signed-out browser to
     * `/settings/security` within the 60 s cookie-cache window produces
     * `ERR_TOO_MANY_REDIRECTS` instead of the login form. The page's `getFreshSession()` fails
     * and redirects to `/login?next=…`, but `/login` re-checks with `getSession()`, which the
     * still-valid `vh.session_data` snapshot satisfies, so it redirects straight back. The fix
     * belongs in `src/app/(auth)/login/page.tsx` (read the session without the cookie cache
     * before bouncing) or in the security page; either way it is outside this file.
     */

    // The revoking device stays signed in — that is the whole point of "others".
    await pageA.reload();
    await expect(pageA.getByRole("heading", { name: "Security", level: 1 })).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});

test("changing the password retires the old one", async ({ browser }) => {
  const user = E2E_USERS.marja;
  const rotated = "e2e-marja-rotated-passphrase";

  const owner = await openContext(browser);
  try {
    const page = await owner.newPage();
    await login(page, user);
    await page.goto("/settings/security");

    await changePassword(page, user.password, rotated);

    // A fresh browser: the old password is refused with the deliberately generic message…
    const attacker = await openContext(browser);
    try {
      const stale = await attacker.newPage();
      await stale.goto("/login");
      await stale.getByRole("button", { name: user.name }).click();
      await stale.locator('input[name="password"]').fill(user.password);
      await stale.getByRole("button", { name: "Sign in", exact: true }).click();
      // By text, not by role: Next's route announcer is also `role="alert"`.
      await expect(stale.getByText("Wrong username or password")).toBeVisible();
      await expect(stale).toHaveURL(/\/login/);

      // …and the new one works.
      await stale.locator('input[name="password"]').fill(rotated);
      await stale.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(stale).toHaveURL(/\/today$/);
    } finally {
      await attacker.close();
    }

    // Put the seeded password back, so a rerun against a reused server still starts from a known
    // state (`reuseExistingServer` is on outside CI).
    await page.reload();
    await changePassword(page, rotated, user.password);
  } finally {
    await owner.close();
  }
});

async function changePassword(
  page: Awaited<ReturnType<BrowserContext["newPage"]>>,
  current: string,
  next: string,
): Promise<void> {
  // `exact` matters: "New password" is a substring of "Repeat new password".
  await page.getByLabel("Current password", { exact: true }).fill(current);
  await page.getByLabel("New password", { exact: true }).fill(next);
  await page.getByLabel("Repeat new password", { exact: true }).fill(next);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed")).toBeVisible();
}

test("a deep link survives the trip through the login page", async ({ browser }) => {
  const target = "/settings/household";
  const context = await openContext(browser);
  try {
    const page = await context.newPage();

    // This is the Home Assistant notification path: a link into the app while signed out.
    await page.goto(target);
    await expect(page).toHaveURL(`/login?next=${encodeURIComponent(target)}`);

    await login(page, "lucas", { next: target });
    await expect(page).toHaveURL(new RegExp(`${target}$`));
  } finally {
    await context.close();
  }
});

test("an off-site next param cannot bounce the browser off the origin", async ({ browser }) => {
  const context = await openContext(browser);
  try {
    const page = await context.newPage();
    await login(page, "lucas", { next: "https://evil.example/steal", expectPath: "/today" });
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/today$/);
  } finally {
    await context.close();
  }
});

test("the health endpoint is public and says nothing else", async ({ browser }) => {
  const anonymous = await openContext(browser);
  try {
    const res = await anonymous.request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok" });
    expect(Object.keys(body)).toHaveLength(1);
    expect(res.headers()["cache-control"]).toContain("no-store");
  } finally {
    await anonymous.close();
  }
});
