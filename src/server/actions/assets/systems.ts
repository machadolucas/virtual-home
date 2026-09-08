"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { maintenancePlan, system, systemAsset, systemLocation } from "@/db/schema";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { userContext } from "@/server/queries/settings/household";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import { deleteSystemInput, upsertSystemInput } from "./schemas";

/**
 * Systems: the functional groupings that span rooms (ventilation, water, electrical).
 *
 * A system is the *other* thing a maintenance plan can target, alongside an asset and a location
 * (`ck_plan_one_target`), which is why deleting one is refused while a plan points at it — a
 * cascade there would silently orphan scheduled work.
 */

export const upsertSystem = action(upsertSystemInput, async (input, session) => {
  const { db } = getDb();
  const systemId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const at = nowMs();
      let id = input.systemId ?? null;

      if (id === null) {
        id = newId();
        tx.insert(system)
          .values({
            id,
            name: input.name,
            kind: input.kind,
            status: input.status,
            description: input.description ?? null,
            createdAtMs: at,
            createdBy: ctx.actorUserId,
            updatedAtMs: at,
            updatedBy: ctx.actorUserId,
          })
          .run();
      } else {
        const before = tx.select().from(system).where(eq(system.id, id)).get();
        if (!before) throw new NotFoundError("system", id);
        tx.update(system)
          .set({
            name: input.name,
            kind: input.kind,
            status: input.status,
            description: input.description ?? null,
            updatedAtMs: at,
            updatedBy: ctx.actorUserId,
          })
          .where(eq(system.id, id))
          .run();
      }

      // Membership is replaced wholesale: the editor posts the full set, so a diff here would only
      // add a way for the two to disagree.
      tx.delete(systemAsset).where(eq(systemAsset.systemId, id)).run();
      const seen = new Set<string>();
      for (const member of input.members) {
        if (seen.has(member.assetId)) {
          throw new ValidationError(
            "duplicate_member",
            "a unit can only be listed once in a system",
            { assetId: member.assetId },
          );
        }
        seen.add(member.assetId);
        tx.insert(systemAsset)
          .values({ systemId: id, assetId: member.assetId, role: member.role ?? null })
          .run();
      }

      tx.delete(systemLocation).where(eq(systemLocation.systemId, id)).run();
      for (const locationId of new Set(input.locationIds)) {
        tx.insert(systemLocation).values({ systemId: id, locationId }).run();
      }

      writeAudit(tx, ctx, {
        entityTable: "system",
        entityId: id,
        action: input.systemId === null ? "created" : "updated",
        summary: `system ${input.name} with ${input.members.length} unit(s) across ${new Set(input.locationIds).size} location(s)`,
      });
      return id;
    }),
  );
  revalidatePath("/equipment/systems");
  revalidatePath("/equipment");
  return { systemId };
});

export const deleteSystem = action(deleteSystemInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const row = tx.select().from(system).where(eq(system.id, input.systemId)).get();
      if (!row) throw new NotFoundError("system", input.systemId);
      const plan = tx
        .select({ id: maintenancePlan.id, title: maintenancePlan.title })
        .from(maintenancePlan)
        .where(eq(maintenancePlan.systemId, input.systemId))
        .get();
      if (plan) {
        throw new ValidationError(
          "system_has_plans",
          `“${plan.title}” is scheduled against this system — retarget or cancel it first`,
          { planId: plan.id },
        );
      }
      // `system_asset` / `system_location` cascade; the system row itself is the only delete.
      tx.delete(system).where(eq(system.id, input.systemId)).run();
      writeAudit(tx, ctx, {
        entityTable: "system",
        entityId: input.systemId,
        action: "deleted",
        summary: `system ${row.name} deleted`,
      });
    }),
  );
  revalidatePath("/equipment/systems");
  revalidatePath("/equipment");
  return { ok: true as const };
});
