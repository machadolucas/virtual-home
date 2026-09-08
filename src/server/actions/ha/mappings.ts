"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { location, locationMapping } from "@/db/schema";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { suggestLocationMappings } from "@/server/ha/registryCache";
import { userContext } from "@/server/queries/settings/household";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import { decideMappingInput } from "./schemas";
import { z } from "zod";

/**
 * Deciding HA area/floor -> app location mappings.
 *
 * §7.3's rule: a suggestion is never auto-confirmed. A confirmed mapping defaults the location of
 * every piece of equipment imported from that area and groups the 3D view, so it is a claim about
 * the house that a person makes. `rejected` is a real, sticky decision too — it stops the
 * suggester re-proposing the same pairing on every sync.
 */

export const decideLocationMapping = action(decideMappingInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const at = nowMs();
      const existing = tx
        .select()
        .from(locationMapping)
        .where(
          and(eq(locationMapping.haKind, input.haKind), eq(locationMapping.haId, input.haId)),
        )
        .get();

      if (input.decision === "clear") {
        if (!existing) return;
        tx.delete(locationMapping).where(eq(locationMapping.id, existing.id)).run();
        writeAudit(tx, ctx, {
          entityTable: "location_mapping",
          entityId: existing.id,
          action: "deleted",
          summary: `mapping for ${input.haKind} ${input.haId} cleared`,
        });
        return;
      }

      if (input.decision === "reject") {
        // A rejection still needs a `location_id` (the column is NOT NULL). Keeping the rejected
        // pairing is the point: it is what the suggester checks before proposing again.
        const locationId = input.locationId ?? existing?.locationId ?? null;
        if (locationId === null) {
          throw new ValidationError(
            "reject_needs_target",
            "rejecting records which pairing was rejected, so it needs the location that was proposed",
          );
        }
        upsert(tx, existing?.id ?? null, {
          haKind: input.haKind,
          haId: input.haId,
          locationId,
          source: "rejected",
          at,
          actorUserId: ctx.actorUserId,
        });
        writeAudit(tx, ctx, {
          entityTable: "location_mapping",
          entityId: existing?.id ?? input.haId,
          action: "updated",
          summary: `mapping ${input.haKind} ${input.haId} rejected`,
        });
        return;
      }

      // confirm
      if (input.locationId == null) {
        throw new ValidationError("confirm_needs_location", "choose a location to confirm");
      }
      const target = tx.select().from(location).where(eq(location.id, input.locationId)).get();
      if (!target) throw new NotFoundError("location", input.locationId);
      if (input.haKind === "area" && target.kind === "floor") {
        throw new ValidationError(
          "area_mapped_to_floor",
          "an HA area is a room-sized thing — map it to a room or a zone, and map the HA floor to the floor",
        );
      }
      upsert(tx, existing?.id ?? null, {
        haKind: input.haKind,
        haId: input.haId,
        locationId: input.locationId,
        source: "confirmed",
        at,
        actorUserId: ctx.actorUserId,
      });
      writeAudit(tx, ctx, {
        entityTable: "location_mapping",
        entityId: existing?.id ?? input.haId,
        action: "updated",
        summary: `${input.haKind} ${input.haId} confirmed as ${target.name}`,
      });
    }),
  );
  revalidatePath("/settings/home-assistant");
  revalidatePath("/equipment");
  return { ok: true as const };
});

function upsert(
  tx: Parameters<Parameters<typeof writeTx>[1]>[0],
  id: string | null,
  values: {
    haKind: "area" | "floor";
    haId: string;
    locationId: string;
    source: "confirmed" | "rejected";
    at: number;
    actorUserId: string | null;
  },
): void {
  const row = {
    haKind: values.haKind,
    haId: values.haId,
    locationId: values.locationId,
    source: values.source,
    // Confidence only means something for a suggestion; a decision replaces it.
    confidence: null,
    matchReason: "manual",
    decidedBy: values.actorUserId,
    decidedAtMs: values.at,
    updatedAtMs: values.at,
    updatedBy: values.actorUserId,
  };
  if (id === null) {
    tx.insert(locationMapping)
      .values({ id: newId(), ...row, createdAtMs: values.at, createdBy: values.actorUserId })
      .run();
  } else {
    tx.update(locationMapping).set(row).where(eq(locationMapping.id, id)).run();
  }
}

/**
 * Re-run the name matcher over the cached registry.
 *
 * `suggestLocationMappings` only ever writes `source='suggested'` rows for pairings that have no
 * row at all, so this is safe to press repeatedly: it cannot overwrite a confirmation and cannot
 * resurrect a rejection.
 *
 * Two things it now avoids. It does not open a second write transaction to record that nothing
 * happened — an audit row per fruitless press is noise in the one log that is supposed to be a
 * record of decisions. And it returns `locationCount`, because "no new exact name matches were
 * found" is the wrong sentence when the household has no rooms to match *against*: the matcher
 * returns early in that case and never compares a single name.
 */
export const refreshMappingSuggestions = action(z.object({}).optional(), async (_input, session) => {
  const handle = getDb();
  const locationCount =
    handle.db.select({ n: sql<number>`count(*)` }).from(location).get()?.n ?? 0;
  const suggestions = suggestLocationMappings(handle, nowMs());
  if (suggestions.length > 0) {
    writeTx(handle.db, (tx) => {
      const ctx = userContext(session, tx);
      writeAudit(tx, ctx, {
        entityTable: "location_mapping",
        entityId: "suggestions",
        action: "updated",
        summary: `${suggestions.length} new mapping suggestion(s) from exact name matches`,
      });
    });
  }
  revalidatePath("/settings/home-assistant");
  return { added: suggestions.length, locationCount };
});
