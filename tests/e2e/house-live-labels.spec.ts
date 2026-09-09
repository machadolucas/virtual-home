import { expect, test } from "@playwright/test";
import { e2eBaseUrl } from "./fixtures";
import {
  deviceOptionsOfProject,
  houseClientIp,
  openHouse,
  vh,
} from "./helpers/house";
import { emitHaBatch, installSyntheticHa, openSyntheticHa } from "./helpers/liveHa";

test("equipment label stays live, expands linked readings, and preserves its saved symbol", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The 3D label overlay is desktop-only.");
  const context = await browser.newContext({
    ...deviceOptionsOfProject(),
    baseURL: e2eBaseUrl(),
    extraHTTPHeaders: { "x-forwarded-for": houseClientIp() },
  });
  const page = await context.newPage();
  let savedPlacement: Record<string, unknown> | null = null;
  const placement = {
    id: "placement-live-climate",
    modelId: "fixture-house",
    equipmentId: "asset-live-climate",
    name: "Live climate sensor",
    position: [1.5, 0.4, 1.5],
    rotationYDeg: 0,
    lightAim: null,
    mount: { kind: "floor", height: 0.4 },
    floorId: "f-lower",
    roomId: "r-l-a",
    surfaceId: null,
    locationNote: "Synthetic browser fixture",
    photoId: null,
    entityId: "sensor.live_temperature",
    linkedEntities: [
      { entityId: "sensor.live_temperature", role: "primary", name: "Temperature", deviceClass: "temperature", unit: "°C" },
      { entityId: "sensor.live_humidity", role: "status", name: "Humidity", deviceClass: "humidity", unit: "%" },
      { entityId: "sensor.live_battery", role: "battery_level", name: "Battery", deviceClass: "battery", unit: "%" },
    ],
    symbol: "lamp_post",
    category: "sensor",
  };

  try {
    await installSyntheticHa(page);
    await page.route("**/api/house-model/fixture-house/placements*", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as { placement: Record<string, unknown> };
        savedPlacement = body.placement;
        await route.fulfill({ json: { placement: { ...placement, ...body.placement }, partialFields: [] } });
        return;
      }
      if (new URL(route.request().url()).searchParams.get("options") === "placeable") {
        await route.fulfill({ json: { placeable: [] } });
        return;
      }
      await route.fulfill({ json: { placements: [placement], stale: [], partialFields: [] } });
    });

    await openHouse(page);
    await openSyntheticHa(page);
    await emitHaBatch(page, [
      { topic: "ha.state", key: "sensor.live_temperature", payload: { state: "21.4", attributes: { unit_of_measurement: "°C", device_class: "temperature" }, lastUpdated: Date.now() } },
      { topic: "ha.state", key: "sensor.live_humidity", payload: { state: "45", attributes: { unit_of_measurement: "%", device_class: "humidity" }, lastUpdated: Date.now() } },
      { topic: "ha.state", key: "sensor.live_battery", payload: { state: "68", attributes: { unit_of_measurement: "%", device_class: "battery" }, lastUpdated: Date.now() } },
    ]);

    await vh(page).select({ kind: "equipment", id: placement.id });
    await page.getByRole("button", { name: "Show me", exact: true }).click();
    const label = page.locator(`[data-anchor="equipment:${placement.id}"]:visible`);
    await expect(label).toBeVisible();
    await expect(label).toContainText(/21\.4 °C.*68%/);
    await expect(label).toHaveAttribute("data-battery-level", "68");
    await expect(label.locator(".vh-battery-icon span span")).toHaveCSS("width", /[1-9]/);

    await emitHaBatch(page, [
      { topic: "ha.state", key: "sensor.live_temperature", payload: { state: "22.1", attributes: { unit_of_measurement: "°C", device_class: "temperature" }, lastUpdated: Date.now() + 1 } },
    ], 2);
    await expect(label).toContainText(/22\.1 °C.*68%/);
    await label.click();
    await expect(label).toContainText(/Temperature: 22\.1 °C · Humidity: 45 %.*68%/);
    await expect(label).toHaveAttribute("aria-expanded", "true");
    await testInfo.attach("expanded-live-label.png", { body: await page.screenshot(), contentType: "image/png" });

    await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect.poll(() => savedPlacement).not.toBeNull();
    expect(savedPlacement).toMatchObject({ symbol: "lamp_post" });
  } finally {
    await context.close();
  }
});
