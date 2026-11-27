import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";
import { setDbForTests, writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import { attachment, infraRoute, infraRoutePoint, modelFix, modelFixScreenshot, modelNode, modelRevision } from "@/db/schema";
import type { ModelFix, ModelFixResolution } from "@/house/modelFixTypes";
import { createConnection } from "@/server/mcp/auth";
import { deleteAttachment } from "@/server/files/store";
import { UnauthorizedError, requireSession } from "@/server/auth/session";
import { GET as LIST, POST as CREATE } from "@/app/api/house-model/[modelId]/fixes/route";
import { GET as DETAIL, PATCH } from "@/app/api/house-model/[modelId]/fixes/[fixId]/route";
import { POST as ADD_SCREENSHOT } from "@/app/api/house-model/[modelId]/fixes/[fixId]/screenshots/route";
import { POST as ATTACH_QUEST } from "@/app/api/house-model/[modelId]/fixes/[fixId]/screenshots/quest/route";
import { GET as IMAGE } from "@/app/api/house-model/[modelId]/fixes/[fixId]/screenshots/[screenshotId]/[imageIndex]/route";
import { POST as MCP } from "@/app/mcp/route";
import { seedUser, testDb } from "../helpers/db";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/auth/session")>(),
  requireSession: vi.fn(),
}));

const modelId = "synthetic-house";
const fingerprint = "0".repeat(64);
const endpoint = `http://localhost:3010/api/house-model/${modelId}/fixes`;
const context = { params: Promise.resolve({ modelId }) };
const detailContext = (fixId: string) => ({ params: Promise.resolve({ modelId, fixId }) });
const viewpoint = {
  mode: "mr",
  camera: { position: [1, 1.7, 2], target: [2, 1.7, 2], projection: "perspective" },
  overlay: "ducts",
  context: { floorId: "f-ground", roomId: "r-fixture" },
};
let handle: DbHandle;
let actor: string;
let image: Buffer;

beforeEach(async () => {
  handle = testDb();
  setDbForTests(handle);
  actor = seedUser(handle, { username: "fix-reviewer", name: "Fixture Reviewer" }).id;
  vi.mocked(requireSession).mockResolvedValue({ user: { id: actor } } as Awaited<ReturnType<typeof requireSession>>);
  writeTx(handle.db, (tx) => tx.insert(modelRevision).values({
    id: newId(), modelId, contentHash: fingerprint, schemaVersion: "1.0",
    generatedAtMs: 1, coordinateSystemJson: "{}", nodeCount: 0, importedAtMs: 1,
    status: "current", importedBy: actor,
  }).run());
  image = await sharp({
    create: { width: 40, height: 30, channels: 4, background: { r: 210, g: 80, b: 0, alpha: 0.5 } },
  }).png().toBuffer();
});

afterEach(() => {
  vi.clearAllMocks();
  setDbForTests(null);
  handle.close();
});

function captureRequest(input: { id?: string; screenshot?: Buffer; stale?: boolean; second?: Buffer; viewpoint?: object } = {}) {
  const form = new FormData();
  form.set("metadata", JSON.stringify({
    requestId: input.id ?? randomUUID(), fingerprint: input.stale ? "1".repeat(64) : fingerprint, viewpoint: input.viewpoint ?? viewpoint,
  }));
  const append = (buffer: Buffer) => form.append("image", new Blob([new Uint8Array(buffer)]), "fixture.png");
  append(input.screenshot ?? image);
  if (input.second) append(input.second);
  return new Request(endpoint, { method: "POST", headers: { "x-vh-model-fix": "1" }, body: form });
}

async function capture() {
  const response = await CREATE(captureRequest(), context);
  expect(response.status).toBe(200);
  return await response.json() as ModelFix;
}

