/**
 * The occurrence lifecycle (§3) — generation, completion bookkeeping, postpone, snooze, skip,
 * cancel, block, reopen and schedule seeding.
 *
 * **Every function here takes a Drizzle `tx` that is already inside `writeTx()`** and never opens
 * a transaction of its own: the completion transaction (§5.1) has to close an occurrence, clear
 * both recipients, generate the successor and move the plan anchor atomically, so these are
 * composable steps rather than self-contained commands.
 *
 * Two CLAUDE.md rules shape all of it:
 *  - rule 6, **never fabricate maintenance history**: seeding writes `schedule_anchor_date`, skip
 *    writes `schedule_anchor_source='skipped_due_date'`, and neither ever creates a `completion`
 *    row or touches `plan.last_completion_id`;
 *  - rule 4, all calendar maths goes through `time.ts` with an injected clock.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { newId } from "@/db/ids";
import { asset } from "@/db/schema/assets";
import {
  HOUSEHOLD_SETTING_ID,
  auditLog,
  householdSetting,
  type AuditActorKind,
} from "@/db/schema/household";
import {
  OCCURRENCE_OPEN_STATUSES,
  completion,
  maintenanceOccurrence,
  maintenancePlan,
  occurrenceEvent,
  occurrenceProgressItem,
  type OccurrenceEventKind,
  type OccurrenceSource,
  type OccurrenceStatus,
} from "@/db/schema/maintenance";
import { notificationActionEvent, notificationRecipientState, reminderSlot } from "@/db/schema/notifications";
import { procedure } from "@/db/schema/procedures";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { clearRecipients, rearmRecipientStates } from "./notify/recipients";
import {
  computeNextDue,
  isCompletionAnchored,
  parseRecurrenceRule,
  type Anchor,
  type AnchorSource,
  type NextDue,
  type RecurrenceRule,
} from "./recurrence";
import {
  addDaysLocal,
  compareLocalDate,
  instantOf,
  isValidLocalDate,
  localDateOf,
  type Clock,
  type LocalDate,
  type LocalTime,
} from "./time";

export type OccurrenceRow = typeof maintenanceOccurrence.$inferSelect;
export type PlanRow = typeof maintenancePlan.$inferSelect;
export type CompletionRow = typeof completion.$inferSelect;
export type OccurrenceEventRow = typeof occurrenceEvent.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;

/** Who is acting, what time it is, and which zone the household lives in. */
export interface DomainCtx {
  clock: Clock;
  tz: string;
  actorUserId: string | null;
  actorKind: AuditActorKind;
}

/** Not household settings: policy defaults the schema does not (yet) carry a column for. */
export const DEFAULT_MAX_POSTPONE_DAYS = 365;
export const DEFAULT_REOPEN_WINDOW_DAYS = 90;
export const DEFAULT_APP_BASE_URL = "http://localhost:3010";
/** How long reminders are snoozed when a condition reading recovers (§6.5) — never cleared. */
export const DEFAULT_RECOVERY_SNOOZE_DAYS = 3;

export interface HouseholdSettings {
  timezone: string;
  deliveryTime: LocalTime;
  reminderIntervalDays: number;
  sendWindowStart: LocalTime;
  sendWindowEnd: LocalTime;
  catchupGapMinutes: number;
  catchupDigestThreshold: number;
  slotGraceMinutes: number;
  actionTtlDays: number;
  /** `original_due_date + this` is the furthest a postpone may reach. */
  maxPostponeDays: number;
  /** How long after closing a skipped/cancelled occurrence may be reopened. */
  reopenWindowDays: number;
  /** Base URL used in notification `url`/`URI` actions. */
  appBaseUrl: string;
  haBaseUrl: string;
  // Condition (low-battery) hysteresis — §6.3.
  batteryThresholdPct: number;
  batteryClearPct: number;
  batterySustainMinutes: number;
  batteryClearSustainMinutes: number;
  batteryStaleHours: number;
  /** Days of reminders after a condition reading recovers. */
  recoverySnoozeDays: number;
  // Inventory.
  reorderHorizonDays: number;
  inventoryPushEnabled: boolean;
  // Identity / model pointers, for callers that need them without a second read.
  displayName: string;
  currentModelId: string;
  currentModelRevisionId: string | null;
}

/** Read the singleton `household_setting` row. */
export function loadHousehold(tx: Db): HouseholdSettings {
  const row = tx
    .select()
    .from(householdSetting)
    .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
    .all()[0];
  if (!row) throw new NotFoundError("household_setting", HOUSEHOLD_SETTING_ID);
  return {
    timezone: row.timezone,
    deliveryTime: row.deliveryTime,
    reminderIntervalDays: row.reminderIntervalDays,
    sendWindowStart: row.sendWindowStart,
    sendWindowEnd: row.sendWindowEnd,
    catchupGapMinutes: row.catchupGapMinutes,
    catchupDigestThreshold: row.catchupDigestThreshold,
    slotGraceMinutes: row.slotGraceMinutes,
    actionTtlDays: row.actionTtlDays,
    maxPostponeDays: DEFAULT_MAX_POSTPONE_DAYS,
    reopenWindowDays: DEFAULT_REOPEN_WINDOW_DAYS,
    appBaseUrl: DEFAULT_APP_BASE_URL,
    haBaseUrl: row.haBaseUrl,
    batteryThresholdPct: row.batteryThresholdPct,
    batteryClearPct: row.batteryClearPct,
    batterySustainMinutes: row.batterySustainMinutes,
    batteryClearSustainMinutes: row.batteryClearSustainMinutes,
    batteryStaleHours: row.batteryStaleHours,
    recoverySnoozeDays: DEFAULT_RECOVERY_SNOOZE_DAYS,
    reorderHorizonDays: row.reorderHorizonDays,
    inventoryPushEnabled: row.inventoryPushEnabled,
    displayName: row.displayName,
    currentModelId: row.currentModelId,
    currentModelRevisionId: row.currentModelRevisionId,
  };
}

