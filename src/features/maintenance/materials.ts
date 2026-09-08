/**
 * Material lines for the completion form: pre-fill from what is expected, quantity formatting in
 * thousandths, and the diff that decides whether a line is short.
 *
 * Pure and React-free on purpose — §5.3's contract (the server never guesses, the user picks per
 * line) is only trustworthy if the arithmetic that decides "this line is short" is tested.
 *
 * Quantities are integers in thousandths everywhere (CLAUDE.md rule 5): 2 pcs = 2000.
 */
import type { PartUnit } from "@/db/schema/inventory";
import type { ShortResolution } from "@/domain/completion";
import type { ExpectedMaterialSource } from "@/domain/inventory";

/** One expected line, joined with the part and its balance, as the completion form receives it. */
export interface MaterialLine {
  partId: string;
  partName: string;
  spec: string | null;
  unit: PartUnit;
  /** `discrete` parts are whole units: the form steps by 1, not by 0.001. */
  trackingMode: "discrete" | "measured" | "estimated";
  expectedQtyMilli: number;
  isRequired: boolean;
  source: ExpectedMaterialSource;
  /** Ledger balance, from `availableMilli` — the number the completion check uses. */
  availableMilli: number;
}

/** What the user has typed for one line. */
export interface MaterialDraft {
  partId: string;
  actualQtyMilli: number;
  resolutionIfShort?: ShortResolution;
}

/**
 * The form's initial state: use exactly what is expected. `0` is a legitimate value the user may
 * type afterwards ("we expected to use one, we did not"), but it is never the default.
 */
export function prefillMaterials(lines: readonly MaterialLine[]): MaterialDraft[] {
  return lines.map((line) => ({ partId: line.partId, actualQtyMilli: line.expectedQtyMilli }));
}

export interface MaterialDiffRow {
  partId: string;
  partName: string;
  unit: PartUnit;
  expectedQtyMilli: number;
  actualQtyMilli: number;
  /** `actual - expected`; positive means more was used than planned. */
  deltaMilli: number;
  availableMilli: number;
  /** `actual - available`, clamped at 0: how much the ledger cannot cover. */
  shortfallMilli: number;
  isShort: boolean;
  /** Set only when the line is short — otherwise the radio group is not shown at all. */
  resolutionIfShort: ShortResolution | null;
}

/**
 * Line-by-line comparison of what was expected, what was typed and what the ledger holds.
 *
 * A draft with no matching expected line is still reported (the user may add a part that was not
 * planned), with `expectedQtyMilli = 0`.
 */
export function diffMaterials(
  lines: readonly MaterialLine[],
  drafts: readonly MaterialDraft[],
): MaterialDiffRow[] {
  const byPart = new Map(lines.map((line) => [line.partId, line]));
  return drafts.map((draft) => {
    const line = byPart.get(draft.partId);
    const expected = line?.expectedQtyMilli ?? 0;
    const available = line?.availableMilli ?? 0;
    const shortfall = Math.max(0, draft.actualQtyMilli - available);
    return {
      partId: draft.partId,
      partName: line?.partName ?? draft.partId,
      unit: line?.unit ?? "pcs",
      expectedQtyMilli: expected,
      actualQtyMilli: draft.actualQtyMilli,
      deltaMilli: draft.actualQtyMilli - expected,
      availableMilli: available,
      shortfallMilli: shortfall,
      isShort: shortfall > 0,
      resolutionIfShort: shortfall > 0 ? (draft.resolutionIfShort ?? null) : null,
    };
  });
}

/** The lines the server would refuse without a resolution (§5.3). */
export function shortLines(rows: readonly MaterialDiffRow[]): MaterialDiffRow[] {
  return rows.filter((row) => row.isShort);
}

/**
 * True when every short line has a resolution, i.e. the form may be submitted. A line that is not
 * short needs nothing, which is why an untouched form with enough stock submits immediately.
 */
export function resolutionsComplete(rows: readonly MaterialDiffRow[]): boolean {
  return rows.every((row) => !row.isShort || row.resolutionIfShort !== null);
}

/** Whether a required expected line has been zeroed out — worth warning about, never blocking. */
export function missingRequired(
  lines: readonly MaterialLine[],
  drafts: readonly MaterialDraft[],
): MaterialLine[] {
  const byPart = new Map(drafts.map((draft) => [draft.partId, draft]));
  return lines.filter((line) => line.isRequired && (byPart.get(line.partId)?.actualQtyMilli ?? 0) === 0);
}

/**
 * `2000` + `pcs` → `2 pcs`. Discrete parts never show decimals; measured parts show up to three
 * and drop trailing zeros, so `1500 ml` reads `1.5 l` only if the caller asked for litres.
 */
export function formatQty(qtyMilli: number, unit: PartUnit): string {
  const value = qtyMilli / 1000;
  const text = Number.isInteger(value) ? String(value) : trimZeros(value.toFixed(3));
  return `${text} ${unit}`;
}

function trimZeros(text: string): string {
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Parse a typed quantity into thousandths. Returns `null` for anything that is not a
 * non-negative number, so the caller can leave the field invalid rather than guess a zero.
 */
export function parseQty(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,3})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 1000);
}

/** The step a number input should use: whole units for discrete parts, thousandths otherwise. */
export function qtyStep(trackingMode: MaterialLine["trackingMode"]): number {
  return trackingMode === "discrete" ? 1 : 0.001;
}

/** Where an expected line came from, in words — so the user can see why it is pre-filled. */
export function describeSource(source: ExpectedMaterialSource): string {
  switch (source) {
    case "plan":
      return "From this plan";
    case "procedure":
      return "From the procedure";
    case "asset_consumable":
      return "What this unit consumes";
    case "condition_rule":
      return "Default part for this alert";
  }
}

/** Stock wording that never claims a number it does not have. */
export function describeStock(line: MaterialLine): { text: string; sufficient: boolean } {
  const sufficient = line.availableMilli >= line.expectedQtyMilli;
  return {
    text: `${formatQty(line.availableMilli, line.unit)} in stock`,
    sufficient,
  };
}
