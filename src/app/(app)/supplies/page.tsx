import type { Metadata } from "next";
import Link from "next/link";
import { Package, Plus, ShoppingCart } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, EmptyState, Panel, StatusDot, buttonClasses, cn } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { listSupplies, type SupplyListRow } from "@/server/queries/inventory/list";
import { applySupplyFilter, filterCounts, EXPIRY_HORIZON_DAYS } from "@/features/inventory/filter";
import {
  KIT_RULE_TEXT,
  SUPPLY_FILTER_LABEL,
  isSupplyFilter,
  type SupplyFilter,
} from "@/features/inventory/labels";
import { stockDisplay } from "@/features/inventory/units";
import { SuppliesFilters } from "./SuppliesFilters";

export const metadata: Metadata = { title: "Supplies" };

/**
 * `/supplies` — what is in stock and what to buy.
 *
 * The reorder verdict on every row comes from `reorderSuggestions`, not from a threshold compared
 * here: the list, the shopping list and the completion form must agree about what "low" means, and
 * there is exactly one implementation of that.
 */
export default async function SuppliesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSessionPage("/supplies");
  const params = await searchParams;
  const rawFilter = firstValue(params["filter"]);
  const filter: SupplyFilter = isSupplyFilter(rawFilter) ? rawFilter : "low";
  const query = firstValue(params["q"]) ?? "";

  const { db, household, today } = pageContext();
  const result = listSupplies(db, { today, horizonDays: household.reorderHorizonDays });
  const counts = filterCounts(result.rows, today, result.expiryHorizonEnd);
  const rows = applySupplyFilter(result.rows, {
    filter,
    query,
    today,
    expiryHorizonEnd: result.expiryHorizonEnd,
  });

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Household"
        title="Supplies"
        description={`Consumables the house needs. Amounts are exact to a thousandth, so half a pack is a real number. “To buy” looks ${household.reorderHorizonDays} days ahead at the tasks that already exist — it is not a guess about tasks that do not.`}
        actions={
          <>
            <Link href="/supplies/shopping" className={buttonClasses({ variant: "secondary" })}>
              <ShoppingCart aria-hidden="true" className="size-4" />
              Shopping list
            </Link>
            <Link href="/supplies/new" className={buttonClasses({ variant: "primary" })}>
              <Plus aria-hidden="true" className="size-4" />
              Add an item
            </Link>
          </>
        }
      >
        {result.isEmpty ? null : <SuppliesFilters counts={counts} />}
      </PageHeader>

      {result.isEmpty ? (
        <EmptyState
          icon={<Package />}
          title="No supplies tracked yet"
          description="Add the first consumable — a filter, a bulb, softener salt, a paint tin — and this becomes the list of what is on hand and what to buy."
          bullets={[
            "On-hand amount per item, in the unit you buy it in, with the size that fits the equipment.",
            "A “to buy” state derived from the tasks already scheduled, plus your own threshold and lead time.",
            "Which equipment each item fits, so a filter in your hand traces back to a room.",
            "Every movement in a ledger: bought, used by a task, counted, corrected — with who and when.",
          ]}
          actions={
            <Link href="/supplies/new" className={buttonClasses({ variant: "primary" })}>
              Add the first item
            </Link>
          }
          note="Nothing appears here on its own. Stock changes only when a purchase, a stock take or a completed task says so."
        />
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Package />}
            title={
              query === ""
                ? `Nothing is ${SUPPLY_FILTER_LABEL[filter].toLowerCase()} right now`
                : `No item matches “${query}”`
            }
            description={
              filter === "low"
                ? "No item is below its threshold, and the tasks in the horizon are covered by what is on the shelf."
                : filter === "expiring"
                  ? `No lot expires within ${EXPIRY_HORIZON_DAYS} days.`
                  : "Try another filter, or clear the search."
            }
            note={`${result.rows.length} item(s) tracked in total.`}
          />
        </Panel>
      ) : (
        <Panel
          flush
          title={`${rows.length} of ${result.rows.length} item(s)`}
          subtitle={filter === "kits" ? KIT_RULE_TEXT : undefined}
        >
          <SuppliesList rows={rows} today={today} />
        </Panel>
      )}

      <p className="text-xs leading-5 text-ink-3">
        {KIT_RULE_TEXT} A negative amount is shown as it is, never clamped to zero: it means the
        ledger and the shelf disagree, and a stock take is how that gets settled.
      </p>
    </PageScroll>
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A list of links rather than a `DataTable`: the whole row navigates, and the on-hand cell carries
 * a status glyph plus a reason sentence that no single-value cell renderer would fit.
 */
