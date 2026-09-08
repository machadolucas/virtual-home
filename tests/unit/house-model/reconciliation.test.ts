/**
 * Model revision registration and the explicit reconciliation apply step.
 *
 * The whole point of D-016 is that a package swap never silently rewrites a row, so these tests
 * are about *who decided what*: which imports carry data forward on their own, which ones stop and
 * ask, and what each of the three answers (remap / keep / archive) actually does to the tables.
 *
 * `registerRevision` only ever reads `pkg.manifest`, `pkg.modelId` and `pkg.fingerprint`, so a
 * package is built by hand here from the synthetic fixture manifest — no GLBs, no temp directory,
 * no install. The fingerprint is the caller's input, which is what makes "the same ids in a new
 * build" expressible as a one-line change.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import {
  annotation,
  appAlert,
  asset,
  assetPlacement,
  auditLog,
  householdSetting,
  infraEndpoint,
  infraRoute,
  location,
  modelNodeAlias,
  modelReconciliation,
  modelReconciliationItem,
  modelRevision,
  storagePlace,
  surfaceColorOverride,
} from "@/db/schema";
import { ConflictError } from "@/domain/errors";
import { formatZodIssues, safeParseManifest } from "@/house/model/schema";
import type { Manifest } from "@/house/model/types";
import type { CurrentPackage } from "@/server/house-model/package";
import {
  abandonReconciliation,
  applyReconciliation,
  decideReconciliationItem,
  reconciliationSummary,
  registerRevision,
} from "@/server/house-model/revision";
import { seedUser, testDb } from "../../helpers/db";
import { FIXTURE_DIR, loadManifest } from "../house/glb";

/** The fixture room whose id the "new export" renames. Its tokens make it a scorable candidate. */
const CLOSET = "r-l-closet";
const CLOSET_RENAMED = "r-l-closet-renamed";
/** A room id present in every variant, so records pinned to it are never part of a plan. */
const STABLE_ROOM = "r-l-a";
const STABLE_SURFACE = "s-r-l-closet-floor";
const RENAMED_SURFACE = "s-r-l-closet-slab";

const base = loadManifest(FIXTURE_DIR);

function reparse(raw: unknown): Manifest {
  const parsed = safeParseManifest(raw);
  if (!parsed.success) throw new Error(formatZodIssues(parsed.error).join("\n"));
  return parsed.data;
}

/**
 * The fixture manifest with `r-l-closet` renamed everywhere it appears as a whole id (so the
 * room, and every reference to it, stay consistent), optionally shifted along X so the remap has a
 * real centroid delta to re-project.
 */
function renamedManifest(shiftX = 0): Manifest {
  const raw = JSON.parse(JSON.stringify(base).replaceAll(`"${CLOSET}"`, `"${CLOSET_RENAMED}"`)) as {
    rooms: Array<{ id: string; footprint: { outer: Array<[number, number]> } }>;
  };
  if (shiftX !== 0) {
    const room = raw.rooms.find((entry) => entry.id === CLOSET_RENAMED);
    if (!room) throw new Error(`fixture changed: no room ${CLOSET_RENAMED} after the rename`);
    room.footprint.outer = room.footprint.outer.map(([x, z]) => [x + shiftX, z]);
  }
  return reparse(raw);
}

/** The fixture manifest with the closet's floor *surface* renamed — rooms untouched. */
function renamedSurfaceManifest(): Manifest {
  return reparse(
    JSON.parse(JSON.stringify(base).replaceAll(`"${STABLE_SURFACE}"`, `"${RENAMED_SURFACE}"`)),
  );
}

/** The fixture manifest with `r-l-a` shifted along X, id unchanged: D-016's tolerance case. */
function movedStableRoomManifest(shiftX: number): Manifest {
  const raw = JSON.parse(JSON.stringify(base)) as {
    rooms: Array<{ id: string; footprint: { outer: Array<[number, number]> } }>;
  };
  const room = raw.rooms.find((entry) => entry.id === STABLE_ROOM);
  if (!room) throw new Error(`fixture changed: no room ${STABLE_ROOM}`);
  room.footprint.outer = room.footprint.outer.map(([x, z]) => [x + shiftX, z]);
  return reparse(raw);
}

function pkgOf(manifest: Manifest, fingerprint: string): CurrentPackage {
  return {
    modelId: manifest.modelId,
    fingerprint,
    // Never read by `registerRevision`; the files are `installPackage`'s business.
    dir: `/nonexistent/${fingerprint}`,
    manifest,
    diagnostics: [],
    assetFiles: new Map(),
    lock: null,
  };
}

let handle: DbHandle;
let actorUserId: string;

/** Ids of the rows every scenario seeds, so assertions do not have to re-query by shape. */
interface Seeded {
  placementId: string;
  colorId: string;
  routeId: string;
  endpointId: string;
  annotationId: string;
  roomLocationId: string;
}

/**
 * Runtime data stamped with `revisionId`: one record of every reconcilable shape. Only the
 * placement points at `nodeId` (the id a later package renames); everything else is pinned to ids
 * that survive, which is what makes "one item, and the rest simply re-stamped" assertable.
 */
