"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { nowMs } from "@/db/ids";
import { assetHaLink, haEntity } from "@/db/schema";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { resolveAlert, writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { userContext } from "@/server/queries/settings/household";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import { insertDeviceLink, insertEntityLink } from "./linkWrites";
import { linkHaDeviceInput, linkHaEntityInput, relinkHaInput, setLinkStateInput, unlinkHaInput } from "./schemas";

/**
 * Creating, repairing and removing the Home Assistant link.
 *
 * The rule these actions exist to keep (§7.2): **relinking is never automatic.** Repointing a link
 * asserts that a new registry entry is physically the same device as the old one, and only the
 * household can make that claim. So `relinkHa` is a button, `suggestRelinks` is a suggestion, and
 * nothing in the worker does either.
 */

function revalidateLinks(assetId: string): void {
  revalidatePath(`/equipment/${assetId}`);
  revalidatePath("/equipment");
  revalidatePath("/settings/home-assistant");
}

export const linkHaEntity = action(linkHaEntityInput, async (input, session) => {
  const { db } = getDb();
  const linkId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const id = insertEntityLink(tx, ctx, {
        assetId: input.assetId,
        registryId: input.registryId,
        role: input.role,
        notes: input.notes ?? null,
        atMs: nowMs(),
      });
      // The asset now has a link, so the "link this unit" alert (raised by `replaceAsset`) is
      // answered. Resolving here rather than waiting for the worker keeps the page honest.
      resolveAlert(tx, ctx, `ha_link_missing:asset:${input.assetId}`);
      return id;
    }),
  );
  revalidateLinks(input.assetId);
  return { linkId };
});

export const linkHaDevice = action(linkHaDeviceInput, async (input, session) => {
  const { db } = getDb();
  const linkId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const id = insertDeviceLink(tx, ctx, {
        assetId: input.assetId,
        deviceId: input.deviceId,
        role: input.role,
        notes: input.notes ?? null,
        atMs: nowMs(),
      });
      resolveAlert(tx, ctx, `ha_link_missing:asset:${input.assetId}`);
      return id;
    }),
  );
  revalidateLinks(input.assetId);
  return { linkId };
});

/**
 * Point a broken link at a live registry entry.
 *
 * Only a `missing` link may be repaired: repointing an `active` link would be a silent identity
 * change on something that currently works, and that is a different, more dangerous operation than
 * "the thing I linked came back with a new id".
 */
export const relinkHa = action(relinkHaInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const link = tx.select().from(assetHaLink).where(eq(assetHaLink.id, input.linkId)).get();
      if (!link) throw new NotFoundError("asset_ha_link", input.linkId);
      if (link.assetId !== input.assetId) {
        throw new ValidationError("link_asset_mismatch", "that link belongs to another unit");
      }
      if (link.linkState !== "missing") {
        throw new ValidationError(
          "link_not_missing",
          "only a link whose Home Assistant entry has disappeared can be repointed",
          { linkState: link.linkState },
        );
      }
      const entity = tx
        .select()
        .from(haEntity)
        .where(eq(haEntity.registryId, input.registryId))
        .get();
      if (!entity) throw new NotFoundError("ha_entity", input.registryId);
      if (entity.removedAtMs !== null) {
        throw new ValidationError(
          "entity_removed",
          "that registry entry is itself gone from Home Assistant",
        );
      }

      const at = nowMs();
      tx.update(assetHaLink)
        .set({
          haEntityRegistryId: entity.registryId,
          entityIdSnapshot: entity.entityId,
          uniqueIdSnapshot: entity.uniqueId,
          platformSnapshot: entity.platform,
          linkState: "active",
          linkStateChangedAtMs: at,
          updatedAtMs: at,
          updatedBy: ctx.actorUserId,
        })
        .where(eq(assetHaLink.id, input.linkId))
        .run();

      writeAudit(tx, ctx, {
        entityTable: "asset_ha_link",
        entityId: input.linkId,
        action: "ha_link_repaired",
        summary: `repointed to ${entity.entityId}`,
        changes: {
          ha_entity_registry_id: [link.haEntityRegistryId, entity.registryId],
          link_state: [link.linkState, "active"],
        },
      });
      resolveAlert(tx, ctx, `ha_link_missing:asset:${input.assetId}`);
    }),
  );
  revalidateLinks(input.assetId);
  return { linkId: input.linkId };
});

/**
 * Retire or reactivate a link without deleting it.
 *
 * `missing` and `replaced` are states the system assigns, so they are not offered here: a person
 * choosing "missing" by hand would be asserting something about Home Assistant that only a sync
 * can establish.
 */
export const setHaLinkState = action(setLinkStateInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const link = tx.select().from(assetHaLink).where(eq(assetHaLink.id, input.linkId)).get();
      if (!link) throw new NotFoundError("asset_ha_link", input.linkId);
      if (link.assetId !== input.assetId) {
        throw new ValidationError("link_asset_mismatch", "that link belongs to another unit");
      }
      if (input.linkState === "active" && link.linkState === "missing") {
        throw new ValidationError(
          "link_still_missing",
          "the Home Assistant entry is gone — repoint the link instead of marking it active",
        );
      }
      const at = nowMs();
      tx.update(assetHaLink)
        .set({
          linkState: input.linkState,
          linkStateChangedAtMs: at,
          updatedAtMs: at,
          updatedBy: ctx.actorUserId,
        })
        .where(eq(assetHaLink.id, input.linkId))
        .run();
      writeAudit(tx, ctx, {
        entityTable: "asset_ha_link",
        entityId: input.linkId,
        action: "updated",
        summary: `link ${input.linkState}`,
        changes: { link_state: [link.linkState, input.linkState] },
      });
    }),
  );
  revalidateLinks(input.assetId);
  return { linkId: input.linkId };
});

/**
 * Remove a link entirely.
 *
 * This *is* a delete, unlike retiring: it is for a link that was created by mistake, where keeping
 * a row saying "we once wrongly connected the sauna heater to the doorbell" is noise rather than
 * history. The audit row records that it happened.
 */
export const unlinkHa = action(unlinkHaInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const link = tx.select().from(assetHaLink).where(eq(assetHaLink.id, input.linkId)).get();
      if (!link) throw new NotFoundError("asset_ha_link", input.linkId);
      if (link.assetId !== input.assetId) {
        throw new ValidationError("link_asset_mismatch", "that link belongs to another unit");
      }
      tx.delete(assetHaLink).where(eq(assetHaLink.id, input.linkId)).run();
      writeAudit(tx, ctx, {
        entityTable: "asset",
        entityId: input.assetId,
        action: "updated",
        summary: `Home Assistant link removed (${link.entityIdSnapshot ?? link.haDeviceId ?? link.id})`,
      });
    }),
  );
  revalidateLinks(input.assetId);
  return { ok: true as const };
});
