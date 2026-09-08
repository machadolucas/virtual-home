import "server-only";
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset,
  assetConsumable,
  assetHaLink,
  assetReplacement,
  attachment,
  attachmentLink,
  completion,
  conditionRule,
  conditionSignal,
  haArea,
  haDevice,
  haEntity,
  haEntityState,
  location,
  maintenanceOccurrence,
  maintenancePlan,
  part,
  partStock,
  system,
  systemAsset,
  user,
  type AssetCategory,
  type AttachmentKind,
  type ConsumableRole,
  type HaLinkRole,
  type HaLinkState,
} from "@/db/schema";
import { assetHistory, type AssetHistory } from "@/domain/assets";
import { batteryDisplay, type BatteryDisplay } from "@/features/assets/battery";
import { suggestRelinks, type CandidateEntity, type RelinkSuggestion } from "@/features/assets/haLink";

export type AssetRow = typeof asset.$inferSelect;

export interface ConsumableEntry {
  id: string;
  partId: string;
  partName: string;
  role: ConsumableRole;
  qtyMilli: number;
  unit: (typeof part.$inferSelect)["unit"];
  isKit: boolean;
  onHandMilli: number;
  notes: string | null;
}

export interface HaLinkEntry {
  id: string;
  linkKind: "device" | "entity";
  role: HaLinkRole;
  linkState: HaLinkState;
  linkStateChangedAtMs: number | null;
  haDeviceId: string | null;
  haDeviceName: string | null;
  haEntityRegistryId: string | null;
  /** Live entity id from the registry cache; falls back to the snapshot when the entry is gone. */
  entityId: string | null;
  entityIdSnapshot: string | null;
  platformSnapshot: string | null;
  uniqueIdSnapshot: string | null;
  /** Latest cached state, verbatim. `null` when nothing has been observed. */
  state: string | null;
  stateLastUpdatedMs: number | null;
  unitOfMeasurement: string | null;
  notes: string | null;
}

export interface PlanEntry {
  id: string;
  title: string;
  status: string;
  scheduleKind: string;
  priority: string;
}

export interface TaskEntry {
  id: string;
  title: string;
  status: string;
  dueDate: string;
  priority: string;
}

export interface CompletionEntry {
  id: string;
  assetId: string | null;
  completedLocalDate: string;
  completedAtMs: number;
  outcome: string;
  notes: string | null;
  performedByName: string | null;
  /** True when the completion belongs to a different unit in the replacement chain. */
  viaChain: boolean;
}

export interface DocumentEntry {
  id: string;
  kind: AttachmentKind;
  mime: string;
  byteSize: number;
  originalFilename: string;
  caption: string | null;
  role: string | null;
  hasWebCopy: boolean;
  width: number | null;
  height: number | null;
  createdAtMs: number;
}

export interface ConditionRuleEntry {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  thresholdPct: number | null;
  clearThresholdPct: number | null;
  sustainMinutes: number | null;
  entityId: string | null;
  defaultPartName: string | null;
}

export interface AssetDetail {
  asset: AssetRow;
  locationName: string | null;
  locationPath: string | null;
  battery: BatteryDisplay | null;
  consumables: ConsumableEntry[];
  systems: { id: string; name: string; kind: string; role: string | null }[];
  haLinks: HaLinkEntry[];
  relinkSuggestions: RelinkSuggestion[];
  plans: PlanEntry[];
  openTasks: TaskEntry[];
  history: AssetHistory;
  completions: CompletionEntry[];
  documents: DocumentEntry[];
  closeUpPhotos: DocumentEntry[];
  conditionRules: ConditionRuleEntry[];
  replacedBy: { id: string; name: string } | null;
  replaces: { id: string; name: string } | null;
  replacement: typeof assetReplacement.$inferSelect | null;
  /** Names of every unit in the chain, for the history header. */
  chainNames: { id: string; name: string; installedOn: string | null; removedOn: string | null }[];
}

export interface ReadAssetOptions {
  nowMs: number;
  batteryThresholdPct: number;
  batteryStaleHours: number;
}

