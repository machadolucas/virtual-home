/**
 * The latest-state cache: `ha_entity_state`.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §7.1 ("identities only — no telemetry
 * history"). HA already stores history; copying it here would make the database grow at HA's event
 * rate for no benefit. We keep exactly one row per entity we care about, with only the attributes
 * the UI reads.
 *
 * "Care about" is `interestingEntityIds()`: entities an asset links to, the canonical battery
 * entity of every device, and entities an enabled condition rule watches. The household instance
 * has ~3300 entities and a handful of links, so this filter is the difference between a 40-row
 * table and a 3300-row one — and between one outbox row per real change and one per HA event.
 *
 * States are stored **verbatim**, `unknown`/`unavailable` included (CLAUDE.md rule 8): they are
 * the absence of a reading, not a value. Interpretation belongs to `classifyBatteryReading`.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { assetHaLink } from "@/db/schema/assets";
import { haDevice, haEntity, haEntityState } from "@/db/schema/ha";
import { conditionRule } from "@/db/schema/ha";
import { normalizeState, type NormalizedState } from "@/worker/ha/registry";
import type { HaState, HaStateChangedData } from "@/worker/ha/protocol";

/**
 * The only attributes we persist. `battery_level` / `battery` / `battery_type` are here because
 * `src/house/store/haSse.ts` renders them straight onto the 3D markers; everything else HA sends
 * (and some entities send kilobytes) is dropped.
 */
export const KEPT_ATTRIBUTES: readonly string[] = [
  "friendly_name",
  "unit_of_measurement",
  "device_class",
  "battery_level",
  "battery",
  "battery_type",
  "current_temperature",
  "temperature",
  "target_temp_low",
  "target_temp_high",
  "temperature_unit",
  "hvac_action",
  "fan_mode",
  "brightness",
  "rgb_color",
  "hs_color",
  "color_temp_kelvin",
  "color_temp_mireds",
  "color_temp",
  "supported_color_modes",
  "min_color_temp_kelvin",
  "max_color_temp_kelvin",
];

/** Link states that still mean "this link points at something real". */
const LIVE_LINK_STATES = ["active", "renamed"] as const;

export interface HaStateRecord {
  entityId: string;
  registryId: string | null;
  state: string;
  attributes: Record<string, unknown>;
  lastChangedMs: number;
  lastUpdatedMs: number;
  observedAtMs: number;
}

export interface ApplyStatesOptions {
  /** Default true. `false` is only for a deliberate full-instance dump. */
  onlyInteresting?: boolean;
}

export interface StateChangeOutcome {
  entityId: string;
  interesting: boolean;
  /** Null when the entity was removed (`new_state === null`) or the change was skipped. */
  record: HaStateRecord | null;
  removed: boolean;
}

/* --------------------------------------------------------------- selections */

/** Entity ids an asset links to directly, or through a device-level link. */
function linkedEntityIds(tx: Db): string[] {
  const direct = tx
    .select({ entityId: haEntity.entityId })
    .from(assetHaLink)
    .innerJoin(haEntity, eq(haEntity.registryId, assetHaLink.haEntityRegistryId))
    .where(
      and(
        isNotNull(assetHaLink.haEntityRegistryId),
        inArray(assetHaLink.linkState, [...LIVE_LINK_STATES]),
        isNull(haEntity.removedAtMs),
      ),
    )
    .all();

  // A device-level link means "this asset *is* that device", so all of its entities are in scope.
  const viaDevice = tx
    .select({ entityId: haEntity.entityId })
    .from(assetHaLink)
    .innerJoin(haEntity, eq(haEntity.deviceId, assetHaLink.haDeviceId))
    .where(
      and(
        isNotNull(assetHaLink.haDeviceId),
        inArray(assetHaLink.linkState, [...LIVE_LINK_STATES]),
        isNull(haEntity.removedAtMs),
      ),
    )
    .all();

  return [...direct, ...viaDevice].map((row) => row.entityId);
}

function canonicalBatteryEntityIds(tx: Db): string[] {
  return tx
    .select({ entityId: haEntity.entityId })
    .from(haDevice)
    .innerJoin(haEntity, eq(haEntity.registryId, haDevice.canonicalBatteryEntityId))
    .where(and(isNotNull(haDevice.canonicalBatteryEntityId), isNull(haEntity.removedAtMs)))
    .all()
    .map((row) => row.entityId);
}

function conditionRuleEntityIds(tx: Db): string[] {
  return tx
    .select({ entityId: haEntity.entityId })
    .from(conditionRule)
    .innerJoin(haEntity, eq(haEntity.registryId, conditionRule.haEntityRegistryId))
    .where(
      and(
        isNotNull(conditionRule.haEntityRegistryId),
        eq(conditionRule.enabled, true),
        isNull(haEntity.removedAtMs),
      ),
    )
    .all()
    .map((row) => row.entityId);
}

