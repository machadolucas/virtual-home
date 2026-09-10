import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SESSION_USER_ID } = vi.hoisted(() => ({ SESSION_USER_ID: "01900000-0000-7000-8000-000000000001" }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: SESSION_USER_ID } }),
  requireFreshSession: async () => ({ user: { id: SESSION_USER_ID } }),
  getSession: async () => ({ user: { id: SESSION_USER_ID } }),
  UnauthorizedError: class UnauthorizedError extends Error { readonly status = 401 as const; },
}));

import { furnishing } from "@/db/schema";
import { DELETE, GET, PUT } from "@/app/api/house-model/[modelId]/furnishings/route";
import type { Furnishing } from "@/house/model/types";
import { bodyOf, ctx, jsonRequest, setupHarness, teardownHarness, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => { h = await setupHarness(); });
afterEach(() => teardownHarness(h));

const input = {
  kind: "sofa_l", name: "Living room sofa", position: [1.2344, 0, 1.8766],
  rotationYDeg: 91.2344, widthM: 2.6, depthM: 1.7, heightM: .85, floorId: "f-lower",
};
const put = (furnishing: Record<string, unknown>, fingerprint = h.fingerprint, viewMode = "normal") =>
  PUT(jsonRequest(`/api/house-model/${h.modelId}/furnishings`, "PUT", { fingerprint, viewMode, furnishing }), ctx({ modelId: h.modelId }));

describe("model-only furnishings", () => {
  it("creates, edits, lists and deletes a resizable record without equipment", async () => {
    const created = await bodyOf<{ furnishing: Furnishing }>(await put(input));
    expect(created.furnishing).toMatchObject({
      kind: "sofa_l", position: [1.234, 0, 1.877], rotationYDeg: 91.234,
      widthM: 2.6, depthM: 1.7, heightM: .85, floorId: "f-lower", roomId: "r-l-a",
    });
    expect(h.handle.db.select().from(furnishing).all()).toHaveLength(1);

    const edited = await bodyOf<{ furnishing: Furnishing }>(await put({
      ...input, id: created.furnishing.id, name: "Long sofa", widthM: 3.1, rotationYDeg: 180,
    }));
    expect(edited.furnishing).toMatchObject({ name: "Long sofa", widthM: 3.1, rotationYDeg: 180 });
    const listed = await bodyOf<{ furnishings: Furnishing[] }>(await GET(
      jsonRequest(`/api/house-model/${h.modelId}/furnishings`, "GET"), ctx({ modelId: h.modelId }),
    ));
    expect(listed.furnishings).toEqual([edited.furnishing]);

    const removed = await DELETE(
      jsonRequest(`/api/house-model/${h.modelId}/furnishings?id=${created.furnishing.id}`, "DELETE"),
      ctx({ modelId: h.modelId }),
    );
    expect(removed.status).toBe(204);
    expect(h.handle.db.select().from(furnishing).all()).toHaveLength(0);
  });

  it("rejects stale fingerprints and presentation-space coordinates", async () => {
    expect((await put(input, "stale-fingerprint")).status).toBe(409);
    expect((await put(input, h.fingerprint, "exploded")).status).toBe(422);
    expect(h.handle.db.select().from(furnishing).all()).toHaveLength(0);
  });

  it("validates model bounds and physical dimensions", async () => {
    expect((await put({ ...input, position: [999, 0, 1] })).status).toBe(400);
    expect((await put({ ...input, widthM: .049 })).status).toBe(400);
    expect((await put({ ...input, heightM: 15.01 })).status).toBe(400);
    expect(h.handle.db.select().from(furnishing).all()).toHaveLength(0);
  });
});
