import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { emitHaBatch, installSyntheticHa, openSyntheticHa } from "./helpers/liveHa";
import { openHouse, openHouseSession, waitForStableFrames } from "./helpers/house";

test("spotlight aim previews independently and survives saving and reopening", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Mouse aiming; phone uses numeric beam angles.");
  const { context, page } = await openHouseSession(browser);
  let placementId: string | undefined;
  try {
    const status = await page.evaluate(() => window.__vh!.status());
    const endpoint = `/api/house-model/${status.modelId}/placements`;
    const available = await (await page.request.get(`${endpoint}?options=placeable`)).json();
    const equipment = available.placeable.find((p: { name: string }) => p.name === "Eave spot");
    expect(equipment).toBeTruthy();
    const response = await page.request.put(endpoint, { data: { fingerprint: status.fingerprint, viewMode: "normal", placement: { equipmentId: equipment.assetId, floorId: "f-lower", roomId: "r-l-a", position: [1, 2, 1], mount: { kind: "free", height: 2 }, symbol: "downlight" } } });
    expect(response.ok()).toBe(true);
    placementId = (await response.json()).placement.id;
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), placementId);
    await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Shown as", exact: true })).toContainText("Downlight");
    const coordinates = await Promise.all(["X", "Y", "Z"].map((axis) => page.getByLabel(`${axis} (m)`, { exact: true }).inputValue()));
    await page.getByRole("button", { name: "Aim in 3D view", exact: true }).click();
    const target = await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!.getBoundingClientRect();
      for (let y = canvas.top + 80; y < canvas.bottom - 50; y += 40) {
        for (let x = canvas.left + 100; x < canvas.right - 80; x += 40) {
          const hit = window.__vh!.pick(x - canvas.left, y - canvas.top);
          if (hit?.surfaceId) return { x, y };
        }
      }
      return null;
    });
    expect(target).not.toBeNull();
    await page.mouse.move(target!.x, target!.y);
    await expect(page.getByLabel("Pitch (°)", { exact: true })).toHaveValue("-90");
    expect(await Promise.all(["X", "Y", "Z"].map((axis) => page.getByLabel(`${axis} (m)`, { exact: true }).inputValue()))).toEqual(coordinates);
    await page.mouse.click(target!.x, target!.y);
    await expect(page.getByRole("button", { name: "Aim in 3D view", exact: true })).toBeVisible();
    expect(await Promise.all(["X", "Y", "Z"].map((axis) => page.getByLabel(`${axis} (m)`, { exact: true }).inputValue()))).toEqual(coordinates);
    await page.getByLabel("Yaw (°)", { exact: true }).fill("35");
    await page.getByLabel("Pitch (°)", { exact: true }).fill("-40");
    await page.getByRole("button", { name: "Save placement", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Adjust placement", exact: true })).toBeHidden();
    await page.reload();
    await page.waitForFunction(() => window.__vh?.status().phase === "ready");
    const reloaded = await (await page.request.get(endpoint)).json();
    expect(reloaded.placements.find((p: { id: string }) => p.id === placementId)).toMatchObject({ symbol: "downlight", lightAim: { yawDeg: 35, pitchDeg: -40 }, position: coordinates.map(Number) });
    await page.evaluate((id) => window.__vh!.select({ kind: "equipment", id: id! }), placementId);
    await page.getByRole("button", { name: "Adjust placement (E)", exact: true }).click();
    await expect(page.getByLabel("Yaw (°)", { exact: true })).toHaveValue("35");
    await expect(page.getByLabel("Pitch (°)", { exact: true })).toHaveValue("-40");
    await waitForStableFrames(page);
    await testInfo.attach("spotlight-aim.png", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "Cancel (Esc)", exact: true }).click();
  } finally {
    if (placementId) await page.request.delete(`/api/house-model/fixture-house/placements/${placementId}`);
    await context.close();
  }
});

