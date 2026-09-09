/**
 * M7 — the Home Assistant registry cache (identities only, no telemetry history), connection and
 * sync bookkeeping, and the condition engine that turns readings into work.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §6.1, §7.1;
 * `docs/design-notes/auth-security-operations.md` §8.7.
 *
 * CLAUDE.md rule 8: identity is the registry id (device registry id / entity registry entry id),
 * with `(platform, unique_id)` as the fallback and `entity_id` only as a logged last resort.
 * Registry rows are **soft-deleted** (`removed_at_ms`) — links point at them.
 * `unknown`/`unavailable` is never a value, which is what `condition_signal.is_valid` records.
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
import { actor, auditQuad, oneOf } from "./columns";
import { user } from "./auth";
import { asset } from "./assets";
import { part } from "./inventory";
import { maintenanceOccurrence } from "./maintenance";
import { procedure } from "./procedures";

export const haFloor = sqliteTable("ha_floor", {
  floorId: text("floor_id").primaryKey(),
  name: text("name").notNull(),
  level: integer("level"),
  icon: text("icon"),
  lastSeenMs: integer("last_seen_ms").notNull(),
  removedAtMs: integer("removed_at_ms"),
});

export const haArea = sqliteTable(
  "ha_area",
  {
    areaId: text("area_id").primaryKey(),
    name: text("name").notNull(),
    floorId: text("floor_id").references(() => haFloor.floorId, { onDelete: "set null" }),
    icon: text("icon"),
    aliasesJson: text("aliases_json"),
    lastSeenMs: integer("last_seen_ms").notNull(),
    removedAtMs: integer("removed_at_ms"),
  },
  (t) => [index("ix_ha_area_floor").on(t.floorId)],
);

export const haDevice = sqliteTable(
  "ha_device",
  {
    /** HA device registry id. */
    deviceId: text("device_id").primaryKey(),
    name: text("name"),
    nameByUser: text("name_by_user"),
    manufacturer: text("manufacturer"),
    model: text("model"),
    swVersion: text("sw_version"),
    hwVersion: text("hw_version"),
    areaId: text("area_id").references(() => haArea.areaId, { onDelete: "set null" }),
    viaDeviceId: text("via_device_id").references((): AnySQLiteColumn => haDevice.deviceId, {
      onDelete: "set null",
    }),
    /** For cross-restart identity matching. */
    identifiersJson: text("identifiers_json"),
    connectionsJson: text("connections_json"),
    /** `'service'` marks a software "device". */
    entryType: text("entry_type"),
    disabledBy: text("disabled_by"),
    /** The one battery-level entity for this device (§6.2). */
    canonicalBatteryEntityId: text("canonical_battery_entity_id").references(
      (): AnySQLiteColumn => haEntity.registryId,
      { onDelete: "set null" },
    ),
    firstSeenMs: integer("first_seen_ms").notNull(),
    lastSeenMs: integer("last_seen_ms").notNull(),
    /** Soft delete — never hard-delete; links point here. */
    removedAtMs: integer("removed_at_ms"),
  },
  (t) => [
    index("ix_ha_device_area").on(t.areaId),
    index("ix_ha_device_via").on(t.viaDeviceId),
  ],
);

