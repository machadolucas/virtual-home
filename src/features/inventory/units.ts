/**
 * Unit-aware quantity formatting for the supplies screens.
 *
 * Quantities are integer thousandths everywhere (CLAUDE.md rule 5): 2 pcs = 2000, 0.75 l = 750.
 * This module is the one place that turns a `*_milli` integer into something a human reads, and it
 * is pure and React-free so the tests, the exports and the server actions can all use it.
 *
 * Two deliberate choices:
 *  - `pcs` never grows a decimal tail. A discrete part moves in whole units, so `2000` is `"2 pcs"`
 *    and never `"2.000 pcs"`. A non-whole `pcs` value is a data problem and is shown as such
 *    (`"2.5 pcs"`) rather than silently rounded.
 *  - A kit counts in kits, because that is what is on the shelf — `"1 kit"`, `"2 kits"`. This
 *    mirrors `reorderSuggestions`' own wording so the list and the detail page agree.
 */
import type { PartUnit } from "@/db/schema";

/** Millis per whole unit. The ledger's contract, not a display choice. */
export const MILLI = 1000;

/**
 * How many decimals a unit is worth showing. `ml`/`g` are already the small unit, so a fractional
 * millilitre is noise; litres and kilos get up to three, which is exactly what a thousandth is.
 */
const MAX_DECIMALS: Record<PartUnit, number> = {
  pcs: 3,
  l: 3,
  ml: 0,
  m: 2,
  kg: 3,
  g: 0,
};

/**
 * `2000` → `"2"`, `750` → `"0.75"`, `-1500` → `"-1.5"`.
 *
 * Trailing zeros are dropped so a whole number never reads as `"2.000"`, and the decimal separator
 * is always `.` — this string ends up in CSV exports and in copy-as-text shopping lists, where a
 * locale-dependent comma would be a bug.
 */
export function formatMilli(qtyMilli: number, unit: PartUnit): string {
  const decimals = MAX_DECIMALS[unit];
  const amount = qtyMilli / MILLI;
  if (Number.isInteger(amount)) return String(amount);
  const fixed = amount.toFixed(decimals);
  // `toFixed(0)` on 2.5 gives "3": for a zero-decimal unit that is the honest rounding, but we
  // must not claim precision we dropped, so mark it as approximate at the call site if needed.
  if (decimals === 0) return fixed;
  return fixed.replace(/\.?0+$/, "");
}

/**
 * The full label: `"2 pcs"`, `"0.75 l"`, `"1 kit"`, `"3 kits"`.
 *
 * `isKit` overrides the unit, because a kit's `unit` is `pcs` and "2 pcs" of a filter box tells a
 * reader less than "2 kits".
 */
export function formatQuantity(qtyMilli: number, unit: PartUnit, isKit = false): string {
  const number = formatMilli(qtyMilli, isKit ? "pcs" : unit);
  if (!isKit) return `${number} ${unit}`;
  return Math.abs(qtyMilli) === MILLI ? `${number} kit` : `${number} kits`;
}

/** Signed, for ledger rows: `"+2 pcs"` / `"−1 pcs"` (a real minus sign, not a hyphen). */
export function formatSignedQuantity(qtyMilli: number, unit: PartUnit, isKit = false): string {
  const body = formatQuantity(Math.abs(qtyMilli), unit, isKit);
  return qtyMilli < 0 ? `−${body}` : `+${body}`;
}

/**
 * Parse a human-typed amount into thousandths. Returns `null` for anything that is not a finite
 * number — the caller decides whether that is an error or an empty field.
 *
 * Accepts a comma as the decimal separator, because a Finnish keyboard produces one and refusing
 * it would be a papercut on every purchase form.
 */
export function parseQuantityToMilli(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  if (!/^-?\d*\.?\d*$/.test(trimmed)) return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * MILLI);
}

/** True when the value is a whole number of units — the invariant for a `discrete` part. */
export function isWholeUnit(qtyMilli: number): boolean {
  return Number.isInteger(qtyMilli) && qtyMilli % MILLI === 0;
}

/**
 * What to show as the on-hand figure, and how alarmed to look about it.
 *
 * `negative` is its own state on purpose: the ledger allows a negative balance because that is how
 * a noticed discrepancy is recorded honestly (§1.8), and the UI must offer a reconcile rather than
 * clamp the number to zero.
 */
export type StockTone = "negative" | "empty" | "low" | "ok";

export interface StockDisplay {
  label: string;
  tone: StockTone;
}

export function stockDisplay(
  onHandMilli: number,
  unit: PartUnit,
  isKit: boolean,
  thresholdMilli: number | null,
): StockDisplay {
  const label = formatQuantity(onHandMilli, unit, isKit);
  if (onHandMilli < 0) return { label, tone: "negative" };
  if (onHandMilli === 0) return { label, tone: "empty" };
  if (thresholdMilli !== null && onHandMilli < thresholdMilli) return { label, tone: "low" };
  return { label, tone: "ok" };
}

/** Human label for a tracking mode, used in the part form and the detail header. */
export const TRACKING_MODE_LABEL = {
  discrete: "Counted in whole units",
  measured: "Measured amount",
  estimated: "Estimated remaining",
} as const;

/** One-line explanation of each tracking mode, shown as field help. */
export const TRACKING_MODE_HELP = {
  discrete: "Moves in whole units only — you have 2 filters, never 2.4.",
  measured: "A real measured amount: 0.75 l of oil, 1.2 kg of salt.",
  estimated:
    "No scale involved: you set a percentage on the open container and the ledger records the implied change.",
} as const;