function seedRuntimeData(revisionId: string, nodeId: string): Seeded {
  const at = 1_700_000_000_000;
  const ids: Seeded = {
    placementId: newId(),
    colorId: newId(),
    routeId: newId(),
    endpointId: newId(),
    annotationId: newId(),
    roomLocationId: newId(),
  };
  writeTx(handle.db, (tx) => {
    const propertyId = newId();
    const buildingId = newId();
    const floorId = newId();
    const quad = { createdAtMs: at, createdBy: actorUserId, updatedAtMs: at, updatedBy: actorUserId };
    tx.insert(location)
      .values([
        { id: propertyId, kind: "property", parentId: null, name: "Property", slug: "property", ...quad },
        { id: buildingId, kind: "building", parentId: propertyId, name: "House", slug: "house", ...quad },
        { id: floorId, kind: "floor", parentId: buildingId, name: "Lower", slug: "lower", floorLevel: 0, ...quad },
        {
          id: ids.roomLocationId,
          kind: "room",
          parentId: floorId,
          name: "Room A",
          slug: "room-a",
          modelRevisionId: revisionId,
          modelNodeId: STABLE_ROOM,
          ...quad,
        },
      ])
      .run();

    const assetId = newId();
    tx.insert(asset)
      .values({ id: assetId, name: "Heat pump", category: "hvac", status: "installed", ...quad })
      .run();
    tx.insert(assetPlacement)
      .values({
        id: ids.placementId,
        assetId,
        modelRevisionId: revisionId,
        modelNodeId: nodeId,
        posX: 5.25,
        posY: 1.1,
        posZ: 2,
        mountKind: "wall",
        mountSurfaceId: STABLE_SURFACE,
        ...quad,
      })
      .run();
    tx.insert(surfaceColorOverride)
      .values({
        id: ids.colorId,
        modelId: base.modelId,
        modelRevisionId: revisionId,
        surfaceId: STABLE_SURFACE,
        roomId: nodeId,
        colorHex: "#aabbcc",
        ...quad,
      })
      .run();
    tx.insert(infraRoute)
      .values({
        id: ids.routeId,
        name: "Cold water riser",
        medium: "cold_water",
        modelRevisionId: revisionId,
        ...quad,
      })
      .run();
    tx.insert(infraEndpoint)
      .values({
        id: ids.endpointId,
        name: "Shutoff",
        kind: "shutoff",
        modelRevisionId: revisionId,
        modelNodeId: STABLE_ROOM,
        posX: 1,
        posY: 1,
        posZ: 1,
        ...quad,
      })
      .run();
    tx.insert(annotation)
      .values({
        id: ids.annotationId,
        targetKind: "node",
        targetId: STABLE_ROOM,
        modelRevisionId: revisionId,
        modelNodeId: STABLE_ROOM,
        kind: "note",
        title: "Behind the hatch",
        ...quad,
      })
      .run();
  });
  return ids;
}

/**
 * An annotation and a route endpoint pinned to `nodeId`, so a plan can contain more than one kind
 * of row and the two archivable-by-deletion kinds are covered as well as the placement.
 */
function seedNodePinned(revisionId: string, nodeId: string): { annotationId: string; endpointId: string } {
  const at = 1_700_000_100_000;
  const quad = { createdAtMs: at, createdBy: actorUserId, updatedAtMs: at, updatedBy: actorUserId };
  const ids = { annotationId: newId(), endpointId: newId() };
  writeTx(handle.db, (tx) => {
    tx.insert(annotation)
      .values({
        id: ids.annotationId,
        targetKind: "node",
        targetId: nodeId,
        modelRevisionId: revisionId,
        modelNodeId: nodeId,
        kind: "note",
        title: "Filter behind the panel",
        ...quad,
      })
      .run();
    tx.insert(infraEndpoint)
      .values({
        id: ids.endpointId,
        name: "Closet shutoff",
        kind: "shutoff",
        modelRevisionId: revisionId,
        modelNodeId: nodeId,
        posX: 2,
        posY: 1,
        posZ: 3,
        ...quad,
      })
      .run();
  });
  return ids;
}

function revisionStatus(id: string): string | undefined {
  return handle.db.select().from(modelRevision).where(eq(modelRevision.id, id)).get()?.status;
}

function currentPointer(): string | null {
  return (
    handle.db
      .select({ id: householdSetting.currentModelRevisionId })
      .from(householdSetting)
      .where(eq(householdSetting.id, "household"))
      .get()?.id ?? null
  );
}

function placement(id: string) {
  return handle.db.select().from(assetPlacement).where(eq(assetPlacement.id, id)).get();
}

function openItems(reconciliationId: string) {
  return handle.db
    .select()
    .from(modelReconciliationItem)
    .where(eq(modelReconciliationItem.reconciliationId, reconciliationId))
    .all();
}

function aliases() {
  return handle.db.select().from(modelNodeAlias).all();
}

beforeEach(() => {
  handle = testDb();
  actorUserId = seedUser(handle, { username: "lucas", name: "Lucas" }).id;
});

afterEach(() => {
  handle.close();
});

