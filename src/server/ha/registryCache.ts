/**
 * Persistence for the HA registry cache: floors, areas, devices, entities, renames, removals,
 * canonical battery entities, and the `ha_sync_run` bookkeeping row.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §6.2 and §7; `docs/home-assistant.md`.
 * The pure parts (normalisation, `diffRegistry`, battery selection) live in `src/worker/ha/registry`
 * and are unit-tested there; this module is the SQL around them.
 *
 * Rules this file exists to enforce:
 *  - **Soft delete only.** A registry row that disappears from HA gets `removed_at_ms`; links point
 *    at these rows and hard-deleting them would cascade real household data away.
 *  - **Renames break nothing.** Links store the registry id, so a rename updates the cached
 *    `entity_id`, records `ha_entity_rename`, refreshes `asset_ha_link.entity_id_snapshot`, and
 *    raises an *informational* alert.
 *  - **Removals are loud.** Every referencing link goes `link_state='missing'` and raises a
 *    warning naming the asset, because silence here looks exactly like "the sensor is fine".
 *  - **One transaction per sync.** The web must never observe a half-updated registry.
 *
 * The one deliberate automation: when the *same registry id* reappears, the row is resurrected and
 * its links go back to `active`. That is not the "replacement" case §7.2 forbids automating — the
 * identity is unchanged, so no physical-identity claim is being made on the owner's behalf.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import { asset, assetHaLink } from "@/db/schema/assets";
import { auditLog } from "@/db/schema/household";
import {
  haArea,
  haDevice,
  haEntity,
  haEntityRename,
  haEntityState,
  haFloor,
  haSyncRun,
} from "@/db/schema/ha";
import { appAlert } from "@/db/schema/inventory";
import { location, locationMapping } from "@/db/schema/model";
import type {
  HaAreaRegistryEntry,
  HaDeviceRegistryEntry,
  HaEntityRegistryEntry,
  HaFloorRegistryEntry,
  HaState,
} from "@/worker/ha/protocol";
import {
  diffRegistry,
  indexStates,
  normalizeArea,
  normalizeDevice,
  normalizeEntity,
  normalizeFloor,
  selectCanonicalBatteryEntities,
  type HaIdentitySource,
  type HaNormalizedRecord,
  type NormalizedEntity,
  type NormalizedState,
} from "@/worker/ha/registry";
import type { HaRegistryName } from "@/worker/ha/protocol";

/** A rename key no record has, so `diffRegistry` reports every edit as `changed`. */
const NO_RENAME_KEY = "__no_rename__";

/** Link states a sync may transition automatically. `retired`/`replaced` are human decisions. */
const AUTOMATIC_LINK_STATES = ["active", "renamed"] as const;

export interface SyncCounters {
  floorsSeen: number;
  areasSeen: number;
  devicesSeen: number;
  entitiesSeen: number;
  additionsDetected: number;
  removalsDetected: number;
  renamesDetected: number;
  /** Rows resurrected because the same registry id came back. */
  resurrectionsDetected: number;
  /** `asset_ha_link` rows moved to `missing` by this run. */
  linksMarkedMissing: number;
  /** `ha_device.canonical_battery_entity_id` values this run changed. */
  canonicalBatteryChanges: number;
}

export interface SyncResult extends SyncCounters {
  syncRunId: string;
}

function emptyCounters(): SyncCounters {
  return {
    floorsSeen: 0,
    areasSeen: 0,
    devicesSeen: 0,
    entitiesSeen: 0,
    additionsDetected: 0,
    removalsDetected: 0,
    renamesDetected: 0,
    resurrectionsDetected: 0,
    linksMarkedMissing: 0,
    canonicalBatteryChanges: 0,
  };
}

/* ------------------------------------------------------- cached record shapes */

/**
 * The projections `diffRegistry` compares: exactly the columns we persist, so a "changed" record
 * means something we store actually differs (and not that HA added a field we ignore).
 */
interface FloorRecord extends HaNormalizedRecord {
  floorId: string;
  name: string;
  level: number | null;
  icon: string | null;
}

interface AreaRecord extends HaNormalizedRecord {
  areaId: string;
  name: string;
  floorId: string | null;
  icon: string | null;
  aliasesJson: string | null;
}

interface DeviceRecord extends HaNormalizedRecord {
  deviceId: string;
  name: string | null;
  nameByUser: string | null;
  manufacturer: string | null;
  model: string | null;
  swVersion: string | null;
  hwVersion: string | null;
  areaId: string | null;
  viaDeviceId: string | null;
  identifiersJson: string | null;
  connectionsJson: string | null;
  entryType: string | null;
  disabledBy: string | null;
}

interface EntityRecord extends HaNormalizedRecord {
  registryId: string;
  entityId: string;
  uniqueId: string | null;
  platform: string | null;
  configEntryId: string | null;
  deviceId: string | null;
  areaId: string | null;
  domain: string;
  deviceClass: string | null;
  originalDeviceClass: string | null;
  unitOfMeasurement: string | null;
  name: string | null;
  originalName: string | null;
  entityCategory: string | null;
  disabledBy: string | null;
  hiddenBy: string | null;
}

