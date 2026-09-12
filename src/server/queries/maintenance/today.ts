import "server-only";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { conditionEpisode, conditionRule, conditionSignal, haEntity } from "@/db/schema/ha";
import {
  maintenanceOccurrence,
  maintenancePlan,
  serviceBooking,
  serviceProvider,
} from "@/db/schema/maintenance";
import { notificationRecipientState } from "@/db/schema/notifications";
import { addDaysLocal, type LocalDate } from "@/domain/time";
import type { GroupableTask } from "@/features/maintenance/grouping";
import { UPCOMING_HORIZON_DAYS } from "@/features/maintenance/grouping";
import { resolveTargets, targetOf, type TaskTarget } from "./targets";

/** One row on `/today` (and reused by the plan page's "open work" panel). */
export interface TaskRow extends GroupableTask {
  planId: string | null;
  originalDueDate: LocalDate;
  windowStartDate: LocalDate | null;
  windowEndDate: LocalDate | null;
  title: string;
  estimatedMinutes: number | null;
  target: TaskTarget | null;
  /** `true` when the occurrence's anchor was only approximate — no exact overdue counts (§2.4). */
  approximateAnchor: boolean;
  /** Calendar dates in the series that passed while this stayed open. Never shown as completions. */
  missedSeriesDates: LocalDate[];
  booking: TaskBooking | null;
  /** Reminder state for the person looking at the screen. */
  viewerSnoozedUntilMs: number | null;
  /** Present only on condition-sourced rows. */
  condition: ConditionInfo | null;
  requiresProfessional: boolean;
}

export interface TaskBooking {
  id: string;
  status: "requested" | "confirmed" | "rescheduled" | "cancelled" | "attended" | "no_show";
  providerName: string;
  providerId?: string;
  scheduledStartMs?: number | null;
  scheduledEndMs?: number | null;
  contactNote?: string | null;
  scheduledLocalDate: LocalDate | null;
  windowNote: string | null;
  reference: string | null;
}

export interface ConditionInfo {
  ruleId: string;
  ruleName: string;
  episodeId: string | null;
  /** The reading that opened the episode, and the latest one we have. */
  openedValue: number | null;
  latestValue: number | null;
  /** `false` when the current reading is `unknown`/`unavailable` — never rendered as a number. */
  latestValid: boolean;
  latestObservedAtMs: number | null;
  stale: boolean;
  entityId: string | null;
  /** The episode closed because the reading came back — the task is deliberately still open. */
  recovered: boolean;
  thresholdPct: number | null;
}

/**
 * Every open occurrence up to 30 days out, with everything a row needs.
 *
 * A handful of set-based queries rather than a per-row lookup: Today is the most-loaded page in
 * the app and it renders on every navigation.
 */
export function loadOpenTasks(db: Db, today: LocalDate, viewerId: string): TaskRow[] {
  const horizon = addDaysLocal(today, UPCOMING_HORIZON_DAYS);

  const rows = db
    .select({
      id: maintenanceOccurrence.id,
      planId: maintenanceOccurrence.planId,
      source: maintenanceOccurrence.source,
      title: maintenanceOccurrence.title,
      status: maintenanceOccurrence.status,
      dueDate: maintenanceOccurrence.dueDate,
      originalDueDate: maintenanceOccurrence.originalDueDate,
      windowStartDate: maintenanceOccurrence.windowStartDate,
      windowEndDate: maintenanceOccurrence.windowEndDate,
      priority: maintenanceOccurrence.priority,
      estimatedMinutes: maintenanceOccurrence.estimatedMinutes,
      assignmentMode: maintenanceOccurrence.assignmentMode,
      assigneeUserId: maintenanceOccurrence.assigneeUserId,
      blockedReason: maintenanceOccurrence.blockedReason,
      serviceBookingId: maintenanceOccurrence.serviceBookingId,
      assetId: maintenanceOccurrence.assetId,
      systemId: maintenanceOccurrence.systemId,
      locationId: maintenanceOccurrence.locationId,
      generationNoteJson: maintenanceOccurrence.generationNoteJson,
      conditionRuleId: maintenanceOccurrence.conditionRuleId,
      conditionEpisodeId: maintenanceOccurrence.conditionEpisodeId,
      requiresProfessional: maintenancePlan.requiresProfessional,
    })
    .from(maintenanceOccurrence)
    .leftJoin(maintenancePlan, eq(maintenanceOccurrence.planId, maintenancePlan.id))
    .where(
      and(
        inArray(maintenanceOccurrence.status, ["pending", "due"]),
        // Condition work has no calendar horizon: it is here because a reading crossed a
        // threshold, and hiding it because its due date is 40 days out would be wrong.
        or(
          lte(maintenanceOccurrence.dueDate, horizon),
          eq(maintenanceOccurrence.source, "condition"),
        ),
      ),
    )
    .orderBy(asc(maintenanceOccurrence.dueDate))
    .all();

  if (rows.length === 0) return [];

  const targets = resolveTargets(db, rows);
  const bookings = loadBookings(
    db,
    rows.map((row) => row.serviceBookingId).filter((id): id is string => id !== null),
  );
  const conditions = loadConditionInfo(db, rows);
  const snoozes = loadViewerSnoozes(
    db,
    rows.map((row) => row.id),
    viewerId,
  );

  return rows.map((row) => {
    const note = readGenerationNote(row.generationNoteJson);
    return {
      id: row.id,
      planId: row.planId,
      source: row.source,
      title: row.title,
      status: row.status,
      dueDate: row.dueDate,
      originalDueDate: row.originalDueDate,
      windowStartDate: row.windowStartDate,
      windowEndDate: row.windowEndDate,
      priority: row.priority,
      estimatedMinutes: row.estimatedMinutes,
      assignmentMode: row.assignmentMode,
      assigneeUserId: row.assigneeUserId,
      blockedReason: row.blockedReason,
      serviceBookingId: row.serviceBookingId,
      target: targetOf(targets, row),
      approximateAnchor: note.anchorPrecision === "approx" || note.anchorSource === "baseline_approx",
      missedSeriesDates: note.missedSeriesDates ?? [],
      booking: row.serviceBookingId === null ? null : (bookings.get(row.serviceBookingId) ?? null),
      viewerSnoozedUntilMs: snoozes.get(row.id) ?? null,
      condition: conditions.get(row.id) ?? null,
      requiresProfessional: row.requiresProfessional ?? false,
    } satisfies TaskRow;
  });
}

