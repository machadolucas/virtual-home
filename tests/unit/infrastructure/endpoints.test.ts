/**
 * `GET/PUT/DELETE /api/house-model/[modelId]/endpoints`, and the link between an endpoint and the
 * route that runs to it.
 *
 * The handlers are called directly with a mocked session, against a real migrated database and the
 * real synthetic fixture package. What is asserted is the persistence contract the new workspace
 * UI depends on: an endpoint round-trips with its place, it can carry equipment (either an
 * existing unit or one created with it), a maintenance plan can be written against that equipment
 * — which is the whole point of the link — and a route keeps its `from`/`to` across a re-read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SESSION_USER_ID } = vi.hoisted(() => ({
  SESSION_USER_ID: "01900000-0000-7000-8000-000000000001",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: SESSION_USER_ID } }),
  requireFreshSession: async () => ({ user: { id: SESSION_USER_ID } }),
  getSession: async () => ({ user: { id: SESSION_USER_ID } }),
  UnauthorizedError: class UnauthorizedError extends Error {
    readonly status = 401 as const;
  },
}));

import { eq } from "drizzle-orm";
import { newId, nowMs } from "@/db/ids";
import { writeTx } from "@/db/client";
import { asset, auditLog, infraEndpoint, maintenancePlan } from "@/db/schema";
import { DELETE, GET, PUT } from "@/app/api/house-model/[modelId]/endpoints/route";
import { PUT as PUT_ROUTE, GET as GET_ROUTES } from "@/app/api/house-model/[modelId]/routes/route";
import type { EndpointDto, RouteDto } from "@/features/projects/wire";
import {
  bodyOf,
  ctx,
  jsonRequest,
  seedAsset,
  setupHarness,
  teardownHarness,
  type Harness,
} from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await setupHarness();
});

afterEach(() => {
  teardownHarness(h);
});

/** A vent in the fixture's lower-floor room `r-l-a`. */
function endpointBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: h.fingerprint,
    viewMode: "normal",
    endpoint: {
      name: "Kitchen extract vent",
      kind: "terminal",
      modelNodeId: "r-l-a",
      position: [1.2, 2.3, 1.1],
      ...over,
    },
  };
}

const put = (body: unknown) =>
  PUT(
    jsonRequest(`/api/house-model/${h.modelId}/endpoints`, "PUT", body),
    ctx({ modelId: h.modelId }),
  );

const list = () =>
  GET(jsonRequest(`/api/house-model/${h.modelId}/endpoints`, "GET"), ctx({ modelId: h.modelId }));

const putEndpoint = async (over: Record<string, unknown> = {}): Promise<EndpointDto> => {
  const res = await put(endpointBody(over));
  expect(res.status).toBe(200);
  return (await bodyOf<{ endpoint: EndpointDto }>(res)).endpoint;
};

describe("PUT endpoints", () => {
  it("round-trips an endpoint with its kind, place and position", async () => {
    const stored = await putEndpoint();
    expect(stored.name).toBe("Kitchen extract vent");
    expect(stored.kind).toBe("terminal");
    expect(stored.modelNodeId).toBe("r-l-a");
    expect(stored.position).toEqual([1.2, 2.3, 1.1]);
    expect(stored.assetId).toBeNull();
    expect(stored.needsReconciliation).toBe(false);

    const { endpoints } = await bodyOf<{ endpoints: EndpointDto[] }>(await list());
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.id).toBe(stored.id);

    const row = h.handle.db
      .select()
      .from(infraEndpoint)
      .where(eq(infraEndpoint.id, stored.id))
      .get();
    expect(row?.modelRevisionId).toBe(h.revisionId);
  });

  it("keeps a room-only endpoint, with no coordinates, rather than refusing it", async () => {
    const stored = await putEndpoint({ position: null });
    expect(stored.position).toBeNull();
    expect(stored.modelNodeId).toBe("r-l-a");
    // No coordinate means no revision is needed to interpret it.
    const row = h.handle.db
      .select()
      .from(infraEndpoint)
      .where(eq(infraEndpoint.id, stored.id))
      .get();
    expect(row?.modelRevisionId).toBeNull();
  });

  it("refuses an endpoint nobody could find", async () => {
    const res = await put(endpointBody({ position: null, modelNodeId: null }));
    expect(res.status).toBe(400);
    expect((await bodyOf<{ error: string }>(res)).error).toBe("endpoint_needs_a_place");
  });

  it("updates in place when the same id comes back", async () => {
    const first = await putEndpoint();
    const second = await putEndpoint({ id: first.id, name: "Kitchen extract vent (upper)" });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Kitchen extract vent (upper)");
    expect(h.handle.db.select().from(infraEndpoint).all()).toHaveLength(1);
  });
});