/**
 * How a stored `registry_id` was derived. We do not persist `identity_source`, but the derivation
 * is deterministic (`entityIdentity`), so it can be read back — and `diffRegistry` needs it to
 * tell a rename from a replacement.
 */
function identitySourceOf(
  registryId: string,
  entityId: string,
  platform: string | null,
  uniqueId: string | null,
): HaIdentitySource {
  if (platform && uniqueId && registryId === `${platform}:${uniqueId}`) {
    return "platform_unique_id";
  }
  if (registryId === entityId) return "entity_id";
  return "registry_id";
}

/* ------------------------------------------------------------------- helpers */

function jsonOrNull(value: unknown[]): string | null {
  return value.length === 0 ? null : JSON.stringify(value);
}

interface AlertInput {
  kind: "ha_entity_renamed" | "ha_link_missing";
  severity: "info" | "warning";
  entityTable: string;
  entityId: string;
  title: string;
  body?: string | null;
  dedupeKey: string;
}

/**
 * Raise (or re-raise) an alert. The partial unique index on `dedupe_key WHERE resolved_at_ms IS
 * NULL` is what turns a repeat into `seen_count + 1` instead of a second row of noise.
 */
function raiseAlert(tx: Db, input: AlertInput, nowMs: number): void {
  tx.insert(appAlert)
    .values({
      id: newId(),
      kind: input.kind,
      severity: input.severity,
      entityTable: input.entityTable,
      entityId: input.entityId,
      title: input.title,
      body: input.body ?? null,
      dedupeKey: input.dedupeKey,
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      seenCount: 1,
    })
    .onConflictDoUpdate({
      target: appAlert.dedupeKey,
      targetWhere: sql`resolved_at_ms IS NULL`,
      set: { lastSeenAtMs: nowMs, seenCount: sql`${appAlert.seenCount} + 1` },
    })
    .run();
}

/** Resolve an open alert by dedupe key — used when the thing it complained about comes back. */
function resolveAlert(tx: Db, dedupeKey: string, nowMs: number): void {
  tx.update(appAlert)
    .set({ resolvedAtMs: nowMs })
    .where(and(eq(appAlert.dedupeKey, dedupeKey), isNull(appAlert.resolvedAtMs)))
    .run();
}

function writeAudit(
  tx: Db,
  input: { entityTable: string; entityId: string; action: string; summary: string; changes?: unknown },
  nowMs: number,
): void {
  tx.insert(auditLog)
    .values({
      id: newId(),
      atMs: nowMs,
      actorKind: "worker",
      entityTable: input.entityTable,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary,
      changesJson: input.changes === undefined ? null : JSON.stringify(input.changes),
    })
    .run();
}

function linkMissingDedupeKey(linkId: string): string {
  return `ha_link_missing:${linkId}`;
}

interface LinkRow {
  id: string;
  assetId: string;
  assetName: string;
  linkState: string;
  entityIdSnapshot: string | null;
}

function linksForEntity(tx: Db, registryId: string): LinkRow[] {
  return tx
    .select({
      id: assetHaLink.id,
      assetId: assetHaLink.assetId,
      assetName: asset.name,
      linkState: assetHaLink.linkState,
      entityIdSnapshot: assetHaLink.entityIdSnapshot,
    })
    .from(assetHaLink)
    .innerJoin(asset, eq(asset.id, assetHaLink.assetId))
    .where(eq(assetHaLink.haEntityRegistryId, registryId))
    .all();
}

function linksForDevice(tx: Db, deviceId: string): LinkRow[] {
  return tx
    .select({
      id: assetHaLink.id,
      assetId: assetHaLink.assetId,
      assetName: asset.name,
      linkState: assetHaLink.linkState,
      entityIdSnapshot: assetHaLink.entityIdSnapshot,
    })
    .from(assetHaLink)
    .innerJoin(asset, eq(asset.id, assetHaLink.assetId))
    .where(eq(assetHaLink.haDeviceId, deviceId))
    .all();
}

function markLinksMissing(
  tx: Db,
  links: readonly LinkRow[],
  label: string,
  nowMs: number,
  counters: SyncCounters,
): void {
  for (const link of links) {
    if (!AUTOMATIC_LINK_STATES.includes(link.linkState as (typeof AUTOMATIC_LINK_STATES)[number])) {
      continue;
    }
    tx.update(assetHaLink)
      .set({ linkState: "missing", linkStateChangedAtMs: nowMs, updatedAtMs: nowMs })
      .where(eq(assetHaLink.id, link.id))
      .run();
    counters.linksMarkedMissing += 1;
    raiseAlert(
      tx,
      {
        kind: "ha_link_missing",
        severity: "warning",
        entityTable: "asset_ha_link",
        entityId: link.id,
        title: `Home Assistant link missing for ${link.assetName}`,
        body: `${label} is no longer in the Home Assistant registry.`,
        dedupeKey: linkMissingDedupeKey(link.id),
      },
      nowMs,
    );
  }
}

