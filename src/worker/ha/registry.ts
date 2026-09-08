/**
 * Pure normalisation, diffing and battery-entity selection for the HA registries.
 *
 * No I/O, no clock, no database: everything here is a function of its arguments, which is what
 * makes the awkward rules (identity precedence, rename detection, battery dedupe) cheap to test.
 * The persistence layer feeds these functions with `HaSocket`'s `'snapshot'` / `'registry'`
 * payloads and writes the results.
 *
 * References: docs/design-notes/domain-scheduling-inventory.md §6.2 (battery selection),
 * §6.3 (reading validity), §7.1 (cache columns), §7.2 (identity precedence).
 */
import type {
  HaAreaRegistryEntry,
  HaDeviceRegistryEntry,
  HaEntityRegistryEntry,
  HaFloorRegistryEntry,
  HaState,
} from "./protocol";

/* ---------------------------------------------------------------- identity */

/**
 * How an identity key was derived. `entity_id` is the last resort and is logged as weak by the
 * caller: HA lets the user rename an entity_id, so a link keyed on it silently breaks (§7.2).
 */
export type HaIdentitySource = "registry_id" | "platform_unique_id" | "entity_id";

export interface HaIdentity {
  /**
   * The value persisted as `ha_entity.registry_id`. Equal to HA's registry entry id whenever HA
   * supplies one (always, on 2026.x); the derived forms exist only so an odd record still gets a
   * stable primary key instead of being dropped.
   */
  identityKey: string;
  identitySource: HaIdentitySource;
}

/** Identity precedence: registry id -> (platform, unique_id) -> entity_id. */
export function entityIdentity(entry: {
  id?: string | null;
  platform?: string | null;
  unique_id?: string | null;
  entity_id: string;
}): HaIdentity {
  if (entry.id) return { identityKey: entry.id, identitySource: "registry_id" };
  if (entry.platform && entry.unique_id) {
    return {
      identityKey: `${entry.platform}:${entry.unique_id}`,
      identitySource: "platform_unique_id",
    };
  }
  return { identityKey: entry.entity_id, identitySource: "entity_id" };
}

/* -------------------------------------------------------------- normalised */

/** Marker for records `diffRegistry` can compare. */
export interface HaNormalizedRecord {
  identityKey: string;
  identitySource: HaIdentitySource;
}

export interface NormalizedEntity extends HaNormalizedRecord {
  /** HA's entity registry entry id, or null when HA did not supply one. */
  registryId: string | null;
  entityId: string;
  /** `sensor`, `binary_sensor`, `fan`, ... derived from the entity_id prefix. */
  domain: string;
  uniqueId: string | null;
  platform: string | null;
  configEntryId: string | null;
  deviceId: string | null;
  areaId: string | null;
  name: string | null;
  originalName: string | null;
  deviceClass: string | null;
  originalDeviceClass: string | null;
  unitOfMeasurement: string | null;
  entityCategory: string | null;
  disabledBy: string | null;
  hiddenBy: string | null;
  /** Kept verbatim: user unit/precision overrides live under `options["sensor"]`. */
  options: Record<string, unknown> | null;
}

export interface NormalizedDevice extends HaNormalizedRecord {
  deviceId: string;
  name: string | null;
  nameByUser: string | null;
  manufacturer: string | null;
  model: string | null;
  swVersion: string | null;
  hwVersion: string | null;
  areaId: string | null;
  viaDeviceId: string | null;
  /** 2026.9 child devices; a child legitimately has no manufacturer/model/firmware. */
  parentDeviceId: string | null;
  identifiers: [string, string][];
  connections: [string, string][];
  entryType: string | null;
  disabledBy: string | null;
  /** `primary_config_entry` -> `config_entry_id` -> first of the deprecated `config_entries`. */
  configEntryId: string | null;
}

export interface NormalizedArea extends HaNormalizedRecord {
  areaId: string;
  name: string;
  floorId: string | null;
  icon: string | null;
  aliases: string[];
}

export interface NormalizedFloor extends HaNormalizedRecord {
  floorId: string;
  name: string;
  level: number | null;
  icon: string | null;
  aliases: string[];
}