test("HA lights fade, settle idle, and illuminate through bounded wall-occluded shadows", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Pixel comparison of desktop room framing.");
  await installSyntheticHa(page);
  const placement = {
    id: "live-light", modelId: "fixture-house", equipmentId: "live-light-equipment", name: "Live test downlight",
    position: [1.5, 2.3, 1.5], rotationYDeg: 0, lightAim: null,
    mount: { kind: "free", height: 2.3 }, floorId: "f-lower", roomId: "r-l-a", surfaceId: null,
    locationNote: "", photoId: null, entityId: "light.live_test", symbol: "downlight", category: "electrical",
    linkedEntities: [{ entityId: "light.live_test", role: "primary", name: "Light", deviceClass: null, unit: null }],
  };
  await page.route("**/api/house-model/fixture-house/placements*", async (route) => {
    const placeable = new URL(route.request().url()).searchParams.has("options");
    await route.fulfill({ json: placeable ? { placeable: [] } : { placements: [placement], stale: [], partialFields: [] } });
  });
  await openHouse(page, { sel: "room:r-l-a" });
  await openSyntheticHa(page);
  const emit = (state: string, brightness = 255, rgb = [255, 60, 20]) => emitHaBatch(page, [{ topic: "ha.state", key: "light.live_test", payload: { state, attributes: { brightness, rgb_color: rgb }, lastUpdated: Date.now() } }]);
  await emit("off");
  await waitForStableFrames(page, 900);
  const canvas = page.locator("canvas").first();
  const off = await sharp(await canvas.screenshot()).removeAlpha().raw().toBuffer();
  const programs = await page.evaluate(() => window.__vh!.renderInfo().programs);
  // Reproduce the long-idle case: the first R3F delta must not consume the whole rapid fade.
  await page.waitForTimeout(1_000);
  const beforeFade = await page.evaluate(() => window.__vh!.invalidateCount());
  const starting = await page.evaluate(() => {
    (window as unknown as { __vhSyntheticHa: { emit(type: string, data: unknown): void } })
      .__vhSyntheticHa.emit("batch", {
        seq: 1,
        items: [{
          topic: "ha.state",
          key: "light.live_test",
          payload: {
            state: "on",
            attributes: { brightness: 255, rgb_color: [255, 60, 20] },
            lastUpdated: Date.now(),
          },
        }],
      });
    return window.__vh!.renderedLights()[0];
  });
  expect(starting).toMatchObject({ id: "live-light", kind: "spot", castShadow: true, shadowMapSize: 256, fading: true });
  expect(starting?.intensity).toBeLessThan(55);
  await expect.poll(() => page.evaluate(() => window.__vh!.lights().length)).toBe(1);
  await waitForStableFrames(page);
  const settled = await page.evaluate(() => window.__vh!.renderedLights()[0]);
  expect(settled).toMatchObject({
    id: "live-light",
    castShadow: true,
    shadowMapAllocated: true,
    fading: false,
  });
  expect(settled?.intensity).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__vh!.renderInfo().shadowMapEnabled)).toBe(true);
  expect(await page.evaluate(() => window.__vh!.invalidateCount())).toBeGreaterThan(beforeFade + 1);
  for (const surfaceId of ["s-w-l-ab--r-l-a", "s-o-l-door-leaf"]) {
    expect(await page.evaluate((id) => window.__vh!.shadowSurface(id), surfaceId)).toMatchObject({
      castShadow: true,
      receiveShadow: true,
      clipShadows: false,
      roughness: 0.94,
    });
  }
  const litImage = await canvas.screenshot();
  const on = await sharp(litImage).removeAlpha().raw().toBuffer();
  let changed = 0;
  for (let i = 0; i < off.length; i += 3) if (Math.abs(off[i]! - on[i]!) + Math.abs(off[i + 1]! - on[i + 1]!) + Math.abs(off[i + 2]! - on[i + 2]!) > 15) changed++;
  expect(changed).toBeGreaterThan(100);
  await testInfo.attach("live-downlight.png", { body: litImage, contentType: "image/png" });
  const shadowPasses = await page.evaluate(() => window.__vh!.shadowPassCount());
  await emit("on", 64, [20, 80, 255]);
  await expect.poll(() => page.evaluate(() => window.__vh!.lights()[0]?.brightness)).toBeCloseTo(64 / 255);
  expect(await page.evaluate(() => window.__vh!.lights()[0]?.color)).toEqual([20 / 255, 80 / 255, 1]);
  await waitForStableFrames(page);
  expect(await page.evaluate(() => window.__vh!.shadowPassCount())).toBe(shadowPasses);
  const fadingOff = await page.evaluate(() => {
    (window as unknown as { __vhSyntheticHa: { emit(type: string, data: unknown): void } })
      .__vhSyntheticHa.emit("batch", {
        seq: 1,
        items: [{
          topic: "ha.state",
          key: "light.live_test",
          payload: { state: "unavailable", attributes: {}, lastUpdated: Date.now() },
        }],
      });
    return window.__vh!.renderedLights()[0];
  });
  expect(fadingOff).toMatchObject({ id: "live-light", fading: true });
  await expect.poll(() => page.evaluate(() => window.__vh!.lights().length)).toBe(0);
  await waitForStableFrames(page);
  expect(await page.evaluate(() => window.__vh!.renderInfo().programs)).toBe(programs);
  const beforeIdle = await page.evaluate(() => window.__vh!.invalidateCount());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__vh!.invalidateCount())).toBe(beforeIdle);
});