function reactivateLinks(tx: Db, links: readonly LinkRow[], nowMs: number): void {
  for (const link of links) {
    if (link.linkState !== "missing") continue;
    tx.update(assetHaLink)
      .set({ linkState: "active", linkStateChangedAtMs: nowMs, updatedAtMs: nowMs })
      .where(eq(assetHaLink.id, link.id))
      .run();
    resolveAlert(tx, linkMissingDedupeKey(link.id), nowMs);
  }
}

/* -------------------------------------------------------------------- floors */

function toFloorRecord(entry: HaFloorRegistryEntry): FloorRecord {
  const normalized = normalizeFloor(entry);
  return {
    identityKey: normalized.floorId,
    identitySource: "registry_id",
    floorId: normalized.floorId,
    name: normalized.name,
    level: normalized.level,
    icon: normalized.icon,
  };
}

function readFloorRecords(tx: Db): { live: FloorRecord[]; removed: Set<string> } {
  const rows = tx.select().from(haFloor).all();
  const live: FloorRecord[] = [];
  const removed = new Set<string>();
  for (const row of rows) {
    if (row.removedAtMs !== null) {
      removed.add(row.floorId);
      continue;
    }
    live.push({
      identityKey: row.floorId,
      identitySource: "registry_id",
      floorId: row.floorId,
      name: row.name,
      level: row.level,
      icon: row.icon,
    });
  }
  return { live, removed };
}

function syncFloors(
  tx: Db,
  entries: readonly HaFloorRegistryEntry[],
  nowMs: number,
  counters: SyncCounters,
): void {
  const next = entries.map(toFloorRecord);
  const { live, removed } = readFloorRecords(tx);
  const diff = diffRegistry(live, next, { renameKey: NO_RENAME_KEY });

  for (const record of next) {
    const values = {
      floorId: record.floorId,
      name: record.name,
      level: record.level,
      icon: record.icon,
      lastSeenMs: nowMs,
      removedAtMs: null,
    };
    tx.insert(haFloor)
      .values(values)
      .onConflictDoUpdate({ target: haFloor.floorId, set: values })
      .run();
    if (removed.has(record.floorId)) counters.resurrectionsDetected += 1;
  }

  for (const record of diff.removed) {
    tx.update(haFloor)
      .set({ removedAtMs: nowMs })
      .where(eq(haFloor.floorId, record.floorId))
      .run();
  }

  counters.floorsSeen = next.length;
  counters.additionsDetected += diff.added.length;
  counters.removalsDetected += diff.removed.length;
}

/* --------------------------------------------------------------------- areas */

function toAreaRecord(entry: HaAreaRegistryEntry, knownFloors: ReadonlySet<string>): AreaRecord {
  const normalized = normalizeArea(entry);
  return {
    identityKey: normalized.areaId,
    identitySource: "registry_id",
    areaId: normalized.areaId,
    name: normalized.name,
    // The FK is enforced; an area pointing at a floor HA did not send would abort the sync.
    floorId: normalized.floorId && knownFloors.has(normalized.floorId) ? normalized.floorId : null,
    icon: normalized.icon,
    aliasesJson: jsonOrNull(normalized.aliases),
  };
}

function liveIds(tx: Db, table: "floor" | "area" | "device"): Set<string> {
  if (table === "floor") {
    return new Set(
      tx.select({ id: haFloor.floorId }).from(haFloor).where(isNull(haFloor.removedAtMs)).all().map((r) => r.id),
    );
  }
  if (table === "area") {
    return new Set(
      tx.select({ id: haArea.areaId }).from(haArea).where(isNull(haArea.removedAtMs)).all().map((r) => r.id),
    );
  }
  return new Set(
    tx.select({ id: haDevice.deviceId }).from(haDevice).where(isNull(haDevice.removedAtMs)).all().map((r) => r.id),
  );
}

function syncAreas(
  tx: Db,
  entries: readonly HaAreaRegistryEntry[],
  nowMs: number,
  counters: SyncCounters,
): void {
  const knownFloors = liveIds(tx, "floor");
  const next = entries.map((entry) => toAreaRecord(entry, knownFloors));

  const rows = tx.select().from(haArea).all();
  const live: AreaRecord[] = [];
  const removed = new Set<string>();
  for (const row of rows) {
    if (row.removedAtMs !== null) {
      removed.add(row.areaId);
      continue;
    }
    live.push({
      identityKey: row.areaId,
      identitySource: "registry_id",
      areaId: row.areaId,
      name: row.name,
      floorId: row.floorId,
      icon: row.icon,
      aliasesJson: row.aliasesJson,
    });
  }

  const diff = diffRegistry(live, next, { renameKey: NO_RENAME_KEY });

  for (const record of next) {
    const values = {
      areaId: record.areaId,
      name: record.name,
      floorId: record.floorId,
      icon: record.icon,
      aliasesJson: record.aliasesJson,
      lastSeenMs: nowMs,
      removedAtMs: null,
    };
    tx.insert(haArea).values(values).onConflictDoUpdate({ target: haArea.areaId, set: values }).run();
    if (removed.has(record.areaId)) counters.resurrectionsDetected += 1;
  }

  for (const record of diff.removed) {
    tx.update(haArea).set({ removedAtMs: nowMs }).where(eq(haArea.areaId, record.areaId)).run();
  }

  counters.areasSeen = next.length;
  counters.additionsDetected += diff.added.length;
  counters.removalsDetected += diff.removed.length;
}

