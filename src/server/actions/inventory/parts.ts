"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  kitComponent,
  part,
  partCompatibility,
  partLot,
  partSupplier,
} from "@/db/schema";
import { ValidationError } from "@/domain/errors";
import { getPart, writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { userContext } from "@/server/queries/settings/household";
import { mapDomainErrors } from "./errors";
import {
  archivePartInput,
  createPartInput,
  removeSupplierInput,
  setKitComponentsInput,
  updatePartInput,
  upsertLotInput,
  upsertSupplierInput,
} from "./schemas";

/**
 * Part definition writes.
 *
 * Nothing here touches `stock_transaction` — creating a part does not create stock, and editing a
 * part's threshold does not move a number. That separation is what keeps the ledger the only
 * source of "how many do I have" (§1.8).
 */

function revalidateSupplies(partId?: string): void {
  revalidatePath("/supplies");
  revalidatePath("/supplies/shopping");
  if (partId !== undefined) revalidatePath(`/supplies/${partId}`);
}

/**
 * `stock_mode` is derived from a checkbox rather than exposed as an enum: the only legal
 * `not_stocked` row is a kit (`ck_part_kit_stock_mode`), and asking a person to pick between two
 * words that mean the same thing for 95 % of parts is a worse form.
 */
function stockModeOf(isKit: boolean, stocked: boolean): "stocked" | "not_stocked" {
  if (!isKit) return "stocked";
  return stocked ? "stocked" : "not_stocked";
}

/** Reject a reorder target below its threshold: it would suggest an order that stays below it. */
function assertReorderPair(
  thresholdMilli: number | null | undefined,
  targetMilli: number | null | undefined,
): void {
  if (
    thresholdMilli !== null &&
    thresholdMilli !== undefined &&
    targetMilli !== null &&
    targetMilli !== undefined &&
    targetMilli < thresholdMilli
  ) {
    throw new ValidationError(
      "reorder_target_below_threshold",
      "the reorder target must be at least the threshold, or every order would leave the part still low",
      { thresholdMilli, targetMilli },
    );
  }
}

export const createPart = action(createPartInput, async (input, session) => {
  const { db } = getDb();
  // Inside `mapDomainErrors` even though it runs before the transaction: a `ValidationError` that
  // escapes it reaches `action()` as a generic failure, and the screen would say "something went
  // wrong" where the domain had said exactly what was wrong.
  mapDomainErrors(() => {
    assertReorderPair(input.reorderThresholdMilli, input.reorderTargetMilli);
    if (!input.isKit && input.components.length > 0) {
      throw new ValidationError(
        "components_on_non_kit",
        "only a kit carries a parts list — tick “this is a kit” first",
      );
    }
  });

  const partId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const at = nowMs();
      const id = newId();
      tx.insert(part)
        .values({
          id,
          name: input.name,
          spec: input.spec ?? null,
          dimensions: input.dimensions ?? null,
          manufacturer: input.manufacturer ?? null,
          productCode: input.productCode ?? null,
          ean: input.ean ?? null,
          trackingMode: input.trackingMode,
          unit: input.unit,
          isKit: input.isKit,
          stockMode: stockModeOf(input.isKit, input.stocked),
          reorderThresholdMilli: input.reorderThresholdMilli ?? null,
          reorderTargetMilli: input.reorderTargetMilli ?? null,
          leadTimeDays: input.leadTimeDays ?? null,
          defaultStoragePlaceId: input.defaultStoragePlaceId ?? null,
          tracksLots: input.tracksLots,
          notes: input.notes ?? null,
          createdAtMs: at,
          createdBy: ctx.actorUserId,
          updatedAtMs: at,
          updatedBy: ctx.actorUserId,
        })
        .run();

      for (const component of input.components) {
        if (component.componentPartId === id) {
          throw new ValidationError("kit_self_component", "a kit cannot contain itself");
        }
        tx.insert(kitComponent)
          .values({
            kitPartId: id,
            componentPartId: component.componentPartId,
            qtyMilli: component.qtyMilli,
          })
          .run();
      }

      for (const supplier of input.suppliers) {
        tx.insert(partSupplier)
          .values({
            id: newId(),
            partId: id,
            supplierName: supplier.supplierName,
            supplierSku: supplier.supplierSku ?? null,
            url: supplier.url ?? null,
            lastPriceCents: supplier.lastPriceCents ?? null,
            currency: supplier.currency ?? "EUR",
            packQtyMilli: supplier.packQtyMilli ?? null,
            leadTimeDays: supplier.leadTimeDays ?? null,
            isPreferred: supplier.isPreferred,
            note: supplier.note ?? null,
          })
          .run();
      }

      for (const entry of input.compatibility) {
        if (!entry.assetId && !entry.assetModelName) {
          throw new ValidationError(
            "compatibility_target_missing",
            "a compatibility row needs either a piece of equipment or a model name",
          );
        }
        tx.insert(partCompatibility)
          .values({
            id: newId(),
            partId: id,
            assetId: entry.assetId ?? null,
            assetModelName: entry.assetModelName ?? null,
            manufacturer: entry.manufacturer ?? null,
            confidence: entry.confidence,
            note: entry.note ?? null,
          })
          .run();
      }

      writeAudit(tx, ctx, {
        entityTable: "part",
        entityId: id,
        action: "created",
        summary: `part ${input.name} created`,
      });
      return id;
    }),
  );

  revalidateSupplies(partId);
  return { partId };
});

