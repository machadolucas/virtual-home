import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import manifest from "../fixtures/model/house-model/model.json";
import { login, nextClientIp } from "./fixtures";

test("a household member can review a captured fix and attach a headset screenshot", async ({page}, info) => {
  await page.context().setExtraHTTPHeaders({"x-forwarded-for":nextClientIp()});
  const base = `/api/house-model/${manifest.modelId}`;
  expect((await page.request.get(base + "/fixes")).status()).toBe(401);
  await page.addInitScript(() => {
    const xr = Object.assign(new EventTarget(), { isSessionSupported: async (mode: string) => mode === "immersive-vr" });
    Object.defineProperty(navigator, "xr", {configurable:true,value:xr});
  });
  await login(page, "marja", {next:"/house"});
  await expect(page.getByRole("button", {name:"Enter VR",exact:true})).toBeVisible();
  await expect(page.getByRole("button", {name:"Enter mixed reality",exact:true})).toHaveCount(0);
  await page.getByText("Quest controls", {exact:true}).click();
  await expect(page.getByText(/steer the landing arrow with the left stick/)).toBeVisible();
  await page.getByText("Quest controls", {exact:true}).click();
  const installed = await page.request.get(base + "/status");
  expect(installed.ok()).toBe(true);
  const {fingerprint} = await installed.json();
  const room = manifest.rooms[0]!;
  const context = { floorId: room.floorId, roomId: room.id };
  const selectedSpan = [[1.9, 1.9, 2], [2.3, 1.9, 2]];
  const duct = await page.request.put(base + "/routes", {data: {
    fingerprint, viewMode: "normal",
    route: { name: "Fixture overhead duct", system: "ventilation", medium: "supply_air",
      lifecycle: "installed", flowState: "active", certainty: "inferred",
      points: selectedSpan.map(position => ({position, ...context})) },
  }});
  expect(duct.ok(), await duct.text()).toBe(true);
  const {route} = await duct.json();
  const routeMeasurement = { routeId: route.id, ...context, selectedSpan,
    position: [2.37, 1.91, 2], method: "two_aims", registrationErrorM: 0.025 };
  const png = await sharp({create:{width:24,height:24,channels:4,background:"#559967"}}).png().toBuffer();
  const payload = {metadata: JSON.stringify({requestId:randomUUID(),fingerprint,
    viewpoint:{mode:"mr", camera:{position:[1,1.65,2],target:[1,1.65,1],projection:"perspective"},overlay:"both",
      routeMeasurement, context, view: {selection: {kind: "route", id: route.id}}}}),
    image:{name:"fixture-overlay.png",mimeType:"image/png",buffer:png}};
  const create = await page.request.post(base + "/fixes", {headers:{"x-vh-model-fix":"1"},multipart:payload});
  expect(await create.text()).not.toContain("internal_error");
  expect(create.ok()).toBe(true);
  const fix = await create.json();
  const retry = await page.request.post(base + "/fixes", {headers:{"x-vh-model-fix":"1"}, multipart:payload});
  expect(retry.ok(), await retry.text()).toBe(true);
  expect((await retry.json()).id).toBe(fix.id);
  const detail = await (await page.request.get(base + "/fixes/" + fix.id)).json();
  expect(detail.screenshots).toHaveLength(1);
  expect(detail.screenshots[0].viewpoint.routeMeasurement).toEqual(routeMeasurement);
  const {routes} = await (await page.request.get(base + "/routes")).json();
  expect(routes.find((item: {id: string}) => item.id === route.id).points).toEqual(selectedSpan);
  const name = `Fixture alignment ${info.project.name}`;
  const edited = await page.request.patch(base + "/fixes/" + fix.id, {headers:{"x-vh-model-fix":"1"},
    data:{expectedUpdatedAtMs:fix.updatedAtMs,description:name}});
  expect(edited.ok()).toBe(true);
  await page.getByRole("button", {name:"View",exact:true}).click();
  await page.getByRole("button", {name:"Model fixes",exact:true}).click();
  await page.getByRole("button", {name:new RegExp(name)}).click();
  await expect(page.getByRole("textbox",{name:"Description"})).toHaveValue(name);
  await expect(page.getByText("Measured route position", {exact:true})).toBeVisible();
  await expect(page.getByText(/Two controller aims.*2.5 cm/)).toBeVisible();
  const picker = page.locator('input[type="file"][accept*="image"]').last();
  await picker.setInputFiles({name:"synthetic-headset.png",mimeType:"image/png",buffer:png});
  await expect.poll(async () => (await (await page.request.get(base + "/fixes/" + fix.id)).json()).screenshots.length).toBe(2);
});