/* ------------------------------------------------------------------- devices */

function toDeviceRecord(
  entry: HaDeviceRegistryEntry,
  knownAreas: ReadonlySet<string>,
  incomingDeviceIds: ReadonlySet<string>,
  knownDevices: ReadonlySet<string>,
): DeviceRecord {
  const normalized = normalizeDevice(entry);
  const via = normalized.viaDeviceId;
  return {
    identityKey: normalized.deviceId,
    identitySource: "registry_id",
    deviceId: normalized.deviceId,
    name: normalized.name,
    nameByUser: normalized.nameByUser,
    manufacturer: normalized.manufacturer,
    model: normalized.model,
    swVersion: normalized.swVersion,
    hwVersion: normalized.hwVersion,
    areaId: normalized.areaId && knownAreas.has(normalized.areaId) ? normalized.areaId : null,
    viaDeviceId: via && (incomingDeviceIds.has(via) || knownDevices.has(via)) ? via : null,
    identifiersJson: jsonOrNull(normalized.identifiers),
    connectionsJson: jsonOrNull(normalized.connections),
    entryType: normalized.entryType,
    disabledBy: normalized.disabledBy,
  };
}

function syncDevices(
  tx: Db,
  entries: readonly HaDeviceRegistryEntry[],
  nowMs: number,
  counters: SyncCounters,
): void {
  const knownAreas = liveIds(tx, "area");
  const knownDevices = liveIds(tx, "device");
  const incoming = new Set(entries.map((entry) => entry.id));
  const next = entries.map((entry) => toDeviceRecord(entry, knownAreas, incoming, knownDevices));

  const rows = tx.select().from(haDevice).all();
  const live: DeviceRecord[] = [];
  const removed = new Set<string>();
  for (const row of rows) {
    if (row.removedAtMs !== null) {
      removed.add(row.deviceId);
      continue;
    }
    live.push({
      identityKey: row.deviceId,
      identitySource: "registry_id",
      deviceId: row.deviceId,
      name: row.name,
      nameByUser: row.nameByUser,
      manufacturer: row.manufacturer,
      model: row.model,
      swVersion: row.swVersion,
      hwVersion: row.hwVersion,
      areaId: row.areaId,
      viaDeviceId: row.viaDeviceId,
      identifiersJson: row.identifiersJson,
      connectionsJson: row.connectionsJson,
      entryType: row.entryType,
      disabledBy: row.disabledBy,
    });
  }

  const diff = diffRegistry(live, next, { renameKey: NO_RENAME_KEY });

  // Two passes: `via_device_id` is a self-reference, so every row must exist before it is linked.
  for (const record of next) {
    const values = {
      deviceId: record.deviceId,
      name: record.name,
      nameByUser: record.nameByUser,
      manufacturer: record.manufacturer,
      model: record.model,
      swVersion: record.swVersion,
      hwVersion: record.hwVersion,
      areaId: record.areaId,
      viaDeviceId: null,
      identifiersJson: record.identifiersJson,
      connectionsJson: record.connectionsJson,
      entryType: record.entryType,
      disabledBy: record.disabledBy,
      lastSeenMs: nowMs,
      removedAtMs: null,
    };
    tx.insert(haDevice)
      .values({ ...values, firstSeenMs: nowMs })
      .onConflictDoUpdate({ target: haDevice.deviceId, set: values })
      .run();
    if (removed.has(record.deviceId)) {
      counters.resurrectionsDetected += 1;
      reactivateLinks(tx, linksForDevice(tx, record.deviceId), nowMs);
    }
  }
  for (const record of next) {
    if (record.viaDeviceId === null) continue;
    tx.update(haDevice)
      .set({ viaDeviceId: record.viaDeviceId })
      .where(eq(haDevice.deviceId, record.deviceId))
      .run();
  }

  for (const record of diff.removed) {
    tx.update(haDevice)
      .set({ removedAtMs: nowMs })
      .where(eq(haDevice.deviceId, record.deviceId))
      .run();
    markLinksMissing(
      tx,
      linksForDevice(tx, record.deviceId),
      `Device ${record.nameByUser ?? record.name ?? record.deviceId}`,
      nowMs,
      counters,
    );
  }

  counters.devicesSeen = next.length;
  counters.additionsDetected += diff.added.length;
  counters.removalsDetected += diff.removed.length;
}

/* ------------------------------------------------------------------ entities */

