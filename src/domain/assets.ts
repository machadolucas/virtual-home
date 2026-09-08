/**
 * Equipment replacement and the history reads that depend on it.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.5 and §5.5.
 *
 * A replacement creates a **new** `asset` row rather than editing the old one, so the old unit
 * keeps its whole completion history and the new install is unmistakably distinct. Forward-looking
 * references (active plans, HA links) move; backward-looking ones (past completions) never do.
 *
 * Everything here takes a `tx` already inside `writeTx()`; `completion.ts` calls `replaceAsset`
 * from inside the completion transaction.
 */
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { newId } from "@/db/ids";
import {
  asset,
  assetConsumable,
  assetHaLink,
  assetReplacement,
  completion,
  conditionEpisode,
  maintenancePlan,
  type AssetCategory,
  type DatePrecision,
  type ReplacementReason,
} from "@/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { raiseAlert, writeAudit, type DomainContext } from "@/domain/inventory";

export type AssetRow = typeof asset.$inferSelect;
export type AssetReplacementRow = typeof assetReplacement.$inferSelect;
export type AssetHaLinkRow = typeof assetHaLink.$inferSelect;
export type CompletionRow = typeof completion.$inferSelect;
export type ConditionEpisodeRow = typeof conditionEpisode.$inferSelect;

/** Fields of the replacement unit. Anything omitted is copied from the unit being replaced. */
export interface NewAssetInput {
  name?: string;
  category?: AssetCategory;
  manufacturer?: string | null;
  modelName?: string | null;
  serialNumber?: string | null;
  productCode?: string | null;
  locationId?: string | null;
  parentAssetId?: string | null;
  isVirtual?: boolean;
  installedOnPrecision?: DatePrecision;
  purchasePriceCents?: number | null;
  currency?: string | null;
  warrantyUntil?: string | null;
  expectedLifeYears?: number | null;
  notes?: string | null;
}

export interface ExistingAssetRef {
  existingAssetId: string;
}

export interface ReplaceAssetInput {
  oldAssetId: string;
  newAsset: NewAssetInput | ExistingAssetRef;
  /** LocalDate. */
  replacedOn: string;
  reason: ReplacementReason;
  occurrenceId?: string | null;
  completionId?: string | null;
  /** Copy the old unit's `asset_consumable` rows onto the new one. */
  cloneConsumables?: boolean;
  /** Clone the old unit's `asset_ha_link` rows as `active` on the new one (same physical device). */
  cloneHaLinks?: boolean;
  notes?: string | null;
}

export interface ReplaceAssetResult {
  oldAsset: AssetRow;
  newAsset: AssetRow;
  replacement: AssetReplacementRow;
  /** Active plans moved from the old unit to the new one. */
  repointedPlanIds: string[];
  /** Old links set to `link_state = 'replaced'`. */
  retiredLinkIds: string[];
  /** Clones on the new unit, `link_state = 'active'`. */
  clonedLinkIds: string[];
  consumableIds: string[];
}

function isExistingRef(value: NewAssetInput | ExistingAssetRef): value is ExistingAssetRef {
  return typeof (value as ExistingAssetRef).existingAssetId === "string";
}

function loadAsset(tx: Db, assetId: string): AssetRow {
  const row = tx.select().from(asset).where(eq(asset.id, assetId)).get();
  if (!row) throw new NotFoundError("asset", assetId);
  return row;
}

/**
 * The full chain a unit belongs to, oldest first: walk `replaces_asset_id` back to the original
 * install, then `replaced_by_asset_id` forward to the unit in service today. Cycle-guarded (the
 * schema cannot declare acyclicity, so the code does).
 */
