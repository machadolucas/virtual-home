import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { openHouse, waitForStableFrames } from "./helpers/house";
import { installSyntheticHa } from "./helpers/liveHa";

test.use({ serviceWorkers: "block" });

test("outdoor trees leave terrain-relative trunks in contextual views and restore full crowns", async ({ page }, info) => {
  test.skip(info.project.name.includes("phone"), "Shared renderer, with desktop wall controls.");
  await installSyntheticHa(page);
  const shaderErrors: string[] = [];
  page.on("console", message => { if (/shader error|VALIDATE_STATUS|Error compiling|linkProgram/i.test(message.text())) shaderErrors.push(message.text()); });
  const base = { modelId: "fixture-house", rotationYDeg: 0, floorId: "f-lower", roomId: null, surfaceId: "s-e-terrain-fx",
    mount: { kind: "free", height: 0 }, locationNote: "", photoId: null, category: "outdoor", linkedEntities: [], entityId: null,
    symbol: "tree", treeHeightM: 10 };
  const positions = [[0, -1, 7], [6, 1, 7]];
  await page.route("**/api/house-model/fixture-house/placements*", async route => {
    await route.fulfill({ json: new URL(route.request().url()).searchParams.has("options") ? { placeable: [] } : {
      placements: positions.map((position, i) => ({ ...base, id: `tree-${i}`, equipmentId: `tree-${i}`, name: `Slope tree ${i}`, position })),
      stale: [], partialFields: [],
    } });
  });
  await openHouse(page);
  await expect.poll(() => page.evaluate(() => window.__vh!.trees().reduce((sum, tree) => sum + tree.count, 0))).toBe(2);
  const initial = await page.evaluate(() => window.__vh!.trees());
  expect(initial).toHaveLength(1); // two trees still share one instanced draw call
  expect(initial[0]!.positions).toEqual(positions);
  const camera = await page.evaluate(() => window.__vh!.camera());
  const canvas = page.getByTestId("vh-canvas-host");
  const greenPixels = async (image: Buffer) => {
    const pixels = await sharp(image).removeAlpha().raw().toBuffer();
    let count = 0;
    for (let i = 0; i < pixels.length; i += 3) if (pixels[i + 1]! > pixels[i]! * 1.3 && pixels[i + 1]! > pixels[i + 2]! * 1.3) count++;
    return count;
  };
  await page.getByRole("radio", { name: "All up", exact: true }).click();
  await waitForStableFrames(page);
  const full = await canvas.screenshot();
  const fullGreen = await greenPixels(full);
  expect(fullGreen).toBeGreaterThan(500);
  for (const mode of ["Contextual", "All cut"]) {
    await page.getByRole("radio", { name: mode, exact: true }).click();
    await waitForStableFrames(page);
    const trees = await page.evaluate(() => window.__vh!.trees());
    expect(trees).toEqual([{ ...initial[0], cutHeightM: .9 }]);
    expect(await page.evaluate(() => window.__vh!.selection())).toBeNull();
    expect(await page.evaluate(() => window.__vh!.camera())).toEqual(camera);
    const cut = await canvas.screenshot();
    expect(await greenPixels(cut)).toBeLessThan(fullGreen * .6);
    await info.attach(`trees-${mode}.png`, { body: cut, contentType: "image/png" });
  }
  await page.getByRole("radio", { name: "All up", exact: true }).click();
  await waitForStableFrames(page);
  expect((await page.evaluate(() => window.__vh!.trees()))[0]!.cutHeightM).toBe(10_000);
  expect(await greenPixels(await canvas.screenshot())).toBeGreaterThan(fullGreen * .95);
  expect(shaderErrors).toEqual([]);
  await info.attach("trees-full.png", { body: full, contentType: "image/png" });
});
