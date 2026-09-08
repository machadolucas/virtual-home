/**
 * M0 — household settings, notify devices, audit log.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.3.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { actor, createdPair, isLocalTime, oneOf } from "./columns";
import { user } from "./auth";
import { modelRevision } from "./model";

export const HOUSEHOLD_SETTING_ID = "household";

/**
 * Singleton row (`id = 'household'`). Every tunable the scheduler, notifier and inventory engine
 * read at runtime, so behaviour is changeable without a deploy.
 */
export const householdSetting = sqliteTable(
  "household_setting",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    /** IANA time zone; all calendar math is relative to this. */
    timezone: text("timezone").notNull().default("Europe/Helsinki"),
    /** `HH:MM` local wall clock — must survive DST, so never stored as an instant. */
    deliveryTime: text("delivery_time").notNull().default("09:00"),
    reminderIntervalDays: integer("reminder_interval_days").notNull().default(7),
    /** Sends outside [start, end] are held rather than delivered at 03:00. */
    sendWindowStart: text("send_window_start").notNull().default("08:00"),
    sendWindowEnd: text("send_window_end").notNull().default("21:30"),
    /** Heartbeat gap that marks the previous period an outage. */
    catchupGapMinutes: integer("catchup_gap_minutes").notNull().default(120),
    /** More than this many simultaneous catch-ups per recipient ⇒ one digest instead. */
    catchupDigestThreshold: integer("catchup_digest_threshold").notNull().default(3),
    /** A slot later than this is "late", not "on time". */
    slotGraceMinutes: integer("slot_grace_minutes").notNull().default(30),
    /** Max age of a notification nonce accepted back from HA. */
    actionTtlDays: integer("action_ttl_days").notNull().default(30),
    batteryThresholdPct: integer("battery_threshold_pct").notNull().default(15),
    batteryClearPct: integer("battery_clear_pct").notNull().default(30),
    batterySustainMinutes: integer("battery_sustain_minutes").notNull().default(120),
    batteryClearSustainMinutes: integer("battery_clear_sustain_minutes").notNull().default(360),
    batteryStaleHours: integer("battery_stale_hours").notNull().default(48),
    reorderHorizonDays: integer("reorder_horizon_days").notNull().default(90),
    haBaseUrl: text("ha_base_url").notNull().default("http://homeassistant.local:8123"),
    currentModelId: text("current_model_id").notNull(),
    currentModelRevisionId: text("current_model_revision_id").references(() => modelRevision.id, {
      onDelete: "restrict",
    }),
    /** Inventory warnings are in-app only unless this is on. */
    inventoryPushEnabled: integer("inventory_push_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    updatedBy: actor("updated_by"),
  },
  (t) => [
    check("ck_household_setting_singleton", sql`${t.id} = 'household'`),
    check("ck_household_setting_delivery_time", isLocalTime("delivery_time")),
    check("ck_household_setting_send_window_start", isLocalTime("send_window_start")),
    check("ck_household_setting_send_window_end", isLocalTime("send_window_end")),
    check("ck_household_setting_reminder_interval", sql`${t.reminderIntervalDays} >= 1`),
    check("ck_household_setting_catchup_gap", sql`${t.catchupGapMinutes} >= 1`),
    check("ck_household_setting_digest_threshold", sql`${t.catchupDigestThreshold} >= 1`),
    check("ck_household_setting_slot_grace", sql`${t.slotGraceMinutes} >= 0`),
    check("ck_household_setting_action_ttl", sql`${t.actionTtlDays} >= 1`),
    check(
      "ck_household_setting_battery_pct",
      sql`${t.batteryThresholdPct} BETWEEN 0 AND 100 AND ${t.batteryClearPct} BETWEEN 0 AND 100`,
    ),
    check("ck_household_setting_battery_clear", sql`${t.batteryClearPct} > ${t.batteryThresholdPct}`),
    check("ck_household_setting_reorder_horizon", sql`${t.reorderHorizonDays} >= 1`),
  ],
);

/** Which `notify.mobile_app_*` service reaches which user. */
export const userNotifyDevice = sqliteTable(
  "user_notify_device",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** "Lucas iPhone" */
    label: text("label").notNull(),
    /** `notify.mobile_app_lucas_iphone` */
    notifyService: text("notify_service").notNull(),
    /** For matching the `device_name` of `mobile_app_notification_action` events. */
    haDeviceName: text("ha_device_name"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...createdPair(),
  },
  (t) => [
    uniqueIndex("ux_notify_device_service").on(t.notifyService),
    index("ix_notify_device_user").on(t.userId, t.isActive),
  ],
);

export const AUDIT_ACTOR_KINDS = ["user", "worker", "system", "ha"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/**
 * Generic audit trail for *meaningful* changes, written by the service layer (never by triggers —
 * a trigger cannot see the actor). Immutable ledgers keep their own history and are only
 * referenced from here, not duplicated.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    atMs: integer("at_ms").notNull(),
    actorKind: text("actor_kind").$type<AuditActorKind>().notNull(),
    /** Required in code when `actor_kind = 'user'`. */
    actorUserId: actor("actor_user_id"),
    entityTable: text("entity_table").notNull(),
    entityId: text("entity_id").notNull(),
    /** `'created'`, `'updated'`, `'completed'`, `'stock_adjusted'`, `'model_reconciled'`, … */
    action: text("action").notNull(),
    summary: text("summary").notNull(),
    /** `{ field: [before, after] }`, only for `action = 'updated'`. */
    changesJson: text("changes_json"),
    /** Correlates a web request or a worker tick. */
    requestId: text("request_id"),
  },
  (t) => [
    check("ck_audit_log_actor_kind", oneOf("actor_kind", AUDIT_ACTOR_KINDS)),
    index("ix_audit_entity").on(t.entityTable, t.entityId, t.atMs),
    index("ix_audit_at").on(t.atMs),
    index("ix_audit_actor").on(t.actorUserId, t.atMs),
  ],
);