export function replacementChain(tx: Db, assetId: string): string[] {
  loadAsset(tx, assetId);

  const back: string[] = [];
  const seen = new Set<string>([assetId]);
  let cursor: string | null = assetId;
  while (cursor !== null) {
    const row: AssetRow = loadAsset(tx, cursor);
    const previous: string | null = row.replacesAssetId;
    if (previous === null || seen.has(previous)) break;
    seen.add(previous);
    back.unshift(previous);
    cursor = previous;
  }

  const forward: string[] = [];
  cursor = assetId;
  while (cursor !== null) {
    const row: AssetRow = loadAsset(tx, cursor);
    const next: string | null = row.replacedByAssetId;
    if (next === null || seen.has(next)) break;
    seen.add(next);
    forward.push(next);
    cursor = next;
  }

  return [...back, assetId, ...forward];
}

export interface AssetHistory {
  assetId: string;
  /** Every unit in the replacement chain, oldest first. */
  chain: string[];
  /** Completions recorded against **this** unit, newest first. */
  completions: CompletionRow[];
  /** Completions anywhere in the chain (the "whole appliance" view), newest first. */
  chainCompletions: CompletionRow[];
  replacements: AssetReplacementRow[];
  episodes: ConditionEpisodeRow[];
}

/**
 * Everything that happened to a unit: its own completions, the completions of every unit in its
 * replacement chain, the swaps themselves, and its condition episodes.
 */
export function assetHistory(tx: Db, assetId: string): AssetHistory {
  const chain = replacementChain(tx, assetId);

  const chainCompletions = tx
    .select()
    .from(completion)
    .where(inArray(completion.assetId, chain))
    .orderBy(desc(completion.completedAtMs), desc(completion.id))
    .all();

  const replacements = tx
    .select()
    .from(assetReplacement)
    .where(or(inArray(assetReplacement.oldAssetId, chain), inArray(assetReplacement.newAssetId, chain)))
    .orderBy(asc(assetReplacement.replacedOn))
    .all();

  const episodes = tx
    .select()
    .from(conditionEpisode)
    .where(inArray(conditionEpisode.assetId, chain))
    .orderBy(desc(conditionEpisode.openedAtMs))
    .all();

  return {
    assetId,
    chain,
    completions: chainCompletions.filter((row) => row.assetId === assetId),
    chainCompletions,
    replacements,
    episodes,
  };
}

/**
 * Swap a unit. Both sides of `replaces` / `replaced_by` are written here, in this transaction, so
 * they can never disagree.
 */
