import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { part } from "@/db/schema/inventory";
import {
  completion,
  completionMaterial,
  maintenanceOccurrence,
  maintenancePlan,
  planMaterial,
  serviceBooking,
  serviceProvider,
} from "@/db/schema/maintenance";
import { modelRevision } from "@/db/schema/model";
import { loadHousehold } from "@/domain/occurrence";
import { localDateOf } from "@/domain/time";

export const MAINTENANCE_DATASETS = [
  "plans",
  "occurrences",
  "completions",
  "bookings",
] as const;
export type MaintenanceDataset = (typeof MAINTENANCE_DATASETS)[number];

export function isMaintenanceDataset(value: string): value is MaintenanceDataset {
  return (MAINTENANCE_DATASETS as readonly string[]).includes(value);
}

/**
 * The envelope of §8.4. Every export carries the frame the numbers are expressed in — the
 * household time zone, and the model revision plus its coordinate system — so a file opened in
 * five years is still interpretable rather than a pile of unlabelled floats.
 */
export interface ExportContext {
  exportedAt: string;
  app: { name: "virtual-home"; schemaVersion: number };
  household: { timezone: string; deliveryTime: string };
  model: {
    modelId: string;
    revisionId: string | null;
    schemaVersion: string | null;
    generatedAt: string | null;
    contentHash: string | null;
    coordinateSystem: unknown;
  };
}

export function buildExportContext(db: Db, nowMs: number): ExportContext {
  const settings = loadHousehold(db);
  const revision =
    settings.currentModelRevisionId === null
      ? null
      : (db
          .select()
          .from(modelRevision)
          .where(eq(modelRevision.id, settings.currentModelRevisionId))
          .get() ?? null);

  return {
    exportedAt: new Date(nowMs).toISOString(),
    app: { name: "virtual-home", schemaVersion: schemaVersionOf(db) },
    household: { timezone: settings.timezone, deliveryTime: settings.deliveryTime },
    model: {
      modelId: settings.currentModelId,
      revisionId: revision?.id ?? null,
      schemaVersion: revision?.schemaVersion ?? null,
      generatedAt: revision === null ? null : new Date(revision.generatedAtMs).toISOString(),
      contentHash: revision?.contentHash ?? null,
      coordinateSystem: revision === null ? null : safeJson(revision.coordinateSystemJson),
    },
  };
}

