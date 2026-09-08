import "server-only";
import { asc, desc, eq } from "drizzle-orm";
import type { Db, DbHandle } from "@/db/client";
import {
  HOUSEHOLD_SETTING_ID,
  annotation,
  householdSetting,
  infraEndpoint,
  infraRoute,
  infraRoutePoint,
  modelRevision,
  project,
  projectLink,
} from "@/db/schema";

/**
 * The infrastructure export: routes with their points, endpoints, annotations and projects.
 *
 * Everything is wrapped in the envelope from
 * `docs/design-notes/domain-scheduling-inventory.md` §8.4, and the reason is the whole point of the
 * feature: a bare `pos_x = 3.412` is meaningless in ten years. The envelope carries the model id,
 * the revision, the content hash and the **coordinate system** — units, up axis, forward axis,
 * origin — so the numbers stay interpretable after the app, the package and the laptop are gone.
 *
 * Conventions from §8.4 that the CSV rows follow: instants as ISO-8601 UTC with a companion local
 * date column, coordinates as `pos_x`/`pos_y`/`pos_z` beside `model_node_id` and
 * `model_revision_id`, and `NULL` as an empty field — never the four letters "null".
 */

export const INFRA_DATASETS = [
  "infraRoutes",
  "infraRoutePoints",
  "infraEndpoints",
  "annotations",
  "projects",
  "projectLinks",
] as const;
export type InfraDataset = (typeof INFRA_DATASETS)[number];

export interface ExportEnvelope {
  exportedAt: string;
  app: { name: "virtual-home"; schemaVersion: number };
  household: { timezone: string; deliveryTime: string };
  /** `null` when no model package has been imported: the rest still exports. */
  model: {
    modelId: string;
    revisionId: string;
    schemaVersion: string;
    generatedAt: string;
    contentHash: string;
    coordinateSystem: unknown;
  } | null;
  datasets: Record<string, unknown[]>;
  rowCounts: Record<string, number>;
}

