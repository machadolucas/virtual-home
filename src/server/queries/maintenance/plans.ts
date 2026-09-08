import "server-only";
import { and, asc, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { part, type PartUnit } from "@/db/schema/inventory";
import {
  completion,
  maintenanceOccurrence,
  maintenancePlan,
  planMaterial,
  serviceProvider,
  type PlanStatus,
  type Priority,
  type ScheduleKind,
} from "@/db/schema/maintenance";
import { procedure, procedureVersion } from "@/db/schema/procedures";
import { availableMilli } from "@/domain/inventory";
import { describeRule, parseRecurrenceRule, type RecurrenceRule } from "@/domain/recurrence";
import type { LocalDate } from "@/domain/time";
import type { MaterialLine } from "@/features/maintenance/materials";
import { resolveTargets, targetOf, type TaskTarget } from "./targets";

export interface PlanListRow {
  id: string;
  title: string;
  status: PlanStatus;
  scheduleKind: ScheduleKind;
  ruleText: string;
  priority: Priority;
  assignmentMode: "user" | "shared";
  assigneeUserId: string | null;
  requiresProfessional: boolean;
  target: TaskTarget | null;
  procedureTitle: string | null;
  /** The plan's single open occurrence, if it has one (`ux_occ_open_per_plan` allows one). */
  openOccurrence: { id: string; dueDate: LocalDate; status: "pending" | "due" } | null;
  scheduleAnchorDate: LocalDate | null;
  scheduleAnchorSource: string;
  /** Set when the plan is waiting for someone to answer "when was this last done?" (§2.4). */
  needsSetup: boolean;
  lastCompletedOn: LocalDate | null;
}

export function loadPlans(db: Db, includeCancelled = false): PlanListRow[] {
  const rows = db
    .select({
      id: maintenancePlan.id,
      title: maintenancePlan.title,
      status: maintenancePlan.status,
      scheduleKind: maintenancePlan.scheduleKind,
      recurrenceJson: maintenancePlan.recurrenceJson,
      priority: maintenancePlan.priority,
      assignmentMode: maintenancePlan.assignmentMode,
      assigneeUserId: maintenancePlan.assigneeUserId,
      requiresProfessional: maintenancePlan.requiresProfessional,
      assetId: maintenancePlan.assetId,
      systemId: maintenancePlan.systemId,
      locationId: maintenancePlan.locationId,
      procedureId: maintenancePlan.procedureId,
      scheduleAnchorDate: maintenancePlan.scheduleAnchorDate,
      scheduleAnchorSource: maintenancePlan.scheduleAnchorSource,
      lastCompletionId: maintenancePlan.lastCompletionId,
    })
    .from(maintenancePlan)
    .where(
      includeCancelled ? undefined : inArray(maintenancePlan.status, ["active", "paused"]),
    )
    .orderBy(asc(maintenancePlan.title))
    .all();

  if (rows.length === 0) return [];
  const targets = resolveTargets(db, rows);

  const procedureIds = [
    ...new Set(rows.map((row) => row.procedureId).filter((id): id is string => id !== null)),
  ];
  const procedures =
    procedureIds.length === 0
      ? []
      : db
          .select({ id: procedure.id, title: procedure.title })
          .from(procedure)
          .where(inArray(procedure.id, procedureIds))
          .all();
  const procedureById = new Map(procedures.map((row) => [row.id, row.title]));

  const openRows = db
    .select({
      id: maintenanceOccurrence.id,
      planId: maintenanceOccurrence.planId,
      dueDate: maintenanceOccurrence.dueDate,
      status: maintenanceOccurrence.status,
    })
    .from(maintenanceOccurrence)
    .where(inArray(maintenanceOccurrence.status, ["pending", "due"]))
    .all();
  const openByPlan = new Map<string, { id: string; dueDate: LocalDate; status: "pending" | "due" }>();
  for (const row of openRows) {
    if (row.planId === null) continue;
    if (row.status !== "pending" && row.status !== "due") continue;
    openByPlan.set(row.planId, { id: row.id, dueDate: row.dueDate, status: row.status });
  }

  const completionIds = [
    ...new Set(rows.map((row) => row.lastCompletionId).filter((id): id is string => id !== null)),
  ];
  const completions =
    completionIds.length === 0
      ? []
      : db
          .select({ id: completion.id, completedLocalDate: completion.completedLocalDate })
          .from(completion)
          .where(inArray(completion.id, completionIds))
          .all();
  const completionById = new Map(completions.map((row) => [row.id, row.completedLocalDate]));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    scheduleKind: row.scheduleKind,
    ruleText: safeRuleText(row.recurrenceJson),
    priority: row.priority,
    assignmentMode: row.assignmentMode,
    assigneeUserId: row.assigneeUserId,
    requiresProfessional: row.requiresProfessional,
    target: targetOf(targets, row),
    procedureTitle: row.procedureId === null ? null : (procedureById.get(row.procedureId) ?? null),
    openOccurrence: openByPlan.get(row.id) ?? null,
    scheduleAnchorDate: row.scheduleAnchorDate,
    scheduleAnchorSource: row.scheduleAnchorSource,
    needsSetup: row.scheduleAnchorSource === "none" && row.scheduleAnchorDate === null,
    lastCompletedOn:
      row.lastCompletionId === null ? null : (completionById.get(row.lastCompletionId) ?? null),
  }));
}