function patchRequest(fix: ModelFix, body: { status?: string; description?: string; resolution?: ModelFixResolution }) {
  return new Request(`${endpoint}/${fix.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-vh-model-fix": "1" },
    body: JSON.stringify({ expectedUpdatedAtMs: fix.updatedAtMs, ...body }),
  });
}

function questRequest(id = randomUUID()) {
  const form = new FormData();
  form.set("metadata", JSON.stringify({ requestId: id }));
  form.set("image", new Blob([new Uint8Array(image)]), "synthetic-quest-screenshot.png");
  return new Request(endpoint, { method: "POST", headers: { "x-vh-model-fix": "1" }, body: form });
}

describe("private model fixes", () => {
  it("saves a checked observation of an active route from a prior revision exactly once, without moving its geometry", async () => {
    const current = handle.db.select().from(modelRevision).get()!;
    const route = "fixture-supply", floor = "f-ground", room = "r-fixture";
    writeTx(handle.db, tx => {
      tx.insert(modelRevision).values({...current, id:"previous-fixture", contentHash:"2".repeat(64), status:"superseded"}).run();
      tx.insert(modelNode).values({id:newId(), revisionId:current.id, nodeId:room, kind:"room", parentNodeId:floor, name:"Workshop"}).run();
      tx.insert(infraRoute).values({id:route, name:"Supply duct", modelRevisionId:"previous-fixture", medium:"supply_air",
        flowState:"active", createdAtMs:1, updatedAtMs:1}).run();
      tx.insert(infraRoutePoint).values({id:newId(), routeId:route, seq:0, posX:2, posY:3, posZ:1}).run();
    });
    const original = handle.db.select().from(infraRoutePoint).all();
    const mark = {routeId:route, floorId:floor, roomId:room, registrationErrorM:.029, method:"two_aims",
      position:[2.3,2.5,1.2], selectedSpan:[[2,3,1],[2,2.5,1]]};
    const view = {...viewpoint, view:{selection:{kind:"route", id:route}}, routeMeasurement:mark};
    const id = randomUUID(), response = await CREATE(captureRequest({id,viewpoint:view}),context);
    expect(response.status).toBe(200);
    const fix = await response.json() as ModelFix;
    expect(fix).toMatchObject({status:"pending", description:"Measured position for Supply duct in Workshop.",
      screenshots:[{viewpoint:{routeMeasurement:mark}}]});
    expect(await (await CREATE(captureRequest({id,viewpoint:view}),context)).json()).toEqual(fix);
    expect(await (await DETAIL(new Request(endpoint),detailContext(fix.id))).json()).toEqual(fix);
    expect(handle.db.select().from(infraRoutePoint).all()).toEqual(original);
    for (const invalid of [
      {...view, routeMeasurement:{...mark, registrationErrorM:.051}},
      {...view, context:{...viewpoint.context, roomId:"other-room"}},
      {...view, view:{selection:{kind:"route", id:"other-route"}}},
      {...view, mode:"vr"},
      {...view, context:{floorId:floor, roomId:"unknown-room"}, routeMeasurement:{...mark, roomId:"unknown-room"}},
    ]) expect((await CREATE(captureRequest({viewpoint:invalid}),context)).status).toBe(400);
    expect(handle.db.select().from(modelFix).all()).toHaveLength(1);
  });
  it("captures once across concurrent retries and preserves viewpoint and screenshot context", async () => {
    const id = randomUUID();
    const requests = await Promise.all([CREATE(captureRequest({ id }), context), CREATE(captureRequest({ id }), context)]);
    expect(requests.map((response) => response.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(requests.map((response) => response.json() as Promise<ModelFix>));
    expect(first).toEqual(second);
    expect(first?.screenshots).toMatchObject([{ viewpoint, fingerprint, content: "ar_overlay_only", imageCount: 1 }]);
    expect(handle.db.select().from(modelFix).all()).toHaveLength(1);
    expect(handle.db.select().from(modelFixScreenshot).all()).toHaveLength(1);
    expect(handle.db.select().from(attachment).all()).toHaveLength(1);
    expect((await CREATE(captureRequest({ id, stale: true }), context)).status).toBe(409);
  });

  it("keeps capture atomic and permits later description, status, and distinct screenshot edits", async () => {
    expect((await CREATE(captureRequest({ second: Buffer.from("invalid") }), context)).status).toBe(400);
    expect(handle.db.select().from(modelFix).all()).toHaveLength(0);
    expect(handle.db.select().from(attachment).all()).toHaveLength(0);
    expect((await CREATE(captureRequest({ stale: true }), context)).status).toBe(409);
    const fix = await capture();
    const extraId = randomUUID();
    const extra = await ADD_SCREENSHOT(captureRequest({ id: extraId }), detailContext(fix.id));
    expect(extra.status).toBe(200);
    const afterExtra = await extra.json() as ModelFix;
    expect(afterExtra.screenshots).toHaveLength(2);
    const duplicate = await ADD_SCREENSHOT(captureRequest({ id: extraId }), detailContext(fix.id));
    expect(await duplicate.json()).toEqual(afterExtra);
    const staleEdit = await PATCH(patchRequest(fix, { description: "Race" }), detailContext(fix.id));
    expect(staleEdit.status).toBe(409);
    const noReference = await PATCH(patchRequest(afterExtra, { status: "resolved" }), detailContext(fix.id));
    expect(noReference.status).toBe(400);
    const unknownFingerprint = await PATCH(patchRequest(afterExtra, {
      status: "resolved", resolution: { kind: "model_revision", fingerprint: "1".repeat(64) },
    }), detailContext(fix.id));
    expect(unknownFingerprint.status).toBe(400);
    const resolution = { kind: "model_revision", fingerprint } as const;
    const edited = await PATCH(patchRequest(afterExtra, { description: "Align the fixture", status: "resolved", resolution }), detailContext(fix.id));
    const detail = await edited.json() as ModelFix;
    expect(detail).toMatchObject({ description: "Align the fixture", status: "resolved", resolution, resolvedAtMs: expect.any(Number) });
    expect(detail.screenshots).toHaveLength(2);
    const page = await LIST(new Request(`${endpoint}?status=resolved&limit=1`), context);
    expect(await page.json()).toMatchObject({ items: [{ id: fix.id, status: "resolved" }], nextCursor: null });
    const pending = await LIST(new Request(`${endpoint}?status=pending`), context);
    expect(await pending.json()).toEqual({ items: [], nextCursor: null });
  });

  it("attaches a Quest file independently of the active model revision with no invented pose", async () => {
    const fix = await capture();
    writeTx(handle.db, (tx) => tx.update(modelRevision).set({ status: "superseded" }).run());
    expect((await ADD_SCREENSHOT(captureRequest(), detailContext(fix.id))).status).toBe(404);
    const id = randomUUID();
    const upload = await ATTACH_QUEST(questRequest(id), detailContext(fix.id));
    expect(upload.status).toBe(200);
    const stored = await upload.json() as ModelFix;
    expect(stored.screenshots).toMatchObject([
      { content: "ar_overlay_only", fingerprint, viewpoint },
      { content: "quest_system_screenshot", fingerprint: null, viewpoint: null, imageCount: 1 },
    ]);
    expect(await (await ATTACH_QUEST(questRequest(id), detailContext(fix.id))).json()).toEqual(stored);
    const resolution = { kind: "route_change", note: "Adjusted synthetic route fixture" } as const;
    const resolved = await PATCH(patchRequest(stored, { status: "resolved", resolution }), detailContext(fix.id));
    expect(await resolved.json()).toMatchObject({ status: "resolved", resolution });
  });

  it("requires browser sessions and returns only bounded images through a read token", async () => {
    const fix = await capture();
    const screenshot = fix.screenshots[0]!;
    const imageCtx = { params: Promise.resolve({ modelId, fixId: fix.id, screenshotId: screenshot.id, imageIndex: "0" }) };
    const imageReq = new Request(`${endpoint}/${fix.id}/screenshots/${screenshot.id}/0`);
    const imageId = handle.db.select({ id: attachment.id }).from(attachment).get()!.id;
    await expect(deleteAttachment(imageId)).rejects.toThrow(/FOREIGN KEY/);
    const browserImage = await IMAGE(imageReq, imageCtx);
    expect(browserImage.status).toBe(200);
    expect(browserImage.headers.get("cache-control")).toBe("private, no-store");
    expect(browserImage.headers.get("content-type")).toBe("image/webp");
    vi.mocked(requireSession).mockRejectedValue(new UnauthorizedError());
    expect((await IMAGE(imageReq, imageCtx)).status).toBe(401);
    expect((await DETAIL(new Request(endpoint), detailContext(fix.id))).status).toBe(401);
    expect((await CREATE(captureRequest(), context)).status).toBe(401);
    const { token } = createConnection(handle.db, actor, { name: "Fixture reader", scopes: ["read"] });

    async function callTool(name: string, args: object, bearer?: string) {
      return await MCP(new Request("http://localhost:3010/mcp", {
        method: "POST",
        headers: {
          host: "localhost:3010", accept: "application/json, text/event-stream", "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args } }),
      }));
    }
    const imageArgs = { id: fix.id, screenshotId: screenshot.id };
    expect((await callTool("get_model_fix_image", imageArgs)).status).toBe(401);
    const list = await callTool("list_model_fixes", { limit: 1 }, token);
    expect(await list.json()).toMatchObject({ result: { structuredContent: { items: [{ id: fix.id }] } } });
    const detail = await callTool("get_model_fix", { id: fix.id }, token);
    expect(await detail.json()).toMatchObject({ result: { structuredContent: { screenshots: [{ id: screenshot.id }] } } });
    const result = await (await callTool("get_model_fix_image", imageArgs, token)).json();
    expect(result).toMatchObject({ result: {
      structuredContent: { content: "ar_overlay_only" },
      content: [{ type: "text" }, { type: "image", mimeType: "image/jpeg", data: expect.any(String) }],
    } });
    expect(Buffer.from(result.result.content[1].data, "base64").length).toBeLessThan(512 * 1024);
    const wrongParent = await callTool("get_model_fix_image", { ...imageArgs, id: randomUUID() }, token);
    expect(await wrongParent.json()).toMatchObject({ result: { isError: true } });
  });
  it("exposes the fix list, detail and image through the existing stdio client bridge", async () => {
    const fix = await capture();
    const screenshot = fix.screenshots[0]!;
    const attached = await ATTACH_QUEST(questRequest(), detailContext(fix.id));
    expect(attached.status).toBe(200);
    const withQuest = await attached.json() as ModelFix;
    const questScreenshot = withQuest.screenshots[1]!;
    const resolution = { kind: "route_change", note: "Adjusted synthetic duct route" } as const;
    expect((await PATCH(patchRequest(withQuest, { status: "resolved", resolution }), detailContext(fix.id))).status).toBe(200);
    const { token } = createConnection(handle.db, actor, { name: "Fixture stdio reader", scopes: ["read"] });
    const proxy = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      headers.set("host", "localhost:3010");
      const response = await MCP(new Request("http://localhost:3010/mcp", {
        method: req.method,
        headers,
        ...(chunks.length ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    const tmp = await mkdtemp(path.join(os.tmpdir(), "vh-fix-stdio-"));
    const client = new Client({ name: "model-fix-test", version: "1.0.0" });
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const config = path.join(tmp, "connection.json");
      await writeFile(config, JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp`, token }), { mode: 0o600 });
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("scripts/mcp-bridge.mjs")],
        env: { VH_MCP_CONFIG: config },
      }));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("get_model_fix_image");
      expect(await client.callTool({ name: "list_model_fixes" })).toMatchObject({
        structuredContent: { items: [{ id: fix.id }] },
      });
      expect(await client.callTool({ name: "get_model_fix", arguments: { id: fix.id } })).toMatchObject({
        structuredContent: { resolution, screenshots: [
          { id: screenshot.id }, { id: questScreenshot.id, content: "quest_system_screenshot" },
        ] },
      });
      expect(await client.callTool({ name: "get_model_fix_image", arguments: { id: fix.id, screenshotId: screenshot.id } })).toMatchObject({
        structuredContent: { content: "ar_overlay_only" },
        content: [{ type: "text" }, { type: "image", mimeType: "image/jpeg", data: expect.any(String) }],
      });
      expect(await client.callTool({ name: "get_model_fix_image", arguments: { id: fix.id, screenshotId: questScreenshot.id } })).toMatchObject({
        structuredContent: { content: "quest_system_screenshot" },
      });
    } finally {
      await client.close();
      proxy.closeAllConnections();
      if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(tmp, { recursive: true, force: true });
    }
  }, 10_000);
});