export const haEntity = sqliteTable(
  "ha_entity",
  {
    /** The stable entity registry entry id — the primary identity. */
    registryId: text("registry_id").primaryKey(),
    /** Renameable; unique only among live rows. */
    entityId: text("entity_id").notNull(),
    uniqueId: text("unique_id"),
    platform: text("platform"),
    configEntryId: text("config_entry_id"),
    deviceId: text("device_id").references(() => haDevice.deviceId, { onDelete: "set null" }),
    /** Entity-level area override. */
    areaId: text("area_id").references(() => haArea.areaId, { onDelete: "set null" }),
    /** Derived from the `entity_id` prefix. */
    domain: text("domain").notNull(),
    deviceClass: text("device_class"),
    originalDeviceClass: text("original_device_class"),
    unitOfMeasurement: text("unit_of_measurement"),
    stateClass: text("state_class"),
    name: text("name"),
    originalName: text("original_name"),
    /** `'diagnostic'` / `'config'`. */
    entityCategory: text("entity_category"),
    disabledBy: text("disabled_by"),
    hiddenBy: text("hidden_by"),
    /**
     * Liveness from the last full snapshot, for **every** entity — distinct from
     * `ha_entity_state`, which caches values only for the entities something is linked to.
     *
     * The import browser needs it: HA's registry keeps entries whose integration no longer
     * provides them (`restored`), and a registry row says nothing about whether the thing is
     * alive. Verbatim, `unknown`/`unavailable` included, per hard rule 8 — this is the absence of
     * a reading, and the browser's job is to report that absence, not to reinterpret it.
     */
    liveState: text("live_state"),
    /** HA's `restored` attribute: the entity is in the registry but nothing is providing it. */
    liveRestored: integer("live_restored", { mode: "boolean" }),
    /** When the snapshot that produced `live_state` ran. Null until the first snapshot. */
    liveAtMs: integer("live_at_ms"),
    firstSeenMs: integer("first_seen_ms").notNull(),
    lastSeenMs: integer("last_seen_ms").notNull(),
    removedAtMs: integer("removed_at_ms"),
  },
  (t) => [
    uniqueIndex("ux_ha_entity_entity_id")
      .on(t.entityId)
      .where(sql`removed_at_ms IS NULL`),
    // `domain` belongs in this index: Home Assistant guarantees `unique_id` is
    // unique per platform *per domain*, not per platform. Real registries
    // collide constantly without it — `mobile_app` reuses one id for a
    // `device_tracker` and a `notify`, HACS for a `switch` and an `update`,
    // `apple_tv` across `media_player`/`remote`/`binary_sensor` — and the
    // rolled-back snapshot left the whole registry mirror empty.
    uniqueIndex("ux_ha_entity_unique_id")
      .on(t.platform, t.uniqueId, t.domain)
      .where(sql`unique_id IS NOT NULL AND removed_at_ms IS NULL`),
    index("ix_ha_entity_device").on(t.deviceId),
    index("ix_ha_entity_class").on(t.deviceClass, t.unitOfMeasurement),
    index("ix_ha_entity_entity_id").on(t.entityId),
  ],
);

/**
 * The **latest** state of the entities we actually render or evaluate — never a telemetry history
 * (§7.1: "identities only"; HA keeps the history). The web process reads this table instead of
 * talking to HA, and `/api/events` seeds a fresh SSE client from it so the browser renders before
 * the first `state_changed` arrives.
 *
 * Keyed by `entity_id` because that is what a `state_changed` event carries; `registry_id` is the
 * durable identity and is filled in whenever the entity is in the registry cache (CLAUDE.md
 * rule 8). `attributes_json` holds only the handful of attributes the UI needs — copying HA's full
 * attribute blob would make this table the biggest thing in the database for no benefit.
 *
 * `state` is stored verbatim, `unknown`/`unavailable` included: those are the *absence* of a
 * reading, and turning them into a value (0 %) is what hard rule #8 forbids. Interpretation is
 * `classifyBatteryReading`'s job, not the cache's.
 */
export const haEntityState = sqliteTable(
  "ha_entity_state",
  {
    entityId: text("entity_id").primaryKey(),
    registryId: text("registry_id").references((): AnySQLiteColumn => haEntity.registryId, {
      onDelete: "set null",
    }),
    /** Verbatim from HA. */
    state: text("state").notNull(),
    /** `{friendly_name, unit_of_measurement, device_class, battery_level, battery, battery_type}`. */
    attributesJson: text("attributes_json"),
    lastChangedMs: integer("last_changed_ms").notNull(),
    lastUpdatedMs: integer("last_updated_ms").notNull(),
    /** When *we* saw it — `observed_at_ms - last_updated_ms` is the staleness measure. */
    observedAtMs: integer("observed_at_ms").notNull(),
  },
  (t) => [
    index("ix_ha_entity_state_registry").on(t.registryId),
    index("ix_ha_entity_state_observed").on(t.observedAtMs),
  ],
);

export const HA_RENAME_SOURCES = ["registry_sync", "event"] as const;
export type HaRenameSource = (typeof HA_RENAME_SOURCES)[number];