export const updatePart = action(updatePartInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() => assertReorderPair(input.reorderThresholdMilli, input.reorderTargetMilli));

  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const before = getPart(tx, input.partId);
      // Changing `is_kit` after the fact would silently reinterpret every existing ledger row for
      // this part, so it is not editable. Create the right kind of part instead.
      if (before.isKit !== input.isKit) {
        throw new ValidationError(
          "is_kit_immutable",
          "whether a part is a kit cannot be changed later — its existing stock rows mean different things on each side of that line",
        );
      }
      const next = {
        name: input.name,
        spec: input.spec ?? null,
        dimensions: input.dimensions ?? null,
        manufacturer: input.manufacturer ?? null,
        productCode: input.productCode ?? null,
        ean: input.ean ?? null,
        trackingMode: input.trackingMode,
        unit: input.unit,
        stockMode: stockModeOf(input.isKit, input.stocked),
        reorderThresholdMilli: input.reorderThresholdMilli ?? null,
        reorderTargetMilli: input.reorderTargetMilli ?? null,
        leadTimeDays: input.leadTimeDays ?? null,
        defaultStoragePlaceId: input.defaultStoragePlaceId ?? null,
        tracksLots: input.tracksLots,
        notes: input.notes ?? null,
        updatedAtMs: nowMs(),
        updatedBy: ctx.actorUserId,
      };
      tx.update(part).set(next).where(eq(part.id, input.partId)).run();

      const changes: Record<string, [unknown, unknown]> = {};
      for (const [key, value] of Object.entries(next)) {
        if (key === "updatedAtMs" || key === "updatedBy") continue;
        const previous = (before as unknown as Record<string, unknown>)[key];
        if (previous !== value) changes[key] = [previous, value];
      }
      if (Object.keys(changes).length > 0) {
        writeAudit(tx, ctx, {
          entityTable: "part",
          entityId: input.partId,
          action: "updated",
          summary: `part ${input.name} updated`,
          changes,
        });
      }
    }),
  );

  revalidateSupplies(input.partId);
  return { partId: input.partId };
});

export const setKitComponents = action(setKitComponentsInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const kit = getPart(tx, input.partId);
      if (!kit.isKit) {
        throw new ValidationError("not_a_kit", "only a kit has a parts list", { partId: kit.id });
      }
      tx.delete(kitComponent).where(eq(kitComponent.kitPartId, input.partId)).run();
      for (const component of input.components) {
        if (component.componentPartId === input.partId) {
          throw new ValidationError("kit_self_component", "a kit cannot contain itself");
        }
        // Depth is capped at 1 here: a kit whose component is itself a kit would need the
        // acyclicity walk the design note allows up to depth 3, and nothing in the UI creates one.
        const component_ = getPart(tx, component.componentPartId);
        if (component_.isKit) {
          throw new ValidationError(
            "nested_kit",
            "a kit inside a kit is not supported — list the individual parts instead",
            { componentPartId: component_.id },
          );
        }
        tx.insert(kitComponent)
          .values({
            kitPartId: input.partId,
            componentPartId: component.componentPartId,
            qtyMilli: component.qtyMilli,
          })
          .run();
      }
      writeAudit(tx, ctx, {
        entityTable: "part",
        entityId: input.partId,
        action: "updated",
        summary: `kit contents set to ${input.components.length} component(s)`,
      });
    }),
  );
  revalidateSupplies(input.partId);
  return { partId: input.partId };
});