describe("registerRevision", () => {
  it("makes the first import current and points the household at it", () => {
    const result = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    expect(result.status).toBe("created");
    expect(result.itemCount).toBe(0);
    expect(revisionStatus(result.revisionId)).toBe("current");
    expect(currentPointer()).toBe(result.revisionId);
    expect(
      handle.db
        .select({ id: householdSetting.currentModelId })
        .from(householdSetting)
        .where(eq(householdSetting.id, "household"))
        .get()?.id,
    ).toBe(base.modelId);
  });

  it("is a no-op for an unchanged fingerprint", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const again = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    expect(again.status).toBe("unchanged");
    expect(again.revisionId).toBe(first.revisionId);
    expect(handle.db.select().from(modelRevision).all()).toHaveLength(1);
  });

  it("auto-carries a new package when every referenced id survives", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, STABLE_ROOM);

    // Same semantic ids, different build: the fingerprint is what makes it a new package.
    const second = registerRevision(handle, pkgOf(base, "test-fp-2"), actorUserId);
    expect(second.status).toBe("auto_carried");
    expect(second.itemCount).toBe(0);
    expect(handle.db.select().from(modelReconciliation).all()).toHaveLength(0);

    expect(revisionStatus(first.revisionId)).toBe("superseded");
    expect(revisionStatus(second.revisionId)).toBe("current");
    expect(currentPointer()).toBe(second.revisionId);

    expect(placement(seeded.placementId)?.modelRevisionId).toBe(second.revisionId);
    expect(placement(seeded.placementId)?.needsReconciliation).toBe(false);
    for (const [table, column, id] of [
      [surfaceColorOverride, surfaceColorOverride.id, seeded.colorId],
      [infraRoute, infraRoute.id, seeded.routeId],
      [infraEndpoint, infraEndpoint.id, seeded.endpointId],
      [annotation, annotation.id, seeded.annotationId],
      [location, location.id, seeded.roomLocationId],
    ] as const) {
      const row = handle.db.select().from(table).where(eq(column, id)).get();
      expect(row?.modelRevisionId).toBe(second.revisionId);
    }
  });

  it("opens a moved_beyond_tolerance item when a referenced room keeps its id but moves 3 m", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, STABLE_ROOM);

    const second = registerRevision(handle, pkgOf(movedStableRoomManifest(3), "test-fp-2"), actorUserId);
    expect(second.status).toBe("reconciliation_open");
    expect(second.reconciliationId).toBeDefined();
    const items = openItems(second.reconciliationId!);
    const moved = items.filter((item) => item.issue === "moved_beyond_tolerance");
    expect(moved.length).toBeGreaterThan(0);
    for (const item of moved) {
      expect(item.oldNodeId).toBe(STABLE_ROOM);
      expect(item.proposedAction).toBe("remap");
      expect(item.proposedNewNodeId).toBe(STABLE_ROOM);
      const cands = JSON.parse(item.candidatesJson ?? "[]") as Array<{ centroidDistanceM?: number }>;
      expect(cands[0]?.centroidDistanceM).toBeGreaterThan(2.9);
    }
    // The old revision stays current until the owner applies the plan.
    expect(revisionStatus(first.revisionId)).toBe("current");
    expect(revisionStatus(second.revisionId)).toBe("imported");
    expect(placement(seeded.placementId)?.needsReconciliation).toBe(true);
  });

  it("still auto-carries when a referenced room only shifts 0.2 m", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    seedRuntimeData(first.revisionId, STABLE_ROOM);
    const second = registerRevision(handle, pkgOf(movedStableRoomManifest(0.2), "test-fp-2"), actorUserId);
    expect(second.status).toBe("auto_carried");
    expect(revisionStatus(second.revisionId)).toBe("current");
  });

  it("opens a reconciliation with a scored candidate when a referenced room id is renamed", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, CLOSET);

    const second = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-2"), actorUserId);
    expect(second.status).toBe("reconciliation_open");
    expect(second.itemCount).toBe(1);
    expect(second.reconciliationId).toBeDefined();

    // Nothing moved: the new revision waits, the old one is still current.
    expect(revisionStatus(first.revisionId)).toBe("current");
    expect(revisionStatus(second.revisionId)).toBe("imported");
    expect(currentPointer()).toBe(first.revisionId);

    const items = openItems(second.reconciliationId!);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.entityKind).toBe("asset_placement");
    expect(item.entityId).toBe(seeded.placementId);
    expect(item.oldNodeId).toBe(CLOSET);
    expect(item.issue).toBe("node_missing");
    expect(item.decision).toBeNull();
    expect(item.proposedAction).toBe("remap");
    expect(item.proposedNewNodeId).toBe(CLOSET_RENAMED);

    const candidates = JSON.parse(item.candidatesJson ?? "[]") as Array<{ nodeId: string; score: number; kind: string }>;
    expect(candidates[0]?.nodeId).toBe(CLOSET_RENAMED);
    expect(candidates[0]?.score).toBeGreaterThanOrEqual(0.75);
    expect(candidates[0]?.kind).toBe("room");

    // The affected record is flagged, and still fully usable.
    expect(placement(seeded.placementId)?.needsReconciliation).toBe(true);
    expect(placement(seeded.placementId)?.modelRevisionId).toBe(first.revisionId);
    // Records pinned to ids the new package still has are not part of the plan.
    expect(
      handle.db.select().from(location).where(eq(location.id, seeded.roomLocationId)).get()?.needsReconciliation,
    ).toBe(false);
  });
});

