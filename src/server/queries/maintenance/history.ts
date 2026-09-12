import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { attachment, attachmentLink } from "@/db/schema/attachments";
import { part } from "@/db/schema/inventory";
import {
  completion,
  completionMaterial,
  maintenanceOccurrence,
  serviceBooking,
  serviceProvider,
} from "@/db/schema/maintenance";
import { isValidLocalDate, type LocalDate } from "@/domain/time";
import {
  DEFAULT_HISTORY_TYPES,
  HISTORY_TYPES,
  type HistoryType,
} from "@/features/maintenance/historyTypes";
import { resolveTargets, targetOf, type TaskTarget } from "./targets";

// Declared in `src/features/maintenance/historyTypes.ts` so the filter control (a client
// component) can import the list without pulling this `server-only` module into the browser.
export {
  HISTORY_TYPES,
  DEFAULT_HISTORY_TYPES,
  HISTORY_TYPE_LABEL,
  type HistoryType,
} from "@/features/maintenance/historyTypes";

export interface HistoryFilters {
  /** Exact completion, including a voided record, when following a history link. */
  completionId?: string;
  /** Inclusive LocalDate bounds. */
  from: LocalDate | null;
  to: LocalDate | null;
  /** `asset:<id>` / `system:<id>` / `location:<id>`; `null` for everything. */
  target: string | null;
  types: HistoryType[];
}

/** Parse the URL's search params into filters. Unknown values are dropped, never guessed. */
export function parseHistoryFilters(params: URLSearchParams): HistoryFilters {
  const from = params.get("from");
  const to = params.get("to");
  const rawTypes = params.getAll("type").flatMap((value) => value.split(","));
  const types = rawTypes.filter((value): value is HistoryType =>
    (HISTORY_TYPES as readonly string[]).includes(value),
  );
  const target = params.get("target");
  const completionId = params.get("completion");
  if (completionId && completionId.length <= 64) return { from: null, to: null, target: null, types: ["completions", "voided"], completionId };
  return {
    from: from !== null && isValidLocalDate(from) ? from : null,
    to: to !== null && isValidLocalDate(to) ? to : null,
    target: target !== null && /^(asset|system|location):.+/.test(target) ? target : null,
    types: types.length > 0 ? [...new Set(types)] : DEFAULT_HISTORY_TYPES,
  };
}

export interface HistoryRow {
  id: string;
  type: HistoryType;
  /** LocalDate the row is filed under. */
  date: LocalDate;
  atMs: number;
  title: string;
  target: TaskTarget | null;
  /** Who did the work (a member id), or the provider's name for a professional. */
  actorUserId: string | null;
  actorProviderName: string | null;
  /** Who typed it in, when that is a different person from who did it. */
  recordedByUserId: string | null;
  notes: string | null;
  effortMinutes: number | null;
  outcome: string | null;
  materials: HistoryMaterial[];
  photoIds: string[];
  voidedAtMs: number | null;
  voidReason: string | null;
  isReplacement: boolean;
  /** For bookings: what state the booking is in. Booking is never completion. */
  bookingStatus: string | null;
  occurrenceId: string | null;
  reason: string | null;
}

export interface HistoryMaterial {
  partName: string;
  unit: "pcs" | "l" | "ml" | "m" | "kg" | "g";
  actualQtyMilli: number;
  expectedQtyMilli: number | null;
  shortfallMilli: number;
  resolution: string;
}

/**
 * The History table.
 *
 * Voided completions are a *separate* type rather than a hidden row: §5.4 says nothing is deleted,
 * and "completed 12 Jun, voided 14 Jun by Lucas (wrong task)" is the record the household wants.
 * Skips and cancellations are here for the same reason, and they never look like completions.
 */
