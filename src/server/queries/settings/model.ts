import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { loadEnv } from "@/env";
import {
  modelReconciliation,
  modelReconciliationItem,
  modelRevision,
  user,
  type ReconciliationDecision,
  type ReconciliationEntityKind,
  type ReconciliationIssue,
  type ReconciliationProposedAction,
} from "@/db/schema";
import { packageStatus, type PackageStatus } from "@/server/house-model/package";

export interface IncomingPackage {
  name: string;
  absPath: string;
  /** True when the directory at least contains a `model.json`. */
  looksLikePackage: boolean;
  fileCount: number;
  bytes: number;
}

/**
 * Directories sitting in `$VH_DATA_DIR/model-incoming`, which is where a new export is dropped.
 *
 * Deliberately shallow: one level of directories, each expected to be a package root. A nested
 * scan would invite somebody to drop a whole backup in there and wait for a timeout.
 */
export async function listIncomingPackages(): Promise<IncomingPackage[]> {
  const dir = loadEnv().modelIncomingDir;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // A missing directory is the normal state on a fresh install, not an error to surface.
    return [];
  }
  const out: IncomingPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const absPath = path.join(dir, entry.name);
    const manifest = await fs.stat(path.join(absPath, "model.json")).catch(() => null);
    let fileCount = 0;
    let bytes = 0;
    const files = await fs.readdir(absPath, { withFileTypes: true, recursive: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile()) continue;
      fileCount += 1;
      const stat = await fs
        .stat(path.join(file.parentPath ?? absPath, file.name))
        .catch(() => null);
      if (stat) bytes += stat.size;
    }
    out.push({
      name: entry.name,
      absPath,
      looksLikePackage: manifest?.isFile() === true,
      fileCount,
      bytes,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ReconciliationItemRow {
  id: string;
  entityKind: ReconciliationEntityKind;
  entityId: string;
  oldNodeId: string;
  issue: ReconciliationIssue;
  proposedAction: ReconciliationProposedAction;
  proposedNewNodeId: string | null;
  decision: ReconciliationDecision | null;
  decidedNewNodeId: string | null;
  decidedByName: string | null;
  decidedAtMs: number | null;
  note: string | null;
  candidates: ReconciliationCandidate[];
}

export interface ReconciliationCandidate {
  nodeId: string;
  name?: string;
  kind?: string;
  score?: number;
  reason?: string;
  centroidDistanceM?: number;
}

export interface ReconciliationRow {
  id: string;
  status: "open" | "applied" | "abandoned";
  fromRevisionId: string;
  toRevisionId: string;
  /** Short content hashes, so a plan reads without cross-referencing the revision list. */
  fromLabel: string;
  toLabel: string;
  createdAtMs: number;
  appliedAtMs: number | null;
  summary: Record<string, unknown> | null;
  items: ReconciliationItemRow[];
  total: number;
  decided: number;
  undecided: number;
  /** Whether `applyReconciliation` would run: still open, and every item answered. */
  applicable: boolean;
}

export interface ModelSettings {
  status: PackageStatus;
  revisions: (typeof modelRevision.$inferSelect)[];
  reconciliations: ReconciliationRow[];
  incoming: IncomingPackage[];
  incomingDir: string;
}

export async function readModelSettings(tx: Db): Promise<ModelSettings> {
  const [status, incoming] = await Promise.all([packageStatus(), listIncomingPackages()]);
  return {
    status,
    revisions: tx
      .select()
      .from(modelRevision)
      .orderBy(desc(modelRevision.importedAtMs))
      .limit(10)
      .all(),
    reconciliations: listReconciliations(tx),
    incoming,
    incomingDir: loadEnv().modelIncomingDir,
  };
}

/** How many settled plans the "Earlier reconciliations" list shows. Open ones are never capped out. */
const RECENT_PLAN_LIMIT = 5;
/** A safety bound on open plans. There is normally one; hundreds would mean something else is wrong. */
const OPEN_PLAN_LIMIT = 20;

/**
 * Reconciliation plans with their items and parsed candidate lists.
 *
 * Open plans are fetched in their own query and merged in. Taking the five most recently *created*
 * rows and filtering them for `open` afterwards meant that six imports after a plan was opened, the
 * panel said "No reconciliation is open" — a confident false negative about the one thing on the
 * page that is waiting for a person.
 */
export function listReconciliations(tx: Db): ReconciliationRow[] {
  const recent = tx
    .select()
    .from(modelReconciliation)
    .orderBy(desc(modelReconciliation.createdAtMs))
    .limit(RECENT_PLAN_LIMIT)
    .all();
  const openPlans = tx
    .select()
    .from(modelReconciliation)
    .where(eq(modelReconciliation.status, "open"))
    .orderBy(desc(modelReconciliation.createdAtMs))
    .limit(OPEN_PLAN_LIMIT)
    .all();

  const byId = new Map(recent.map((plan) => [plan.id, plan]));
  for (const plan of openPlans) byId.set(plan.id, plan);
  const plans = [...byId.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
  if (plans.length === 0) return [];

  const names = new Map(
    tx.select({ id: user.id, name: user.name }).from(user).all().map((row) => [row.id, row.name]),
  );
  const hashes = new Map(
    tx
      .select({ id: modelRevision.id, hash: modelRevision.contentHash })
      .from(modelRevision)
      .all()
      .map((row) => [row.id, row.hash.slice(0, 12)]),
  );

  return plans.map((plan) => {
    const items: ReconciliationItemRow[] = tx
      .select()
      .from(modelReconciliationItem)
      .where(eq(modelReconciliationItem.reconciliationId, plan.id))
      .orderBy(asc(modelReconciliationItem.entityKind), asc(modelReconciliationItem.oldNodeId))
      .all()
      .map((item) => ({
        id: item.id,
        entityKind: item.entityKind,
        entityId: item.entityId,
        oldNodeId: item.oldNodeId,
        issue: item.issue,
        proposedAction: item.proposedAction,
        proposedNewNodeId: item.proposedNewNodeId,
        decision: item.decision,
        decidedNewNodeId: item.decidedNewNodeId,
        decidedByName: item.decidedBy === null ? null : (names.get(item.decidedBy) ?? null),
        decidedAtMs: item.decidedAtMs,
        note: item.note,
        candidates: parseCandidates(item.candidatesJson),
      }));
    const decided = items.filter((item) => item.decision !== null).length;
    return {
      id: plan.id,
      status: plan.status,
      fromRevisionId: plan.fromRevisionId,
      toRevisionId: plan.toRevisionId,
      fromLabel: hashes.get(plan.fromRevisionId) ?? plan.fromRevisionId.slice(0, 8),
      toLabel: hashes.get(plan.toRevisionId) ?? plan.toRevisionId.slice(0, 8),
      createdAtMs: plan.createdAtMs,
      appliedAtMs: plan.appliedAtMs,
      summary: parseJsonObject(plan.summaryJson),
      items,
      total: items.length,
      decided,
      undecided: items.length - decided,
      applicable: plan.status === "open" && items.length - decided === 0,
    };
  });
}

function parseJsonObject(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseCandidates(json: string | null): ReconciliationCandidate[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const nodeId = record["nodeId"];
      if (typeof nodeId !== "string") return [];
      return [
        {
          nodeId,
          name: typeof record["name"] === "string" ? record["name"] : undefined,
          kind: typeof record["kind"] === "string" ? record["kind"] : undefined,
          score: typeof record["score"] === "number" ? record["score"] : undefined,
          reason: typeof record["reason"] === "string" ? record["reason"] : undefined,
          centroidDistanceM:
            typeof record["centroidDistanceM"] === "number"
              ? record["centroidDistanceM"]
              : undefined,
        },
      ];
    });
  } catch {
    return [];
  }
}