describe("applyReconciliation", () => {
  function openPlan(shiftX = 0) {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, CLOSET);
    const second = registerRevision(handle, pkgOf(renamedManifest(shiftX), "test-fp-2"), actorUserId);
    const item = openItems(second.reconciliationId!)[0]!;
    return { first, second, seeded, item, reconciliationId: second.reconciliationId! };
  }

  it("refuses while any item is undecided, and says how many", () => {
    const { reconciliationId, first } = openPlan();
    let thrown: unknown;
    try {
      applyReconciliation(handle, { reconciliationId, actorUserId });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConflictError);
    const error = thrown as ConflictError;
    expect(error.code).toBe("undecided_items");
    expect(error.detail).toMatchObject({ count: 1, total: 1 });

    // Nothing was half-applied.
    expect(revisionStatus(first.revisionId)).toBe("current");
    expect(
      handle.db.select().from(modelReconciliation).where(eq(modelReconciliation.id, reconciliationId)).get()?.status,
    ).toBe("open");
  });

  it("remaps: re-points the record, re-stamps everything, writes an alias and clears the flag", () => {
    const { first, second, seeded, item, reconciliationId } = openPlan();

    const decided = decideReconciliationItem(handle, {
      itemId: item.id,
      decision: "remap",
      newNodeId: CLOSET_RENAMED,
      actorUserId,
      note: "the exporter renamed the closet",
    });
    expect(decided).toMatchObject({ decision: "remap", decidedNewNodeId: CLOSET_RENAMED, decided: 1, total: 1 });
    expect(reconciliationSummary(handle.db, reconciliationId)).toMatchObject({
      total: 1,
      decided: 1,
      undecided: 0,
      applicable: true,
      byDecision: { remap: 1, keep: 0, archive: 0 },
    });

    const result = applyReconciliation(handle, { reconciliationId, actorUserId });
    expect(result.applied).toEqual({ remap: 1, keep: 0, archive: 0 });
    expect(result.flaggedMoves).toEqual([]);

    const row = placement(seeded.placementId);
    expect(row?.modelNodeId).toBe(CLOSET_RENAMED);
    expect(row?.modelRevisionId).toBe(second.revisionId);
    expect(row?.needsReconciliation).toBe(false);
    // The geometry did not move, so neither did the position.
    expect(row?.posX).toBe(5.25);

    // Colours, routes, endpoints, annotations and locations are all carried by revision.
    for (const [table, column, id] of [
      [surfaceColorOverride, surfaceColorOverride.id, seeded.colorId],
      [infraRoute, infraRoute.id, seeded.routeId],
      [infraEndpoint, infraEndpoint.id, seeded.endpointId],
      [annotation, annotation.id, seeded.annotationId],
      [location, location.id, seeded.roomLocationId],
    ] as const) {
      expect(handle.db.select().from(table).where(eq(column, id)).get()?.modelRevisionId).toBe(second.revisionId);
    }
    // A secondary reference to the renamed id follows the decision too.
    expect(
      handle.db.select().from(surfaceColorOverride).where(eq(surfaceColorOverride.id, seeded.colorId)).get()?.roomId,
    ).toBe(CLOSET_RENAMED);

    expect(revisionStatus(first.revisionId)).toBe("superseded");
    expect(revisionStatus(second.revisionId)).toBe("current");
    expect(currentPointer()).toBe(second.revisionId);

    const plan = handle.db
      .select()
      .from(modelReconciliation)
      .where(eq(modelReconciliation.id, reconciliationId))
      .get();
    expect(plan?.status).toBe("applied");
    expect(plan?.appliedBy).toBe(actorUserId);
    expect(JSON.parse(plan?.summaryJson ?? "{}")).toMatchObject({ remap: 1, keep: 0, archive: 0 });

    const alias = aliases();
    expect(alias).toHaveLength(1);
    expect(alias[0]).toMatchObject({
      modelId: base.modelId,
      fromRevisionId: first.revisionId,
      toRevisionId: second.revisionId,
      oldNodeId: CLOSET,
      newNodeId: CLOSET_RENAMED,
      decidedBy: actorUserId,
    });

    const audits = handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, seeded.placementId))
      .all()
      .filter((entry) => entry.action === "model_reconciled");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityTable).toBe("asset_placement");
    expect(JSON.parse(audits[0]?.changesJson ?? "{}")).toMatchObject({
      decision: "remap",
      oldNodeId: CLOSET,
      newNodeId: CLOSET_RENAMED,
    });
  });

  it("re-projects a remapped position by the centroid delta and flags a move over 2 m", () => {
    const { seeded, item, reconciliationId } = openPlan(5);

    decideReconciliationItem(handle, { itemId: item.id, decision: "remap", newNodeId: CLOSET_RENAMED, actorUserId });
    const result = applyReconciliation(handle, { reconciliationId, actorUserId });

    expect(result.flaggedMoves).toHaveLength(1);
    expect(result.flaggedMoves[0]?.movedM).toBeCloseTo(5, 3);
    expect(placement(seeded.placementId)?.posX).toBeCloseTo(10.25, 3);
    expect(placement(seeded.placementId)?.posZ).toBeCloseTo(2, 3);

    const alerts = handle.db.select().from(appAlert).where(eq(appAlert.kind, "model_reconciliation")).all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("info");
    expect(alerts[0]?.entityId).toBe(seeded.placementId);

    const note = handle.db
      .select()
      .from(modelReconciliationItem)
      .where(eq(modelReconciliationItem.id, item.id))
      .get()?.note;
    expect(note).toContain("5.00 m");
  });

  it("keeps: leaves the node id, records a self-alias and keeps the flag", () => {
    const { first, second, seeded, item, reconciliationId } = openPlan();

    decideReconciliationItem(handle, { itemId: item.id, decision: "keep", actorUserId });
    const result = applyReconciliation(handle, { reconciliationId, actorUserId });
    expect(result.applied).toEqual({ remap: 0, keep: 1, archive: 0 });

    const row = placement(seeded.placementId);
    expect(row?.modelNodeId).toBe(CLOSET);
    expect(row?.modelRevisionId).toBe(second.revisionId);
    expect(row?.needsReconciliation).toBe(true);

    const alias = aliases();
    expect(alias).toHaveLength(1);
    expect(alias[0]).toMatchObject({
      oldNodeId: CLOSET,
      newNodeId: CLOSET,
      fromRevisionId: first.revisionId,
      toRevisionId: second.revisionId,
    });

    expect(revisionStatus(first.revisionId)).toBe("superseded");
    expect(revisionStatus(second.revisionId)).toBe("current");
  });

  it("archives a placement by removing the row and keeping its full JSON in the audit log", () => {
    const { seeded, item, reconciliationId } = openPlan();
    const before = placement(seeded.placementId);
    expect(before).toBeDefined();

    decideReconciliationItem(handle, { itemId: item.id, decision: "archive", actorUserId });
    const result = applyReconciliation(handle, { reconciliationId, actorUserId });
    expect(result.applied).toEqual({ remap: 0, keep: 0, archive: 1 });

    expect(placement(seeded.placementId)).toBeUndefined();
    // The equipment itself survives: maintenance history is not geometry.
    expect(handle.db.select().from(asset).all()).toHaveLength(1);

    const audits = handle.db.select().from(auditLog).where(eq(auditLog.entityId, seeded.placementId)).all();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("model_reconciled");
    const changes = JSON.parse(audits[0]?.changesJson ?? "{}") as {
      outcome: string;
      removedRow: Record<string, unknown> | null;
    };
    expect(changes.outcome).toBe("deleted");
    expect(changes.removedRow).toMatchObject({
      id: seeded.placementId,
      modelNodeId: CLOSET,
      posX: 5.25,
      assetId: before?.assetId,
    });

    // The removal is remembered as "this node is gone", so it is never re-asked.
    expect(aliases()[0]).toMatchObject({ oldNodeId: CLOSET, newNodeId: null });
  });

  it("refuses to archive a location, at decision time", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    writeTx(handle.db, (tx) => {
      const at = 1_700_000_000_000;
      const quad = { createdAtMs: at, createdBy: actorUserId, updatedAtMs: at, updatedBy: actorUserId };
      const propertyId = newId();
      tx.insert(location)
        .values([
          { id: propertyId, kind: "property", parentId: null, name: "Property", slug: "property", ...quad },
          {
            id: newId(),
            kind: "room",
            parentId: propertyId,
            name: "Closet",
            slug: "closet",
            modelRevisionId: first.revisionId,
            modelNodeId: CLOSET,
            ...quad,
          },
        ])
        .run();
    });
    const second = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-2"), actorUserId);
    const item = openItems(second.reconciliationId!)[0]!;
    expect(item.entityKind).toBe("location");

    expect(() =>
      decideReconciliationItem(handle, { itemId: item.id, decision: "archive", actorUserId }),
    ).toThrow(/never archived/);
  });

  it("rejects a remap onto an identifier the new package does not have", () => {
    const { item } = openPlan();
    expect(() =>
      decideReconciliationItem(handle, { itemId: item.id, decision: "remap", newNodeId: "r-nope", actorUserId }),
    ).toThrow(/no node called r-nope/);
  });

  it("cannot be applied twice", () => {
    const { item, reconciliationId } = openPlan();
    decideReconciliationItem(handle, { itemId: item.id, decision: "keep", actorUserId });
    applyReconciliation(handle, { reconciliationId, actorUserId });
    expect(() => applyReconciliation(handle, { reconciliationId, actorUserId })).toThrow(/already applied/);
  });
});

