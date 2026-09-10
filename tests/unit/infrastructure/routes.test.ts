/**
 * `GET/PUT /api/house-model/[modelId]/routes` and `DELETE .../routes/[routeId]`.
 *
 * The handlers are called directly with a mocked session, against a real migrated database and the
 * real synthetic fixture package. What is being asserted is the persistence contract, not the
 * plumbing: points survive with their per-segment floor/room, confidence is stored as stated, a
 * presentation coordinate is refused, a missing revision is a 409 the client can fall back on, and
 * a delete is soft.
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
import { infraRoute, infraRoutePoint, modelRevision } from "@/db/schema";
import { GET, PUT } from "@/app/api/house-model/[modelId]/routes/route";
import { DELETE } from "@/app/api/house-model/[modelId]/routes/[routeId]/route";
import type { RouteDto } from "@/features/projects/wire";
import { routeWrite } from "@/house/store/dataApi";
import {
  bodyOf,
  ctx,
  jsonRequest,
  seedAsset,
  seedProject,
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

/** A valid two-point run inside the fixture's lower floor. */
function routeBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: h.fingerprint,
    viewMode: "normal",
    route: {
      name: "Kitchen cold water",
      system: "water",
      certainty: "observed",
      lifecycle: "installed",
      installedOn: "2018-04-01",
      points: [
        { position: [1, 0.4, 1], floorId: "f-lower", roomId: "r-l-a" },
        { position: [3, 0.4, 1], floorId: "f-lower", roomId: "r-l-b" },
      ],
      ...over,
    },
  };
}

const put = (body: unknown) =>
  PUT(jsonRequest(`/api/house-model/${h.modelId}/routes`, "PUT", body), ctx({ modelId: h.modelId }));

const list = () =>
  GET(jsonRequest(`/api/house-model/${h.modelId}/routes`, "GET"), ctx({ modelId: h.modelId }));

