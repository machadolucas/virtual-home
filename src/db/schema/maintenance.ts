/**
 * M4 — maintenance plans, the occurrences they generate, guided-procedure progress, completions
 * and their material lines, plus professional providers, bookings and documents.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.7, §3, §5.
 *
 * The two rules that shape this module (CLAUDE.md rule 6):
 *  - a plan's **schedule anchor** is scheduling input, never a claim that work happened; the
 *    factual history pointer is `last_completion_id`;
 *  - a booking is not a completion, and attendance is not a completion — a `completion` row is
 *    always required.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { actor, auditQuad, exactlyOne, nonNegative, oneOf, positive } from "./columns";
import { user } from "./auth";
import { asset, system } from "./assets";
import { attachment } from "./attachments";
import { conditionEpisode, conditionRule } from "./ha";
import { AUDIT_ACTOR_KINDS, type AuditActorKind } from "./household";
import { part, partLot, stockTransaction } from "./inventory";
import { location } from "./model";
import { procedure, procedureChecklistItem, procedureStep, procedureVersion } from "./procedures";

export const SCHEDULE_KINDS = [
  "interval_from_completion",
  "fixed_calendar",
  "seasonal_window",
  "one_off",
  "condition",
] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const SCHEDULE_ANCHOR_SOURCES = [
  "completion",
  "baseline_exact",
  "baseline_approx",
  "user_chosen",
  "skipped_due_date",
  "install_date",
  "none",
] as const;
export type ScheduleAnchorSource = (typeof SCHEDULE_ANCHOR_SOURCES)[number];

export const ASSIGNMENT_MODES = ["user", "shared"] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PLAN_STATUSES = ["active", "paused", "cancelled"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** A recurring (or one-off) maintenance obligation against exactly one target. */
export const maintenancePlan = sqliteTable(
  "maintenance_plan",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    assetId: text("asset_id").references(() => asset.id, { onDelete: "restrict" }),
    systemId: text("system_id").references(() => system.id, { onDelete: "restrict" }),
    locationId: text("location_id").references(() => location.id, { onDelete: "restrict" }),
    procedureId: text("procedure_id").references(() => procedure.id, { onDelete: "set null" }),
    /** NULL = resolve the procedure's current published version at generation time. */
    pinProcedureVersionId: text("pin_procedure_version_id").references(() => procedureVersion.id, {
      onDelete: "set null",
    }),
    scheduleKind: text("schedule_kind").$type<ScheduleKind>().notNull(),
    /** The recurrence rule (§2); `'{"v":1,"kind":"one_off"}'` for one-offs. */
    recurrenceJson: text("recurrence_json").notNull(),
    /** LocalDate input to `computeNextDue`. **Not** a claim that work happened. */
    scheduleAnchorDate: text("schedule_anchor_date"),
    scheduleAnchorSource: text("schedule_anchor_source")
      .$type<ScheduleAnchorSource>()
      .notNull()
      .default("none"),
    scheduleAnchorNote: text("schedule_anchor_note"),
    /** The factual history pointer — set only by a real completion. */
    lastCompletionId: text("last_completion_id").references((): AnySQLiteColumn => completion.id, {
      onDelete: "set null",
    }),
    assignmentMode: text("assignment_mode").$type<AssignmentMode>().notNull(),
    assigneeUserId: text("assignee_user_id").references(() => user.id, { onDelete: "restrict" }),
    priority: text("priority").$type<Priority>().notNull().default("normal"),
    estimatedMinutes: integer("estimated_minutes"),
    requiresProfessional: integer("requires_professional", { mode: "boolean" })
      .notNull()
      .default(false),
    defaultProviderId: text("default_provider_id").references(
      (): AnySQLiteColumn => serviceProvider.id,
      { onDelete: "set null" },
    ),
    status: text("status").$type<PlanStatus>().notNull().default("active"),
    cancelledAtMs: integer("cancelled_at_ms"),
    cancelReason: text("cancel_reason"),
    /** Cached (§4.6); recomputed on plan/procedure/material change. */
    allowQuickDone: integer("allow_quick_done", { mode: "boolean" }).notNull().default(false),
    ...auditQuad(),
  },
  (t) => [
    check("ck_plan_schedule_kind", oneOf("schedule_kind", SCHEDULE_KINDS)),
    check("ck_plan_anchor_source", oneOf("schedule_anchor_source", SCHEDULE_ANCHOR_SOURCES)),
    check("ck_plan_assignment_mode", oneOf("assignment_mode", ASSIGNMENT_MODES)),
    check("ck_plan_priority", oneOf("priority", PRIORITIES)),
    check("ck_plan_status", oneOf("status", PLAN_STATUSES)),
    check("ck_plan_one_target", exactlyOne("asset_id", "system_id", "location_id")),
    check(
      "ck_plan_assignee",
      sql`(assignment_mode = 'user') = (assignee_user_id IS NOT NULL)`,
    ),
    check(
      "ck_plan_estimated_minutes",
      sql`estimated_minutes IS NULL OR estimated_minutes > 0`,
    ),
    index("ix_plan_status").on(t.status),
    index("ix_plan_asset").on(t.assetId),
    index("ix_plan_system").on(t.systemId),
    index("ix_plan_location").on(t.locationId),
    index("ix_plan_schedule_kind").on(t.scheduleKind),
    index("ix_plan_assignee").on(t.assigneeUserId),
  ],
);

