/**
 * The completion transaction: the single place work is recorded as done and stock leaves the shelf.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §5.
 *
 * Three properties this module exists to guarantee, all of them tested:
 *
 *  1. **Idempotency.** `completion.request_id` is a client-generated key. The same tap arriving
 *     twice (a retry, or HA re-emitting a notification action) short-circuits on the first probe:
 *     no second completion, no second deduction, no state change. This is the single most
 *     important line in the system (§5.1 step 1).
 *  2. **Atomicity.** Materials, stock rows, the replacement, the occurrence close and the successor
 *     all happen in one `BEGIN IMMEDIATE` transaction. A failure anywhere rolls back everything —
 *     there is no state where stock moved but the completion did not exist.
 *  3. **Stock is never invented.** If a line asks for more than the ledger has, the server does not
 *     guess: it throws `InsufficientStockError` listing the three honest options, and the user
 *     picks. Retrying reuses the same `request_id`, so a lost response cannot double-complete.
 *
 * The three entry points here (`completeOccurrence`, `voidCompletion`, `correctCompletion`) take a
 * `DbHandle` and open their own `writeTx`. Everything else in this slice takes a `tx`.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import {
  auditLog,
  completion,
  completionMaterial,
  conditionEpisode,
  maintenanceOccurrence,
  maintenancePlan,
  partLot,
  stockTransaction,
  type CompletionOutcome,
  type CompletionPrecision,
  type CompletionSource,
  type MaterialResolution,
  type ReplacementReason,
  type StockResolution,
} from "@/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/domain/errors";
import { compareLocalDate, localDateOf, type Clock, type LocalDate } from "@/domain/time";
import {
  anchorForCompletion,
  loadOccurrence,
  loadPlan,
  markCompleted,
  openOccurrenceOfPlan,
  reopenAfterVoid,
  successorBlockers,
  writeOccurrenceEvent,
} from "@/domain/occurrence";
import { computeNextDue, parseRecurrenceRule } from "@/domain/recurrence";
import { rearmRecipientStates } from "@/domain/notify/recipients";
import {
  availableMilli,
  expectedMaterialsFor,
  getPart,
  pickLot,
  raiseAlert,
  recordTransaction,
  writeAudit,
  type DomainContext,
} from "@/domain/inventory";
import { replaceAsset, type ExistingAssetRef, type NewAssetInput } from "@/domain/assets";

export type CompletionRow = typeof completion.$inferSelect;
export type CompletionMaterialRow = typeof completionMaterial.$inferSelect;
export type StockTransactionRow = typeof stockTransaction.$inferSelect;
export type OccurrenceRow = typeof maintenanceOccurrence.$inferSelect;
/** Whatever `markCompleted` reports about the successor it generated. */
export type NextOccurrence = ReturnType<typeof markCompleted>["next"];

/** How the user wants a short line handled. Mandatory once a line is actually short. */
export type ShortResolution = "adjust_up" | "consume_available" | "note_discrepancy";

export const SHORT_RESOLUTION_OPTIONS = [
  "adjust_up",
  "consume_available",
  "note_discrepancy",
] as const satisfies readonly ShortResolution[];

export interface CompletionMaterialInput {
  partId: string;
  lotId?: string | null;
  storagePlaceId?: string | null;
  expectedQtyMilli?: number | null;
  /** What was really used. `0` records "we expected to use one, we did not". */
  actualQtyMilli: number;
  resolutionIfShort?: ShortResolution;
  notes?: string | null;
}

export interface CompletionReplacementInput {
  newAsset: NewAssetInput | ExistingAssetRef;
  reason: ReplacementReason;
  cloneConsumables?: boolean;
  cloneHaLinks?: boolean;
  notes?: string | null;
}

export interface CompletionInput {
  /** Client-generated UUIDv7, or `'act:' + nonce` for a notification action. REQUIRED. */
  requestId: string;
  occurrenceId: string;
  /** May be in the past; never more than 5 minutes in the future. */
  completedAtMs: number;
  completedAtPrecision?: CompletionPrecision;
  performedByUserId?: string | null;
  performedByProviderId?: string | null;
  recordedByUserId?: string | null;
  notes?: string | null;
  effortMinutes?: number | null;
  outcome?: CompletionOutcome;
  /** Omitted ⇒ the occurrence's expected materials (§1.7 resolution order). */
  materials?: CompletionMaterialInput[];
  replacement?: CompletionReplacementInput;
  source?: CompletionSource;
}

export interface StockResolutionLine {
  partId: string;
  lotId: string | null;
  expectedQtyMilli: number | null;
  actualQtyMilli: number;
  availableMilli: number;
  shortfallMilli: number;
  resolution: MaterialResolution;
  consumptionTransactionId: string | null;
  adjustmentTransactionId: string | null;
}

export interface CompleteOccurrenceResult {
  completion: CompletionRow;
  /** `null` on an idempotent replay — a replay changes nothing, including the successor. */
  next: NextOccurrence | null;
  stockResolution: StockResolution;
  materials: CompletionMaterialRow[];
  lines: StockResolutionLine[];
  /** True when the request id had already been recorded and this call did nothing. */
  idempotentReplay: boolean;
  replacement: { oldAssetId: string; newAssetId: string; replacementId: string } | null;
}

