import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { attachment, attachmentLink } from "@/db/schema/attachments";
import { part } from "@/db/schema/inventory";
import {
  completion,
  completionMaterial,
  maintenanceOccurrence,
  maintenancePlan,
  occurrenceEvent,
  occurrenceProgressItem,
  planMaterial,
  serviceProvider,
  type OccurrenceEventKind,
} from "@/db/schema/maintenance";
import {
  procedure,
  procedureChecklistItem,
  procedureEquipmentNote,
  procedureMaterial,
  procedureReference,
  procedureStep,
  procedureTool,
  procedureVersion,
  type ChecklistValueKind,
} from "@/db/schema/procedures";
import { availableMilli, expectedMaterialsFor, loadOccurrenceLike } from "@/domain/inventory";
import { parseRecurrenceRule, describeRule } from "@/domain/recurrence";
import type { LocalDate } from "@/domain/time";
import type { MaterialLine } from "@/features/maintenance/materials";
import { loadBookings, loadConditionInfo, readGenerationNote, type ConditionInfo, type TaskBooking } from "./today";
import { resolveTargets, targetOf, type TaskTarget } from "./targets";

export interface TaskDetail {
  id: string;
  planId: string | null;
  source: "plan" | "manual" | "condition";
  title: string;
  description: string | null;
  status: "pending" | "due" | "completed" | "skipped" | "cancelled";
  dueDate: LocalDate;
  originalDueDate: LocalDate;
  windowStartDate: LocalDate | null;
  windowEndDate: LocalDate | null;
  priority: "low" | "normal" | "high" | "urgent";
  estimatedMinutes: number | null;
  assignmentMode: "user" | "shared";
  assigneeUserId: string | null;
  blockedReason: string | null;
  blockedAtMs: number | null;
  serviceBookingId: string | null;
  closedAtMs: number | null;
  closeReason: string | null;
  completionId: string | null;
  target: TaskTarget | null;
  approximateAnchor: boolean;
  missedSeriesDates: LocalDate[];
  booking: TaskBooking | null;
  condition: ConditionInfo | null;
  /** The plan behind the task, when it has one. */
  plan: TaskPlanSummary | null;
  /** The frozen instructions. `null` when the plan has no procedure. */
  procedure: FrozenProcedure | null;
  materials: MaterialLine[];
  photos: TaskPhoto[];
  events: TaskEvent[];
  progress: ProgressRow[];
  /** Completions for the same plan (or the same asset when there is no plan), voided included. */
  history: HistoryEntry[];
  /** The live completion of this occurrence, when it is completed and not voided. */
  liveCompletion: CompletionSummary | null;
}

export interface TaskPlanSummary {
  id: string;
  title: string;
  status: "active" | "paused" | "cancelled";
  ruleText: string;
  scheduleAnchorDate: LocalDate | null;
  scheduleAnchorSource: string;
  scheduleAnchorNote: string | null;
  requiresProfessional: boolean;
  defaultProviderId: string | null;
  defaultProviderName: string | null;
}

export interface FrozenProcedure {
  procedureId: string;
  procedureTitle: string;
  versionId: string;
  version: number;
  status: "draft" | "published" | "superseded";
  publishedAtMs: number | null;
  summary: string | null;
  prerequisites: string | null;
  safetyNotes: string | null;
  steps: FrozenStep[];
  /** Checklist items that belong to the version rather than to a step. */
  looseChecklist: FrozenChecklistItem[];
  tools: { id: string; name: string; isRequired: boolean; notes: string | null }[];
  references: FrozenReference[];
  equipmentNotes: { id: string; note: string; assetId: string | null; assetModelName: string | null }[];
}

export interface FrozenStep {
  id: string;
  seq: number;
  title: string;
  bodyMd: string | null;
  expectedMinutes: number | null;
  isOptional: boolean;
  warning: string | null;
  checklist: FrozenChecklistItem[];
}

export interface FrozenChecklistItem {
  id: string;
  seq: number;
  text: string;
  requiresValue: ChecklistValueKind | null;
  unit: string | null;
}