/**
 * Plan-level expected materials. Resolution order for a completion is
 * `plan_material` ∪ `procedure_material` (plan wins on a conflicting `part_id`) ∪
 * `asset_consumable` for the roles the procedure declares.
 */
export const planMaterial = sqliteTable(
  "plan_material",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => maintenancePlan.id, { onDelete: "cascade" }),
    partId: text("part_id")
      .notNull()
      .references(() => part.id, { onDelete: "restrict" }),
    qtyMilli: integer("qty_milli").notNull(),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(true),
    notes: text("notes"),
  },
  (t) => [
    check("ck_plan_material_qty", positive("qty_milli")),
    uniqueIndex("ux_plan_material").on(t.planId, t.partId),
    index("ix_plan_material_part").on(t.partId),
  ],
);

export const OCCURRENCE_SOURCES = ["plan", "manual", "condition"] as const;
export type OccurrenceSource = (typeof OCCURRENCE_SOURCES)[number];

export const OCCURRENCE_STATUSES = [
  "pending",
  "due",
  "completed",
  "skipped",
  "cancelled",
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** Open (i.e. not yet closed) occurrence statuses — the predicate of the partial unique indexes. */
export const OCCURRENCE_OPEN_STATUSES = ["pending", "due"] as const;

/**
 * The unit of work and the unit of notification. Snapshots the plan's fields at generation time,
 * so editing a plan never rewrites open work.
 *
 * Load-bearing invariants, enforced by partial unique indexes (not by code):
 *  - `ux_occ_open_per_plan` — at most one open occurrence per plan, ever;
 *  - `ux_occ_open_per_condition` — at most one open occurrence per (condition rule, asset), using
 *    the VIRTUAL generated `condition_rule_key` so the predicate can be composite.
 */
export const maintenanceOccurrence = sqliteTable(
  "maintenance_occurrence",
  {
    id: text("id").primaryKey(),
    /** NULL for ad-hoc work. */
    planId: text("plan_id").references(() => maintenancePlan.id, { onDelete: "restrict" }),
    source: text("source").$type<OccurrenceSource>().notNull(),
    conditionRuleId: text("condition_rule_id").references(() => conditionRule.id, {
      onDelete: "restrict",
    }),
    // Annotated because `condition_episode.occurrence_id` points back here.
    conditionEpisodeId: text("condition_episode_id").references(
      (): AnySQLiteColumn => conditionEpisode.id,
      { onDelete: "set null" },
    ),
    /** Snapshot of the plan's target at generation time. */
    assetId: text("asset_id").references(() => asset.id, { onDelete: "restrict" }),
    systemId: text("system_id").references(() => system.id, { onDelete: "restrict" }),
    locationId: text("location_id").references(() => location.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    /** Resolved at generation and frozen for the occurrence. */
    procedureVersionId: text("procedure_version_id").references(() => procedureVersion.id, {
      onDelete: "restrict",
    }),
    status: text("status").$type<OccurrenceStatus>().notNull().default("pending"),
    /** LocalDate. */
    dueDate: text("due_date").notNull(),
    /** LocalDate that never changes — the honest record of when this was first due. */
    originalDueDate: text("original_due_date").notNull(),
    windowStartDate: text("window_start_date"),
    windowEndDate: text("window_end_date"),
    /** `{"missedSeriesDates":["2026-10-01"],"anchorSource":"completion"}` */
    generationNoteJson: text("generation_note_json"),
    assignmentMode: text("assignment_mode").$type<AssignmentMode>().notNull(),
    assigneeUserId: text("assignee_user_id").references(() => user.id, { onDelete: "restrict" }),
    priority: text("priority").$type<Priority>().notNull().default("normal"),
    estimatedMinutes: integer("estimated_minutes"),
    /** Non-NULL ⇒ blocked. */
    blockedReason: text("blocked_reason"),
    blockedAtMs: integer("blocked_at_ms"),
    blockedBy: actor("blocked_by"),
    /** Non-NULL ⇒ a professional is booked. Still not a completion. */
    serviceBookingId: text("service_booking_id").references(
      (): AnySQLiteColumn => serviceBooking.id,
      { onDelete: "set null" },
    ),
    becameDueAtMs: integer("became_due_at_ms"),
    completionId: text("completion_id").references((): AnySQLiteColumn => completion.id, {
      onDelete: "restrict",
    }),
    closedAtMs: integer("closed_at_ms"),
    closeReason: text("close_reason"),
    /**
     * `condition_rule_id || ':' || coalesce(asset_id, '')` — exists purely so
     * `ux_occ_open_per_condition` can be a composite partial unique index. VIRTUAL: computed on
     * read, no storage, no migration cost.
     */
    conditionRuleKey: text("condition_rule_key").generatedAlwaysAs(
      sql`(condition_rule_id || ':' || coalesce(asset_id, ''))`,
      { mode: "virtual" },
    ),
    ...auditQuad(),
  },
  (t) => [
    check("ck_occ_source", oneOf("source", OCCURRENCE_SOURCES)),
    check("ck_occ_status", oneOf("status", OCCURRENCE_STATUSES)),
    check("ck_occ_assignment_mode", oneOf("assignment_mode", ASSIGNMENT_MODES)),
    check("ck_occ_priority", oneOf("priority", PRIORITIES)),
    check("ck_occ_completion", sql`(status = 'completed') = (completion_id IS NOT NULL)`),
    check(
      "ck_occ_closed",
      sql`(status IN ('completed', 'skipped', 'cancelled')) = (closed_at_ms IS NOT NULL)`,
    ),
    check(
      "ck_occ_window",
      sql`window_end_date IS NULL OR window_start_date IS NOT NULL`,
    ),
    check(
      "ck_occ_condition_rule",
      sql`(source = 'condition') = (condition_rule_id IS NOT NULL)`,
    ),
    uniqueIndex("ux_occ_open_per_plan")
      .on(t.planId)
      .where(sql`plan_id IS NOT NULL AND status IN ('pending', 'due')`),
    uniqueIndex("ux_occ_open_per_condition")
      .on(t.conditionRuleKey)
      .where(sql`source = 'condition' AND status IN ('pending', 'due')`),
    index("ix_occ_status_due").on(t.status, t.dueDate),
    index("ix_occ_asset").on(t.assetId, t.status),
    index("ix_occ_assignee").on(t.assigneeUserId, t.status, t.dueDate),
    index("ix_occ_episode").on(t.conditionEpisodeId),
  ],
);

export const PROGRESS_ITEM_KINDS = ["step", "checklist"] as const;
export type ProgressItemKind = (typeof PROGRESS_ITEM_KINDS)[number];

export const PROGRESS_STATES = ["todo", "in_progress", "done", "skipped"] as const;
export type ProgressState = (typeof PROGRESS_STATES)[number];

/**
 * Resumable guided-procedure progress. Rows are created lazily on first interaction, survive
 * navigation and process restart, and are retained after completion as part of the record.
 */
export const occurrenceProgressItem = sqliteTable(
  "occurrence_progress_item",
  {
    id: text("id").primaryKey(),
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => maintenanceOccurrence.id, { onDelete: "cascade" }),
    itemKind: text("item_kind").$type<ProgressItemKind>().notNull(),
    stepId: text("step_id").references(() => procedureStep.id, { onDelete: "set null" }),
    checklistItemId: text("checklist_item_id").references(() => procedureChecklistItem.id, {
      onDelete: "set null",
    }),
    state: text("state").$type<ProgressState>().notNull().default("todo"),
    valueText: text("value_text"),
    valueNumber: real("value_number"),
    attachmentId: text("attachment_id").references(() => attachment.id, { onDelete: "set null" }),
    changedAtMs: integer("changed_at_ms").notNull(),
    changedBy: actor("changed_by"),
  },
  (t) => [
    check("ck_progress_item_kind", oneOf("item_kind", PROGRESS_ITEM_KINDS)),
    check("ck_progress_state", oneOf("state", PROGRESS_STATES)),
    uniqueIndex("ux_progress_item").on(t.occurrenceId, t.itemKind, t.stepId, t.checklistItemId),
  ],
);

export const OCCURRENCE_EVENT_KINDS = [
  "created",
  "became_due",
  "completed",
  "completion_voided",
  "postponed",
  "snoozed",
  "skipped",
  "cancelled",
  "blocked",
  "unblocked",
  "booked",
  "booking_cancelled",
  "reopened",
  "notified",
  "condition_recovered",
  "materials_reconciled",
] as const;
export type OccurrenceEventKind = (typeof OCCURRENCE_EVENT_KINDS)[number];

/** Typed domain timeline that drives the UI; `audit_log` stays generic. Append-only. */
export const occurrenceEvent = sqliteTable(
  "occurrence_event",
  {
    id: text("id").primaryKey(),
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => maintenanceOccurrence.id, { onDelete: "cascade" }),
    atMs: integer("at_ms").notNull(),
    actorKind: text("actor_kind").$type<AuditActorKind>().notNull(),
    actorUserId: actor("actor_user_id"),
    kind: text("kind").$type<OccurrenceEventKind>().notNull(),
    fromStatus: text("from_status").$type<OccurrenceStatus>(),
    toStatus: text("to_status").$type<OccurrenceStatus>(),
    fromDueDate: text("from_due_date"),
    toDueDate: text("to_due_date"),
    reason: text("reason"),
    detailJson: text("detail_json"),
  },
  (t) => [
    check("ck_occurrence_event_kind", oneOf("kind", OCCURRENCE_EVENT_KINDS)),
    check("ck_occurrence_event_actor_kind", oneOf("actor_kind", AUDIT_ACTOR_KINDS)),
    index("ix_occurrence_event").on(t.occurrenceId, t.atMs),
  ],
);