interface GenerationNote {
  missedSeriesDates?: LocalDate[];
  anchorSource?: string;
  anchorPrecision?: "exact" | "approx";
}

/** `generation_note_json` is written by the domain; a corrupt one must not break the page. */
export function readGenerationNote(json: string | null): GenerationNote {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as GenerationNote) : {};
  } catch {
    return {};
  }
}

export function loadBookings(db: Db, ids: readonly string[]): Map<string, TaskBooking> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({
      id: serviceBooking.id,
      status: serviceBooking.status,
      scheduledLocalDate: serviceBooking.scheduledLocalDate,
      windowNote: serviceBooking.windowNote,
      reference: serviceBooking.reference,
      providerName: serviceProvider.name,
      providerId: serviceBooking.providerId,
      scheduledStartMs: serviceBooking.scheduledStartMs,
      scheduledEndMs: serviceBooking.scheduledEndMs,
      contactNote: serviceBooking.contactNote,
    })
    .from(serviceBooking)
    .innerJoin(serviceProvider, eq(serviceBooking.providerId, serviceProvider.id))
    .where(inArray(serviceBooking.id, [...ids]))
    .all();
  return new Map(rows.map((row) => [row.id, row]));
}

interface ConditionSourceRow {
  id: string;
  conditionRuleId: string | null;
  conditionEpisodeId: string | null;
}

/**
 * Battery (and other condition) context for condition-sourced rows.
 *
 * `condition_signal.is_valid = 0` means `unknown`/`unavailable`, which is never a value and never
 * a zero (CLAUDE.md rule 8) — hence `latestValid` rather than a nullable number the UI could
 * accidentally format as `0 %`.
 */