describe("PUT routes", () => {
  it("persists the polyline with its per-segment floor and room, and its confidence", async () => {
    const res = await put(routeBody());
    expect(res.status).toBe(200);
    const { route, partialFields } = await bodyOf<{ route: RouteDto; partialFields: string[] }>(res);

    expect(route.points).toEqual([
      [1, 0.4, 1],
      [3, 0.4, 1],
    ]);
    expect(route.segments).toEqual([{ floorId: "f-lower", roomId: "r-l-a" }]);
    expect(route.certainty).toBe("observed");
    expect(route.lifecycle).toBe("installed");
    expect(route.installedAt).toBe("2018-04-01");
    // The workspace's derived view of the stored medium.
    expect(route.medium).toBe("cold_water");
    expect(route.system).toBe("water");
    expect(route.kind).toBe("pipe");
    // Honest about what the table cannot hold.
    expect(partialFields).toContain("kind");

    const rows = h.handle.db.select().from(infraRoute).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.modelRevisionId).toBe(h.revisionId);
    expect(rows[0]?.certainty).toBe("observed");
    expect(rows[0]?.isEstimated).toBe(true); // observed is not measured

    const points = h.handle.db
      .select()
      .from(infraRoutePoint)
      .where(eq(infraRoutePoint.routeId, route.id))
      .all();
    expect(points.map((p) => p.seq)).toEqual([0, 1]);
    expect(points[0]?.roomId).toBe("r-l-a");
    expect(points[1]?.roomId).toBe("r-l-b");
  });

  it("rounds coordinates to millimetres, because that is what the model is honest to", async () => {
    const res = await put(
      routeBody({
        points: [
          { position: [1.00049, 0.4, 1], floorId: "f-lower", roomId: "r-l-a" },
          { position: [3.00051, 0.4, 1], floorId: "f-lower", roomId: "r-l-a" },
        ],
      }),
    );
    const { route } = await bodyOf<{ route: RouteDto }>(res);
    expect(route.points[0]?.[0]).toBe(1);
    expect(route.points[1]?.[0]).toBe(3.001);
  });

  it("refuses a coordinate read in an exploded view (422)", async () => {
    const res = await PUT(
      jsonRequest(`/api/house-model/${h.modelId}/routes`, "PUT", {
        ...routeBody(),
        viewMode: "exploded",
      }),
      ctx({ modelId: h.modelId }),
    );
    expect(res.status).toBe(422);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: "presentation_view_mode" });
    expect(h.handle.db.select().from(infraRoute).all()).toHaveLength(0);
  });

  it("refuses a stale fingerprint (409)", async () => {
    const res = await put({ ...routeBody(), fingerprint: "0000000000000000" });
    expect(res.status).toBe(409);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: "stale_fingerprint" });
  });

  it("answers 409 model_revision_missing when nothing has been imported yet", async () => {
    // Remove the seeded revision: this is the state the workspace falls back to a session store in.
    h.handle.db.delete(modelRevision).where(eq(modelRevision.id, h.revisionId)).run();
    const res = await put(routeBody());
    expect(res.status).toBe(409);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: "model_revision_missing" });
  });

  it("refuses a point outside the package's own bounds", async () => {
    const res = await put(
      routeBody({
        points: [
          { position: [1, 0.4, 1], floorId: "f-lower" },
          { position: [900, 0.4, 1], floorId: "f-lower" },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: "out_of_bounds" });
  });

  it("refuses ids the package does not know", async () => {
    const badRoom = await put(
      routeBody({
        points: [
          { position: [1, 0.4, 1], floorId: "f-lower", roomId: "r-nope" },
          { position: [3, 0.4, 1], floorId: "f-lower", roomId: "r-l-a" },
        ],
      }),
    );
    expect(badRoom.status).toBe(400);
    expect(await bodyOf<{ error: string }>(badRoom)).toMatchObject({ error: "unknown_room" });

    const badSurface = await put(routeBody({ offsetSurfaceId: "s-nope", offsetM: 0.02 }));
    expect(badSurface.status).toBe(400);
    expect(await bodyOf<{ error: string }>(badSurface)).toMatchObject({ error: "unknown_surface" });
  });

  it("stores the depth and the offset from a real wall surface", async () => {
    const res = await put(
      routeBody({ depthM: -0.04, offsetSurfaceId: "s-w-l-ab--r-l-a", offsetM: 0.02 }),
    );
    const { route } = await bodyOf<{ route: RouteDto }>(res);
    expect(route.depthM).toBe(-0.04);
    expect(route.offsetFrom).toEqual({
      surfaceId: "s-w-l-ab--r-l-a",
      kind: "wall",
      offsetM: 0.02,
    });
  });

  it("keeps a specific medium across a workspace round trip", async () => {
    const created = await bodyOf<{ route: RouteDto }>(await put(routeBody({ medium: "hot_water" })));
    expect(created.route.medium).toBe("hot_water");

    // The workspace only knows `system: 'water'`; the stored medium must survive.
    const resaved = await bodyOf<{ route: RouteDto }>(
      await put(routeBody({ id: created.route.id, system: "water" })),
    );
    expect(resaved.route.id).toBe(created.route.id);
    expect(resaved.route.medium).toBe("hot_water");
  });

  it("refuses a medium that contradicts the stated system", async () => {
    const res = await put(routeBody({ system: "network", medium: "hot_water" }));
    expect(res.status).toBe(400);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({
      error: "medium_system_mismatch",
    });
  });

  it("replaces the polyline wholesale rather than leaving a hole in seq", async () => {
    const created = await bodyOf<{ route: RouteDto }>(await put(routeBody()));
    await put(
      routeBody({
        id: created.route.id,
        points: [
          { position: [1, 0.4, 1], floorId: "f-lower", roomId: "r-l-a" },
          { position: [2, 0.4, 1], floorId: "f-lower", roomId: "r-l-a" },
          { position: [3, 0.4, 1], floorId: "f-lower", roomId: "r-l-b" },
        ],
      }),
    );
    const points = h.handle.db
      .select()
      .from(infraRoutePoint)
      .where(eq(infraRoutePoint.routeId, created.route.id))
      .all();
    expect(points.map((p) => p.seq).sort()).toEqual([0, 1, 2]);
  });

  it("stamps today as the removal date when a route is saved as removed with none", async () => {
    const { route } = await bodyOf<{ route: RouteDto }>(
      await put(routeBody({ lifecycle: "removed" })),
    );
    expect(route.removedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses a removal date before the installation date", async () => {
    const res = await put(
      routeBody({ lifecycle: "removed", installedOn: "2020-01-01", removedOn: "2019-01-01" }),
    );
    expect(res.status).toBe(400);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({
      error: "removed_before_installed",
    });
  });

  it("refuses references that do not exist, naming which one", async () => {
    const badProject = await put(routeBody({ projectId: "does-not-exist" }));
    expect(badProject.status).toBe(409);
    expect(await bodyOf<{ error: string }>(badProject)).toMatchObject({
      error: "unknown_project",
    });

    const badAsset = await put(
      routeBody({
        points: [
          { position: [1, 0.4, 1], floorId: "f-lower", assetId: "nope" },
          { position: [3, 0.4, 1], floorId: "f-lower" },
        ],
      }),
    );
    expect(badAsset.status).toBe(409);
    expect(await bodyOf<{ error: string }>(badAsset)).toMatchObject({ error: "unknown_asset" });
  });

  it("accepts a project and an asset that do exist", async () => {
    const projectId = seedProject(h.handle);
    const assetId = seedAsset(h.handle, "Manifold");
    const { route } = await bodyOf<{ route: RouteDto }>(
      await put(
        routeBody({
          projectId,
          points: [
            { position: [1, 0.4, 1], floorId: "f-lower", assetId, pointKind: "valve" },
            { position: [3, 0.4, 1], floorId: "f-lower" },
          ],
        }),
      ),
    );
    expect(route.projectId).toBe(projectId);
    expect(route.renovationId).toBe(projectId);
    expect(route.pointKinds[0]).toBe("valve");
  });
});

describe("GET routes", () => {
  it("preserves both ends of a two-floor riser through read and re-save", async () => {
    const pointPlaces = [
      { floorId: "f-lower", roomId: "r-l-a" },
      { floorId: "f-upper", roomId: "r-u-a" },
    ];
    const createdResponse = await put(routeBody({ points: [
      { position: [1, .4, 1], ...pointPlaces[0] },
      { position: [1, 3.1, 1], ...pointPlaces[1] },
    ] }));
    expect(createdResponse.status).toBe(200);
    const created = await bodyOf<{ route: RouteDto }>(createdResponse);
    expect(created.route.pointPlaces).toEqual(pointPlaces);
    const reread = await bodyOf<{ routes: RouteDto[] }>(await list());
    expect(reread.routes[0]?.pointPlaces).toEqual(pointPlaces);
    const saved = await put({ fingerprint: h.fingerprint, viewMode: "normal", route: routeWrite(reread.routes[0]!) });
    expect(saved.status).toBe(200);
    expect((await bodyOf<{ route: RouteDto }>(saved)).route.pointPlaces).toEqual(pointPlaces);
  });

  it("returns nothing (not an error) before anything is drawn", async () => {
    const body = await bodyOf<{ routes: RouteDto[]; stale: string[] }>(await list());
    expect(body.routes).toEqual([]);
    expect(body.stale).toEqual([]);
  });

  it("round-trips a saved route", async () => {
    const created = await bodyOf<{ route: RouteDto }>(await put(routeBody()));
    const body = await bodyOf<{ routes: RouteDto[] }>(await list());
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]).toMatchObject({
      id: created.route.id,
      name: "Kitchen cold water",
      certainty: "observed",
      points: [
        [1, 0.4, 1],
        [3, 0.4, 1],
      ],
    });
  });

  it("reports a route whose floor id the package no longer knows, instead of dropping it", async () => {
    const created = await bodyOf<{ route: RouteDto }>(await put(routeBody()));
    h.handle.db
      .update(infraRoutePoint)
      .set({ floorId: "f-gone" })
      .where(eq(infraRoutePoint.routeId, created.route.id))
      .run();

    const body = await bodyOf<{ routes: RouteDto[]; stale: string[] }>(await list());
    expect(body.stale).toEqual([created.route.id]);
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]?.needsReconciliation).toBe(true);
    expect(body.routes[0]?.segments[0]?.floorId).toBeNull();
  });

  it("serves the project options the inspector's picker needs", async () => {
    const projectId = seedProject(h.handle, "Bathroom 2024");
    const res = await GET(
      jsonRequest(`/api/house-model/${h.modelId}/routes?options=projects`, "GET"),
      ctx({ modelId: h.modelId }),
    );
    const body = await bodyOf<{ projects: Array<{ id: string; name: string }> }>(res);
    expect(body.projects).toEqual([{ id: projectId, name: "Bathroom 2024", status: "in_progress" }]);
  });
});

