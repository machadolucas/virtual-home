import "server-only";
import { asc, desc, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { part, partSupplier } from "@/db/schema";
import { partsToReorder, type ReorderSuggestion } from "@/domain/reorder";
import type { LocalDate } from "@/domain/time";
import { formatQuantity } from "@/features/inventory/units";

export interface ShoppingLine {
  partId: string;
  partName: string;
  spec: string | null;
  manufacturer: string | null;
  productCode: string | null;
  suggestion: ReorderSuggestion;
  /** The supplier's own article number, when we know it. */
  supplierSku: string | null;
  url: string | null;
  lastPriceCents: number | null;
  currency: string | null;
  packQtyMilli: number | null;
  /** How many packs cover the suggested order, when a pack size is known. */
  packsNeeded: number | null;
}

export interface ShoppingGroup {
  /** `null` groups the parts with no supplier on file. */
  supplierName: string | null;
  lines: ShoppingLine[];
}

export interface ShoppingList {
  groups: ShoppingGroup[];
  horizonDays: number;
  today: LocalDate;
  lineCount: number;
}

/**
 * The shopping list: `partsToReorder` grouped by preferred supplier.
 *
 * There is no purchasing here and there never will be — no basket, no API, no price scraping. The
 * output is a list you read in a shop or paste into an order form, which is why
 * `shoppingListAsText` is part of the contract rather than a UI afterthought.
 */
export function readShoppingList(
  tx: Db,
  options: { today: LocalDate; horizonDays: number },
): ShoppingList {
  const suggestions = partsToReorder(tx, options);
  if (suggestions.length === 0) {
    return { groups: [], horizonDays: options.horizonDays, today: options.today, lineCount: 0 };
  }

  const partIds = suggestions.map((row) => row.partId);
  const parts = new Map(
    tx.select().from(part).where(inArray(part.id, partIds)).all().map((row) => [row.id, row]),
  );

  // Preferred supplier first; the partial unique index guarantees at most one per part, so the
  // first row per part after this ordering is the one to show.
  const suppliers = new Map<string, typeof partSupplier.$inferSelect>();
  for (const row of tx
    .select()
    .from(partSupplier)
    .where(inArray(partSupplier.partId, partIds))
    .orderBy(desc(partSupplier.isPreferred), asc(partSupplier.supplierName))
    .all()) {
    if (!suppliers.has(row.partId)) suppliers.set(row.partId, row);
  }

  const byGroup = new Map<string, ShoppingLine[]>();
  for (const suggestion of suggestions) {
    const partRow = parts.get(suggestion.partId);
    const supplier = suppliers.get(suggestion.partId) ?? null;
    const packQtyMilli = supplier?.packQtyMilli ?? null;
    const line: ShoppingLine = {
      partId: suggestion.partId,
      partName: suggestion.partName,
      spec: partRow?.spec ?? null,
      manufacturer: partRow?.manufacturer ?? null,
      productCode: partRow?.productCode ?? null,
      suggestion,
      supplierSku: supplier?.supplierSku ?? null,
      url: supplier?.url ?? null,
      lastPriceCents: supplier?.lastPriceCents ?? null,
      currency: supplier?.currency ?? null,
      packQtyMilli,
      packsNeeded:
        packQtyMilli === null || packQtyMilli <= 0
          ? null
          : Math.ceil(suggestion.suggestedOrderMilli / packQtyMilli),
    };
    const key = supplier?.supplierName ?? "";
    byGroup.set(key, [...(byGroup.get(key) ?? []), line]);
  }

  const groups: ShoppingGroup[] = [...byGroup.entries()]
    .map(([key, lines]) => ({
      supplierName: key === "" ? null : key,
      lines: lines.sort((a, b) => a.partName.localeCompare(b.partName)),
    }))
    // Named suppliers first, alphabetically; "no supplier on file" last, because it is the group
    // that needs a decision rather than an order.
    .sort((a, b) => {
      if (a.supplierName === null) return 1;
      if (b.supplierName === null) return -1;
      return a.supplierName.localeCompare(b.supplierName);
    });

  return {
    groups,
    horizonDays: options.horizonDays,
    today: options.today,
    lineCount: suggestions.length,
  };
}

/**
 * The copy-as-text rendering. Plain text with no table alignment, because it is pasted into
 * order forms, notes apps and messages, all of which reflow.
 */
export function shoppingListAsText(list: ShoppingList): string {
  const lines: string[] = [
    `Shopping list — ${list.today} (${list.horizonDays}-day horizon)`,
    "",
  ];
  for (const group of list.groups) {
    lines.push(group.supplierName ?? "No supplier on file");
    for (const line of group.lines) {
      const qty = formatQuantity(
        line.suggestion.suggestedOrderMilli,
        line.suggestion.unit,
        line.suggestion.isKit,
      );
      const identity = [line.manufacturer, line.productCode].filter(Boolean).join(" ");
      const packs =
        line.packsNeeded === null
          ? ""
          : ` (${line.packsNeeded} × pack of ${formatQuantity(line.packQtyMilli ?? 0, line.suggestion.unit, line.suggestion.isKit)})`;
      lines.push(`  - ${qty} ${line.partName}${identity === "" ? "" : ` [${identity}]`}${packs}`);
      lines.push(`    ${line.suggestion.reason}`);
      if (line.supplierSku !== null) lines.push(`    SKU ${line.supplierSku}`);
      if (line.url !== null) lines.push(`    ${line.url}`);
    }
    lines.push("");
  }
  lines.push(
    "Quantities are what it takes to reach the reorder target after the tasks already scheduled in the horizon.",
  );
  return lines.join("\n");
}
