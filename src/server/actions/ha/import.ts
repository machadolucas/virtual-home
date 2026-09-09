"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, writeTx, type Db } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  ASSET_CATEGORIES,
  asset,
  assetHaLink,
  haDevice,
  haEntity,
  type AssetCategory,
} from "@/db/schema";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { resolveAlert, writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { insertDeviceLink, insertEntityLink } from "@/server/actions/assets/linkWrites";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import { userContext } from "@/server/queries/settings/household";
import { readAreaMappings } from "@/server/queries/ha/registry";
import { importDeviceInput, importDevicesInput } from "./schemas";

/**
 * "Import & link": turn a cached Home Assistant device into a piece of equipment, or attach it to
 * one that already exists.
 *
 * Everything here reads the registry **cache** — the web process has no socket to HA (§7.1). So
 * this works while HA is down, and what it creates is exactly as fresh as the last sync, which the
 * page states rather than hides.
 *
 * A `service`-type device is HA's word for an integration rather than a thing: it becomes
 * `asset.is_virtual = 1` with no location, which is what §7.2 prescribes.
 */

function isAssetCategory(value: string): value is AssetCategory {
  return (ASSET_CATEGORIES as readonly string[]).includes(value);
}

export const importHaDevice = action(importDeviceInput, async (input, session) => {
  // Inside `mapDomainErrors` so the refusal reaches the screen as `unknown_category` rather than
  // as a generic failure.
  const category = mapDomainErrors((): AssetCategory => {
    if (!isAssetCategory(input.category)) {
      throw new ValidationError("unknown_category", `unknown equipment category ${input.category}`);
    }
    return input.category;
  });

  const { db } = getDb();
  const result = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const at = nowMs();
      const device = tx.select().from(haDevice).where(eq(haDevice.deviceId, input.deviceId)).get();
      if (!device) throw new NotFoundError("ha_device", input.deviceId);
      if (device.removedAtMs !== null) {
        throw new ValidationError(
          "device_removed",
          "that device is no longer in Home Assistant's registry",
        );
      }

      const isVirtual = input.isVirtual || device.entryType === "service";
      let assetId: string;
      let created: boolean;

      if (input.existingAssetId != null) {
        const existing = tx
          .select()
          .from(asset)
          .where(eq(asset.id, input.existingAssetId))
          .get();
        if (!existing) throw new NotFoundError("asset", input.existingAssetId);
        assetId = existing.id;
        created = false;
      } else {
        assetId = newId();
        created = true;
        tx.insert(asset)
          .values({
            id: assetId,
            name: input.name,
            category,
            manufacturer: input.manufacturer ?? device.manufacturer,
            modelName: input.modelName ?? device.model,
            serialNumber: null,
            productCode: null,
            // A software device has no room, and a physical one gets the confirmed mapping's
            // location when the caller passed it (the form pre-selects it, the user can change it).
            locationId: isVirtual ? null : (input.locationId ?? null),
            parentAssetId: null,
            isVirtual,
            status: "installed",
            // Deliberately no `installed_on`: HA's `first_seen` is when *we* noticed the device,
            // not when it was installed, and recording it as an install date would fabricate
            // history (CLAUDE.md rule 6).
            installedOn: null,
            installedOnPrecision: "unknown",
            currency: "EUR",
            notes: null,
            createdAtMs: at,
            createdBy: ctx.actorUserId,
            updatedAtMs: at,
            updatedBy: ctx.actorUserId,
          })
          .run();
      }

      const linkIds: string[] = [];
      if (input.linkDevice) {
        linkIds.push(
          insertDeviceLink(tx, ctx, {
            assetId,
            deviceId: device.deviceId,
            // `primary` is unique per asset, so a device link on an asset that already has a
            // primary entity link would collide. `status` is the honest fallback: the device row
            // says "this hardware", not "this reading".
            role: hasPrimary(tx, assetId) ? "status" : "primary",
            atMs: at,
          }),
        );
      }
      for (const entity of input.entities) {
        linkIds.push(
          insertEntityLink(tx, ctx, {
            assetId,
            registryId: entity.registryId,
            role: entity.role,
            atMs: at,
          }),
        );
      }

      resolveAlert(tx, ctx, `ha_link_missing:asset:${assetId}`);
      writeAudit(tx, ctx, {
        entityTable: "asset",
        entityId: assetId,
        action: created ? "created" : "updated",
        summary:
          `${created ? "created from" : "linked to"} Home Assistant device ` +
          `${device.nameByUser ?? device.name ?? device.deviceId} with ${linkIds.length} link(s)`,
      });

      return { assetId, created, linkCount: linkIds.length, isVirtual };
    }),
  );

  revalidatePath("/equipment");
  revalidatePath(`/equipment/${result.assetId}`);
  revalidatePath("/settings/home-assistant");
  return result;
});

/**
 * Bulk "import & link" for a registry with hundreds of devices.
 *
 * Entity roles come from explicit choices on each selected device. Nothing here infers a role from
 * an entity name, domain or device class.
 *
 * Already-linked devices are skipped rather than duplicated, and the result reports the three
 * outcomes separately so the caller can state them instead of claiming "imported 50".
 */