export const COMPLETION_PRECISIONS = ["exact", "day", "month"] as const;
export type CompletionPrecision = (typeof COMPLETION_PRECISIONS)[number];

export const COMPLETION_OUTCOMES = ["done", "done_with_issues", "partial"] as const;
export type CompletionOutcome = (typeof COMPLETION_OUTCOMES)[number];

export const STOCK_RESOLUTIONS = [
  "none",
  "sufficient",
  "adjusted_up",
  "consumed_available",
  "discrepancy_noted",
] as const;
export type StockResolution = (typeof STOCK_RESOLUTIONS)[number];

export const COMPLETION_SOURCES = ["web", "notification_action", "import"] as const;
export type CompletionSource = (typeof COMPLETION_SOURCES)[number];

/**
 * The factual record that work happened. `request_id` is the client-generated idempotency key, so
 * a double-tap or a retried notification action produces one completion.
 */
export const completion = sqliteTable(
  "completion",
  {
    id: text("id").primaryKey(),
    /** Client-generated `completionRequestId`. */
    requestId: text("request_id").notNull(),
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => maintenanceOccurrence.id, { onDelete: "restrict" }),
    planId: text("plan_id").references(() => maintenancePlan.id, { onDelete: "set null" }),
    /** Snapshot — history stays on the unit serviced and survives replacement. */
    assetId: text("asset_id").references(() => asset.id, { onDelete: "restrict" }),
    procedureVersionId: text("procedure_version_id").references(() => procedureVersion.id, {
      onDelete: "restrict",
    }),
    /** May be in the past. */
    completedAtMs: integer("completed_at_ms").notNull(),
    /** LocalDate in the household time zone — this is the scheduling anchor. */
    completedLocalDate: text("completed_local_date").notNull(),
    completedAtPrecision: text("completed_at_precision")
      .$type<CompletionPrecision>()
      .notNull()
      .default("exact"),
    /** NULL when a professional did the work. */
    performedByUserId: text("performed_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    performedByProviderId: text("performed_by_provider_id").references(
      (): AnySQLiteColumn => serviceProvider.id,
      { onDelete: "restrict" },
    ),
    /** Who typed it in. */
    recordedBy: text("recorded_by").references(() => user.id, { onDelete: "restrict" }),
    notes: text("notes"),
    effortMinutes: integer("effort_minutes"),
    outcome: text("outcome").$type<CompletionOutcome>().notNull().default("done"),
    stockResolution: text("stock_resolution").$type<StockResolution>().notNull().default("none"),
    isReplacement: integer("is_replacement", { mode: "boolean" }).notNull().default(false),
    voidedAtMs: integer("voided_at_ms"),
    voidedBy: actor("voided_by"),
    voidReason: text("void_reason"),
    source: text("source").$type<CompletionSource>().notNull().default("web"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_completion_precision", oneOf("completed_at_precision", COMPLETION_PRECISIONS)),
    check("ck_completion_outcome", oneOf("outcome", COMPLETION_OUTCOMES)),
    check("ck_completion_stock_resolution", oneOf("stock_resolution", STOCK_RESOLUTIONS)),
    check("ck_completion_source", oneOf("source", COMPLETION_SOURCES)),
    check(
      "ck_completion_performer",
      sql`performed_by_user_id IS NOT NULL OR performed_by_provider_id IS NOT NULL`,
    ),
    check("ck_completion_effort", sql`effort_minutes IS NULL OR effort_minutes >= 0`),
    uniqueIndex("ux_completion_request").on(t.requestId),
    // At most one live (non-voided) completion per occurrence.
    uniqueIndex("ux_completion_live_per_occurrence")
      .on(t.occurrenceId)
      .where(sql`voided_at_ms IS NULL`),
    index("ix_completion_occurrence").on(t.occurrenceId),
    index("ix_completion_asset").on(t.assetId, t.completedLocalDate),
    index("ix_completion_plan").on(t.planId, t.completedLocalDate),
  ],
);