export interface NormalizedState {
  entityId: string;
  raw: string;
  attributes: Record<string, unknown>;
  lastChangedMs: number | null;
  lastUpdatedMs: number | null;
  lastReportedMs: number | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toMs(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function tuples(value: unknown): [string, string][] {
  if (!Array.isArray(value)) return [];
  const out: [string, string][] = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    out.push([String(pair[0]), String(pair[1])]);
  }
  return out;
}

export function normalizeEntity(entry: HaEntityRegistryEntry): NormalizedEntity {
  const identity = entityIdentity(entry);
  const dot = entry.entity_id.indexOf(".");
  return {
    ...identity,
    registryId: str(entry.id),
    entityId: entry.entity_id,
    domain: dot > 0 ? entry.entity_id.slice(0, dot) : entry.entity_id,
    uniqueId: str(entry.unique_id),
    platform: str(entry.platform),
    configEntryId: str(entry.config_entry_id),
    deviceId: str(entry.device_id),
    areaId: str(entry.area_id),
    name: str(entry.name),
    originalName: str(entry.original_name),
    deviceClass: str(entry.device_class),
    originalDeviceClass: str(entry.original_device_class),
    unitOfMeasurement: str(entry.unit_of_measurement),
    entityCategory: str(entry.entity_category),
    disabledBy: str(entry.disabled_by),
    hiddenBy: str(entry.hidden_by),
    options: entry.options ?? null,
  };
}

export function normalizeDevice(entry: HaDeviceRegistryEntry): NormalizedDevice {
  const deprecated = entry.config_entries?.find((id) => typeof id === "string" && id.length > 0);
  return {
    identityKey: entry.id,
    identitySource: "registry_id",
    deviceId: entry.id,
    name: str(entry.name),
    nameByUser: str(entry.name_by_user),
    manufacturer: str(entry.manufacturer),
    model: str(entry.model),
    swVersion: str(entry.sw_version),
    hwVersion: str(entry.hw_version),
    areaId: str(entry.area_id),
    viaDeviceId: str(entry.via_device_id),
    parentDeviceId: str(entry.parent_device_id),
    identifiers: tuples(entry.identifiers),
    connections: tuples(entry.connections),
    entryType: str(entry.entry_type),
    disabledBy: str(entry.disabled_by),
    configEntryId: str(entry.primary_config_entry) ?? str(entry.config_entry_id) ?? deprecated ?? null,
  };
}

export function normalizeArea(entry: HaAreaRegistryEntry): NormalizedArea {
  return {
    identityKey: entry.area_id,
    identitySource: "registry_id",
    areaId: entry.area_id,
    name: entry.name,
    floorId: str(entry.floor_id),
    icon: str(entry.icon),
    aliases: entry.aliases ?? [],
  };
}

export function normalizeFloor(entry: HaFloorRegistryEntry): NormalizedFloor {
  return {
    identityKey: entry.floor_id,
    identitySource: "registry_id",
    floorId: entry.floor_id,
    name: entry.name,
    level: typeof entry.level === "number" ? entry.level : null,
    icon: str(entry.icon),
    aliases: entry.aliases ?? [],
  };
}

export function normalizeState(state: HaState): NormalizedState {
  return {
    entityId: state.entity_id,
    raw: state.state,
    attributes: state.attributes,
    lastChangedMs: toMs(state.last_changed),
    lastUpdatedMs: toMs(state.last_updated),
    lastReportedMs: toMs(state.last_reported),
  };
}

function isNormalizedState(value: HaState | NormalizedState): value is NormalizedState {
  // HA records carry an index signature, so `in` alone does not narrow usefully.
  return typeof (value as Partial<NormalizedState>).entityId === "string";
}

/** Index states by entity_id for the lookups battery selection needs. */
export function indexStates(
  states: readonly (HaState | NormalizedState)[],
): Map<string, NormalizedState> {
  const map = new Map<string, NormalizedState>();
  for (const state of states) {
    const normalized = isNormalizedState(state) ? state : normalizeState(state);
    map.set(normalized.entityId, normalized);
  }
  return map;
}

/* -------------------------------------------------------------------- diff */

export interface RegistryChange<T> {
  prev: T;
  next: T;
  /** Names of the normalised fields whose values differ. */
  fields: string[];
}

export interface RegistryRename<T> extends RegistryChange<T> {
  from: string;
  to: string;
}

export interface RegistryDiff<T> {
  added: T[];
  removed: T[];
  /**
   * Same identity (a real registry id), different `renameKey`. Nothing breaks on a rename because
   * every link is keyed on the registry id, but the user is told (§7.2). A renamed record is
   * reported here only — it is not repeated in `changed`, and `fields` carries its other edits too.
   */
  renamed: RegistryRename<T>[];
  changed: RegistryChange<T>[];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function changedFields<T extends object>(prev: T, next: T): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const fields: string[] = [];
  for (const key of keys) {
    const a = (prev as Record<string, unknown>)[key];
    const b = (next as Record<string, unknown>)[key];
    if (!sameValue(a, b)) fields.push(key);
  }
  return fields.sort();
}

/**
 * Compare two normalised registry listings.
 *
 * `removed` means "present before, absent now" — the caller soft-deletes (sets `removed_at_ms`)
 * and never hard-deletes, because links point at these rows.
 */
export function diffRegistry<T extends HaNormalizedRecord>(
  prev: readonly T[],
  next: readonly T[],
  options?: { renameKey?: string },
): RegistryDiff<T> {
  const renameKey = options?.renameKey ?? "entityId";
  const prevByKey = new Map(prev.map((record) => [record.identityKey, record]));
  const nextByKey = new Map(next.map((record) => [record.identityKey, record]));

  const diff: RegistryDiff<T> = { added: [], removed: [], renamed: [], changed: [] };

  for (const record of next) {
    const before = prevByKey.get(record.identityKey);
    if (!before) {
      diff.added.push(record);
      continue;
    }
    const fields = changedFields(before, record);
    if (fields.length === 0) continue;
    const from = (before as Record<string, unknown>)[renameKey];
    const to = (record as Record<string, unknown>)[renameKey];
    // A rename is only a rename when the identity is HA's own registry id. Matching on
    // (platform, unique_id) or on the entity_id itself cannot distinguish rename from replacement.
    if (
      fields.includes(renameKey) &&
      record.identitySource === "registry_id" &&
      before.identitySource === "registry_id" &&
      typeof from === "string" &&
      typeof to === "string"
    ) {
      diff.renamed.push({ prev: before, next: record, fields, from, to });
    } else {
      diff.changed.push({ prev: before, next: record, fields });
    }
  }

  for (const record of prev) {
    if (!nextByKey.has(record.identityKey)) diff.removed.push(record);
  }

  return diff;
}

/* ---------------------------------------------------------------- batteries */

/** Entity ids that look like a battery level but never are (§6.2 step 2). */
const NON_LEVEL_SUFFIX = /(_battery_type|_battery_voltage|_battery_state|_battery_plugged)(_\d+)?$/;
const BATTERY_TYPE_SUFFIX = /_battery_type(_\d+)?$/;
const BATTERY_LEVEL_SUFFIX = /_battery(_level)?(_\d+)?$/;
const EXCLUDED_DEVICE_CLASSES = new Set(["voltage", "enum"]);
const EXCLUDED_UNITS = new Set(["v", "mv"]);

/** Reasons a candidate was rejected. Useful in logs and in `/settings/system`. */
export type BatteryRejectReason =
  | "not_battery_device_class"
  | "not_percent_unit"
  | "disabled_or_hidden"
  | "no_device"
  | "excluded_device_class"
  | "excluded_unit"
  | "excluded_entity_id"
  | "non_numeric_state";

export interface BatteryRejection {
  entity: NormalizedEntity;
  reason: BatteryRejectReason;
}

export interface BatterySelection {
  /** deviceId -> entity registry id of the one entity that means "battery level". */
  canonicalByDevice: Map<string, string>;
  /**
   * deviceId -> entity registry id of the `_battery_type` sensor (state `"AAA"`).
   * Never a level signal; it is read to suggest `asset_consumable.part_id` (§6.2).
   */
  batteryTypeEntityByDevice: Map<string, string>;
  /** Every candidate that was dropped, with the rule that dropped it. */
  rejected: BatteryRejection[];
}

/**
 * Effective device_class / unit for an entity.
 *
 * `config/entity_registry/list` does not reliably carry either: a user override lands in
 * `options["sensor"]`, and otherwise only the state's attributes have them. Resolution order is
 * registry field -> registry override -> state attributes.
 */
export function resolveEntityMeta(
  entity: NormalizedEntity,
  state?: NormalizedState,
): { deviceClass: string | null; unit: string | null } {
  const sensorOptions = entity.options?.["sensor"];
  const optionUnit =
    sensorOptions && typeof sensorOptions === "object"
      ? str((sensorOptions as Record<string, unknown>)["unit_of_measurement"])
      : null;
  const attributes = state?.attributes ?? {};
  return {
    deviceClass:
      entity.deviceClass ??
      entity.originalDeviceClass ??
      str(attributes["device_class"]) ??
      null,
    unit:
      entity.unitOfMeasurement ?? optionUnit ?? str(attributes["unit_of_measurement"]) ?? null,
  };
}

const TRANSIENT_STATES = new Set(["unknown", "unavailable", "none", ""]);

interface Candidate {
  entity: NormalizedEntity;
  deviceId: string;
  /** True when the latest state parses as a number, i.e. the entity is proven to be a level. */
  verified: boolean;
}

/**
 * Pick the one entity per device that means "battery level" (§6.2).
 *
 * Candidates: `device_class = battery` and unit `%`, not disabled or hidden, attached to a device.
 * Hard exclusions: `voltage`/`enum` device classes, `V`/`mV` units, `_battery_type` /
 * `_battery_voltage` / `_battery_state` / `_battery_plugged` entity ids, and a latest state that
 * is a real non-numeric value (this is what filters the `"AAA"` battery-type sensor even when it
 * is mislabelled).
 *
 * A state of `unknown`/`unavailable`/missing is *not* a hard exclusion: it is transient, and
 * excluding on it would make the canonical entity flap on every reconnect (each change is
 * audited). Such candidates rank below any verified one instead.
 *
 * Ranking: manual override -> verified before unverified -> `_battery` suffix ->
 * shortest entity_id -> lowest registry id.
 *
 * @param overrides deviceId -> entity registry id, from `asset_ha_link` rows with
 *                  `role='battery_level'`. An override wins outright, even against these rules.
 */
export function selectCanonicalBatteryEntities(
  entities: readonly NormalizedEntity[],
  states: ReadonlyMap<string, NormalizedState> | readonly (HaState | NormalizedState)[],
  overrides?: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): BatterySelection {
  const stateMap: ReadonlyMap<string, NormalizedState> = Array.isArray(states)
    ? indexStates(states)
    : (states as ReadonlyMap<string, NormalizedState>);
  const overrideMap: ReadonlyMap<string, string> =
    overrides instanceof Map
      ? overrides
      : new Map(Object.entries((overrides ?? {}) as Record<string, string>));

  const rejected: BatteryRejection[] = [];
  const byDevice = new Map<string, Candidate[]>();
  const batteryTypeEntityByDevice = new Map<string, string>();
  const byIdentity = new Map<string, NormalizedEntity>();

  for (const entity of entities) {
    byIdentity.set(entity.identityKey, entity);
    const meta = resolveEntityMeta(entity, stateMap.get(entity.entityId));

    if (entity.deviceId && BATTERY_TYPE_SUFFIX.test(entity.entityId)) {
      // Not a level, but it tells us the chemistry/size — keep it for part suggestions.
      batteryTypeEntityByDevice.set(entity.deviceId, entity.identityKey);
    }

    // Suffix exclusions come first so the recorded reason names the rule that actually applies.
    if (NON_LEVEL_SUFFIX.test(entity.entityId)) {
      rejected.push({ entity, reason: "excluded_entity_id" });
      continue;
    }
    if (meta.deviceClass !== "battery") {
      if (BATTERY_LEVEL_SUFFIX.test(entity.entityId)) {
        rejected.push({ entity, reason: "not_battery_device_class" });
      }
      continue;
    }
    if (entity.disabledBy || entity.hiddenBy) {
      rejected.push({ entity, reason: "disabled_or_hidden" });
      continue;
    }
    if (!entity.deviceId) {
      rejected.push({ entity, reason: "no_device" });
      continue;
    }
    if (EXCLUDED_DEVICE_CLASSES.has(meta.deviceClass)) {
      rejected.push({ entity, reason: "excluded_device_class" });
      continue;
    }
    if (meta.unit && EXCLUDED_UNITS.has(meta.unit.toLowerCase())) {
      rejected.push({ entity, reason: "excluded_unit" });
      continue;
    }
    if (meta.unit !== "%") {
      rejected.push({ entity, reason: "not_percent_unit" });
      continue;
    }

    const state = stateMap.get(entity.entityId);
    const raw = state?.raw?.trim().toLowerCase();
    const transient = raw === undefined || TRANSIENT_STATES.has(raw);
    const numeric = state !== undefined && !transient && isNumericState(state.raw);
    if (!transient && !numeric) {
      rejected.push({ entity, reason: "non_numeric_state" });
      continue;
    }

    const list = byDevice.get(entity.deviceId) ?? [];
    list.push({ entity, deviceId: entity.deviceId, verified: numeric });
    byDevice.set(entity.deviceId, list);
  }

  const canonicalByDevice = new Map<string, string>();

  // Manual overrides win outright, and may name an entity these rules would have rejected.
  for (const [deviceId, identityKey] of overrideMap) {
    if (byIdentity.has(identityKey)) canonicalByDevice.set(deviceId, identityKey);
  }

  for (const [deviceId, candidates] of byDevice) {
    if (canonicalByDevice.has(deviceId)) continue;
    const best = [...candidates].sort(compareCandidates)[0];
    if (best) canonicalByDevice.set(deviceId, best.entity.identityKey);
  }

  return { canonicalByDevice, batteryTypeEntityByDevice, rejected };
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.verified !== b.verified) return a.verified ? -1 : 1;
  const aSuffix = BATTERY_LEVEL_SUFFIX.test(a.entity.entityId) ? 0 : 1;
  const bSuffix = BATTERY_LEVEL_SUFFIX.test(b.entity.entityId) ? 0 : 1;
  if (aSuffix !== bSuffix) return aSuffix - bSuffix;
  if (a.entity.entityId.length !== b.entity.entityId.length) {
    return a.entity.entityId.length - b.entity.entityId.length;
  }
  return a.entity.identityKey < b.entity.identityKey ? -1 : a.entity.identityKey > b.entity.identityKey ? 1 : 0;
}

