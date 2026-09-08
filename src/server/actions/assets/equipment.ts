"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { asset, assetConsumable, assetHaLink, systemAsset } from "@/db/schema";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { replaceAsset as replaceAssetDomain } from "@/domain/assets";
import { writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { userContext } from "@/server/queries/settings/household";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import { insertDeviceLink, insertEntityLink } from "./linkWrites";
import {
  createAssetInput,
  replaceAssetInput,
  retireAssetInput,
  setConsumablesInput,
  updateAssetInput,
} from "./schemas";

/**
 * Equipment writes.
 *
 * The one that matters is `replaceEquipment`, and it is a thin wrapper by design: `replaceAsset`
 * in `@/domain/assets` writes both sides of `replaces`/`replaced_by`, repoints active plans,
 * retires the old HA links and raises the "link the new unit" alert — all in one transaction. Any
 * of that reimplemented here would be a second, subtly different version of a rule the tests
 * already cover.
 */

function revalidateEquipment(assetId?: string): void {
  revalidatePath("/equipment");
  revalidatePath("/equipment/systems");
  if (assetId !== undefined) revalidatePath(`/equipment/${assetId}`);
}

/**
 * `status IN ('removed','retired','lost')` requires `removed_on` (a code invariant, not a CHECK),
 * and this form has no field for it — so creating a unit that is already out of service is
 * refused. Create it in service and retire it, which records *when*.
 */
function assertCreatableStatus(status: string): void {
  if (status === "removed" || status === "retired" || status === "lost") {
    throw new ValidationError(
      "status_not_creatable",
      "add the unit as planned or in service, then retire it — that records the date it went out of service",
      { status },
    );
  }
}

export const createEquipment = action(createAssetInput, async (input, session) => {
  const { db } = getDb();
  const assetId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const at = nowMs();
      const id = newId();

      if (input.isVirtual && input.locationId != null) {
        // Allowed by the schema, but a software "device" with a room is almost always a mistake in
        // the import flow, and silently keeping it makes the house view lie.
        throw new ValidationError(
          "virtual_asset_has_location",
          "a software unit has no room — clear the location or untick “software”",
        );
      }
      assertCreatableStatus(input.status);

      tx.insert(asset)
        .values({
          id,
          name: input.name,
          category: input.category,
          manufacturer: input.manufacturer ?? null,
          modelName: input.modelName ?? null,
          serialNumber: input.serialNumber ?? null,
          productCode: input.productCode ?? null,
          locationId: input.locationId ?? null,
          parentAssetId: input.parentAssetId ?? null,
          isVirtual: input.isVirtual,
          status: input.status,
          installedOn: input.installedOn ?? null,
          installedOnPrecision: input.installedOnPrecision ?? null,
          purchasePriceCents: input.purchasePriceCents ?? null,
          currency: input.currency ?? "EUR",
          warrantyUntil: input.warrantyUntil ?? null,
          expectedLifeYears: input.expectedLifeYears ?? null,
          notes: input.notes ?? null,
          createdAtMs: at,
          createdBy: ctx.actorUserId,
          updatedAtMs: at,
          updatedBy: ctx.actorUserId,
        })
        .run();

      for (const line of input.consumables) {
        tx.insert(assetConsumable)
          .values({
            id: newId(),
            assetId: id,
            partId: line.partId,
            role: line.role,
            qtyMilli: line.qtyMilli,
            notes: line.notes ?? null,
          })
          .run();
      }

      for (const systemId of input.systemIds) {
        tx.insert(systemAsset).values({ systemId, assetId: id, role: null }).onConflictDoNothing().run();
      }

      if (input.haDeviceId != null) {
        insertDeviceLink(tx, ctx, {
          assetId: id,
          deviceId: input.haDeviceId,
          role: "primary",
          atMs: at,
        });
      }
      for (const link of input.haEntityLinks) {
        insertEntityLink(tx, ctx, {
          assetId: id,
          registryId: link.registryId,
          role: link.role,
          atMs: at,
        });
      }

      writeAudit(tx, ctx, {
        entityTable: "asset",
        entityId: id,
        action: "created",
        summary: `equipment ${input.name} created`,
      });
      return id;
    }),
  );
  revalidateEquipment(assetId);
  revalidatePath("/settings/home-assistant");
  return { assetId };
});

export const updateEquipment = action(updateAssetInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const before = tx.select().from(asset).where(eq(asset.id, input.assetId)).get();
      if (!before) throw new NotFoundError("asset", input.assetId);
      if (input.parentAssetId === input.assetId) {
        throw new ValidationError("self_parent", "a unit cannot be its own parent");
      }
      const next = {
        name: input.name,
        category: input.category,
        manufacturer: input.manufacturer ?? null,
        modelName: input.modelName ?? null,
        serialNumber: input.serialNumber ?? null,
        productCode: input.productCode ?? null,
        locationId: input.locationId ?? null,
        parentAssetId: input.parentAssetId ?? null,
        isVirtual: input.isVirtual,
        status: input.status,
        installedOn: input.installedOn ?? null,
        installedOnPrecision: input.installedOnPrecision ?? null,
        purchasePriceCents: input.purchasePriceCents ?? null,
        currency: input.currency ?? "EUR",
        warrantyUntil: input.warrantyUntil ?? null,
        expectedLifeYears: input.expectedLifeYears ?? null,
        notes: input.notes ?? null,
        updatedAtMs: nowMs(),
        updatedBy: ctx.actorUserId,
      };
      tx.update(asset).set(next).where(eq(asset.id, input.assetId)).run();

      const changes: Record<string, [unknown, unknown]> = {};
      for (const [key, value] of Object.entries(next)) {
        if (key === "updatedAtMs" || key === "updatedBy") continue;
        const previous = (before as unknown as Record<string, unknown>)[key];
        if (previous !== value) changes[key] = [previous, value];
      }
      if (Object.keys(changes).length > 0) {
        writeAudit(tx, ctx, {
          entityTable: "asset",
          entityId: input.assetId,
          action: "updated",
          summary: `equipment ${input.name} updated`,
          changes,
        });
      }
    }),
  );
  revalidateEquipment(input.assetId);
  return { assetId: input.assetId };
});