export const MATERIAL_RESOLUTIONS = [
  "sufficient",
  "adjusted_up",
  "consumed_available",
  "discrepancy_noted",
] as const;
export type MaterialResolution = (typeof MATERIAL_RESOLUTIONS)[number];

export const completionMaterial = sqliteTable(
  "completion_material",
  {
    id: text("id").primaryKey(),
    completionId: text("completion_id")
      .notNull()
      .references(() => completion.id, { onDelete: "cascade" }),
    partId: text("part_id")
      .notNull()
      .references(() => part.id, { onDelete: "restrict" }),
    lotId: text("lot_id").references(() => partLot.id, { onDelete: "set null" }),
    expectedQtyMilli: integer("expected_qty_milli"),
    actualQtyMilli: integer("actual_qty_milli").notNull(),
    shortfallMilli: integer("shortfall_milli").notNull().default(0),
    resolution: text("resolution").$type<MaterialResolution>().notNull(),
    stockTransactionId: text("stock_transaction_id").references(() => stockTransaction.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
  },
  (t) => [
    check("ck_completion_material_resolution", oneOf("resolution", MATERIAL_RESOLUTIONS)),
    check("ck_completion_material_actual", nonNegative("actual_qty_milli")),
    check("ck_completion_material_shortfall", nonNegative("shortfall_milli")),
    check(
      "ck_completion_material_expected",
      sql`expected_qty_milli IS NULL OR expected_qty_milli >= 0`,
    ),
    uniqueIndex("ux_completion_material").on(t.completionId, t.partId, t.lotId),
    index("ix_completion_material_part").on(t.partId),
  ],
);

export const serviceProvider = sqliteTable(
  "service_provider",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** `'plumbing'`, `'hvac'`, `'electrical'`, `'chimney'`, … — free text on purpose. */
    trade: text("trade"),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    website: text("website"),
    address: text("address"),
    vatId: text("vat_id"),
    notes: text("notes"),
    isPreferred: integer("is_preferred", { mode: "boolean" }).notNull().default(false),
    ...auditQuad(),
  },
  (t) => [index("ix_service_provider_trade").on(t.trade)],
);