// ---------------------------------------------------------------------------------------------
// Small shared writers
// ---------------------------------------------------------------------------------------------

export interface OccurrenceEventInput {
  occurrenceId: string;
  kind: OccurrenceEventKind;
  fromStatus?: OccurrenceStatus | null;
  toStatus?: OccurrenceStatus | null;
  fromDueDate?: LocalDate | null;
  toDueDate?: LocalDate | null;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
}

/** Append to the typed domain timeline that drives the task page. */
export function writeOccurrenceEvent(tx: Db, ctx: DomainCtx, input: OccurrenceEventInput): void {
  tx.insert(occurrenceEvent)
    .values({
      id: newId(),
      occurrenceId: input.occurrenceId,
      atMs: ctx.clock.now(),
      actorKind: ctx.actorKind,
      actorUserId: ctx.actorUserId,
      kind: input.kind,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      fromDueDate: input.fromDueDate ?? null,
      toDueDate: input.toDueDate ?? null,
      reason: input.reason ?? null,
      detailJson: input.detail ? JSON.stringify(input.detail) : null,
    })
    .run();
}

export interface AuditInput {
  entityTable: string;
  entityId: string;
  action: string;
  summary: string;
  changes?: Record<string, [unknown, unknown]>;
  requestId?: string;
}