export interface FrozenReference {
  id: string;
  kind: "manual" | "page" | "url" | "video" | "datasheet";
  label: string;
  url: string | null;
  manualName: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  attachmentId: string | null;
}

export interface ProgressRow {
  id: string;
  itemKind: "step" | "checklist";
  stepId: string | null;
  checklistItemId: string | null;
  state: "todo" | "in_progress" | "done" | "skipped";
  valueText: string | null;
  valueNumber: number | null;
  attachmentId: string | null;
  changedAtMs: number;
  changedBy: string | null;
}

export interface TaskPhoto {
  attachmentId: string;
  linkId: string;
  role: string | null;
  caption: string | null;
  mime: string;
  originalFilename: string;
  width: number | null;
  height: number | null;
  takenAtMs: number | null;
  /** Attached to this occurrence, or to the completion that closed it. */
  scope: "occurrence" | "completion";
}

export interface TaskEvent {
  id: string;
  atMs: number;
  kind: OccurrenceEventKind;
  actorKind: "user" | "worker" | "system" | "ha";
  actorUserId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  fromDueDate: LocalDate | null;
  toDueDate: LocalDate | null;
  reason: string | null;
  detailJson: string | null;
}

export interface CompletionSummary {
  id: string;
  occurrenceId: string;
  completedAtMs: number;
  completedLocalDate: LocalDate;
  precision: "exact" | "day" | "month";
  performedByUserId: string | null;
  performedByProviderId: string | null;
  performedByProviderName: string | null;
  recordedBy: string | null;
  notes: string | null;
  effortMinutes: number | null;
  outcome: "done" | "done_with_issues" | "partial";
  stockResolution: string;
  isReplacement: boolean;
  voidedAtMs: number | null;
  voidReason: string | null;
  materials: CompletionMaterialSummary[];
}

export interface CompletionMaterialSummary {
  partId: string;
  partName: string;
  unit: "pcs" | "l" | "ml" | "m" | "kg" | "g";
  expectedQtyMilli: number | null;
  actualQtyMilli: number;
  shortfallMilli: number;
  resolution: string;
  notes: string | null;
}

export type HistoryEntry =
  | { kind: "completion"; atMs: number; date: LocalDate; completion: CompletionSummary }
  | {
      kind: "closed";
      atMs: number;
      date: LocalDate;
      occurrenceId: string;
      status: "skipped" | "cancelled";
      dueDate: LocalDate;
      reason: string | null;
    };

/**
 * Everything `/tasks/[id]` renders, in one function.
 *
 * The instructions come from the occurrence's **frozen** `procedure_version_id` — never from the
 * procedure's current version. That is the whole point of freezing: someone standing in front of a
 * ventilation unit must see the steps that were in force when the task was generated, even if the
 * procedure was edited yesterday.
 */