export function loadConditionInfo(
  db: Db,
  rows: readonly ConditionSourceRow[],
): Map<string, ConditionInfo> {
  const ruleIds = [
    ...new Set(rows.map((row) => row.conditionRuleId).filter((id): id is string => id !== null)),
  ];
  if (ruleIds.length === 0) return new Map();

  const rules = db
    .select({
      id: conditionRule.id,
      name: conditionRule.name,
      haEntityRegistryId: conditionRule.haEntityRegistryId,
      thresholdPct: conditionRule.thresholdPct,
    })
    .from(conditionRule)
    .where(inArray(conditionRule.id, ruleIds))
    .all();
  const ruleById = new Map(rules.map((row) => [row.id, row]));

  const occurrenceIds = rows.map((row) => row.id);
  const episodes = db
    .select({
      id: conditionEpisode.id,
      occurrenceId: conditionEpisode.occurrenceId,
      ruleId: conditionEpisode.ruleId,
      haEntityRegistryId: conditionEpisode.haEntityRegistryId,
      openedValue: conditionEpisode.openedValue,
      closedAtMs: conditionEpisode.closedAtMs,
      closeReason: conditionEpisode.closeReason,
    })
    .from(conditionEpisode)
    .where(inArray(conditionEpisode.occurrenceId, occurrenceIds))
    .orderBy(desc(conditionEpisode.openedAtMs))
    .all();
  const episodeByOccurrence = new Map<string, (typeof episodes)[number]>();
  for (const episode of episodes) {
    if (episode.occurrenceId !== null && !episodeByOccurrence.has(episode.occurrenceId)) {
      episodeByOccurrence.set(episode.occurrenceId, episode);
    }
  }

  const entityIds = [
    ...new Set(
      [
        ...rules.map((row) => row.haEntityRegistryId),
        ...episodes.map((row) => row.haEntityRegistryId),
      ].filter((id): id is string => id !== null),
    ),
  ];
  const signals =
    entityIds.length === 0
      ? []
      : db
          .select({
            registryId: conditionSignal.haEntityRegistryId,
            numericValue: conditionSignal.numericValue,
            isValid: conditionSignal.isValid,
            observedAtMs: conditionSignal.observedAtMs,
            isStale: conditionSignal.isStale,
            entityId: haEntity.entityId,
          })
          .from(conditionSignal)
          .leftJoin(haEntity, eq(conditionSignal.haEntityRegistryId, haEntity.registryId))
          .where(inArray(conditionSignal.haEntityRegistryId, entityIds))
          .all();
  const signalById = new Map(signals.map((row) => [row.registryId, row]));

  const out = new Map<string, ConditionInfo>();
  for (const row of rows) {
    if (row.conditionRuleId === null) continue;
    const rule = ruleById.get(row.conditionRuleId);
    if (!rule) continue;
    const episode = episodeByOccurrence.get(row.id) ?? null;
    const registryId = episode?.haEntityRegistryId ?? rule.haEntityRegistryId ?? null;
    const signal = registryId === null ? undefined : signalById.get(registryId);
    out.set(row.id, {
      ruleId: rule.id,
      ruleName: rule.name,
      episodeId: episode?.id ?? null,
      openedValue: episode?.openedValue ?? null,
      latestValue: signal?.isValid ? (signal.numericValue ?? null) : null,
      latestValid: signal?.isValid ?? false,
      latestObservedAtMs: signal?.observedAtMs ?? null,
      stale: signal?.isStale ?? false,
      entityId: signal?.entityId ?? null,
      recovered: episode?.closedAtMs !== null && episode?.closeReason === "recovered",
      thresholdPct: rule.thresholdPct,
    });
  }
  return out;
}

/** `snoozed_until_ms` for the viewer, per occurrence — a snooze is per person by design. */
export function loadViewerSnoozes(
  db: Db,
  occurrenceIds: readonly string[],
  viewerId: string,
): Map<string, number> {
  if (occurrenceIds.length === 0) return new Map();
  const rows = db
    .select({
      occurrenceId: notificationRecipientState.occurrenceId,
      snoozedUntilMs: notificationRecipientState.snoozedUntilMs,
      state: notificationRecipientState.state,
    })
    .from(notificationRecipientState)
    .where(
      and(
        inArray(notificationRecipientState.occurrenceId, [...occurrenceIds]),
        eq(notificationRecipientState.recipientUserId, viewerId),
        eq(notificationRecipientState.state, "snoozed"),
      ),
    )
    .all();
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.snoozedUntilMs !== null) out.set(row.occurrenceId, row.snoozedUntilMs);
  }
  return out;
}

export interface PlanNeedingSetup {
  id: string;
  title: string;
  ruleJson: string;
  target: TaskTarget | null;
}

/**
 * Plans that were saved with "ask me later" (§2.4): paused, no anchor, and generating nothing
 * until someone answers the question.
 */
export function loadPlansNeedingSetup(db: Db): PlanNeedingSetup[] {
  const rows = db
    .select({
      id: maintenancePlan.id,
      title: maintenancePlan.title,
      recurrenceJson: maintenancePlan.recurrenceJson,
      assetId: maintenancePlan.assetId,
      systemId: maintenancePlan.systemId,
      locationId: maintenancePlan.locationId,
    })
    .from(maintenancePlan)
    .where(
      and(
        eq(maintenancePlan.scheduleAnchorSource, "none"),
        isNull(maintenancePlan.scheduleAnchorDate),
        inArray(maintenancePlan.status, ["active", "paused"]),
      ),
    )
    .orderBy(asc(maintenancePlan.title))
    .all();
  if (rows.length === 0) return [];
  const targets = resolveTargets(db, rows);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    ruleJson: row.recurrenceJson,
    target: targetOf(targets, row),
  }));
}