/** Generic "who changed what" row, for meaningful changes only. */
export function writeAuditLog(tx: Db, ctx: DomainCtx, input: AuditInput): void {
  tx.insert(auditLog)
    .values({
      id: newId(),
      atMs: ctx.clock.now(),
      actorKind: ctx.actorKind,
      actorUserId: ctx.actorUserId,
      entityTable: input.entityTable,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary,
      changesJson: input.changes ? JSON.stringify(input.changes) : null,
      requestId: input.requestId ?? null,
    })
    .run();
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export function loadOccurrence(tx: Db, occurrenceId: string): OccurrenceRow {
  const row = tx
    .select()
    .from(maintenanceOccurrence)
    .where(eq(maintenanceOccurrence.id, occurrenceId))
    .all()[0];
  if (!row) throw new NotFoundError("maintenance_occurrence", occurrenceId);
  return row;
}

export function loadPlan(tx: Db, planId: string): PlanRow {
  const row = tx.select().from(maintenancePlan).where(eq(maintenancePlan.id, planId)).all()[0];
  if (!row) throw new NotFoundError("maintenance_plan", planId);
  return row;
}

/** The plan's single open occurrence, if it has one (`ux_occ_open_per_plan` guarantees ≤ 1). */
export function openOccurrenceOfPlan(tx: Db, planId: string): OccurrenceRow | null {
  return (
    tx
      .select()
      .from(maintenanceOccurrence)
      .where(
        and(
          eq(maintenanceOccurrence.planId, planId),
          inArray(maintenanceOccurrence.status, [...OCCURRENCE_OPEN_STATUSES]),
        ),
      )
      .all()[0] ?? null
  );
}

export function isOpen(occ: OccurrenceRow): boolean {
  return occ.status === "pending" || occ.status === "due";
}

/** `overdue` is derived, never stored: an announced occurrence whose due date has passed. */
export function isOverdue(occ: OccurrenceRow, today: LocalDate): boolean {
  return occ.status === "due" && compareLocalDate(occ.dueDate, today) < 0;
}

function assertOpen(occ: OccurrenceRow): void {
  if (!isOpen(occ)) {
    throw new ConflictError("occurrence_not_open", `occurrence is ${occ.status}`, {
      status: occ.status,
      occurrenceId: occ.id,
    });
  }
}

interface GenerationNote {
  missedSeriesDates?: LocalDate[];
  anchorSource?: AnchorSource;
  anchorDate?: LocalDate | null;
  anchorPrecision?: "exact" | "approx";
  generatedByCompletionId?: string;
  seedKind?: string;
  note?: string;
}

function readGenerationNote(occ: OccurrenceRow): GenerationNote {
  if (!occ.generationNoteJson) return {};
  try {
    return JSON.parse(occ.generationNoteJson) as GenerationNote;
  } catch {
    return {};
  }
}

function resolveProcedureVersionId(tx: Db, plan: PlanRow): string | null {
  if (plan.pinProcedureVersionId) return plan.pinProcedureVersionId;
  if (!plan.procedureId) return null;
  const row = tx.select().from(procedure).where(eq(procedure.id, plan.procedureId)).all()[0];
  return row?.currentVersionId ?? null;
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

export interface CreateOccurrenceOptions {
  /** Overrides the plan's stored anchor (a completion passes the completion date here). */
  anchor?: Anchor;
  /** Stamped into `generation_note_json` so a void can recognise its own successor. */
  generatedByCompletionId?: string;
  /** Extra fields merged into `generation_note_json`. */
  note?: Record<string, unknown>;
}

/**
 * Generate the plan's next occurrence, or return `null` when there is nothing to generate:
 * the plan is not `active`, an open occurrence already exists (one-open-per-plan), the rule is
 * terminal (`one_off`, `condition`), or the plan still has no schedule anchor ("ask me later").
 */
export function createOccurrenceForPlan(
  tx: Db,
  ctx: DomainCtx,
  planId: string,
  opts: CreateOccurrenceOptions = {},
): OccurrenceRow | null {
  const plan = loadPlan(tx, planId);
  if (plan.status !== "active") return null;
  if (openOccurrenceOfPlan(tx, planId) !== null) return null;

  const rule = parseRecurrenceRule(plan.recurrenceJson);
  const anchor: Anchor =
    opts.anchor ?? { date: plan.scheduleAnchorDate, source: plan.scheduleAnchorSource };
  // "No idea / ask me later": there is no scheduling input, so there is nothing honest to compute.
  if (anchor.date === null && anchor.source === "none") return null;

  const next = computeNextDue(rule, anchor, ctx.clock.now(), ctx.tz);
  if (next === null) return null;

  return insertOccurrence(tx, ctx, {
    plan,
    rule,
    anchor,
    next,
    source: "plan",
    generatedByCompletionId: opts.generatedByCompletionId,
    extraNote: opts.note,
  });
}

interface InsertOccurrenceInput {
  plan: PlanRow;
  rule: RecurrenceRule;
  anchor: Anchor;
  next: NextDue;
  source: OccurrenceSource;
  generatedByCompletionId?: string;
  extraNote?: Record<string, unknown>;
}

function insertOccurrence(tx: Db, ctx: DomainCtx, input: InsertOccurrenceInput): OccurrenceRow {
  const { plan, anchor, next } = input;
  const now = ctx.clock.now();
  const note: GenerationNote & Record<string, unknown> = {
    missedSeriesDates: next.missedSeriesDates,
    anchorSource: anchor.source,
    anchorDate: anchor.date,
    ...(anchor.source === "baseline_approx" ? { anchorPrecision: "approx" as const } : {}),
    ...(input.generatedByCompletionId
      ? { generatedByCompletionId: input.generatedByCompletionId }
      : {}),
    ...(input.extraNote ?? {}),
  };

  const row: OccurrenceRow = {
    id: newId(),
    planId: plan.id,
    source: input.source,
    conditionRuleId: null,
    conditionEpisodeId: null,
    assetId: plan.assetId,
    systemId: plan.systemId,
    locationId: plan.locationId,
    title: plan.title,
    procedureVersionId: resolveProcedureVersionId(tx, plan),
    status: "pending",
    dueDate: next.dueDate,
    originalDueDate: next.dueDate,
    windowStartDate: next.windowStartDate ?? null,
    windowEndDate: next.windowEndDate ?? null,
    generationNoteJson: JSON.stringify(note),
    assignmentMode: plan.assignmentMode,
    assigneeUserId: plan.assigneeUserId,
    priority: plan.priority,
    estimatedMinutes: plan.estimatedMinutes,
    blockedReason: null,
    blockedAtMs: null,
    blockedBy: null,
    serviceBookingId: null,
    becameDueAtMs: null,
    completionId: null,
    closedAtMs: null,
    closeReason: null,
    conditionRuleKey: null,
    createdAtMs: now,
    createdBy: ctx.actorUserId,
    updatedAtMs: now,
    updatedBy: ctx.actorUserId,
  };

  // `condition_rule_key` is a VIRTUAL generated column — present on reads, never written.
  const { conditionRuleKey, ...insertable } = row;
  void conditionRuleKey;
  tx.insert(maintenanceOccurrence).values(insertable).run();

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: row.id,
    kind: "created",
    toStatus: "pending",
    toDueDate: row.dueDate,
    detail: { anchorSource: anchor.source, anchorDate: anchor.date, missedSeriesDates: next.missedSeriesDates },
  });
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: row.id,
    action: "created",
    summary: `Generated "${row.title}" due ${row.dueDate}`,
  });
  if (next.missedSeriesDates.length > 0) {
    writeAuditLog(tx, ctx, {
      entityTable: "maintenance_occurrence",
      entityId: row.id,
      action: "fixed_series_dates_skipped",
      summary: `${next.missedSeriesDates.length} scheduled date(s) passed while the previous task was open: ${next.missedSeriesDates.join(", ")}`,
    });
  }
  return row;
}

export interface CreateConditionOccurrenceInput {
  conditionRuleId: string;
  conditionEpisodeId: string;
  assetId: string;
  title: string;
  dueDate: LocalDate;
  priority: OccurrenceRow["priority"];
  assignmentMode: OccurrenceRow["assignmentMode"];
  assigneeUserId: string | null;
  procedureVersionId?: string | null;
}

/**
 * The occurrence a condition episode opens (§6.4).
 *
 * A battery that dips, recovers and dips again while the first task is still open must produce
 * **no** second task: `ux_occ_open_per_condition` is the structural guard, and this function
 * honours it by returning the existing open occurrence and appending an event instead.
 */