export function loadTaskDetail(db: Db, occurrenceId: string): TaskDetail | null {
  const occ = db
    .select()
    .from(maintenanceOccurrence)
    .where(eq(maintenanceOccurrence.id, occurrenceId))
    .get();
  if (!occ) return null;

  const planRow =
    occ.planId === null
      ? null
      : (db.select().from(maintenancePlan).where(eq(maintenancePlan.id, occ.planId)).get() ?? null);

  const targets = resolveTargets(db, [occ]);
  const note = readGenerationNote(occ.generationNoteJson);
  const bookings = loadBookings(db, occ.serviceBookingId === null ? [] : [occ.serviceBookingId]);
  const conditions = loadConditionInfo(db, [occ]);

  let providerName: string | null = null;
  if (planRow?.defaultProviderId) {
    providerName =
      db
        .select({ name: serviceProvider.name })
        .from(serviceProvider)
        .where(eq(serviceProvider.id, planRow.defaultProviderId))
        .get()?.name ?? null;
  }

  // Voided rows are kept deliberately (§5.4): "completed 12 Jun, voided 14 Jun" is the record.
  const completionRows = db
    .select()
    .from(completion)
    .where(eq(completion.occurrenceId, occ.id))
    .orderBy(desc(completion.createdAtMs))
    .all();

  return {
    id: occ.id,
    planId: occ.planId,
    source: occ.source,
    title: occ.title,
    description: planRow?.description ?? null,
    status: occ.status,
    dueDate: occ.dueDate,
    originalDueDate: occ.originalDueDate,
    windowStartDate: occ.windowStartDate,
    windowEndDate: occ.windowEndDate,
    priority: occ.priority,
    estimatedMinutes: occ.estimatedMinutes,
    assignmentMode: occ.assignmentMode,
    assigneeUserId: occ.assigneeUserId,
    blockedReason: occ.blockedReason,
    blockedAtMs: occ.blockedAtMs,
    serviceBookingId: occ.serviceBookingId,
    closedAtMs: occ.closedAtMs,
    closeReason: occ.closeReason,
    completionId: occ.completionId,
    target: targetOf(targets, occ),
    approximateAnchor: note.anchorPrecision === "approx" || note.anchorSource === "baseline_approx",
    missedSeriesDates: note.missedSeriesDates ?? [],
    booking: occ.serviceBookingId === null ? null : (bookings.get(occ.serviceBookingId) ?? null),
    condition: conditions.get(occ.id) ?? null,
    plan:
      planRow === null
        ? null
        : {
            id: planRow.id,
            title: planRow.title,
            status: planRow.status,
            ruleText: safeRuleText(planRow.recurrenceJson),
            scheduleAnchorDate: planRow.scheduleAnchorDate,
            scheduleAnchorSource: planRow.scheduleAnchorSource,
            scheduleAnchorNote: planRow.scheduleAnchorNote,
            requiresProfessional: planRow.requiresProfessional,
            defaultProviderId: planRow.defaultProviderId,
            defaultProviderName: providerName,
          },
    procedure: loadFrozenProcedure(db, occ.procedureVersionId),
    materials: loadMaterialLines(db, occ.id),
    photos: loadTaskPhotos(db, occ.id, occ.completionId),
    events: loadTaskEvents(db, occ.id),
    progress: loadProgress(db, occ.id),
    history: loadTaskHistory(db, occ.planId, occ.assetId, occ.id),
    liveCompletion: pickCompletion(db, completionRows, occ.completionId),
  };
}

function safeRuleText(json: string): string {
  try {
    return describeRule(parseRecurrenceRule(json));
  } catch {
    return "Schedule could not be read";
  }
}