describe("the equipment bridge", () => {
  it("links an existing unit", async () => {
    const assetId = seedAsset(h.handle, "Extract vent grille");
    const stored = await putEndpoint({ assetId });
    expect(stored.assetId).toBe(assetId);

    // Survives the re-read, which is what the workspace's list is built from.
    const { endpoints } = await bodyOf<{ endpoints: EndpointDto[] }>(await list());
    expect(endpoints[0]?.assetId).toBe(assetId);
  });

  it("creates the unit with the endpoint, and audits it", async () => {
    const stored = await putEndpoint({
      newAsset: { name: "Kitchen extract vent", category: "hvac" },
    });
    expect(stored.assetId).not.toBeNull();

    const unit = h.handle.db
      .select()
      .from(asset)
      .where(eq(asset.id, stored.assetId as string))
      .get();
    expect(unit?.name).toBe("Kitchen extract vent");
    expect(unit?.category).toBe("hvac");
    // In service, not planned: the vent is being recorded because it is there.
    expect(unit?.status).toBe("installed");

    const audits = h.handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, stored.assetId as string))
      .all();
    expect(audits.map((a) => a.action)).toEqual(["created"]);
  });

  it("carries a maintenance plan, which is the reason the link exists", async () => {
    const stored = await putEndpoint({
      newAsset: { name: "Kitchen extract vent", category: "hvac" },
    });
    const assetId = stored.assetId as string;

    // The plan targets the asset, exactly as a plan written from the equipment page would. No
    // maintenance schema is involved in the endpoint at all — the endpoint only supplies the unit.
    const planId = newId();
    const at = nowMs();
    writeTx(h.handle.db, (tx) => {
      tx
        .insert(maintenancePlan)
        .values({
          id: planId,
          title: "Clean the vents",
          assetId,
          scheduleKind: "interval_from_completion",
          recurrenceJson: JSON.stringify({ v: 1, kind: "interval", months: 6 }),
          scheduleAnchorDate: "2026-01-01",
          scheduleAnchorSource: "user_chosen",
          assignmentMode: "shared",
          createdAtMs: at,
          createdBy: SESSION_USER_ID,
          updatedAtMs: at,
          updatedBy: SESSION_USER_ID,
        })
        .run();
    });

    const plans = h.handle.db
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.assetId, assetId))
      .all();
    expect(plans.map((p) => p.title)).toEqual(["Clean the vents"]);
  });

  it("refuses to both link and create", async () => {
    const assetId = seedAsset(h.handle);
    const res = await put(
      endpointBody({ assetId, newAsset: { name: "Vent", category: "hvac" } }),
    );
    expect(res.status).toBe(400);
    expect((await bodyOf<{ error: string }>(res)).error).toBe("asset_link_ambiguous");
  });

  it("refuses a unit that does not exist", async () => {
    const res = await put(endpointBody({ assetId: "no-such-asset" }));
    expect(res.status).toBe(409);
    expect((await bodyOf<{ error: string }>(res)).error).toBe("unknown_asset");
  });
});

describe("routes and their endpoints", () => {
  const putRoute = (route: Record<string, unknown>) =>
    PUT_ROUTE(
      jsonRequest(`/api/house-model/${h.modelId}/routes`, "PUT", {
        fingerprint: h.fingerprint,
        viewMode: "normal",
        route,
      }),
      ctx({ modelId: h.modelId }),
    );

  it("keeps a run's from and to across a re-read", async () => {
    const from = await putEndpoint({ name: "HRU supply spigot", kind: "source" });
    const to = await putEndpoint({ name: "Kitchen extract vent", position: [2.5, 2.3, 1.1] });

    const res = await putRoute({
      name: "Kitchen extract duct",
      system: "ventilation",
      medium: "extract_air",
      certainty: "inferred",
      lifecycle: "installed",
      nominalSize: "Ø125 mm",
      fromEndpointId: from.id,
      toEndpointId: to.id,
      points: [
        { position: [1, 2.3, 1], floorId: "f-lower", roomId: "r-l-a" },
        { position: [3, 2.3, 1], floorId: "f-lower", roomId: "r-l-b" },
      ],
    });
    expect(res.status).toBe(200);
    const { route } = await bodyOf<{ route: RouteDto }>(res);
    expect(route.fromEndpointId).toBe(from.id);
    expect(route.toEndpointId).toBe(to.id);
    expect(route.medium).toBe("extract_air");
    expect(route.nominalSize).toBe("Ø125 mm");
    expect(route.points).toEqual([
      [1, 2.3, 1],
      [3, 2.3, 1],
    ]);

    const { routes } = await bodyOf<{ routes: RouteDto[] }>(
      await GET_ROUTES(
        jsonRequest(`/api/house-model/${h.modelId}/routes`, "GET"),
        ctx({ modelId: h.modelId }),
      ),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.fromEndpointId).toBe(from.id);
    expect(routes[0]?.toEndpointId).toBe(to.id);
  });

  it("survives the endpoint being deleted, and stops claiming where it ends", async () => {
    const to = await putEndpoint();
    const created = await putRoute({
      name: "Kitchen extract duct",
      system: "ventilation",
      certainty: "inferred",
      lifecycle: "installed",
      toEndpointId: to.id,
      points: [
        { position: [1, 2.3, 1], floorId: "f-lower", roomId: "r-l-a" },
        { position: [3, 2.3, 1], floorId: "f-lower", roomId: "r-l-b" },
      ],
    });
    expect(created.status).toBe(200);

    const deleted = await DELETE(
      jsonRequest(`/api/house-model/${h.modelId}/endpoints?id=${to.id}`, "DELETE"),
      ctx({ modelId: h.modelId }),
    );
    expect(deleted.status).toBe(204);

    const { routes } = await bodyOf<{ routes: RouteDto[] }>(
      await GET_ROUTES(
        jsonRequest(`/api/house-model/${h.modelId}/routes`, "GET"),
        ctx({ modelId: h.modelId }),
      ),
    );
    // The run is intact; only the claim about its far end is gone (`ON DELETE SET NULL`).
    expect(routes).toHaveLength(1);
    expect(routes[0]?.points).toHaveLength(2);
    expect(routes[0]?.toEndpointId).toBeNull();
  });
});