export function createConditionOccurrence(
  tx: Db,
  ctx: DomainCtx,
  input: CreateConditionOccurrenceInput,
): OccurrenceRow {
  const existing = tx
    .select()
    .from(maintenanceOccurrence)
    .where(
      and(
        eq(maintenanceOccurrence.source, "condition"),
        eq(maintenanceOccurrence.conditionRuleId, input.conditionRuleId),
        eq(maintenanceOccurrence.assetId, input.assetId),
        inArray(maintenanceOccurrence.status, [...OCCURRENCE_OPEN_STATUSES]),
      ),
    )
    .all()[0];

  if (existing) {
    writeOccurrenceEvent(tx, ctx, {
      occurrenceId: existing.id,
      kind: "created",
      reason: "condition_reopened_while_open",
      detail: { conditionEpisodeId: input.conditionEpisodeId, reused: true },
    });
    return existing;
  }

  const now = ctx.clock.now();
  const row: OccurrenceRow = {
    id: newId(),
    planId: null,
    source: "condition",
    conditionRuleId: input.conditionRuleId,
    conditionEpisodeId: input.conditionEpisodeId,
    assetId: input.assetId,
    systemId: null,
    locationId: null,
    title: input.title,
    procedureVersionId: input.procedureVersionId ?? null,
    status: "pending",
    dueDate: input.dueDate,
    originalDueDate: input.dueDate,
    windowStartDate: null,
    windowEndDate: null,
    generationNoteJson: JSON.stringify({
      anchorSource: "none" satisfies AnchorSource,
      conditionEpisodeId: input.conditionEpisodeId,
    }),
    assignmentMode: input.assignmentMode,
    assigneeUserId: input.assigneeUserId,
    priority: input.priority,
    estimatedMinutes: null,
    blockedReason: null,
    blockedAtMs: null,
    blockedBy: null,
    serviceBookingId: null,
    becameDueAtMs: null,
    completionId: null,
    closedAtMs: null,
    closeReason: null,
    conditionRuleKey: null,
    createdAtMs: now,
    createdBy: ctx.actorUserId,
    updatedAtMs: now,
    updatedBy: ctx.actorUserId,
  };
  const { conditionRuleKey, ...insertable } = row;
  void conditionRuleKey;
  tx.insert(maintenanceOccurrence).values(insertable).run();

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: row.id,
    kind: "created",
    toStatus: "pending",
    toDueDate: row.dueDate,
    detail: { conditionRuleId: input.conditionRuleId, conditionEpisodeId: input.conditionEpisodeId },
  });
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: row.id,
    action: "created",
    summary: `Condition task "${row.title}" due ${row.dueDate}`,
  });
  return row;
}

// ---------------------------------------------------------------------------------------------
// Completion bookkeeping
// ---------------------------------------------------------------------------------------------

/** The anchor a completed occurrence hands to `computeNextDue`. */
export function anchorForCompletion(
  rule: RecurrenceRule,
  occ: OccurrenceRow,
  completedLocalDate: LocalDate,
): Anchor {
  // Completion-anchored kinds measure from the actual completion; calendar kinds measure from the
  // due date of the occurrence just closed, so the series never drifts.
  return {
    date: isCompletionAnchored(rule) ? completedLocalDate : occ.dueDate,
    source: "completion",
  };
}

export interface MarkCompletedInput {
  occurrenceId: string;
  completionId: string;
  completedLocalDate: LocalDate;
  completedAtMs: number;
}

/**
 * Close an occurrence against an already-inserted `completion` row, clear both recipients, move
 * the plan's anchor and generate the successor. Steps 7, 8, 10 and 11 of §5.1 — the caller owns
 * the idempotency probe, the completion row and the stock ledger.
 */
export function markCompleted(
  tx: Db,
  ctx: DomainCtx,
  input: MarkCompletedInput,
): { next: OccurrenceRow | null } {
  const occ = loadOccurrence(tx, input.occurrenceId);
  assertOpen(occ);
  const now = ctx.clock.now();

  tx.update(maintenanceOccurrence)
    .set({
      status: "completed",
      completionId: input.completionId,
      closedAtMs: now,
      closeReason: "completed",
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenanceOccurrence.id, occ.id))
    .run();

  clearRecipients(tx, ctx, occ.id, "completed");

  let next: OccurrenceRow | null = null;
  if (occ.planId !== null) {
    const plan = loadPlan(tx, occ.planId);
    const rule = parseRecurrenceRule(plan.recurrenceJson);
    const anchor = anchorForCompletion(rule, occ, input.completedLocalDate);

    tx.update(maintenancePlan)
      .set({
        lastCompletionId: input.completionId,
        scheduleAnchorDate: anchor.date,
        scheduleAnchorSource: "completion",
        updatedAtMs: now,
        updatedBy: ctx.actorUserId,
      })
      .where(eq(maintenancePlan.id, plan.id))
      .run();
    writeAuditLog(tx, ctx, {
      entityTable: "maintenance_plan",
      entityId: plan.id,
      action: "updated",
      summary: `Anchor moved to ${anchor.date ?? "none"} by a completion`,
      changes: {
        scheduleAnchorDate: [plan.scheduleAnchorDate, anchor.date],
        scheduleAnchorSource: [plan.scheduleAnchorSource, "completion"],
        lastCompletionId: [plan.lastCompletionId, input.completionId],
      },
    });

    next = createOccurrenceForPlan(tx, ctx, plan.id, {
      anchor,
      generatedByCompletionId: input.completionId,
    });
  }

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: occ.id,
    kind: "completed",
    fromStatus: occ.status,
    toStatus: "completed",
    detail: {
      completionId: input.completionId,
      completedLocalDate: input.completedLocalDate,
      completedAtMs: input.completedAtMs,
      successorOccurrenceId: next?.id ?? null,
    },
  });
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: occ.id,
    action: "completed",
    summary: `Completed "${occ.title}" on ${input.completedLocalDate}`,
  });

  return { next };
}