describe("abandonReconciliation", () => {
  it("leaves the new revision imported and the affected rows flagged", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, CLOSET);
    const second = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-2"), actorUserId);
    const reconciliationId = second.reconciliationId!;

    const result = abandonReconciliation(handle, { reconciliationId, actorUserId });
    expect(result).toMatchObject({ total: 1, decided: 0, toRevisionId: second.revisionId });

    expect(
      handle.db.select().from(modelReconciliation).where(eq(modelReconciliation.id, reconciliationId)).get()?.status,
    ).toBe("abandoned");
    expect(revisionStatus(first.revisionId)).toBe("current");
    expect(revisionStatus(second.revisionId)).toBe("imported");
    expect(currentPointer()).toBe(first.revisionId);
    // Documented on purpose: the flag still states a true fact, so abandoning does not clear it.
    expect(placement(seeded.placementId)?.needsReconciliation).toBe(true);
    expect(placement(seeded.placementId)?.modelRevisionId).toBe(first.revisionId);
    expect(aliases()).toHaveLength(0);

    expect(() => decideReconciliationItem(handle, {
      itemId: openItems(reconciliationId)[0]!.id,
      decision: "keep",
      actorUserId,
    })).toThrow(/already abandoned/);
  });
});

describe("remembered decisions", () => {
  it("auto-carries a later import instead of re-asking about a kept identifier", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, CLOSET);

    const second = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-2"), actorUserId);
    decideReconciliationItem(handle, {
      itemId: openItems(second.reconciliationId!)[0]!.id,
      decision: "keep",
      actorUserId,
    });
    applyReconciliation(handle, { reconciliationId: second.reconciliationId!, actorUserId });

    // A third export, still without the old id. The remembered `keep` answers it.
    const third = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-3"), actorUserId);
    expect(third.status).toBe("auto_carried");
    expect(third.itemCount).toBe(0);
    expect(third.aliasCarried).toBe(1);
    expect(handle.db.select().from(modelReconciliation).all()).toHaveLength(1);

    const row = placement(seeded.placementId);
    expect(row?.modelRevisionId).toBe(third.revisionId);
    expect(row?.modelNodeId).toBe(CLOSET);
    // Still unplaced, and still honest about it.
    expect(row?.needsReconciliation).toBe(true);
    expect(revisionStatus(third.revisionId)).toBe("current");
    expect(currentPointer()).toBe(third.revisionId);
  });

  it("follows a remembered rename without asking", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, CLOSET);
    // A decision made against an earlier pair of revisions, which is what the table is for.
    writeTx(handle.db, (tx) => {
      tx.insert(modelNodeAlias)
        .values({
          id: newId(),
          modelId: base.modelId,
          fromRevisionId: first.revisionId,
          toRevisionId: first.revisionId,
          oldNodeId: CLOSET,
          newNodeId: CLOSET_RENAMED,
          decidedBy: actorUserId,
          decidedAtMs: 1_700_000_000_000,
          note: "renamed by the exporter in an earlier round",
        })
        .run();
    });

    const second = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-2"), actorUserId);
    expect(second.status).toBe("auto_carried");
    expect(second.aliasCarried).toBe(1);
    expect(handle.db.select().from(modelReconciliation).all()).toHaveLength(0);

    const row = placement(seeded.placementId);
    expect(row?.modelNodeId).toBe(CLOSET_RENAMED);
    expect(row?.modelRevisionId).toBe(second.revisionId);
    expect(row?.needsReconciliation).toBe(false);
  });
});