function toEntityRecord(
  normalized: NormalizedEntity,
  knownAreas: ReadonlySet<string>,
  knownDevices: ReadonlySet<string>,
): EntityRecord {
  const deviceId = normalized.deviceId;
  return {
    identityKey: normalized.identityKey,
    identitySource: normalized.identitySource,
    registryId: normalized.identityKey,
    entityId: normalized.entityId,
    uniqueId: normalized.uniqueId,
    platform: normalized.platform,
    configEntryId: normalized.configEntryId,
    deviceId: deviceId && knownDevices.has(deviceId) ? deviceId : null,
    areaId: normalized.areaId && knownAreas.has(normalized.areaId) ? normalized.areaId : null,
    domain: normalized.domain,
    deviceClass: normalized.deviceClass,
    originalDeviceClass: normalized.originalDeviceClass,
    unitOfMeasurement: normalized.unitOfMeasurement,
    name: normalized.name,
    originalName: normalized.originalName,
    entityCategory: normalized.entityCategory,
    disabledBy: normalized.disabledBy,
    hiddenBy: normalized.hiddenBy,
  };
}

function readEntityRecords(tx: Db): { live: EntityRecord[]; removed: Set<string> } {
  const rows = tx.select().from(haEntity).all();
  const live: EntityRecord[] = [];
  const removed = new Set<string>();
  for (const row of rows) {
    const record: EntityRecord = {
      identityKey: row.registryId,
      identitySource: identitySourceOf(row.registryId, row.entityId, row.platform, row.uniqueId),
      registryId: row.registryId,
      entityId: row.entityId,
      uniqueId: row.uniqueId,
      platform: row.platform,
      configEntryId: row.configEntryId,
      deviceId: row.deviceId,
      areaId: row.areaId,
      domain: row.domain,
      deviceClass: row.deviceClass,
      originalDeviceClass: row.originalDeviceClass,
      unitOfMeasurement: row.unitOfMeasurement,
      name: row.name,
      originalName: row.originalName,
      entityCategory: row.entityCategory,
      disabledBy: row.disabledBy,
      hiddenBy: row.hiddenBy,
    };
    if (row.removedAtMs !== null) removed.add(row.registryId);
    else live.push(record);
  }
  return { live, removed };
}

/**
 * The liveness fields for one entity, or nothing to change when this run has no states.
 *
 * An entity in the registry with no state object at all is as dead as a `restored` one — HA has
 * the entry but nothing is publishing it — so it is recorded as such rather than left blank.
 */
function liveness(
  states: ReadonlyMap<string, NormalizedState> | undefined,
  entityId: string,
  nowMs: number,
): { liveState?: string | null; liveRestored?: boolean | null; liveAtMs?: number | null } {
  if (!states) return {};
  const state = states.get(entityId);
  if (!state) return { liveState: null, liveRestored: null, liveAtMs: nowMs };
  const attributes = state.attributes as Record<string, unknown> | undefined;
  return {
    liveState: state.raw,
    liveRestored: attributes?.["restored"] === true,
    liveAtMs: nowMs,
  };
}

function syncEntities(
  tx: Db,
  entries: readonly HaEntityRegistryEntry[],
  nowMs: number,
  counters: SyncCounters,
  /**
   * Present only on a full snapshot. A registry-only re-list must leave the liveness columns
   * alone rather than blank them: it carries no states, and "we did not look" is not "it is dead".
   */
  states: ReadonlyMap<string, NormalizedState> | undefined,
): void {
  const knownAreas = liveIds(tx, "area");
  const knownDevices = liveIds(tx, "device");
  const normalized = entries.map(normalizeEntity);
  const next = normalized.map((entity) => toEntityRecord(entity, knownAreas, knownDevices));
  const { live, removed } = readEntityRecords(tx);

  const diff = diffRegistry(live, next, { renameKey: "entityId" });

  // A rename must land before the row that used to own the new entity_id is soft-deleted, or the
  // partial unique index on the live `entity_id` can collide. Soft-deleting first is the simplest
  // ordering that satisfies it.
  for (const record of diff.removed) {
    tx.update(haEntity)
      .set({ removedAtMs: nowMs })
      .where(eq(haEntity.registryId, record.registryId))
      .run();
    markLinksMissing(
      tx,
      linksForEntity(tx, record.registryId),
      `Entity ${record.entityId}`,
      nowMs,
      counters,
    );
  }

  for (const record of next) {
    const values = {
      registryId: record.registryId,
      entityId: record.entityId,
      uniqueId: record.uniqueId,
      platform: record.platform,
      configEntryId: record.configEntryId,
      deviceId: record.deviceId,
      areaId: record.areaId,
      domain: record.domain,
      deviceClass: record.deviceClass,
      originalDeviceClass: record.originalDeviceClass,
      unitOfMeasurement: record.unitOfMeasurement,
      name: record.name,
      originalName: record.originalName,
      entityCategory: record.entityCategory,
      disabledBy: record.disabledBy,
      hiddenBy: record.hiddenBy,
      lastSeenMs: nowMs,
      removedAtMs: null,
      ...liveness(states, record.entityId, nowMs),
    };
    tx.insert(haEntity)
      .values({ ...values, firstSeenMs: nowMs })
      .onConflictDoUpdate({ target: haEntity.registryId, set: values })
      .run();
    if (removed.has(record.registryId)) {
      counters.resurrectionsDetected += 1;
      reactivateLinks(tx, linksForEntity(tx, record.registryId), nowMs);
    }
  }

  for (const rename of diff.renamed) {
    counters.renamesDetected += 1;
    tx.insert(haEntityRename)
      .values({
        id: newId(),
        registryId: rename.next.registryId,
        oldEntityId: rename.from,
        newEntityId: rename.to,
        detectedAtMs: nowMs,
        source: "registry_sync",
      })
      .run();

    // Move the cached state onto the new key. Without this the cache and the registry disagree
    // until the entity next changes, `resolveEntityMeta` loses the state attributes it needs, and
    // `canonical_battery_entity_id` flaps on every rename (with an audit row for each flap).
    tx.delete(haEntityState).where(eq(haEntityState.entityId, rename.to)).run();
    tx.update(haEntityState)
      .set({ entityId: rename.to })
      .where(eq(haEntityState.entityId, rename.from))
      .run();

    // Links are keyed on the registry id, so nothing breaks — only the informational snapshot
    // needs refreshing, and the user is told.
    const links = linksForEntity(tx, rename.next.registryId);
    for (const link of links) {
      if (
        !AUTOMATIC_LINK_STATES.includes(link.linkState as (typeof AUTOMATIC_LINK_STATES)[number])
      ) {
        continue;
      }
      tx.update(assetHaLink)
        .set({ entityIdSnapshot: rename.to, linkState: "active", updatedAtMs: nowMs })
        .where(eq(assetHaLink.id, link.id))
        .run();
    }

    raiseAlert(
      tx,
      {
        kind: "ha_entity_renamed",
        severity: "info",
        entityTable: "ha_entity",
        entityId: rename.next.registryId,
        title: `Home Assistant renamed ${rename.from}`,
        body: `It is now ${rename.to}. Links kept working — they are keyed on the registry id.`,
        dedupeKey: `ha_entity_renamed:${rename.next.registryId}:${rename.to}`,
      },
      nowMs,
    );
  }

  counters.entitiesSeen = next.length;
  counters.additionsDetected += diff.added.length;
  counters.removalsDetected += diff.removed.length;
}