function SuppliesList({ rows, today }: { rows: readonly SupplyListRow[]; today: string }) {
  return (
    <ul className="flex list-none flex-col">
      {rows.map((row) => {
        const stock = stockDisplay(row.onHandMilli, row.unit, row.isKit, row.reorderThresholdMilli);
        const dot =
          stock.tone === "negative"
            ? { kind: "overdue" as const, label: "Ledger and shelf disagree" }
            : stock.tone === "empty"
              ? { kind: "blocked" as const, label: "None on hand" }
              : stock.tone === "low"
                ? { kind: "due" as const, label: "Below the threshold" }
                : { kind: "ok" as const, label: "In stock" };
        return (
          <li key={row.partId} className="border-b border-line last:border-b-0">
            <Link
              href={`/supplies/${row.partId}`}
              className={cn(
                "flex min-h-16 flex-col gap-1.5 px-4 py-3 transition-colors duration-100",
                "hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4",
                "outline-none focus-visible:bg-surface-2 focus-visible:outline-2",
                "focus-visible:-outline-offset-2 focus-visible:outline-ring",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{row.name}</span>
                  {row.isKit ? (
                    <Badge tone="neutral" size="sm">
                      Kit of {row.componentCount}
                    </Badge>
                  ) : null}
                  {row.stocked ? null : (
                    <Badge tone="neutral" size="sm">
                      Parts list only
                    </Badge>
                  )}
                  {row.earliestExpiry === null ? null : row.earliestExpiry <= today ? (
                    <Badge tone="overdue" size="sm">
                      Expired {row.earliestExpiry}
                    </Badge>
                  ) : (
                    <Badge tone="due" size="sm">
                      Expires {row.earliestExpiry}
                    </Badge>
                  )}
                </span>
                <span className="text-xs leading-5 text-ink-3">
                  {describe(row) ?? "No specification recorded."}
                </span>
                {row.suggest && row.reason !== null ? (
                  <span className="text-xs leading-5 font-medium text-due">{row.reason}</span>
                ) : null}
              </span>

              <span className="flex shrink-0 items-center gap-4 sm:w-64 sm:justify-end">
                {row.trackingMode === "estimated" && row.openLotEstimatePct !== null ? (
                  <span className="vh-tnum text-xs text-ink-3">
                    {row.openLotEstimatePct} % in the open one
                  </span>
                ) : null}
                {row.leadTimeDays !== null && row.suggest ? (
                  <span className="vh-tnum hidden text-xs text-ink-3 md:inline">
                    {row.leadTimeDays} d lead
                  </span>
                ) : null}
                <span className="flex items-center gap-1.5">
                  <StatusDot kind={dot.kind} label={dot.label} />
                  <span className="vh-tnum text-sm font-semibold text-ink">{stock.label}</span>
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function describe(row: SupplyListRow): string | null {
  const fits =
    row.compatibleAssetNames.length === 0
      ? null
      : `Fits ${row.compatibleAssetNames.slice(0, 2).join(", ")}` +
        (row.compatibleAssetNames.length > 2 ? ` +${row.compatibleAssetNames.length - 2} more` : "");
  const parts = [
    row.spec,
    [row.manufacturer, row.productCode].filter(Boolean).join(" ") || null,
    row.storagePlaceName,
    fits,
  ].filter((value): value is string => value !== null && value !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}