describe("DELETE routes/[routeId]", () => {
  it("is soft by default: lifecycle becomes removed and the date is stamped", async () => {
    const created = await bodyOf<{ route: RouteDto }>(await put(routeBody()));
    const res = await DELETE(
      jsonRequest(`/api/house-model/${h.modelId}/routes/${created.route.id}`, "DELETE"),
      ctx({ modelId: h.modelId, routeId: created.route.id }),
    );
    expect(res.status).toBe(200);
    const body = await bodyOf<{ route: RouteDto; softDeleted: boolean }>(res);
    expect(body.softDeleted).toBe(true);
    expect(body.route.lifecycle).toBe("removed");
    expect(body.route.removedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const rows = h.handle.db.select().from(infraRoute).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lifecycle).toBe("removed");
    // The path is still there: "why is there a capped stub behind this panel?" stays answerable.
    expect(
      h.handle.db
        .select()
        .from(infraRoutePoint)
        .where(eq(infraRoutePoint.routeId, created.route.id))
        .all(),
    ).toHaveLength(2);
  });

  it("does not rewrite an existing removal date on a second delete", async () => {
    const created = await bodyOf<{ route: RouteDto }>(
      await put(routeBody({ lifecycle: "removed", removedOn: "2019-05-01" })),
    );
    const res = await DELETE(
      jsonRequest(`/api/house-model/${h.modelId}/routes/${created.route.id}`, "DELETE"),
      ctx({ modelId: h.modelId, routeId: created.route.id }),
    );
    const body = await bodyOf<{ route: RouteDto }>(res);
    expect(body.route.removedAt).toBe("2019-05-01");
  });

  it("erases a wrongly drawn run with ?hard=1, taking its points with it", async () => {
    const created = await bodyOf<{ route: RouteDto }>(await put(routeBody()));
    const res = await DELETE(
      jsonRequest(`/api/house-model/${h.modelId}/routes/${created.route.id}?hard=1`, "DELETE"),
      ctx({ modelId: h.modelId, routeId: created.route.id }),
    );
    expect(res.status).toBe(204);
    expect(h.handle.db.select().from(infraRoute).all()).toHaveLength(0);
    expect(h.handle.db.select().from(infraRoutePoint).all()).toHaveLength(0);
  });

  it("404s on an unknown route", async () => {
    const res = await DELETE(
      jsonRequest(`/api/house-model/${h.modelId}/routes/nope`, "DELETE"),
      ctx({ modelId: h.modelId, routeId: "nope" }),
    );
    expect(res.status).toBe(404);
  });
});