test("a lit room does not illuminate the neighbouring room through its wall", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Pixel comparison of desktop room framing.");
  await installSyntheticHa(page);
  const placement = {
    id: "occluded-light", modelId: "fixture-house", equipmentId: "occluded-equipment", name: "Occlusion test lamp",
    position: [2.6, 1.6, 1.9], rotationYDeg: 0, lightAim: null,
    mount: { kind: "free", height: 1.6 }, floorId: "f-lower", roomId: "r-l-a", surfaceId: null,
    locationNote: "", photoId: null, entityId: "light.occlusion_test", symbol: "ceiling_lamp", category: "electrical",
    linkedEntities: [{ entityId: "light.occlusion_test", role: "primary", name: "Light", deviceClass: null, unit: null, source: "entity" }],
  };
  await page.route("**/api/house-model/fixture-house/placements*", async (route) => {
    await route.fulfill({ json: new URL(route.request().url()).searchParams.has("options")
      ? { placeable: [] } : { placements: [placement], stale: [], partialFields: [] } });
  });
  await openHouse(page, { sel: "room:r-l-a" });
  await page.getByRole("button", { name: "Lower floor", exact: true }).click();
  await page.getByRole("application", { name: "House 3D view" }).focus();
  await page.keyboard.press("p");
  await page.getByRole("radio", { name: "All cut", exact: true }).click();
  await openSyntheticHa(page);
  const emit = (state: string) => emitHaBatch(page, [{ topic: "ha.state", key: "light.occlusion_test", payload: { state, attributes: { brightness: 255 }, lastUpdated: Date.now() } }]);
  await emit("off");
  await waitForStableFrames(page, 900);
  const points = await page.evaluate(() => ({
    own: window.__vh!.screenOf([2.4, 0.01, 1.5]),
    next: window.__vh!.screenOf([3.5, -0.19, 1.5]),
  }));
  const canvas = page.locator("canvas").first();
  const off = await sharp(await canvas.screenshot({ scale: "css" })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  await emit("on");
  await waitForStableFrames(page);
  const lit = await canvas.screenshot({ scale: "css" });
  const on = await sharp(lit).removeAlpha().raw().toBuffer();
  const changeAt = (point: number[] | null) => {
    expect(point).not.toBeNull();
    const [x, y] = point!.map(Math.round);
    expect(x).toBeGreaterThan(5); expect(x).toBeLessThan(off.info.width - 5);
    expect(y).toBeGreaterThan(5); expect(y).toBeLessThan(off.info.height - 5);
    let total = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const i = ((y! + dy) * off.info.width + x! + dx) * 3;
      for (let c = 0; c < 3; c++) total += Math.abs(on[i + c]! - off.data[i + c]!);
    }
    return total / (49 * 3);
  };
  const picked = await page.evaluate((points) => ({
    own: points.own ? window.__vh!.pick(...points.own)?.surfaceId : null,
    next: points.next ? window.__vh!.pick(...points.next)?.surfaceId : null,
  }), points);
  await testInfo.attach("occlusion-samples.json", { body: JSON.stringify({ points, picked }), contentType: "application/json" });
  expect(picked.own).toBe("s-r-l-a-floor");
  expect(picked.next).toBe("s-r-l-b-floor");
  const ownChange = changeAt(points.own);
  const neighbouringChange = changeAt(points.next);
  expect(ownChange).toBeGreaterThan(8);
  expect(neighbouringChange).toBeLessThan(ownChange * 0.2);
  await testInfo.attach("wall-light-occlusion.png", { body: lit, contentType: "image/png" });
});