/* -------------------------------------------------------------------------------------------------
 * Insufficient stock
 * ---------------------------------------------------------------------------------------------- */

export interface InsufficientStockLine {
  partId: string;
  partName: string;
  lotId: string | null;
  availableMilli: number;
  requestedMilli: number;
  options: readonly ShortResolution[];
}

/**
 * The structured 409 of §5.3. The completion form keeps every field the user typed and adds a
 * per-line radio group; retrying reuses the same `requestId`, so a first attempt that actually
 * committed replays idempotently instead of double-completing.
 */
export class InsufficientStockError extends Error {
  readonly code = "insufficient_stock";
  readonly lines: InsufficientStockLine[];

  constructor(lines: InsufficientStockLine[]) {
    super(
      `insufficient stock for ${lines.length} line(s): ` +
        lines.map((l) => `${l.partName} needs ${l.requestedMilli}, has ${l.availableMilli}`).join("; "),
    );
    this.name = "InsufficientStockError";
    this.lines = lines;
  }
}

export function isInsufficientStockError(err: unknown): err is InsufficientStockError {
  return err instanceof InsufficientStockError;
}

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** `'discrepancy_noted' > 'consumed_available' > 'adjusted_up' > 'sufficient' > 'none'` (§5.1.6). */
const RESOLUTION_RANK: Record<StockResolution, number> = {
  none: 0,
  sufficient: 1,
  adjusted_up: 2,
  consumed_available: 3,
  discrepancy_noted: 4,
};

function worstResolution(lines: readonly MaterialResolution[]): StockResolution {
  let worst: StockResolution = "none";
  for (const line of lines) {
    if (RESOLUTION_RANK[line] > RESOLUTION_RANK[worst]) worst = line;
  }
  return worst;
}

/** Five minutes of clock skew is tolerated; anything beyond is a future completion (§5.1.3). */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const OPEN_STATUSES = new Set(["pending", "due"]);

function lineKey(partId: string, lotId: string | null): string {
  return `${partId}|${lotId ?? ""}`;
}

function loadCompletionMaterials(tx: Db, completionId: string): CompletionMaterialRow[] {
  return tx
    .select()
    .from(completionMaterial)
    .where(eq(completionMaterial.completionId, completionId))
    .orderBy(asc(completionMaterial.id))
    .all();
}

/** Test seam for §9 item 44: inject a failure after the material rows are written. */
export interface CompleteOccurrenceHooks {
  afterMaterials?: () => void;
}

/* -------------------------------------------------------------------------------------------------
 * completeOccurrence
 * ---------------------------------------------------------------------------------------------- */

/**
 * Record that work happened. One `BEGIN IMMEDIATE` transaction, the steps of §5.1 in order.
 *
 * Concurrency (§5.2): two people pressing Done carry *different* request ids, so SQLite serialises
 * them, the winner commits and the loser's re-read sees `status = 'completed'` and throws
 * `ConflictError('already_closed')` — exactly one completion, exactly one deduction.
 */
export function completeOccurrence(
  handle: DbHandle,
  ctx: DomainContext,
  input: CompletionInput,
  hooks: CompleteOccurrenceHooks = {},
): CompleteOccurrenceResult {
  return writeTx(handle.db, (tx) => completeOccurrenceInTx(tx, ctx, input, hooks));
}

