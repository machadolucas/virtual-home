import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import manifest from "../fixtures/model/house-model/model.json";
import { login, nextClientIp } from "./fixtures";

test("a signed-in member can save, retry and reopen a private fit comparison for the current room", async ({
  page,
}) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextClientIp() });
  const base = "/api/house-model/" + manifest.modelId;
  const url = base + "/fit-proposals",
    roomId = manifest.rooms[0]!.id;
  const roomUrl = url + "?roomId=" + roomId;
  expect((await page.request.get(roomUrl)).status()).toBe(401);
  const finder = base + "/headset/find";
  const equipment = base + "/headset/equipment/missing-placement";
  expect((await page.request.get(finder)).status()).toBe(401);
  expect((await page.request.get(equipment)).status()).toBe(401);
  await login(page, "marja", { next: "/house" });
  expect((await page.request.get(finder+"?purpose=unknown")).status()).toBe(400);
  const found=await page.request.get(finder+"?purpose=water_shutoff");
  expect(found.ok(),await found.text()).toBe(true);
  expect((await found.json()).items).toEqual(expect.any(Array));
  expect((await page.request.get(equipment)).status()).toBe(404);
  const { fingerprint } = await (await page.request.get(base + "/status")).json();
  const draft = {
    spec: { kind: "Cabinet", width: 0.8, height: 0.9, depth: 0.6, reach: 0.4, opening: "Drawer" },
    arrangements: [
      { x: 2, z: 2, yaw: 0 },
      { x: 2.5, z: 2.8, yaw: 90 },
    ],
    preferred: "B",
  };
  const data = { fingerprint, roomId, requestId: randomUUID(), draft };
  const headers = { "x-vh-fit-proposal": "1" };
  expect((await page.request.post(url, { data })).status()).toBe(403);
  expect(
    (
      await page.request.post(url, { data: { ...data, fingerprint: "obsolete-revision" }, headers })
    ).status(),
  ).toBe(409);
  const saved = await page.request.post(url, { data, headers });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { id } = await saved.json();
  expect(await (await page.request.post(url, { data, headers })).json()).toEqual({ id });
  expect(
    (
      await page.request.post(url, { data: { ...data, draft: { ...draft, preferred: "A" } }, headers })
    ).status(),
  ).toBe(409);
  const { proposals } = await (await page.request.get(roomUrl)).json();
  expect(proposals.filter((p: { id: string }) => p.id === id)).toEqual([
    { id, createdAtMs: expect.any(Number), draft },
  ]);
});