export function replaceAsset(
  tx: Db,
  ctx: DomainContext,
  input: ReplaceAssetInput,
): ReplaceAssetResult {
  const now = ctx.clock.now();
  const old = loadAsset(tx, input.oldAssetId);

  if (old.replacedByAssetId !== null) {
    throw new ConflictError("already_replaced", "that unit has already been replaced", {
      oldAssetId: old.id,
      replacedByAssetId: old.replacedByAssetId,
    });
  }
  const existingSwap = tx
    .select()
    .from(assetReplacement)
    .where(eq(assetReplacement.oldAssetId, old.id))
    .get();
  if (existingSwap) {
    throw new ConflictError("already_replaced", "that unit already has an asset_replacement row", {
      oldAssetId: old.id,
      replacementId: existingSwap.id,
    });
  }

  let created: AssetRow;
  if (isExistingRef(input.newAsset)) {
    const existing = loadAsset(tx, input.newAsset.existingAssetId);
    if (existing.id === old.id) {
      throw new ValidationError("replacement_is_same_asset", "a unit cannot replace itself", {
        assetId: old.id,
      });
    }
    // Acyclicity: the new unit must not already be an ancestor of the old one.
    if (replacementChain(tx, existing.id).includes(old.id)) {
      throw new ValidationError(
        "replacement_cycle",
        "that unit is already part of this replacement chain",
        { oldAssetId: old.id, newAssetId: existing.id },
      );
    }
    created = tx
      .update(asset)
      .set({
        status: "installed",
        installedOn: input.replacedOn,
        installedOnPrecision: existing.installedOnPrecision ?? "exact",
        replacesAssetId: old.id,
        locationId: existing.locationId ?? old.locationId,
        updatedAtMs: now,
        updatedBy: ctx.actorUserId,
      })
      .where(eq(asset.id, existing.id))
      .returning()
      .get();
  } else {
    const spec = input.newAsset;
    created = tx
      .insert(asset)
      .values({
        id: newId(),
        name: spec.name ?? old.name,
        category: spec.category ?? old.category,
        manufacturer: spec.manufacturer ?? old.manufacturer,
        modelName: spec.modelName ?? old.modelName,
        serialNumber: spec.serialNumber ?? null,
        productCode: spec.productCode ?? old.productCode,
        locationId: spec.locationId ?? old.locationId,
        parentAssetId: spec.parentAssetId ?? old.parentAssetId,
        isVirtual: spec.isVirtual ?? old.isVirtual,
        status: "installed",
        installedOn: input.replacedOn,
        installedOnPrecision: spec.installedOnPrecision ?? "exact",
        replacesAssetId: old.id,
        purchasePriceCents: spec.purchasePriceCents ?? null,
        currency: spec.currency ?? old.currency,
        warrantyUntil: spec.warrantyUntil ?? null,
        expectedLifeYears: spec.expectedLifeYears ?? old.expectedLifeYears,
        notes: spec.notes ?? null,
        createdAtMs: now,
        createdBy: ctx.actorUserId,
        updatedAtMs: now,
        updatedBy: ctx.actorUserId,
      })
      .returning()
      .get();
  }

  const oldAsset = tx
    .update(asset)
    .set({
      status: "removed",
      removedOn: input.replacedOn,
      replacedByAssetId: created.id,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(asset.id, old.id))
    .returning()
    .get();

  const replacement = tx
    .insert(assetReplacement)
    .values({
      id: newId(),
      oldAssetId: old.id,
      newAssetId: created.id,
      occurrenceId: input.occurrenceId ?? null,
      completionId: input.completionId ?? null,
      replacedOn: input.replacedOn,
      reason: input.reason,
      notes: input.notes ?? null,
      createdAtMs: now,
      createdBy: ctx.actorUserId,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .returning()
    .get();

  // What the new unit eats.
  const consumableIds: string[] = [];
  if (input.cloneConsumables) {
    const existingParts = new Set(
      tx
        .select({ partId: assetConsumable.partId, role: assetConsumable.role })
        .from(assetConsumable)
        .where(eq(assetConsumable.assetId, created.id))
        .all()
        .map((row) => `${row.partId}:${row.role}`),
    );
    for (const row of tx
      .select()
      .from(assetConsumable)
      .where(eq(assetConsumable.assetId, old.id))
      .all()) {
      if (existingParts.has(`${row.partId}:${row.role}`)) continue;
      const clone = tx
        .insert(assetConsumable)
        .values({
          id: newId(),
          assetId: created.id,
          partId: row.partId,
          role: row.role,
          qtyMilli: row.qtyMilli,
          notes: row.notes,
        })
        .returning()
        .get();
      consumableIds.push(clone.id);
    }
  }

  // Forward-looking references move; past completions never do.
  const repointedPlanIds: string[] = [];
  for (const plan of tx
    .select()
    .from(maintenancePlan)
    .where(and(eq(maintenancePlan.assetId, old.id), eq(maintenancePlan.status, "active")))
    .all()) {
    tx.update(maintenancePlan)
      .set({ assetId: created.id, updatedAtMs: now, updatedBy: ctx.actorUserId })
      .where(eq(maintenancePlan.id, plan.id))
      .run();
    repointedPlanIds.push(plan.id);
    writeAudit(tx, ctx, {
      entityTable: "maintenance_plan",
      entityId: plan.id,
      action: "updated",
      summary: `plan repointed to the replacement unit`,
      changes: { asset_id: [old.id, created.id] },
    });
  }

  // HA links: the old unit's links are `replaced`; clones are `active` on the new unit when the
  // physical registry entry is the same. If we do not clone, the user has to re-link — say so.
  const oldLinks = tx
    .select()
    .from(assetHaLink)
    .where(eq(assetHaLink.assetId, old.id))
    .all();
  const retiredLinkIds: string[] = [];
  const clonedLinkIds: string[] = [];
  for (const link of oldLinks) {
    tx.update(assetHaLink)
      .set({
        linkState: "replaced",
        linkStateChangedAtMs: now,
        updatedAtMs: now,
        updatedBy: ctx.actorUserId,
      })
      .where(eq(assetHaLink.id, link.id))
      .run();
    retiredLinkIds.push(link.id);

    if (input.cloneHaLinks) {
      const clone = tx
        .insert(assetHaLink)
        .values({
          id: newId(),
          assetId: created.id,
          linkKind: link.linkKind,
          haDeviceId: link.haDeviceId,
          haEntityRegistryId: link.haEntityRegistryId,
          role: link.role,
          entityIdSnapshot: link.entityIdSnapshot,
          uniqueIdSnapshot: link.uniqueIdSnapshot,
          platformSnapshot: link.platformSnapshot,
          linkState: "active",
          linkStateChangedAtMs: now,
          notes: link.notes,
          createdAtMs: now,
          createdBy: ctx.actorUserId,
          updatedAtMs: now,
          updatedBy: ctx.actorUserId,
        })
        .returning()
        .get();
      clonedLinkIds.push(clone.id);
    }
  }
  if (oldLinks.length > 0 && !input.cloneHaLinks) {
    raiseAlert(tx, ctx, {
      kind: "ha_link_missing",
      severity: "warning",
      title: `Link ${created.name} to Home Assistant`,
      body:
        `${old.name} was replaced on ${input.replacedOn}; its ${oldLinks.length} Home Assistant ` +
        `link(s) were retired and the new unit has none yet.`,
      entityTable: "asset",
      entityId: created.id,
      dedupeKey: `ha_link_missing:asset:${created.id}`,
    });
  }

  writeAudit(tx, ctx, {
    entityTable: "asset_replacement",
    entityId: replacement.id,
    action: "created",
    summary: `${old.name} replaced by ${created.name} on ${input.replacedOn} (${input.reason})`,
  });

  return {
    oldAsset,
    newAsset: created,
    replacement,
    repointedPlanIds,
    retiredLinkIds,
    clonedLinkIds,
    consumableIds,
  };
}

/** Live (non-`replaced`, non-`retired`) HA links of an asset. */
export function activeHaLinks(tx: Db, assetId: string): AssetHaLinkRow[] {
  return tx
    .select()
    .from(assetHaLink)
    .where(and(eq(assetHaLink.assetId, assetId), eq(assetHaLink.linkState, "active")))
    .all();
}

/** Assets an HA entity (or, failing that, its device) is linked to — §6.4 step 2. */
export function assetsForEntity(tx: Db, entityRegistryId: string, deviceId: string | null): string[] {
  const direct = tx
    .select({ assetId: assetHaLink.assetId })
    .from(assetHaLink)
    .where(
      and(
        eq(assetHaLink.haEntityRegistryId, entityRegistryId),
        inArray(assetHaLink.linkState, ["active", "renamed"]),
      ),
    )
    .all()
    .map((row) => row.assetId);
  if (direct.length > 0) return [...new Set(direct)];

  if (deviceId === null) return [];
  const viaDevice = tx
    .select({ assetId: assetHaLink.assetId })
    .from(assetHaLink)
    .where(
      and(
        eq(assetHaLink.haDeviceId, deviceId),
        isNull(assetHaLink.haEntityRegistryId),
        inArray(assetHaLink.linkState, ["active", "renamed"]),
      ),
    )
    .all()
    .map((row) => row.assetId);
  return [...new Set(viaDevice)];
}