/** The body of `completeOccurrence`, for callers that already hold the write transaction. */
export function completeOccurrenceInTx(
  tx: Db,
  ctx: DomainContext,
  input: CompletionInput,
  hooks: CompleteOccurrenceHooks = {},
): CompleteOccurrenceResult {
  const now = ctx.clock.now();

  // 1. Idempotency probe. No stock movement, no state change, no audit row.
  const existing = tx
    .select()
    .from(completion)
    .where(eq(completion.requestId, input.requestId))
    .get();
  if (existing) {
    return {
      completion: existing,
      next: null,
      stockResolution: existing.stockResolution,
      materials: loadCompletionMaterials(tx, existing.id),
      lines: [],
      idempotentReplay: true,
      replacement: null,
    };
  }

  // 2. Load and guard. We already hold the write lock, so this read is the serialisation point.
  const occurrence = tx
    .select()
    .from(maintenanceOccurrence)
    .where(eq(maintenanceOccurrence.id, input.occurrenceId))
    .get();
  if (!occurrence) throw new NotFoundError("maintenance_occurrence", input.occurrenceId);
  if (!OPEN_STATUSES.has(occurrence.status)) {
    throw new ConflictError("already_closed", `occurrence is ${occurrence.status}`, {
      occurrenceId: occurrence.id,
      status: occurrence.status,
      completionId: occurrence.completionId,
      closedAtMs: occurrence.closedAtMs,
    });
  }

  // 3. Derive dates. Backdating is legitimate; a future completion is not.
  if (input.completedAtMs > now + FUTURE_TOLERANCE_MS) {
    throw new ValidationError("completed_in_future", "a completion cannot be in the future", {
      completedAtMs: input.completedAtMs,
      nowMs: now,
    });
  }
  const completedLocalDate = localDateOf(input.completedAtMs, ctx.tz);

  // A completion always names who did the work: a household user, or a professional. When neither
  // is given we fall back to the actor, because "someone typed Done" is who did it.
  const performedByProviderId = input.performedByProviderId ?? null;
  const performedByUserId =
    input.performedByUserId ?? (performedByProviderId === null ? ctx.actorUserId : null);
  if (performedByUserId === null && performedByProviderId === null) {
    throw new ValidationError(
      "no_performer",
      "a completion needs a performer: a household user or a service provider",
      { occurrenceId: occurrence.id },
    );
  }

  // 4. Materials — the caller's lines, or what the occurrence expects.
  const materialInputs: CompletionMaterialInput[] =
    input.materials ??
    expectedMaterialsFor(tx, occurrence).map((line) => ({
      partId: line.partId,
      expectedQtyMilli: line.qtyMilli,
      actualQtyMilli: line.qtyMilli,
    }));

  // 5a. Resolve each line's lot and availability *before* writing anything, so an unresolved
  // shortfall throws with every short line enumerated and the transaction rolls back whole.
  interface PreparedLine {
    input: CompletionMaterialInput;
    partName: string;
    trackingMode: string;
    lotId: string | null;
    lotNote: string | null;
    availableMilli: number;
  }

  const consumedSoFar = new Map<string, number>();
  const prepared: PreparedLine[] = [];
  const short: InsufficientStockLine[] = [];

  for (const line of materialInputs) {
    if (!Number.isInteger(line.actualQtyMilli) || line.actualQtyMilli < 0) {
      throw new ValidationError("actual_qty_invalid", "actualQtyMilli must be a non-negative integer", {
        partId: line.partId,
        actualQtyMilli: line.actualQtyMilli,
      });
    }
    const partRow = getPart(tx, line.partId);
    if (partRow.trackingMode === "discrete" && line.actualQtyMilli % 1000 !== 0) {
      throw new ValidationError(
        "qty_not_whole_unit",
        "a discrete part is used in whole units (multiples of 1000)",
        { partId: partRow.id, actualQtyMilli: line.actualQtyMilli },
      );
    }

    // 5f. Lot handling: FEFO when the part tracks lots and the caller did not choose.
    let lotId = line.lotId ?? null;
    let lotNote: string | null = null;
    if (lotId === null && partRow.tracksLots) {
      const lot = pickLot(tx, partRow.id);
      if (lot) {
        lotId = lot.id;
        lotNote = `lot chosen automatically (FEFO): ${lot.label}`;
      }
    }

    const key = lineKey(partRow.id, lotId);
    const alreadyTaken = consumedSoFar.get(key) ?? 0;
    const available = availableMilli(tx, partRow.id, lotId) - alreadyTaken;

    prepared.push({
      input: line,
      partName: partRow.name,
      trackingMode: partRow.trackingMode,
      lotId,
      lotNote,
      availableMilli: available,
    });

    if (line.actualQtyMilli > 0) {
      consumedSoFar.set(key, alreadyTaken + line.actualQtyMilli);
      if (line.actualQtyMilli > available && line.resolutionIfShort === undefined) {
        short.push({
          partId: partRow.id,
          partName: partRow.name,
          lotId,
          availableMilli: available,
          requestedMilli: line.actualQtyMilli,
          options: SHORT_RESOLUTION_OPTIONS,
        });
      }
    }
  }

  if (short.length > 0) {
    // Throwing rolls the whole transaction back: no completion, no stock rows, nothing partial.
    throw new InsufficientStockError(short);
  }

  // 4 (cont.) Insert the completion. `asset_id` snapshots the unit that was *serviced* — the old
  // one on a replacement, which is what makes per-unit history honest (§5.5 step 4).
  const completionId = newId();
  tx.insert(completion)
    .values({
      id: completionId,
      requestId: input.requestId,
      occurrenceId: occurrence.id,
      planId: occurrence.planId,
      assetId: occurrence.assetId,
      procedureVersionId: occurrence.procedureVersionId,
      completedAtMs: input.completedAtMs,
      completedLocalDate,
      completedAtPrecision: input.completedAtPrecision ?? "exact",
      performedByUserId,
      performedByProviderId,
      recordedBy: input.recordedByUserId ?? ctx.actorUserId,
      notes: input.notes ?? null,
      effortMinutes: input.effortMinutes ?? null,
      outcome: input.outcome ?? "done",
      stockResolution: "none",
      isReplacement: input.replacement !== undefined,
      source: input.source ?? "web",
      createdAtMs: now,
      createdBy: ctx.actorUserId,
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .run();

  // 5. Per material line, in input order — deterministic, so tests are stable.
  const groupId = newId();
  const lines: StockResolutionLine[] = [];

  for (const line of prepared) {
    const actual = line.input.actualQtyMilli;
    const available = line.availableMilli;
    let resolution: MaterialResolution = "sufficient";
    let shortfall = 0;
    let consumptionId: string | null = null;
    let adjustmentId: string | null = null;
    const notes: string[] = [];
    if (line.input.notes) notes.push(line.input.notes);
    if (line.lotNote) notes.push(line.lotNote);

    const consume = (qtyMilli: number): string => {
      const row = recordTransaction(tx, ctx, {
        partId: line.input.partId,
        lotId: line.lotId,
        storagePlaceId: line.input.storagePlaceId ?? null,
        qtyMilli: -qtyMilli,
        kind: "consumption",
        reason: "maintenance_consumption",
        occurrenceId: occurrence.id,
        completionId,
        transactionGroupId: groupId,
        occurredAtMs: input.completedAtMs,
      });
      return row.id;
    };

    if (actual === 0) {
      // A useful record with no movement: "we expected to use a filter, we did not."
      resolution = "sufficient";
    } else if (actual <= available) {
      consumptionId = consume(actual);
      resolution = "sufficient";
    } else {
      // The reconciliation branch: the completion is never lost and stock is never invented.
      const choice = line.input.resolutionIfShort;
      /* c8 ignore next 3 -- guarded by the pre-pass above */
      if (choice === undefined) {
        throw new ValidationError("resolution_required", "resolutionIfShort is mandatory here");
      }
      if (choice === "adjust_up") {
        // "There was more on the shelf than recorded." Net stock effect: zero.
        const missing = actual - available;
        adjustmentId = recordTransaction(tx, ctx, {
          partId: line.input.partId,
          lotId: line.lotId,
          storagePlaceId: line.input.storagePlaceId ?? null,
          qtyMilli: missing,
          kind: "adjustment",
          reason: "reconcile_missing_stock",
          occurrenceId: occurrence.id,
          completionId,
          transactionGroupId: groupId,
          occurredAtMs: input.completedAtMs,
          notes: `stock adjusted up by ${missing} milli: more on the shelf than recorded`,
        }).id;
        consumptionId = consume(actual);
        resolution = "adjusted_up";
        writeAudit(tx, ctx, {
          entityTable: "stock_transaction",
          entityId: adjustmentId,
          action: "stock_adjusted",
          summary: `${line.partName}: adjusted up ${missing} milli while completing "${occurrence.title}"`,
          requestId: input.requestId,
        });
      } else if (choice === "consume_available") {
        // "We only had this much recorded; the rest came from somewhere unrecorded."
        const usable = Math.max(available, 0);
        if (usable > 0) consumptionId = consume(usable);
        shortfall = actual - usable;
        resolution = "consumed_available";
        writeAudit(tx, ctx, {
          entityTable: "completion",
          entityId: completionId,
          action: "stock_shortfall",
          summary: `${line.partName}: used ${actual} milli, only ${usable} milli was recorded`,
          requestId: input.requestId,
        });
      } else {
        // "Record the truth now, fix the books later." The balance is allowed to go negative.
        consumptionId = consume(actual);
        resolution = "discrepancy_noted";
        const balance = availableMilli(tx, line.input.partId, line.lotId);
        if (balance < 0) {
          raiseAlert(tx, ctx, {
            kind: "negative_stock",
            severity: "warning",
            title: `${line.partName} is at ${balance} milli`,
            body:
              `Completing "${occurrence.title}" used more ${line.partName} than the ledger had. ` +
              `Reconcile with a stock take.`,
            entityTable: "part",
            entityId: line.input.partId,
            dedupeKey: `negative_stock:part:${line.input.partId}`,
          });
        }
        writeAudit(tx, ctx, {
          entityTable: "completion",
          entityId: completionId,
          action: "stock_discrepancy",
          summary: `${line.partName}: balance taken negative to ${balance} milli`,
          requestId: input.requestId,
        });
      }
    }

    tx.insert(completionMaterial)
      .values({
        id: newId(),
        completionId,
        partId: line.input.partId,
        lotId: line.lotId,
        expectedQtyMilli: line.input.expectedQtyMilli ?? null,
        actualQtyMilli: actual,
        shortfallMilli: shortfall,
        resolution,
        stockTransactionId: consumptionId,
        notes: notes.length > 0 ? notes.join(" · ") : null,
      })
      .run();

    // For an `estimated` part the dial is what the user reads, so keep it in step with the ledger
    // rather than writing a second delta on top of the consumption we just recorded.
    if (line.trackingMode === "estimated" && line.lotId !== null) {
      const lot = tx.select().from(partLot).where(eq(partLot.id, line.lotId)).get();
      if (lot && lot.initialQtyMilli !== null && lot.initialQtyMilli > 0) {
        const balance = availableMilli(tx, line.input.partId, line.lotId);
        const pct = Math.min(100, Math.max(0, Math.round((balance / lot.initialQtyMilli) * 100)));
        tx.update(partLot)
          .set({ estimatePct: pct, updatedAtMs: now, updatedBy: ctx.actorUserId })
          .where(eq(partLot.id, lot.id))
          .run();
      }
    }

    lines.push({
      partId: line.input.partId,
      lotId: line.lotId,
      expectedQtyMilli: line.input.expectedQtyMilli ?? null,
      actualQtyMilli: actual,
      availableMilli: available,
      shortfallMilli: shortfall,
      resolution,
      consumptionTransactionId: consumptionId,
      adjustmentTransactionId: adjustmentId,
    });
  }

  hooks.afterMaterials?.();

  // 6. The completion's own resolution is the worst of its lines.
  const stockResolution = worstResolution(lines.map((line) => line.resolution));

  // 9. Replacement, before the successor is generated: repointing the plans first means the
  // successor snapshots the *new* unit, which is what "forward-looking" means.
  let replacementResult: CompleteOccurrenceResult["replacement"] = null;
  if (input.replacement) {
    if (occurrence.assetId === null) {
      throw new ValidationError(
        "replacement_without_asset",
        "only an occurrence against an asset can record a replacement",
        { occurrenceId: occurrence.id },
      );
    }
    const swap = replaceAsset(tx, ctx, {
      oldAssetId: occurrence.assetId,
      newAsset: input.replacement.newAsset,
      replacedOn: completedLocalDate,
      reason: input.replacement.reason,
      occurrenceId: occurrence.id,
      completionId,
      cloneConsumables: input.replacement.cloneConsumables ?? false,
      cloneHaLinks: input.replacement.cloneHaLinks ?? false,
      notes: input.replacement.notes ?? null,
    });
    replacementResult = {
      oldAssetId: swap.oldAsset.id,
      newAssetId: swap.newAsset.id,
      replacementId: swap.replacement.id,
    };
  }

  const withResolution = tx
    .update(completion)
    .set({ stockResolution, updatedAtMs: now, updatedBy: ctx.actorUserId })
    .where(eq(completion.id, completionId))
    .returning()
    .get();

  // §6.6: a battery task that was actually done closes its condition episode as `completed` —
  // which is the *only* close reason that means maintenance happened.
  if (occurrence.conditionEpisodeId !== null) {
    tx.update(conditionEpisode)
      .set({ closedAtMs: now, closeReason: "completed" })
      .where(
        and(
          eq(conditionEpisode.id, occurrence.conditionEpisodeId),
          isNull(conditionEpisode.closedAtMs),
        ),
      )
      .run();
  }

  // 7, 8, 10. Close the occurrence, clear the notifications, generate the successor, move the
  // plan anchor — all of that is `occurrence.ts`'s job and all of it is still this transaction.
  const { next } = markCompleted(tx, ctx, {
    occurrenceId: occurrence.id,
    completionId,
    completedLocalDate,
    completedAtMs: input.completedAtMs,
  });

  // 11. Audit.
  writeAudit(tx, ctx, {
    entityTable: "completion",
    entityId: completionId,
    action: "completed",
    summary: `"${occurrence.title}" completed on ${completedLocalDate} (stock: ${stockResolution})`,
    requestId: input.requestId,
  });

  return {
    completion: withResolution,
    next,
    stockResolution,
    materials: loadCompletionMaterials(tx, completionId),
    lines,
    idempotentReplay: false,
    replacement: replacementResult,
  };
}

/* -------------------------------------------------------------------------------------------------
 * voidCompletion
 * ---------------------------------------------------------------------------------------------- */

export interface VoidCompletionInput {
  completionId: string;
  reason: string;
  /** Idempotency key for the void itself, recorded on the `audit_log` row. */
  requestId: string;
}

export interface VoidCompletionResult {
  completion: CompletionRow;
  /** The mirror rows written to restore the balance. */
  reversals: StockTransactionRow[];
  idempotentReplay: boolean;
}

/**
 * Undo a completion (§5.4). Nothing is deleted: the completion row and its material lines stay so
 * history reads "completed 12 Jun, voided 14 Jun by Lucas (wrong task)", and every stock row is
 * reversed by a mirror row whose `reverses_transaction_id` makes a second reversal impossible.
 */
export function voidCompletion(
  handle: DbHandle,
  ctx: DomainContext,
  input: VoidCompletionInput,
): VoidCompletionResult {
  return writeTx(handle.db, (tx) => {
    const now = ctx.clock.now();

    // 1. Idempotency probe on the void's own request id.
    const replay = tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.requestId, input.requestId), eq(auditLog.action, "completion_voided")))
      .get();
    if (replay) {
      const row = tx.select().from(completion).where(eq(completion.id, replay.entityId)).get();
      if (!row) throw new NotFoundError("completion", replay.entityId);
      return { completion: row, reversals: [], idempotentReplay: true };
    }

    // 2. Assert not already voided.
    const row = tx.select().from(completion).where(eq(completion.id, input.completionId)).get();
    if (!row) throw new NotFoundError("completion", input.completionId);
    if (row.voidedAtMs !== null) {
      throw new ConflictError("already_voided", "that completion has already been voided", {
        completionId: row.id,
        voidedAtMs: row.voidedAtMs,
      });
    }

    // 4. Mirror every stock row of the completion. `reverses_transaction_id IS NULL` skips the
    // mirrors themselves, so a re-run cannot chase its own tail.
    const originals = tx
      .select()
      .from(stockTransaction)
      .where(
        and(
          eq(stockTransaction.completionId, row.id),
          isNull(stockTransaction.reversesTransactionId),
        ),
      )
      .orderBy(asc(stockTransaction.id))
      .all();

    const reversalGroupId = newId();
    const reversals = originals.map((original) =>
      recordTransaction(tx, ctx, {
        partId: original.partId,
        lotId: original.lotId,
        storagePlaceId: original.storagePlaceId,
        qtyMilli: -original.qtyMilli,
        kind: "correction",
        reason: "completion_voided",
        occurrenceId: original.occurrenceId,
        completionId: original.completionId,
        transactionGroupId: reversalGroupId,
        reversesTransactionId: original.id,
        occurredAtMs: now,
        notes: `completion voided: ${input.reason}`,
      }),
    );

    // 5. Mark the completion voided *before* reopening, so the occurrence's live-completion index
    // is free and `reopenAfterVoid` sees the correct "most recent non-voided completion".
    const voided = tx
      .update(completion)
      .set({
        voidedAtMs: now,
        voidedBy: ctx.actorUserId,
        voidReason: input.reason,
        updatedAtMs: now,
        updatedBy: ctx.actorUserId,
      })
      .where(eq(completion.id, row.id))
      .returning()
      .get();

    // 3, 6, 7. Successor check, reopen, notification rebuild and the plan-anchor revert.
    reopenAfterVoid(tx, ctx, row.occurrenceId);

    // 8. Audit — and the idempotency record the probe above reads.
    writeAudit(tx, ctx, {
      entityTable: "completion",
      entityId: row.id,
      action: "completion_voided",
      summary: `completion voided: ${input.reason}`,
      requestId: input.requestId,
    });

    return { completion: voided, reversals, idempotentReplay: false };
  });
}