export interface PlanDetail extends PlanListRow {
  description: string | null;
  estimatedMinutes: number | null;
  defaultProviderId: string | null;
  procedureId: string | null;
  pinProcedureVersionId: string | null;
  scheduleAnchorNote: string | null;
  cancelledAtMs: number | null;
  cancelReason: string | null;
  rule: RecurrenceRule | null;
  materials: MaterialLine[];
  /** Every occurrence of the plan, newest due date first — the plan's own history. */
  occurrences: PlanOccurrenceRow[];
  assetId: string | null;
  systemId: string | null;
  locationId: string | null;
}

export interface PlanOccurrenceRow {
  id: string;
  status: "pending" | "due" | "completed" | "skipped" | "cancelled";
  dueDate: LocalDate;
  originalDueDate: LocalDate;
  closedAtMs: number | null;
  closeReason: string | null;
  blockedReason: string | null;
  completionId: string | null;
}

export function loadPlanDetail(db: Db, planId: string): PlanDetail | null {
  const row = db.select().from(maintenancePlan).where(eq(maintenancePlan.id, planId)).get();
  if (!row) return null;
  const targets = resolveTargets(db, [row]);

  const procedureTitle =
    row.procedureId === null
      ? null
      : (db
          .select({ title: procedure.title })
          .from(procedure)
          .where(eq(procedure.id, row.procedureId))
          .get()?.title ?? null);

  const open = db
    .select({
      id: maintenanceOccurrence.id,
      dueDate: maintenanceOccurrence.dueDate,
      status: maintenanceOccurrence.status,
    })
    .from(maintenanceOccurrence)
    .where(
      and(
        eq(maintenanceOccurrence.planId, planId),
        inArray(maintenanceOccurrence.status, ["pending", "due"]),
      ),
    )
    .get();

  const occurrences = db
    .select({
      id: maintenanceOccurrence.id,
      status: maintenanceOccurrence.status,
      dueDate: maintenanceOccurrence.dueDate,
      originalDueDate: maintenanceOccurrence.originalDueDate,
      closedAtMs: maintenanceOccurrence.closedAtMs,
      closeReason: maintenanceOccurrence.closeReason,
      blockedReason: maintenanceOccurrence.blockedReason,
      completionId: maintenanceOccurrence.completionId,
    })
    .from(maintenanceOccurrence)
    .where(eq(maintenanceOccurrence.planId, planId))
    .orderBy(desc(maintenanceOccurrence.dueDate))
    .limit(50)
    .all();

  const lastCompletedOn =
    row.lastCompletionId === null
      ? null
      : (db
          .select({ date: completion.completedLocalDate })
          .from(completion)
          .where(eq(completion.id, row.lastCompletionId))
          .get()?.date ?? null);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    scheduleKind: row.scheduleKind,
    ruleText: safeRuleText(row.recurrenceJson),
    rule: safeRule(row.recurrenceJson),
    priority: row.priority,
    assignmentMode: row.assignmentMode,
    assigneeUserId: row.assigneeUserId,
    requiresProfessional: row.requiresProfessional,
    defaultProviderId: row.defaultProviderId,
    estimatedMinutes: row.estimatedMinutes,
    procedureId: row.procedureId,
    pinProcedureVersionId: row.pinProcedureVersionId,
    procedureTitle,
    target: targetOf(targets, row),
    assetId: row.assetId,
    systemId: row.systemId,
    locationId: row.locationId,
    openOccurrence:
      open && (open.status === "pending" || open.status === "due")
        ? { id: open.id, dueDate: open.dueDate, status: open.status }
        : null,
    scheduleAnchorDate: row.scheduleAnchorDate,
    scheduleAnchorSource: row.scheduleAnchorSource,
    scheduleAnchorNote: row.scheduleAnchorNote,
    needsSetup: row.scheduleAnchorSource === "none" && row.scheduleAnchorDate === null,
    cancelledAtMs: row.cancelledAtMs,
    cancelReason: row.cancelReason,
    lastCompletedOn,
    materials: loadPlanMaterialLines(db, planId),
    occurrences,
  };
}

