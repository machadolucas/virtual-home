/**
 * Model revision registration.
 *
 * `installPackage` puts files on disk; this module records the package in the database so runtime
 * data (colours, placements, routes, annotations, locations) can be stamped with a revision and
 * detected as stale when the model changes. Rules (docs/decisions.md D-016):
 *  - same fingerprint as the current revision → no-op;
 *  - first import → becomes current;
 *  - changed package: if every node id referenced by runtime data still exists → auto-carry
 *    (records re-stamped, new revision current, old superseded); otherwise the new revision stays
 *    `imported`, an open `model_reconciliation` with items is created and affected records are
 *    flagged `needs_reconciliation`. Applying decisions is a separate, explicit step.
 */
import { and, eq } from "drizzle-orm";
import { type DbHandle, writeTx, type Db } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  annotation,
  assetPlacement,
  householdSetting,
  infraEndpoint,
  infraRoute,
  location,
  modelNode,
  modelReconciliation,
  modelReconciliationItem,
  modelRevision,
  surfaceColorOverride,
  type ModelNodeKind,
  type ReconciliationEntityKind,
} from "@/db/schema";
import { ringBBox, ringCentroid, ringSignedArea } from "@/house/model/geometry2d";
import { buildManifestIndex, type ManifestIndex } from "@/house/model/manifestIndex";
import type { CurrentPackage } from "./package";

export type RegisterStatus = "unchanged" | "created" | "auto_carried" | "reconciliation_open";

export interface RegisterResult {
  status: RegisterStatus;
  revisionId: string;
  reconciliationId?: string;
  itemCount: number;
}

interface NodeRow {
  nodeId: string;
  kind: ModelNodeKind;
  parentNodeId: string | null;
  name: string;
  centroid?: [number, number, number];
  bbox?: { min: [number, number, number]; max: [number, number, number] };
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
      const min: [number, number, number] = [bb.minX, r.floorElevation, bb.minZ];
      const max: [number, number, number] = [bb.maxX, top, bb.maxZ];
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

function mid(b: NonNullable<NodeRow["bbox"]>): [number, number, number] {
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

function flagNeedsReconciliation(tx: Db, ref: Ref): void {
  const flag = { needsReconciliation: true };
  switch (ref.entityKind) {
    case "surface_color_override": tx.update(surfaceColorOverride).set(flag).where(eq(surfaceColorOverride.id, ref.entityId)).run(); break;
    case "asset_placement": tx.update(assetPlacement).set(flag).where(eq(assetPlacement.id, ref.entityId)).run(); break;
    case "location": tx.update(location).set(flag).where(eq(location.id, ref.entityId)).run(); break;
    case "infra_endpoint": tx.update(infraEndpoint).set(flag).where(eq(infraEndpoint.id, ref.entityId)).run(); break;
    case "annotation": tx.update(annotation).set(flag).where(eq(annotation.id, ref.entityId)).run(); break;
    default: break;
  }
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

function candidatesFor(nodeId: string, oldKind: ModelNodeKind | undefined, nodes: NodeRow[]) {
  const want = tokens(nodeId);
  return nodes
    .filter((n) => !oldKind || n.kind === oldKind)
    .map((n) => {
      const have = tokens(n.nodeId + " " + n.name);
      let shared = 0;
      for (const t of want) if (have.has(t)) shared++;
      const score = want.size ? shared / want.size : 0;
      return { nodeId: n.nodeId, name: n.name, kind: n.kind, score, reason: score >= 0.75 ? "id_similarity" : "same_kind" };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

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
      if (existing.status === "current") return { status: "unchanged", revisionId: existing.id, itemCount: 0 };
      const open = tx.select().from(modelReconciliation).where(and(eq(modelReconciliation.toRevisionId, existing.id), eq(modelReconciliation.status, "open"))).get();
      return { status: "reconciliation_open", revisionId: existing.id, reconciliationId: open?.id, itemCount: 0 };
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
      return { status: "created", revisionId, itemCount: 0 };
    }

    const known = new Set(nodes.map((n) => n.nodeId));
    const oldKinds = new Map(tx.select({ nodeId: modelNode.nodeId, kind: modelNode.kind }).from(modelNode).where(eq(modelNode.revisionId, current.id)).all().map((r) => [r.nodeId, r.kind]));
    const refs = referencedNodes(tx, current.id);
    const missing = refs.filter((r) => !known.has(r.nodeId));
    if (missing.length === 0) {
      restampAll(tx, current.id, revisionId);
      tx.update(modelRevision).set({ status: "superseded" }).where(eq(modelRevision.id, current.id)).run();
      tx.update(modelRevision).set({ status: "current" }).where(eq(modelRevision.id, revisionId)).run();
      tx.update(householdSetting).set({ currentModelRevisionId: revisionId, updatedAtMs: now }).where(eq(householdSetting.id, "household")).run();
      return { status: "auto_carried", revisionId, itemCount: 0 };
    }
    const reconciliationId = newId();
    tx.insert(modelReconciliation).values({
      id: reconciliationId,
      fromRevisionId: current.id,
      toRevisionId: revisionId,
      status: "open",
      summaryJson: JSON.stringify({ nodeMissing: missing.length, referenced: refs.length }),
      createdAtMs: now,
      createdBy: actorUserId,
    }).run();
    for (const ref of missing) {
      const cands = candidatesFor(ref.nodeId, oldKinds.get(ref.nodeId), nodes);
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
      flagNeedsReconciliation(tx, ref);
    }
    return { status: "reconciliation_open", revisionId, reconciliationId, itemCount: missing.length };
  });
}