describe("one plan, several kinds of row", () => {
  /** A plan whose items are an annotation and an endpoint: the two kinds archived by deletion. */
  function openPlanOfNodePinned() {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    // Pinned to ids the rename keeps, so the placement/colour/route rows are never asked about.
    const seeded = seedRuntimeData(first.revisionId, STABLE_ROOM);
    const extra = seedNodePinned(first.revisionId, CLOSET);
    const second = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-2"), actorUserId);
    return { first, second, seeded, extra, reconciliationId: second.reconciliationId! };
  }

  it("archives an annotation and an endpoint, each recoverable from the audit log", () => {
    const { extra, reconciliationId } = openPlanOfNodePinned();
    const items = openItems(reconciliationId);
    expect(items.map((item) => item.entityKind).sort()).toEqual(["annotation", "infra_endpoint"]);

    for (const item of items) decideReconciliationItem(handle, { itemId: item.id, decision: "archive", actorUserId });
    const result = applyReconciliation(handle, { reconciliationId, actorUserId });
    expect(result.applied).toEqual({ remap: 0, keep: 0, archive: 2 });

    expect(handle.db.select().from(annotation).where(eq(annotation.id, extra.annotationId)).get()).toBeUndefined();
    expect(handle.db.select().from(infraEndpoint).where(eq(infraEndpoint.id, extra.endpointId)).get()).toBeUndefined();

    const audits = handle.db
      .select()
      .from(auditLog)
      .all()
      .filter((entry) => entry.action === "model_reconciled");
    expect(audits).toHaveLength(2);
    const restorable = new Map(
      audits.map((entry) => [entry.entityId, JSON.parse(entry.changesJson ?? "{}") as { outcome: string; removedRow: Record<string, unknown> | null }]),
    );
    expect(restorable.get(extra.annotationId)?.outcome).toBe("deleted");
    expect(restorable.get(extra.annotationId)?.removedRow).toMatchObject({ title: "Filter behind the panel" });
    expect(restorable.get(extra.endpointId)?.outcome).toBe("deleted");
    expect(restorable.get(extra.endpointId)?.removedRow).toMatchObject({ name: "Closet shutoff", posX: 2 });
  });

  it("applies three different decisions in one transaction, one audit entry each", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, CLOSET);
    const extra = seedNodePinned(first.revisionId, CLOSET);
    const second = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-2"), actorUserId);
    const reconciliationId = second.reconciliationId!;

    const items = openItems(reconciliationId);
    expect(items).toHaveLength(3);
    const byKind = new Map(items.map((item) => [item.entityKind, item]));
    decideReconciliationItem(handle, {
      itemId: byKind.get("asset_placement")!.id,
      decision: "remap",
      newNodeId: CLOSET_RENAMED,
      actorUserId,
    });
    decideReconciliationItem(handle, { itemId: byKind.get("annotation")!.id, decision: "keep", actorUserId });
    decideReconciliationItem(handle, { itemId: byKind.get("infra_endpoint")!.id, decision: "archive", actorUserId });

    expect(reconciliationSummary(handle.db, reconciliationId)).toMatchObject({
      total: 3,
      decided: 3,
      undecided: 0,
      applicable: true,
      byDecision: { remap: 1, keep: 1, archive: 1 },
      byEntityKind: { annotation: 1, asset_placement: 1, infra_endpoint: 1 },
      byIssue: { node_missing: 3 },
    });

    const result = applyReconciliation(handle, { reconciliationId, actorUserId });
    expect(result.applied).toEqual({ remap: 1, keep: 1, archive: 1 });

    expect(placement(seeded.placementId)?.modelNodeId).toBe(CLOSET_RENAMED);
    expect(placement(seeded.placementId)?.needsReconciliation).toBe(false);
    const kept = handle.db.select().from(annotation).where(eq(annotation.id, extra.annotationId)).get();
    expect(kept?.modelNodeId).toBe(CLOSET);
    expect(kept?.modelRevisionId).toBe(second.revisionId);
    expect(kept?.needsReconciliation).toBe(true);
    expect(handle.db.select().from(infraEndpoint).where(eq(infraEndpoint.id, extra.endpointId)).get()).toBeUndefined();

    // One entry per item, so every row's fate is on the record separately.
    expect(handle.db.select().from(auditLog).all().filter((entry) => entry.action === "model_reconciled")).toHaveLength(3);

    // Documented consequence of `model_node_alias` being keyed by node id: three rows disagreed
    // about the same identifier, so the plan remembers the decision applied last (items are
    // applied in `entity_kind` order, and `archive` writes `NULL`). Each row's own outcome is in
    // the audit log, which is where the per-row truth lives.
    const alias = aliases();
    expect(alias).toHaveLength(1);
    expect(alias[0]).toMatchObject({ oldNodeId: CLOSET, newNodeId: null });

    const plan = handle.db.select().from(modelReconciliation).where(eq(modelReconciliation.id, reconciliationId)).get();
    expect(JSON.parse(plan?.summaryJson ?? "{}")).toMatchObject({ total: 3, remap: 1, keep: 1, archive: 1 });
  });
});

