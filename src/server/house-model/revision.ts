/**
 * Model revision registration and reconciliation.
 *
 * `installPackage` puts files on disk; this module records the package in the database so runtime
 * data (colours, placements, routes, annotations, locations) can be stamped with a revision and
 * detected as stale when the model changes. Rules (docs/decisions.md D-016, design note §8):
 *  - same fingerprint as the current revision → no-op;
 *  - first import → becomes current;
 *  - changed package: if every node id referenced by runtime data still exists (directly, or
 *    through a remembered `model_node_alias`) → auto-carry (records re-stamped, new revision
 *    current, old superseded); otherwise the new revision stays `imported`, an open
 *    `model_reconciliation` with items is created and affected records are flagged
 *    `needs_reconciliation`. Applying decisions is a separate, explicit step:
 *    `decideReconciliationItem` per row, then one `applyReconciliation`.
 *
 * Semantics this module had to decide, because the schema does not carry them:
 *  - **There is no `archived_at_ms` column** on any reconcilable table, so `archive` means the
 *    closest honest thing per entity kind: `infra_route` gets `lifecycle = 'removed'` (a real
 *    lifecycle that already exists); `storage_place` is unpinned from the model (`model_node_id`
 *    nulled — its `location_id` is the actual anchor); everything else has its row deleted, with
 *    the complete row recorded as JSON in `audit_log('model_reconciled')` so it is recoverable.
 *    A `location` is never archivable at all (design §8: locations anchor everything).
 *  - **Abandoning leaves the flags alone.** `needs_reconciliation = 1` says "this row points at an
 *    identifier the newest package does not have", which stays true after an abandon. The new
 *    revision stays `imported` and the household pointer is untouched, so nothing else changes.
 *  - **A remap follows secondary semantic-id references too** (`asset_placement.mount_surface_id`,
 *    `infra_route.offset_surface_id`, `surface_color_override.room_id`, `infra_route_point`'s
 *    `model_node_id`/`room_id`/`floor_id`, `storage_place.model_node_id`). Those columns hold the
 *    package's own ids and would otherwise be left dangling by a decision the human already made.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { type DbHandle, writeTx, type Db } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  annotation,
  appAlert,
  assetPlacement,
  auditLog,
  householdSetting,
  infraEndpoint,
  infraRoute,
  infraRoutePoint,
  location,
  modelNode,
  modelNodeAlias,
  modelReconciliation,
  modelReconciliationItem,
  modelRevision,
  storagePlace,
  surfaceColorOverride,
  type ModelNodeKind,
  type ModelReconciliationStatus,
  type ReconciliationDecision,
  type ReconciliationEntityKind,
} from "@/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { ringBBox, ringCentroid, ringSignedArea } from "@/house/model/geometry2d";
import { buildManifestIndex, type ManifestIndex } from "@/house/model/manifestIndex";
import type { CurrentPackage } from "./package";

export type RegisterStatus = "unchanged" | "created" | "auto_carried" | "reconciliation_open";

export interface RegisterResult {
  status: RegisterStatus;
  revisionId: string;
  reconciliationId?: string;
  itemCount: number;
  /** Refs resolved without asking, because an earlier decision is remembered in `model_node_alias`. */
  aliasCarried: number;
}

/** A position that moves further than this by a remap is worth a human's second look. */
export const MOVE_REVIEW_THRESHOLD_M = 2;
/** D-016: a record auto-carries only if its node keeps id AND kind AND centroid within this distance. */
export const AUTO_CARRY_TOLERANCE_M = 0.5;