/** The frozen procedure version, with its steps and checklists in `seq` order. */
export function loadFrozenProcedure(db: Db, versionId: string | null): FrozenProcedure | null {
  if (versionId === null) return null;
  const version = db
    .select()
    .from(procedureVersion)
    .where(eq(procedureVersion.id, versionId))
    .get();
  if (!version) return null;
  const proc = db.select().from(procedure).where(eq(procedure.id, version.procedureId)).get();

  const steps = db
    .select()
    .from(procedureStep)
    .where(eq(procedureStep.versionId, versionId))
    .orderBy(asc(procedureStep.seq))
    .all();
  const checklist = db
    .select()
    .from(procedureChecklistItem)
    .where(eq(procedureChecklistItem.versionId, versionId))
    .orderBy(asc(procedureChecklistItem.seq))
    .all();
  const tools = db
    .select()
    .from(procedureTool)
    .where(eq(procedureTool.versionId, versionId))
    .orderBy(asc(procedureTool.id))
    .all();
  const references = db
    .select()
    .from(procedureReference)
    .where(eq(procedureReference.versionId, versionId))
    .orderBy(asc(procedureReference.id))
    .all();
  const equipmentNotes = db
    .select()
    .from(procedureEquipmentNote)
    .where(eq(procedureEquipmentNote.versionId, versionId))
    .orderBy(asc(procedureEquipmentNote.id))
    .all();

  const byStep = new Map<string, FrozenChecklistItem[]>();
  const loose: FrozenChecklistItem[] = [];
  for (const item of checklist) {
    const mapped: FrozenChecklistItem = {
      id: item.id,
      seq: item.seq,
      text: item.text,
      requiresValue: item.requiresValue,
      unit: item.unit,
    };
    if (item.stepId === null) loose.push(mapped);
    else {
      const list = byStep.get(item.stepId) ?? [];
      list.push(mapped);
      byStep.set(item.stepId, list);
    }
  }

  return {
    procedureId: version.procedureId,
    procedureTitle: proc?.title ?? "Procedure",
    versionId: version.id,
    version: version.version,
    status: version.status,
    publishedAtMs: version.publishedAtMs,
    summary: proc?.summary ?? null,
    prerequisites: version.prerequisites,
    safetyNotes: version.safetyNotes,
    steps: steps.map((step) => ({
      id: step.id,
      seq: step.seq,
      title: step.title,
      bodyMd: step.bodyMd,
      expectedMinutes: step.expectedMinutes,
      isOptional: step.isOptional,
      warning: step.warning,
      checklist: byStep.get(step.id) ?? [],
    })),
    looseChecklist: loose,
    tools: tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      isRequired: tool.isRequired,
      notes: tool.notes,
    })),
    references: references.map((ref) => ({
      id: ref.id,
      kind: ref.kind,
      label: ref.label,
      url: ref.url,
      manualName: ref.manualName,
      pageFrom: ref.pageFrom,
      pageTo: ref.pageTo,
      attachmentId: ref.attachmentId,
    })),
    equipmentNotes: equipmentNotes.map((row) => ({
      id: row.id,
      note: row.note,
      assetId: row.assetId,
      assetModelName: row.assetModelName,
    })),
  };
}

/**
 * The expected material lines with their part details and ledger balance.
 *
 * `expectedMaterialsFor` is the domain's resolution order (§1.7): plan ∪ procedure, plan winning on
 * a conflicting part, plus the asset's consumables for the declared roles. Nothing is invented
 * here; `availableMilli` is the same SUM the completion transaction checks against.
 */
export function loadMaterialLines(db: Db, occurrenceId: string): MaterialLine[] {
  const occurrenceLike = loadOccurrenceLike(db, occurrenceId);
  const expected = expectedMaterialsFor(db, occurrenceLike);
  if (expected.length === 0) return [];

  const parts = db
    .select({
      id: part.id,
      name: part.name,
      spec: part.spec,
      unit: part.unit,
      trackingMode: part.trackingMode,
    })
    .from(part)
    .where(inArray(part.id, expected.map((line) => line.partId)))
    .all();
  const partById = new Map(parts.map((row) => [row.id, row]));

  return expected.flatMap((line) => {
    const row = partById.get(line.partId);
    if (!row) return [];
    return [
      {
        partId: line.partId,
        partName: row.name,
        spec: row.spec,
        unit: row.unit,
        trackingMode: row.trackingMode,
        expectedQtyMilli: line.qtyMilli,
        isRequired: line.isRequired,
        source: line.source,
        availableMilli: availableMilli(db, line.partId),
      } satisfies MaterialLine,
    ];
  });
}

export function loadTaskPhotos(
  db: Db,
  occurrenceId: string,
  completionId: string | null,
): TaskPhoto[] {
  const rows = db
    .select({
      linkId: attachmentLink.id,
      attachmentId: attachmentLink.attachmentId,
      entityKind: attachmentLink.entityKind,
      role: attachmentLink.role,
      seq: attachmentLink.seq,
      caption: attachment.caption,
      mime: attachment.mime,
      originalFilename: attachment.originalFilename,
      width: attachment.width,
      height: attachment.height,
      takenAtMs: attachment.takenAtMs,
    })
    .from(attachmentLink)
    .innerJoin(attachment, eq(attachmentLink.attachmentId, attachment.id))
    .where(
      completionId === null
        ? and(eq(attachmentLink.entityKind, "occurrence"), eq(attachmentLink.entityId, occurrenceId))
        : or(
            and(
              eq(attachmentLink.entityKind, "occurrence"),
              eq(attachmentLink.entityId, occurrenceId),
            ),
            and(
              eq(attachmentLink.entityKind, "completion"),
              eq(attachmentLink.entityId, completionId),
            ),
          ),
    )
    .orderBy(asc(attachmentLink.seq), asc(attachmentLink.id))
    .all();

  return rows.map((row) => ({
    linkId: row.linkId,
    attachmentId: row.attachmentId,
    role: row.role,
    caption: row.caption,
    mime: row.mime,
    originalFilename: row.originalFilename,
    width: row.width,
    height: row.height,
    takenAtMs: row.takenAtMs,
    scope: row.entityKind === "completion" ? "completion" : "occurrence",
  }));
}