describe("archive, spelled out per entity kind", () => {
  /**
   * `infra_route` and `storage_place` carry no `model_revision_id`, so an import cannot discover
   * them (§ "the two tables carried by their parent") and their items are written here by hand.
   * The apply path is polymorphic and handles them, and what it does to each is the semantics the
   * module's doc comment had to invent because there is no `archived_at_ms` column anywhere.
   */
  it("marks a route removed and unpins a storage place instead of deleting either", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, CLOSET);
    const placeId = newId();
    writeTx(handle.db, (tx) => {
      const at = 1_700_000_200_000;
      tx.insert(storagePlace)
        .values({
          id: placeId,
          name: "Shelf by the hatch",
          locationId: seeded.roomLocationId,
          modelNodeId: CLOSET,
          createdAtMs: at,
          createdBy: actorUserId,
          updatedAtMs: at,
          updatedBy: actorUserId,
        })
        .run();
    });
    const second = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-2"), actorUserId);
    const reconciliationId = second.reconciliationId!;

    writeTx(handle.db, (tx) => {
      for (const [entityKind, entityId] of [
        ["infra_route", seeded.routeId],
        ["storage_place", placeId],
      ] as const) {
        tx.insert(modelReconciliationItem)
          .values({
            id: newId(),
            reconciliationId,
            entityKind,
            entityId,
            oldNodeId: CLOSET,
            issue: "node_missing",
            candidatesJson: null,
            proposedAction: "none",
            proposedNewNodeId: null,
          })
          .run();
      }
    });

    for (const item of openItems(reconciliationId)) {
      decideReconciliationItem(handle, { itemId: item.id, decision: "archive", actorUserId });
    }
    const result = applyReconciliation(handle, { reconciliationId, actorUserId });
    expect(result.applied).toEqual({ remap: 0, keep: 0, archive: 3 });

    // The run survives as history: a pipe that was cut out is the answer to "why is there a stub?"
    const route = handle.db.select().from(infraRoute).where(eq(infraRoute.id, seeded.routeId)).get();
    expect(route?.lifecycle).toBe("removed");
    expect(route?.removedOn).not.toBeNull();
    expect(route?.needsReconciliation).toBe(false);

    // A storage place is anchored by its location, so only the model pin is dropped.
    const place = handle.db.select().from(storagePlace).where(eq(storagePlace.id, placeId)).get();
    expect(place?.name).toBe("Shelf by the hatch");
    expect(place?.modelNodeId).toBeNull();
    expect(place?.needsReconciliation).toBe(false);

    const outcomes = handle.db
      .select()
      .from(auditLog)
      .all()
      .filter((entry) => entry.action === "model_reconciled")
      .map((entry) => [entry.entityTable, (JSON.parse(entry.changesJson ?? "{}") as { outcome: string }).outcome]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        ["asset_placement", "deleted"],
        ["infra_route", "lifecycle_removed"],
        ["storage_place", "unpinned"],
      ]),
    );
  });
});