export const setConsumables = action(setConsumablesInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      tx.delete(assetConsumable).where(eq(assetConsumable.assetId, input.assetId)).run();
      for (const line of input.consumables) {
        tx.insert(assetConsumable)
          .values({
            id: newId(),
            assetId: input.assetId,
            partId: line.partId,
            role: line.role,
            qtyMilli: line.qtyMilli,
            notes: line.notes ?? null,
          })
          .run();
      }
      writeAudit(tx, ctx, {
        entityTable: "asset",
        entityId: input.assetId,
        action: "updated",
        summary: `consumables set to ${input.consumables.length} line(s)`,
      });
    }),
  );
  revalidateEquipment(input.assetId);
  revalidatePath("/supplies");
  return { assetId: input.assetId };
});

/**
 * Take a unit out of service **without** claiming a replacement.
 *
 * Deliberately separate from `replaceEquipment`: retiring is not a swap, and pretending it is
 * would put a `replaced_by` pointer on a row where nothing replaced anything.
 */
export const retireEquipment = action(retireAssetInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const row = tx.select().from(asset).where(eq(asset.id, input.assetId)).get();
      if (!row) throw new NotFoundError("asset", input.assetId);
      if (row.replacedByAssetId !== null) {
        throw new ValidationError(
          "already_replaced",
          "this unit was replaced; its successor carries the service record now",
        );
      }
      tx.update(asset)
        .set({
          status: input.status,
          removedOn: input.removedOn,
          notes:
            input.notes == null
              ? row.notes
              : [row.notes, input.notes].filter(Boolean).join("\n\n"),
          updatedAtMs: nowMs(),
          updatedBy: ctx.actorUserId,
        })
        .where(eq(asset.id, input.assetId))
        .run();

      // Links to a unit that is gone are retired, not deleted: the history of what was linked is
      // part of the record, and a deleted link cannot be explained later.
      tx.update(assetHaLink)
        .set({
          linkState: "retired",
          linkStateChangedAtMs: nowMs(),
          updatedAtMs: nowMs(),
          updatedBy: ctx.actorUserId,
        })
        .where(and(eq(assetHaLink.assetId, input.assetId), eq(assetHaLink.linkState, "active")))
        .run();

      writeAudit(tx, ctx, {
        entityTable: "asset",
        entityId: input.assetId,
        action: "updated",
        summary: `${row.name} marked ${input.status} on ${input.removedOn}`,
        changes: { status: [row.status, input.status] },
      });
    }),
  );
  revalidateEquipment(input.assetId);
  return { assetId: input.assetId };
});

export const replaceEquipment = action(replaceAssetInput, async (input, session) => {
  const { db } = getDb();
  const result = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      return replaceAssetDomain(tx, ctx, {
        oldAssetId: input.oldAssetId,
        replacedOn: input.replacedOn,
        reason: input.reason,
        cloneConsumables: input.cloneConsumables,
        cloneHaLinks: input.cloneHaLinks,
        notes: input.notes ?? null,
        newAsset:
          input.existingAssetId != null
            ? { existingAssetId: input.existingAssetId }
            : {
                name: input.newAsset?.name,
                category: input.newAsset?.category,
                manufacturer: input.newAsset?.manufacturer,
                modelName: input.newAsset?.modelName,
                serialNumber: input.newAsset?.serialNumber,
                productCode: input.newAsset?.productCode,
                locationId: input.newAsset?.locationId,
                parentAssetId: input.newAsset?.parentAssetId,
                isVirtual: input.newAsset?.isVirtual,
                installedOnPrecision: input.newAsset?.installedOnPrecision ?? undefined,
                purchasePriceCents: input.newAsset?.purchasePriceCents,
                currency: input.newAsset?.currency,
                warrantyUntil: input.newAsset?.warrantyUntil,
                expectedLifeYears: input.newAsset?.expectedLifeYears,
                notes: input.newAsset?.notes,
              },
      });
    }),
  );
  revalidateEquipment(input.oldAssetId);
  revalidateEquipment(result.newAsset.id);
  revalidatePath("/settings/system");
  return {
    newAssetId: result.newAsset.id,
    newAssetName: result.newAsset.name,
    repointedPlanIds: result.repointedPlanIds,
    retiredLinkIds: result.retiredLinkIds,
    clonedLinkIds: result.clonedLinkIds,
    consumableIds: result.consumableIds,
  };
});
