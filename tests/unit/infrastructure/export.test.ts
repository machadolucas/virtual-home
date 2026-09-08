/**
 * `GET /api/exports/infrastructure`.
 *
 * The assertion that matters is the envelope. A CSV of `pos_x, pos_y, pos_z` is worthless in ten
 * years unless it says which model, which revision and which coordinate frame those metres are in
 * (`docs/design-notes/domain-scheduling-inventory.md` §8.4) — so the coordinate system travelling
 * with every response is a test, not a comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { SESSION_USER_ID } = vi.hoisted(() => ({
  SESSION_USER_ID: "01900000-0000-7000-8000-000000000001",
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: SESSION_USER_ID } }),
  requireFreshSession: async () => ({ user: { id: SESSION_USER_ID } }),
  getSession: async () => ({ user: { id: SESSION_USER_ID } }),
  UnauthorizedError: class UnauthorizedError extends Error {
    readonly status = 401 as const;
  },
}));

import { exportRun } from "@/db/schema";
import { GET as EXPORT } from "@/app/api/exports/infrastructure/route";
import { PUT as PUT_ROUTE } from "@/app/api/house-model/[modelId]/routes/route";
import { csvCell, toCsv } from "@/server/queries/infrastructure/exportInfrastructure";
import type { ExportEnvelope } from "@/server/queries/infrastructure/exportInfrastructure";
import { bodyOf, ctx, jsonRequest, setupHarness, teardownHarness, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await setupHarness();
  // One real route, so the export has something with coordinates in it.
  await PUT_ROUTE(
    jsonRequest(`/api/house-model/${h.modelId}/routes`, "PUT", {
      fingerprint: h.fingerprint,
      viewMode: "normal",
      route: {
        name: "Riser to the upper floor",
        system: "water",
        medium: "hot_water",
        certainty: "inferred",
        lifecycle: "installed",
        installedOn: "2012-08-15",
        points: [
          { position: [2, 0.4, 2], floorId: "f-lower", roomId: "r-l-b" },
          { position: [2, 3, 2], floorId: "f-upper", roomId: "r-u-a" },
        ],
      },
    }),
    ctx({ modelId: h.modelId }),
  );
});

afterEach(() => {
  teardownHarness(h);
});

const request = (query = "") =>
  EXPORT(jsonRequest(`/api/exports/infrastructure${query}`, "GET"), undefined);

describe("JSON export", () => {
  it("carries the model, the revision and the coordinate system with the numbers", async () => {
    const res = await request();
    expect(res.status).toBe(200);
    const body = await bodyOf<ExportEnvelope>(res);

    expect(body.app.name).toBe("virtual-home");
    expect(body.app.schemaVersion).toBeGreaterThan(0);
    expect(body.household.timezone).toBe("Europe/Helsinki");
    expect(body.model).not.toBeNull();
    expect(body.model?.modelId).toBe(h.modelId);
    expect(body.model?.revisionId).toBe(h.revisionId);
    expect(body.model?.coordinateSystem).toEqual({
      units: "m",
      up: "y",
      forward: "-z",
      origin: "model-frame",
    });
    expect(body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("nests each route's points inside it, in seq order", async () => {
    const body = await bodyOf<ExportEnvelope>(await request());
    const routes = body.datasets.infraRoutes as Array<{
      name: string;
      medium: string;
      installed_on: string;
      points: Array<{ seq: number; pos_y: number; floor_id: string }>;
    }>;
    expect(routes).toHaveLength(1);
    expect(routes[0]?.medium).toBe("hot_water");
    expect(routes[0]?.installed_on).toBe("2012-08-15");
    expect(routes[0]?.points.map((p) => p.seq)).toEqual([0, 1]);
    expect(routes[0]?.points[1]?.floor_id).toBe("f-upper");
  });

  it("records the run: who exported what, and how many rows", async () => {
    await request();
    const runs = h.handle.db.select().from(exportRun).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.requestedBy).toBe(SESSION_USER_ID);
    expect(runs[0]?.status).toBe("done");
    expect(JSON.parse(runs[0]?.rowCountsJson ?? "{}")).toMatchObject({
      infraRoutes: 1,
      infraRoutePoints: 2,
    });
  });
});

describe("CSV export", () => {
  it("serves a manifest naming every dataset and where to fetch it", async () => {
    const res = await request("?format=csv");
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("dataset,row_count,url");
    expect(text).toContain("infraRoutes");
    expect(text).toContain("format=csv&dataset=infraRoutePoints");
  });

  it("serves one dataset, with coordinates beside their node and revision ids", async () => {
    const res = await request("?format=csv&dataset=infraRoutePoints");
    const text = await res.text();
    const [header, first] = text.trim().split("\r\n");
    expect(header).toContain("pos_x,pos_y,pos_z,model_node_id,floor_id,room_id");
    expect(first).toContain("f-lower");
    expect(res.headers.get("Content-Disposition")).toContain("infraRoutePoints");
  });

  it("files the frame beside the rows as _context.json", async () => {
    const res = await request("?format=context");
    const body = JSON.parse(await res.text()) as ExportEnvelope;
    expect(body.model?.coordinateSystem).toBeTruthy();
    expect(body.rowCounts).toMatchObject({ infraRoutes: 1 });
    // The context is metadata only: no rows travel in it.
    expect((body as unknown as { datasets?: unknown }).datasets).toBeUndefined();
  });

  it("refuses a format and a dataset it does not know", async () => {
    expect((await request("?format=xlsx")).status).toBe(400);
    expect((await request("?format=csv&dataset=everything")).status).toBe(400);
  });
});

describe("CSV escaping", () => {
  it("writes NULL as an empty field, never the four letters", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
  });

  it("quotes what RFC 4180 requires and doubles embedded quotes", () => {
    expect(csvCell('he said "no"')).toBe('"he said ""no"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("plain")).toBe("plain");
  });

  it("takes the header from the union of the keys, so a sparse row still lines up", () => {
    expect(toCsv([{ a: 1 }, { b: 2 }])).toBe("a,b\r\n1,\r\n,2\r\n");
  });
});