/** What stops a successor occurrence from being cancelled by a reopen or a void. */
export function successorBlockers(tx: Db, occ: OccurrenceRow): string[] {
  const blockers: string[] = [];
  const progress = tx
    .select({ id: occurrenceProgressItem.id })
    .from(occurrenceProgressItem)
    .where(eq(occurrenceProgressItem.occurrenceId, occ.id))
    .all();
  if (progress.length > 0) blockers.push("progress");

  const live = tx
    .select({ id: completion.id })
    .from(completion)
    .where(and(eq(completion.occurrenceId, occ.id), isNull(completion.voidedAtMs)))
    .all();
  if (live.length > 0) blockers.push("completion");

  const acted = tx
    .select({ id: notificationActionEvent.id })
    .from(notificationActionEvent)
    .where(
      and(
        eq(notificationActionEvent.claimedOccurrenceId, occ.id),
        eq(notificationActionEvent.validation, "accepted"),
        ne(notificationActionEvent.appliedEffect, "noop"),
      ),
    )
    .all();
  if (acted.length > 0) blockers.push("notification_action");

  return blockers;
}

function cancelSuccessor(
  tx: Db,
  ctx: DomainCtx,
  successor: OccurrenceRow,
  closeReason: string,
): void {
  const blockers = successorBlockers(tx, successor);
  if (blockers.length > 0) {
    throw new ConflictError(
      "successor_touched",
      `the successor occurrence has been worked on (${blockers.join(", ")}) — handle it first`,
      { occurrenceId: successor.id, blockers },
    );
  }
  const now = ctx.clock.now();
  tx.update(maintenanceOccurrence)
    .set({
      status: "cancelled",
      closedAtMs: now,
      closeReason,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenanceOccurrence.id, successor.id))
    .run();
  clearRecipients(tx, ctx, successor.id, "cancelled");
  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: successor.id,
    kind: "cancelled",
    fromStatus: successor.status,
    toStatus: "cancelled",
    reason: closeReason,
  });
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: successor.id,
    action: "cancelled",
    summary: `Cancelled successor (${closeReason})`,
  });
}

/**
 * Move the plan's anchor back to the most recent **non-voided** completion, or — when there is
 * none — to the anchor that generated the occurrence being reopened (the pre-existing baseline).
 * Never invents an anchor and never leaves `last_completion_id` pointing at voided work.
 */
function revertPlanAnchor(tx: Db, ctx: DomainCtx, plan: PlanRow, reopened: OccurrenceRow): void {
  const rule = parseRecurrenceRule(plan.recurrenceJson);
  const previous = tx
    .select({ completion, dueDate: maintenanceOccurrence.dueDate })
    .from(completion)
    .innerJoin(maintenanceOccurrence, eq(maintenanceOccurrence.id, completion.occurrenceId))
    .where(
      and(
        eq(completion.planId, plan.id),
        isNull(completion.voidedAtMs),
        ne(completion.occurrenceId, reopened.id),
      ),
    )
    .orderBy(desc(completion.completedLocalDate), desc(completion.completedAtMs))
    .all()[0];

  let anchorDate: LocalDate | null;
  let anchorSource: AnchorSource;
  let lastCompletionId: string | null;
  if (previous) {
    anchorDate = isCompletionAnchored(rule)
      ? previous.completion.completedLocalDate
      : previous.dueDate;
    anchorSource = "completion";
    lastCompletionId = previous.completion.id;
  } else {
    const note = readGenerationNote(reopened);
    anchorDate = note.anchorDate ?? null;
    anchorSource = note.anchorSource ?? "none";
    lastCompletionId = null;
  }

  const now = ctx.clock.now();
  tx.update(maintenancePlan)
    .set({
      lastCompletionId,
      scheduleAnchorDate: anchorDate,
      scheduleAnchorSource: anchorSource,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenancePlan.id, plan.id))
    .run();
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_plan",
    entityId: plan.id,
    action: "updated",
    summary: `Anchor reverted to ${anchorDate ?? "none"} (${anchorSource})`,
    changes: {
      scheduleAnchorDate: [plan.scheduleAnchorDate, anchorDate],
      scheduleAnchorSource: [plan.scheduleAnchorSource, anchorSource],
      lastCompletionId: [plan.lastCompletionId, lastCompletionId],
    },
  });
}

/** Reopen an occurrence whose completion was just voided (§5.4 steps 3, 6, 7). */
export function reopenAfterVoid(tx: Db, ctx: DomainCtx, occurrenceId: string): void {
  const occ = loadOccurrence(tx, occurrenceId);
  if (isOpen(occ)) {
    throw new ConflictError("occurrence_already_open", `occurrence is ${occ.status}`, {
      status: occ.status,
    });
  }

  if (occ.planId !== null) {
    const successor = openOccurrenceOfPlan(tx, occ.planId);
    if (successor) cancelSuccessor(tx, ctx, successor, "superseded_by_void");
  }

  const reopened = reopenRow(tx, ctx, occ, "completion_voided");
  rearmRecipientStates(tx, ctx, reopened, "reopened");

  if (occ.planId !== null) revertPlanAnchor(tx, ctx, loadPlan(tx, occ.planId), reopened);

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: occ.id,
    kind: "completion_voided",
    fromStatus: occ.status,
    toStatus: reopened.status,
    reason: "completion_voided",
  });
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: occ.id,
    action: "reopened",
    summary: `Reopened "${occ.title}" after its completion was voided`,
  });
}

/** Shared "put this occurrence back into the open world" update. */
function reopenRow(
  tx: Db,
  ctx: DomainCtx,
  occ: OccurrenceRow,
  reason: string,
): OccurrenceRow {
  const now = ctx.clock.now();
  const today = localDateOf(now, ctx.tz);
  const status: OccurrenceStatus = compareLocalDate(occ.dueDate, today) <= 0 ? "due" : "pending";
  tx.update(maintenanceOccurrence)
    .set({
      status,
      completionId: null,
      closedAtMs: null,
      closeReason: null,
      becameDueAtMs: status === "due" ? (occ.becameDueAtMs ?? now) : null,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenanceOccurrence.id, occ.id))
    .run();
  void reason;
  return { ...occ, status, completionId: null, closedAtMs: null, closeReason: null };
}

