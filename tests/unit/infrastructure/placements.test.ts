/**
 * `GET/PUT /api/house-model/[modelId]/placements` after the mount columns were added.
 *
 * The point of the change is one sentence from `docs/model-contract.md` §3.1 that used to be a
 * confession and is now history: *"A wall-mounted sensor keeps its coordinates; it loses the record
 * of which wall."* These tests assert that it does not.
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

import { assetPlacement } from "@/db/schema";
import { GET, PARTIAL_FIELDS, PUT } from "@/app/api/house-model/[modelId]/placements/route";
import type { Placement } from "@/house/model/types";
import { bodyOf, ctx, jsonRequest, seedAsset, setupHarness, teardownHarness, type Harness } from "./harness";

type PersistedPlacement = Placement & {
  mountKind: string;
  mountSurfaceId: string | null;
  mountHeightM: number | null;
  mountOffsetM: number | null;
};

let h: Harness;
let equipmentId: string;

beforeEach(async () => {
  h = await setupHarness();
  equipmentId = seedAsset(h.handle, "Humidity sensor");
});

afterEach(() => {
  teardownHarness(h);
});

const put = (placement: Record<string, unknown>) =>
  PUT(
    jsonRequest(`/api/house-model/${h.modelId}/placements`, "PUT", {
      fingerprint: h.fingerprint,
      viewMode: "normal",
      placement: { equipmentId, floorId: "f-lower", roomId: "r-l-a", ...placement },
    }),
    ctx({ modelId: h.modelId }),
  );

const list = () =>
  GET(jsonRequest(`/api/house-model/${h.modelId}/placements`, "GET"), ctx({ modelId: h.modelId }));

describe("placement mount round trip", () => {
  it("keeps which wall a wall mount is on, with its height and standoff", async () => {
    const created = await bodyOf<{ placement: PersistedPlacement; partialFields: string[] }>(
      await put({
        position: [1.2, 1.4, 0.52],
        mount: { kind: "wall", surfaceId: "s-w-l-ab--r-l-a", height: 1.4, offset: 0.02 },
        locationNote: "Left of the hatch, above the manifold",
      }),
    );

    expect(created.placement.mount).toEqual({
      kind: "wall",
      surfaceId: "s-w-l-ab--r-l-a",
      height: 1.4,
      offset: 0.02,
    });
    expect(created.placement.surfaceId).toBe("s-w-l-ab--r-l-a");
    expect(created.placement.locationNote).toBe("Left of the hatch, above the manifold");
    // The one field that still cannot round-trip is named, not hidden.
    expect(created.partialFields).toEqual(["entityId"]);

    const row = h.handle.db.select().from(assetPlacement).all()[0];
    expect(row?.mountKind).toBe("wall");
    expect(row?.mountSurfaceId).toBe("s-w-l-ab--r-l-a");
    expect(row?.mountHeightM).toBe(1.4);
    expect(row?.mountOffsetM).toBe(0.02);
    expect(row?.locationNote).toBe("Left of the hatch, above the manifold");

    const listed = await bodyOf<{ placements: PersistedPlacement[] }>(await list());
    expect(listed.placements[0]?.mount).toEqual({
      kind: "wall",
      surfaceId: "s-w-l-ab--r-l-a",
      height: 1.4,
      offset: 0.02,
    });
    expect(listed.placements[0]?.mountKind).toBe("wall");
  });

  it("still defaults to a floor mount measured from the room's own floor elevation", async () => {
    // r-l-b sits 0.2 m below the lower-floor datum in the fixture's floorDatums.
    const created = await bodyOf<{ placement: PersistedPlacement }>(
      await put({ position: [3, 0.8, 3], roomId: "r-l-b" }),
    );
    expect(created.placement.mountKind).toBe("floor");
    expect(created.placement.mount.kind).toBe("floor");
    expect(created.placement.mount.height).toBeCloseTo(1, 3);
  });

  it("stores a ceiling mount, and answers it in the workspace's narrower union", async () => {
    const created = await bodyOf<{ placement: PersistedPlacement }>(
      await put({
        position: [1.5, 2.4, 1.5],
        mount: { kind: "ceiling", surfaceId: "s-r-l-a-ceiling", height: 2.4, offset: 0.01 },
      }),
    );
    // The true value travels beside the narrower one, so nothing is silently coarsened.
    expect(created.placement.mountKind).toBe("ceiling");
    expect(created.placement.mount).toMatchObject({ kind: "wall", surfaceId: "s-r-l-a-ceiling" });
    expect(h.handle.db.select().from(assetPlacement).all()[0]?.mountKind).toBe("ceiling");
  });

  it("refuses a wall mount on a surface that is not a wall", async () => {
    const res = await put({
      position: [1.5, 1.4, 1.5],
      mount: { kind: "wall", surfaceId: "s-r-l-a-ceiling", height: 1.4, offset: 0.02 },
    });
    expect(res.status).toBe(400);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({
      error: "mount_surface_kind_mismatch",
    });
  });

  it("refuses a mount surface the package does not know", async () => {
    const res = await put({
      position: [1.5, 1.4, 1.5],
      mount: { kind: "wall", surfaceId: "s-nope", height: 1.4, offset: 0.02 },
    });
    expect(res.status).toBe(400);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: "unknown_surface" });
  });

  it("refuses a photo id that is not an attachment", async () => {
    const res = await put({ position: [1.5, 0.4, 1.5], photoId: "not-an-attachment" });
    expect(res.status).toBe(409);
    expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: "unknown_attachment" });
  });

  it("still refuses a presentation coordinate", async () => {
    const res = await PUT(
      jsonRequest(`/api/house-model/${h.modelId}/placements`, "PUT", {
        fingerprint: h.fingerprint,
        viewMode: "exploded",
        placement: { equipmentId, floorId: "f-lower", position: [1, 0.4, 1] },
      }),
      ctx({ modelId: h.modelId }),
    );
    expect(res.status).toBe(422);
    expect(h.handle.db.select().from(assetPlacement).all()).toHaveLength(0);
  });

  it("reports the mount as no longer partial", () => {
    expect(PARTIAL_FIELDS).not.toContain("mount");
    expect(PARTIAL_FIELDS).not.toContain("locationNote");
    expect(PARTIAL_FIELDS).not.toContain("photoId");
  });
});
