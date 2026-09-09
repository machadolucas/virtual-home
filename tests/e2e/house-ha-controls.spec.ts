import { expect, test } from "@playwright/test";
import type { EquipmentHaControlsResponse } from "@/domain/haControl";
import { openHouseSession } from "./helpers/house";

const plain = { brightness: false, colorTemperature: false, color: false, minKelvin: null, maxKelvin: null };

test("equipment controls match HA capabilities and send explicit commands without pretending state changed", async ({ browser }, testInfo) => {
  const { context, page } = await openHouseSession(browser);
  const commands: Array<{ registryId: string; requestId: string; command: Record<string, unknown> }> = [];
  let offline = false;
  const response: EquipmentHaControlsResponse = { connected: true, entities: [
    { registryId: "reg-light", entityId: "light.test", name: "Color lamp", state: "off", available: true, capabilities: { ...plain, brightness: true, colorTemperature: true, color: true, minKelvin: 2000, maxKelvin: 6500 }, brightness: 128, colorTempKelvin: 2700, rgbColor: [255, 160, 80] },
    { registryId: "reg-dimmer", entityId: "light.dimmer", name: "Dimmer", state: "on", available: true, capabilities: { ...plain, brightness: true }, brightness: 100, colorTempKelvin: null, rgbColor: null },
    { registryId: "reg-switch", entityId: "switch.test", name: "Test socket", state: "off", available: true, capabilities: plain, brightness: null, colorTempKelvin: null, rgbColor: null },
  ] };
  try {
    await page.route("**/api/equipment/asset-control-fixture/controls**", async (route) => {
      if (route.request().method() === "POST") {
        commands.push(route.request().postDataJSON());
        return route.fulfill({ status: 202, json: { commandId: "cmd-fixture", status: "queued", observed: false } });
      }
      if (new URL(route.request().url()).pathname.endsWith("cmd-fixture")) return route.fulfill({ json: { status: "sent", observed: false } });
      return route.fulfill({ json: { ...response, connected: !offline } });
    });
    await page.route("**/api/house-model/fixture-house/placements*", async (route) => route.fulfill({ json: { placements: [{
      id: "control-placement", modelId: "fixture-house", equipmentId: "asset-control-fixture", name: "Control fixture", floorId: "f-lower", roomId: "r-l-a", surfaceId: null,
      position: [1.5, 1, 1.5], rotationYDeg: 0, mount: { kind: "free", height: 1 }, symbol: "wall_lamp", entityId: "light.test", category: "light", linkedEntities: [], locationNote: "", photoId: null,
    }], stale: [], partialFields: [] } }));
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await page.evaluate(() => window.__vh!.select({ kind: "equipment", id: "control-placement" }));
    const panel = page.getByRole("region", { name: "Home Assistant controls", exact: true });
    const lamp = panel.getByRole("group", { name: "Color lamp controls", exact: true });
    const dimmer = panel.getByRole("group", { name: "Dimmer controls", exact: true });
    const socket = panel.getByRole("group", { name: "Test socket controls", exact: true });
    await expect(lamp.getByRole("slider")).toHaveCount(2);
    await expect(dimmer.getByRole("slider")).toHaveCount(1);
    await expect(socket.getByRole("slider")).toHaveCount(0);
    await socket.getByRole("switch").click();
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]).toMatchObject({ registryId: "reg-switch", command: { type: "turn_on" } });
    expect(commands[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(socket.getByRole("status")).toContainText("Sent to Home Assistant");
    await expect(socket.getByRole("switch")).not.toBeChecked();
    await lamp.getByRole("slider", { name: "Color lamp brightness" }).fill("65");
    await lamp.getByRole("slider", { name: "Color lamp white temperature" }).fill("3500");
    await lamp.getByRole("button", { name: "Apply and turn on" }).click();
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]?.command).toEqual({ type: "turn_on", brightness: 166, colorTempKelvin: 3500 });
    await expect(lamp.getByRole("status")).toContainText("Sent to Home Assistant");
    await lamp.getByRole("button", { name: "Color", exact: true }).click();
    await lamp.getByLabel("Color lamp color", { exact: true }).fill("#123456");
    await lamp.getByRole("button", { name: "Apply and turn on" }).click();
    await expect.poll(() => commands.length).toBe(3);
    expect(commands[2]?.command).toEqual({ type: "turn_on", rgbColor: [18, 52, 86] });
    await expect(lamp.getByRole("status")).toContainText("Sent to Home Assistant");
    await testInfo.attach("device-controls.png", { body: await page.screenshot(), contentType: "image/png" });
    offline = true;
    await panel.getByRole("button", { name: "Refresh device controls" }).click();
    await expect(socket.getByRole("switch")).toBeDisabled();
    await expect(lamp.getByRole("button", { name: "Apply and turn on" })).toBeDisabled();
  } finally { await context.close(); }
});