function loadPlanMaterialLines(db: Db, planId: string): MaterialLine[] {
  return db
    .select({
      partId: planMaterial.partId,
      qtyMilli: planMaterial.qtyMilli,
      isRequired: planMaterial.isRequired,
      partName: part.name,
      spec: part.spec,
      unit: part.unit,
      trackingMode: part.trackingMode,
    })
    .from(planMaterial)
    .innerJoin(part, eq(planMaterial.partId, part.id))
    .where(eq(planMaterial.planId, planId))
    .orderBy(asc(part.name))
    .all()
    .map((row) => ({
      partId: row.partId,
      partName: row.partName,
      spec: row.spec,
      unit: row.unit,
      trackingMode: row.trackingMode,
      expectedQtyMilli: row.qtyMilli,
      isRequired: row.isRequired,
      source: "plan" as const,
      availableMilli: availableMilli(db, row.partId),
    }));
}

function safeRule(json: string): RecurrenceRule | null {
  try {
    return parseRecurrenceRule(json);
  } catch {
    return null;
  }
}

function safeRuleText(json: string): string {
  const rule = safeRule(json);
  return rule === null ? "Schedule could not be read" : describeRule(rule);
}

export interface ProcedureOption {
  value: string;
  label: string;
  hint: string;
}

/** Published procedures, for the plan wizard's "instructions" step. */
export function loadProcedureOptions(db: Db): ProcedureOption[] {
  return db
    .select({
      id: procedure.id,
      title: procedure.title,
      summary: procedure.summary,
      currentVersionId: procedure.currentVersionId,
      version: procedureVersion.version,
    })
    .from(procedure)
    .leftJoin(procedureVersion, eq(procedure.currentVersionId, procedureVersion.id))
    .where(isNull(procedure.archivedAtMs))
    .orderBy(asc(procedure.title))
    .all()
    .map((row) => ({
      value: row.id,
      label: row.title,
      hint:
        row.currentVersionId === null
          ? "No published version yet — tasks will have no instructions"
          : [`v${row.version ?? 1}`, row.summary].filter(Boolean).join(" · "),
    }));
}

export interface PartOption {
  value: string;
  label: string;
  hint: string;
  unit: PartUnit;
}

/** Part search for the "required materials" step and the completion form. */
export function searchParts(db: Db, query: string, limit = 25): PartOption[] {
  const term = `%${query.trim()}%`;
  const rows = db
    .select({
      id: part.id,
      name: part.name,
      spec: part.spec,
      unit: part.unit,
      manufacturer: part.manufacturer,
      productCode: part.productCode,
    })
    .from(part)
    .where(
      and(
        isNull(part.archivedAtMs),
        query.trim() === ""
          ? undefined
          : or(like(part.name, term), like(part.productCode, term), like(part.spec, term)),
      ),
    )
    .orderBy(asc(part.name))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    value: row.id,
    label: row.name,
    unit: row.unit,
    hint: [row.spec, [row.manufacturer, row.productCode].filter(Boolean).join(" "), row.unit]
      .filter((piece): piece is string => typeof piece === "string" && piece.length > 0)
      .join(" · "),
  }));
}

export interface ProviderOption {
  id: string;
  name: string;
  trade: string | null;
  phone: string | null;
  isPreferred: boolean;
}

export function loadProviders(db: Db): ProviderOption[] {
  return db
    .select({
      id: serviceProvider.id,
      name: serviceProvider.name,
      trade: serviceProvider.trade,
      phone: serviceProvider.phone,
      isPreferred: serviceProvider.isPreferred,
    })
    .from(serviceProvider)
    .orderBy(desc(serviceProvider.isPreferred), asc(serviceProvider.name))
    .all();
}
