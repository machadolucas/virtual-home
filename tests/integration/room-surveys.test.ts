import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbForTests, writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import { asset, assetPlacement, furnishing, modelRevision, roomSurvey } from "@/db/schema";
import { ManifestSchema } from "@/house/model/schema";
import type { RoomSurvey, RoomSurveyCapture, RoomSurveyMove, RoomSurveyMoveInput, RoomSurveyObservation, RoomSurveySummary } from "@/house/roomSurveyTypes";
import { requireFreshSession, requireSession, UnauthorizedError } from "@/server/auth/session";
import type { CurrentPackage } from "@/server/house-model/package";
import { currentPackageForRequest } from "@/server/house-model/http";
import { createConnection } from "@/server/mcp/auth";
import { GET as LIST, POST as CREATE } from "@/app/api/house-model/[modelId]/surveys/route";
import { GET as DETAIL } from "@/app/api/house-model/[modelId]/surveys/[surveyId]/route";
import { GET as GEOMETRY } from "@/app/api/house-model/[modelId]/surveys/[surveyId]/geometry/route";
import { POST as PROPOSE } from "@/app/api/house-model/[modelId]/surveys/[surveyId]/moves/route";
import { PATCH as CHANGE } from "@/app/api/house-model/[modelId]/surveys/[surveyId]/moves/[moveId]/route";
import { POST as OBSERVE } from "@/app/api/house-model/[modelId]/surveys/[surveyId]/observations/route";
import { POST as MCP } from "@/app/mcp/route";
import { getModelFix } from "@/server/model-fixes/registry";
import { readRoomSurveyGeometryPage } from "@/server/room-surveys/registry";
import raw from "../fixtures/model/house-model/model.json";
import { seedUser, testDb } from "../helpers/db";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/auth/session")>(), requireSession: vi.fn(), requireFreshSession: vi.fn(),
}));
vi.mock("@/server/house-model/http", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/house-model/http")>(), currentPackageForRequest: vi.fn(),
}));

const manifest = ManifestSchema.parse(raw);
const fingerprint = "0".repeat(64);
const modelId = manifest.modelId;
const roomId = "r-l-a";
const floorId = "f-lower";
const endpoint = `http://localhost:3010/api/house-model/${modelId}/surveys`;
const context = { params: Promise.resolve({ modelId }) };
const detailContext = (surveyId: string) => ({ params: Promise.resolve({ modelId, surveyId }) });
const moveContext = (surveyId: string, moveId: string) => ({ params: Promise.resolve({ modelId, surveyId, moveId }) });
const pkg: CurrentPackage = { modelId, fingerprint, dir: "", manifest, diagnostics: [], assetFiles: new Map(), lock: null };

let handle: DbHandle;
let actor: string;
let revisionId: string;

beforeEach(() => {
  handle = testDb();
  setDbForTests(handle);
  actor = seedUser(handle, { username: "survey-reviewer", name: "Synthetic Survey Reviewer" }).id;
  const userSession = { user: { id: actor } } as Awaited<ReturnType<typeof requireSession>>;
  vi.mocked(requireSession).mockResolvedValue(userSession);
  vi.mocked(requireFreshSession).mockResolvedValue(userSession);
  vi.mocked(currentPackageForRequest).mockResolvedValue(pkg);
  revisionId = newId();
  writeTx(handle.db, (tx) => tx.insert(modelRevision).values({
    id: revisionId, modelId, contentHash: fingerprint, schemaVersion: "1.0",
    generatedAtMs: 1, coordinateSystemJson: "{}", nodeCount: 0, importedAtMs: 1,
    status: "current", importedBy: actor,
  }).run());
});

afterEach(() => {
  vi.resetAllMocks();
  setDbForTests(null);
  handle.close();
});

function json(body: unknown, method = "POST") {
  return new Request(endpoint, {
    method, headers: { "content-type": "application/json", "x-vh-room-survey": "1" }, body: JSON.stringify(body),
  });
}

function sample(patch: Partial<RoomSurveyCapture> = {}): RoomSurveyCapture {
  return {
    requestId: randomUUID(), fingerprint, roomId, floorId, registrationErrorM: 0.032,
    geometry: {
      surfaces: [
        { source: "plane", orientation: "horizontal", points: [[1, 0, 1], [3.5, 0, 1], [3, 0, 1.5]] },
        { source: "mesh", points: [[1, 0, 1], [1, 1, 1], [1, 0, 2]], indices: [0, 1, 2] },
      ],
      measurements: [{ kind: "ceiling_height", a: [1, 0, 1], b: [1.1, 2.4, 1] }],
    },
    ...patch,
  };
}

