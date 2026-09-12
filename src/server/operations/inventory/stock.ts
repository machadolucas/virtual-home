import "server-only";

import { revalidatePath } from "@/server/operations/core";
import { getDb, writeTx } from "@/db/client";
import {
  adjustStockTake,
  explodeKit as explodeKitDomain,
  getPart,
  purchase,
  reverseTransaction,
  setEstimate as setEstimateDomain,
  undoExplode as undoExplodeDomain,
  writeAudit,
} from "@/domain/inventory";
import { ValidationError } from "@/domain/errors";
import { instantOf } from "@/domain/time";
import { isWholeUnit } from "@/features/inventory/units";
import { defineOperation as action } from "@/server/operations/core";
import { userContext } from "@/server/queries/settings/household";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import {
  addPurchaseInput,
  correctTransactionInput,
  explodeKitInput,
  setEstimateInput,
  stockTakeInput,
  undoExplodeInput,
} from "@/server/actions/inventory/schemas";

/**
 * The five ledger writes the supplies UI offers, each a thin wrapper over `@/domain/inventory`.
 *
 * These wrappers do three things and no more: open the transaction, build the `DomainContext`
 * (which needs the household time zone), and turn a household-local date into an instant. Every
 * sign rule, lot guard and reversal rule stays in the domain, where it is tested.
 */

function revalidateFor(partId: string): void {
  revalidatePath("/supplies");
  revalidatePath("/supplies/shopping");
  revalidatePath(`/supplies/${partId}`);
  // Equipment pages show consumable stock beside each part.
  revalidatePath("/equipment");
}

/**
 * A backdated movement happens at **noon** household-local on that date, not midnight.
 *
 * Midnight is the wrong choice twice over: it sits on the DST boundary in some zones, and a
 * purchase "on the 3rd" recorded at 00:00 sorts before everything else that day, which reads as
 * though it happened before movements it followed. Noon is unambiguous in every zone.
 */
function instantForLocalDate(date: string, tz: string): number {
  return instantOf(date, "12:00", tz);
}

export const addPurchase = action(addPurchaseInput, (input, session) => {
  const { db } = getDb();
  const result = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const partRow = getPart(tx, input.partId);
      if (partRow.trackingMode === "discrete" && !isWholeUnit(input.qtyMilli)) {
        throw new ValidationError(
          "qty_not_whole_unit",
          `${partRow.name} is counted in whole units — enter a whole number`,
          { qtyMilli: input.qtyMilli },
        );
      }
      return purchase(tx, ctx, {
        partId: input.partId,
        qtyMilli: input.qtyMilli,
        lotId: input.lotId ?? null,
        storagePlaceId: input.storagePlaceId ?? null,
        unitPriceCents: input.unitPriceCents ?? null,
        occurredAtMs:
          input.occurredOn === undefined
            ? undefined
            : instantForLocalDate(input.occurredOn, ctx.tz),
        notes: input.notes ?? null,
      });
    }),
  );
  revalidateFor(input.partId);
  return { transactionId: result.id, qtyMilli: result.qtyMilli };
});

/**
 * A stock take records the **delta**, never the count. `adjustStockTake` returns `null` when the
 * shelf already matched, and that is a real, useful outcome: "counted, nothing changed" is worth
 * saying and not worth a ledger row.
 */
export const stockTake = action(stockTakeInput, (input, session) => {
  const { db } = getDb();
  const result = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const partRow = getPart(tx, input.partId);
      if (partRow.trackingMode === "discrete" && !isWholeUnit(input.countedMilli)) {
        throw new ValidationError(
          "qty_not_whole_unit",
          `${partRow.name} is counted in whole units — enter a whole number`,
          { countedMilli: input.countedMilli },
        );
      }
      const row = adjustStockTake(tx, ctx, {
        partId: input.partId,
        countedMilli: input.countedMilli,
        lotId: input.lotId ?? null,
        notes: input.notes ?? null,
        occurredAtMs:
          input.occurredOn === undefined
            ? undefined
            : instantForLocalDate(input.occurredOn, ctx.tz),
      });
      if (row === null) {
        // Still audited: "somebody counted and it matched" is evidence the number is trustworthy.
        writeAudit(tx, ctx, {
          entityTable: "part",
          entityId: input.partId,
          action: "stock_counted",
          summary: `stock take matched the ledger (${input.countedMilli} milli)`,
        });
      }
      return row;
    }),
  );
  revalidateFor(input.partId);
  return {
    transactionId: result?.id ?? null,
    deltaMilli: result?.qtyMilli ?? 0,
    matched: result === null,
  };
});

export const explodeKit = action(explodeKitInput, (input, session) => {
  const { db } = getDb();
  const result = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      return explodeKitDomain(tx, ctx, {
        kitPartId: input.kitPartId,
        count: input.count,
        storagePlaceId: input.storagePlaceId ?? null,
        notes: input.notes ?? null,
      });
    }),
  );
  revalidateFor(input.kitPartId);
  for (const row of result.componentRows) revalidatePath(`/supplies/${row.partId}`);
  return {
    groupId: result.groupId,
    componentPartIds: result.componentRows.map((row) => row.partId),
  };
});

export const undoExplode = action(undoExplodeInput, (input, session) => {
  const { db } = getDb();
  const result = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      return undoExplodeDomain(tx, ctx, input.groupId);
    }),
  );
  revalidateFor(input.kitPartId);
  for (const row of result.rows) revalidatePath(`/supplies/${row.partId}`);
  return { reversalGroupId: result.reversalGroupId, rowCount: result.rows.length };
});

/**
 * Correct one ledger row. Never an UPDATE: the domain writes a mirror `correction` row that points
 * at the original, and `UNIQUE(reverses_transaction_id)` makes a second correction impossible —
 * which is why the UI hides the button once a row has been corrected.
 */
export const correctTransaction = action(correctTransactionInput, (input, session) => {
  const { db } = getDb();
  const row = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      return reverseTransaction(tx, ctx, input.transactionId, input.reason, input.notes);
    }),
  );
  revalidateFor(input.partId);
  return { transactionId: row.id, qtyMilli: row.qtyMilli };
});

export const setEstimate = action(setEstimateInput, (input, session) => {
  const { db } = getDb();
  const result = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      return setEstimateDomain(tx, ctx, {
        lotId: input.lotId,
        estimatePct: input.estimatePct,
        notes: input.notes ?? null,
      });
    }),
  );
  revalidateFor(input.partId);
  return {
    estimatePct: result.lot.estimatePct,
    remainingMilli: result.remainingMilli,
    transactionId: result.transaction?.id ?? null,
  };
});
