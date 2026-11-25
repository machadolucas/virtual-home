import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import manifest from "../fixtures/model/house-model/model.json";
import { login, nextClientIp } from "./fixtures";

test("survey entry follows AR capability and saved room evidence opens on desktop and phone", async ({
  page,
}, info) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  const base = `/api/house-model/${manifest.modelId}`;
  expect((await page.request.get(base + "/surveys")).status()).toBe(401);
  await page.addInitScript(() => {
    const xr = Object.assign(new EventTarget(), {
      isSessionSupported: async (mode: string) => mode === "immersive-ar",
    });
    Object.defineProperty(navigator, "xr", { configurable: true, value: xr });
  });
  await login(page, "marja", { next: "/house" });
  await expect(page.getByRole("button", { name: "Survey room", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter VR", exact: true })).toHaveCount(0);
  const { fingerprint } = await (await page.request.get(base + "/status")).json();
  const room = manifest.rooms.find((r) => r.id === "r-l-a")!;
  const headers = { "x-vh-room-survey": "1" };
  const geometry = {
    scope: "full",
    surfaces: [
      {
        source: "mesh",
        label: "table",
        points: [
          [1, 0.8, 1],
          [1.6, 0.8, 1],
          [1, 0.8, 1.6],
        ],
        indices: [0, 1, 2],
      },
    ],
    measurements: [{ kind: "distance", a: [1, 0.8, 1], b: [1.6, 0.8, 1] }],
  };
  const payload = {
    requestId: randomUUID(),
    fingerprint,
    floorId: room.floorId,
    roomId: room.id,
    registrationErrorM: 0.021,
    geometry,
  };
  const saved = await page.request.post(base + "/surveys", { data: payload, headers });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { id } = await saved.json();
  const record = `${base}/surveys/${id}`;
  expect((await (await page.request.get(record + "/geometry")).json()).surfaces).toEqual(geometry.surfaces);
  const note = `Measured fixture ${info.project.name} ${randomUUID().slice(0, 8)}`;
  const observation = await page.request.post(record + "/observations", {
    headers,
    data: { kind: "new_object", requestId: randomUUID(), position: [1, 0.8, 1], description: note },
  });
  expect(observation.ok(), await observation.text()).toBe(true);
  if (info.project.name === "phone") await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("button", { name: "Room surveys", exact: true }).click();
  await page
    .getByRole("button", { name: /Room A.*alignment residual/ })
    .first()
    .click();
  await expect(page.getByText("2.1 cm", { exact: true })).toBeVisible();
  await expect(page.getByText(/Distance · 60.0 cm/)).toBeVisible();
  await page.getByRole("button", { name: "New object observation", exact: true }).click();
  await expect(page.getByText(note, { exact: false }).first()).toBeVisible();
});