function isNumericState(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  return Number.isFinite(Number(trimmed));
}

/* --------------------------------------------------------- reading validity */

export type BatteryInvalidReason =
  | "unknown"
  | "unavailable"
  | "empty"
  | "non_numeric"
  | "out_of_range";

export interface BatteryReading {
  valid: boolean;
  /** Present only when `valid`. Never 0 as a stand-in for "no reading" (hard rule #8). */
  value?: number;
  invalidReason?: BatteryInvalidReason;
  /** `now - lastUpdated > staleHours`. A stale reading opens and closes nothing (§6.3). */
  stale: boolean;
}

/**
 * Classify one raw battery state.
 *
 * `unknown` / `unavailable` / `""` / `"AAA"` are **not** 0 % — they are the absence of a reading.
 * Treating them as 0 would invent low-battery tasks out of connectivity blips, which is exactly
 * what hard rule #8 forbids.
 */
export function classifyBatteryReading(
  raw: string | null | undefined,
  lastUpdatedMs: number | null | undefined,
  nowMs: number,
  staleHours: number,
): BatteryReading {
  const stale =
    typeof lastUpdatedMs !== "number" || !Number.isFinite(lastUpdatedMs)
      ? true
      : nowMs - lastUpdatedMs > staleHours * 3_600_000;

  if (raw === null || raw === undefined) {
    return { valid: false, invalidReason: "empty", stale };
  }
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length === 0) return { valid: false, invalidReason: "empty", stale };
  if (lower === "unavailable") return { valid: false, invalidReason: "unavailable", stale };
  if (lower === "unknown" || lower === "none") {
    return { valid: false, invalidReason: "unknown", stale };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { valid: false, invalidReason: "non_numeric", stale };
  if (value < 0 || value > 100) return { valid: false, invalidReason: "out_of_range", stale };
  return { valid: true, value, stale };
}