// ---------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------

/**
 * Move the due date without touching the plan (§3.2). The reminder series is re-anchored to the
 * new date and restarted at index 0; `original_due_date`, `plan.schedule_anchor_date` and
 * `recurrence_json` are all left exactly as they were.
 */
export function postpone(
  tx: Db,
  ctx: DomainCtx,
  occurrenceId: string,
  newDueDate: LocalDate,
  reason?: string,
): void {
  const occ = loadOccurrence(tx, occurrenceId);
  assertOpen(occ);
  if (!isValidLocalDate(newDueDate)) {
    throw new ValidationError("invalid_local_date", `not a LocalDate: ${newDueDate}`);
  }
  const settings = loadHousehold(tx);
  const now = ctx.clock.now();
  const today = localDateOf(now, ctx.tz);
  if (compareLocalDate(newDueDate, today) < 0) {
    throw new ValidationError("postpone_in_past", "a postpone must not move the due date backwards");
  }
  const limit = addDaysLocal(occ.originalDueDate, settings.maxPostponeDays);
  if (compareLocalDate(newDueDate, limit) > 0) {
    throw new ValidationError("postpone_too_far", `a postpone may not go past ${limit}`, { limit });
  }

  const status: OccurrenceStatus = compareLocalDate(newDueDate, today) > 0 ? "pending" : "due";
  tx.update(maintenanceOccurrence)
    .set({
      dueDate: newDueDate,
      status,
      becameDueAtMs: status === "due" ? (occ.becameDueAtMs ?? now) : occ.becameDueAtMs,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenanceOccurrence.id, occ.id))
    .run();

  // The "due now" push is no longer true: clear the phones, then re-anchor the series.
  clearRecipients(tx, ctx, occ.id, "postponed");
  tx.update(notificationRecipientState)
    .set({ anchorDate: newDueDate, nextSlotIndex: 0, updatedAtMs: now })
    .where(
      and(
        eq(notificationRecipientState.occurrenceId, occ.id),
        ne(notificationRecipientState.state, "suppressed"),
      ),
    )
    .run();

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: occ.id,
    kind: "postponed",
    fromStatus: occ.status,
    toStatus: status,
    fromDueDate: occ.dueDate,
    toDueDate: newDueDate,
    reason: reason ?? null,
  });
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: occ.id,
    action: "postponed",
    summary: `Postponed "${occ.title}" from ${occ.dueDate} to ${newDueDate}`,
    changes: { dueDate: [occ.dueDate, newDueDate] },
  });
}

/**
 * Snooze one recipient's reminders until `untilMs`.
 *
 * Deliberately harmless: it writes one recipient state, one reminder slot and one event. It
 * touches no completion, no stock transaction, no due date and no plan (CLAUDE.md rule 6). The
 * new slot keeps the **same** `slot_index`, so after it fires the anchored series resumes at
 * `t(index + 1)`.
 */
export function snooze(
  tx: Db,
  ctx: DomainCtx,
  occurrenceId: string,
  recipientUserId: string,
  untilMs: number,
): void {
  const occ = loadOccurrence(tx, occurrenceId);
  assertOpen(occ);
  const state = tx
    .select()
    .from(notificationRecipientState)
    .where(
      and(
        eq(notificationRecipientState.occurrenceId, occurrenceId),
        eq(notificationRecipientState.recipientUserId, recipientUserId),
      ),
    )
    .all()[0];
  if (!state) {
    throw new NotFoundError("notification_recipient_state", `${occurrenceId}/${recipientUserId}`);
  }
  if (state.state === "cleared" || state.state === "suppressed") {
    throw new ConflictError("recipient_not_active", `recipient state is ${state.state}`);
  }

  const now = ctx.clock.now();
  const open = tx
    .select()
    .from(reminderSlot)
    .where(
      and(
        eq(reminderSlot.recipientStateId, state.id),
        inArray(reminderSlot.state, ["pending", "claimed"]),
      ),
    )
    .all()[0];
  const slotIndex = open?.slotIndex ?? state.nextSlotIndex;

  if (open) {
    tx.update(reminderSlot)
      .set({ state: "snoozed", cancelReason: "snoozed" })
      .where(eq(reminderSlot.id, open.id))
      .run();
  }

  tx.insert(reminderSlot)
    .values({
      id: newId(),
      recipientStateId: state.id,
      slotIndex,
      scheduledAtMs: untilMs,
      scheduledLocalDate: localDateOf(untilMs, ctx.tz),
      state: "pending",
      isSnooze: true,
      nonce: newNonce(),
      createdAtMs: now,
    })
    .run();

  tx.update(notificationRecipientState)
    .set({
      state: "snoozed",
      snoozedUntilMs: untilMs,
      snoozeCount: sql`${notificationRecipientState.snoozeCount} + 1`,
      updatedAtMs: now,
    })
    .where(eq(notificationRecipientState.id, state.id))
    .run();

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId,
    kind: "snoozed",
    detail: { recipientUserId, untilMs, slotIndex },
  });
}

/** 128-bit random hex, stable across retries of the same slot. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Close an occurrence **without** a completion and generate the next one from the *due date*
 * (`schedule_anchor_source='skipped_due_date'`). `plan.last_completion_id` is untouched, so no
 * fake history is ever written.
 */