async function capture() {
  const response = await CREATE(json(sample()), context);
  expect(response.status).toBe(200);
  return await response.json() as RoomSurveySummary;
}

function addFurniture() {
  const id = newId();
  writeTx(handle.db, (tx) => tx.insert(furnishing).values({
    id, modelId, modelNodeId: roomId, floorId, roomId, kind: "chair", name: "Fixture chair",
    posX: 2, posY: 0, posZ: 1, rotYawDeg: 170, widthM: 0.6, depthM: 0.6, heightM: 0.8,
    createdAtMs: 1, updatedAtMs: 1,
  }).run());
  return id;
}

function addEquipment(mounted = false) {
  const id = newId(), assetId = newId();
  writeTx(handle.db, (tx) => {
    tx.insert(asset).values({ id: assetId, category: "appliance", name: "Fixture hob", status: "installed", createdAtMs: 4, updatedAtMs: 4 }).run();
    tx.insert(assetPlacement).values({
      id, assetId, modelRevisionId: revisionId, modelNodeId: roomId,
      posX: 2, posY: 0, posZ: 1, rotYawDeg: 170, mountHeightM: null,
      mountKind: mounted ? "wall" : "floor", mountSurfaceId: mounted ? "s-fixture-wall" : null,
      createdAtMs: 4, updatedAtMs: 4,
    }).run();
  });
  return id;
}

function move(kind: RoomSurveyMoveInput["target"]["kind"], id: string): RoomSurveyMoveInput {
  return {
    requestId: randomUUID(), target: { kind, id },
    before: { position: [2, 0, 1], yawDeg: 170 },
    sample: { position: [2.3, 0.02, 1.4], yawDeg: -170 },
    registrationErrorM: 0.03,
  };
}