/** Everything `/equipment/[assetId]` renders. `null` for an unknown id. */
export function readAssetDetail(
  tx: Db,
  assetId: string,
  options: ReadAssetOptions,
): AssetDetail | null {
  const row = tx.select().from(asset).where(eq(asset.id, assetId)).get();
  if (!row) return null;

  const locationRow =
    row.locationId === null
      ? null
      : (tx.select().from(location).where(eq(location.id, row.locationId)).get() ?? null);
  const parentName =
    locationRow?.parentId == null
      ? null
      : (tx
          .select({ name: location.name })
          .from(location)
          .where(eq(location.id, locationRow.parentId))
          .get()?.name ?? null);

  const consumables: ConsumableEntry[] = tx
    .select({
      id: assetConsumable.id,
      partId: assetConsumable.partId,
      partName: part.name,
      role: assetConsumable.role,
      qtyMilli: assetConsumable.qtyMilli,
      unit: part.unit,
      isKit: part.isKit,
      onHandMilli: partStock.onHandMilli,
      notes: assetConsumable.notes,
    })
    .from(assetConsumable)
    .innerJoin(part, eq(part.id, assetConsumable.partId))
    .leftJoin(partStock, eq(partStock.partId, assetConsumable.partId))
    .where(eq(assetConsumable.assetId, assetId))
    .orderBy(asc(assetConsumable.role), asc(part.name))
    .all()
    .map((entry) => ({ ...entry, onHandMilli: entry.onHandMilli ?? 0 }));

  const systems = tx
    .select({
      id: system.id,
      name: system.name,
      kind: system.kind,
      role: systemAsset.role,
    })
    .from(systemAsset)
    .innerJoin(system, eq(system.id, systemAsset.systemId))
    .where(eq(systemAsset.assetId, assetId))
    .orderBy(asc(system.name))
    .all();

  const haLinks = readHaLinks(tx, assetId);

  const batteryLink = haLinks.find(
    (link) => link.role === "battery_level" && link.linkState === "active",
  );
  const staleFlag =
    batteryLink?.haEntityRegistryId == null
      ? undefined
      : (tx
          .select({ isStale: conditionSignal.isStale })
          .from(conditionSignal)
          .where(eq(conditionSignal.haEntityRegistryId, batteryLink.haEntityRegistryId))
          .get()?.isStale ?? undefined);

  const battery =
    batteryLink === undefined
      ? null
      : batteryDisplay({
          rawState: batteryLink.state,
          lastUpdatedMs: batteryLink.stateLastUpdatedMs,
          isStale: staleFlag,
          thresholdPct: options.batteryThresholdPct,
          staleHours: options.batteryStaleHours,
          nowMs: options.nowMs,
        });

  const plans: PlanEntry[] = tx
    .select({
      id: maintenancePlan.id,
      title: maintenancePlan.title,
      status: maintenancePlan.status,
      scheduleKind: maintenancePlan.scheduleKind,
      priority: maintenancePlan.priority,
    })
    .from(maintenancePlan)
    .where(eq(maintenancePlan.assetId, assetId))
    .orderBy(asc(maintenancePlan.title))
    .all();

  const openTasks: TaskEntry[] = tx
    .select({
      id: maintenanceOccurrence.id,
      title: maintenanceOccurrence.title,
      status: maintenanceOccurrence.status,
      dueDate: maintenanceOccurrence.dueDate,
      priority: maintenanceOccurrence.priority,
    })
    .from(maintenanceOccurrence)
    .where(
      and(
        eq(maintenanceOccurrence.assetId, assetId),
        inArray(maintenanceOccurrence.status, ["pending", "due"]),
      ),
    )
    .orderBy(asc(maintenanceOccurrence.dueDate))
    .all();

  const history = assetHistory(tx, assetId);
  const performers = new Map(
    tx.select({ id: user.id, name: user.name }).from(user).all().map((r) => [r.id, r.name]),
  );
  const completions: CompletionEntry[] = history.chainCompletions.map((entry) => ({
    id: entry.id,
    assetId: entry.assetId,
    completedLocalDate: entry.completedLocalDate,
    completedAtMs: entry.completedAtMs,
    outcome: entry.outcome,
    notes: entry.notes,
    performedByName:
      entry.performedByUserId === null ? null : (performers.get(entry.performedByUserId) ?? null),
    viaChain: entry.assetId !== assetId,
  }));

  const chainNames = history.chain.length <= 1
    ? []
    : tx
        .select({
          id: asset.id,
          name: asset.name,
          installedOn: asset.installedOn,
          removedOn: asset.removedOn,
        })
        .from(asset)
        .where(inArray(asset.id, history.chain))
        .all()
        // Keep the chain's own order (oldest first) rather than the database's.
        .sort((a, b) => history.chain.indexOf(a.id) - history.chain.indexOf(b.id));

  const allDocuments = readDocuments(tx, assetId);

  const conditionRules: ConditionRuleEntry[] = tx
    .select({
      id: conditionRule.id,
      name: conditionRule.name,
      kind: conditionRule.kind,
      enabled: conditionRule.enabled,
      thresholdPct: conditionRule.thresholdPct,
      clearThresholdPct: conditionRule.clearThresholdPct,
      sustainMinutes: conditionRule.sustainMinutes,
      entityId: haEntity.entityId,
      defaultPartName: part.name,
    })
    .from(conditionRule)
    .leftJoin(haEntity, eq(haEntity.registryId, conditionRule.haEntityRegistryId))
    .leftJoin(part, eq(part.id, conditionRule.defaultPartId))
    .where(eq(conditionRule.assetId, assetId))
    .orderBy(asc(conditionRule.name))
    .all();

  const replacedBy =
    row.replacedByAssetId === null
      ? null
      : (tx
          .select({ id: asset.id, name: asset.name })
          .from(asset)
          .where(eq(asset.id, row.replacedByAssetId))
          .get() ?? null);
  const replaces =
    row.replacesAssetId === null
      ? null
      : (tx
          .select({ id: asset.id, name: asset.name })
          .from(asset)
          .where(eq(asset.id, row.replacesAssetId))
          .get() ?? null);

  const replacement =
    tx
      .select()
      .from(assetReplacement)
      .where(
        or(eq(assetReplacement.oldAssetId, assetId), eq(assetReplacement.newAssetId, assetId)),
      )
      .orderBy(desc(assetReplacement.replacedOn))
      .get() ?? null;

  return {
    asset: row,
    locationName: locationRow?.name ?? null,
    locationPath:
      locationRow === null
        ? null
        : parentName === null
          ? locationRow.name
          : `${parentName} · ${locationRow.name}`,
    battery,
    consumables,
    systems,
    haLinks,
    relinkSuggestions: relinkSuggestionsFor(tx, assetId, row.name, haLinks),
    plans,
    openTasks,
    history,
    completions,
    documents: allDocuments.filter((doc) => doc.role !== "close_up"),
    closeUpPhotos: allDocuments.filter((doc) => doc.role === "close_up"),
    conditionRules,
    replacedBy,
    replaces,
    replacement,
    chainNames,
  };
}