/** Outdoor readings are a small, opt-in viewer source set and must stay live before selection. */
function environmentalEntityIds(tx: Db): string[] {
  return tx
    .select({ entityId: haEntity.entityId })
    .from(haEntity)
    .leftJoin(haDevice, eq(haDevice.deviceId, haEntity.deviceId))
    .where(
      and(
        isNull(haEntity.removedAtMs),
        isNull(haEntity.disabledBy),
        isNull(haEntity.hiddenBy),
        isNull(haDevice.removedAtMs),
        isNull(haDevice.disabledBy),
        sql`((${haEntity.deviceClass} = 'illuminance' AND (${haEntity.unitOfMeasurement} IS NULL OR lower(trim(${haEntity.unitOfMeasurement})) IN ('lx', 'lux', 'klx', 'klux'))) OR ${haEntity.domain} = 'weather')`,
      ),
    )
    .all()
    .map((row) => row.entityId);
}

/**
 * Every entity whose state we persist and publish: linked (directly or via a device link),
 * canonical battery, or watched by an enabled condition rule.
 */
export function interestingEntityIds(tx: Db): Set<string> {
  return new Set([
    ...linkedEntityIds(tx),
    ...canonicalBatteryEntityIds(tx),
    ...conditionRuleEntityIds(tx),
    ...environmentalEntityIds(tx),
  ]);
}

/**
 * The subset a fresh page load needs in order to render: linked entities and canonical battery
 * entities. Condition-rule entities are engine inputs, not markers, so they stay out of the
 * `hello` frame.
 */
export function renderableEntityIds(tx: Db): Set<string> {
  return new Set([
    ...linkedEntityIds(tx),
    ...canonicalBatteryEntityIds(tx),
    ...environmentalEntityIds(tx),
  ]);
}

/* ------------------------------------------------------------------- writes */

function pickAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KEPT_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** entity_id -> registry_id for the live registry rows. One query, used for the FK column. */
function registryIdByEntityId(tx: Db): Map<string, string> {
  const rows = tx
    .select({ entityId: haEntity.entityId, registryId: haEntity.registryId })
    .from(haEntity)
    .where(isNull(haEntity.removedAtMs))
    .all();
  return new Map(rows.map((row) => [row.entityId, row.registryId]));
}

function toRecord(
  normalized: NormalizedState,
  registryId: string | null,
  nowMs: number,
): HaStateRecord {
  return {
    entityId: normalized.entityId,
    registryId,
    state: normalized.raw,
    attributes: pickAttributes(normalized.attributes),
    // HA omits the timestamps on synthetic states; "when we saw it" is the honest fallback.
    lastChangedMs: normalized.lastChangedMs ?? nowMs,
    lastUpdatedMs: normalized.lastUpdatedMs ?? normalized.lastChangedMs ?? nowMs,
    observedAtMs: nowMs,
  };
}

function upsert(tx: Db, record: HaStateRecord): void {
  const values = {
    entityId: record.entityId,
    registryId: record.registryId,
    state: record.state,
    attributesJson:
      Object.keys(record.attributes).length === 0 ? null : JSON.stringify(record.attributes),
    lastChangedMs: record.lastChangedMs,
    lastUpdatedMs: record.lastUpdatedMs,
    observedAtMs: record.observedAtMs,
  };
  tx.insert(haEntityState)
    .values(values)
    .onConflictDoUpdate({ target: haEntityState.entityId, set: values })
    .run();
}

/** `applyStates` inside the caller's transaction. Returns the rows actually written. */
export function applyStatesTx(
  tx: Db,
  states: readonly (HaState | NormalizedState)[],
  nowMs: number,
  options: ApplyStatesOptions = {},
): HaStateRecord[] {
  const onlyInteresting = options.onlyInteresting ?? true;
  const wanted = onlyInteresting ? interestingEntityIds(tx) : null;
  const registryIds = registryIdByEntityId(tx);

  const written: HaStateRecord[] = [];
  for (const state of states) {
    const normalized =
      typeof (state as NormalizedState).entityId === "string"
        ? (state as NormalizedState)
        : normalizeState(state as HaState);
    if (wanted && !wanted.has(normalized.entityId)) continue;
    const record = toRecord(normalized, registryIds.get(normalized.entityId) ?? null, nowMs);
    upsert(tx, record);
    written.push(record);
  }
  return written;
}

/**
 * Persist a batch of states (a reconnect snapshot, typically). Returns the rows written — i.e.
 * the interesting ones, unless `onlyInteresting: false`.
 */