describe("private room survey evidence", () => {
  it("stores explicit bounded geometry once and retains typed adjacent evidence", async () => {
    const input = sample();
    const responses = await Promise.all([CREATE(json(input), context), CREATE(json(input), context)]);
    expect(responses.map((result) => result.status)).toEqual([200, 200]);
    const [record, replay] = await Promise.all(responses.map(async (response) => await response.json() as RoomSurveySummary));
    expect(record).toEqual(replay);
    expect(handle.db.select().from(roomSurvey).all()).toHaveLength(1);
    expect(record?.statistics).toMatchObject({
      includesAdjoining: true, sources: { plane: 1, mesh: 1 }, pointCount: 6, measurementCount: 1,
      extent: { min: [1, 0, 1], max: [3.5, 2.4, 2] },
    });
    expect(record).toMatchObject({ roomId, floorId, fingerprint, registrationErrorM: 0.032 });
    const bad = sample({ geometry: { ...input.geometry, surfaces: [{ source: "hit-test", points: [[20, 0, 20]] }] } });
    expect((await CREATE(json(bad), context)).status).toBe(400);
    expect((await CREATE(json({ ...input, registrationErrorM: 0.04 }), context)).status).toBe(409);
    const request = new Request(endpoint);
    const detail = await DETAIL(request, detailContext(record!.id));
    expect(detail.headers.get("cache-control")).toBe("private, no-store");
    expect((await detail.json() as RoomSurvey).measurements[0]).toMatchObject({ kind: "ceiling_height", lengthM: 2.4 });
    expect(await (await GEOMETRY(request, detailContext(record!.id))).json()).toEqual(input.geometry);
    expect(await (await LIST(request, context)).json()).toMatchObject({ items: [{ id: record!.id }] });
  });

  it("preserves untrimmed full geometry and exact triangle indices across database chunks", async () => {
    const points = Array.from({ length: 2002 }, (_, i): [number, number, number] => [7 + i / 10_000, (i % 4) / 10, 1 + (i % 3) / 10]);
    const indices = Array.from({ length: 6006 }, (_, i) => (i * 3 + 5) % points.length);
    const geometry = { scope: "full", surfaces: [{ source: "mesh", points, indices }], measurements: [] } as const;
    const response = await CREATE(json({ ...sample(), geometry }), context);
    expect(response.status).toBe(200);
    const record = await response.json() as RoomSurveySummary;
    expect(record.statistics).toMatchObject({ scope: "full", includesAdjoining: true, extent: { min: [7, 0, 1] } });
    const page = readRoomSurveyGeometryPage(handle.db, { id: record.id, surface: 0, section: "points", offset: 1999, limit: 2 });
    expect(page).toMatchObject({ values: points.slice(1999, 2001), nextOffset: 2001, total: 2002 });
    const topology = readRoomSurveyGeometryPage(handle.db, { id: record.id, surface: 0, section: "indices", offset: 5998, limit: 10 });
    expect(topology).toMatchObject({ values: indices.slice(5998), nextOffset: null, total: 6006 });
    expect(await (await GEOMETRY(new Request(endpoint), detailContext(record.id))).json()).toEqual(geometry);
    const rejected = await CREATE(json({ ...sample(), geometry: { ...geometry, scope: "bounded" } }), context);
    expect(rejected.status).toBe(400);
  });

  it("approves a furnishing pose once, tolerates a lost response and restores the exact recorded pose", async () => {
    const survey = await capture();
    const id = addFurniture();
    const input = move("furnishing", id);
    const first = await PROPOSE(json(input), detailContext(survey.id));
    expect(first.status).toBe(200);
    const proposed = await first.json() as RoomSurveyMove;
    expect(proposed).toMatchObject({ displacementCm: 50, headingChangeDeg: 20, status: "proposed", applyBlockedReason: null });
    expect(await (await PROPOSE(json(input), detailContext(survey.id))).json()).toEqual(proposed);
    const change = (action: "apply" | "undo") => CHANGE(json({ action }, "PATCH"), moveContext(survey.id, proposed.id));
    vi.mocked(requireFreshSession).mockRejectedValueOnce(new UnauthorizedError());
    expect((await change("apply")).status).toBe(401);
    const applied = await change("apply");
    expect(applied.status).toBe(200);
    const updated = await applied.json() as RoomSurveyMove;
    expect(updated.status).toBe("applied");
    expect(await (await change("apply")).json()).toEqual(updated);
    expect(handle.db.select().from(furnishing).where(eq(furnishing.id, id)).get())
      .toMatchObject({ posX: 2.3, posY: 0.02, posZ: 1.4, rotYawDeg: -170, floorId, roomId });
    vi.mocked(requireFreshSession).mockRejectedValueOnce(new UnauthorizedError());
    expect((await change("undo")).status).toBe(401);
    expect(await (await change("undo")).json()).toMatchObject({ status: "undone" });
    expect(handle.db.select().from(furnishing).where(eq(furnishing.id, id)).get())
      .toMatchObject({ posX: 2, posY: 0, posZ: 1, rotYawDeg: 170, floorId, roomId });
    expect((await change("apply")).status).toBe(409);
  });

  it("serializes competing approved corrections to the same placement", async () => {
    const survey = await capture();
    const id = addFurniture();
    const left = await (await PROPOSE(json(move("furnishing", id)), detailContext(survey.id))).json() as RoomSurveyMove;
    const right = await (await PROPOSE(json({ ...move("furnishing", id), sample: { position: [2.5, 0, 1.5] } }), detailContext(survey.id))).json() as RoomSurveyMove;
    const approvals = await Promise.all([left, right].map(({ id }) => CHANGE(json({ action: "apply" }, "PATCH"), moveContext(survey.id, id))));
    expect(approvals.map((item) => item.status).sort()).toEqual([200, 409]);
  });

  it("retains prior mount semantics and refuses overwritten equipment, stale revisions and unsafe supports", async () => {
    const survey = await capture();
    const id = addEquipment();
    const proposed = await (await PROPOSE(json(move("equipment", id)), detailContext(survey.id))).json() as RoomSurveyMove;
    const supported = addEquipment(true);
    const blocked = await (await PROPOSE(json(move("equipment", supported)), detailContext(survey.id))).json() as RoomSurveyMove;
    expect(blocked).toMatchObject({ status: "proposed", applyBlockedReason: "surface_support_unverified", before: { position: [2, 0, 1] } });
    expect((await CHANGE(json({ action: "apply" }, "PATCH"), moveContext(survey.id, blocked.id))).status).toBe(409);
    const change = (moveId: string, action: "apply" | "undo") => CHANGE(json({ action }, "PATCH"), moveContext(survey.id, moveId));
    expect((await change(proposed.id, "apply")).status).toBe(200);
    expect(handle.db.select().from(assetPlacement).where(eq(assetPlacement.id, id)).get())
      .toMatchObject({ posX: 2.3, mountHeightM: 0.02, mountKind: "floor", mountSurfaceId: null });
    writeTx(handle.db, (tx) => tx.update(assetPlacement).set({ posX: 1.7 }).where(eq(assetPlacement.id, id)).run());
    expect((await change(proposed.id, "undo")).status).toBe(409);
    const another = addEquipment();
    const next = await (await PROPOSE(json(move("equipment", another)), detailContext(survey.id))).json() as RoomSurveyMove;
    writeTx(handle.db, (tx) => tx.update(modelRevision).set({ status: "superseded" }).where(eq(modelRevision.id, revisionId)).run());
    expect((await change(next.id, "apply")).status).toBe(409);
  });

  it("records observations as model fixes and exposes only paged, read-scoped MCP evidence", async () => {
    const survey = await capture();
    const input = { requestId: randomUUID(), kind: "structure", position: [1, 0, 1], description: "Synthetic wall observation" };
    const observed = await (await OBSERVE(json(input), detailContext(survey.id))).json() as RoomSurveyObservation;
    expect(getModelFix(handle.db, observed.fixId)).toMatchObject({
      status: "pending", description: input.description, screenshots: [],
      surveyObservation: { surveyId: survey.id, kind: "structure", position: [1, 0, 1] },
    });
    expect(await (await OBSERVE(json(input), detailContext(survey.id))).json()).toEqual(observed);
    vi.mocked(requireSession).mockRejectedValue(new UnauthorizedError());
    expect((await GEOMETRY(new Request(endpoint), detailContext(survey.id))).status).toBe(401);
    expect((await CREATE(json(sample()), context)).status).toBe(401);
    const token = createConnection(handle.db, actor, { name: "Fixture survey reader", scopes: ["read"] }).token;
    const call = (name: string, args: object, bearer?: string) => MCP(new Request("http://localhost:3010/mcp", {
      method: "POST",
      headers: { host: "localhost:3010", accept: "application/json, text/event-stream", "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args } }),
    }));
    expect((await call("get_room_survey", { id: survey.id })).status).toBe(401);
    expect(await (await call("list_room_surveys", {}, token)).json())
      .toMatchObject({ result: { structuredContent: { items: [{ id: survey.id }] } } });
    expect(await (await call("get_room_survey", { id: survey.id, section: "observations" }, token)).json())
      .toMatchObject({ result: { structuredContent: { items: [{ fixId: observed.fixId }], nextOffset: null } } });
    expect(await (await call("read_room_survey_geometry", { id: survey.id, surface: 1, limit: 1 }, token)).json())
      .toMatchObject({ result: { structuredContent: { source: "mesh", values: [[1, 0, 1]], nextOffset: 1 } } });
    expect(await (await call("apply_room_survey_move", { id: survey.id }, token)).json()).toMatchObject({ result: { isError: true } });
  });

  it("keeps a discrepancy pending with both outlines, the captured source and the original alignment measurement", async () => {
    const survey = await capture();
    const comparison = {
      target: { kind: "surface", id: "s-e-l-ext--r-l-a" }, label: "Synthetic wall", sourceSurface: 1,
      scanOutline: [[1, 0, 1], [1, 0, 2], [1, 1, 2], [1, 1, 1]],
      modelOutline: [[0.82, 0, 1], [0.82, 0, 2], [0.82, 1, 2], [0.82, 1, 1]],
      offsetM: 0.18, scanUncertaintyM: 0.025,
    };
    const input = { requestId: randomUUID(), kind: "discrepancy", position: [1, 0.5, 1.5], comparison };
    expect((await OBSERVE(json({ ...input, comparison: { ...comparison, sourceSurface: 4 } }), detailContext(survey.id))).status).toBe(400);
    expect((await OBSERVE(json({ ...input, comparison: { ...comparison, offsetM: 0.45 } }), detailContext(survey.id))).status).toBe(400);
    const response = await OBSERVE(json(input), detailContext(survey.id));
    expect(response.status).toBe(200);
    const observed = await response.json() as RoomSurveyObservation;
    expect(observed).toMatchObject({ kind: "discrepancy", surveyId: survey.id,
      comparison: { ...comparison, registrationErrorM: 0.032 } });
    expect(await (await OBSERVE(json(input), detailContext(survey.id))).json()).toEqual(observed);
    expect(getModelFix(handle.db, observed.fixId)).toMatchObject({ status: "pending", surveyObservation: observed });
    expect(await (await DETAIL(new Request(endpoint), detailContext(survey.id))).json()).toMatchObject({ observations: [observed] });
  });
});