export const BOOKING_STATUSES = [
  "requested",
  "confirmed",
  "rescheduled",
  "cancelled",
  "attended",
  "no_show",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** A booking is its own record with its own status. Creating or attending one never completes work. */
export const serviceBooking = sqliteTable(
  "service_booking",
  {
    id: text("id").primaryKey(),
    occurrenceId: text("occurrence_id").references(() => maintenanceOccurrence.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id")
      .notNull()
      .references(() => serviceProvider.id, { onDelete: "restrict" }),
    status: text("status").$type<BookingStatus>().notNull().default("requested"),
    requestedAtMs: integer("requested_at_ms").notNull(),
    scheduledStartMs: integer("scheduled_start_ms"),
    scheduledEndMs: integer("scheduled_end_ms"),
    /** LocalDate, for the calendar view. */
    scheduledLocalDate: text("scheduled_local_date"),
    /** "between 8 and 12" */
    windowNote: text("window_note"),
    /** The provider's own booking reference. */
    reference: text("reference"),
    quotedPriceCents: integer("quoted_price_cents"),
    currency: text("currency").default("EUR"),
    contactNote: text("contact_note"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_service_booking_status", oneOf("status", BOOKING_STATUSES)),
    check(
      "ck_service_booking_window",
      sql`scheduled_end_ms IS NULL OR (scheduled_start_ms IS NOT NULL AND scheduled_end_ms >= scheduled_start_ms)`,
    ),
    check(
      "ck_service_booking_price",
      sql`quoted_price_cents IS NULL OR quoted_price_cents >= 0`,
    ),
    index("ix_service_booking_occurrence").on(t.occurrenceId),
    index("ix_service_booking_start").on(t.scheduledStartMs),
  ],
);

export const SERVICE_DOCUMENT_KINDS = [
  "quote",
  "invoice",
  "receipt",
  "certificate",
  "report",
  "warranty",
] as const;
export type ServiceDocumentKind = (typeof SERVICE_DOCUMENT_KINDS)[number];

export const serviceDocument = sqliteTable(
  "service_document",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ServiceDocumentKind>().notNull(),
    providerId: text("provider_id").references(() => serviceProvider.id, { onDelete: "set null" }),
    bookingId: text("booking_id").references(() => serviceBooking.id, { onDelete: "set null" }),
    completionId: text("completion_id").references(() => completion.id, { onDelete: "set null" }),
    assetId: text("asset_id").references(() => asset.id, { onDelete: "set null" }),
    documentNo: text("document_no"),
    /** LocalDate. */
    issuedOn: text("issued_on"),
    validUntil: text("valid_until"),
    amountCents: integer("amount_cents"),
    currency: text("currency").default("EUR"),
    attachmentId: text("attachment_id").references(() => attachment.id, { onDelete: "set null" }),
    notes: text("notes"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_service_document_kind", oneOf("kind", SERVICE_DOCUMENT_KINDS)),
    check(
      "ck_service_document_target",
      sql`booking_id IS NOT NULL OR completion_id IS NOT NULL OR asset_id IS NOT NULL`,
    ),
    index("ix_service_document_provider").on(t.providerId),
    index("ix_service_document_completion").on(t.completionId),
    index("ix_service_document_asset").on(t.assetId),
  ],
);