export function loadTaskEvents(db: Db, occurrenceId: string): TaskEvent[] {
  return db
    .select()
    .from(occurrenceEvent)
    .where(eq(occurrenceEvent.occurrenceId, occurrenceId))
    .orderBy(desc(occurrenceEvent.atMs), desc(occurrenceEvent.id))
    .all()
    .map((row) => ({
      id: row.id,
      atMs: row.atMs,
      kind: row.kind,
      actorKind: row.actorKind,
      actorUserId: row.actorUserId,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      fromDueDate: row.fromDueDate,
      toDueDate: row.toDueDate,
      reason: row.reason,
      detailJson: row.detailJson,
    }));
}

export function loadProgress(db: Db, occurrenceId: string): ProgressRow[] {
  return db
    .select()
    .from(occurrenceProgressItem)
    .where(eq(occurrenceProgressItem.occurrenceId, occurrenceId))
    .all()
    .map((row) => ({
      id: row.id,
      itemKind: row.itemKind,
      stepId: row.stepId,
      checklistItemId: row.checklistItemId,
      state: row.state,
      valueText: row.valueText,
      valueNumber: row.valueNumber,
      attachmentId: row.attachmentId,
      changedAtMs: row.changedAtMs,
      changedBy: row.changedBy,
    }));
}

/**
 * The completion to show on the task page: the live one when there is one, otherwise the most
 * recent voided one — so a void stays visible instead of the page silently going back to "open".
 */
function pickCompletion(
  db: Db,
  rows: readonly (typeof completion.$inferSelect)[],
  completionId: string | null,
): CompletionSummary | null {
  const named = completionId === null ? undefined : rows.find((row) => row.id === completionId);
  const chosen = named ?? rows.find((row) => row.voidedAtMs === null) ?? rows[0];
  return chosen ? summariseCompletion(db, chosen) : null;
}

