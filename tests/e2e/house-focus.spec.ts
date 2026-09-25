import { expect, test } from "@playwright/test";
import { openHouseSession, vh, waitForStableFrames } from "./helpers/house";

test("property focus frames buildings and outdoor areas, and reveals rooms from above", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name.includes("phone"), "The property browser is a desktop panel.");
  const { context, page } = await openHouseSession(browser);
  try {
    // The scoped browser starts at the property: the address-only package root is omitted, and the
    // top level lists the building and Outside rather than every room. Browsing a row never moves
    // the camera; its Frame button selects and frames it.
    const panel = page.getByRole("complementary", { name: "Property browser" });
    const frame = (label: string) => panel.getByRole("button", { name: `Frame ${label}`, exact: true });
    const browse = (label: string) => panel.getByRole("button", { name: `Browse ${label}`, exact: true });
    await expect(browse("Fixture house")).toBeVisible();
    await expect(browse("Outside")).toBeVisible();
    await expect(frame("Room A")).toHaveCount(0);
    const building = frame("Fixture house");
    await building.click();
    await waitForStableFrames(page);
    const buildingCamera = await page.evaluate(() => window.__vh!.camera());
    // Floor focus is the floor control: perspective, isolate the floor, frame it from above.
    const floors = page.getByRole("region", { name: "Floor focus" });
    await floors.getByRole("button", { name: "Lower floor", exact: true }).click();
    await waitForStableFrames(page);
    const floorCamera = await page.evaluate(() => window.__vh!.camera());
    expect(floorCamera.projection).toBe("perspective");
    const floorDx = floorCamera.position[0] - floorCamera.target[0];
    const floorDy = floorCamera.position[1] - floorCamera.target[1];
    const floorDz = floorCamera.position[2] - floorCamera.target[2];
    expect(Math.hypot(floorDx, floorDz) / floorDy).toBeLessThan(0.05);
    await browse("Fixture house").click();
    await browse("Lower floor").click();
    await frame("Room A").click();
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
    // Tilted with the keyboard (ArrowDown = 5° of polar per press, the documented orbit path) rather
    // than a scripted mouse drag: the regression is about which controls instance the listener is
    // attached to, not about pointer input, and WebKit intermittently turned the same synthetic
    // drag into only a few degrees of rotation — too close to overhead for any wall to face the
    // camera. Pointer orbit itself is covered by house.spec.ts ("floor shortcuts … keep camera
    // orbit available").
    await page.getByRole("application", { name: "House 3D view" }).focus();
    // 60° off vertical, then 70° of azimuth: the pose the old drag reached, with the camera beyond
    // Room A's exterior side, which is what makes those faces "camera-facing" in this fixture.
    for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowDown");
    for (let i = 0; i < 14; i++) await page.keyboard.press("ArrowLeft");
    await waitForStableFrames(page);
    const tiltedCamera = await vh(page).camera();
    const tiltedDx = tiltedCamera.position[0] - tiltedCamera.target[0];
    const tiltedDy = tiltedCamera.position[1] - tiltedCamera.target[1];
    const tiltedDz = tiltedCamera.position[2] - tiltedCamera.target[2];
    expect(tiltedDy).toBeGreaterThan(0);
    expect(Math.hypot(tiltedDx, tiltedDz) / tiltedDy).toBeGreaterThan(1);
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
    await floors.getByRole("button", { name: "All", exact: true }).click();
    await panel.getByRole("navigation", { name: "House location" }).getByRole("button", { name: "Property", exact: true }).click();
    await building.click();
    await waitForStableFrames(page);
    expect(await page.evaluate(() => window.__vh!.visible("fixture-upper", "f-upper"))).toBe(true);
    expect(await page.evaluate(() => window.__vh!.visible("fixture-roof", "e-roof-fx"))).toBe(true);

    // Browsing Outside opens its Trees category; the yard itself is listed under Rooms (places).
    await browse("Outside").click();
    await panel.getByRole("button", { name: "Rooms", exact: true }).click();
    await frame("Yard").click();
    await waitForStableFrames(page);
    expect(await page.evaluate(() => window.__vh!.selection())).toEqual({ kind: "element", id: "e-terrain-fx" });
    expect(await page.evaluate(() => window.__vh!.camera())).not.toEqual(roomCamera);
    expect(await page.evaluate(() => window.__vh!.visible("fixture-terrain", "e-terrain-fx"))).toBe(true);
  } finally {
    await context.close();
  }
});