/* -------------------------------------------------------------------------------------------------
 * correctCompletion
 * ---------------------------------------------------------------------------------------------- */

export interface CorrectionMaterialInput {
  partId: string;
  lotId?: string | null;
  /** The corrected quantity. The delta against the recorded one becomes a `correction` row. */
  actualQtyMilli: number;
}

export interface CorrectCompletionInput {
  completionId: string;
  notes?: string | null;
  effortMinutes?: number | null;
  outcome?: CompletionOutcome;
  performedByUserId?: string | null;
  performedByProviderId?: string | null;
  /**
   * "It was actually done on Tuesday." Re-derives `completed_local_date` and, when this completion
   * seeded the plan's still-untouched successor, regenerates that successor's due date (§5.4).
   */
  completedAtMs?: number;
  materials?: CorrectionMaterialInput[];
  requestId?: string | null;
}

/** What a corrected completion date did to the successor it had seeded. */
export interface RegeneratedSuccessor {
  occurrenceId: string;
  fromDueDate: LocalDate;
  toDueDate: LocalDate;
}

export interface CorrectCompletionResult {
  completion: CompletionRow;
  materials: CompletionMaterialRow[];
  /** One `correction` row per changed quantity — the delta only. */
  corrections: StockTransactionRow[];
  /** `null` unless a corrected date actually moved the successor. */
  regeneratedSuccessor: RegeneratedSuccessor | null;
}