/** Nothing breaks on a rename — every link stores `registry_id`. This is the paper trail. */
export const haEntityRename = sqliteTable(
  "ha_entity_rename",
  {
    id: text("id").primaryKey(),
    registryId: text("registry_id")
      .notNull()
      .references(() => haEntity.registryId, { onDelete: "cascade" }),
    oldEntityId: text("old_entity_id").notNull(),
    newEntityId: text("new_entity_id").notNull(),
    detectedAtMs: integer("detected_at_ms").notNull(),
    source: text("source").$type<HaRenameSource>().notNull(),
  },
  (t) => [
    check("ck_ha_entity_rename_source", oneOf("source", HA_RENAME_SOURCES)),
    index("ix_ha_entity_rename_registry").on(t.registryId, t.detectedAtMs),
  ],
);

export const HA_SYNC_STATUSES = ["running", "ok", "failed"] as const;
export type HaSyncStatus = (typeof HA_SYNC_STATUSES)[number];

export const haSyncRun = sqliteTable(
  "ha_sync_run",
  {
    id: text("id").primaryKey(),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
    status: text("status").$type<HaSyncStatus>().notNull(),
    devicesSeen: integer("devices_seen").notNull().default(0),
    entitiesSeen: integer("entities_seen").notNull().default(0),
    areasSeen: integer("areas_seen").notNull().default(0),
    renamesDetected: integer("renames_detected").notNull().default(0),
    removalsDetected: integer("removals_detected").notNull().default(0),
    additionsDetected: integer("additions_detected").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    check("ck_ha_sync_run_status", oneOf("status", HA_SYNC_STATUSES)),
    index("ix_ha_sync_run_started").on(t.startedAtMs),
  ],
);

export const HA_CONNECTION_STATE_ID = "ha";

