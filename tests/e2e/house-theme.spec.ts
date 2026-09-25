/**
 * The reported defect, in a real browser: **the House workspace rendered light while the rest of
 * the interface was dark**, and the tree's search field was unreadable.
 *
 * Every assertion here compares against the tokens read from the live `<html>` rather than against
 * a hex literal, so re-tuning the dark ramp in `globals.css` is not a test change — the test is
 * "the workspace uses the tokens", not "the workspace is #161513".
 *
 * The last two cases cover the feature the defect asked for: a configurable background, and the
 * `alpha: true` switch that makes a CSS gradient possible without a shader.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { e2eBaseUrl } from "./fixtures";
import {
  houseClientIp,
  openHouse,
  openRenderingCategory,
  vh,
  waitForHook,
  waitForStableFrames,
} from "./helpers/house";

/** Read the resolved `--vh-*` custom properties the page is actually painting with. */
async function tokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const names = ["--vh-paper-0", "--vh-paper-1", "--vh-paper-2", "--vh-viewport", "--vh-ink-1"];
    const out: Record<string, string> = {};
    for (const name of names) out[name] = style.getPropertyValue(name).trim();
    return out;
  });
}

/** `#rrggbb` → the `rgb(r, g, b)` string `getComputedStyle` hands back. */
function toRgb(hex: string): string {
  const body = hex.replace("#", "");
  const n = Number.parseInt(body, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/**
 * A dark context of its own.
 *
 * `colorScheme: "dark"` makes `prefers-color-scheme` match, which is the *system* path through the
 * token blocks — the one the owner was on when the workspace stayed light. The explicit
 * `data-theme="dark"` path is checked separately below.
 */
async function darkHouse(browser: Browser, options: { sel?: string } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: e2eBaseUrl(),
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
    extraHTTPHeaders: { "x-forwarded-for": houseClientIp() },
  });
  const page = await context.newPage();
  await openHouse(page, options);
  return { context, page };
}

/**
 * Run an interaction with the control and wait for the write it triggers to come back.
 *
 * The control applies optimistically and debounces the write by 600 ms (the same debounce the
 * surface-colour picker uses), so "the host repainted" is *not* evidence the database has it. A
 * server action is a POST to the current URL, which is the honest thing to wait on before a reload.
 */
async function withSavedBackground(page: Page, interact: () => Promise<void>): Promise<void> {
  await openRenderingCategory(page, "Background");
  const write = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/house"),
    { timeout: 15_000 },
  );
  await interact();
  await write;
}

/**
 * Put the household background back to "follow the theme".
 *
 * The e2e projects share one database, so a background left behind here would be the background
 * `house.spec.ts` runs against. Done through the control rather than the database, so the cleanup
 * also exercises the path back to the default.
 */
async function resetBackground(page: Page): Promise<void> {
  await withSavedBackground(page, async () => {
    await page
      .getByRole("radiogroup", { name: "3D background" })
      .getByRole("radio", { name: "Theme" })
      .click();
  });
  await expect(page.getByTestId("vh-canvas-host")).not.toHaveAttribute("style", /background/);
}

