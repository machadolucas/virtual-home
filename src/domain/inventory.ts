/**
 * Inventory: the append-only stock ledger and everything that writes to it.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.8 and §5.
 *
 * The one rule the whole module exists to protect:
 *
 *     available(part) = SUM(stock_transaction.qty_milli WHERE part_id = part)
 *
 * — full stop. There is no `+ kits × ratio` term anywhere, so opening a box is an explicit,
 * audited "kit explode" (`explodeKit`) rather than a derivation. Nothing here ever UPDATEs or
 * DELETEs a ledger row: a mistake is corrected by a mirror row that points at the original with
 * `reverses_transaction_id`, and the unique index on that column makes double reversal impossible.
 *
 * Every function takes a `tx` that is already inside `writeTx()` (CLAUDE.md rule 3); the top-level
 * entry points that open their own transaction live in `completion.ts` and `condition.ts`.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { newId } from "@/db/ids";
import {
  appAlert,
  assetConsumable,
  auditLog,
  conditionRule,
  kitComponent,
  maintenanceOccurrence,
  part,
  partLot,
  partStock,
  planMaterial,
  procedureMaterial,
  storagePlace,
  stockTransaction,
  type AppAlertKind,
  type AppAlertSeverity,
  type ConsumableRole,
  type StockTransactionKind,
  type StockTransactionReason,
} from "@/db/schema";
import { NotFoundError, ValidationError, ConflictError } from "@/domain/errors";
import { localDateOf, type Clock } from "@/domain/time";

/** The actor + calendar context every write in this module needs. Mirrors `occurrence.ts`. */
export interface DomainContext {
  clock: Clock;
  tz: string;
  actorUserId: string | null;
  actorKind: "user" | "worker" | "system" | "ha";
}

export type PartRow = typeof part.$inferSelect;
export type PartLotRow = typeof partLot.$inferSelect;
export type StockTransactionRow = typeof stockTransaction.$inferSelect;
export type AppAlertRow = typeof appAlert.$inferSelect;

/** One part's balance, straight off the `part_stock` view (no cache table, no drift). */
export interface StockLevel {
  partId: string;
  /** Every ledger row, including rows dated in the future. */
  onHandMilli: number;
  /** Excludes future-dated rows (a purchase recorded ahead of delivery). */
  effectiveMilli: number;
  lastMovementMs: number | null;
}

/* -------------------------------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------------------------------- */

export function getPart(tx: Db, partId: string): PartRow {
  const row = tx.select().from(part).where(eq(part.id, partId)).get();
  if (!row) throw new NotFoundError("part", partId);
  return row;
}

/** `getStock` for one part. Throws `NotFoundError` for an unknown part id. */
export function getStock(tx: Db, partId: string): StockLevel {
  const row = tx.select().from(partStock).where(eq(partStock.partId, partId)).get();
  if (!row) throw new NotFoundError("part", partId);
  return {
    partId: row.partId,
    onHandMilli: row.onHandMilli,
    effectiveMilli: row.effectiveMilli,
    lastMovementMs: row.lastMovementMs ?? null,
  };
}

/**
 * The authoritative availability number used by the completion transaction (§5.1 step 5a): a plain
 * SUM over the ledger, optionally narrowed to one lot. Deliberately *not* the view's
 * `effective_milli` — the completion check must not depend on the wall clock.
 */
export function availableMilli(tx: Db, partId: string, lotId?: string | null): number {
  const where =
    lotId === undefined || lotId === null
      ? eq(stockTransaction.partId, partId)
      : and(eq(stockTransaction.partId, partId), eq(stockTransaction.lotId, lotId));
  const row = tx
    .select({ total: sql<number>`COALESCE(SUM(${stockTransaction.qtyMilli}), 0)` })
    .from(stockTransaction)
    .where(where)
    .get();
  return row?.total ?? 0;
}

