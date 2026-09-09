import { expect, test } from "@playwright/test";
import { openHouseSession, vh, waitForStableFrames } from "./helpers/house";

test("property focus frames buildings and outdoor areas, and reveals rooms from above", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Property tree is a desktop control.");
  const { context, page } = await openHouseSession(browser);
  try {
    const tree = page.getByRole("tree", { name: "Property structure" });
    // The address-only package root is omitted and the everyday hierarchy starts open at rooms.
    await expect(tree.locator('[data-node="property"]')).toHaveCount(0);
    await expect(tree.locator('[data-node="room:r-l-a"]')).toBeVisible();
    const building = tree.locator('[data-node="building:b-fx"]');
    await building.click();
    await waitForStableFrames(page);
    const buildingCamera = await page.evaluate(() => window.__vh!.camera());
    await tree.locator('[data-node="floor:f-lower"]').click();
    await waitForStableFrames(page);
    const floorCamera = await page.evaluate(() => window.__vh!.camera());
    expect(floorCamera.projection).toBe("perspective");
    const floorDx = floorCamera.position[0] - floorCamera.target[0];
    const floorDy = floorCamera.position[1] - floorCamera.target[1];
    const floorDz = floorCamera.position[2] - floorCamera.target[2];
    expect(Math.hypot(floorDx, floorDz) / floorDy).toBeLessThan(0.05);
    await tree.locator('[data-node="room:r-l-a"]').click();
    await waitForStableFrames(page);
    const roomCamera = await page.evaluate(() => window.__vh!.camera());
    expect(roomCamera.target).not.toEqual(buildingCamera.target);
    const dx = roomCamera.position[0] - roomCamera.target[0];
    const dy = roomCamera.position[1] - roomCamera.target[1];
    const dz = roomCamera.position[2] - roomCamera.target[2];
    expect(dy).toBeGreaterThan(0);
    expect(Math.hypot(dx, dz) / dy).toBeLessThan(0.05);
    const revealed = await page.evaluate(() => ({
      roof: window.__vh!.visible("fixture-roof", "e-roof-fx"),
      upper: window.__vh!.visible("fixture-upper", "f-upper"),
      ceiling: window.__vh!.visible("fixture-lower", "s-r-l-a-ceiling"),
      ownWall: window.__vh!.visible("fixture-lower", "s-w-l-ab--r-l-a"),
    }));
    expect(revealed).toEqual({ roof: false, upper: false, ceiling: false, ownWall: true });

    // Orbiting away from the overhead pose must reclassify the camera-side wall cuts on the live
    // controls instance. This failed when the listener remained attached to a discarded instance.
    const canvas = page.locator("canvas").first();
    const canvasBox = (await canvas.boundingBox())!;
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.45, canvasBox.y + canvasBox.height * 0.5);
    await page.mouse.down();
    // Drag upward from polar 0. A downward drag asks CameraControls to move below its minimum and
    // is correctly clamped at the overhead pose, which would produce no camera-facing wall.
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.62, canvasBox.y + canvasBox.height * 0.35, {
      steps: 12,
    });
    await page.mouse.up();
    await waitForStableFrames(page);
    const tiltedCamera = await vh(page).camera();
    const tiltedDx = tiltedCamera.position[0] - tiltedCamera.target[0];
    const tiltedDy = tiltedCamera.position[1] - tiltedCamera.target[1];
    const tiltedDz = tiltedCamera.position[2] - tiltedCamera.target[2];
    expect(Math.hypot(tiltedDx, tiltedDz) / tiltedDy).toBeGreaterThan(0.05);
    const lowerWalls = [
      "s-e-l-ext--r-l-a",
      "s-e-l-ext--r-l-b",
      "s-e-l-ext--r-l-closet",
      "s-w-l-ab--r-l-a",
      "s-w-l-ab--r-l-b",
      "s-w-l-bc--r-l-b",
      "s-w-l-bc--r-l-closet",
    ];
    const focusConstants = await Promise.all(
      lowerWalls.map(async (surfaceId) => (await vh(page).clipPlanes(surfaceId))[2]?.constant ?? 10_000),
    );
    expect(focusConstants.some((constant) => constant < 1_000)).toBe(true);
    await testInfo.attach("room-focus.png", { body: await page.screenshot(), contentType: "image/png" });
    await building.click();
    await waitForStableFrames(page);
    expect(await page.evaluate(() => window.__vh!.visible("fixture-upper", "f-upper"))).toBe(true);
    expect(await page.evaluate(() => window.__vh!.visible("fixture-roof", "e-roof-fx"))).toBe(true);

    await tree.locator('[data-node="outside"]').click();
    await tree.locator('[data-node="element:e-terrain-fx"]').click();
    await waitForStableFrames(page);
    expect(await page.evaluate(() => window.__vh!.selection())).toEqual({ kind: "element", id: "e-terrain-fx" });
    expect(await page.evaluate(() => window.__vh!.camera())).not.toEqual(roomCamera);
    expect(await page.evaluate(() => window.__vh!.visible("fixture-terrain", "e-terrain-fx"))).toBe(true);
  } finally {
    await context.close();
  }
});
