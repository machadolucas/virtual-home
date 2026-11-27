import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { POST, GET as LIST } from "@/app/api/house-model/[modelId]/alignment-attempts/route";
import { GET as DETAIL } from "@/app/api/house-model/[modelId]/alignment-attempts/[attemptId]/route";
import { POST as MCP } from "@/app/mcp/route";
import { setDbForTests, writeTx, type DbHandle } from "@/db/client";
import { alignmentAttempt, mcpConnection, modelRevision } from "@/db/schema";
import { MAX_ALIGNMENT_ATTEMPT_BYTES, type AlignmentAttempt } from "@/house/alignmentAttemptTypes";
import { ALIGNMENT_ATTEMPT_RETENTION_MS } from "@/server/alignment-attempts/retention";
import { getAlignmentAttempt, storeAlignmentAttempt } from "@/server/alignment-attempts/registry";
import { requireSession, UnauthorizedError } from "@/server/auth/session";
import { createConnection } from "@/server/mcp/auth";
import { runHousekeeping } from "@/worker/jobs/housekeeping";
import { testDb, seedUser } from "../helpers/db";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", async original => ({ ...await original<typeof import("@/server/auth/session")>(), requireSession: vi.fn() }));
const modelId = "synthetic-package", fingerprint = "abcd".repeat(4);
const origin = "http://localhost:3010", url = origin + "/api/house-model/" + modelId + "/alignment-attempts";
const ctx = { params: Promise.resolve({ modelId }) };
let handle: DbHandle, actor: string, other: string, sample: AlignmentAttempt;
const login = (id: string) => vi.mocked(requireSession).mockResolvedValue({ user: { id } } as Awaited<ReturnType<typeof requireSession>>);
beforeEach(() => {
  handle = testDb(); setDbForTests(handle);
  actor = seedUser(handle, { username: "diagnostic-one", name: "Synthetic One" }).id;
  other = seedUser(handle, { username: "diagnostic-two", name: "Synthetic Two" }).id;
  login(actor);
  writeTx(handle.db, tx => tx.insert(modelRevision).values({ id: randomUUID(), modelId, contentHash: fingerprint,
    schemaVersion: "1", generatedAtMs: 1, importedAtMs: 1, coordinateSystemJson: "{}", nodeCount: 0, status: "current" }).run());
  sample = { id: randomUUID(), userId: actor, fingerprint, startedAtMs: Date.now() - 3000,
    mode: "mr", revision: 2, elapsedMs: 1800, status: "aligning", roomId: "fixture-room", features: ["plane-detection"],
    events: [{ atMs: 250, kind: "room-selected", detail: "Synthetic test" }],
    snapshots: [{ atMs: 550, space: 0, roomId: "fixture-room", viewer: [0, 1.6, 2], floor: null, walls: [], landmarks: [],
      traces: [{ a: [0, 0], b: [1, 0], low: 0, high: 0 }], diagnosis: null }] };
});
afterEach(() => { setDbForTests(null); handle.close(); vi.clearAllMocks(); });
function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(new Request(url, { method: "POST", headers: { origin, "content-type": "application/json", "x-vh-alignment": "1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body) }), ctx);
}
const detail = (id: string, bound = modelId) => DETAIL(new Request(url + "/" + id), { params: Promise.resolve({ modelId: bound, attemptId: id }) });

it("authenticates before reading, requires same-origin browser writes and keeps evidence bound to the account and model", async () => {
  vi.mocked(requireSession).mockRejectedValue(new UnauthorizedError());
  expect((await post(sample)).status).toBe(401);
  expect((await LIST(new Request(url), ctx)).status).toBe(401);
  expect((await detail(sample.id)).status).toBe(401);
  login(actor);
  const deniedHeaders: Record<string,string>[] = [{origin:"https://example.invalid"}, {"x-vh-alignment":"0"}, {"sec-fetch-site":"cross-site"}];
  for (const headers of deniedHeaders) {
    expect((await post(sample, headers)).status).toBe(403);
  }
  expect((await post({ ...sample, userId: other })).status).toBe(403);
  expect((await post(sample)).status).toBe(200);
  expect((await detail(sample.id, "other-package")).status).toBe(404);
  const res = await detail(sample.id);
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(await res.json()).toMatchObject({ ...sample, modelId, modelStatus: "current" });
  login(other);
  expect((await detail(sample.id)).status).toBe(404);
  expect(await (await LIST(new Request(url), ctx)).json()).toEqual({ items: [], nextCursor: null });
  expect((await post(sample)).status).toBe(403);
  expect((await post({ ...sample, userId: other, events: [] })).status).toBe(200);
  expect((await (await detail(sample.id)).json()).events).toEqual([]);
});

it("acknowledges the highest stored revision through retries and binds queued work to its original package", async () => {
  const newer = { ...sample, revision: 3, elapsedMs: 2400, status: "ended" };
  for (const result of await Promise.all([post(newer), post(sample), post(newer)])) {
    expect(result.status).toBe(200);
  }
  expect(await (await post(sample)).json()).toEqual({ id: sample.id, revision: 3 });
  expect((await post({ ...newer, events: [] })).status).toBe(409);
  expect((await post({ ...newer, revision: 4, elapsedMs: 2000 })).status).toBe(409);
  expect((await post({ ...newer, startedAtMs: sample.startedAtMs - 20 })).status).toBe(409);
  writeTx(handle.db, tx => tx.update(modelRevision).set({ status: "superseded" }).where(eq(modelRevision.contentHash, fingerprint)).run());
  expect((await post({ ...newer, revision: 4 })).status).toBe(200);
  expect((await (await detail(sample.id)).json()).modelStatus).toBe("superseded");
  expect((await post({ ...sample, id: randomUUID() })).status).toBe(200);
  expect((await post({ ...sample, fingerprint: "baad".repeat(4) })).status).toBe(409);
  writeTx(handle.db, tx => tx.update(modelRevision).set({ status: "imported" }).where(eq(modelRevision.contentHash, fingerprint)).run());
  expect((await post({ ...sample, id: randomUUID() })).status).toBe(409);
});

it("bounds chunked bodies, coordinates, nested arrays, timestamps and arbitrary extra data", async () => {
  expect((await post(" ".repeat(MAX_ALIGNMENT_ATTEMPT_BYTES + 1))).status).toBe(413);
  for (const body of [{ ...sample, events: Array(49).fill(sample.events[0]) }, { ...sample, debug: "unbounded field" },
    { ...sample, events: [{ atMs: 2000, kind: "scan", detail: "" }] },
    { ...sample, snapshots: [{ ...sample.snapshots[0], floor: { y: 0, outline: Array(129).fill([1, 2]) } }] },
    { ...sample, snapshots: [{ ...sample.snapshots[0], viewer: [0, 0, 1e9] }] }]) {
    expect((await post(body)).status).toBe(400);
  }
  expect(handle.db.select().from(alignmentAttempt).all()).toHaveLength(0);
});

it("pages by stable start time and expires old or evicted attempts without reviving a stale client", async () => {
  const now = Date.now();
  for (let i = 0; i < 61; i++) storeAlignmentAttempt(handle.db, actor, modelId,
    { ...sample, id: i === 0 ? sample.id : randomUUID(), startedAtMs: now - 1000 + i }, now);
  expect(handle.db.select({ id: alignmentAttempt.id }).from(alignmentAttempt).all()).toHaveLength(60);
  expect((await detail(sample.id)).status).toBe(404);
  expect((await post({ ...sample, startedAtMs: now - 1000 })).status).toBe(410);
  const first = await (await LIST(new Request(url + "?limit=2"), ctx)).json();
  const second = await (await LIST(new Request(url + "?limit=2&cursor=" + first.nextCursor), ctx)).json();
  expect(first.items[1].startedAtMs).toBeGreaterThan(second.items[0].startedAtMs);
  expect(first.items[0]).not.toHaveProperty("snapshots");
  const future = now + ALIGNMENT_ATTEMPT_RETENTION_MS;
  expect(() => getAlignmentAttempt(handle.db, actor, first.items[0].id, modelId, future)).toThrow("unknown_alignment_attempt");
  expect(runHousekeeping({ handle, clock: { now: () => future }, checkpoint: false }).alignmentAttemptsDeleted).toBe(60);
  expect((await post({ ...sample, startedAtMs: now - ALIGNMENT_ATTEMPT_RETENTION_MS })).status).toBe(410);
});

it("allows read-scoped MCP list and paged detail only for the connection owner's account", async () => {
  await post(sample);
  const rpc = (token: string, name: string, args: Record<string, unknown> = {}) => MCP(new Request(origin + "/mcp", {
    method: "POST", headers: { host: "localhost:3010", authorization: "Bearer " + token,
      accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  const own = createConnection(handle.db, actor, { name: "Fixture reader", scopes: ["read"] });
  const foreign = createConnection(handle.db, other, { name: "Other reader", scopes: ["read"] });
  expect((await (await rpc(own.token, "list_alignment_attempts")).json()).result.structuredContent.items[0].id).toBe(sample.id);
  const args = { id: sample.id, snapshotIndex: 0, section: "traces" };
  const found = await (await rpc(own.token, "get_alignment_attempt", args)).json();
  expect(found.result.structuredContent.snapshot.traces).toEqual(sample.snapshots[0]!.traces);
  expect((await (await rpc(foreign.token, "get_alignment_attempt", args)).json()).result.isError).toBe(true);
  expect((await (await rpc(foreign.token, "list_alignment_attempts")).json()).result.structuredContent.items).toEqual([]);
  writeTx(handle.db, tx => tx.update(mcpConnection).set({ revokedAtMs: Date.now() }).where(eq(mcpConnection.id, own.id)).run());
  expect((await rpc(own.token, "get_alignment_attempt", args)).status).toBe(401);
});
