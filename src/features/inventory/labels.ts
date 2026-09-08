/**
 * Words for the inventory enums, plus the kit rule the UI is required to explain.
 *
 * Kept pure and free of React so both the pages and the CSV export use the same wording — an
 * export whose `kind` column says something different from the screen is a support call waiting
 * to happen.
 */
import type { StockTransactionKind, StockTransactionReason } from "@/db/schema";

/**
 * The sentence every kit surface must carry, verbatim. It is short because the rule is short: the
 * app never derives "filters I could have if I opened that box" — you tell it you opened the box.
 */
export const KIT_RULE_TEXT =
  "Stock is counted where the goods physically are; opening a kit moves its contents to the component parts.";

/** The longer version, for the part detail page and the new-part form. */
export const KIT_RULE_DETAIL =
  "A kit is one part with a parts list. While the box is sealed, the stock sits on the kit and the components read zero. " +
  "“Open a kit” records one kit leaving and its contents arriving, in a single reversible movement. " +
  "Nothing is ever counted on both sides, so “how many filters do I have” stays one number.";

export const STOCK_KIND_LABEL: Record<StockTransactionKind, string> = {
  purchase: "Purchase",
  consumption: "Used",
  adjustment: "Adjustment",
  correction: "Correction",
  kit_explode_in: "From a kit",
  kit_explode_out: "Kit opened",
  estimate_update: "Estimate",
  initial_count: "Initial count",
  disposal: "Disposed",
};

export const STOCK_REASON_LABEL: Record<StockTransactionReason, string> = {
  purchase: "bought",
  maintenance_consumption: "used by a task",
  stock_take: "stock take",
  reconcile_missing_stock: "reconciled — stock was missing",
  reconcile_surplus: "reconciled — stock was surplus",
  completion_voided: "a completion was voided",
  kit_explode: "kit opened",
  kit_explode_undo: "kit re-sealed",
  expired: "expired",
  damaged: "damaged",
  estimate_update: "estimate changed",
  manual_correction: "corrected by hand",
  initial_seed: "initial set-up",
};

/** Reasons a person may pick when correcting a ledger row by hand. */
export const CORRECTION_REASONS: readonly {
  value: StockTransactionReason;
  label: string;
  hint: string;
}[] = [
  {
    value: "manual_correction",
    label: "Entered by mistake",
    hint: "The movement did not happen, or the amount was wrong.",
  },
  {
    value: "reconcile_missing_stock",
    label: "Stock was missing from the shelf",
    hint: "The ledger said more than the shelf held.",
  },
  {
    value: "reconcile_surplus",
    label: "There was more on the shelf",
    hint: "The ledger said less than the shelf held.",
  },
  { value: "expired", label: "Expired", hint: "Written off because it passed its date." },
  { value: "damaged", label: "Damaged", hint: "Written off because it was unusable." },
];

/** The four list filters. `all` is last because it is the escape hatch, not the default. */
export const SUPPLY_FILTERS = ["low", "expiring", "kits", "all"] as const;
export type SupplyFilter = (typeof SUPPLY_FILTERS)[number];

export const SUPPLY_FILTER_LABEL: Record<SupplyFilter, string> = {
  low: "To buy",
  expiring: "Expiring",
  kits: "Kits",
  all: "Everything",
};

export function isSupplyFilter(value: string | null | undefined): value is SupplyFilter {
  return value !== null && value !== undefined && (SUPPLY_FILTERS as readonly string[]).includes(value);
}