/**
 * Fix a typo without voiding (§5.4). Allowed fields are notes, effort, outcome, the performer, the
 * completion date and material quantities. A quantity change writes a `correction` row for the
 * **delta**; the original consumption row is never touched.
 *
 * Sign note: §5.4 spells the delta `newActual - oldActual`, which is the change in *consumption*.
 * The ledger records the change in *stock*, so the row carries `oldActual - newActual` — using more
 * takes the balance down.
 *
 * A corrected **date** re-anchors the schedule: the plan's anchor follows it, and the successor
 * this completion seeded is regenerated — but only while that successor is untouched. If someone
 * has already worked on it, this throws `ConflictError('successor_touched')` exactly as a void
 * does, because silently moving a task someone is standing in front of is worse than refusing.
 */
export function correctCompletion(
  handle: DbHandle,
  ctx: DomainContext,
  input: CorrectCompletionInput,
): CorrectCompletionResult {
  return writeTx(handle.db, (tx) => {
    const now = ctx.clock.now();
    const row = tx.select().from(completion).where(eq(completion.id, input.completionId)).get();
    if (!row) throw new NotFoundError("completion", input.completionId);
    if (row.voidedAtMs !== null) {
      throw new ConflictError("already_voided", "a voided completion cannot be corrected", {
        completionId: row.id,
      });
    }

    const changes: Record<string, [unknown, unknown]> = {};
    const patch: Partial<typeof completion.$inferInsert> = {
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    };
    if (input.notes !== undefined && input.notes !== row.notes) {
      patch.notes = input.notes;
      changes.notes = [row.notes, input.notes];
    }
    if (input.effortMinutes !== undefined && input.effortMinutes !== row.effortMinutes) {
      patch.effortMinutes = input.effortMinutes;
      changes.effort_minutes = [row.effortMinutes, input.effortMinutes];
    }
    if (input.outcome !== undefined && input.outcome !== row.outcome) {
      patch.outcome = input.outcome;
      changes.outcome = [row.outcome, input.outcome];
    }
    if (
      input.performedByUserId !== undefined &&
      input.performedByUserId !== row.performedByUserId
    ) {
      patch.performedByUserId = input.performedByUserId;
      changes.performed_by_user_id = [row.performedByUserId, input.performedByUserId];
    }
    if (
      input.performedByProviderId !== undefined &&
      input.performedByProviderId !== row.performedByProviderId
    ) {
      patch.performedByProviderId = input.performedByProviderId;
      changes.performed_by_provider_id = [row.performedByProviderId, input.performedByProviderId];
    }

    let regeneratedSuccessor: RegeneratedSuccessor | null = null;
    if (input.completedAtMs !== undefined && input.completedAtMs !== row.completedAtMs) {
      if (input.completedAtMs > now + FUTURE_TOLERANCE_MS) {
        throw new ValidationError("completed_in_future", "a completion cannot be in the future", {
          completedAtMs: input.completedAtMs,
          nowMs: now,
        });
      }
      const completedLocalDate = localDateOf(input.completedAtMs, ctx.tz);
      patch.completedAtMs = input.completedAtMs;
      patch.completedLocalDate = completedLocalDate;
      changes.completed_at_ms = [row.completedAtMs, input.completedAtMs];
      if (completedLocalDate !== row.completedLocalDate) {
        changes.completed_local_date = [row.completedLocalDate, completedLocalDate];
      }
      regeneratedSuccessor = recomputeSchedule(tx, ctx, row, completedLocalDate, input.requestId);
    }

    const corrections: StockTransactionRow[] = [];
    const groupId = newId();

    for (const line of input.materials ?? []) {
      if (!Number.isInteger(line.actualQtyMilli) || line.actualQtyMilli < 0) {
        throw new ValidationError(
          "actual_qty_invalid",
          "actualQtyMilli must be a non-negative integer",
          { partId: line.partId, actualQtyMilli: line.actualQtyMilli },
        );
      }
      const lotId = line.lotId ?? null;
      const existing = tx
        .select()
        .from(completionMaterial)
        .where(
          and(
            eq(completionMaterial.completionId, row.id),
            eq(completionMaterial.partId, line.partId),
            lotId === null
              ? isNull(completionMaterial.lotId)
              : eq(completionMaterial.lotId, lotId),
          ),
        )
        .get();
      if (!existing) {
        throw new NotFoundError("completion_material", `${row.id}/${line.partId}`);
      }
      const delta = line.actualQtyMilli - existing.actualQtyMilli;
      if (delta === 0) continue;

      corrections.push(
        recordTransaction(tx, ctx, {
          partId: line.partId,
          lotId,
          qtyMilli: -delta,
          kind: "correction",
          reason: "manual_correction",
          occurrenceId: row.occurrenceId,
          completionId: row.id,
          transactionGroupId: groupId,
          occurredAtMs: now,
          notes:
            `quantity corrected from ${existing.actualQtyMilli} to ${line.actualQtyMilli} milli ` +
            `(delta ${delta})`,
        }),
      );

      tx.update(completionMaterial)
        .set({ actualQtyMilli: line.actualQtyMilli })
        .where(eq(completionMaterial.id, existing.id))
        .run();

      writeAudit(tx, ctx, {
        entityTable: "completion_material",
        entityId: existing.id,
        action: "updated",
        summary: `quantity corrected on completion ${row.id}`,
        changes: { actual_qty_milli: [existing.actualQtyMilli, line.actualQtyMilli] },
        requestId: input.requestId ?? null,
      });
    }

    const updated = tx
      .update(completion)
      .set(patch)
      .where(eq(completion.id, row.id))
      .returning()
      .get();

    if (Object.keys(changes).length > 0) {
      writeAudit(tx, ctx, {
        entityTable: "completion",
        entityId: row.id,
        action: "updated",
        summary: "completion corrected",
        changes,
        requestId: input.requestId ?? null,
      });
    }

    return {
      completion: updated,
      materials: loadCompletionMaterials(tx, row.id),
      corrections,
      regeneratedSuccessor,
    };
  });
}