/** Singleton (`id = 'ha'`) written by the worker's socket state machine. */
export const haConnectionState = sqliteTable(
  "ha_connection_state",
  {
    id: text("id").primaryKey(),
    connected: integer("connected", { mode: "boolean" }).notNull().default(false),
    connectedSinceMs: integer("connected_since_ms"),
    lastDisconnectedAtMs: integer("last_disconnected_at_ms"),
    /** Redacted — never contains the token. */
    lastError: text("last_error"),
    haVersion: text("ha_version"),
    reconnectAttempts: integer("reconnect_attempts").notNull().default(0),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [check("ck_ha_connection_state_singleton", sql`${t.id} = 'ha'`)],
);

export const INTEGRATION_STATES = [
  "connecting",
  "authenticating",
  "syncing",
  "subscribed",
  "degraded",
  "auth_failed",
  "disconnected",
] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

export const INTEGRATION_STATUS_HA_ID = "ha";

/**
 * What both processes read to render "is the integration healthy". `heartbeat_at_ms` is bumped by
 * the worker every `VH_WORKER_HEARTBEAT_MS` regardless of HA state, so a stale heartbeat means
 * *the worker* is down — a distinct message from "HA is unreachable".
 */
export const integrationStatus = sqliteTable(
  "integration_status",
  {
    id: text("id").primaryKey(),
    state: text("state").$type<IntegrationState>().notNull(),
    haVersion: text("ha_version"),
    lastOkAtMs: integer("last_ok_at_ms"),
    heartbeatAtMs: integer("heartbeat_at_ms").notNull(),
    /** Redacted — never contains the token. */
    lastError: text("last_error"),
    reconnectCount: integer("reconnect_count").notNull().default(0),
    entityCount: integer("entity_count").notNull().default(0),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  () => [check("ck_integration_status_state", oneOf("state", INTEGRATION_STATES))],
);

export const HA_CONTROL_COMMAND_STATES = [
  "queued",
  "sending",
  "sent",
  "failed",
  "expired",
] as const;
export type HaControlCommandState = (typeof HA_CONTROL_COMMAND_STATES)[number];

/**
 * Short-lived web → worker commands for a linked light or switch.
 *
 * The row captures both durable registry identity and the entity_id resolved when the household
 * asked for the change. The worker re-resolves the registry id before sending, so an HA rename
 * between enqueue and delivery cannot control an unrelated entity. Commands expire quickly and
 * are never retried after a send starts: a timed-out call has an uncertain outcome, and repeating
 * it later would make a stale UI gesture surprising.
 */
export const haControlCommand = sqliteTable(
  "ha_control_command",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => asset.id, { onDelete: "cascade" }),
    entityRegistryId: text("entity_registry_id")
      .notNull()
      .references(() => haEntity.registryId, { onDelete: "restrict" }),
    entityIdSnapshot: text("entity_id_snapshot").notNull(),
    domain: text("domain").notNull(),
    commandJson: text("command_json").notNull(),
    state: text("state").$type<HaControlCommandState>().notNull().default("queued"),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAtMs: integer("created_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    sendingAtMs: integer("sending_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
    lastError: text("last_error"),
  },
  (t) => [
    check("ck_ha_control_command_state", oneOf("state", HA_CONTROL_COMMAND_STATES)),
    check("ck_ha_control_command_domain", oneOf("domain", ["light", "switch"])),
    check("ck_ha_control_command_expiry", sql`expires_at_ms > created_at_ms`),
    uniqueIndex("ux_ha_control_command_request").on(t.requestedBy, t.requestId),
    index("ix_ha_control_command_ready").on(t.state, t.expiresAtMs, t.createdAtMs),
    index("ix_ha_control_command_asset").on(t.assetId, t.createdAtMs),
  ],
);

export const CONDITION_RULE_KINDS = [
  "low_battery",
  "unavailable_device",
  "threshold_below",
  "threshold_above",
] as const;
export type ConditionRuleKind = (typeof CONDITION_RULE_KINDS)[number];

export const CONDITION_SCOPES = ["all_batteries", "asset", "entity"] as const;
export type ConditionScope = (typeof CONDITION_SCOPES)[number];

/** A rule that turns HA readings into maintenance work, with explicit hysteresis. */
export const conditionRule = sqliteTable(
  "condition_rule",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ConditionRuleKind>().notNull(),
    name: text("name").notNull(),
    scope: text("scope").$type<ConditionScope>().notNull(),
    assetId: text("asset_id").references(() => asset.id, { onDelete: "cascade" }),
    haEntityRegistryId: text("ha_entity_registry_id").references(() => haEntity.registryId, {
      onDelete: "set null",
    }),
    /** Falls back to `household_setting.battery_threshold_pct`. */
    thresholdPct: integer("threshold_pct"),
    clearThresholdPct: integer("clear_threshold_pct"),
    sustainMinutes: integer("sustain_minutes"),
    clearSustainMinutes: integer("clear_sustain_minutes"),
    procedureId: text("procedure_id").references(() => procedure.id, { onDelete: "set null" }),
    /** Fallback when the asset has no `asset_consumable` battery row. */
    defaultPartId: text("default_part_id").references(() => part.id, { onDelete: "set null" }),
    priority: text("priority").notNull().default("normal"),
    assignmentMode: text("assignment_mode").notNull().default("shared"),
    assigneeUserId: text("assignee_user_id").references(() => user.id, { onDelete: "restrict" }),
    /** `'Replace battery: {{asset}}'` */
    titleTemplate: text("title_template").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ...auditQuad(),
  },
  (t) => [
    check("ck_condition_rule_kind", oneOf("kind", CONDITION_RULE_KINDS)),
    check("ck_condition_rule_scope", oneOf("scope", CONDITION_SCOPES)),
    check("ck_condition_rule_priority", oneOf("priority", ["low", "normal", "high", "urgent"])),
    check("ck_condition_rule_assignment_mode", oneOf("assignment_mode", ["user", "shared"])),
    check(
      "ck_condition_rule_assignee",
      sql`(assignment_mode = 'user') = (assignee_user_id IS NOT NULL)`,
    ),
    check(
      "ck_condition_rule_threshold",
      sql`threshold_pct IS NULL OR (threshold_pct BETWEEN 0 AND 100)`,
    ),
    check(
      "ck_condition_rule_clear_threshold",
      sql`clear_threshold_pct IS NULL OR (clear_threshold_pct BETWEEN 0 AND 100 AND (threshold_pct IS NULL OR clear_threshold_pct > threshold_pct))`,
    ),
    check(
      "ck_condition_rule_sustain",
      sql`(sustain_minutes IS NULL OR sustain_minutes >= 0) AND (clear_sustain_minutes IS NULL OR clear_sustain_minutes >= 0)`,
    ),
    check(
      "ck_condition_rule_scope_target",
      sql`(scope = 'asset') <= (asset_id IS NOT NULL) AND (scope = 'entity') <= (ha_entity_registry_id IS NOT NULL)`,
    ),
    index("ix_condition_rule_enabled").on(t.enabled, t.kind),
    index("ix_condition_rule_asset").on(t.assetId),
  ],
);

