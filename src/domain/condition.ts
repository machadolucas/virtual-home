/**
 * Low-battery (and other threshold) conditions: turning Home Assistant readings into work, without
 * ever inventing maintenance history.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §6.
 *
 * Three protections, all three required, all three tested:
 *  - a **dead band** (`threshold_pct` … `clear_threshold_pct`, default 15 % … 30 %): a reading in
 *    between changes no state, so a battery oscillating 14/16/13/17 neither opens nor closes
 *    anything after the first decision;
 *  - **sustain timers** (2 h to open, 6 h to close): one spurious sample does nothing;
 *  - **invalid readings freeze rather than reset** the timers, so `unavailable` is never 0 % and a
 *    30-second connectivity blip mid-episode neither triggers nor cancels an episode.
 *
 * And the rule that outranks all of them (CLAUDE.md rule 6): a reading recovering is **not**
 * evidence that maintenance happened. Recovery closes the *episode*, snoozes the reminders, and
 * leaves the task open for a human to decide.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import {
  asset,
  assetHaLink,
  conditionEpisode,
  conditionRule,
  conditionSignal,
  haDevice,
  haEntity,
  maintenanceOccurrence,
  procedure,
  type AssignmentMode,
  type Priority,
  type SignalInvalidReason,
} from "@/db/schema";
import { NotFoundError } from "@/domain/errors";
import { addDaysLocal, instantOf, localDateOf } from "@/domain/time";
import {
  createConditionOccurrence,
  loadHousehold,
  loadOccurrence,
  skip,
  snooze,
  writeOccurrenceEvent,
} from "@/domain/occurrence";
import { ensureRecipientStates, recipientStatesOf } from "@/domain/notify/recipients";
import { assetsForEntity } from "@/domain/assets";
import { raiseAlert, writeAudit, type DomainContext } from "@/domain/inventory";

export type ConditionRuleRow = typeof conditionRule.$inferSelect;
export type ConditionSignalRow = typeof conditionSignal.$inferSelect;
export type ConditionEpisodeRow = typeof conditionEpisode.$inferSelect;
export type HaEntityRow = typeof haEntity.$inferSelect;

/** States HA sends that are never a value — `unknown`/`unavailable` is not 0 % (CLAUDE.md rule 8). */
const NON_VALUES = new Set(["unknown", "unavailable", "none", ""]);

/* -------------------------------------------------------------------------------------------------
 * Rule resolution
 * ---------------------------------------------------------------------------------------------- */

export interface ResolvedThresholds {
  /** Open below or at this. */
  lowPct: number;
  /** Close at or above this. */
  clearPct: number;
  sustainLowMinutes: number;
  sustainClearMinutes: number;
  staleHours: number;
}

export interface ResolvedRule {
  rule: ConditionRuleRow;
  thresholds: ResolvedThresholds;
  /** Why this rule won: `'entity'` > `'asset'` > `'all_batteries'`. */
  matchedBy: "entity" | "asset" | "all_batteries";
}

/**
 * The matching enabled `low_battery` rule for an entity, in precedence order
 * entity-specific > asset > `all_batteries`, with every threshold falling back to
 * `household_setting`.
 */
export function resolveRule(tx: Db, entityRegistryId: string): ResolvedRule | null {
  const household = loadHousehold(tx);

  const withThresholds = (
    rule: ConditionRuleRow,
    matchedBy: ResolvedRule["matchedBy"],
  ): ResolvedRule => ({
    rule,
    matchedBy,
    thresholds: {
      lowPct: rule.thresholdPct ?? household.batteryThresholdPct,
      clearPct: rule.clearThresholdPct ?? household.batteryClearPct,
      sustainLowMinutes: rule.sustainMinutes ?? household.batterySustainMinutes,
      sustainClearMinutes: rule.clearSustainMinutes ?? household.batteryClearSustainMinutes,
      staleHours: household.batteryStaleHours,
    },
  });

  const entityRule = tx
    .select()
    .from(conditionRule)
    .where(
      and(
        eq(conditionRule.enabled, true),
        eq(conditionRule.kind, "low_battery"),
        eq(conditionRule.scope, "entity"),
        eq(conditionRule.haEntityRegistryId, entityRegistryId),
      ),
    )
    .orderBy(asc(conditionRule.id))
    .get();
  if (entityRule) return withThresholds(entityRule, "entity");

  const entity = tx.select().from(haEntity).where(eq(haEntity.registryId, entityRegistryId)).get();
  const assetIds = entity ? assetsForEntity(tx, entityRegistryId, entity.deviceId) : [];
  for (const assetId of assetIds) {
    const assetRule = tx
      .select()
      .from(conditionRule)
      .where(
        and(
          eq(conditionRule.enabled, true),
          eq(conditionRule.kind, "low_battery"),
          eq(conditionRule.scope, "asset"),
          eq(conditionRule.assetId, assetId),
        ),
      )
      .orderBy(asc(conditionRule.id))
      .get();
    if (assetRule) return withThresholds(assetRule, "asset");
  }

  const globalRule = tx
    .select()
    .from(conditionRule)
    .where(
      and(
        eq(conditionRule.enabled, true),
        eq(conditionRule.kind, "low_battery"),
        eq(conditionRule.scope, "all_batteries"),
      ),
    )
    .orderBy(asc(conditionRule.id))
    .get();
  return globalRule ? withThresholds(globalRule, "all_batteries") : null;
}