/**
 * The scheduling half of a date correction: move the plan's anchor to the corrected date and, if
 * this completion seeded the plan's current open occurrence, recompute that occurrence's due date
 * from the corrected anchor.
 *
 * Calendar-anchored rules measure from the *due date* of the occurrence that was closed, so their
 * successor does not move at all — which is the §2 rule ("a completion date does not move a
 * calendar series") falling out for free rather than being special-cased.
 */
function recomputeSchedule(
  tx: Db,
  ctx: DomainContext,
  row: CompletionRow,
  completedLocalDate: LocalDate,
  requestId: string | null | undefined,
): RegeneratedSuccessor | null {
  if (row.planId === null) return null;
  const now = ctx.clock.now();
  const plan = loadPlan(tx, row.planId);
  const rule = parseRecurrenceRule(plan.recurrenceJson);
  const closed = loadOccurrence(tx, row.occurrenceId);
  const anchor = anchorForCompletion(rule, closed, completedLocalDate);

  // The anchor only follows a correction to the *latest* completion; correcting an older one
  // rewrites history, not the schedule.
  if (plan.lastCompletionId === row.id && plan.scheduleAnchorDate !== anchor.date) {
    tx.update(maintenancePlan)
      .set({
        scheduleAnchorDate: anchor.date,
        scheduleAnchorSource: "completion",
        updatedAtMs: now,
        updatedBy: ctx.actorUserId,
      })
      .where(eq(maintenancePlan.id, plan.id))
      .run();
    writeAudit(tx, ctx, {
      entityTable: "maintenance_plan",
      entityId: plan.id,
      action: "updated",
      summary: `anchor moved to ${anchor.date ?? "none"} by a corrected completion date`,
      changes: { schedule_anchor_date: [plan.scheduleAnchorDate, anchor.date] },
      requestId: requestId ?? null,
    });
  }

  const successor = openOccurrenceOfPlan(tx, plan.id);
  if (!successor) return null;
  let note: { generatedByCompletionId?: string } = {};
  if (successor.generationNoteJson !== null) {
    try {
      note = JSON.parse(successor.generationNoteJson) as { generatedByCompletionId?: string };
    } catch {
      note = {};
    }
  }
  if (note.generatedByCompletionId !== row.id) return null;

  const next = computeNextDue(rule, anchor, now, ctx.tz);
  if (next === null || next.dueDate === successor.dueDate) return null;

  const blockers = successorBlockers(tx, successor);
  if (blockers.length > 0) {
    throw new ConflictError(
      "successor_touched",
      `the successor occurrence has been worked on (${blockers.join(", ")}) — handle it first`,
      { occurrenceId: successor.id, blockers },
    );
  }

  const today = localDateOf(now, ctx.tz);
  const status = compareLocalDate(next.dueDate, today) > 0 ? "pending" : "due";
  const moved = tx
    .update(maintenanceOccurrence)
    .set({
      dueDate: next.dueDate,
      // A regenerated date *is* the original one: this occurrence was never postponed, its seed
      // was wrong. `original_due_date` is what postpone-distance is measured from, so it moves.
      originalDueDate: next.dueDate,
      windowStartDate: next.windowStartDate ?? null,
      windowEndDate: next.windowEndDate ?? null,
      status,
      becameDueAtMs: status === "due" ? (successor.becameDueAtMs ?? now) : successor.becameDueAtMs,
      generationNoteJson: JSON.stringify({
        ...note,
        missedSeriesDates: next.missedSeriesDates,
        anchorSource: anchor.source,
        anchorDate: anchor.date,
        note: "regenerated after the completion date was corrected",
      }),
      updatedAtMs: now,
      updatedBy: ctx.actorUserId,
    })
    .where(eq(maintenanceOccurrence.id, successor.id))
    .returning()
    .get();

  // The pending reminder is about the old date: cancel it and re-anchor the series.
  rearmRecipientStates(tx, ctx, moved, "postponed");

  writeOccurrenceEvent(tx, ctx, {
    occurrenceId: moved.id,
    kind: "postponed",
    fromStatus: successor.status,
    toStatus: status,
    fromDueDate: successor.dueDate,
    toDueDate: next.dueDate,
    reason: "completion_date_corrected",
    detail: { completionId: row.id, anchorDate: anchor.date },
  });
  writeAudit(tx, ctx, {
    entityTable: "maintenance_occurrence",
    entityId: moved.id,
    action: "updated",
    summary: `successor regenerated to ${next.dueDate} after the completion date was corrected`,
    changes: { due_date: [successor.dueDate, next.dueDate] },
    requestId: requestId ?? null,
  });

  return {
    occurrenceId: moved.id,
    fromDueDate: successor.dueDate,
    toDueDate: next.dueDate,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The notification engine's entry point
 * ---------------------------------------------------------------------------------------------- */

export interface CompleteFromActionDeps {
  handle: DbHandle;
  clock: Clock;
  tz: string;
}

export interface CompleteFromActionInput {
  occurrenceId: string;
  /** The recipient whose phone the tap came from — the performer of record. */
  recipientUserId: string;
  /** `'act:' + nonce`, which is what makes a re-delivered HA action harmless. */
  requestId: string;
}

/**
 * The `Done` button. Uses the occurrence's expected materials with no shortfall resolution, so a
 * short shelf throws `InsufficientStockError` and the caller records `applied_effect = 'noop'` and
 * deep-links into the reconciliation flow (§4.7, and open question 5 in §10).
 */
export function completeFromAction(
  deps: CompleteFromActionDeps,
): (input: CompleteFromActionInput) => CompleteOccurrenceResult {
  return (input) =>
    completeOccurrence(
      deps.handle,
      {
        clock: deps.clock,
        tz: deps.tz,
        actorUserId: input.recipientUserId,
        actorKind: "ha",
      },
      {
        requestId: input.requestId,
        occurrenceId: input.occurrenceId,
        completedAtMs: deps.clock.now(),
        performedByUserId: input.recipientUserId,
        recordedByUserId: input.recipientUserId,
        source: "notification_action",
      },
    );
}

/** Every live (non-voided) completion of a plan, newest first — what `last_completion_id` tracks. */
export function planCompletions(tx: Db, planId: string): CompletionRow[] {
  return tx
    .select()
    .from(completion)
    .where(and(eq(completion.planId, planId), isNull(completion.voidedAtMs)))
    .orderBy(desc(completion.completedAtMs), desc(completion.id))
    .all();
}