export const SIGNAL_INVALID_REASONS = [
  "unknown",
  "unavailable",
  "non_numeric",
  "missing_unit",
] as const;
export type SignalInvalidReason = (typeof SIGNAL_INVALID_REASONS)[number];

/**
 * Latest value only. **No telemetry history is copied into this database** — HA keeps that.
 * `below_since_ms`/`above_since_ms` are the hysteresis timers for the current run.
 */
export const conditionSignal = sqliteTable(
  "condition_signal",
  {
    haEntityRegistryId: text("ha_entity_registry_id")
      .primaryKey()
      .references(() => haEntity.registryId, { onDelete: "cascade" }),
    /** Verbatim from HA. */
    rawState: text("raw_state").notNull(),
    /** NULL when not parseable. */
    numericValue: real("numeric_value"),
    /** 0 for `unknown`/`unavailable`/empty/non-numeric — never treated as a value. */
    isValid: integer("is_valid", { mode: "boolean" }).notNull(),
    invalidReason: text("invalid_reason").$type<SignalInvalidReason>(),
    lastChangedMs: integer("last_changed_ms").notNull(),
    lastUpdatedMs: integer("last_updated_ms").notNull(),
    /** When we saw it. */
    observedAtMs: integer("observed_at_ms").notNull(),
    belowSinceMs: integer("below_since_ms"),
    aboveSinceMs: integer("above_since_ms"),
    isStale: integer("is_stale", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    check("ck_condition_signal_invalid_reason", oneOf("invalid_reason", SIGNAL_INVALID_REASONS)),
    check("ck_condition_signal_valid", sql`(is_valid = 1) = (invalid_reason IS NULL)`),
    index("ix_condition_signal_observed").on(t.observedAtMs),
  ],
);

export const EPISODE_CLOSE_REASONS = [
  "recovered",
  "entity_removed",
  "rule_disabled",
  "manual",
  "completed",
] as const;
export type EpisodeCloseReason = (typeof EPISODE_CLOSE_REASONS)[number];

/** The condition history that *is* worth keeping: one row per "it went low and then came back". */
export const conditionEpisode = sqliteTable(
  "condition_episode",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => conditionRule.id, { onDelete: "cascade" }),
    haEntityRegistryId: text("ha_entity_registry_id")
      .notNull()
      .references(() => haEntity.registryId, { onDelete: "cascade" }),
    assetId: text("asset_id").references(() => asset.id, { onDelete: "set null" }),
    openedAtMs: integer("opened_at_ms").notNull(),
    openedValue: real("opened_value"),
    /** LocalDate. */
    openLocalDate: text("open_local_date").notNull(),
    closedAtMs: integer("closed_at_ms"),
    closedValue: real("closed_value"),
    closeReason: text("close_reason").$type<EpisodeCloseReason>(),
    occurrenceId: text("occurrence_id").references(
      (): AnySQLiteColumn => maintenanceOccurrence.id,
      { onDelete: "set null" },
    ),
    minValue: real("min_value"),
    notes: text("notes"),
    createdAtMs: integer("created_at_ms").notNull(),
    createdBy: actor("created_by"),
  },
  (t) => [
    check("ck_condition_episode_close_reason", oneOf("close_reason", EPISODE_CLOSE_REASONS)),
    check("ck_condition_episode_closed", sql`(closed_at_ms IS NULL) = (close_reason IS NULL)`),
    // One open episode per (rule, entity).
    uniqueIndex("ux_condition_episode_open")
      .on(t.ruleId, t.haEntityRegistryId)
      .where(sql`closed_at_ms IS NULL`),
    index("ix_condition_episode_entity").on(t.haEntityRegistryId, t.openedAtMs),
    index("ix_condition_episode_occurrence").on(t.occurrenceId),
  ],
);