/** Most recent ledger rows for a part, newest first. */
export function stockHistory(tx: Db, partId: string, limit = 50): StockTransactionRow[] {
  return tx
    .select()
    .from(stockTransaction)
    .where(eq(stockTransaction.partId, partId))
    .orderBy(desc(stockTransaction.occurredAtMs), desc(stockTransaction.createdAtMs))
    .limit(limit)
    .all();
}

/* -------------------------------------------------------------------------------------------------
 * Alerts (the `app_alert` table lives in this module's schema file)
 * ---------------------------------------------------------------------------------------------- */

export interface RaiseAlertInput {
  kind: AppAlertKind;
  severity: AppAlertSeverity;
  title: string;
  body?: string | null;
  entityTable?: string | null;
  entityId?: string | null;
  /** Stable per real-world problem — re-raising bumps the counters instead of adding noise. */
  dedupeKey: string;
}

/**
 * Raise (or re-raise) an in-app alert. Idempotent per `dedupeKey` while unresolved, which is what
 * the partial unique index buys us.
 */
export function raiseAlert(tx: Db, ctx: DomainContext, input: RaiseAlertInput): AppAlertRow {
  const now = ctx.clock.now();
  const existing = tx
    .select()
    .from(appAlert)
    .where(and(eq(appAlert.dedupeKey, input.dedupeKey), isNull(appAlert.resolvedAtMs)))
    .get();

  if (existing) {
    const updated = tx
      .update(appAlert)
      .set({
        lastSeenAtMs: now,
        seenCount: existing.seenCount + 1,
        title: input.title,
        body: input.body ?? existing.body,
      })
      .where(eq(appAlert.id, existing.id))
      .returning()
      .get();
    return updated;
  }

  return tx
    .insert(appAlert)
    .values({
      id: newId(),
      kind: input.kind,
      severity: input.severity,
      entityTable: input.entityTable ?? null,
      entityId: input.entityId ?? null,
      title: input.title,
      body: input.body ?? null,
      dedupeKey: input.dedupeKey,
      firstSeenAtMs: now,
      lastSeenAtMs: now,
      seenCount: 1,
    })
    .returning()
    .get();
}

