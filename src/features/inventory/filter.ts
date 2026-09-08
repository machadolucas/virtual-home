/**
 * Filtering and searching the supplies list — pure, so the server component can apply it to rows
 * it already loaded and the tests can assert on it without a database.
 *
 * The filter set is deliberately small and each one answers a question somebody actually asks:
 * "what should I buy?", "what is about to go off?", "which boxes are still sealed?", "show me
 * everything".
 */
import type { SupplyFilter } from "./labels";

/** The shape the list needs. A superset lives in `@/server/queries/inventory/list`. */
export interface FilterableSupply {
  partId: string;
  name: string;
  spec: string | null;
  manufacturer: string | null;
  productCode: string | null;
  storagePlaceName: string | null;
  compatibleAssetNames: readonly string[];
  isKit: boolean;
  suggest: boolean;
  onHandMilli: number;
  /** Earliest lot expiry, `YYYY-MM-DD`, or null when nothing expires. */
  earliestExpiry: string | null;
}

/**
 * Days ahead that counts as "expiring". Fixed rather than configurable: a household does not need
 * a knob for this, and `household_setting` already carries more tunables than anyone changes.
 */
export const EXPIRY_HORIZON_DAYS = 60;

/** Case- and diacritic-insensitive haystack for one row. */
function haystack(row: FilterableSupply): string {
  return [
    row.name,
    row.spec ?? "",
    row.manufacturer ?? "",
    row.productCode ?? "",
    row.storagePlaceName ?? "",
    ...row.compatibleAssetNames,
  ]
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Normalise a search box value the same way the haystack is normalised. */
export function normaliseQuery(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function matchesQuery(row: FilterableSupply, query: string): boolean {
  const needle = normaliseQuery(query);
  if (needle === "") return true;
  const hay = haystack(row);
  // Every whitespace-separated term must appear, so "hepa garage" finds the filter on that shelf.
  return needle.split(/\s+/).every((term) => hay.includes(term));
}

/**
 * `expiresOn` is a LocalDate and `today` is a LocalDate, so this is a string comparison — no
 * timezone arithmetic, no off-by-one at midnight.
 */
export function isExpiringSoon(
  earliestExpiry: string | null,
  today: string,
  horizonEnd: string,
): boolean {
  if (earliestExpiry === null) return false;
  // Already past its date counts as expiring: it is exactly the row you want to see.
  return earliestExpiry <= horizonEnd;
}

export interface ApplyFilterOptions {
  filter: SupplyFilter;
  query: string;
  today: string;
  /** `addDaysLocal(today, EXPIRY_HORIZON_DAYS)`; passed in so this module stays free of time code. */
  expiryHorizonEnd: string;
}

export function applySupplyFilter<T extends FilterableSupply>(
  rows: readonly T[],
  options: ApplyFilterOptions,
): T[] {
  const { filter, query, today, expiryHorizonEnd } = options;
  return rows.filter((row) => {
    if (!matchesQuery(row, query)) return false;
    switch (filter) {
      case "low":
        return row.suggest;
      case "expiring":
        return isExpiringSoon(row.earliestExpiry, today, expiryHorizonEnd);
      case "kits":
        return row.isKit;
      case "all":
        return true;
    }
  });
}

/** Counts for the filter chips, computed once over the unfiltered rows. */
export function filterCounts<T extends FilterableSupply>(
  rows: readonly T[],
  today: string,
  expiryHorizonEnd: string,
): Record<SupplyFilter, number> {
  return {
    low: rows.filter((row) => row.suggest).length,
    expiring: rows.filter((row) => isExpiringSoon(row.earliestExpiry, today, expiryHorizonEnd))
      .length,
    kits: rows.filter((row) => row.isKit).length,
    all: rows.length,
  };
}