/** How many migrations this database has applied — the app's own schema version. */
export function appSchemaVersion(handle: DbHandle): number {
  const table = handle.sqlite
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?`)
    .get("__drizzle_migrations") as { n: number } | undefined;
  if (!table || table.n === 0) return 0;
  const row = handle.sqlite.prepare(`SELECT count(*) AS n FROM __drizzle_migrations`).get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

function modelContext(db: Db): ExportEnvelope["model"] {
  const row = db
    .select()
    .from(modelRevision)
    .where(eq(modelRevision.status, "current"))
    .orderBy(desc(modelRevision.importedAtMs))
    .get();
  if (!row) return null;
  let coordinateSystem: unknown = row.coordinateSystemJson;
  try {
    coordinateSystem = JSON.parse(row.coordinateSystemJson);
  } catch {
    // Keep the raw text rather than dropping the frame: unparseable is still evidence.
  }
  return {
    modelId: row.modelId,
    revisionId: row.id,
    schemaVersion: row.schemaVersion,
    generatedAt: new Date(row.generatedAtMs).toISOString(),
    contentHash: row.contentHash,
    coordinateSystem,
  };
}

export interface DatasetRows {
  infraRoutes: Array<Record<string, unknown>>;
  infraRoutePoints: Array<Record<string, unknown>>;
  infraEndpoints: Array<Record<string, unknown>>;
  annotations: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  projectLinks: Array<Record<string, unknown>>;
}

/** Flat rows, one shape per dataset, shared by the JSON and the CSV renderers. */
export function collectInfrastructure(db: Db): DatasetRows {
  const routes = db.select().from(infraRoute).orderBy(asc(infraRoute.name)).all();
  const points = db
    .select()
    .from(infraRoutePoint)
    .orderBy(asc(infraRoutePoint.routeId), asc(infraRoutePoint.seq))
    .all();
  const endpoints = db.select().from(infraEndpoint).orderBy(asc(infraEndpoint.name)).all();
  const annotations = db.select().from(annotation).orderBy(asc(annotation.title)).all();
  const projects = db.select().from(project).orderBy(asc(project.name)).all();
  const links = db.select().from(projectLink).all();

  return {
    infraRoutes: routes.map((r) => ({
      id: r.id,
      name: r.name,
      medium: r.medium,
      nominal_size: r.nominalSize,
      system_id: r.systemId,
      from_endpoint_id: r.fromEndpointId,
      to_endpoint_id: r.toEndpointId,
      certainty: r.certainty,
      is_estimated: r.isEstimated ? 1 : 0,
      lifecycle: r.lifecycle,
      installed_on: r.installedOn,
      removed_on: r.removedOn,
      depth_m: r.depthM,
      offset_surface_id: r.offsetSurfaceId,
      offset_m: r.offsetM,
      project_id: r.projectId,
      notes: r.notes,
      needs_reconciliation: r.needsReconciliation ? 1 : 0,
      model_revision_id: r.modelRevisionId,
      point_count: points.filter((p) => p.routeId === r.id).length,
      created_at: new Date(r.createdAtMs).toISOString(),
      updated_at: new Date(r.updatedAtMs).toISOString(),
    })),
    infraRoutePoints: points.map((p) => ({
      id: p.id,
      route_id: p.routeId,
      seq: p.seq,
      pos_x: p.posX,
      pos_y: p.posY,
      pos_z: p.posZ,
      model_node_id: p.modelNodeId,
      floor_id: p.floorId,
      room_id: p.roomId,
      point_kind: p.pointKind,
      asset_id: p.assetId,
      needs_reconciliation: p.needsReconciliation ? 1 : 0,
    })),
    infraEndpoints: endpoints.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      location_id: e.locationId,
      asset_id: e.assetId,
      model_revision_id: e.modelRevisionId,
      model_node_id: e.modelNodeId,
      pos_x: e.posX,
      pos_y: e.posY,
      pos_z: e.posZ,
      notes: e.notes,
      needs_reconciliation: e.needsReconciliation ? 1 : 0,
      created_at: new Date(e.createdAtMs).toISOString(),
      updated_at: new Date(e.updatedAtMs).toISOString(),
    })),
    annotations: annotations.map((a) => ({
      id: a.id,
      target_kind: a.targetKind,
      target_id: a.targetId,
      model_revision_id: a.modelRevisionId,
      model_node_id: a.modelNodeId,
      pos_x: a.posX,
      pos_y: a.posY,
      pos_z: a.posZ,
      kind: a.kind,
      title: a.title,
      body: a.body,
      measurement_value: a.measurementValue,
      measurement_unit: a.measurementUnit,
      needs_reconciliation: a.needsReconciliation ? 1 : 0,
      created_at: new Date(a.createdAtMs).toISOString(),
      updated_at: new Date(a.updatedAtMs).toISOString(),
    })),
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      status: p.status,
      started_on: p.startedOn,
      ended_on: p.endedOn,
      // Cents as stored, plus the euro value: the integer is the fact, the decimal is convenience.
      budget_cents: p.budgetCents,
      actual_cost_cents: p.actualCostCents,
      budget: p.budgetCents === null ? null : (p.budgetCents / 100).toFixed(2),
      actual_cost: p.actualCostCents === null ? null : (p.actualCostCents / 100).toFixed(2),
      currency: p.currency,
      summary: p.summary,
      notes: p.notes,
      created_at: new Date(p.createdAtMs).toISOString(),
      updated_at: new Date(p.updatedAtMs).toISOString(),
    })),
    projectLinks: links.map((l) => ({
      id: l.id,
      project_id: l.projectId,
      entity_kind: l.entityKind,
      entity_id: l.entityId,
      role: l.role,
    })),
  };
}

/** The JSON body: the envelope, with each route carrying its own points inline. */
export function infrastructureJson(handle: DbHandle, atMs: number): ExportEnvelope {
  const db = handle.db;
  const rows = collectInfrastructure(db);
  const household = db
    .select({ timezone: householdSetting.timezone, deliveryTime: householdSetting.deliveryTime })
    .from(householdSetting)
    .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
    .get();

  const pointsByRoute = new Map<string, Array<Record<string, unknown>>>();
  for (const point of rows.infraRoutePoints) {
    const routeId = String(point.route_id);
    const list = pointsByRoute.get(routeId);
    if (list) list.push(point);
    else pointsByRoute.set(routeId, [point]);
  }
  const linksByProject = new Map<string, Array<Record<string, unknown>>>();
  for (const link of rows.projectLinks) {
    const projectId = String(link.project_id);
    const list = linksByProject.get(projectId);
    if (list) list.push(link);
    else linksByProject.set(projectId, [link]);
  }

  return {
    exportedAt: new Date(atMs).toISOString(),
    app: { name: "virtual-home", schemaVersion: appSchemaVersion(handle) },
    household: {
      timezone: household?.timezone ?? "Europe/Helsinki",
      deliveryTime: household?.deliveryTime ?? "09:00",
    },
    model: modelContext(db),
    datasets: {
      infraRoutes: rows.infraRoutes.map((r) => ({
        ...r,
        points: pointsByRoute.get(String(r.id)) ?? [],
      })),
      infraEndpoints: rows.infraEndpoints,
      annotations: rows.annotations,
      projects: rows.projects.map((p) => ({
        ...p,
        links: linksByProject.get(String(p.id)) ?? [],
      })),
    },
    rowCounts: Object.fromEntries(
      INFRA_DATASETS.map((name) => [name, rows[name].length]),
    ) as Record<string, number>,
  };
}

/** RFC 4180. `null` and `undefined` become an empty field, never the string "null". */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return /["\n\r,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows to CSV, with the header taken from the union of the keys present. */
export function toCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  const header: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!header.includes(key)) header.push(key);
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(header.map((key) => csvCell(row[key])).join(","));
  // CRLF, because RFC 4180 says so and Excel on Windows still cares.
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * `_manifest.csv`: the dataset names, their row counts and the file each one downloads from.
 *
 * One HTTP response cannot be six files, so CSV mode serves one dataset per request and this
 * manifest is the index. A single zip is a follow-up, recorded in `docs/model-contract.md`.
 */
export function manifestCsv(handle: DbHandle, atMs: number): string {
  const rows = collectInfrastructure(handle.db);
  const model = modelContext(handle.db);
  return toCsv(
    INFRA_DATASETS.map((name) => ({
      dataset: name,
      row_count: rows[name].length,
      url: `/api/exports/infrastructure?format=csv&dataset=${name}`,
      exported_at: new Date(atMs).toISOString(),
      model_id: model?.modelId ?? null,
      model_revision_id: model?.revisionId ?? null,
    })),
  );
}

export function isInfraDataset(value: string | null): value is InfraDataset {
  return value !== null && (INFRA_DATASETS as readonly string[]).includes(value);
}

/** Included beside a CSV download so the frame travels with the numbers. */
export function contextJson(handle: DbHandle, atMs: number): string {
  const envelope = infrastructureJson(handle, atMs);
  return JSON.stringify(
    {
      exportedAt: envelope.exportedAt,
      app: envelope.app,
      household: envelope.household,
      model: envelope.model,
      rowCounts: envelope.rowCounts,
    },
    null,
    2,
  );
}