/** Mark every unresolved alert with this dedupe key resolved. */
export function resolveAlert(tx: Db, ctx: DomainContext, dedupeKey: string): number {
  const rows = tx
    .update(appAlert)
    .set({ resolvedAtMs: ctx.clock.now() })
    .where(and(eq(appAlert.dedupeKey, dedupeKey), isNull(appAlert.resolvedAtMs)))
    .returning()
    .all();
  return rows.length;
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 *
 * `writeAudit` lives here rather than in a module of its own because this file is the lowest layer
 * of the completion/inventory/condition slice — `assets.ts`, `completion.ts` and `condition.ts` all
 * import it, and it must not import them back.
 * ---------------------------------------------------------------------------------------------- */

export interface WriteAuditInput {
  entityTable: string;
  entityId: string;
  /** `'created'`, `'updated'`, `'completed'`, `'stock_adjusted'`, … */
  action: string;
  summary: string;
  /** `{ field: [before, after] }` — only for `action = 'updated'`. */
  changes?: Record<string, [unknown, unknown]>;
  requestId?: string | null;
}

export type AuditLogRow = typeof auditLog.$inferSelect;

/** One `audit_log` row per meaningful transition. Never written by a trigger — a trigger cannot
 * see the actor. */
export function writeAudit(tx: Db, ctx: DomainContext, input: WriteAuditInput): AuditLogRow {
  return tx
    .insert(auditLog)
    .values({
      id: newId(),
      atMs: ctx.clock.now(),
      actorKind: ctx.actorKind,
      actorUserId: ctx.actorUserId,
      entityTable: input.entityTable,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary,
      changesJson: input.changes ? JSON.stringify(input.changes) : null,
      requestId: input.requestId ?? null,
    })
    .returning()
    .get();
}

/* -------------------------------------------------------------------------------------------------
 * Writing the ledger
 * ---------------------------------------------------------------------------------------------- */

/** Kinds whose quantity must be positive (schema CHECK + `kit_explode_in`). */
const POSITIVE_KINDS: ReadonlySet<StockTransactionKind> = new Set([
  "purchase",
  "initial_count",
  "kit_explode_in",
]);

/** Kinds whose quantity must be negative. `consumption` is also a schema CHECK. */
const NEGATIVE_KINDS: ReadonlySet<StockTransactionKind> = new Set([
  "consumption",
  "kit_explode_out",
  "disposal",
]);

export interface RecordTransactionInput {
  partId: string;
  lotId?: string | null;
  storagePlaceId?: string | null;
  /** Signed thousandths; never zero. */
  qtyMilli: number;
  kind: StockTransactionKind;
  reason: StockTransactionReason;
  occurrenceId?: string | null;
  completionId?: string | null;
  transactionGroupId?: string | null;
  reversesTransactionId?: string | null;
  unitPriceCents?: number | null;
  /** When it physically happened; defaults to now. May be backdated. */
  occurredAtMs?: number;
  notes?: string | null;
}

/**
 * Append one row to the ledger. The only place in the codebase that inserts into
 * `stock_transaction`, so every sign rule and every lot/storage guard is enforced exactly once.
 */
export function recordTransaction(
  tx: Db,
  ctx: DomainContext,
  input: RecordTransactionInput,
): StockTransactionRow {
  const { qtyMilli, kind, reason } = input;

  if (!Number.isInteger(qtyMilli)) {
    throw new ValidationError("qty_not_integer", "qty_milli must be an integer number of thousandths", {
      qtyMilli,
    });
  }
  if (qtyMilli === 0) {
    throw new ValidationError("qty_zero", "a ledger row with qty_milli = 0 says nothing");
  }
  if (POSITIVE_KINDS.has(kind) && qtyMilli < 0) {
    throw new ValidationError("qty_sign", `${kind} requires a positive qty_milli`, { kind, qtyMilli });
  }
  if (NEGATIVE_KINDS.has(kind) && qtyMilli > 0) {
    throw new ValidationError("qty_sign", `${kind} requires a negative qty_milli`, { kind, qtyMilli });
  }

  const partRow = getPart(tx, input.partId);
  if (partRow.trackingMode === "discrete" && qtyMilli % 1000 !== 0) {
    throw new ValidationError(
      "qty_not_whole_unit",
      "a discrete part moves in whole units (multiples of 1000)",
      { partId: partRow.id, qtyMilli },
    );
  }

  const lotId = input.lotId ?? null;
  if (lotId !== null) {
    const lot = tx.select().from(partLot).where(eq(partLot.id, lotId)).get();
    if (!lot) throw new NotFoundError("part_lot", lotId);
    if (lot.partId !== partRow.id) {
      throw new ValidationError("lot_part_mismatch", "the lot belongs to a different part", {
        lotId,
        lotPartId: lot.partId,
        partId: partRow.id,
      });
    }
  }

  const storagePlaceId = input.storagePlaceId ?? partRow.defaultStoragePlaceId ?? null;
  if (storagePlaceId !== null) {
    const place = tx.select().from(storagePlace).where(eq(storagePlace.id, storagePlaceId)).get();
    if (!place) throw new NotFoundError("storage_place", storagePlaceId);
  }

  if (input.reversesTransactionId) {
    const original = tx
      .select()
      .from(stockTransaction)
      .where(eq(stockTransaction.id, input.reversesTransactionId))
      .get();
    if (!original) throw new NotFoundError("stock_transaction", input.reversesTransactionId);
    const already = tx
      .select({ id: stockTransaction.id })
      .from(stockTransaction)
      .where(eq(stockTransaction.reversesTransactionId, input.reversesTransactionId))
      .get();
    if (already) {
      throw new ConflictError("already_reversed", "that ledger row has already been reversed", {
        transactionId: input.reversesTransactionId,
        reversalId: already.id,
      });
    }
  }

  const occurredAtMs = input.occurredAtMs ?? ctx.clock.now();

  return tx
    .insert(stockTransaction)
    .values({
      id: newId(),
      partId: partRow.id,
      lotId,
      storagePlaceId,
      qtyMilli,
      kind,
      reason,
      occurrenceId: input.occurrenceId ?? null,
      completionId: input.completionId ?? null,
      transactionGroupId: input.transactionGroupId ?? null,
      reversesTransactionId: input.reversesTransactionId ?? null,
      unitPriceCents: input.unitPriceCents ?? null,
      occurredAtMs,
      occurredLocalDate: localDateOf(occurredAtMs, ctx.tz),
      notes: input.notes ?? null,
      createdAtMs: ctx.clock.now(),
      createdBy: ctx.actorUserId,
    })
    .returning()
    .get();
}

export interface PurchaseInput {
  partId: string;
  qtyMilli: number;
  lotId?: string | null;
  storagePlaceId?: string | null;
  unitPriceCents?: number | null;
  occurredAtMs?: number;
  notes?: string | null;
}

/** Goods arrived. */
export function purchase(tx: Db, ctx: DomainContext, input: PurchaseInput): StockTransactionRow {
  return recordTransaction(tx, ctx, { ...input, kind: "purchase", reason: "purchase" });
}

export interface AdjustStockTakeInput {
  partId: string;
  /** What was actually on the shelf, in thousandths. */
  countedMilli: number;
  notes?: string | null;
  lotId?: string | null;
  occurredAtMs?: number;
}

/**
 * A stock take. Writes the **delta** (`counted - recorded`), never an UPDATE — the ledger stays the
 * single source of the number. Returns `null` when the count already matches (nothing to record).
 */
export function adjustStockTake(
  tx: Db,
  ctx: DomainContext,
  input: AdjustStockTakeInput,
): StockTransactionRow | null {
  if (!Number.isInteger(input.countedMilli) || input.countedMilli < 0) {
    throw new ValidationError("counted_invalid", "countedMilli must be a non-negative integer", {
      countedMilli: input.countedMilli,
    });
  }
  const recorded = availableMilli(tx, input.partId, input.lotId ?? null);
  const delta = input.countedMilli - recorded;
  if (delta === 0) return null;

  const counted = `counted ${input.countedMilli} milli (recorded ${recorded} milli)`;
  return recordTransaction(tx, ctx, {
    partId: input.partId,
    lotId: input.lotId ?? null,
    qtyMilli: delta,
    kind: "adjustment",
    reason: "stock_take",
    occurredAtMs: input.occurredAtMs,
    notes: input.notes ? `${input.notes} — ${counted}` : counted,
  });
}

export interface ExplodeKitInput {
  kitPartId: string;
  /** Whole kits to open. */
  count: number;
  storagePlaceId?: string | null;
  occurredAtMs?: number;
  notes?: string | null;
}

export interface KitExplodeResult {
  groupId: string;
  /** The kit consumption row. */
  kitRow: StockTransactionRow;
  /** One addition per component. */
  componentRows: StockTransactionRow[];
}

/**
 * Open a box. One consumption of the kit plus one addition per component, all sharing a
 * `transaction_group_id`, in this one transaction. After the explode the components have stock and
 * the kit does not — which is precisely why nothing double counts.
 */
export function explodeKit(tx: Db, ctx: DomainContext, input: ExplodeKitInput): KitExplodeResult {
  const { count } = input;
  if (!Number.isInteger(count) || count <= 0) {
    throw new ValidationError("count_invalid", "count must be a positive whole number of kits", {
      count,
    });
  }
  const kit = getPart(tx, input.kitPartId);
  if (!kit.isKit) {
    throw new ValidationError("not_a_kit", "that part is not a kit", { partId: kit.id });
  }
  const components = tx
    .select()
    .from(kitComponent)
    .where(eq(kitComponent.kitPartId, kit.id))
    .all();
  if (components.length === 0) {
    throw new ValidationError("kit_empty", "the kit has no kit_component rows", { partId: kit.id });
  }

  const groupId = newId();
  const occurredAtMs = input.occurredAtMs ?? ctx.clock.now();
  const notes = input.notes ?? `kit explode ×${count}`;

  const kitRow = recordTransaction(tx, ctx, {
    partId: kit.id,
    qtyMilli: -count * 1000,
    kind: "kit_explode_out",
    reason: "kit_explode",
    transactionGroupId: groupId,
    storagePlaceId: input.storagePlaceId ?? null,
    occurredAtMs,
    notes,
  });

  const componentRows = components.map((component) =>
    recordTransaction(tx, ctx, {
      partId: component.componentPartId,
      qtyMilli: component.qtyMilli * count,
      kind: "kit_explode_in",
      reason: "kit_explode",
      transactionGroupId: groupId,
      storagePlaceId: input.storagePlaceId ?? null,
      occurredAtMs,
      notes,
    }),
  );

  return { groupId, kitRow, componentRows };
}

export interface UndoExplodeResult {
  groupId: string;
  reversalGroupId: string;
  rows: StockTransactionRow[];
}

/** The mirror-image group: the kit comes back, the components go away. */
export function undoExplode(tx: Db, ctx: DomainContext, groupId: string): UndoExplodeResult {
  const original = tx
    .select()
    .from(stockTransaction)
    .where(eq(stockTransaction.transactionGroupId, groupId))
    .all();
  if (original.length === 0) throw new NotFoundError("stock_transaction group", groupId);
  if (original.some((row) => row.reason !== "kit_explode")) {
    throw new ValidationError("not_a_kit_explode", "that transaction group is not a kit explode", {
      groupId,
    });
  }

  const reversalGroupId = newId();
  const occurredAtMs = ctx.clock.now();
  const rows = original.map((row) =>
    recordTransaction(tx, ctx, {
      partId: row.partId,
      lotId: row.lotId,
      storagePlaceId: row.storagePlaceId,
      qtyMilli: -row.qtyMilli,
      kind: row.qtyMilli < 0 ? "kit_explode_in" : "kit_explode_out",
      reason: "kit_explode_undo",
      transactionGroupId: reversalGroupId,
      reversesTransactionId: row.id,
      occurredAtMs,
      notes: `undo of kit explode ${groupId}`,
    }),
  );

  return { groupId, reversalGroupId, rows };
}

export interface SetEstimateInput {
  lotId: string;
  /** 0…100. */
  estimatePct: number;
  occurredAtMs?: number;
  notes?: string | null;
}

export interface SetEstimateResult {
  lot: PartLotRow;
  /** The delta row; `null` when the ledger already matched the new percentage. */
  transaction: StockTransactionRow | null;
  /** What the UI now displays, in thousandths. Equals the lot's ledger sum after this call. */
  remainingMilli: number;
}

/**
 * The "estimated remaining for liquids" dial. `estimate_pct` is the authoritative number for
 * `tracking_mode = 'estimated'` parts, so we write the **implied delta** into the ledger as well:
 * that keeps `SUM(qty_milli)` equal to the displayed remaining rather than letting the two drift.
 */
export function setEstimate(
  tx: Db,
  ctx: DomainContext,
  input: SetEstimateInput,
): SetEstimateResult {
  const { estimatePct } = input;
  if (!Number.isInteger(estimatePct) || estimatePct < 0 || estimatePct > 100) {
    throw new ValidationError("estimate_pct_invalid", "estimatePct must be an integer 0…100", {
      estimatePct,
    });
  }
  const lot = tx.select().from(partLot).where(eq(partLot.id, input.lotId)).get();
  if (!lot) throw new NotFoundError("part_lot", input.lotId);
  const partRow = getPart(tx, lot.partId);
  if (partRow.trackingMode !== "estimated") {
    throw new ValidationError("part_not_estimated", "only an estimated part carries a percentage", {
      partId: partRow.id,
      trackingMode: partRow.trackingMode,
    });
  }
  if (lot.initialQtyMilli === null) {
    throw new ValidationError(
      "lot_initial_qty_missing",
      "a percentage needs the lot's initial quantity to mean anything",
      { lotId: lot.id },
    );
  }

  const remainingMilli = Math.round((lot.initialQtyMilli * estimatePct) / 100);
  const current = availableMilli(tx, lot.partId, lot.id);
  const delta = remainingMilli - current;

  const transaction =
    delta === 0
      ? null
      : recordTransaction(tx, ctx, {
          partId: lot.partId,
          lotId: lot.id,
          qtyMilli: delta,
          kind: "estimate_update",
          reason: "estimate_update",
          occurredAtMs: input.occurredAtMs,
          notes: input.notes ?? `estimate set to ${estimatePct}%`,
        });

  const updated = tx
    .update(partLot)
    .set({ estimatePct, updatedAtMs: ctx.clock.now(), updatedBy: ctx.actorUserId })
    .where(eq(partLot.id, lot.id))
    .returning()
    .get();

  return { lot: updated, transaction, remainingMilli };
}

/**
 * Reverse one ledger row. Never an UPDATE: a mirror `correction` row points at the original, and
 * `UNIQUE(reverses_transaction_id)` makes a second reversal physically impossible.
 */
export function reverseTransaction(
  tx: Db,
  ctx: DomainContext,
  txnId: string,
  reason: StockTransactionReason = "manual_correction",
  notes?: string | null,
): StockTransactionRow {
  const original = tx
    .select()
    .from(stockTransaction)
    .where(eq(stockTransaction.id, txnId))
    .get();
  if (!original) throw new NotFoundError("stock_transaction", txnId);

  return recordTransaction(tx, ctx, {
    partId: original.partId,
    lotId: original.lotId,
    storagePlaceId: original.storagePlaceId,
    qtyMilli: -original.qtyMilli,
    kind: "correction",
    reason,
    occurrenceId: original.occurrenceId,
    completionId: original.completionId,
    transactionGroupId: newId(),
    reversesTransactionId: original.id,
    notes: notes ?? `reversal of ${original.kind} ${original.id}`,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Expected materials
 * ---------------------------------------------------------------------------------------------- */

export type ExpectedMaterialSource = "plan" | "procedure" | "asset_consumable" | "condition_rule";

export interface ExpectedMaterial {
  partId: string;
  qtyMilli: number;
  isRequired: boolean;
  source: ExpectedMaterialSource;
  /** `asset_consumable.role`, when that is where the line came from. */
  role?: ConsumableRole;
}

/** The subset of an occurrence `expectedMaterialsFor` actually reads. */
export interface OccurrenceLike {
  id: string;
  planId: string | null;
  procedureVersionId: string | null;
  assetId: string | null;
  source: "plan" | "manual" | "condition";
  conditionRuleId: string | null;
}

export interface ExpectedMaterialsOptions {
  /**
   * `asset_consumable` roles to pull in. Condition occurrences default to `['battery']`; for plan
   * and manual work the caller says which roles its procedure declares, because the schema has no
   * place to declare them (a future `procedure_consumable_role` table would be that place).
   */
  consumableRoles?: readonly ConsumableRole[];
}

/**
 * `plan_material` ∪ `procedure_material` (plan wins on a conflicting `part_id`) ∪
 * `asset_consumable` for the declared roles — the resolution order of §1.7 and §6.6.
 *
 * A condition occurrence has no plan materials, so its battery lines come from
 * `asset_consumable(role = 'battery')`, falling back to the rule's `default_part_id` at quantity 1.
 */
export function expectedMaterialsFor(
  tx: Db,
  occurrence: OccurrenceLike,
  options: ExpectedMaterialsOptions = {},
): ExpectedMaterial[] {
  const out: ExpectedMaterial[] = [];
  const seen = new Set<string>();

  const push = (line: ExpectedMaterial): void => {
    if (seen.has(line.partId)) return;
    seen.add(line.partId);
    out.push(line);
  };

  if (occurrence.planId !== null) {
    for (const row of tx
      .select()
      .from(planMaterial)
      .where(eq(planMaterial.planId, occurrence.planId))
      .orderBy(planMaterial.id)
      .all()) {
      push({
        partId: row.partId,
        qtyMilli: row.qtyMilli,
        isRequired: row.isRequired,
        source: "plan",
      });
    }
  }

  if (occurrence.procedureVersionId !== null) {
    for (const row of tx
      .select()
      .from(procedureMaterial)
      .where(eq(procedureMaterial.versionId, occurrence.procedureVersionId))
      .orderBy(procedureMaterial.id)
      .all()) {
      push({
        partId: row.partId,
        qtyMilli: row.qtyMilli,
        isRequired: row.isRequired,
        source: "procedure",
      });
    }
  }

  const roles: readonly ConsumableRole[] =
    options.consumableRoles ?? (occurrence.source === "condition" ? (["battery"] as const) : []);

  if (occurrence.assetId !== null && roles.length > 0) {
    const consumables = tx
      .select()
      .from(assetConsumable)
      .where(eq(assetConsumable.assetId, occurrence.assetId))
      .orderBy(assetConsumable.id)
      .all()
      .filter((row) => roles.includes(row.role));
    for (const row of consumables) {
      push({
        partId: row.partId,
        qtyMilli: row.qtyMilli,
        isRequired: true,
        source: "asset_consumable",
        role: row.role,
      });
    }
  }

  // A battery task with no `asset_consumable` row still needs a part: the rule's default, ×1.
  if (out.length === 0 && occurrence.conditionRuleId !== null) {
    const rule = tx
      .select()
      .from(conditionRule)
      .where(eq(conditionRule.id, occurrence.conditionRuleId))
      .get();
    if (rule?.defaultPartId) {
      push({
        partId: rule.defaultPartId,
        qtyMilli: 1000,
        isRequired: true,
        source: "condition_rule",
      });
    }
  }

  return out;
}

/** Load an occurrence in the shape `expectedMaterialsFor` wants. */
export function loadOccurrenceLike(tx: Db, occurrenceId: string): OccurrenceLike {
  const row = tx
    .select({
      id: maintenanceOccurrence.id,
      planId: maintenanceOccurrence.planId,
      procedureVersionId: maintenanceOccurrence.procedureVersionId,
      assetId: maintenanceOccurrence.assetId,
      source: maintenanceOccurrence.source,
      conditionRuleId: maintenanceOccurrence.conditionRuleId,
    })
    .from(maintenanceOccurrence)
    .where(eq(maintenanceOccurrence.id, occurrenceId))
    .get();
  if (!row) throw new NotFoundError("maintenance_occurrence", occurrenceId);
  return row;
}

/**
 * FEFO lot choice for a part that tracks lots: the open lot expiring soonest, else the one
 * purchased earliest, else any. Returns `null` when the part has no lots at all.
 */
export function pickLot(tx: Db, partId: string): PartLotRow | null {
  const lots = tx.select().from(partLot).where(eq(partLot.partId, partId)).all();
  if (lots.length === 0) return null;
  const open = lots.filter((lot) => lot.isOpen);
  const pool = open.length > 0 ? open : lots;
  const sorted = [...pool].sort((a, b) => {
    const ax = a.expiresOn ?? "9999-12-31";
    const bx = b.expiresOn ?? "9999-12-31";
    if (ax !== bx) return ax < bx ? -1 : 1;
    const ap = a.purchasedOn ?? "9999-12-31";
    const bp = b.purchasedOn ?? "9999-12-31";
    if (ap !== bp) return ap < bp ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return sorted[0] ?? null;
}