/** The asset's HA links, joined to the registry cache and the latest cached state. */
export function readHaLinks(tx: Db, assetId: string): HaLinkEntry[] {
  return tx
    .select({
      id: assetHaLink.id,
      linkKind: assetHaLink.linkKind,
      role: assetHaLink.role,
      linkState: assetHaLink.linkState,
      linkStateChangedAtMs: assetHaLink.linkStateChangedAtMs,
      haDeviceId: assetHaLink.haDeviceId,
      haDeviceName: haDevice.name,
      haDeviceNameByUser: haDevice.nameByUser,
      haEntityRegistryId: assetHaLink.haEntityRegistryId,
      entityId: haEntity.entityId,
      entityIdSnapshot: assetHaLink.entityIdSnapshot,
      platformSnapshot: assetHaLink.platformSnapshot,
      uniqueIdSnapshot: assetHaLink.uniqueIdSnapshot,
      unitOfMeasurement: haEntity.unitOfMeasurement,
      state: haEntityState.state,
      stateLastUpdatedMs: haEntityState.lastUpdatedMs,
      notes: assetHaLink.notes,
    })
    .from(assetHaLink)
    .leftJoin(haEntity, eq(haEntity.registryId, assetHaLink.haEntityRegistryId))
    .leftJoin(haDevice, eq(haDevice.deviceId, assetHaLink.haDeviceId))
    .leftJoin(haEntityState, eq(haEntityState.registryId, assetHaLink.haEntityRegistryId))
    .where(eq(assetHaLink.assetId, assetId))
    .orderBy(asc(assetHaLink.role))
    .all()
    .map((row) => ({
      id: row.id,
      linkKind: row.linkKind,
      role: row.role,
      linkState: row.linkState,
      linkStateChangedAtMs: row.linkStateChangedAtMs,
      haDeviceId: row.haDeviceId,
      haDeviceName: row.haDeviceNameByUser ?? row.haDeviceName,
      haEntityRegistryId: row.haEntityRegistryId,
      entityId: row.entityId,
      entityIdSnapshot: row.entityIdSnapshot,
      platformSnapshot: row.platformSnapshot,
      uniqueIdSnapshot: row.uniqueIdSnapshot,
      unitOfMeasurement: row.unitOfMeasurement,
      state: row.state,
      stateLastUpdatedMs: row.stateLastUpdatedMs,
      notes: row.notes,
    }));
}

/**
 * Relink candidates for this asset's broken links: live registry entries that share the snapshot's
 * `(platform, unique_id)`, or the snapshot's entity id.
 *
 * Only the plausible candidates are loaded rather than the whole registry — the household instance
 * has thousands of entities and this runs on a page render.
 */