export const importHaDevices = action(importDevicesInput, async (input, session) => {
  const category = mapDomainErrors((): AssetCategory => {
    if (!isAssetCategory(input.category)) {
      throw new ValidationError("unknown_category", `unknown equipment category ${input.category}`);
    }
    return input.category;
  });

  const { db } = getDb();
  const result = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const at = nowMs();
      const mappings = input.useMappedLocation ? readAreaMappings(tx) : new Map();

      const created: string[] = [];
      const skipped: { deviceId: string; reason: string }[] = [];

      for (const selectedDevice of input.devices) {
        const { deviceId } = selectedDevice;
        const device = tx.select().from(haDevice).where(eq(haDevice.deviceId, deviceId)).get();
        if (!device) {
          skipped.push({ deviceId, reason: "not_in_registry" });
          continue;
        }
        if (device.removedAtMs !== null) {
          skipped.push({ deviceId, reason: "removed_in_ha" });
          continue;
        }
        if (linkedAssetIdFor(tx, deviceId) !== null) {
          skipped.push({ deviceId, reason: "already_linked" });
          continue;
        }

        const isVirtual = device.entryType === "service";
        // Only a *confirmed* mapping sets a location in bulk. A suggestion is the name matcher's
        // guess, and applying it to a batch would turn a guess into recorded fact.
        const mapping = device.areaId === null ? undefined : mappings.get(device.areaId);
        const locationId =
          !isVirtual && mapping?.source === "confirmed" ? mapping.locationId : null;

        const assetId = newId();
        tx.insert(asset)
          .values({
            id: assetId,
            name: device.nameByUser ?? device.name ?? deviceId,
            category,
            manufacturer: device.manufacturer,
            modelName: device.model,
            serialNumber: null,
            productCode: null,
            locationId,
            parentAssetId: null,
            isVirtual,
            status: "installed",
            installedOn: null,
            installedOnPrecision: "unknown",
            currency: "EUR",
            notes: null,
            createdAtMs: at,
            createdBy: ctx.actorUserId,
            updatedAtMs: at,
            updatedBy: ctx.actorUserId,
          })
          .run();

        insertDeviceLink(tx, ctx, { assetId, deviceId, role: "primary", atMs: at });
        for (const selectedEntity of selectedDevice.entities) {
          const entity = tx
            .select({ deviceId: haEntity.deviceId, removedAtMs: haEntity.removedAtMs })
            .from(haEntity)
            .where(eq(haEntity.registryId, selectedEntity.registryId))
            .get();
          if (!entity || entity.removedAtMs !== null) {
            throw new ValidationError(
              "entity_not_linkable",
              `entity ${selectedEntity.registryId} is no longer linkable`,
            );
          }
          if (entity.deviceId !== deviceId) {
            throw new ValidationError(
              "entity_device_mismatch",
              `entity ${selectedEntity.registryId} does not belong to device ${deviceId}`,
            );
          }
          insertEntityLink(tx, ctx, {
            assetId,
            registryId: selectedEntity.registryId,
            role: selectedEntity.role,
            atMs: at,
          });
        }
        resolveAlert(tx, ctx, `ha_link_missing:asset:${assetId}`);
        writeAudit(tx, ctx, {
          entityTable: "asset",
          entityId: assetId,
          action: "created",
          summary:
            `created from Home Assistant device ${device.nameByUser ?? device.name ?? deviceId} ` +
            `with ${selectedDevice.entities.length} entity link(s) ` +
            `in a bulk import of ${input.devices.length}`,
        });
        created.push(assetId);
      }

      return { createdCount: created.length, skipped };
    }),
  );

  revalidatePath("/equipment");
  revalidatePath("/settings/home-assistant");
  return result;
});

/** Any active link for this device, entity links included — the "already imported" test. */
function linkedAssetIdFor(tx: Db, deviceId: string): string | null {
  const byDevice = tx
    .select({ assetId: assetHaLink.assetId })
    .from(assetHaLink)
    .where(and(eq(assetHaLink.haDeviceId, deviceId), inArray(assetHaLink.linkState, ACTIVE_LINKS)))
    .get();
  if (byDevice) return byDevice.assetId;
  const byEntity = tx
    .select({ assetId: assetHaLink.assetId })
    .from(assetHaLink)
    .innerJoin(haEntity, eq(haEntity.registryId, assetHaLink.haEntityRegistryId))
    .where(and(eq(haEntity.deviceId, deviceId), inArray(assetHaLink.linkState, ACTIVE_LINKS)))
    .get();
  return byEntity?.assetId ?? null;
}

const ACTIVE_LINKS = ["active", "renamed"] as const;

/** Does this asset already hold the `primary` role? The partial unique index allows exactly one. */
function hasPrimary(tx: Db, assetId: string): boolean {
  return (
    tx
      .select({ id: assetHaLink.id })
      .from(assetHaLink)
      .where(and(eq(assetHaLink.assetId, assetId), eq(assetHaLink.role, "primary")))
      .get() !== undefined
  );
}
