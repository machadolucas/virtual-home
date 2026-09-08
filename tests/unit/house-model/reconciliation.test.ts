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