export const upsertSupplier = action(upsertSupplierInput, async (input, session) => {
  const { db } = getDb();
  const supplierId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      getPart(tx, input.partId);
      // The partial unique index allows one preferred supplier per part, so demote the incumbent
      // in the same transaction rather than letting the insert fail.
      if (input.isPreferred) {
        tx.update(partSupplier)
          .set({ isPreferred: false })
          .where(and(eq(partSupplier.partId, input.partId), eq(partSupplier.isPreferred, true)))
          .run();
      }
      const values = {
        partId: input.partId,
        supplierName: input.supplierName,
        supplierSku: input.supplierSku ?? null,
        url: input.url ?? null,
        lastPriceCents: input.lastPriceCents ?? null,
        currency: input.currency ?? "EUR",
        packQtyMilli: input.packQtyMilli ?? null,
        leadTimeDays: input.leadTimeDays ?? null,
        isPreferred: input.isPreferred,
        note: input.note ?? null,
      };
      let id = input.supplierId ?? null;
      if (id === null) {
        id = newId();
        tx.insert(partSupplier).values({ id, ...values }).run();
      } else {
        tx.update(partSupplier).set(values).where(eq(partSupplier.id, id)).run();
      }
      writeAudit(tx, ctx, {
        entityTable: "part_supplier",
        entityId: id,
        action: input.supplierId === null ? "created" : "updated",
        summary: `supplier ${input.supplierName} for part ${input.partId}`,
      });
      return id;
    }),
  );
  revalidateSupplies(input.partId);
  return { supplierId };
});

export const removeSupplier = action(removeSupplierInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      tx.delete(partSupplier).where(eq(partSupplier.id, input.supplierId)).run();
      writeAudit(tx, ctx, {
        entityTable: "part_supplier",
        entityId: input.supplierId,
        action: "deleted",
        summary: "supplier link removed",
      });
    }),
  );
  revalidateSupplies(input.partId);
  return { ok: true as const };
});

export const upsertLot = action(upsertLotInput, async (input, session) => {
  const { db } = getDb();
  const lotId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const partRow = getPart(tx, input.partId);
      if (!partRow.tracksLots) {
        throw new ValidationError(
          "part_does_not_track_lots",
          "turn on lot tracking for this part before adding a lot",
          { partId: partRow.id },
        );
      }
      if (partRow.trackingMode === "estimated" && (input.initialQtyMilli ?? null) === null) {
        throw new ValidationError(
          "lot_initial_qty_missing",
          "an estimated part needs the container's full size, or a percentage means nothing",
        );
      }
      const at = nowMs();
      const values = {
        partId: input.partId,
        label: input.label,
        storagePlaceId: input.storagePlaceId ?? null,
        purchasedOn: input.purchasedOn ?? null,
        expiresOn: input.expiresOn ?? null,
        openedOn: input.openedOn ?? null,
        initialQtyMilli: input.initialQtyMilli ?? null,
        isOpen: input.isOpen,
        notes: input.notes ?? null,
        updatedAtMs: at,
        updatedBy: ctx.actorUserId,
      };
      let id = input.lotId ?? null;
      if (id === null) {
        id = newId();
        tx.insert(partLot)
          .values({ id, ...values, createdAtMs: at, createdBy: ctx.actorUserId })
          .run();
      } else {
        tx.update(partLot).set(values).where(eq(partLot.id, id)).run();
      }
      writeAudit(tx, ctx, {
        entityTable: "part_lot",
        entityId: id,
        action: input.lotId === null ? "created" : "updated",
        summary: `lot ${input.label}`,
      });
      return id;
    }),
  );
  revalidateSupplies(input.partId);
  return { lotId };
});

export const setPartArchived = action(archivePartInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const row = getPart(tx, input.partId);
      tx.update(part)
        .set({
          archivedAtMs: input.archived ? nowMs() : null,
          updatedAtMs: nowMs(),
          updatedBy: ctx.actorUserId,
        })
        .where(eq(part.id, input.partId))
        .run();
      writeAudit(tx, ctx, {
        entityTable: "part",
        entityId: input.partId,
        action: "updated",
        summary: `part ${row.name} ${input.archived ? "archived" : "restored"}`,
        changes: { archived: [!input.archived, input.archived] },
      });
    }),
  );
  revalidateSupplies(input.partId);
  return { partId: input.partId };
});

/**
 * A tiny read exposed as an action so the new-part form can check a product code without a page
 * reload. Read-only, but still behind `action()` so it requires a session like everything else.
 */
export const findPartByProductCode = action(
  z.object({ manufacturer: z.string().trim().min(1), productCode: z.string().trim().min(1) }),
  async (input) => {
    const { db } = getDb();
    const row = db
      .select({ id: part.id, name: part.name })
      .from(part)
      .where(
        and(eq(part.manufacturer, input.manufacturer), eq(part.productCode, input.productCode)),
      )
      .get();
    return { existing: row ?? null };
  },
);