/* -------------------------------------------------------------------------------------------------
 * Canonical battery entity (§6.2)
 * ---------------------------------------------------------------------------------------------- */

const EXCLUDED_SUFFIXES = ["_battery_type", "_battery_voltage", "_battery_state", "_battery_plugged"];
const EXCLUDED_DEVICE_CLASSES = new Set(["voltage", "enum"]);
const EXCLUDED_UNITS = new Set(["V", "mV"]);

/**
 * The one battery-*level* entity of a device. HA typically exposes `sensor.x_battery` (%),
 * `sensor.x_battery_voltage` (V) and `sensor.x_battery_type` (state `"AAA"`); only the first is a
 * level. An explicit `asset_ha_link(role = 'battery_level')` wins outright — that is the manual
 * override for the rare multi-battery device.
 */
export function resolveCanonicalBatteryEntity(tx: Db, deviceId: string): string | null {
  const entities = tx
    .select()
    .from(haEntity)
    .where(and(eq(haEntity.deviceId, deviceId), isNull(haEntity.removedAtMs)))
    .all();

  // (i) The manual override, checked against this device's entities.
  const pinned = tx
    .select({ registryId: assetHaLink.haEntityRegistryId })
    .from(assetHaLink)
    .where(and(eq(assetHaLink.role, "battery_level"), eq(assetHaLink.linkKind, "entity")))
    .all()
    .map((row) => row.registryId);
  const override = entities.find((entity) => pinned.includes(entity.registryId));
  if (override) return override.registryId;

  const candidates = entities.filter((entity) => {
    if (entity.disabledBy !== null || entity.hiddenBy !== null) return false;
    if (entity.deviceClass !== "battery") return false;
    if (entity.unitOfMeasurement !== "%") return false;
    if (entity.deviceClass !== null && EXCLUDED_DEVICE_CLASSES.has(entity.deviceClass)) return false;
    if (entity.unitOfMeasurement !== null && EXCLUDED_UNITS.has(entity.unitOfMeasurement)) return false;
    if (EXCLUDED_SUFFIXES.some((suffix) => entity.entityId.endsWith(suffix))) return false;
    // A non-numeric latest reading filters the `"AAA"` battery-type sensor even if mislabelled.
    const signal = tx
      .select()
      .from(conditionSignal)
      .where(eq(conditionSignal.haEntityRegistryId, entity.registryId))
      .get();
    if (signal && !signal.isValid && signal.invalidReason === "non_numeric") return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // (ii) `_battery` suffix, (iii) shortest entity_id, (iv) lowest registry id.
  const ranked = [...candidates].sort((a, b) => {
    const aSuffix = a.entityId.endsWith("_battery") ? 0 : 1;
    const bSuffix = b.entityId.endsWith("_battery") ? 0 : 1;
    if (aSuffix !== bSuffix) return aSuffix - bSuffix;
    if (a.entityId.length !== b.entityId.length) return a.entityId.length - b.entityId.length;
    return a.registryId < b.registryId ? -1 : 1;
  });
  return ranked[0]?.registryId ?? null;
}

/** Recompute and store `ha_device.canonical_battery_entity_id`, auditing a change. */
export function syncCanonicalBatteryEntity(
  tx: Db,
  ctx: DomainContext,
  deviceId: string,
): string | null {
  const device = tx.select().from(haDevice).where(eq(haDevice.deviceId, deviceId)).get();
  if (!device) throw new NotFoundError("ha_device", deviceId);
  const canonical = resolveCanonicalBatteryEntity(tx, deviceId);
  if (canonical === device.canonicalBatteryEntityId) return canonical;

  tx.update(haDevice)
    .set({ canonicalBatteryEntityId: canonical })
    .where(eq(haDevice.deviceId, deviceId))
    .run();
  writeAudit(tx, ctx, {
    entityTable: "ha_device",
    entityId: deviceId,
    action: "updated",
    summary: "canonical battery entity recomputed",
    changes: { canonical_battery_entity_id: [device.canonicalBatteryEntityId, canonical] },
  });
  return canonical;
}

/* -------------------------------------------------------------------------------------------------
 * Signal evaluation (§6.3)
 * ---------------------------------------------------------------------------------------------- */

export type BatterySignalAction =
  /** Not a value. Timers frozen, not reset. */
  | "invalid"
  /** Valid but too old to act on — a data-quality problem, not a maintenance task. */
  | "stale"
  /** Another entity of the same device is the canonical battery level. */
  | "not_canonical"
  | "no_rule"
  /** At or below the threshold, sustain not met yet. */
  | "below_pending"
  /** Sustain met, an episode was opened. */
  | "episode_opened"
  /** Sustain met but the device is not linked to an asset, so no task was created. */
  | "link_missing"
  /** Sustain met and an episode was already open. */
  | "already_open"
  /** At or above the clear threshold, clear sustain not met yet. */
  | "above_pending"
  | "episode_closed"
  /** In the dead band: nothing changes. This is the anti-flap. */
  | "dead_band";

export interface BatterySignalResult {
  action: BatterySignalAction;
  signal: ConditionSignalRow;
  value: number | null;
  episodeId: string | null;
  occurrenceId: string | null;
  alertId: string | null;
}

export interface BatterySignalInput {
  entityRegistryId: string;
  /** Verbatim from HA. */
  rawState: string;
  /** HA's `last_updated`. */
  lastUpdatedMs: number;
  /**
   * HA's `last_changed`. Optional: when omitted we carry the stored value forward for an unchanged
   * state, which is what makes "unavailable for 3 days" measurable.
   */
  lastChangedMs?: number;
}

/**
 * A discriminated union rather than three loose fields, so `if (!valid)` narrows `value` for the
 * rest of the function — the type system enforcing "invalid is never a number".
 */
type Classified =
  | { valid: true; value: number; reason: null }
  | { valid: false; value: null; reason: SignalInvalidReason };

function classify(raw: string): Classified {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered === "unknown") return { valid: false, value: null, reason: "unknown" };
  if (lowered === "unavailable") return { valid: false, value: null, reason: "unavailable" };
  if (NON_VALUES.has(lowered)) return { valid: false, value: null, reason: "non_numeric" };
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return { valid: false, value: null, reason: "non_numeric" };
  return { valid: true, value: parsed, reason: null };
}

/** Evaluate one HA state change (or one worker tick's re-read) for a battery-level entity. */
export function evaluateBatterySignal(
  handle: DbHandle,
  ctx: DomainContext,
  input: BatterySignalInput,
): BatterySignalResult {
  return writeTx(handle.db, (tx) => evaluateBatterySignalInTx(tx, ctx, input));
}

export function evaluateBatterySignalInTx(
  tx: Db,
  ctx: DomainContext,
  input: BatterySignalInput,
): BatterySignalResult {
  const now = ctx.clock.now();
  const household = loadHousehold(tx);
  const entity = tx
    .select()
    .from(haEntity)
    .where(eq(haEntity.registryId, input.entityRegistryId))
    .get();
  if (!entity) throw new NotFoundError("ha_entity", input.entityRegistryId);

  const previous = tx
    .select()
    .from(conditionSignal)
    .where(eq(conditionSignal.haEntityRegistryId, input.entityRegistryId))
    .get();

  const { valid, value, reason } = classify(input.rawState);
  const lastChangedMs =
    input.lastChangedMs ??
    (previous && previous.rawState === input.rawState ? previous.lastChangedMs : input.lastUpdatedMs);

  const staleAfterMs = household.batteryStaleHours * 3_600_000;
  const isStale = valid
    ? now - input.lastUpdatedMs > staleAfterMs
    : now - lastChangedMs > staleAfterMs;

  const write = (patch: Partial<typeof conditionSignal.$inferInsert> = {}): ConditionSignalRow => {
    const values = {
      haEntityRegistryId: input.entityRegistryId,
      rawState: input.rawState,
      numericValue: value,
      isValid: valid,
      invalidReason: reason,
      lastChangedMs,
      lastUpdatedMs: input.lastUpdatedMs,
      observedAtMs: now,
      // Timers are carried forward by default: an invalid reading freezes them, never resets them.
      belowSinceMs: previous?.belowSinceMs ?? null,
      aboveSinceMs: previous?.aboveSinceMs ?? null,
      isStale,
      ...patch,
    };
    if (previous) {
      return tx
        .update(conditionSignal)
        .set(values)
        .where(eq(conditionSignal.haEntityRegistryId, input.entityRegistryId))
        .returning()
        .get();
    }
    return tx.insert(conditionSignal).values(values).returning().get();
  };

  // Not a value. Never 0 %. Do not touch the sustain clocks.
  if (!valid) {
    const signal = write();
    let alertId: string | null = null;
    if ((reason === "unknown" || reason === "unavailable") && isStale) {
      alertId = raiseAlert(tx, ctx, {
        kind: "stale_sensor",
        severity: "warning",
        title: `${entity.entityId} has been ${input.rawState} for over ${household.batteryStaleHours} h`,
        body: "Home Assistant is not reporting a battery level for this entity. No task was created.",
        entityTable: "ha_entity",
        entityId: entity.registryId,
        dedupeKey: `stale_sensor:entity:${entity.registryId}`,
      }).id;
    }
    return { action: "invalid", signal, value: null, episodeId: null, occurrenceId: null, alertId };
  }

  // A stale value never opens or closes an episode — it is a data-quality alert.
  if (isStale) {
    const signal = write();
    const alertId = raiseAlert(tx, ctx, {
      kind: "stale_sensor",
      severity: "warning",
      title: `${entity.entityId} last updated ${Math.floor((now - input.lastUpdatedMs) / 3_600_000)} h ago`,
      body: `Reading ${input.rawState} is older than ${household.batteryStaleHours} h, so it was ignored.`,
      entityTable: "ha_entity",
      entityId: entity.registryId,
      dedupeKey: `stale_sensor:entity:${entity.registryId}`,
    }).id;
    return { action: "stale", signal, value, episodeId: null, occurrenceId: null, alertId };
  }

  // Canonical-entity dedupe: a device reports one battery level, not three (§6.2).
  if (entity.deviceId !== null) {
    const device = tx.select().from(haDevice).where(eq(haDevice.deviceId, entity.deviceId)).get();
    if (
      device &&
      device.canonicalBatteryEntityId !== null &&
      device.canonicalBatteryEntityId !== entity.registryId
    ) {
      const signal = write();
      return {
        action: "not_canonical",
        signal,
        value,
        episodeId: null,
        occurrenceId: null,
        alertId: null,
      };
    }
  }

  const resolved = resolveRule(tx, input.entityRegistryId);
  if (!resolved) {
    const signal = write();
    return { action: "no_rule", signal, value, episodeId: null, occurrenceId: null, alertId: null };
  }
  const { rule, thresholds } = resolved;

  const openEpisode = tx
    .select()
    .from(conditionEpisode)
    .where(
      and(
        eq(conditionEpisode.ruleId, rule.id),
        eq(conditionEpisode.haEntityRegistryId, input.entityRegistryId),
        isNull(conditionEpisode.closedAtMs),
      ),
    )
    .get();

  // Keep the episode's low-water mark honest whichever branch we take.
  if (openEpisode && (openEpisode.minValue === null || value < openEpisode.minValue)) {
    tx.update(conditionEpisode)
      .set({ minValue: value })
      .where(eq(conditionEpisode.id, openEpisode.id))
      .run();
  }

  if (value <= thresholds.lowPct) {
    const belowSinceMs = previous?.belowSinceMs ?? now;
    const signal = write({ aboveSinceMs: null, belowSinceMs });
    const sustained = now - belowSinceMs >= thresholds.sustainLowMinutes * 60_000;
    if (!sustained) {
      return {
        action: "below_pending",
        signal,
        value,
        episodeId: openEpisode?.id ?? null,
        occurrenceId: openEpisode?.occurrenceId ?? null,
        alertId: null,
      };
    }
    if (openEpisode) {
      return {
        action: "already_open",
        signal,
        value,
        episodeId: openEpisode.id,
        occurrenceId: openEpisode.occurrenceId,
        alertId: null,
      };
    }
    const opened = openConditionEpisode(tx, ctx, { resolved, entity, value });
    return { ...opened, signal, value };
  }

  if (value >= thresholds.clearPct) {
    const aboveSinceMs = previous?.aboveSinceMs ?? now;
    const signal = write({ belowSinceMs: null, aboveSinceMs });
    const sustained = now - aboveSinceMs >= thresholds.sustainClearMinutes * 60_000;
    if (!sustained || !openEpisode) {
      return {
        action: "above_pending",
        signal,
        value,
        episodeId: openEpisode?.id ?? null,
        occurrenceId: openEpisode?.occurrenceId ?? null,
        alertId: null,
      };
    }
    const closed = closeRecovered(tx, ctx, openEpisode, value);
    return {
      action: "episode_closed",
      signal,
      value,
      episodeId: closed.episodeId,
      occurrenceId: closed.occurrenceId,
      alertId: null,
    };
  }

  // Dead band: change nothing at all.
  const signal = write();
  return {
    action: "dead_band",
    signal,
    value,
    episodeId: openEpisode?.id ?? null,
    occurrenceId: openEpisode?.occurrenceId ?? null,
    alertId: null,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Opening an episode → an occurrence (§6.4)
 * ---------------------------------------------------------------------------------------------- */

function renderTitle(template: string, assetName: string, entityId: string, value: number): string {
  return template
    .replaceAll("{{asset}}", assetName)
    .replaceAll("{{entity}}", entityId)
    .replaceAll("{{value}}", String(value));
}

interface OpenEpisodeInput {
  resolved: ResolvedRule;
  entity: HaEntityRow;
  value: number;
}

function openConditionEpisode(
  tx: Db,
  ctx: DomainContext,
  input: OpenEpisodeInput,
): { action: BatterySignalAction; episodeId: string; occurrenceId: string | null; alertId: string | null } {
  const now = ctx.clock.now();
  const { rule } = input.resolved;
  const openLocalDate = localDateOf(now, ctx.tz);

  // Resolve the asset first — a battery task without an asset has nowhere to record history.
  const candidates = assetsForEntity(tx, input.entity.registryId, input.entity.deviceId);
  const assetId = rule.assetId ?? candidates[0] ?? null;

  const episode = tx
    .insert(conditionEpisode)
    .values({
      id: newId(),
      ruleId: rule.id,
      haEntityRegistryId: input.entity.registryId,
      assetId,
      openedAtMs: now,
      openedValue: input.value,
      openLocalDate,
      minValue: input.value,
      createdAtMs: now,
      createdBy: ctx.actorUserId,
    })
    .returning()
    .get();

  if (assetId === null) {
    const alertId = raiseAlert(tx, ctx, {
      kind: "ha_link_missing",
      severity: "warning",
      title: `Link ${input.entity.entityId} to an asset`,
      body:
        `The battery reported ${input.value} %, but this entity is not linked to any asset, so no ` +
        `task was created. Link the device to record replacement history against it.`,
      entityTable: "ha_entity",
      entityId: input.entity.registryId,
      dedupeKey: `ha_link_missing:entity:${input.entity.registryId}`,
    }).id;
    writeAudit(tx, ctx, {
      entityTable: "condition_episode",
      entityId: episode.id,
      action: "created",
      summary: `condition episode opened at ${input.value} % with no linked asset`,
    });
    return { action: "link_missing", episodeId: episode.id, occurrenceId: null, alertId };
  }

  const assetRow = tx.select().from(asset).where(eq(asset.id, assetId)).get();
  const assetName = assetRow?.name ?? input.entity.entityId;

  let procedureVersionId: string | null = null;
  if (rule.procedureId !== null) {
    const proc = tx.select().from(procedure).where(eq(procedure.id, rule.procedureId)).get();
    procedureVersionId = proc?.currentVersionId ?? null;
  }

  const occurrence = createConditionOccurrence(tx, ctx, {
    conditionRuleId: rule.id,
    conditionEpisodeId: episode.id,
    assetId,
    title: renderTitle(rule.titleTemplate, assetName, input.entity.entityId, input.value),
    dueDate: openLocalDate,
    priority: rule.priority as Priority,
    assignmentMode: rule.assignmentMode as AssignmentMode,
    assigneeUserId: rule.assigneeUserId,
    procedureVersionId,
  });

  tx.update(conditionEpisode)
    .set({ occurrenceId: occurrence.id })
    .where(eq(conditionEpisode.id, episode.id))
    .run();

  writeAudit(tx, ctx, {
    entityTable: "condition_episode",
    entityId: episode.id,
    action: "created",
    summary: `condition episode opened at ${input.value} % → occurrence ${occurrence.id}`,
  });

  return { action: "episode_opened", episodeId: episode.id, occurrenceId: occurrence.id, alertId: null };
}

/* -------------------------------------------------------------------------------------------------
 * Recovery (§6.5)
 * ---------------------------------------------------------------------------------------------- */

function closeRecovered(
  tx: Db,
  ctx: DomainContext,
  episode: ConditionEpisodeRow,
  value: number,
): { episodeId: string; occurrenceId: string | null } {
  const now = ctx.clock.now();

  tx.update(conditionEpisode)
    .set({ closedAtMs: now, closedValue: value, closeReason: "recovered" })
    .where(eq(conditionEpisode.id, episode.id))
    .run();

  const occurrenceId = episode.occurrenceId;
  if (occurrenceId !== null) {
    // The occurrence stays open. Recovery is not maintenance.
    writeOccurrenceEvent(tx, ctx, {
      occurrenceId,
      kind: "condition_recovered",
      reason: "recovered",
      detail: { value, episodeId: episode.id },
    });

    // Snoozed, never cleared: clearing would imply "done". Both recipients, and the rows are
    // created first in case the notification tick has not reached this task yet.
    const household = loadHousehold(tx);
    const untilMs = instantOf(
      addDaysLocal(localDateOf(now, ctx.tz), household.recoverySnoozeDays),
      household.deliveryTime,
      ctx.tz,
    );
    const occurrence = loadOccurrence(tx, occurrenceId);
    ensureRecipientStates(tx, ctx, occurrence);
    for (const state of recipientStatesOf(tx, occurrenceId)) {
      if (state.state === "cleared" || state.state === "suppressed") continue;
      snooze(tx, ctx, occurrenceId, state.recipientUserId, untilMs);
    }
  }

  writeAudit(tx, ctx, {
    entityTable: "condition_episode",
    entityId: episode.id,
    action: "updated",
    summary: `condition recovered at ${value} % — episode closed, task left open`,
    changes: { close_reason: [null, "recovered"] },
  });

  return { episodeId: episode.id, occurrenceId };
}

export interface CloseWithoutMaintenanceResult {
  occurrenceId: string;
  /** Episodes closed by this call (usually none — recovery already closed them). */
  closedEpisodeIds: string[];
}

/**
 * "Close without maintenance": the user says the battery is fine after all. `skip`, so history
 * reads honestly — no completion, no stock movement, no fabricated maintenance (§6.5 step 4).
 */
export function closeEpisodeWithoutMaintenance(
  handle: DbHandle,
  ctx: DomainContext,
  occurrenceId: string,
): CloseWithoutMaintenanceResult {
  return writeTx(handle.db, (tx) => {
    const now = ctx.clock.now();
    const closedEpisodeIds: string[] = [];
    for (const episode of tx
      .select()
      .from(conditionEpisode)
      .where(
        and(eq(conditionEpisode.occurrenceId, occurrenceId), isNull(conditionEpisode.closedAtMs)),
      )
      .all()) {
      tx.update(conditionEpisode)
        .set({ closedAtMs: now, closeReason: "manual" })
        .where(eq(conditionEpisode.id, episode.id))
        .run();
      closedEpisodeIds.push(episode.id);
    }

    skip(tx, ctx, occurrenceId, "condition_recovered");

    writeAudit(tx, ctx, {
      entityTable: "maintenance_occurrence",
      entityId: occurrenceId,
      action: "skipped",
      summary: "closed without maintenance after the reading recovered",
    });

    return { occurrenceId, closedEpisodeIds };
  });
}

/* -------------------------------------------------------------------------------------------------
 * Entity removal (§6.5 step 6)
 * ---------------------------------------------------------------------------------------------- */

export interface EntityRemovedResult {
  closedEpisodeIds: string[];
  /** Links moved to `link_state = 'missing'`. */
  missingLinkIds: string[];
  alertId: string | null;
  /** Occurrences deliberately left open — telemetry vanishing is not maintenance. */
  openOccurrenceIds: string[];
}

/**
 * The entity disappeared from the HA registry. The episode closes `entity_removed`, the links go
 * `missing`, an `app_alert('ha_link_missing')` is raised — and the occurrence stays open.
 */
export function onEntityRemoved(
  handle: DbHandle,
  ctx: DomainContext,
  entityRegistryId: string,
): EntityRemovedResult {
  return writeTx(handle.db, (tx) => {
    const now = ctx.clock.now();
    const entity = tx
      .select()
      .from(haEntity)
      .where(eq(haEntity.registryId, entityRegistryId))
      .get();
    if (!entity) throw new NotFoundError("ha_entity", entityRegistryId);

    if (entity.removedAtMs === null) {
      tx.update(haEntity)
        .set({ removedAtMs: now })
        .where(eq(haEntity.registryId, entityRegistryId))
        .run();
    }

    const closedEpisodeIds: string[] = [];
    const openOccurrenceIds: string[] = [];
    for (const episode of tx
      .select()
      .from(conditionEpisode)
      .where(
        and(
          eq(conditionEpisode.haEntityRegistryId, entityRegistryId),
          isNull(conditionEpisode.closedAtMs),
        ),
      )
      .all()) {
      tx.update(conditionEpisode)
        .set({ closedAtMs: now, closeReason: "entity_removed" })
        .where(eq(conditionEpisode.id, episode.id))
        .run();
      closedEpisodeIds.push(episode.id);
      if (episode.occurrenceId !== null) {
        const occurrence = tx
          .select()
          .from(maintenanceOccurrence)
          .where(eq(maintenanceOccurrence.id, episode.occurrenceId))
          .get();
        if (occurrence && (occurrence.status === "pending" || occurrence.status === "due")) {
          openOccurrenceIds.push(occurrence.id);
        }
      }
    }

    const missingLinkIds: string[] = [];
    for (const link of tx
      .select()
      .from(assetHaLink)
      .where(eq(assetHaLink.haEntityRegistryId, entityRegistryId))
      .all()) {
      tx.update(assetHaLink)
        .set({
          linkState: "missing",
          linkStateChangedAtMs: now,
          updatedAtMs: now,
          updatedBy: ctx.actorUserId,
        })
        .where(eq(assetHaLink.id, link.id))
        .run();
      missingLinkIds.push(link.id);
    }

    if (entity.deviceId !== null) {
      tx.update(haDevice)
        .set({ canonicalBatteryEntityId: null })
        .where(
          and(
            eq(haDevice.deviceId, entity.deviceId),
            eq(haDevice.canonicalBatteryEntityId, entityRegistryId),
          ),
        )
        .run();
    }

    const alertId = raiseAlert(tx, ctx, {
      kind: "ha_link_missing",
      severity: "warning",
      title: `${entity.entityId} is gone from Home Assistant`,
      body:
        "The entity was removed from the registry. Any open task was left open — telemetry " +
        "vanishing is not evidence that maintenance happened.",
      entityTable: "ha_entity",
      entityId: entityRegistryId,
      dedupeKey: `ha_link_missing:entity:${entityRegistryId}`,
    }).id;

    writeAudit(tx, ctx, {
      entityTable: "ha_entity",
      entityId: entityRegistryId,
      action: "updated",
      summary: `entity removed from the HA registry; ${closedEpisodeIds.length} episode(s) closed`,
    });

    return { closedEpisodeIds, missingLinkIds, alertId, openOccurrenceIds };
  });
}

/** Open episodes for an entity, newest first. */
export function openEpisodesFor(tx: Db, entityRegistryId: string): ConditionEpisodeRow[] {
  return tx
    .select()
    .from(conditionEpisode)
    .where(
      and(
        eq(conditionEpisode.haEntityRegistryId, entityRegistryId),
        isNull(conditionEpisode.closedAtMs),
      ),
    )
    .orderBy(sql`opened_at_ms DESC`)
    .all();
}