describe("deciding", () => {
  function openPlan() {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    const seeded = seedRuntimeData(first.revisionId, CLOSET);
    const second = registerRevision(handle, pkgOf(renamedManifest(), "test-fp-2"), actorUserId);
    return { first, second, seeded, item: openItems(second.reconciliationId!)[0]!, reconciliationId: second.reconciliationId! };
  }

  it("accepts the item's own proposal when no identifier is passed", () => {
    const { item } = openPlan();
    const decided = decideReconciliationItem(handle, { itemId: item.id, decision: "remap", actorUserId });
    expect(decided.decidedNewNodeId).toBe(CLOSET_RENAMED);
  });

  it("is revisable until the plan is applied", () => {
    const { item, reconciliationId } = openPlan();
    decideReconciliationItem(handle, { itemId: item.id, decision: "remap", newNodeId: CLOSET_RENAMED, actorUserId });
    decideReconciliationItem(handle, { itemId: item.id, decision: "keep", actorUserId });
    const stored = openItems(reconciliationId)[0]!;
    expect(stored.decision).toBe("keep");
    // The abandoned target is cleared, so a later apply cannot act on a decision nobody made.
    expect(stored.decidedNewNodeId).toBeNull();
  });

  it("refuses a remap onto a surface another colour override already covers", () => {
    const first = registerRevision(handle, pkgOf(base, "test-fp-1"), actorUserId);
    seedRuntimeData(first.revisionId, STABLE_ROOM);
    // A second colour already on the id the new package introduces.
    writeTx(handle.db, (tx) => {
      const at = 1_700_000_300_000;
      tx.insert(surfaceColorOverride)
        .values({
          id: newId(),
          modelId: base.modelId,
          modelRevisionId: first.revisionId,
          surfaceId: RENAMED_SURFACE,
          colorHex: "#112233",
          createdAtMs: at,
          createdBy: actorUserId,
          updatedAtMs: at,
          updatedBy: actorUserId,
        })
        .run();
    });

    const second = registerRevision(handle, pkgOf(renamedSurfaceManifest(), "test-fp-2"), actorUserId);
    const items = openItems(second.reconciliationId!);
    expect(items).toHaveLength(1);
    expect(items[0]?.entityKind).toBe("surface_color_override");
    expect(items[0]?.oldNodeId).toBe(STABLE_SURFACE);

    let thrown: unknown;
    try {
      decideReconciliationItem(handle, {
        itemId: items[0]!.id,
        decision: "remap",
        newNodeId: RENAMED_SURFACE,
        actorUserId,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).code).toBe("remap_target_taken");
    expect(openItems(second.reconciliationId!)[0]?.decision).toBeNull();
  });

  it("flags a row written while the plan was open instead of carrying it silently", () => {
    const { first, second, item, reconciliationId } = openPlan();
    // Somebody places a second unit in the closet before anybody works through the plan: it is
    // stamped with the revision that is still current and points at an id the new package drops.
    const lateId = newId();
    writeTx(handle.db, (tx) => {
      const at = 1_700_000_400_000;
      const quad = { createdAtMs: at, createdBy: actorUserId, updatedAtMs: at, updatedBy: actorUserId };
      // Its own piece of equipment: one asset carries one body placement.
      const lateAssetId = newId();
      tx.insert(asset)
        .values({ id: lateAssetId, name: "Dehumidifier", category: "hvac", status: "installed", ...quad })
        .run();
      tx.insert(assetPlacement)
        .values({
          id: lateId,
          assetId: lateAssetId,
          modelRevisionId: first.revisionId,
          modelNodeId: CLOSET,
          posX: 1,
          posY: 1,
          posZ: 1,
          mountKind: "floor",
          createdAtMs: at,
          createdBy: actorUserId,
          updatedAtMs: at,
          updatedBy: actorUserId,
        })
        .run();
    });

    decideReconciliationItem(handle, { itemId: item.id, decision: "archive", actorUserId });
    applyReconciliation(handle, { reconciliationId, actorUserId });

    const late = placement(lateId);
    expect(late?.modelRevisionId).toBe(second.revisionId);
    // Nobody was asked about it, so it says so rather than claiming to be placed.
    expect(late?.needsReconciliation).toBe(true);
    expect(late?.modelNodeId).toBe(CLOSET);
  });
});