/* --------------------------------------------------------- battery selection */

/** Rebuild `NormalizedEntity` values from the cache, so selection runs off one source of truth. */
function cachedNormalizedEntities(tx: Db): NormalizedEntity[] {
  return tx
    .select()
    .from(haEntity)
    .where(isNull(haEntity.removedAtMs))
    .all()
    .map((row) => ({
      identityKey: row.registryId,
      identitySource: identitySourceOf(row.registryId, row.entityId, row.platform, row.uniqueId),
      registryId: row.registryId,
      entityId: row.entityId,
      domain: row.domain,
      uniqueId: row.uniqueId,
      platform: row.platform,
      configEntryId: row.configEntryId,
      deviceId: row.deviceId,
      areaId: row.areaId,
      name: row.name,
      originalName: row.originalName,
      deviceClass: row.deviceClass,
      originalDeviceClass: row.originalDeviceClass,
      unitOfMeasurement: row.unitOfMeasurement,
      entityCategory: row.entityCategory,
      disabledBy: row.disabledBy,
      hiddenBy: row.hiddenBy,
      options: null,
    }));
}

/**
 * States from the cache, **with their attributes**. The attributes matter: HA's
 * `config/entity_registry/list` does not reliably carry `device_class` or `unit_of_measurement`,
 * so `resolveEntityMeta` falls back to the state's attributes — and a registry-only refresh that
 * dropped them would re-classify every battery sensor as "not a percentage" and null out every
 * `canonical_battery_entity_id`. That is what `KEPT_ATTRIBUTES` exists for.
 */
function cachedStates(tx: Db): Map<string, NormalizedState> {
  const map = new Map<string, NormalizedState>();
  for (const row of tx.select().from(haEntityState).all()) {
    let attributes: Record<string, unknown> = {};
    if (row.attributesJson) {
      try {
        const parsed = JSON.parse(row.attributesJson) as unknown;
        if (parsed && typeof parsed === "object") attributes = parsed as Record<string, unknown>;
      } catch {
        // A malformed blob degrades to "no attributes", never to a failed sync.
      }
    }
    map.set(row.entityId, {
      entityId: row.entityId,
      raw: row.state,
      attributes,
      lastChangedMs: row.lastChangedMs,
      lastUpdatedMs: row.lastUpdatedMs,
      lastReportedMs: null,
    });
  }
  return map;
}

/**
 * Manual overrides: `asset_ha_link` rows with `role='battery_level'`, keyed by the device the
 * pinned entity belongs to. §6.2 step 3(i) — an override wins outright.
 */
function batteryOverrides(tx: Db): Map<string, string> {
  const rows = tx
    .select({ registryId: haEntity.registryId, deviceId: haEntity.deviceId })
    .from(assetHaLink)
    .innerJoin(haEntity, eq(haEntity.registryId, assetHaLink.haEntityRegistryId))
    .where(
      and(
        eq(assetHaLink.role, "battery_level"),
        inArray(assetHaLink.linkState, [...AUTOMATIC_LINK_STATES]),
        isNull(haEntity.removedAtMs),
      ),
    )
    .all();
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.deviceId) map.set(row.deviceId, row.registryId);
  }
  return map;
}

