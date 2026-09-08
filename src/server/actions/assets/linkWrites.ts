import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { newId } from "@/db/ids";
import { assetHaLink, haDevice, haEntity, type HaLinkRole } from "@/db/schema";
import { NotFoundError } from "@/domain/errors";
import { writeAudit, type DomainContext } from "@/domain/inventory";

/**
 * Writes that create an `asset_ha_link` row.
 *
 * Not a `"use server"` module: those may only export async functions, and these are synchronous
 * helpers called from inside an already-open `writeTx`. Both the equipment actions and the
 * HA-import actions use them, so they live here rather than being written twice.
 */

/**
 * Insert an entity link, carrying the snapshots across from the registry cache.
 *
 * The snapshots are informational only (CLAUDE.md rule 8 — the FK is the registry id) but they are
 * what makes a relink suggestion possible after the registry entry disappears. So they are
 * captured at link time rather than looked up later from a row that no longer exists.
 */
export function insertEntityLink(
  tx: Db,
  ctx: DomainContext,
  input: {
    assetId: string;
    registryId: string;
    role: HaLinkRole;
    notes?: string | null;
    atMs: number;
  },
): string {
  const entity = tx
    .select()
    .from(haEntity)
    .where(eq(haEntity.registryId, input.registryId))
    .get();
  if (!entity) throw new NotFoundError("ha_entity", input.registryId);
  const id = newId();
  tx.insert(assetHaLink)
    .values({
      id,
      assetId: input.assetId,
      linkKind: "entity",
      haDeviceId: null,
      haEntityRegistryId: input.registryId,
      role: input.role,
      entityIdSnapshot: entity.entityId,
      uniqueIdSnapshot: entity.uniqueId,
      platformSnapshot: entity.platform,
      linkState: "active",
      linkStateChangedAtMs: input.atMs,
      notes: input.notes ?? null,
      createdAtMs: input.atMs,
      createdBy: ctx.actorUserId,
      updatedAtMs: input.atMs,
      updatedBy: ctx.actorUserId,
    })
    .run();
  writeAudit(tx, ctx, {
    entityTable: "asset_ha_link",
    entityId: id,
    action: "created",
    summary: `linked ${entity.entityId} as ${input.role}`,
  });
  return id;
}

/** Insert a device-level link. `link_kind='device'` forbids an entity id (`ck_asset_ha_link_target`). */
export function insertDeviceLink(
  tx: Db,
  ctx: DomainContext,
  input: {
    assetId: string;
    deviceId: string;
    role: HaLinkRole;
    notes?: string | null;
    atMs: number;
  },
): string {
  const device = tx
    .select()
    .from(haDevice)
    .where(eq(haDevice.deviceId, input.deviceId))
    .get();
  if (!device) throw new NotFoundError("ha_device", input.deviceId);
  const id = newId();
  tx.insert(assetHaLink)
    .values({
      id,
      assetId: input.assetId,
      linkKind: "device",
      haDeviceId: input.deviceId,
      haEntityRegistryId: null,
      role: input.role,
      entityIdSnapshot: null,
      uniqueIdSnapshot: null,
      platformSnapshot: null,
      linkState: "active",
      linkStateChangedAtMs: input.atMs,
      notes: input.notes ?? null,
      createdAtMs: input.atMs,
      createdBy: ctx.actorUserId,
      updatedAtMs: input.atMs,
      updatedBy: ctx.actorUserId,
    })
    .run();
  writeAudit(tx, ctx, {
    entityTable: "asset_ha_link",
    entityId: id,
    action: "created",
    summary: `linked device ${device.nameByUser ?? device.name ?? input.deviceId} as ${input.role}`,
  });
  return id;
}