export function skip(
  tx: Db,
  ctx: DomainCtx,
  occurrenceId: string,
  reason?: string,
): { next: OccurrenceRow | null } {
  const occ = loadOccurrence(tx, occurrenceId);
  assertOpen(occ);
  const now = ctx.clock.now();

  tx.update(maintenanceOccurrence)
    .set({
      status: "skipped",
      closedAtMs: now,
      closeReason: reason ?? "skipped",
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenanceOccurrence.id, occ.id))
    .run();

  clearRecipients(tx, ctx, occ.id, "skipped");

  let next: OccurrenceRow | null = null;
  if (occ.planId !== null) {
    const plan = loadPlan(tx, occ.planId);
    const anchor: Anchor = { date: occ.dueDate, source: "skipped_due_date" };
    tx.update(maintenancePlan)
      .set({
        scheduleAnchorDate: anchor.date,
        scheduleAnchorSource: anchor.source,
        updatedAtMs: now,
        updatedBy: ctx.actorUserId,
      })
      .where(eq(maintenancePlan.id, plan.id))
      .run();
    next = createOccurrenceForPlan(tx, ctx, plan.id, { anchor });
  }

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: occ.id,
    kind: "skipped",
    fromStatus: occ.status,
    toStatus: "skipped",
    reason: reason ?? null,
    detail: { successorOccurrenceId: next?.id ?? null },
  });
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: occ.id,
    action: "skipped",
    summary: `Skipped "${occ.title}" due ${occ.dueDate}${reason ? ` (${reason})` : ""}`,
  });
  return { next };
}

/** Cancel a plan: close its open occurrence, clear both recipients, generate nothing. */
export function cancelPlan(tx: Db, ctx: DomainCtx, planId: string, reason?: string): void {
  const plan = loadPlan(tx, planId);
  if (plan.status === "cancelled") {
    throw new ConflictError("plan_already_cancelled", "the plan is already cancelled");
  }
  const now = ctx.clock.now();
  const open = openOccurrenceOfPlan(tx, planId);
  if (open) {
    tx.update(maintenanceOccurrence)
      .set({
        status: "cancelled",
        closedAtMs: now,
        closeReason: "plan_cancelled",
        updatedAtMs: now,
        updatedBy: ctx.actorUserId,
      })
      .where(eq(maintenanceOccurrence.id, open.id))
      .run();
    clearRecipients(tx, ctx, open.id, "cancelled");
    writeOccurrenceEvent(tx, ctx, {
      occurrenceId: open.id,
      kind: "cancelled",
      fromStatus: open.status,
      toStatus: "cancelled",
      reason: reason ?? "plan_cancelled",
    });
  }

  tx.update(maintenancePlan)
    .set({
      status: "cancelled",
      cancelledAtMs: now,
      cancelReason: reason ?? null,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenancePlan.id, planId))
    .run();
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_plan",
    entityId: planId,
    action: "cancelled",
    summary: `Cancelled plan "${plan.title}"${reason ? ` (${reason})` : ""}`,
  });
}

/**
 * Block an occurrence ("waiting for filters"). A decorator, not a state: the due date and the
 * reminder series are untouched, because blocking is not completing (binding policy 3).
 */
export function block(tx: Db, ctx: DomainCtx, occurrenceId: string, reason: string): void {
  const occ = loadOccurrence(tx, occurrenceId);
  assertOpen(occ);
  if (occ.blockedReason !== null) {
    throw new ConflictError("already_blocked", `already blocked: ${occ.blockedReason}`);
  }
  if (reason.trim() === "") throw new ValidationError("reason_required", "a block needs a reason");
  const now = ctx.clock.now();
  tx.update(maintenanceOccurrence)
    .set({
      blockedReason: reason,
      blockedAtMs: now,
      blockedBy: ctx.actorUserId,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenanceOccurrence.id, occ.id))
    .run();
  writeOccurrenceEvent(tx, ctx, { occurrenceId: occ.id, kind: "blocked", reason });
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: occ.id,
    action: "blocked",
    summary: `Blocked "${occ.title}": ${reason}`,
  });
}

export function unblock(tx: Db, ctx: DomainCtx, occurrenceId: string): void {
  const occ = loadOccurrence(tx, occurrenceId);
  if (occ.blockedReason === null) throw new ConflictError("not_blocked", "the task is not blocked");
  const now = ctx.clock.now();
  tx.update(maintenanceOccurrence)
    .set({
      blockedReason: null,
      blockedAtMs: null,
      blockedBy: null,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenanceOccurrence.id, occ.id))
    .run();
  writeOccurrenceEvent(tx, ctx, { occurrenceId: occ.id, kind: "unblocked" });
}

/**
 * Reopen a skipped or cancelled occurrence inside the reopen window. An untouched successor is
 * cancelled; a successor that has been worked on refuses the reopen (never deleted).
 */
