/**
 * Reorder suggestions: "you have one filter left and two changes are due before Christmas".
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.8 (thresholds and lead times) and
 * §1.5 (`asset_consumable` feeding upcoming demand).
 *
 * Read-only and pure: it takes a `tx` and a `today`, never the wall clock, so a test can ask what
 * the household will need in 90 days from any date.
 *
 * Scope note — demand comes from the occurrences that **exist**: every open occurrence whose
 * `due_date` falls inside the horizon, with its expected materials resolved exactly as the
 * completion form would resolve them. It deliberately does not project a plan's *next* cycle: that
 * would mean re-running `computeNextDue` speculatively, and a suggestion built on a guessed date is
 * worse than one built on a real task. Since a plan has at most one open occurrence at a time
 * (`ux_occ_open_per_plan`), the open occurrence *is* the plan's projection.
 */
import { and, asc, inArray, lte } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  maintenanceOccurrence,
  part,
  type PartUnit,
} from "@/db/schema";
import { ValidationError } from "@/domain/errors";
import { addDaysLocal, isValidLocalDate, type LocalDate } from "@/domain/time";
import { availableMilli, expectedMaterialsFor } from "@/domain/inventory";

export interface DemandSource {
  /** `'plan'` for scheduled work, `'condition'` for a battery task, `'manual'` for ad-hoc. */
  kind: "plan" | "condition" | "manual";
  occurrenceId: string;
  title: string;
  dueDate: LocalDate;
  qtyMilli: number;
  isRequired: boolean;
}

export interface ReorderSuggestion {
  partId: string;
  partName: string;
  unit: PartUnit;
  isKit: boolean;
  onHandMilli: number;
  /** Everything the open tasks in the horizon are expected to consume. */
  expectedDemandMilli: number;
  /** `onHand - expectedDemand`; negative means the horizon cannot be served. */
  projectedBalanceMilli: number;
  reorderThresholdMilli: number | null;
  reorderTargetMilli: number | null;
  leadTimeDays: number | null;
  suggest: boolean;
  /** How much to buy to get back to the target (0 when nothing is suggested). */
  suggestedOrderMilli: number;
  /** Human sentence for the UI, e.g. "1 kit left, 2 tasks in 90 days need 2 kits". */
  reason: string;
  demandSources: DemandSource[];
}

export interface ReorderOptions {
  /** How far ahead to look. Defaults to `household_setting.reorder_horizon_days` at the caller. */
  horizonDays: number;
  /** LocalDate the horizon starts from. */
  today: LocalDate;
}

/** `2000` → `"2 pcs"`; a kit counts in kits, which is what the user sees on the shelf. */
function quantityLabel(qtyMilli: number, unit: PartUnit, isKit: boolean): string {
  const amount = qtyMilli / 1000;
  const rounded = Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, "");
  if (!isKit) return `${rounded} ${unit}`;
  return Math.abs(amount) === 1 ? `${rounded} kit` : `${rounded} kits`;
}

/**
 * One suggestion per stocked, unarchived part, ordered by name. Every part is listed — `suggest`
 * says whether to act — so the inventory page can show the whole shelf with the urgent rows marked.
 */
export function reorderSuggestions(tx: Db, options: ReorderOptions): ReorderSuggestion[] {
  const { horizonDays, today } = options;
  if (!Number.isInteger(horizonDays) || horizonDays < 1) {
    throw new ValidationError("horizon_invalid", "horizonDays must be a positive whole number", {
      horizonDays,
    });
  }
  if (!isValidLocalDate(today)) {
    throw new ValidationError("today_invalid", "today must be a YYYY-MM-DD local date", { today });
  }
  const horizonEnd = addDaysLocal(today, horizonDays);

  // Every open task that lands inside the horizon (overdue ones included — their due date is in
  // the past, which is still ≤ the horizon end).
  const occurrences = tx
    .select()
    .from(maintenanceOccurrence)
    .where(
      and(
        inArray(maintenanceOccurrence.status, ["pending", "due"]),
        lte(maintenanceOccurrence.dueDate, horizonEnd),
      ),
    )
    .orderBy(asc(maintenanceOccurrence.dueDate), asc(maintenanceOccurrence.id))
    .all();

  const demand = new Map<string, DemandSource[]>();
  for (const occurrence of occurrences) {
    for (const line of expectedMaterialsFor(tx, occurrence)) {
      const rows = demand.get(line.partId) ?? [];
      rows.push({
        kind: occurrence.source,
        occurrenceId: occurrence.id,
        title: occurrence.title,
        dueDate: occurrence.dueDate,
        qtyMilli: line.qtyMilli,
        isRequired: line.isRequired,
      });
      demand.set(line.partId, rows);
    }
  }

  const parts = tx.select().from(part).orderBy(asc(part.name), asc(part.id)).all();

  const out: ReorderSuggestion[] = [];
  for (const row of parts) {
    if (row.archivedAtMs !== null) continue;
    // A `not_stocked` kit is a pure bill-of-materials definition — there is nothing to reorder.
    if (row.stockMode !== "stocked") continue;

    const demandSources = demand.get(row.id) ?? [];
    const expectedDemandMilli = demandSources.reduce((sum, line) => sum + line.qtyMilli, 0);
    const onHandMilli = availableMilli(tx, row.id);
    const projectedBalanceMilli = onHandMilli - expectedDemandMilli;
    const threshold = row.reorderThresholdMilli;

    const suggest =
      threshold === null ? projectedBalanceMilli < 0 : projectedBalanceMilli < threshold;

    const target = row.reorderTargetMilli ?? threshold ?? expectedDemandMilli;
    const suggestedOrderMilli = suggest ? Math.max(0, target - projectedBalanceMilli) : 0;

    const fragments: string[] = [
      `${quantityLabel(onHandMilli, row.unit, row.isKit)} left`,
    ];
    if (demandSources.length > 0) {
      const taskWord = demandSources.length === 1 ? "task" : "tasks";
      fragments.push(
        `${demandSources.length} ${taskWord} in ${horizonDays} days need ` +
          quantityLabel(expectedDemandMilli, row.unit, row.isKit),
      );
    }
    if (projectedBalanceMilli < 0) {
      fragments.push(`short by ${quantityLabel(-projectedBalanceMilli, row.unit, row.isKit)}`);
    } else if (threshold !== null && projectedBalanceMilli < threshold) {
      fragments.push(
        `below the reorder threshold of ${quantityLabel(threshold, row.unit, row.isKit)}`,
      );
    }
    if (suggest && row.leadTimeDays !== null) {
      fragments.push(`lead time ${row.leadTimeDays} days`);
    }

    out.push({
      partId: row.id,
      partName: row.name,
      unit: row.unit,
      isKit: row.isKit,
      onHandMilli,
      expectedDemandMilli,
      projectedBalanceMilli,
      reorderThresholdMilli: threshold,
      reorderTargetMilli: row.reorderTargetMilli,
      leadTimeDays: row.leadTimeDays,
      suggest,
      suggestedOrderMilli,
      reason: fragments.join(", "),
      demandSources,
    });
  }

  return out;
}

/** Just the rows worth acting on. */
export function partsToReorder(tx: Db, options: ReorderOptions): ReorderSuggestion[] {
  return reorderSuggestions(tx, options).filter((row) => row.suggest);
}
