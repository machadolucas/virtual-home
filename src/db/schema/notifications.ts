/**
 * M8 — the notification engine's state, the transport outbox, the inbound-action replay guard, and
 * worker leases/heartbeats.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §4.1.
 *
 * CLAUDE.md rule 9: notifications are idempotent by design (stable tags, per-slot nonces,
 * `completion.request_id`) and we record `sent` — the instant HA *accepted* the service call —
 * never `delivered`.
 *
 * Two partial unique indexes carry the concurrency guarantees:
 *  - `ux_slot_one_open` — at most one non-terminal slot per recipient state, so a restart or a
 *    second worker physically has no second row to claim;
 *  - `ux_action_replay` — the second accepted `(nonce, action)` insert fails, and the handler turns
 *    that failure into `validation = 'duplicate'` + `applied_effect = 'noop'`.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { nonNegative, oneOf } from "./columns";
import { user } from "./auth";
import { completion, maintenanceOccurrence } from "./maintenance";

export const RECIPIENT_STATES = ["active", "snoozed", "cleared", "suppressed"] as const;
export type RecipientState = (typeof RECIPIENT_STATES)[number];

export const CLEAR_REASONS = [
  "completed",
  "skipped",
  "cancelled",
  "postponed",
  "reopened",
] as const;
export type ClearReason = (typeof CLEAR_REASONS)[number];

/** One row per (occurrence, recipient). The tag is stable, which is what makes clears idempotent. */
export const notificationRecipientState = sqliteTable(
  "notification_recipient_state",
  {
    id: text("id").primaryKey(),
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => maintenanceOccurrence.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** `'vh:occ:' || occurrence_id || ':' || recipient_user_id` */
    tag: text("tag").notNull(),
    /** LocalDate slot-series origin; equals `occurrence.due_date`, updated on postpone. */
    anchorDate: text("anchor_date").notNull(),
    state: text("state").$type<RecipientState>().notNull().default("active"),
    /** Index of the single pending slot. */
    nextSlotIndex: integer("next_slot_index").notNull().default(0),
    snoozedUntilMs: integer("snoozed_until_ms"),
    snoozeCount: integer("snooze_count").notNull().default(0),
    lastSentAtMs: integer("last_sent_at_ms"),
    lastSentSlotIndex: integer("last_sent_slot_index"),
    /** First observed HA action for this occurrence+recipient — our only proxy for "delivered". */
    interactedAtMs: integer("interacted_at_ms"),
    clearedAtMs: integer("cleared_at_ms"),
    clearReason: text("clear_reason").$type<ClearReason>(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    check("ck_recipient_state_state", oneOf("state", RECIPIENT_STATES)),
    check("ck_recipient_state_clear_reason", oneOf("clear_reason", CLEAR_REASONS)),
    check("ck_recipient_state_next_slot", nonNegative("next_slot_index")),
    check("ck_recipient_state_snooze_count", nonNegative("snooze_count")),
    check("ck_recipient_state_cleared", sql`(state = 'cleared') = (cleared_at_ms IS NOT NULL)`),
    uniqueIndex("ux_recipient_state_occurrence").on(t.occurrenceId, t.recipientUserId),
    uniqueIndex("ux_recipient_state_tag").on(t.tag),
    index("ix_recipient_state_state").on(t.state, t.occurrenceId),
    index("ix_recipient_state_user").on(t.recipientUserId, t.state),
  ],
);

export const SLOT_STATES = [
  "pending",
  "claimed",
  "sent",
  "failed",
  "snoozed",
  "cancelled",
  "superseded",
] as const;
export type SlotState = (typeof SLOT_STATES)[number];

/** Non-terminal slot states — the predicate of `ux_slot_one_open`. */
export const SLOT_OPEN_STATES = ["pending", "claimed"] as const;

/** The scheduling truth: `t(n) = instantOf(anchor_date + n × interval, delivery_time, tz)`. */
export const reminderSlot = sqliteTable(
  "reminder_slot",
  {
    id: text("id").primaryKey(),
    recipientStateId: text("recipient_state_id")
      .notNull()
      .references(() => notificationRecipientState.id, { onDelete: "cascade" }),
    /** 0 = the due-date notification; n = due + n × `reminder_interval_days`. */
    slotIndex: integer("slot_index").notNull(),
    scheduledAtMs: integer("scheduled_at_ms").notNull(),
    /** LocalDate, for debugging and exports. */
    scheduledLocalDate: text("scheduled_local_date").notNull(),
    state: text("state").$type<SlotState>().notNull().default("pending"),
    /** A snooze re-fire of the same `slot_index`. */
    isSnooze: integer("is_snooze", { mode: "boolean" }).notNull().default(false),
    /** Catch-up: the index this slot started as. */
    consolidatedFromIndex: integer("consolidated_from_index"),
    /** How many scheduled reminders this one send represents. */
    consolidatedCount: integer("consolidated_count").notNull().default(1),
    /** Set when the slot falls outside the send window. */
    heldUntilMs: integer("held_until_ms"),
    /** 128-bit random hex, stable across retries of the same slot. */
    nonce: text("nonce").notNull(),
    /** Exactly the action ids offered, for inbound validation. */
    offeredActionsJson: text("offered_actions_json"),
    claimedBy: text("claimed_by"),
    /** Lease fence token held at claim time. */
    claimFence: integer("claim_fence"),
    claimExpiresAtMs: integer("claim_expires_at_ms"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAtMs: integer("next_attempt_at_ms"),
    /** When HA accepted the service call — **not** proof of delivery. */
    sentAtMs: integer("sent_at_ms"),
    cancelReason: text("cancel_reason"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    check("ck_reminder_slot_state", oneOf("state", SLOT_STATES)),
    check("ck_reminder_slot_index", nonNegative("slot_index")),
    check("ck_reminder_slot_consolidated_count", sql`consolidated_count >= 1`),
    check("ck_reminder_slot_attempt_count", nonNegative("attempt_count")),
    // The structural reason a restart or a second worker cannot double-schedule.
    uniqueIndex("ux_slot_one_open")
      .on(t.recipientStateId)
      .where(sql`state IN ('pending', 'claimed')`),
    uniqueIndex("ux_slot_nonce").on(t.nonce),
    index("ix_slot_ready").on(t.state, t.scheduledAtMs),
    index("ix_slot_state_recipient").on(t.recipientStateId, t.slotIndex),
  ],
);

export const NOTIFY_COMMAND_KINDS = ["notify", "clear"] as const;
export type NotifyCommandKind = (typeof NOTIFY_COMMAND_KINDS)[number];

export const NOTIFY_COMMAND_STATES = [
  "queued",
  "claimed",
  "sent",
  "failed",
  "abandoned",
] as const;
export type NotifyCommandState = (typeof NOTIFY_COMMAND_STATES)[number];

/**
 * Transport outbox, so a **clear survives an HA outage** too: if a completion happens while HA is
 * down, the "stop reminding" command cannot be dropped. Drain order is `kind = 'clear'` first.
 */
export const haNotifyCommand = sqliteTable(
  "ha_notify_command",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<NotifyCommandKind>().notNull(),
    /** `notify.mobile_app_lucas_iphone` */
    notifyService: text("notify_service").notNull(),
    /** Exact HA service data. */
    payloadJson: text("payload_json").notNull(),
    tag: text("tag").notNull(),
    slotId: text("slot_id").references(() => reminderSlot.id, { onDelete: "set null" }),
    recipientStateId: text("recipient_state_id").references(
      () => notificationRecipientState.id,
      { onDelete: "set null" },
    ),
    /** `'notify:' || slot_id || ':' || notify_service` / `'clear:' || tag || ':' || cleared_at_ms` */
    dedupeKey: text("dedupe_key").notNull(),
    state: text("state").$type<NotifyCommandState>().notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAtMs: integer("next_attempt_at_ms"),
    claimedBy: text("claimed_by"),
    claimFence: integer("claim_fence"),
    claimExpiresAtMs: integer("claim_expires_at_ms"),
    sentAtMs: integer("sent_at_ms"),
    lastError: text("last_error"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    check("ck_ha_notify_command_kind", oneOf("kind", NOTIFY_COMMAND_KINDS)),
    check("ck_ha_notify_command_state", oneOf("state", NOTIFY_COMMAND_STATES)),
    check("ck_ha_notify_command_attempts", nonNegative("attempt_count")),
    uniqueIndex("ux_ha_notify_command_dedupe").on(t.dedupeKey),
    index("ix_ha_notify_command_ready").on(t.state, t.nextAttemptAtMs),
    index("ix_ha_notify_command_kind").on(t.kind, t.state),
  ],
);

export const DELIVERY_OUTCOMES = [
  "accepted",
  "ha_unavailable",
  "ha_error",
  "timeout",
  "no_device",
  "invalid_payload",
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** Immutable attempt log. `accepted` means HA took the call, nothing more. */
export const deliveryAttempt = sqliteTable(
  "delivery_attempt",
  {
    id: text("id").primaryKey(),
    commandId: text("command_id")
      .notNull()
      .references(() => haNotifyCommand.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
    outcome: text("outcome").$type<DeliveryOutcome>(),
    httpStatus: integer("http_status"),
    /** Truncated to 2 KB. */
    haResponse: text("ha_response"),
    error: text("error"),
    workerId: text("worker_id"),
  },
  (t) => [
    check("ck_delivery_attempt_outcome", oneOf("outcome", DELIVERY_OUTCOMES)),
    check("ck_delivery_attempt_no", sql`attempt_no >= 1`),
    uniqueIndex("ux_delivery_attempt").on(t.commandId, t.attemptNo),
    index("ix_delivery_attempt_command").on(t.commandId),
    index("ix_delivery_attempt_started").on(t.startedAtMs),
  ],
);

export const ACTION_VALIDATIONS = [
  "accepted",
  "duplicate",
  "unknown_nonce",
  "expired",
  "wrong_recipient",
  "occurrence_closed",
  "action_not_offered",
  "device_mismatch",
  "malformed",
] as const;
export type ActionValidation = (typeof ACTION_VALIDATIONS)[number];

export const ACTION_EFFECTS = ["snoozed", "completed", "noop"] as const;
export type ActionEffect = (typeof ACTION_EFFECTS)[number];

/** Every inbound HA action is recorded, accepted or not. This is the forensics + replay guard. */
export const notificationActionEvent = sqliteTable(
  "notification_action_event",
  {
    id: text("id").primaryKey(),
    receivedAtMs: integer("received_at_ms").notNull(),
    /** HA event context id, when present. */
    haContextId: text("ha_context_id"),
    /** From `action_data`. */
    nonce: text("nonce"),
    /** `'open'`, `'snooze'`, `'done'`. */
    action: text("action").notNull(),
    /** The whole event, for forensics. */
    rawJson: text("raw_json").notNull(),
    /** As asserted by the payload — never trusted without validation. */
    claimedOccurrenceId: text("claimed_occurrence_id"),
    claimedRecipientUserId: text("claimed_recipient_user_id"),
    claimedSlotId: text("claimed_slot_id"),
    sourceDeviceName: text("source_device_name"),
    validation: text("validation").$type<ActionValidation>().notNull(),
    appliedEffect: text("applied_effect").$type<ActionEffect>(),
    completionId: text("completion_id").references(() => completion.id, { onDelete: "set null" }),
    processedAtMs: integer("processed_at_ms"),
  },
  (t) => [
    check("ck_action_event_validation", oneOf("validation", ACTION_VALIDATIONS)),
    check("ck_action_event_effect", oneOf("applied_effect", ACTION_EFFECTS)),
    uniqueIndex("ux_action_replay")
      .on(t.nonce, t.action)
      .where(sql`nonce IS NOT NULL AND validation = 'accepted'`),
    index("ix_action_context").on(t.haContextId),
    index("ix_action_received").on(t.receivedAtMs),
  ],
);

/** `'notification_tick'`, `'ha_listener'`, `'outbox_drain'`. The fence token guards stale claims. */
export const workerLease = sqliteTable("worker_lease", {
  name: text("name").primaryKey(),
  holderId: text("holder_id"),
  fence: integer("fence").notNull().default(0),
  acquiredAtMs: integer("acquired_at_ms"),
  expiresAtMs: integer("expires_at_ms").notNull().default(0),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/** How the worker learns, after a restart, that an outage happened. */
export const workerHeartbeat = sqliteTable("worker_heartbeat", {
  name: text("name").primaryKey(),
  workerId: text("worker_id"),
  lastTickStartedMs: integer("last_tick_started_ms"),
  lastTickFinishedMs: integer("last_tick_finished_ms"),
  lastOkMs: integer("last_ok_ms"),
  tickCount: integer("tick_count").notNull().default(0),
  lastError: text("last_error"),
  haConnected: integer("ha_connected", { mode: "boolean" }).notNull().default(false),
  haLastConnectedMs: integer("ha_last_connected_ms"),
});