function relinkSuggestionsFor(
  tx: Db,
  assetId: string,
  assetName: string,
  links: readonly HaLinkEntry[],
): RelinkSuggestion[] {
  const broken = links.filter((link) => link.linkState === "missing");
  if (broken.length === 0) return [];

  const uniqueIds = broken
    .map((link) => link.uniqueIdSnapshot)
    .filter((value): value is string => value !== null);
  const entityIds = broken
    .map((link) => link.entityIdSnapshot)
    .filter((value): value is string => value !== null);

  const conditions = [];
  if (uniqueIds.length > 0) conditions.push(inArray(haEntity.uniqueId, uniqueIds));
  if (entityIds.length > 0) conditions.push(inArray(haEntity.entityId, entityIds));
  if (conditions.length === 0) return [];

  const registryIds = broken
    .map((link) => link.haEntityRegistryId)
    .filter((value): value is string => value !== null);

  const candidates: CandidateEntity[] = tx
    .select({
      registryId: haEntity.registryId,
      entityId: haEntity.entityId,
      platform: haEntity.platform,
      uniqueId: haEntity.uniqueId,
      deviceId: haEntity.deviceId,
      name: haEntity.name,
    })
    .from(haEntity)
    .where(
      and(
        isNull(haEntity.removedAtMs),
        conditions.length === 1 ? conditions[0] : or(...conditions),
        registryIds.length === 0 ? undefined : notInRegistryIds(registryIds),
      ),
    )
    .all();

  return suggestRelinks(
    broken.map((link) => ({
      linkId: link.id,
      assetId,
      assetName,
      role: link.role,
      haEntityRegistryId: link.haEntityRegistryId,
      haDeviceId: link.haDeviceId,
      platformSnapshot: link.platformSnapshot,
      uniqueIdSnapshot: link.uniqueIdSnapshot,
      entityIdSnapshot: link.entityIdSnapshot,
    })),
    candidates,
  );
}

/** "Not one of the registry ids we already point at" — a repoint to itself is not a repair. */
function notInRegistryIds(ids: readonly string[]) {
  return ids.length === 1
    ? ne(haEntity.registryId, ids[0]!)
    : and(...ids.map((id) => ne(haEntity.registryId, id)));
}

/** Attachments linked to this asset (manuals, nameplate photos, close-ups). */
export function readDocuments(tx: Db, assetId: string): DocumentEntry[] {
  return tx
    .select({
      id: attachment.id,
      kind: attachment.kind,
      mime: attachment.mime,
      byteSize: attachment.byteSize,
      originalFilename: attachment.originalFilename,
      caption: attachment.caption,
      role: attachmentLink.role,
      hasWebCopy: attachment.hasWebCopy,
      width: attachment.width,
      height: attachment.height,
      createdAtMs: attachment.createdAtMs,
    })
    .from(attachmentLink)
    .innerJoin(attachment, eq(attachment.id, attachmentLink.attachmentId))
    .where(and(eq(attachmentLink.entityKind, "asset"), eq(attachmentLink.entityId, assetId)))
    .orderBy(asc(attachmentLink.seq), desc(attachment.createdAtMs))
    .all();
}

/** Candidate spares for the replacement flow: units in storage or planned, never the unit itself. */
export function listSpareOptions(
  tx: Db,
  excludeAssetId: string,
): { id: string; name: string; category: AssetCategory; locationName: string | null }[] {
  return tx
    .select({
      id: asset.id,
      name: asset.name,
      category: asset.category,
      locationName: location.name,
    })
    .from(asset)
    .leftJoin(location, eq(location.id, asset.locationId))
    .where(
      and(
        ne(asset.id, excludeAssetId),
        isNull(asset.replacesAssetId),
        isNull(asset.replacedByAssetId),
        inArray(asset.status, ["planned", "installed"]),
      ),
    )
    .orderBy(asc(asset.name))
    .all();
}

/** Completions across the whole chain, for the "whole appliance" history toggle. */
export function chainCompletionCount(tx: Db, chain: readonly string[]): number {
  if (chain.length === 0) return 0;
  return tx.select().from(completion).where(inArray(completion.assetId, chain)).all().length;
}

/** HA areas, for the "which area is this device in" hint on the import screen. */
export function areaNames(tx: Db): Map<string, string> {
  return new Map(
    tx
      .select({ areaId: haArea.areaId, name: haArea.name })
      .from(haArea)
      .all()
      .map((row) => [row.areaId, row.name]),
  );
}