export function reopen(tx: Db, ctx: DomainCtx, occurrenceId: string): void {
  const occ = loadOccurrence(tx, occurrenceId);
  if (occ.status !== "skipped" && occ.status !== "cancelled") {
    throw new ConflictError("not_reopenable", `cannot reopen a ${occ.status} occurrence`, {
      status: occ.status,
    });
  }
  const settings = loadHousehold(tx);
  const now = ctx.clock.now();
  const today = localDateOf(now, ctx.tz);
  if (occ.closedAtMs !== null) {
    const closedDate = localDateOf(occ.closedAtMs, ctx.tz);
    if (compareLocalDate(addDaysLocal(closedDate, settings.reopenWindowDays), today) < 0) {
      throw new ConflictError(
        "reopen_window_expired",
        `closed more than ${settings.reopenWindowDays} days ago`,
        { closedAtMs: occ.closedAtMs },
      );
    }
  }

  if (occ.planId !== null) {
    const successor = openOccurrenceOfPlan(tx, occ.planId);
    if (successor) cancelSuccessor(tx, ctx, successor, "superseded_by_reopen");
  }

  const reopened = reopenRow(tx, ctx, occ, "reopened");
  rearmRecipientStates(tx, ctx, reopened, "reopened");
  if (occ.planId !== null) revertPlanAnchor(tx, ctx, loadPlan(tx, occ.planId), reopened);

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: occ.id,
    kind: "reopened",
    fromStatus: occ.status,
    toStatus: reopened.status,
  });
  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: occ.id,
    action: "reopened",
    summary: `Reopened "${occ.title}" (was ${occ.status})`,
  });
}

// ---------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------

export const SEED_KINDS = [
  "baseline_exact",
  "baseline_approx",
  "user_chosen",
  "start_now",
  "ask_later",
  "install_date",
] as const;
export type SeedKind = (typeof SEED_KINDS)[number];

export interface SeedInput {
  kind: SeedKind;
  date?: LocalDate;
  note?: string;
}

/**
 * Set up a plan's schedule at setup time (§2.4).
 *
 * The structural rule this function exists to enforce: **it writes `schedule_anchor_date`, which
 * is a scheduling input, and never a `completion` row, which is a historical fact.** "Sometime in
 * spring 2024" produces an immediately-overdue first occurrence, which is correct, and no history.
 */
export function seedPlanSchedule(
  tx: Db,
  ctx: DomainCtx,
  planId: string,
  seed: SeedInput,
): OccurrenceRow | null {
  const plan = loadPlan(tx, planId);
  if (plan.status === "cancelled") {
    throw new ConflictError("plan_cancelled", "cannot seed a cancelled plan");
  }
  const rule = parseRecurrenceRule(plan.recurrenceJson);
  const now = ctx.clock.now();
  const today = localDateOf(now, ctx.tz);

  const requireDate = (): LocalDate => {
    if (seed.date === undefined || !isValidLocalDate(seed.date)) {
      throw new ValidationError("seed_date_required", `seed kind ${seed.kind} needs a valid date`);
    }
    return seed.date;
  };

  let anchorDate: LocalDate | null;
  let anchorSource: AnchorSource;
  switch (seed.kind) {
    case "baseline_exact":
      anchorDate = requireDate();
      anchorSource = "baseline_exact";
      break;
    case "baseline_approx":
      anchorDate = requireDate();
      anchorSource = "baseline_approx";
      break;
    case "user_chosen":
      anchorDate = requireDate();
      anchorSource = "user_chosen";
      break;
    case "start_now":
      // Completion-anchored kinds start the clock today; calendar kinds need a lower bound that
      // lets a series date landing *on* today still count, so they use yesterday.
      anchorDate = isCompletionAnchored(rule) ? today : addDaysLocal(today, -1);
      anchorSource = "user_chosen";
      break;
    case "install_date": {
      if (seed.date !== undefined) {
        anchorDate = requireDate();
      } else {
        if (plan.assetId === null) {
          throw new ValidationError("no_asset", "install_date seeding needs a plan with an asset");
        }
        const row = tx.select().from(asset).where(eq(asset.id, plan.assetId)).all()[0];
        if (!row) throw new NotFoundError("asset", plan.assetId);
        if (row.installedOn === null) {
          throw new ValidationError("no_install_date", "the asset has no installed_on date");
        }
        anchorDate = row.installedOn;
      }
      anchorSource = "install_date";
      break;
    }
    case "ask_later":
      anchorDate = null;
      anchorSource = "none";
      break;
  }

  tx.update(maintenancePlan)
    .set({
      scheduleAnchorDate: anchorDate,
      scheduleAnchorSource: anchorSource,
      scheduleAnchorNote: seed.note ?? plan.scheduleAnchorNote,
      status: seed.kind === "ask_later" ? "paused" : plan.status === "paused" ? "active" : plan.status,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenancePlan.id, planId))
    .run();

  writeAuditLog(tx, ctx, {
    entityTable: "maintenance_plan",
    entityId: planId,
    action: seed.kind === "ask_later" ? "plan_needs_baseline" : "schedule_seeded",
    summary:
      seed.kind === "ask_later"
        ? `Plan "${plan.title}" paused until a baseline is provided`
        : `Schedule anchor set to ${anchorDate ?? "none"} (${anchorSource})${seed.note ? ` — ${seed.note}` : ""}`,
    changes: {
      scheduleAnchorDate: [plan.scheduleAnchorDate, anchorDate],
      scheduleAnchorSource: [plan.scheduleAnchorSource, anchorSource],
    },
  });

  if (seed.kind === "ask_later") return null;

  return createOccurrenceForPlan(tx, ctx, planId, {
    anchor: { date: anchorDate, source: anchorSource },
    note: { seedKind: seed.kind, ...(seed.note ? { note: seed.note } : {}) },
  });
}

// ---------------------------------------------------------------------------------------------
// Worker-facing helpers
// ---------------------------------------------------------------------------------------------

/** `pending → due` when the delivery-time instant on the due date has arrived. */
export function isDueNow(occ: OccurrenceRow, settings: HouseholdSettings, now: number): boolean {
  return now >= instantOf(occ.dueDate, settings.deliveryTime, settings.timezone);
}