export function loadHistory(db: Db, filters: HistoryFilters, limit = 300): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const wantCompletions = filters.types.includes("completions");
  const wantVoided = filters.types.includes("voided");

  if (wantCompletions || wantVoided) {
    const conditions: SQL[] = [];
    if (filters.completionId) conditions.push(eq(completion.id, filters.completionId));
    if (filters.from !== null) conditions.push(gte(completion.completedLocalDate, filters.from));
    if (filters.to !== null) conditions.push(lte(completion.completedLocalDate, filters.to));
    if (wantCompletions && !wantVoided) conditions.push(isNull(completion.voidedAtMs));
    if (wantVoided && !wantCompletions) conditions.push(isNotNull(completion.voidedAtMs));
    const targetFilter = completionTargetFilter(filters.target);
    if (targetFilter !== null) conditions.push(targetFilter);

    const completions = db
      .select({
        id: completion.id,
        occurrenceId: completion.occurrenceId,
        completedAtMs: completion.completedAtMs,
        completedLocalDate: completion.completedLocalDate,
        performedByUserId: completion.performedByUserId,
        performedByProviderId: completion.performedByProviderId,
        recordedBy: completion.recordedBy,
        notes: completion.notes,
        effortMinutes: completion.effortMinutes,
        outcome: completion.outcome,
        voidedAtMs: completion.voidedAtMs,
        voidReason: completion.voidReason,
        isReplacement: completion.isReplacement,
        assetId: completion.assetId,
        title: maintenanceOccurrence.title,
        systemId: maintenanceOccurrence.systemId,
        locationId: maintenanceOccurrence.locationId,
      })
      .from(completion)
      .innerJoin(maintenanceOccurrence, eq(completion.occurrenceId, maintenanceOccurrence.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(completion.completedAtMs))
      .limit(limit)
      .all();

    const targets = resolveTargets(db, completions);
    const materials = loadMaterials(db, completions.map((row) => row.id));
    const photos = loadPhotos(db, "completion", completions.map((row) => row.id));
    const providers = loadProviderNames(
      db,
      completions.map((row) => row.performedByProviderId).filter((id): id is string => id !== null),
    );

    for (const row of completions) {
      rows.push({
        id: row.id,
        type: row.voidedAtMs === null ? "completions" : "voided",
        date: row.completedLocalDate,
        atMs: row.completedAtMs,
        title: row.title,
        target: targetOf(targets, row),
        actorUserId: row.performedByUserId,
        actorProviderName:
          row.performedByProviderId === null
            ? null
            : (providers.get(row.performedByProviderId) ?? null),
        recordedByUserId: row.recordedBy,
        notes: row.notes,
        effortMinutes: row.effortMinutes,
        outcome: row.outcome,
        materials: materials.get(row.id) ?? [],
        photoIds: photos.get(row.id) ?? [],
        voidedAtMs: row.voidedAtMs,
        voidReason: row.voidReason,
        isReplacement: row.isReplacement,
        bookingStatus: null,
        occurrenceId: row.occurrenceId,
        reason: null,
      });
    }
  }

  const closedStatuses: ("skipped" | "cancelled")[] = [];
  if (filters.types.includes("skipped")) closedStatuses.push("skipped");
  if (filters.types.includes("cancelled")) closedStatuses.push("cancelled");
  if (closedStatuses.length > 0) {
    const conditions: SQL[] = [
      inArray(maintenanceOccurrence.status, closedStatuses),
      isNotNull(maintenanceOccurrence.closedAtMs),
    ];
    if (filters.from !== null) conditions.push(gte(maintenanceOccurrence.dueDate, filters.from));
    if (filters.to !== null) conditions.push(lte(maintenanceOccurrence.dueDate, filters.to));
    const targetFilter = occurrenceTargetFilter(filters.target);
    if (targetFilter !== null) conditions.push(targetFilter);

    const closed = db
      .select({
        id: maintenanceOccurrence.id,
        title: maintenanceOccurrence.title,
        status: maintenanceOccurrence.status,
        dueDate: maintenanceOccurrence.dueDate,
        closedAtMs: maintenanceOccurrence.closedAtMs,
        closeReason: maintenanceOccurrence.closeReason,
        updatedBy: maintenanceOccurrence.updatedBy,
        assetId: maintenanceOccurrence.assetId,
        systemId: maintenanceOccurrence.systemId,
        locationId: maintenanceOccurrence.locationId,
      })
      .from(maintenanceOccurrence)
      .where(and(...conditions))
      .orderBy(desc(maintenanceOccurrence.closedAtMs))
      .limit(limit)
      .all();

    const targets = resolveTargets(db, closed);
    for (const row of closed) {
      rows.push({
        id: row.id,
        type: row.status === "cancelled" ? "cancelled" : "skipped",
        date: row.dueDate,
        atMs: row.closedAtMs ?? 0,
        title: row.title,
        target: targetOf(targets, row),
        actorUserId: row.updatedBy,
        actorProviderName: null,
        recordedByUserId: null,
        notes: null,
        effortMinutes: null,
        outcome: null,
        materials: [],
        photoIds: [],
        voidedAtMs: null,
        voidReason: null,
        isReplacement: false,
        bookingStatus: null,
        occurrenceId: row.id,
        reason: row.closeReason,
      });
    }
  }

  if (filters.types.includes("bookings")) {
    const conditions: SQL[] = [];
    if (filters.from !== null) {
      conditions.push(gte(serviceBooking.scheduledLocalDate, filters.from));
    }
    if (filters.to !== null) conditions.push(lte(serviceBooking.scheduledLocalDate, filters.to));

    const bookings = db
      .select({
        id: serviceBooking.id,
        status: serviceBooking.status,
        scheduledLocalDate: serviceBooking.scheduledLocalDate,
        requestedAtMs: serviceBooking.requestedAtMs,
        windowNote: serviceBooking.windowNote,
        reference: serviceBooking.reference,
        contactNote: serviceBooking.contactNote,
        occurrenceId: serviceBooking.occurrenceId,
        providerName: serviceProvider.name,
        title: maintenanceOccurrence.title,
        assetId: maintenanceOccurrence.assetId,
        systemId: maintenanceOccurrence.systemId,
        locationId: maintenanceOccurrence.locationId,
      })
      .from(serviceBooking)
      .innerJoin(serviceProvider, eq(serviceBooking.providerId, serviceProvider.id))
      .leftJoin(maintenanceOccurrence, eq(serviceBooking.occurrenceId, maintenanceOccurrence.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(serviceBooking.requestedAtMs))
      .limit(limit)
      .all();

    const targets = resolveTargets(db, bookings);
    for (const row of bookings) {
      if (filters.target !== null) {
        const key = targetOf(targets, row);
        if (key === null || `${key.kind}:${key.id}` !== filters.target) continue;
      }
      rows.push({
        id: row.id,
        type: "bookings",
        date: row.scheduledLocalDate ?? "",
        atMs: row.requestedAtMs,
        title: row.title ?? `Booking with ${row.providerName}`,
        target: targetOf(targets, row),
        actorUserId: null,
        actorProviderName: row.providerName,
        recordedByUserId: null,
        notes: [row.windowNote, row.reference, row.contactNote]
          .filter((piece): piece is string => piece !== null && piece.length > 0)
          .join(" · ") || null,
        effortMinutes: null,
        outcome: null,
        materials: [],
        photoIds: [],
        voidedAtMs: null,
        voidReason: null,
        isReplacement: false,
        bookingStatus: row.status,
        occurrenceId: row.occurrenceId,
        reason: null,
      });
    }
  }

  rows.sort((a, b) => b.atMs - a.atMs);
  return rows.slice(0, limit);
}

function completionTargetFilter(target: string | null): SQL | null {
  if (target === null) return null;
  const [kind, ...rest] = target.split(":");
  const id = rest.join(":");
  if (kind === "asset") {
    return or(eq(completion.assetId, id), eq(maintenanceOccurrence.assetId, id)) ?? null;
  }
  if (kind === "system") return eq(maintenanceOccurrence.systemId, id);
  if (kind === "location") return eq(maintenanceOccurrence.locationId, id);
  return null;
}

function occurrenceTargetFilter(target: string | null): SQL | null {
  if (target === null) return null;
  const [kind, ...rest] = target.split(":");
  const id = rest.join(":");
  if (kind === "asset") return eq(maintenanceOccurrence.assetId, id);
  if (kind === "system") return eq(maintenanceOccurrence.systemId, id);
  if (kind === "location") return eq(maintenanceOccurrence.locationId, id);
  return null;
}

function loadMaterials(db: Db, completionIds: readonly string[]): Map<string, HistoryMaterial[]> {
  if (completionIds.length === 0) return new Map();
  const rows = db
    .select({
      completionId: completionMaterial.completionId,
      actualQtyMilli: completionMaterial.actualQtyMilli,
      expectedQtyMilli: completionMaterial.expectedQtyMilli,
      shortfallMilli: completionMaterial.shortfallMilli,
      resolution: completionMaterial.resolution,
      partName: part.name,
      unit: part.unit,
    })
    .from(completionMaterial)
    .innerJoin(part, eq(completionMaterial.partId, part.id))
    .where(inArray(completionMaterial.completionId, [...completionIds]))
    .orderBy(asc(part.name))
    .all();
  const out = new Map<string, HistoryMaterial[]>();
  for (const row of rows) {
    const list = out.get(row.completionId) ?? [];
    list.push({
      partName: row.partName,
      unit: row.unit,
      actualQtyMilli: row.actualQtyMilli,
      expectedQtyMilli: row.expectedQtyMilli,
      shortfallMilli: row.shortfallMilli,
      resolution: row.resolution,
    });
    out.set(row.completionId, list);
  }
  return out;
}

function loadPhotos(
  db: Db,
  entityKind: "completion" | "occurrence",
  entityIds: readonly string[],
): Map<string, string[]> {
  if (entityIds.length === 0) return new Map();
  const rows = db
    .select({ entityId: attachmentLink.entityId, attachmentId: attachmentLink.attachmentId })
    .from(attachmentLink)
    .innerJoin(attachment, eq(attachmentLink.attachmentId, attachment.id))
    .where(
      and(
        eq(attachmentLink.entityKind, entityKind),
        inArray(attachmentLink.entityId, [...entityIds]),
        eq(attachment.kind, "photo"),
      ),
    )
    .orderBy(asc(attachmentLink.seq), asc(attachmentLink.id))
    .all();
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.entityId) ?? [];
    list.push(row.attachmentId);
    out.set(row.entityId, list);
  }
  return out;
}

function loadProviderNames(db: Db, ids: readonly string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: serviceProvider.id, name: serviceProvider.name })
      .from(serviceProvider)
      .where(inArray(serviceProvider.id, [...ids]))
      .all()
      .map((row) => [row.id, row.name]),
  );
}

/** The distinct targets that appear in history, for the filter's target picker. */
export interface HistoryTargetOption {
  value: string;
  label: string;
  hint: string;
}

export function loadHistoryTargets(db: Db): HistoryTargetOption[] {
  const refs = db
    .select({
      assetId: maintenanceOccurrence.assetId,
      systemId: maintenanceOccurrence.systemId,
      locationId: maintenanceOccurrence.locationId,
    })
    .from(maintenanceOccurrence)
    .all();
  const targets = resolveTargets(db, refs);
  return [...targets.values()]
    .map((target) => ({
      value: `${target.kind}:${target.id}`,
      label: target.name,
      hint: target.context ?? target.kind,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