export function applyStates(
  handle: DbHandle,
  states: readonly (HaState | NormalizedState)[],
  nowMs: number,
  options: ApplyStatesOptions = {},
): HaStateRecord[] {
  if (states.length === 0) return [];
  return writeTx(handle.db, (tx) => applyStatesTx(tx, states, nowMs, options));
}

/** `applyStateChanged` inside the caller's transaction, with the detail the bridge needs. */
export function applyStateChangedTx(
  tx: Db,
  event: HaStateChangedData,
  nowMs: number,
  wanted?: ReadonlySet<string>,
): StateChangeOutcome {
  const entityId = event.entity_id;
  const interesting = (wanted ?? interestingEntityIds(tx)).has(entityId);
  if (!interesting) return { entityId, interesting: false, record: null, removed: false };

  const next = event.new_state ?? null;
  if (next === null) {
    // The entity was removed from HA. Drop the cached row rather than inventing 'unavailable'.
    tx.delete(haEntityState).where(eq(haEntityState.entityId, entityId)).run();
    return { entityId, interesting: true, record: null, removed: true };
  }

  const registryId =
    tx
      .select({ registryId: haEntity.registryId })
      .from(haEntity)
      .where(and(eq(haEntity.entityId, entityId), isNull(haEntity.removedAtMs)))
      .get()?.registryId ?? null;

  const record = toRecord(normalizeState(next), registryId, nowMs);
  upsert(tx, record);
  return { entityId, interesting: true, record, removed: false };
}

/**
 * Apply one `state_changed` event. Returns whether the entity was interesting — an uninteresting
 * event is not persisted and not published, which is how a 3300-entity instance stays quiet.
 */
export function applyStateChanged(
  handle: DbHandle,
  event: HaStateChangedData,
  nowMs: number,
): boolean {
  return writeTx(handle.db, (tx) => applyStateChangedTx(tx, event, nowMs).interesting);
}

/* -------------------------------------------------------------------- reads */

/** Cached states, all of them or just `entityIds`. */
export function readSnapshot(tx: Db, entityIds?: Iterable<string>): HaStateRecord[] {
  const ids = entityIds === undefined ? null : [...entityIds];
  if (ids !== null && ids.length === 0) return [];

  const rows = ids === null
    ? tx.select().from(haEntityState).orderBy(haEntityState.entityId).all()
    : tx
        .select()
        .from(haEntityState)
        .where(inArray(haEntityState.entityId, ids))
        .orderBy(haEntityState.entityId)
        .all();

  return rows.map((row) => ({
    entityId: row.entityId,
    registryId: row.registryId,
    state: row.state,
    attributes: parseAttributes(row.attributesJson),
    lastChangedMs: row.lastChangedMs,
    lastUpdatedMs: row.lastUpdatedMs,
    observedAtMs: row.observedAtMs,
  }));
}

export interface CanonicalBatteryState {
  deviceId: string;
  registryId: string;
  entityId: string;
  state: string | null;
  lastUpdatedMs: number | null;
}

/**
 * The canonical battery entity of every live device, with its latest cached state. The worker
 * feeds these into the (domain-owned) condition engine through an injected callback.
 */
export function readCanonicalBatteryStates(tx: Db): CanonicalBatteryState[] {
  return tx
    .select({
      deviceId: haDevice.deviceId,
      registryId: haEntity.registryId,
      entityId: haEntity.entityId,
      state: haEntityState.state,
      lastUpdatedMs: haEntityState.lastUpdatedMs,
    })
    .from(haDevice)
    .innerJoin(haEntity, eq(haEntity.registryId, haDevice.canonicalBatteryEntityId))
    .leftJoin(haEntityState, eq(haEntityState.entityId, haEntity.entityId))
    .where(
      and(
        isNotNull(haDevice.canonicalBatteryEntityId),
        isNull(haDevice.removedAtMs),
        isNull(haEntity.removedAtMs),
      ),
    )
    .all();
}

/** Delete cached rows for entities no longer interesting. Housekeeping after a link is removed. */
export function pruneUninterestingStates(handle: DbHandle): number {
  return writeTx(handle.db, (tx) => {
    const wanted = interestingEntityIds(tx);
    const existing = tx.select({ entityId: haEntityState.entityId }).from(haEntityState).all();
    const stale = existing.map((row) => row.entityId).filter((id) => !wanted.has(id));
    if (stale.length === 0) return 0;
    const result = tx.delete(haEntityState).where(inArray(haEntityState.entityId, stale)).run();
    return Number(result.changes ?? 0);
  });
}

/** How many rows the cache holds. Used by `integration_status.entity_count`. */
export function countCachedStates(tx: Db): number {
  const row = tx.select({ n: sql<number>`count(*)` }).from(haEntityState).get();
  return row?.n ?? 0;
}

function parseAttributes(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