test.describe("the House workspace follows the interface theme", () => {
  test("the shell, both panels and the canvas host paint the dark tokens", async ({ browser }) => {
    // A selection, so the floating inspector is on screen too.
    const { context, page } = await darkHouse(browser, { sel: "room:r-l-a" });
    try {
      const t = await tokens(page);
      // Sanity: a dark context really did select the dark ramp. Without this the assertions below
      // would pass just as well against the light palette.
      expect(t["--vh-paper-0"]).toBeTruthy();
      expect(t["--vh-paper-0"]).not.toBe("#faf9f5");

      const bg = (selector: string) =>
        page.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor);

      // The gutter the three regions sit in.
      expect(await bg('[data-testid="vh-workspace"]')).toBe(toRgb(t["--vh-paper-0"] as string));
      // Property browser and inspector: panel surfaces. The inspector floats over the canvas as
      // the same surface token at 95 % (`bg-surface/95`, a colour-mix the browser reports in its
      // own colour space), so it is compared with a probe element painted by that same utility.
      expect(await bg('aside[aria-label="Property browser"]')).toBe(
        toRgb(t["--vh-paper-1"] as string),
      );
      const translucentSurface = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "bg-surface/95";
        document.body.append(probe);
        const colour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return colour;
      });
      expect(await bg('aside[aria-label="Inspector"]')).toBe(translucentSurface);
      expect(translucentSurface).not.toBe("rgb(255, 255, 255)");
      // The 3D view's own ground, which used to be a hardcoded `#f4f4f2`.
      expect(await bg('[data-testid="vh-canvas-host"]')).toBe(
        toRgb(t["--vh-viewport"] as string),
      );
    } finally {
      await context.close();
    }
  });

  test("nothing inside the workspace is painted white", async ({ browser }) => {
    const { context, page } = await darkHouse(browser);
    try {
      await waitForStableFrames(page);
      const white = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="vh-workspace"]');
        if (!root) throw new Error("the workspace region is missing");
        const offenders: string[] = [];
        for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
          if (getComputedStyle(el).backgroundColor !== "rgb(255, 255, 255)") continue;
          const id = el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? "";
          offenders.push(
            `${el.tagName.toLowerCase()}${id ? `[${id}]` : ""}.${el.className.toString().slice(0, 80)}`,
          );
        }
        return offenders;
      });
      expect(white, `these elements are still opaque white in dark mode:\n${white.join("\n")}`)
        .toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("the property browser's search field is readable", async ({ browser }) => {
    const { context, page } = await darkHouse(browser);
    try {
      const field = page.getByLabel("Search the property");
      await expect(field).toBeVisible();

      const measured = await field.evaluate((el) => {
        const style = getComputedStyle(el);
        const placeholder = getComputedStyle(el, "::placeholder");
        return {
          color: style.color,
          background: style.backgroundColor,
          placeholder: placeholder.color,
        };
      });

      // The reported symptom: the placeholder was the same value as the field it sat in.
      expect(measured.placeholder).not.toBe(measured.background);
      expect(measured.color).not.toBe(measured.background);

      const t = await tokens(page);
      // The typed text is the light ink of the dark ramp, not a dark ink on a dark field.
      expect(measured.color).toBe(toRgb(t["--vh-ink-1"] as string));
      // And the field itself is the sunken token surface, not white.
      expect(measured.background).toBe(toRgb(t["--vh-paper-2"] as string));

      // Still functional: the field is a real search box, not just a readable box. Scoped to the
      // browser panel because the canvas host carries a hidden mirror list of the same room names.
      await field.fill("Room A");
      await expect(
        page.locator('aside[aria-label="Property browser"]').getByRole("button", { name: /^Room A/ }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("an explicitly pinned dark theme wins over a light system preference", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: e2eBaseUrl(),
      viewport: { width: 1600, height: 1000 },
      colorScheme: "light",
      extraHTTPHeaders: { "x-forwarded-for": houseClientIp() },
    });
    try {
      const page = await context.newPage();
      await openHouse(page);

      const light = await tokens(page);
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();

      // Through the account menu, the way a person would.
      await page.getByRole("button", { name: /^Account:/ }).click();
      await page
        .getByRole("radiogroup", { name: "Appearance" })
        .getByRole("radio", { name: "Dark" })
        .click();
      await page.keyboard.press("Escape");

      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
      const dark = await tokens(page);
      expect(dark["--vh-paper-0"]).not.toBe(light["--vh-paper-0"]);
      expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");

      // And it survives a reload with no flash of light: the blocking script in <head> has already
      // set the attribute by the time anything paints.
      await page.reload();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
      expect((await tokens(page))["--vh-paper-0"]).toBe(dark["--vh-paper-0"]);

      // Leave the browser as it was found; the choice is per-browser, in localStorage.
      await page.getByRole("button", { name: /^Account:/ }).click();
      await page
        .getByRole("radiogroup", { name: "Appearance" })
        .getByRole("radio", { name: "System" })
        .click();
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});

test.describe("the configurable 3D background", () => {
  test("a chosen solid colour paints the host and survives a reload", async ({ browser }) => {
    const { context, page } = await darkHouse(browser);
    try {
      const host = page.getByTestId("vh-canvas-host");
      // Following the theme means no inline style at all — the `bg-viewport` token is in charge.
      await expect(host).not.toHaveAttribute("style", /background/);

      const group = page.getByRole("radiogroup", { name: "3D background" });
      await withSavedBackground(page, async () => {
        await group.getByRole("radio", { name: "Colour" }).click();
      });

      await withSavedBackground(page, async () => {
        await page.getByLabel("Background colour").fill("#123456");
      });

      // The optimistic apply is immediate; the write is debounced behind it.
      await expect(host).toHaveAttribute("style", /background-color:\s*rgb\(18,\s*52,\s*86\)/);

      // Persisted: a reload gets it from the server, on the first paint, with no default in between.
      await page.reload();
      await waitForHook(page);
      await vh(page).settled();
      await expect(page.getByTestId("vh-canvas-host")).toHaveAttribute(
        "style",
        /background-color:\s*rgb\(18,\s*52,\s*86\)/,
      );

      // A preset lands too, and a gradient is a plain CSS gradient rather than a scene texture.
      await withSavedBackground(page, async () => {
        await page.getByRole("button", { name: "Cool fade, dark" }).click();
      });
      await expect(page.getByTestId("vh-canvas-host")).toHaveAttribute("style", /linear-gradient/);
    } finally {
      await resetBackground(page).catch(() => undefined);
      await context.close();
    }
  });

  test("the transparent context costs nothing: still ready, same shader inventory", async ({
    browser,
  }) => {
    const { context, page } = await darkHouse(browser);
    try {
      await vh(page).ready();
      expect((await vh(page).status()).phase).toBe("ready");

      // `alpha: true` changes the drawing buffer, not the materials. The absolute inventory is
      // pinned once, in `house.spec.ts` (surface, edge, lighting and shadow programs); this test is
      // about the delta, so it only needs a compiled scene to compare against.
      const before = await vh(page).renderInfo();
      expect(before.programs).toBeGreaterThan(0);

      // A background change must not compile a program or add a draw call — it is CSS.
      await withSavedBackground(page, async () => {
        await page
          .getByRole("radiogroup", { name: "3D background" })
          .getByRole("radio", { name: "Colour" })
          .click();
      });
      await withSavedBackground(page, async () => {
        await page.getByLabel("Background colour").fill("#0b0d10");
      });
      await waitForStableFrames(page);

      const after = await vh(page).renderInfo();
      expect(after.programs).toBe(before.programs);
      expect(after.geometries).toBe(before.geometries);
      expect((await vh(page).status()).phase).toBe("ready");
    } finally {
      await resetBackground(page).catch(() => undefined);
      await context.close();
    }
  });

  test("the same control renders on Settings → Household", async ({ browser }) => {
    // A server/client boundary mistake in the Appearance panel would only show at runtime, and the
    // control is the household's other route to this setting — so it gets its own smoke test.
    const { context, page } = await darkHouse(browser);
    try {
      await page.goto("/settings/household");
      await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
      const group = page.getByRole("radiogroup", { name: "3D background" });
      await expect(group).toBeVisible();
      await expect(group.getByRole("radio", { name: "Theme" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      // The copy has to say whose setting this is.
      await expect(page.getByText(/household setting, like the time zone/)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