/**
 * Recompute `ha_device.canonical_battery_entity_id` for every live device and audit every change.
 * Auditing matters because the value drives which reading opens a low-battery task; a silent flap
 * would be indistinguishable from a real battery change.
 */
function recomputeCanonicalBatteries(
  tx: Db,
  nowMs: number,
  counters: SyncCounters,
  states?: ReadonlyMap<string, NormalizedState>,
): void {
  const entities = cachedNormalizedEntities(tx);
  const selection = selectCanonicalBatteryEntities(
    entities,
    states ?? cachedStates(tx),
    batteryOverrides(tx),
  );

  const devices = tx
    .select({ deviceId: haDevice.deviceId, current: haDevice.canonicalBatteryEntityId })
    .from(haDevice)
    .where(isNull(haDevice.removedAtMs))
    .all();

  for (const device of devices) {
    const next = selection.canonicalByDevice.get(device.deviceId) ?? null;
    if (next === device.current) continue;
    tx.update(haDevice)
      .set({ canonicalBatteryEntityId: next })
      .where(eq(haDevice.deviceId, device.deviceId))
      .run();
    counters.canonicalBatteryChanges += 1;
    writeAudit(
      tx,
      {
        entityTable: "ha_device",
        entityId: device.deviceId,
        action: "updated",
        summary: `canonical battery entity ${device.current ?? "none"} -> ${next ?? "none"}`,
        changes: { canonical_battery_entity_id: [device.current, next] },
      },
      nowMs,
    );
  }
}

/* --------------------------------------------------------------- sync run row */

function writeSyncRun(
  tx: Db,
  counters: SyncCounters,
  startedAtMs: number,
  finishedAtMs: number,
): string {
  const id = newId();
  tx.insert(haSyncRun)
    .values({
      id,
      startedAtMs,
      finishedAtMs,
      status: "ok",
      devicesSeen: counters.devicesSeen,
      entitiesSeen: counters.entitiesSeen,
      areasSeen: counters.areasSeen,
      renamesDetected: counters.renamesDetected,
      removalsDetected: counters.removalsDetected,
      additionsDetected: counters.additionsDetected,
    })
    .run();
  return id;
}

function writeFailedSyncRun(handle: DbHandle, startedAtMs: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    writeTx(handle.db, (tx) => {
      tx.insert(haSyncRun)
        .values({
          id: newId(),
          startedAtMs,
          finishedAtMs: Date.now(),
          status: "failed",
          error: message.slice(0, 500),
        })
        .run();
    });
  } catch {
    // If even the failure row cannot be written the database is the problem; the caller logs.
  }
}

/* ------------------------------------------------------------------ public API */

export interface RegistrySnapshotInput {
  states: readonly HaState[];
  entities: readonly HaEntityRegistryEntry[];
  devices: readonly HaDeviceRegistryEntry[];
  areas: readonly HaAreaRegistryEntry[];
  floors: readonly HaFloorRegistryEntry[];
}

/**
 * Apply a full snapshot (worker start, every reconnect, hourly safety net) as **one**
 * BEGIN IMMEDIATE transaction, so the web process never reads a half-updated registry.
 *
 * Order is dictated by the foreign keys: floors, areas, devices, entities, then the device's
 * canonical battery pointer (which references an entity).
 */
export function applySnapshot(
  handle: DbHandle,
  snapshot: RegistrySnapshotInput,
  nowMs: number,
): SyncResult {
  return applyAll(handle, snapshot, nowMs, indexStates(snapshot.states));
}

/** The four registry listings, without states. */
export interface RegistryListsInput {
  entities: readonly HaEntityRegistryEntry[];
  devices: readonly HaDeviceRegistryEntry[];
  areas: readonly HaAreaRegistryEntry[];
  floors: readonly HaFloorRegistryEntry[];
}

/**
 * Apply all four registries in one transaction and one `ha_sync_run` row — the hourly safety-net
 * re-list. Battery selection reads the cached states, which is why the state cache keeps the
 * canonical battery entities: without them the selection would lose its numeric verification and
 * could flap (and every flap is audited).
 */
export function applyRegistryLists(
  handle: DbHandle,
  lists: RegistryListsInput,
  nowMs: number,
): SyncResult {
  return applyAll(handle, lists, nowMs, undefined);
}

function applyAll(
  handle: DbHandle,
  lists: RegistryListsInput,
  nowMs: number,
  states: ReadonlyMap<string, NormalizedState> | undefined,
): SyncResult {
  const startedAtMs = nowMs;
  try {
    return writeTx(handle.db, (tx) => {
      const counters = emptyCounters();
      // Order is dictated by the foreign keys, then the canonical battery pointer last because it
      // references an entity row.
      syncFloors(tx, lists.floors, nowMs, counters);
      syncAreas(tx, lists.areas, nowMs, counters);
      syncDevices(tx, lists.devices, nowMs, counters);
      syncEntities(tx, lists.entities, nowMs, counters, states);
      recomputeCanonicalBatteries(tx, nowMs, counters, states);
      const syncRunId = writeSyncRun(tx, counters, startedAtMs, nowMs);
      return { ...counters, syncRunId };
    });
  } catch (err) {
    writeFailedSyncRun(handle, startedAtMs, err);
    throw err;
  }
}