function centroidDistance(a: Vec3 | undefined, b: Vec3 | undefined): number | null {
  if (!a || !b) return null;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

type Vec3 = [number, number, number];

interface NodeRow {
  nodeId: string;
  kind: ModelNodeKind;
  parentNodeId: string | null;
  name: string;
  centroid?: Vec3;
  bbox?: { min: Vec3; max: Vec3 };
  areaM2?: number;
}

/** Every semantic id of the package as rows of `model_node`. */
export function manifestNodes(index: ManifestIndex): NodeRow[] {
  const rows: NodeRow[] = [];
  for (const b of index.buildings.values()) rows.push({ nodeId: b.id, kind: "building", parentNodeId: null, name: b.name });
  for (const f of index.floors.values()) {
    const rooms = index.roomsByFloor.get(f.id) ?? [];
    let bbox: NodeRow["bbox"];
    for (const r of rooms) {
      const bb = ringBBox(r.footprint.outer);
      const top = r.floorElevation + (r.ceilingHeight ?? 2.5);
      const min: Vec3 = [bb.minX, r.floorElevation, bb.minZ];
      const max: Vec3 = [bb.maxX, top, bb.maxZ];
      bbox = bbox
        ? { min: [Math.min(bbox.min[0], min[0]), Math.min(bbox.min[1], min[1]), Math.min(bbox.min[2], min[2])], max: [Math.max(bbox.max[0], max[0]), Math.max(bbox.max[1], max[1]), Math.max(bbox.max[2], max[2])] }
        : { min, max };
    }
    rows.push({ nodeId: f.id, kind: "floor", parentNodeId: f.buildingId, name: f.name, bbox, centroid: bbox ? mid(bbox) : undefined });
  }
  for (const r of index.rooms.values()) {
    const bb = ringBBox(r.footprint.outer);
    const c = ringCentroid(r.footprint.outer);
    const top = r.floorElevation + (r.ceilingHeight ?? 2.5);
    rows.push({
      nodeId: r.id,
      kind: "room",
      parentNodeId: r.floorId,
      name: r.name,
      centroid: [c[0], (r.floorElevation + top) / 2, c[1]],
      bbox: { min: [bb.minX, r.floorElevation, bb.minZ], max: [bb.maxX, top, bb.maxZ] },
      areaM2: r.area ?? Math.abs(ringSignedArea(r.footprint.outer)),
    });
  }
  for (const e of index.elements.values()) {
    rows.push({ nodeId: e.id, kind: "element", parentNodeId: e.floorId ?? e.buildingId ?? null, name: e.id });
  }
  for (const s of index.surfaces.values()) {
    rows.push({ nodeId: s.id, kind: "surface", parentNodeId: s.elementId ?? s.roomId ?? null, name: s.id });
  }
  return rows;
}

function mid(b: NonNullable<NodeRow["bbox"]>): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

interface Ref {
  entityKind: ReconciliationEntityKind;
  entityId: string;
  nodeId: string;
}

/** Node ids referenced by runtime data stamped with `revisionId`. */
function referencedNodes(tx: Db, revisionId: string): Ref[] {
  const refs: Ref[] = [];
  for (const r of tx.select({ id: surfaceColorOverride.id, node: surfaceColorOverride.surfaceId }).from(surfaceColorOverride).where(eq(surfaceColorOverride.modelRevisionId, revisionId)).all())
    refs.push({ entityKind: "surface_color_override", entityId: r.id, nodeId: r.node });
  for (const r of tx.select({ id: assetPlacement.id, node: assetPlacement.modelNodeId }).from(assetPlacement).where(eq(assetPlacement.modelRevisionId, revisionId)).all())
    refs.push({ entityKind: "asset_placement", entityId: r.id, nodeId: r.node });
  for (const r of tx.select({ id: location.id, node: location.modelNodeId }).from(location).where(eq(location.modelRevisionId, revisionId)).all())
    if (r.node) refs.push({ entityKind: "location", entityId: r.id, nodeId: r.node });
  for (const r of tx.select({ id: infraEndpoint.id, node: infraEndpoint.modelNodeId }).from(infraEndpoint).where(eq(infraEndpoint.modelRevisionId, revisionId)).all())
    if (r.node) refs.push({ entityKind: "infra_endpoint", entityId: r.id, nodeId: r.node });
  for (const r of tx.select({ id: annotation.id, node: annotation.modelNodeId }).from(annotation).where(eq(annotation.modelRevisionId, revisionId)).all())
    if (r.node) refs.push({ entityKind: "annotation", entityId: r.id, nodeId: r.node });
  return refs;
}

/** Records with no node reference of their own (routes) are carried by revision only. */
function restampAll(tx: Db, fromRevisionId: string, toRevisionId: string): void {
  const stamp = { modelRevisionId: toRevisionId };
  tx.update(surfaceColorOverride).set(stamp).where(eq(surfaceColorOverride.modelRevisionId, fromRevisionId)).run();
  tx.update(assetPlacement).set(stamp).where(eq(assetPlacement.modelRevisionId, fromRevisionId)).run();
  tx.update(location).set(stamp).where(eq(location.modelRevisionId, fromRevisionId)).run();
  tx.update(infraRoute).set(stamp).where(eq(infraRoute.modelRevisionId, fromRevisionId)).run();
  tx.update(infraEndpoint).set(stamp).where(eq(infraEndpoint.modelRevisionId, fromRevisionId)).run();
  tx.update(annotation).set(stamp).where(eq(annotation.modelRevisionId, fromRevisionId)).run();
}

function setFlag(tx: Db, ref: Pick<Ref, "entityKind" | "entityId">, needsReconciliation: boolean): void {
  const flag = { needsReconciliation };
  switch (ref.entityKind) {
    case "surface_color_override": tx.update(surfaceColorOverride).set(flag).where(eq(surfaceColorOverride.id, ref.entityId)).run(); return;
    case "asset_placement": tx.update(assetPlacement).set(flag).where(eq(assetPlacement.id, ref.entityId)).run(); return;
    case "location": tx.update(location).set(flag).where(eq(location.id, ref.entityId)).run(); return;
    case "infra_endpoint": tx.update(infraEndpoint).set(flag).where(eq(infraEndpoint.id, ref.entityId)).run(); return;
    case "annotation": tx.update(annotation).set(flag).where(eq(annotation.id, ref.entityId)).run(); return;
    case "infra_route": tx.update(infraRoute).set(flag).where(eq(infraRoute.id, ref.entityId)).run(); return;
    case "infra_route_point": tx.update(infraRoutePoint).set(flag).where(eq(infraRoutePoint.id, ref.entityId)).run(); return;
    case "storage_place": tx.update(storagePlace).set(flag).where(eq(storagePlace.id, ref.entityId)).run(); return;
  }
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface Candidate {
  nodeId: string;
  name: string;
  kind: ModelNodeKind;
  score: number;
  reason: string;
  centroidDistanceM?: number;
}

function candidatesFor(
  nodeId: string,
  old: { kind?: ModelNodeKind; centroid?: Vec3 } | undefined,
  nodes: readonly NodeRow[],
): Candidate[] {
  const want = tokens(nodeId);
  return nodes
    .filter((n) => !old?.kind || n.kind === old.kind)
    .map((n) => {
      const have = tokens(n.nodeId + " " + n.name);
      let shared = 0;
      for (const t of want) if (have.has(t)) shared++;
      const score = want.size ? shared / want.size : 0;
      const distance = old?.centroid && n.centroid ? round3(dist3(old.centroid, n.centroid)) : undefined;
      return {
        nodeId: n.nodeId,
        name: n.name,
        kind: n.kind,
        score,
        reason: score >= 0.75 ? "id_similarity" : "same_kind",
        ...(distance === undefined ? {} : { centroidDistanceM: distance }),
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/* -------------------------------------------------------------------------------------------------
 * Remembered decisions (`model_node_alias`)
 *
 * An alias is a decision a human already made: "the id on the left means the id on the right".
 * Consulting it on every import is what stops the same question being asked at every re-export
 * (design §8.1 rule 4). Three shapes, all of them answers rather than questions:
 *   old → new (different)  the record follows the rename;
 *   old → old              a remembered `keep`: the row stays where it is, still flagged, and is
 *                          never re-asked;
 *   old → NULL             the node was intentionally removed; same treatment as `keep`.
 * ---------------------------------------------------------------------------------------------- */

/** modelId's remembered aliases, newest decision winning. */
function aliasMap(tx: Db, modelId: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const row of tx
    .select({ oldNodeId: modelNodeAlias.oldNodeId, newNodeId: modelNodeAlias.newNodeId })
    .from(modelNodeAlias)
    .where(eq(modelNodeAlias.modelId, modelId))
    .orderBy(asc(modelNodeAlias.decidedAtMs))
    .all()) {
    out.set(row.oldNodeId, row.newNodeId);
  }
  return out;
}

interface RefPlan {
  /** Resolved by a remembered rename: carry the record onto the alias target. */
  remap: Array<{ ref: Ref; newNodeId: string }>;
  /** Resolved by a remembered `keep`/removal: carry the revision, leave the row flagged. */
  hold: Ref[];
  /** Genuinely unanswered: these become reconciliation items. */
  missing: Ref[];
}

function planRefs(
  refs: readonly Ref[],
  known: ReadonlySet<string>,
  alias: ReadonlyMap<string, string | null>,
): RefPlan {
  const plan: RefPlan = { remap: [], hold: [], missing: [] };
  for (const ref of refs) {
    if (known.has(ref.nodeId)) continue;
    if (alias.has(ref.nodeId)) {
      const target = alias.get(ref.nodeId) ?? null;
      if (target !== null && target !== ref.nodeId) {
        // A remembered rename only helps while its target still exists; otherwise ask again.
        if (known.has(target)) {
          plan.remap.push({ ref, newNodeId: target });
          continue;
        }
      } else {
        plan.hold.push(ref);
        continue;
      }
    }
    plan.missing.push(ref);
  }
  return plan;
}

/* -------------------------------------------------------------------------------------------------
 * Registration
 * ---------------------------------------------------------------------------------------------- */

/** Register the installed package in the database. Idempotent for an unchanged fingerprint. */
export function registerRevision(handle: DbHandle, pkg: CurrentPackage, actorUserId: string | null): RegisterResult {
  const index = buildManifestIndex(pkg.manifest);
  const nodes = manifestNodes(index);
  const cs = pkg.manifest.coordinateSystem;
  const coordinateSystemJson = JSON.stringify({
    units: cs.units,
    upAxis: cs.upAxis,
    handedness: cs.handedness,
    originDescription: cs.originDescription,
    siteElevationOffset: (cs as { siteElevationOffset?: number }).siteElevationOffset ?? null,
    north: (cs as { north?: unknown }).north ?? null,
  });
  const generatedAtMs = Date.parse(pkg.manifest.generated ?? "") || nowMs();

  return writeTx(handle.db, (tx) => {
    const existing = tx.select().from(modelRevision).where(and(eq(modelRevision.modelId, pkg.modelId), eq(modelRevision.contentHash, pkg.fingerprint))).get();
    const current = tx.select().from(modelRevision).where(and(eq(modelRevision.modelId, pkg.modelId), eq(modelRevision.status, "current"))).get();
    if (existing) {
      if (existing.status === "current") return { status: "unchanged", revisionId: existing.id, itemCount: 0, aliasCarried: 0 };
      const open = tx.select().from(modelReconciliation).where(and(eq(modelReconciliation.toRevisionId, existing.id), eq(modelReconciliation.status, "open"))).get();
      return { status: "reconciliation_open", revisionId: existing.id, reconciliationId: open?.id, itemCount: 0, aliasCarried: 0 };
    }
    const now = nowMs();
    const revisionId = newId();
    tx.insert(modelRevision).values({
      id: revisionId,
      modelId: pkg.modelId,
      schemaVersion: pkg.manifest.schemaVersion,
      generatedAtMs,
      contentHash: pkg.fingerprint,
      coordinateSystemJson,
      nodeCount: nodes.length,
      importedAtMs: now,
      importedBy: actorUserId,
      status: current ? "imported" : "current",
    }).run();
    for (let i = 0; i < nodes.length; i += 400) {
      tx.insert(modelNode).values(
        nodes.slice(i, i + 400).map((n) => ({
          id: newId(),
          revisionId,
          nodeId: n.nodeId,
          kind: n.kind,
          parentNodeId: n.parentNodeId,
          name: n.name,
          centroidX: n.centroid?.[0] ?? null,
          centroidY: n.centroid?.[1] ?? null,
          centroidZ: n.centroid?.[2] ?? null,
          bboxMinX: n.bbox?.min[0] ?? null,
          bboxMinY: n.bbox?.min[1] ?? null,
          bboxMinZ: n.bbox?.min[2] ?? null,
          bboxMaxX: n.bbox?.max[0] ?? null,
          bboxMaxY: n.bbox?.max[1] ?? null,
          bboxMaxZ: n.bbox?.max[2] ?? null,
          areaM2: n.areaM2 ?? null,
        })),
      ).run();
    }
    if (!current) {
      tx.update(householdSetting).set({ currentModelId: pkg.modelId, currentModelRevisionId: revisionId, updatedAtMs: now }).where(eq(householdSetting.id, "household")).run();
      return { status: "created", revisionId, itemCount: 0, aliasCarried: 0 };
    }

    const known = new Set(nodes.map((n) => n.nodeId));
    const newNodes = nodeIndex(nodes);
    const oldNodes = revisionNodeIndex(tx, current.id);
    const refs = referencedNodes(tx, current.id);
    const plan = planRefs(refs, known, aliasMap(tx, pkg.modelId));

    // D-016: an id that survives but changes kind or moves > 0.5 m is a question, not a carry.
    const accounted = new Set<Ref>([...plan.missing, ...plan.hold, ...plan.remap.map((e) => e.ref)]);
    const changed: Array<{ ref: Ref; issue: "kind_changed" | "moved_beyond_tolerance"; distance: number | null }> = [];
    for (const ref of refs) {
      if (accounted.has(ref)) continue;
      const oldN = oldNodes.get(ref.nodeId);
      const newN = newNodes.get(ref.nodeId);
      if (!oldN || !newN) continue;
      if (oldN.kind !== newN.kind) {
        changed.push({ ref, issue: "kind_changed", distance: null });
        continue;
      }
      const d = centroidDistance(oldN.centroid, newN.centroid);
      if (d !== null && d > AUTO_CARRY_TOLERANCE_M) changed.push({ ref, issue: "moved_beyond_tolerance", distance: d });
    }

    if (plan.missing.length === 0 && changed.length === 0) {
      restampAll(tx, current.id, revisionId);
      for (const entry of plan.remap) {
        remapEntity(tx, {
          kind: entry.ref.entityKind,
          entityId: entry.ref.entityId,
          oldNodeId: entry.ref.nodeId,
          newNodeId: entry.newNodeId,
          revisionId,
          oldCentroid: oldNodes.get(entry.ref.nodeId)?.centroid,
          newCentroid: newNodes.get(entry.newNodeId)?.centroid,
          actorUserId,
          at: now,
        });
      }
      for (const ref of plan.hold) setFlag(tx, ref, true);
      tx.update(modelRevision).set({ status: "superseded" }).where(eq(modelRevision.id, current.id)).run();
      tx.update(modelRevision).set({ status: "current" }).where(eq(modelRevision.id, revisionId)).run();
      tx.update(householdSetting).set({ currentModelRevisionId: revisionId, updatedAtMs: now }).where(eq(householdSetting.id, "household")).run();
      return { status: "auto_carried", revisionId, itemCount: 0, aliasCarried: plan.remap.length + plan.hold.length };
    }

    const reconciliationId = newId();
    tx.insert(modelReconciliation).values({
      id: reconciliationId,
      fromRevisionId: current.id,
      toRevisionId: revisionId,
      status: "open",
      summaryJson: JSON.stringify({
        nodeMissing: plan.missing.length,
        kindChanged: changed.filter((c) => c.issue === "kind_changed").length,
        moved: changed.filter((c) => c.issue === "moved_beyond_tolerance").length,
        referenced: refs.length,
        aliasRemapped: plan.remap.length,
        aliasHeld: plan.hold.length,
      }),
      createdAtMs: now,
      createdBy: actorUserId,
    }).run();
    for (const ref of plan.missing) {
      const cands = candidatesFor(ref.nodeId, oldNodes.get(ref.nodeId), nodes);
      tx.insert(modelReconciliationItem).values({
        id: newId(),
        reconciliationId,
        entityKind: ref.entityKind,
        entityId: ref.entityId,
        oldNodeId: ref.nodeId,
        issue: "node_missing",
        candidatesJson: JSON.stringify(cands),
        proposedAction: cands[0] && cands[0].score >= 0.75 ? "remap" : "none",
        proposedNewNodeId: cands[0] && cands[0].score >= 0.75 ? cands[0].nodeId : null,
      }).onConflictDoNothing().run();
      setFlag(tx, ref, true);
    }
    for (const c of changed) {
      const newN = newNodes.get(c.ref.nodeId);
      const candidate = {
        nodeId: c.ref.nodeId,
        name: c.ref.nodeId,
        kind: newN?.kind ?? "element",
        score: 1,
        reason: c.issue === "kind_changed" ? "same_id_kind_changed" : "same_id_moved",
        ...(c.distance !== null ? { centroidDistanceM: Math.round(c.distance * 100) / 100 } : {}),
      };
      tx.insert(modelReconciliationItem).values({
        id: newId(),
        reconciliationId,
        entityKind: c.ref.entityKind,
        entityId: c.ref.entityId,
        oldNodeId: c.ref.nodeId,
        issue: c.issue,
        candidatesJson: JSON.stringify([candidate]),
        // A moved room keeps its id: remapping onto the same id re-projects the position by the
        // centroid delta. A changed kind is a modelling change the owner should look at first.
        proposedAction: c.issue === "moved_beyond_tolerance" ? "remap" : "keep",
        proposedNewNodeId: c.issue === "moved_beyond_tolerance" ? c.ref.nodeId : null,
      }).onConflictDoNothing().run();
      setFlag(tx, c.ref, true);
    }
    return {
      status: "reconciliation_open",
      revisionId,
      reconciliationId,
      itemCount: plan.missing.length + changed.length,
      aliasCarried: plan.remap.length + plan.hold.length,
    };
  });
}

interface IndexedNode {
  kind: ModelNodeKind;
  centroid?: Vec3;
}

function nodeIndex(nodes: readonly NodeRow[]): Map<string, IndexedNode> {
  const out = new Map<string, IndexedNode>();
  for (const n of nodes) out.set(n.nodeId, { kind: n.kind, ...(n.centroid ? { centroid: n.centroid } : {}) });
  return out;
}

function revisionNodeIndex(tx: Db, revisionId: string): Map<string, IndexedNode> {
  const out = new Map<string, IndexedNode>();
  for (const row of tx
    .select({
      nodeId: modelNode.nodeId,
      kind: modelNode.kind,
      x: modelNode.centroidX,
      y: modelNode.centroidY,
      z: modelNode.centroidZ,
    })
    .from(modelNode)
    .where(eq(modelNode.revisionId, revisionId))
    .all()) {
    const centroid: Vec3 | null =
      row.x === null || row.y === null || row.z === null ? null : [row.x, row.y, row.z];
    out.set(row.nodeId, { kind: row.kind, ...(centroid ? { centroid } : {}) });
  }
  return out;
}

/* -------------------------------------------------------------------------------------------------
 * Entity access
 *
 * Polymorphic by design (`model_reconciliation_item.entity_kind`), so these functions are the one
 * place that knows which column of which table carries a semantic node id, a position and a
 * revision stamp. Explicit switches rather than a table-of-tables abstraction: eight kinds, each
 * with its own quirks, and a missing case is then a compile error.
 * ---------------------------------------------------------------------------------------------- */

interface EntitySnapshot {
  /** The whole row, for the audit trail. */
  row: unknown;
  nodeId: string | null;
  pos: Vec3 | null;
  /** False for the two tables that are carried by their parent instead of stamped themselves. */
  revisionStamped: boolean;
}

function triple(x: number | null, y: number | null, z: number | null): Vec3 | null {
  return x === null || y === null || z === null ? null : [x, y, z];
}

function loadEntity(tx: Db, kind: ReconciliationEntityKind, id: string): EntitySnapshot | null {
  switch (kind) {
    case "surface_color_override": {
      const row = tx.select().from(surfaceColorOverride).where(eq(surfaceColorOverride.id, id)).get();
      return row ? { row, nodeId: row.surfaceId, pos: null, revisionStamped: true } : null;
    }
    case "asset_placement": {
      const row = tx.select().from(assetPlacement).where(eq(assetPlacement.id, id)).get();
      return row ? { row, nodeId: row.modelNodeId, pos: triple(row.posX, row.posY, row.posZ), revisionStamped: true } : null;
    }
    case "location": {
      const row = tx.select().from(location).where(eq(location.id, id)).get();
      return row ? { row, nodeId: row.modelNodeId, pos: null, revisionStamped: true } : null;
    }
    case "infra_endpoint": {
      const row = tx.select().from(infraEndpoint).where(eq(infraEndpoint.id, id)).get();
      return row ? { row, nodeId: row.modelNodeId, pos: triple(row.posX, row.posY, row.posZ), revisionStamped: true } : null;
    }
    case "annotation": {
      const row = tx.select().from(annotation).where(eq(annotation.id, id)).get();
      return row ? { row, nodeId: row.modelNodeId, pos: triple(row.posX, row.posY, row.posZ), revisionStamped: true } : null;
    }
    case "infra_route": {
      // A route has no node column of its own; its polyline points carry the place.
      const row = tx.select().from(infraRoute).where(eq(infraRoute.id, id)).get();
      return row ? { row, nodeId: null, pos: null, revisionStamped: true } : null;
    }
    case "infra_route_point": {
      const row = tx.select().from(infraRoutePoint).where(eq(infraRoutePoint.id, id)).get();
      return row ? { row, nodeId: row.modelNodeId, pos: [row.posX, row.posY, row.posZ], revisionStamped: false } : null;
    }
    case "storage_place": {
      const row = tx.select().from(storagePlace).where(eq(storagePlace.id, id)).get();
      return row ? { row, nodeId: row.modelNodeId, pos: null, revisionStamped: false } : null;
    }
  }
}

interface EntityPatch {
  nodeId?: string | null;
  revisionId?: string;
  needsReconciliation?: boolean;
  pos?: Vec3;
  actorUserId?: string | null;
  at?: number;
}

function updateEntity(tx: Db, kind: ReconciliationEntityKind, id: string, patch: EntityPatch): void {
  const audit = patch.at === undefined ? {} : { updatedAtMs: patch.at, updatedBy: patch.actorUserId ?? null };
  const flag = patch.needsReconciliation === undefined ? {} : { needsReconciliation: patch.needsReconciliation };
  const stamp = patch.revisionId === undefined ? {} : { modelRevisionId: patch.revisionId };
  const pos = patch.pos === undefined ? {} : { posX: patch.pos[0], posY: patch.pos[1], posZ: patch.pos[2] };
  const node = patch.nodeId === undefined ? undefined : patch.nodeId;
  switch (kind) {
    case "surface_color_override":
      tx.update(surfaceColorOverride)
        .set({ ...audit, ...flag, ...stamp, ...(node === undefined || node === null ? {} : { surfaceId: node }) })
        .where(eq(surfaceColorOverride.id, id))
        .run();
      return;
    case "asset_placement":
      tx.update(assetPlacement)
        .set({ ...audit, ...flag, ...stamp, ...pos, ...(node === undefined || node === null ? {} : { modelNodeId: node }) })
        .where(eq(assetPlacement.id, id))
        .run();
      return;
    case "location":
      tx.update(location)
        .set({ ...audit, ...flag, ...stamp, ...(node === undefined ? {} : { modelNodeId: node }) })
        .where(eq(location.id, id))
        .run();
      return;
    case "infra_endpoint":
      tx.update(infraEndpoint)
        .set({ ...audit, ...flag, ...stamp, ...pos, ...(node === undefined ? {} : { modelNodeId: node }) })
        .where(eq(infraEndpoint.id, id))
        .run();
      return;
    case "annotation":
      tx.update(annotation)
        .set({ ...audit, ...flag, ...stamp, ...pos, ...(node === undefined ? {} : { modelNodeId: node }) })
        .where(eq(annotation.id, id))
        .run();
      return;
    case "infra_route":
      tx.update(infraRoute).set({ ...audit, ...flag, ...stamp }).where(eq(infraRoute.id, id)).run();
      return;
    case "infra_route_point":
      tx.update(infraRoutePoint)
        .set({ ...flag, ...pos, ...(node === undefined ? {} : { modelNodeId: node }) })
        .where(eq(infraRoutePoint.id, id))
        .run();
      return;
    case "storage_place":
      tx.update(storagePlace)
        .set({ ...audit, ...flag, ...(node === undefined ? {} : { modelNodeId: node }) })
        .where(eq(storagePlace.id, id))
        .run();
      return;
  }
}

/**
 * `archive`, spelled out per entity kind because there is no `archived_at_ms` column anywhere.
 * Returns what actually happened, which is what the audit entry has to say.
 */
type ArchiveOutcome = "lifecycle_removed" | "unpinned" | "deleted";

function archiveEntity(
  tx: Db,
  kind: ReconciliationEntityKind,
  id: string,
  at: number,
  actorUserId: string | null,
): ArchiveOutcome {
  switch (kind) {
    case "location":
      // Locations anchor equipment, storage, endpoints and history (design §8.3).
      throw new ConflictError(
        "location_not_archivable",
        "a location is never archived by a reconciliation — it can only be remapped or kept",
        { entityId: id },
      );
    case "infra_route": {
      const row = tx.select().from(infraRoute).where(eq(infraRoute.id, id)).get();
      tx.update(infraRoute)
        .set({
          lifecycle: "removed",
          needsReconciliation: false,
          removedOn: row?.removedOn ?? new Date(at).toISOString().slice(0, 10),
          updatedAtMs: at,
          updatedBy: actorUserId,
        })
        .where(eq(infraRoute.id, id))
        .run();
      return "lifecycle_removed";
    }
    case "storage_place":
      // Its `location_id` is the real anchor; only the model pin is dropped.
      tx.update(storagePlace)
        .set({ modelNodeId: null, needsReconciliation: false, updatedAtMs: at, updatedBy: actorUserId })
        .where(eq(storagePlace.id, id))
        .run();
      return "unpinned";
    case "surface_color_override":
      tx.delete(surfaceColorOverride).where(eq(surfaceColorOverride.id, id)).run();
      return "deleted";
    case "asset_placement":
      tx.delete(assetPlacement).where(eq(assetPlacement.id, id)).run();
      return "deleted";
    case "infra_endpoint":
      tx.delete(infraEndpoint).where(eq(infraEndpoint.id, id)).run();
      return "deleted";
    case "annotation":
      tx.delete(annotation).where(eq(annotation.id, id)).run();
      return "deleted";
    case "infra_route_point":
      tx.delete(infraRoutePoint).where(eq(infraRoutePoint.id, id)).run();
      return "deleted";
  }
}

/**
 * The two tables with a unique index on the node id would fail a remap at the SQLite level; a
 * checked `ConflictError` names the row that is already there instead.
 */
function assertRemapAvailable(
  tx: Db,
  kind: ReconciliationEntityKind,
  entityId: string,
  newNodeId: string,
  toRevisionId: string,
): void {
  if (kind === "surface_color_override") {
    const mine = tx.select().from(surfaceColorOverride).where(eq(surfaceColorOverride.id, entityId)).get();
    if (!mine) return;
    const clash = tx
      .select({ id: surfaceColorOverride.id })
      .from(surfaceColorOverride)
      .where(and(eq(surfaceColorOverride.modelId, mine.modelId), eq(surfaceColorOverride.surfaceId, newNodeId)))
      .all()
      .find((row) => row.id !== entityId);
    if (clash) {
      throw new ConflictError(
        "remap_target_taken",
        `another colour override already covers ${newNodeId}; remove or recolour that one first`,
        { entityId, newNodeId, blockedBy: clash.id },
      );
    }
    return;
  }
  if (kind === "location") {
    const clash = tx
      .select({ id: location.id })
      .from(location)
      .where(and(eq(location.modelRevisionId, toRevisionId), eq(location.modelNodeId, newNodeId)))
      .all()
      .find((row) => row.id !== entityId);
    if (clash) {
      throw new ConflictError("remap_target_taken", `another location is already pinned to ${newNodeId}`, {
        entityId,
        newNodeId,
        blockedBy: clash.id,
      });
    }
  }
}

/** Secondary columns holding the package's own semantic ids, which a remap must follow. */
function rewriteSecondaryRefs(tx: Db, oldNodeId: string, newNodeId: string, at: number, actorUserId: string | null): void {
  tx.update(assetPlacement)
    .set({ mountSurfaceId: newNodeId, updatedAtMs: at, updatedBy: actorUserId })
    .where(eq(assetPlacement.mountSurfaceId, oldNodeId))
    .run();
  tx.update(infraRoute)
    .set({ offsetSurfaceId: newNodeId, updatedAtMs: at, updatedBy: actorUserId })
    .where(eq(infraRoute.offsetSurfaceId, oldNodeId))
    .run();
  tx.update(surfaceColorOverride)
    .set({ roomId: newNodeId, updatedAtMs: at, updatedBy: actorUserId })
    .where(eq(surfaceColorOverride.roomId, oldNodeId))
    .run();
  tx.update(infraRoutePoint).set({ modelNodeId: newNodeId }).where(eq(infraRoutePoint.modelNodeId, oldNodeId)).run();
  tx.update(infraRoutePoint).set({ roomId: newNodeId }).where(eq(infraRoutePoint.roomId, oldNodeId)).run();
  tx.update(infraRoutePoint).set({ floorId: newNodeId }).where(eq(infraRoutePoint.floorId, oldNodeId)).run();
  tx.update(storagePlace)
    .set({ modelNodeId: newNodeId, updatedAtMs: at, updatedBy: actorUserId })
    .where(eq(storagePlace.modelNodeId, oldNodeId))
    .run();
}

interface RemapInput {
  kind: ReconciliationEntityKind;
  entityId: string;
  oldNodeId: string;
  newNodeId: string;
  revisionId: string;
  oldCentroid?: Vec3 | undefined;
  newCentroid?: Vec3 | undefined;
  actorUserId: string | null;
  at: number;
}

/**
 * Re-stamp one record onto the new node and revision, re-projecting its position by the centroid
 * delta of old → new node when both centroids are known. Returns how far the position moved, or
 * `null` when there was nothing to move.
 */
function remapEntity(tx: Db, input: RemapInput): { movedM: number | null } {
  const snapshot = loadEntity(tx, input.kind, input.entityId);
  if (!snapshot) throw new NotFoundError(input.kind, input.entityId);
  assertRemapAvailable(tx, input.kind, input.entityId, input.newNodeId, input.revisionId);

  let movedM: number | null = null;
  let pos: Vec3 | undefined;
  if (snapshot.pos && input.oldCentroid && input.newCentroid) {
    const delta: Vec3 = [
      input.newCentroid[0] - input.oldCentroid[0],
      input.newCentroid[1] - input.oldCentroid[1],
      input.newCentroid[2] - input.oldCentroid[2],
    ];
    movedM = round3(Math.hypot(delta[0], delta[1], delta[2]));
    if (movedM > 0) {
      pos = [
        round3(snapshot.pos[0] + delta[0]),
        round3(snapshot.pos[1] + delta[1]),
        round3(snapshot.pos[2] + delta[2]),
      ];
    }
  }

  updateEntity(tx, input.kind, input.entityId, {
    nodeId: input.newNodeId,
    ...(snapshot.revisionStamped ? { revisionId: input.revisionId } : {}),
    needsReconciliation: false,
    ...(pos ? { pos } : {}),
    actorUserId: input.actorUserId,
    at: input.at,
  });
  rewriteSecondaryRefs(tx, input.oldNodeId, input.newNodeId, input.at, input.actorUserId);
  return { movedM };
}

interface AliasInput {
  modelId: string;
  fromRevisionId: string;
  toRevisionId: string;
  oldNodeId: string;
  newNodeId: string | null;
  actorUserId: string | null;
  at: number;
  note: string | null;
}

function writeAlias(tx: Db, input: AliasInput): void {
  tx.insert(modelNodeAlias)
    .values({
      id: newId(),
      modelId: input.modelId,
      fromRevisionId: input.fromRevisionId,
      toRevisionId: input.toRevisionId,
      oldNodeId: input.oldNodeId,
      newNodeId: input.newNodeId,
      decidedBy: input.actorUserId,
      decidedAtMs: input.at,
      note: input.note,
    })
    .onConflictDoUpdate({
      target: [
        modelNodeAlias.modelId,
        modelNodeAlias.fromRevisionId,
        modelNodeAlias.toRevisionId,
        modelNodeAlias.oldNodeId,
      ],
      set: { newNodeId: input.newNodeId, decidedBy: input.actorUserId, decidedAtMs: input.at, note: input.note },
    })
    .run();
}

interface AuditInput {
  at: number;
  actorUserId: string | null;
  entityTable: string;
  entityId: string;
  action: string;
  summary: string;
  changes?: unknown;
}

function writeAudit(tx: Db, input: AuditInput): void {
  tx.insert(auditLog)
    .values({
      id: newId(),
      atMs: input.at,
      actorKind: input.actorUserId === null ? "system" : "user",
      actorUserId: input.actorUserId,
      entityTable: input.entityTable,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary,
      changesJson: input.changes === undefined ? null : JSON.stringify(input.changes),
    })
    .run();
}

/** The reconciliation entity kinds are named after their tables, one for one. */
function tableOf(kind: ReconciliationEntityKind): string {
  return kind;
}

function raiseMoveAlert(
  tx: Db,
  input: { kind: ReconciliationEntityKind; entityId: string; movedM: number; at: number },
): void {
  tx.insert(appAlert)
    .values({
      id: newId(),
      kind: "model_reconciliation",
      severity: "info",
      entityTable: tableOf(input.kind),
      entityId: input.entityId,
      title: `A reconciled position moved ${input.movedM.toFixed(2)} m`,
      body:
        `Re-projecting this ${input.kind.replace(/_/g, " ")} by the centroid difference between the old and ` +
        `the new model node moved it ${input.movedM.toFixed(2)} m, further than the ` +
        `${MOVE_REVIEW_THRESHOLD_M} m review threshold. Check it in the house view and correct it if the ` +
        "marker has landed in the wrong place.",
      dedupeKey: `model_reconciliation:moved:${input.kind}:${input.entityId}`,
      firstSeenAtMs: input.at,
      lastSeenAtMs: input.at,
      seenCount: 1,
    })
    .onConflictDoUpdate({
      target: appAlert.dedupeKey,
      targetWhere: sql`resolved_at_ms IS NULL`,
      set: { lastSeenAtMs: input.at, seenCount: sql`${appAlert.seenCount} + 1` },
    })
    .run();
}

/* -------------------------------------------------------------------------------------------------
 * Deciding
 * ---------------------------------------------------------------------------------------------- */

export interface DecideReconciliationInput {
  itemId: string;
  decision: ReconciliationDecision;
  /** Required for `remap`, unless the item already carries a proposal to accept. */
  newNodeId?: string | null;
  actorUserId: string | null;
  /** `undefined` keeps the existing note; `null` clears it. */
  note?: string | null;
}

export interface DecideReconciliationResult {
  itemId: string;
  reconciliationId: string;
  decision: ReconciliationDecision;
  decidedNewNodeId: string | null;
  decided: number;
  total: number;
}

/**
 * Record one human decision. Nothing reaches the runtime tables here — that is
 * `applyReconciliation`, in one transaction, once every item has an answer.
 */
export function decideReconciliationItem(
  handle: DbHandle,
  input: DecideReconciliationInput,
): DecideReconciliationResult {
  return writeTx(handle.db, (tx) => {
    const item = tx
      .select()
      .from(modelReconciliationItem)
      .where(eq(modelReconciliationItem.id, input.itemId))
      .get();
    if (!item) throw new NotFoundError("model_reconciliation_item", input.itemId);
    const plan = tx
      .select()
      .from(modelReconciliation)
      .where(eq(modelReconciliation.id, item.reconciliationId))
      .get();
    if (!plan) throw new NotFoundError("model_reconciliation", item.reconciliationId);
    if (plan.status !== "open") {
      throw new ConflictError(
        "reconciliation_not_open",
        `this reconciliation is already ${plan.status}, so its items can no longer be decided`,
        { status: plan.status },
      );
    }

    let decidedNewNodeId: string | null = null;
    if (input.decision === "remap") {
      const wanted = (input.newNodeId ?? item.proposedNewNodeId ?? "").trim();
      if (wanted === "") {
        throw new ValidationError("remap_needs_node", "a remap needs the identifier to point at");
      }
      const node = tx
        .select({ nodeId: modelNode.nodeId })
        .from(modelNode)
        .where(and(eq(modelNode.revisionId, plan.toRevisionId), eq(modelNode.nodeId, wanted)))
        .get();
      if (!node) {
        throw new ValidationError("unknown_node", `the new package has no node called ${wanted}`, {
          nodeId: wanted,
          revisionId: plan.toRevisionId,
        });
      }
      assertRemapAvailable(tx, item.entityKind, item.entityId, wanted, plan.toRevisionId);
      decidedNewNodeId = wanted;
    } else if (input.decision === "archive" && item.entityKind === "location") {
      throw new ConflictError(
        "location_not_archivable",
        "a location is never archived by a reconciliation — it can only be remapped or kept",
        { entityId: item.entityId },
      );
    }

    tx.update(modelReconciliationItem)
      .set({
        decision: input.decision,
        decidedNewNodeId,
        decidedBy: input.actorUserId,
        decidedAtMs: nowMs(),
        note: input.note === undefined ? item.note : input.note,
      })
      .where(eq(modelReconciliationItem.id, item.id))
      .run();

    const counts = itemCounts(tx, plan.id);
    return {
      itemId: item.id,
      reconciliationId: plan.id,
      decision: input.decision,
      decidedNewNodeId,
      decided: counts.decided,
      total: counts.total,
    };
  });
}

function itemCounts(tx: Db, reconciliationId: string): { total: number; decided: number } {
  const rows = tx
    .select({ decision: modelReconciliationItem.decision })
    .from(modelReconciliationItem)
    .where(eq(modelReconciliationItem.reconciliationId, reconciliationId))
    .all();
  return { total: rows.length, decided: rows.filter((r) => r.decision !== null).length };
}

/* -------------------------------------------------------------------------------------------------
 * Summary
 * ---------------------------------------------------------------------------------------------- */

export interface ReconciliationSummary {
  reconciliationId: string;
  status: ModelReconciliationStatus;
  fromRevisionId: string;
  toRevisionId: string;
  total: number;
  decided: number;
  undecided: number;
  byDecision: Record<ReconciliationDecision, number>;
  byEntityKind: Record<string, number>;
  byIssue: Record<string, number>;
  /** True when `applyReconciliation` would not throw `undecided_items`. */
  applicable: boolean;
}

/** Counts for one plan: what the Apply button needs, and what `summary_json` records on apply. */
export function reconciliationSummary(tx: Db, reconciliationId: string): ReconciliationSummary {
  const plan = tx
    .select()
    .from(modelReconciliation)
    .where(eq(modelReconciliation.id, reconciliationId))
    .get();
  if (!plan) throw new NotFoundError("model_reconciliation", reconciliationId);
  const items = tx
    .select()
    .from(modelReconciliationItem)
    .where(eq(modelReconciliationItem.reconciliationId, reconciliationId))
    .all();

  const byDecision: Record<ReconciliationDecision, number> = { remap: 0, keep: 0, archive: 0 };
  const byEntityKind: Record<string, number> = {};
  const byIssue: Record<string, number> = {};
  let decided = 0;
  for (const item of items) {
    if (item.decision !== null) {
      decided += 1;
      byDecision[item.decision] += 1;
    }
    byEntityKind[item.entityKind] = (byEntityKind[item.entityKind] ?? 0) + 1;
    byIssue[item.issue] = (byIssue[item.issue] ?? 0) + 1;
  }
  return {
    reconciliationId: plan.id,
    status: plan.status,
    fromRevisionId: plan.fromRevisionId,
    toRevisionId: plan.toRevisionId,
    total: items.length,
    decided,
    undecided: items.length - decided,
    byDecision,
    byEntityKind,
    byIssue,
    applicable: plan.status === "open" && items.length - decided === 0,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Applying
 * ---------------------------------------------------------------------------------------------- */

export interface ApplyReconciliationInput {
  reconciliationId: string;
  actorUserId: string | null;
}

export interface MovedRecord {
  entityKind: ReconciliationEntityKind;
  entityId: string;
  movedM: number;
}

export interface ApplyReconciliationResult {
  reconciliationId: string;
  fromRevisionId: string;
  toRevisionId: string;
  applied: Record<ReconciliationDecision, number>;
  /** Refs carried without an item because an earlier decision is remembered. */
  aliasCarried: number;
  /** Positions re-projected further than `MOVE_REVIEW_THRESHOLD_M`; each also raised an alert. */
  flaggedMoves: MovedRecord[];
}

/**
 * Apply every decision of one reconciliation, in a single `BEGIN IMMEDIATE` transaction:
 * re-stamp everything the old revision owned onto the new one, act on each item, move the current
 * pointer, and write one `audit_log('model_reconciled')` per item.
 *
 * Refuses with `ConflictError('undecided_items')` while any item is unanswered: a half-applied
 * reconciliation is exactly the silent rewrite D-016 exists to prevent.
 */
export function applyReconciliation(
  handle: DbHandle,
  input: ApplyReconciliationInput,
): ApplyReconciliationResult {
  return writeTx(handle.db, (tx) => {
    const plan = tx
      .select()
      .from(modelReconciliation)
      .where(eq(modelReconciliation.id, input.reconciliationId))
      .get();
    if (!plan) throw new NotFoundError("model_reconciliation", input.reconciliationId);
    if (plan.status !== "open") {
      throw new ConflictError("reconciliation_not_open", `this reconciliation is already ${plan.status}`, {
        status: plan.status,
      });
    }
    const items = tx
      .select()
      .from(modelReconciliationItem)
      .where(eq(modelReconciliationItem.reconciliationId, plan.id))
      .orderBy(asc(modelReconciliationItem.entityKind), asc(modelReconciliationItem.oldNodeId))
      .all();
    const undecided = items.filter((item) => item.decision === null);
    if (undecided.length > 0) {
      throw new ConflictError(
        "undecided_items",
        `${undecided.length} of ${items.length} item(s) still have no decision; every row needs one before this can be applied`,
        { count: undecided.length, total: items.length },
      );
    }

    const from = tx.select().from(modelRevision).where(eq(modelRevision.id, plan.fromRevisionId)).get();
    const to = tx.select().from(modelRevision).where(eq(modelRevision.id, plan.toRevisionId)).get();
    if (!from) throw new NotFoundError("model_revision", plan.fromRevisionId);
    if (!to) throw new NotFoundError("model_revision", plan.toRevisionId);

    const at = nowMs();
    const oldNodes = revisionNodeIndex(tx, from.id);
    const newNodes = revisionNodeIndex(tx, to.id);
    const known = new Set(newNodes.keys());

    // Refs with no item of their own, read before anything moves.
    const decidedKeys = new Set(items.map((item) => `${item.entityKind} ${item.entityId} ${item.oldNodeId}`));
    const otherRefs = referencedNodes(tx, from.id).filter(
      (ref) => !decidedKeys.has(`${ref.entityKind} ${ref.entityId} ${ref.nodeId}`),
    );
    const aliasPlan = planRefs(otherRefs, known, aliasMap(tx, to.modelId));

    // Everything the old revision owned now belongs to the new one — routes included. From here on
    // the items only adjust node ids, flags and positions.
    restampAll(tx, from.id, to.id);

    const applied: Record<ReconciliationDecision, number> = { remap: 0, keep: 0, archive: 0 };
    const flaggedMoves: MovedRecord[] = [];

    for (const item of items) {
      const decision = item.decision;
      if (decision === null) continue; // unreachable: guarded above
      applied[decision] += 1;
      const table = tableOf(item.entityKind);

      if (decision === "remap") {
        const newNodeId = item.decidedNewNodeId;
        if (newNodeId === null) {
          throw new ConflictError("remap_needs_node", "a remap decision lost its target identifier", {
            itemId: item.id,
          });
        }
        if (!known.has(newNodeId)) {
          throw new ConflictError(
            "unknown_node",
            `the decision points at ${newNodeId}, which the new package does not contain`,
            { itemId: item.id, nodeId: newNodeId },
          );
        }
        const { movedM } = remapEntity(tx, {
          kind: item.entityKind,
          entityId: item.entityId,
          oldNodeId: item.oldNodeId,
          newNodeId,
          revisionId: to.id,
          oldCentroid: oldNodes.get(item.oldNodeId)?.centroid,
          newCentroid: newNodes.get(newNodeId)?.centroid,
          actorUserId: input.actorUserId,
          at,
        });
        const flagged = movedM !== null && movedM > MOVE_REVIEW_THRESHOLD_M;
        let note = item.note;
        if (flagged && movedM !== null) {
          flaggedMoves.push({ entityKind: item.entityKind, entityId: item.entityId, movedM });
          raiseMoveAlert(tx, { kind: item.entityKind, entityId: item.entityId, movedM, at });
          const suffix = `re-projected position moved ${movedM.toFixed(2)} m — needs a look`;
          note = note === null ? suffix : `${note}; ${suffix}`;
          tx.update(modelReconciliationItem)
            .set({ note })
            .where(eq(modelReconciliationItem.id, item.id))
            .run();
        }
        writeAlias(tx, {
          modelId: to.modelId,
          fromRevisionId: from.id,
          toRevisionId: to.id,
          oldNodeId: item.oldNodeId,
          newNodeId,
          actorUserId: input.actorUserId,
          at,
          note,
        });
        writeAudit(tx, {
          at,
          actorUserId: input.actorUserId,
          entityTable: table,
          entityId: item.entityId,
          action: "model_reconciled",
          summary: `${item.entityKind} remapped from ${item.oldNodeId} to ${newNodeId}`,
          changes: {
            decision,
            oldNodeId: item.oldNodeId,
            newNodeId,
            fromRevisionId: from.id,
            toRevisionId: to.id,
            ...(movedM === null ? {} : { movedM, flagged }),
          },
        });
        continue;
      }

      if (decision === "keep") {
        // The row keeps its identifier and stays flagged: it is honestly unplaced, not wrong.
        updateEntity(tx, item.entityKind, item.entityId, {
          revisionId: to.id,
          needsReconciliation: true,
          actorUserId: input.actorUserId,
          at,
        });
        writeAlias(tx, {
          modelId: to.modelId,
          fromRevisionId: from.id,
          toRevisionId: to.id,
          oldNodeId: item.oldNodeId,
          newNodeId: item.oldNodeId,
          actorUserId: input.actorUserId,
          at,
          note: item.note,
        });
        writeAudit(tx, {
          at,
          actorUserId: input.actorUserId,
          entityTable: table,
          entityId: item.entityId,
          action: "model_reconciled",
          summary: `${item.entityKind} keeps ${item.oldNodeId}; it stays flagged as unplaced`,
          changes: {
            decision,
            oldNodeId: item.oldNodeId,
            newNodeId: item.oldNodeId,
            fromRevisionId: from.id,
            toRevisionId: to.id,
          },
        });
        continue;
      }

      // archive
      const snapshot = loadEntity(tx, item.entityKind, item.entityId);
      const outcome = archiveEntity(tx, item.entityKind, item.entityId, at, input.actorUserId);
      writeAlias(tx, {
        modelId: to.modelId,
        fromRevisionId: from.id,
        toRevisionId: to.id,
        oldNodeId: item.oldNodeId,
        newNodeId: null,
        actorUserId: input.actorUserId,
        at,
        note: item.note,
      });
      writeAudit(tx, {
        at,
        actorUserId: input.actorUserId,
        entityTable: table,
        entityId: item.entityId,
        action: "model_reconciled",
        summary:
          outcome === "deleted"
            ? `${item.entityKind} archived — the row is removed and its full JSON is in changes_json, so it can be restored`
            : outcome === "lifecycle_removed"
              ? `${item.entityKind} archived by setting lifecycle = 'removed'`
              : `${item.entityKind} archived by unpinning it from the model`,
        changes: {
          decision,
          outcome,
          oldNodeId: item.oldNodeId,
          fromRevisionId: from.id,
          toRevisionId: to.id,
          ...(outcome === "deleted" ? { removedRow: snapshot?.row ?? null } : {}),
        },
      });
    }

    // Refs nobody was asked about, because an earlier decision already answered them.
    for (const entry of aliasPlan.remap) {
      remapEntity(tx, {
        kind: entry.ref.entityKind,
        entityId: entry.ref.entityId,
        oldNodeId: entry.ref.nodeId,
        newNodeId: entry.newNodeId,
        revisionId: to.id,
        oldCentroid: oldNodes.get(entry.ref.nodeId)?.centroid,
        newCentroid: newNodes.get(entry.newNodeId)?.centroid,
        actorUserId: input.actorUserId,
        at,
      });
    }
    for (const ref of aliasPlan.hold) setFlag(tx, ref, true);
    // A row written while the plan sat open (somebody placed equipment in a room this package
    // removes) has no item and no remembered answer. `restampAll` above just moved it onto the new
    // revision; leaving `needs_reconciliation = 0` there would claim it is placed when its id is
    // gone. Flag it instead — the next import asks about it.
    for (const ref of aliasPlan.missing) setFlag(tx, ref, true);

    const summary = {
      total: items.length,
      remap: applied.remap,
      keep: applied.keep,
      archive: applied.archive,
      aliasCarried: aliasPlan.remap.length + aliasPlan.hold.length,
      flaggedMoves: flaggedMoves.length,
      flaggedUnasked: aliasPlan.missing.length,
    };

    tx.update(modelRevision).set({ status: "superseded" }).where(eq(modelRevision.id, from.id)).run();
    tx.update(modelRevision).set({ status: "current" }).where(eq(modelRevision.id, to.id)).run();
    tx.update(householdSetting)
      .set({
        currentModelId: to.modelId,
        currentModelRevisionId: to.id,
        updatedAtMs: at,
        updatedBy: input.actorUserId,
      })
      .where(eq(householdSetting.id, "household"))
      .run();
    tx.update(modelReconciliation)
      .set({ status: "applied", appliedAtMs: at, appliedBy: input.actorUserId, summaryJson: JSON.stringify(summary) })
      .where(eq(modelReconciliation.id, plan.id))
      .run();
    writeAudit(tx, {
      at,
      actorUserId: input.actorUserId,
      entityTable: "model_reconciliation",
      entityId: plan.id,
      action: "applied",
      summary: `reconciliation applied: ${applied.remap} remapped, ${applied.keep} kept, ${applied.archive} archived`,
      changes: summary,
    });

    return {
      reconciliationId: plan.id,
      fromRevisionId: from.id,
      toRevisionId: to.id,
      applied,
      aliasCarried: summary.aliasCarried,
      flaggedMoves,
    };
  });
}

/* -------------------------------------------------------------------------------------------------
 * Abandoning
 * ---------------------------------------------------------------------------------------------- */

export interface AbandonReconciliationInput {
  reconciliationId: string;
  actorUserId: string | null;
}

export interface AbandonReconciliationResult {
  reconciliationId: string;
  toRevisionId: string;
  total: number;
  decided: number;
}

/**
 * Walk away from a reconciliation. The new revision stays `imported`, the household pointer is
 * untouched, and **the `needs_reconciliation` flags are deliberately left in place**: they say
 * "this row points at an identifier the newest package does not have", which is still true. The
 * decisions already recorded on the items stay too, as the record of what was being considered;
 * a later import starts a fresh plan.
 */
export function abandonReconciliation(
  handle: DbHandle,
  input: AbandonReconciliationInput,
): AbandonReconciliationResult {
  return writeTx(handle.db, (tx) => {
    const plan = tx
      .select()
      .from(modelReconciliation)
      .where(eq(modelReconciliation.id, input.reconciliationId))
      .get();
    if (!plan) throw new NotFoundError("model_reconciliation", input.reconciliationId);
    if (plan.status !== "open") {
      throw new ConflictError("reconciliation_not_open", `this reconciliation is already ${plan.status}`, {
        status: plan.status,
      });
    }
    const at = nowMs();
    const counts = itemCounts(tx, plan.id);
    tx.update(modelReconciliation)
      .set({
        status: "abandoned",
        summaryJson: JSON.stringify({ total: counts.total, decided: counts.decided, abandonedAtMs: at }),
      })
      .where(eq(modelReconciliation.id, plan.id))
      .run();
    writeAudit(tx, {
      at,
      actorUserId: input.actorUserId,
      entityTable: "model_reconciliation",
      entityId: plan.id,
      action: "abandoned",
      summary:
        `reconciliation abandoned with ${counts.decided} of ${counts.total} item(s) decided; ` +
        "the new revision stays imported and the affected rows stay flagged",
      changes: { total: counts.total, decided: counts.decided, toRevisionId: plan.toRevisionId },
    });
    return {
      reconciliationId: plan.id,
      toRevisionId: plan.toRevisionId,
      total: counts.total,
      decided: counts.decided,
    };
  });
}