export function summariseCompletion(
  db: Db,
  row: typeof completion.$inferSelect,
): CompletionSummary {
  const materials = db
    .select({
      partId: completionMaterial.partId,
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
    .where(eq(completionMaterial.completionId, row.id))
    .orderBy(asc(part.name))
    .all();

  const providerName =
    row.performedByProviderId === null
      ? null
      : (db
          .select({ name: serviceProvider.name })
          .from(serviceProvider)
          .where(eq(serviceProvider.id, row.performedByProviderId))
          .get()?.name ?? null);

  return {
    id: row.id,
    occurrenceId: row.occurrenceId,
    completedAtMs: row.completedAtMs,
    completedLocalDate: row.completedLocalDate,
    precision: row.completedAtPrecision,
    performedByUserId: row.performedByUserId,
    performedByProviderId: row.performedByProviderId,
    performedByProviderName: providerName,
    recordedBy: row.recordedBy,
    notes: row.notes,
    effortMinutes: row.effortMinutes,
    outcome: row.outcome,
    stockResolution: row.stockResolution,
    isReplacement: row.isReplacement,
    voidedAtMs: row.voidedAtMs,
    voidReason: row.voidReason,
    materials: materials.map((line) => ({
      partId: line.partId,
      partName: line.partName,
      unit: line.unit,
      expectedQtyMilli: line.expectedQtyMilli,
      actualQtyMilli: line.actualQtyMilli,
      shortfallMilli: line.shortfallMilli,
      resolution: line.resolution,
      notes: line.notes,
    })),
  };
}

/**
 * What has actually happened to this plan (or, for ad-hoc work, this asset): completions including
 * voided ones, plus occurrences that were skipped or cancelled.
 *
 * Skipped occurrences appear because "we decided not to" is part of the record — and because a
 * skip is exactly what must *not* look like a completion (CLAUDE.md rule 6).
 */
export function loadTaskHistory(
  db: Db,
  planId: string | null,
  assetId: string | null,
  excludeOccurrenceId: string,
  limit = 25,
): HistoryEntry[] {
  const scope =
    planId !== null
      ? eq(completion.planId, planId)
      : assetId !== null
        ? eq(completion.assetId, assetId)
        : null;
  if (scope === null) return [];

  const completions = db
    .select()
    .from(completion)
    .where(scope)
    .orderBy(desc(completion.completedAtMs))
    .limit(limit)
    .all();

  const closedScope =
    planId !== null
      ? eq(maintenanceOccurrence.planId, planId)
      : eq(maintenanceOccurrence.assetId, assetId!);
  const closed = db
    .select({
      id: maintenanceOccurrence.id,
      status: maintenanceOccurrence.status,
      dueDate: maintenanceOccurrence.dueDate,
      closedAtMs: maintenanceOccurrence.closedAtMs,
      closeReason: maintenanceOccurrence.closeReason,
    })
    .from(maintenanceOccurrence)
    .where(
      and(
        closedScope,
        inArray(maintenanceOccurrence.status, ["skipped", "cancelled"]),
        isNotNull(maintenanceOccurrence.closedAtMs),
      ),
    )
    .orderBy(desc(maintenanceOccurrence.closedAtMs))
    .limit(limit)
    .all();

  const entries: HistoryEntry[] = [
    ...completions
      .filter((row) => row.occurrenceId !== excludeOccurrenceId)
      .map(
        (row): HistoryEntry => ({
          kind: "completion",
          atMs: row.completedAtMs,
          date: row.completedLocalDate,
          completion: summariseCompletion(db, row),
        }),
      ),
    ...closed
      .filter((row) => row.id !== excludeOccurrenceId)
      .map(
        (row): HistoryEntry => ({
          kind: "closed",
          atMs: row.closedAtMs ?? 0,
          date: row.dueDate,
          occurrenceId: row.id,
          status: row.status === "cancelled" ? "cancelled" : "skipped",
          dueDate: row.dueDate,
          reason: row.closeReason,
        }),
      ),
  ];

  entries.sort((a, b) => b.atMs - a.atMs);
  return entries.slice(0, limit);
}

/** Plan-level expected materials, for the plan editor (not the completion form). */
export function loadPlanMaterials(db: Db, planId: string): MaterialLine[] {
  const rows = db
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
    .all();

  return rows.map((row) => ({
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

/** Procedure-level materials, shown read-only beside the plan's own list. */
export function loadProcedureMaterials(db: Db, versionId: string): MaterialLine[] {
  const rows = db
    .select({
      partId: procedureMaterial.partId,
      qtyMilli: procedureMaterial.qtyMilli,
      isRequired: procedureMaterial.isRequired,
      partName: part.name,
      spec: part.spec,
      unit: part.unit,
      trackingMode: part.trackingMode,
    })
    .from(procedureMaterial)
    .innerJoin(part, eq(procedureMaterial.partId, part.id))
    .where(eq(procedureMaterial.versionId, versionId))
    .orderBy(asc(part.name))
    .all();

  return rows.map((row) => ({
    partId: row.partId,
    partName: row.partName,
    spec: row.spec,
    unit: row.unit,
    trackingMode: row.trackingMode,
    expectedQtyMilli: row.qtyMilli,
    isRequired: row.isRequired,
    source: "procedure" as const,
    availableMilli: availableMilli(db, row.partId),
  }));
}
