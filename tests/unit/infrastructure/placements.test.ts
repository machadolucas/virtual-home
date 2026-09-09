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

import { eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { asset, assetPlacement } from "@/db/schema";
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
    // Nothing is partial any more: the HA entity link is joined in rather than reported missing.
    expect(created.partialFields).toEqual([]);

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

  it("stores a ceiling mount and answers it as a ceiling mount", async () => {
    const created = await bodyOf<{ placement: PersistedPlacement }>(
      await put({
        position: [1.5, 2.4, 1.5],
        mount: { kind: "ceiling", surfaceId: "s-r-l-a-ceiling", height: 2.4, offset: 0.01 },
      }),
    );
    // It used to come back narrowed to a wall mount, because the workspace's union had no name
    // for a ceiling. It has one now — which is what makes an eave fixture expressible.
    expect(created.placement.mountKind).toBe("ceiling");
    expect(created.placement.mount).toMatchObject({
      kind: "ceiling",
      surfaceId: "s-r-l-a-ceiling",
      height: 2.4,
      offset: 0.01,
    });
    expect(h.handle.db.select().from(assetPlacement).all()[0]?.mountKind).toBe("ceiling");
  });

  it("stores a free mount as free, rather than flattening it to a floor mount", async () => {
    const created = await bodyOf<{ placement: PersistedPlacement }>(
      await put({ position: [1.5, 1.8, 1.5], mount: { kind: "free", height: 1.8 } }),
    );
    expect(created.placement.mountKind).toBe("free");
    expect(created.placement.mount).toMatchObject({ kind: "free" });
  });

  it("round-trips the chosen symbol, and leaves it null when nobody chose", async () => {
    const withSymbol = await bodyOf<{ placement: PersistedPlacement & { symbol: string | null } }>(
      await put({ position: [1.5, 0.4, 1.5], symbol: "lamp_post" }),
    );
    expect(withSymbol.placement.symbol).toBe("lamp_post");

    const listed = await bodyOf<{ placements: (PersistedPlacement & { symbol: string | null })[] }>(
      await list(),
    );
    expect(listed.placements[0]?.symbol).toBe("lamp_post");

    // Clearing it hands the decision back to the view's inference.
    const cleared = await bodyOf<{ placement: PersistedPlacement & { symbol: string | null } }>(
      await put({ position: [1.5, 0.4, 1.5], symbol: null }),
    );
    expect(cleared.placement.symbol).toBeNull();
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

  it("reports nothing as partial, the HA entity link included", () => {
    expect(PARTIAL_FIELDS).not.toContain("mount");
    expect(PARTIAL_FIELDS).not.toContain("locationNote");
    expect(PARTIAL_FIELDS).not.toContain("photoId");
    // It was listed here while the endpoint hardcoded `entityId: null`, which left the whole live
    // layer in the 3D view dark: the stream subscribes to exactly these ids.
    expect(PARTIAL_FIELDS).not.toContain("entityId");
  });
});

/**
 * Outdoor equipment: a yard lamp or an eave spot sits outside every room footprint, because the
 * package's `rooms` are interior only. The endpoint always accepted it; the workspace used to
 * refuse to save it, which made every outdoor fixture unplaceable.
 */
describe("placement outside every room", () => {
  it("stores a placement with no room, anchored to the floor", async () => {
    const created = await bodyOf<{ placement: PersistedPlacement }>(
      await put({ position: [8, 0.4, 6.5], roomId: null, locationNote: "In the eave, above the wood store" }),
    );

    expect(created.placement.roomId).toBeNull();
    expect(created.placement.floorId).toBe("f-lower");
    expect(created.placement.locationNote).toBe("In the eave, above the wood store");

    const row = h.handle.db.select().from(assetPlacement).all()[0];
    // The anchor is the floor node, which is what `resolveNode` falls back to when no room
    // contains the point.
    expect(row?.modelNodeId).toBe("f-lower");

    const listed = await bodyOf<{ placements: PersistedPlacement[] }>(await list());
    expect(listed.placements).toHaveLength(1);
    expect(listed.placements[0]?.roomId).toBeNull();
  });
});

/**
 * `?options=placeable` is how the workspace learns what there is left to place. Without it,
 * equipment imported from Home Assistant appeared nowhere: the tree and search both read
 * `placements`, which only ever holds things already placed.
 */
describe("placeable equipment options", () => {
  const placeable = () =>
    GET(
      jsonRequest(`/api/house-model/${h.modelId}/placements?options=placeable`, "GET"),
      ctx({ modelId: h.modelId }),
    );

  it("lists equipment that has no placement yet", async () => {
    const body = await bodyOf<{ placeable: { assetId: string; name: string }[] }>(await placeable());
    expect(body.placeable.map((e) => e.assetId)).toContain(equipmentId);
  });

  it("drops it once it has coordinates", async () => {
    await put({ position: [1.5, 0.4, 1.5] });
    const body = await bodyOf<{ placeable: { assetId: string }[] }>(await placeable());
    expect(body.placeable.map((e) => e.assetId)).not.toContain(equipmentId);
  });

  it("still offers equipment whose placement is a location-only record", async () => {
    // No coordinates: nothing to draw, so it still needs placing.
    h.handle.db
      .insert(assetPlacement)
      .values({
        id: "loc-only",
        assetId: equipmentId,
        modelRevisionId: h.revisionId,
        modelNodeId: "f-lower",
        posX: null,
        posY: null,
        posZ: null,
        placementKind: "body",
        mountKind: "floor",
        createdAtMs: 1,
        createdBy: SESSION_USER_ID,
        updatedAtMs: 1,
        updatedBy: SESSION_USER_ID,
      })
      .run();

    const body = await bodyOf<{ placeable: { assetId: string }[] }>(await placeable());
    expect(body.placeable.map((e) => e.assetId)).toContain(equipmentId);
  });
});

/**
 * The Home Assistant link, joined into the placement.
 *
 * This endpoint used to answer `entityId: null` unconditionally. The consequence was not cosmetic:
 * `useHaStream` builds its SSE subscription purely from these ids, so the workspace never opened a
 * stream — every marker stayed "unlinked" grey, no battery or state badge ever appeared, and the
 * inspector told the household an entity was not linked when it was.
 */
describe("the HA entity link on a placement", () => {
  const linkEntity = (
    assetId: string,
    registryId: string,
    entityId: string,
    over: { role?: string; linkState?: string } = {},
  ) => {
    const at = 1_700_000_000_000;
    h.handle.sqlite
      .prepare(
        `INSERT INTO ha_entity (registry_id, entity_id, domain, first_seen_ms, last_seen_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(registryId, entityId, entityId.split(".")[0], at, at);
    h.handle.sqlite
      .prepare(
        `INSERT INTO asset_ha_link
           (id, asset_id, link_kind, ha_entity_registry_id, role, link_state,
            created_at_ms, created_by, updated_at_ms, updated_by)
         VALUES (?, ?, 'entity', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `link-${registryId}`,
        assetId,
        registryId,
        over.role ?? "primary",
        over.linkState ?? "active",
        at,
        SESSION_USER_ID,
        at,
        SESSION_USER_ID,
      );
  };

  it("answers the entity id the stream needs", async () => {
    linkEntity(equipmentId, "reg-1", "sensor.utility_humidity");
    await put({ position: [1.5, 0.4, 1.5] });

    const listed = await bodyOf<{ placements: PersistedPlacement[] }>(await list());
    expect(listed.placements[0]?.entityId).toBe("sensor.utility_humidity");
  });

  it("reads the entity id from the registry, not from the link's stale snapshot", async () => {
    // Rule 8: the link is bound by registry id; `entity_id_snapshot` is a paper trail that goes
    // stale the moment somebody renames the entity in Home Assistant.
    linkEntity(equipmentId, "reg-2", "sensor.new_name");
    h.handle.sqlite
      .prepare(`UPDATE asset_ha_link SET entity_id_snapshot = 'sensor.old_name'`)
      .run();
    await put({ position: [1.5, 0.4, 1.5] });

    const listed = await bodyOf<{ placements: PersistedPlacement[] }>(await list());
    expect(listed.placements[0]?.entityId).toBe("sensor.new_name");
  });

  it("treats a renamed link as live, because renaming is what produces that state", async () => {
    linkEntity(equipmentId, "reg-3", "sensor.renamed_one", { linkState: "renamed" });
    await put({ position: [1.5, 0.4, 1.5] });

    const listed = await bodyOf<{ placements: PersistedPlacement[] }>(await list());
    expect(listed.placements[0]?.entityId).toBe("sensor.renamed_one");
  });

  it("prefers the primary role when an asset carries several links", async () => {
    linkEntity(equipmentId, "reg-4", "sensor.secondary", { role: "status" });
    linkEntity(equipmentId, "reg-5", "sensor.the_primary", { role: "primary" });
    await put({ position: [1.5, 0.4, 1.5] });

    const listed = await bodyOf<{ placements: PersistedPlacement[] }>(await list());
    expect(listed.placements[0]?.entityId).toBe("sensor.the_primary");
  });

  it("stays null for equipment with no link, rather than inventing one", async () => {
    await put({ position: [1.5, 0.4, 1.5] });
    const listed = await bodyOf<{ placements: PersistedPlacement[] }>(await list());
    expect(listed.placements[0]?.entityId).toBeNull();
  });

  it("ignores a removed entity — a link to something HA no longer has is not live", async () => {
    linkEntity(equipmentId, "reg-6", "sensor.gone");
    h.handle.sqlite.prepare(`UPDATE ha_entity SET removed_at_ms = 1 WHERE registry_id = 'reg-6'`).run();
    await put({ position: [1.5, 0.4, 1.5] });

    const listed = await bodyOf<{ placements: PersistedPlacement[] }>(await list());
    expect(listed.placements[0]?.entityId).toBeNull();
  });
});

describe("surface policy round trips", () => {
  it.each([
    { surfaceId: "s-e-roof-fx-under", kind: "ceiling", position: [-0.2, 4.95, 1] },
    { surfaceId: "s-e-l-ext-out", kind: "wall", position: [-0.02, 1.35, 1.4] },
  ])("persists a roomless $kind mount on $surfaceId", async ({ surfaceId, kind, position }) => {
    const response = await put({ position, roomId: null,
      mount: { kind, surfaceId, height: kind === "wall" ? 1.35 : 0, offset: kind === "wall" ? 0.02 : 0 } });
    expect(response.status).toBe(200);
    const listed = await bodyOf<{ placements: PersistedPlacement[] }>(await list());
    expect(listed.placements[0]).toMatchObject({ roomId: null, surfaceId, position,
      mount: { kind, surfaceId } });
  });

  it.each(["wall", "ceiling"])("rejects terrain for a %s mount", async (kind) => {
    const response = await put({ position: [1, 0, 1], roomId: null,
      mount: { kind, surfaceId: "s-e-terrain-fx", height: 0, offset: 0 } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "mount_surface_kind_mismatch" });
  });
});


describe("equipment lifecycle in the viewer", () => {
  const available = async () => bodyOf<{ placeable: { assetId: string; name: string }[] }>(
    await GET(jsonRequest(`/api/house-model/${h.modelId}/placements?options=placeable`, "GET"), ctx({ modelId: h.modelId })),
  );

  it.each(["removed", "retired", "lost"] as const)("excludes %s equipment before and after reimport without deleting history", async (status) => {
    writeTx(h.handle.db, (tx) => {
      tx.update(asset).set({ status }).where(eq(asset.id, equipmentId)).run();
    });
    const reimportedId = seedAsset(h.handle, "Humidity sensor");
    const result = await available();
    expect(result.placeable.filter((row) => row.name === "Humidity sensor").map((row) => row.assetId)).toEqual([reimportedId]);
    expect(h.handle.db.select().from(asset).where(eq(asset.id, equipmentId)).get()).toBeDefined();
    const refused = await put({ position: [1, 0, 1] });
    expect(refused.status).toBe(409);
    expect(await bodyOf<{ error: string }>(refused)).toMatchObject({ error: "equipment_not_current" });
  });

  it("hides old placed markers while preserving their historical coordinates", async () => {
    await put({ position: [1, 0, 1] });
    writeTx(h.handle.db, (tx) => tx.update(asset).set({ status: "removed" }).where(eq(asset.id, equipmentId)).run());
    expect((await bodyOf<{ placements: Placement[] }>(await list())).placements).toEqual([]);
    expect(h.handle.db.select().from(assetPlacement).all()).toHaveLength(1);
  });

  it("excludes replaced and software units, and still offers planned physical equipment", async () => {
    const successor = seedAsset(h.handle, "Successor");
    const software = seedAsset(h.handle, "Software");
    writeTx(h.handle.db, (tx) => {
      tx.update(asset).set({ replacedByAssetId: successor }).where(eq(asset.id, equipmentId)).run();
      tx.update(asset).set({ isVirtual: true }).where(eq(asset.id, software)).run();
      tx.update(asset).set({ status: "planned" }).where(eq(asset.id, successor)).run();
    });
    expect((await available()).placeable.map((row) => row.assetId)).toEqual([successor]);
  });
});
