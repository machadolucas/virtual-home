import { expect, test } from "@playwright/test";
import { openHouseSession, openViewSection, vh, waitForHook } from "./helpers/house";

test("area labels can be renamed, hidden globally and restored after reload", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name.includes("phone"), "The persistent room-label form is covered in the desktop inspector.");
  const { context, page } = await openHouseSession(browser, { sel: "room:r-l-a" });
  try {
    // The label form sits behind the room inspector's "Edit room labels" disclosure, and the
    // property browser's search is where a renamed room is found again.
    const panel = page.getByRole("complementary", { name: "Property browser" });
    const renamedRow = panel.getByRole("list", { name: "House items" }).getByRole("button", { name: /^Studio/ });
    await page.locator("summary").filter({ hasText: /^Edit room labels$/ }).click();
    await page.getByLabel("Display name").fill("Studio");
    await page.getByRole("button", { name: "Save label" }).click();
    await panel.getByRole("searchbox", { name: "Search the property" }).fill("Studio");
    await expect(renamedRow.first()).toBeVisible();

    await page.reload();
    await waitForHook(page);
    await vh(page).settled();
    await panel.getByRole("searchbox", { name: "Search the property" }).fill("Studio");
    await expect(renamedRow.first()).toBeVisible();
    await expect(page.locator("ul.sr-only button", { hasText: "Studio" })).not.toHaveCount(0);

    await openViewSection(page, "Visibility");
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