/** How many migrations this database has recorded — the app's own schema version. */
function schemaVersionOf(db: Db): number {
  try {
    const row = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM __drizzle_migrations`);
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface ExportEnvelope {
  exportedAt: string;
  app: ExportContext["app"];
  household: ExportContext["household"];
  model: ExportContext["model"];
  datasets: Partial<Record<MaintenanceDataset, Record<string, unknown>[]>>;
  rowCounts: Partial<Record<MaintenanceDataset, number>>;
}

export function buildMaintenanceExport(
  db: Db,
  nowMs: number,
  datasets: readonly MaintenanceDataset[],
): ExportEnvelope {
  const context = buildExportContext(db, nowMs);
  const out: ExportEnvelope = {
    ...context,
    datasets: {},
    rowCounts: {},
  };
  for (const dataset of datasets) {
    const rows = buildDataset(db, dataset, context.household.timezone);
    out.datasets[dataset] = rows;
    out.rowCounts[dataset] = rows.length;
  }
  return out;
}

/**
 * One dataset as flat rows.
 *
 * Conventions from §8.4: instants as ISO-8601 UTC **plus** a companion `*_local_date`, quantities
 * as decimals (`qty_milli / 1000`) with a `unit` column beside them, and `NULL` as an empty value
 * rather than the string `"null"`.
 */
export function buildDataset(
  db: Db,
  dataset: MaintenanceDataset,
  tz: string,
): Record<string, unknown>[] {
  switch (dataset) {
    case "plans":
      return buildPlans(db);
    case "occurrences":
      return buildOccurrences(db, tz);
    case "completions":
      return buildCompletions(db, tz);
    case "bookings":
      return buildBookings(db, tz);
  }
}

function iso(atMs: number | null): string | null {
  return atMs === null ? null : new Date(atMs).toISOString();
}

function buildPlans(db: Db): Record<string, unknown>[] {
  const materials = db
    .select({
      planId: planMaterial.planId,
      partId: planMaterial.partId,
      qtyMilli: planMaterial.qtyMilli,
      isRequired: planMaterial.isRequired,
      partName: part.name,
      unit: part.unit,
    })
    .from(planMaterial)
    .innerJoin(part, eq(planMaterial.partId, part.id))
    .all();

  return db
    .select()
    .from(maintenancePlan)
    .orderBy(asc(maintenancePlan.title))
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      asset_id: row.assetId,
      system_id: row.systemId,
      location_id: row.locationId,
      procedure_id: row.procedureId,
      pin_procedure_version_id: row.pinProcedureVersionId,
      schedule_kind: row.scheduleKind,
      recurrence: safeJson(row.recurrenceJson),
      schedule_anchor_local_date: row.scheduleAnchorDate,
      schedule_anchor_source: row.scheduleAnchorSource,
      schedule_anchor_note: row.scheduleAnchorNote,
      last_completion_id: row.lastCompletionId,
      assignment_mode: row.assignmentMode,
      assignee_user_id: row.assigneeUserId,
      priority: row.priority,
      estimated_minutes: row.estimatedMinutes,
      requires_professional: row.requiresProfessional ? 1 : 0,
      default_provider_id: row.defaultProviderId,
      status: row.status,
      cancelled_at: iso(row.cancelledAtMs),
      cancel_reason: row.cancelReason,
      created_at: iso(row.createdAtMs),
      materials: materials
        .filter((line) => line.planId === row.id)
        .map((line) => ({
          part_id: line.partId,
          part_name: line.partName,
          qty: line.qtyMilli / 1000,
          unit: line.unit,
          is_required: line.isRequired ? 1 : 0,
        })),
    }));
}

function buildOccurrences(db: Db, tz: string): Record<string, unknown>[] {
  return db
    .select()
    .from(maintenanceOccurrence)
    .orderBy(desc(maintenanceOccurrence.dueDate))
    .all()
    .map((row) => ({
      id: row.id,
      plan_id: row.planId,
      source: row.source,
      condition_rule_id: row.conditionRuleId,
      condition_episode_id: row.conditionEpisodeId,
      asset_id: row.assetId,
      system_id: row.systemId,
      location_id: row.locationId,
      title: row.title,
      procedure_version_id: row.procedureVersionId,
      status: row.status,
      due_local_date: row.dueDate,
      original_due_local_date: row.originalDueDate,
      window_start_local_date: row.windowStartDate,
      window_end_local_date: row.windowEndDate,
      generation_note: row.generationNoteJson === null ? null : safeJson(row.generationNoteJson),
      assignment_mode: row.assignmentMode,
      assignee_user_id: row.assigneeUserId,
      priority: row.priority,
      estimated_minutes: row.estimatedMinutes,
      blocked_reason: row.blockedReason,
      blocked_at: iso(row.blockedAtMs),
      service_booking_id: row.serviceBookingId,
      became_due_at: iso(row.becameDueAtMs),
      became_due_local_date: row.becameDueAtMs === null ? null : localDateOf(row.becameDueAtMs, tz),
      completion_id: row.completionId,
      closed_at: iso(row.closedAtMs),
      closed_local_date: row.closedAtMs === null ? null : localDateOf(row.closedAtMs, tz),
      close_reason: row.closeReason,
    }));
}

function buildCompletions(db: Db, tz: string): Record<string, unknown>[] {
  const materials = db
    .select({
      completionId: completionMaterial.completionId,
      partId: completionMaterial.partId,
      lotId: completionMaterial.lotId,
      expectedQtyMilli: completionMaterial.expectedQtyMilli,
      actualQtyMilli: completionMaterial.actualQtyMilli,
      shortfallMilli: completionMaterial.shortfallMilli,
      resolution: completionMaterial.resolution,
      notes: completionMaterial.notes,
      partName: part.name,
      unit: part.unit,
    })
    .from(completionMaterial)
    .innerJoin(part, eq(completionMaterial.partId, part.id))
    .all();

  return db
    .select()
    .from(completion)
    .orderBy(desc(completion.completedAtMs))
    .all()
    .map((row) => ({
      id: row.id,
      request_id: row.requestId,
      occurrence_id: row.occurrenceId,
      plan_id: row.planId,
      asset_id: row.assetId,
      procedure_version_id: row.procedureVersionId,
      completed_at: iso(row.completedAtMs),
      completed_local_date: row.completedLocalDate,
      completed_at_precision: row.completedAtPrecision,
      performed_by_user_id: row.performedByUserId,
      performed_by_provider_id: row.performedByProviderId,
      recorded_by: row.recordedBy,
      notes: row.notes,
      effort_minutes: row.effortMinutes,
      outcome: row.outcome,
      stock_resolution: row.stockResolution,
      is_replacement: row.isReplacement ? 1 : 0,
      voided_at: iso(row.voidedAtMs),
      voided_local_date: row.voidedAtMs === null ? null : localDateOf(row.voidedAtMs, tz),
      void_reason: row.voidReason,
      source: row.source,
      materials: materials
        .filter((line) => line.completionId === row.id)
        .map((line) => ({
          part_id: line.partId,
          part_name: line.partName,
          lot_id: line.lotId,
          expected_qty: line.expectedQtyMilli === null ? null : line.expectedQtyMilli / 1000,
          actual_qty: line.actualQtyMilli / 1000,
          shortfall_qty: line.shortfallMilli / 1000,
          unit: line.unit,
          resolution: line.resolution,
          notes: line.notes,
        })),
    }));
}

function buildBookings(db: Db, tz: string): Record<string, unknown>[] {
  return db
    .select({
      booking: serviceBooking,
      providerName: serviceProvider.name,
      providerTrade: serviceProvider.trade,
    })
    .from(serviceBooking)
    .innerJoin(serviceProvider, eq(serviceBooking.providerId, serviceProvider.id))
    .orderBy(desc(serviceBooking.requestedAtMs))
    .all()
    .map(({ booking, providerName, providerTrade }) => ({
      id: booking.id,
      occurrence_id: booking.occurrenceId,
      provider_id: booking.providerId,
      provider_name: providerName,
      provider_trade: providerTrade,
      status: booking.status,
      requested_at: iso(booking.requestedAtMs),
      requested_local_date: localDateOf(booking.requestedAtMs, tz),
      scheduled_start: iso(booking.scheduledStartMs),
      scheduled_end: iso(booking.scheduledEndMs),
      scheduled_local_date: booking.scheduledLocalDate,
      window_note: booking.windowNote,
      reference: booking.reference,
      quoted_price_cents: booking.quotedPriceCents,
      currency: booking.currency,
      contact_note: booking.contactNote,
    }));
}

/**
 * CSV for one dataset. Nested values (a completion's material lines, a recurrence rule) are
 * serialised as JSON in their cell rather than dropped, so the CSV is lossless.
 *
 * `NULL` is written as an empty field, never as `"null"` — a literal `null` string is impossible
 * to tell from a note that says "null".
 */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
