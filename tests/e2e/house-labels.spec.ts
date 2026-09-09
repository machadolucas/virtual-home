import { expect, test } from "@playwright/test";
import { openHouseSession, vh, waitForHook } from "./helpers/house";

test("area labels can be renamed, hidden globally and restored after reload", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The persistent room-label form is covered in the desktop inspector.");
  const { context, page } = await openHouseSession(browser, { sel: "room:r-l-a" });
  try {
    const tree = page.getByRole("tree", { name: "Property structure" });
    await page.getByLabel("Display name").fill("Studio");
    await page.getByRole("button", { name: "Save label" }).click();
    await expect(tree.locator('[data-node="room:r-l-a"]')).toContainText("Studio");

    await page.reload();
    await waitForHook(page);
    await vh(page).settled();
    await expect(tree.locator('[data-node="room:r-l-a"]')).toContainText("Studio");

    await page.getByRole("tab", { name: "Layers" }).click();
    const areaLabels = page.getByRole("switch", { name: "Area labels" });
    await expect(areaLabels).toBeChecked();
    await areaLabels.click();
    await expect(page.locator("ul.sr-only button", { hasText: "Studio" })).toHaveCount(0);
  } finally {
    // The browser suite shares its synthetic database. Restore the preference even if an assertion
    // fails so this behaviour test cannot rename rooms for an unrelated test.
    await page.evaluate(async () => {
      const status = window.__vh?.status();
      if (!status?.modelId || !status.fingerprint) return;
      await fetch(`/api/house-model/${encodeURIComponent(status.modelId)}/labels`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprint: status.fingerprint,
          write: { nodeId: "r-l-a", displayName: null, visible: null },
        }),
      });
    }).catch(() => undefined);
    await context.close();
  }
});