/**
 * Apply a single re-listed registry, the response to a `*_registry_updated` signal (§8.4). The
 * event payload itself is never applied — it reports *old* values — so this always receives a
 * fresh `config/*_registry/list` result.
 */
export function applyRegistryList(
  handle: DbHandle,
  kind: HaRegistryName,
  list:
    | readonly HaEntityRegistryEntry[]
    | readonly HaDeviceRegistryEntry[]
    | readonly HaAreaRegistryEntry[]
    | readonly HaFloorRegistryEntry[],
  nowMs: number,
): SyncResult {
  const startedAtMs = nowMs;
  try {
    return writeTx(handle.db, (tx) => {
      const counters = emptyCounters();
      switch (kind) {
        case "floor":
          syncFloors(tx, list as readonly HaFloorRegistryEntry[], nowMs, counters);
          break;
        case "area":
          syncAreas(tx, list as readonly HaAreaRegistryEntry[], nowMs, counters);
          break;
        case "device":
          syncDevices(tx, list as readonly HaDeviceRegistryEntry[], nowMs, counters);
          recomputeCanonicalBatteries(tx, nowMs, counters);
          break;
        case "entity":
          // A `*_registry_updated` re-list carries no states, so liveness is left as the last
          // snapshot recorded it.
          syncEntities(tx, list as readonly HaEntityRegistryEntry[], nowMs, counters, undefined);
          recomputeCanonicalBatteries(tx, nowMs, counters);
          break;
      }
      const syncRunId = writeSyncRun(tx, counters, startedAtMs, nowMs);
      return { ...counters, syncRunId };
    });
  } catch (err) {
    writeFailedSyncRun(handle, startedAtMs, err);
    throw err;
  }
}

/* ------------------------------------------------------- location suggestions */

export interface LocationSuggestion {
  haKind: "area" | "floor";
  haId: string;
  locationId: string;
  confidence: number;
  matchReason: string;
}

/**
 * Normalise a name for matching: case-folded, diacritics stripped, punctuation collapsed.
 * `"Tekninen tila"`, `"technical-room"` and `"Technical Room"` all reduce to comparable forms.
 */
export function normaliseName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Write `location_mapping` rows with `source='suggested'` for HA areas/floors whose normalised
 * name matches a `location` name or slug exactly.
 *
 * **Never `confirmed`** (§7.3): a mapping decides where new assets land and how the 3D view groups
 * rooms, so a human accepts it. Existing rows — including ones a human rejected — are left alone.
 * Only exact normalised matches are written; fuzzy scoring is deliberately not implemented yet
 * (it would produce suggestions nobody can explain).
 */
export function suggestLocationMappings(handle: DbHandle, nowMs: number): LocationSuggestion[] {
  return writeTx(handle.db, (tx) => {
    const locations = tx
      .select({ id: location.id, kind: location.kind, name: location.name, slug: location.slug })
      .from(location)
      .all();
    if (locations.length === 0) return [];

    const byName = new Map<string, string[]>();
    const byFloorName = new Map<string, string[]>();
    for (const row of locations) {
      const keys = new Set([normaliseName(row.name), normaliseName(row.slug)]);
      for (const key of keys) {
        if (key.length === 0) continue;
        const target = row.kind === "floor" ? byFloorName : byName;
        const list = target.get(key) ?? [];
        list.push(row.id);
        target.set(key, list);
      }
    }

    const existing = new Set(
      tx
        .select({ haKind: locationMapping.haKind, haId: locationMapping.haId })
        .from(locationMapping)
        .all()
        .map((row) => `${row.haKind}:${row.haId}`),
    );

    const suggestions: LocationSuggestion[] = [];

    const consider = (haKind: "area" | "floor", haId: string, name: string): void => {
      if (existing.has(`${haKind}:${haId}`)) return;
      const index = haKind === "floor" ? byFloorName : byName;
      const matches = index.get(normaliseName(name));
      // Ambiguity is not a suggestion: two locations with the same name means a human must choose.
      if (!matches || matches.length !== 1) return;
      const locationId = matches[0]!;
      suggestions.push({ haKind, haId, locationId, confidence: 1, matchReason: "name_exact" });
    };

    for (const area of tx.select().from(haArea).where(isNull(haArea.removedAtMs)).all()) {
      consider("area", area.areaId, area.name);
    }
    for (const floor of tx.select().from(haFloor).where(isNull(haFloor.removedAtMs)).all()) {
      consider("floor", floor.floorId, floor.name);
    }

    for (const suggestion of suggestions) {
      tx.insert(locationMapping)
        .values({
          id: newId(),
          haKind: suggestion.haKind,
          haId: suggestion.haId,
          locationId: suggestion.locationId,
          source: "suggested",
          confidence: suggestion.confidence,
          matchReason: suggestion.matchReason,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .onConflictDoNothing()
        .run();
    }

    return suggestions;
  });
}
