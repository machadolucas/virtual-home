import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, ExternalLink } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, EmptyState, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { readShoppingList, shoppingListAsText } from "@/server/queries/inventory/shopping";
import { formatQuantity } from "@/features/inventory/units";
import { CopyAsText } from "./CopyAsText";

export const metadata: Metadata = { title: "Shopping list" };

/**
 * `/supplies/shopping` — the reorder suggestions, grouped by supplier.
 *
 * There is no purchasing here and there is not going to be: no basket, no supplier API, no stored
 * card. The output is a list you read in a shop or paste into an order form. Stock only ever
 * changes when somebody records that goods arrived.
 */
export default async function ShoppingListPage() {
  await requireSessionPage("/supplies/shopping");
  const { db, household, today } = pageContext();
  const list = readShoppingList(db, { today, horizonDays: household.reorderHorizonDays });
  const text = shoppingListAsText(list);

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Supplies"
        title="Shopping list"
        description={`Everything that will not cover the next ${household.reorderHorizonDays} days, grouped by the supplier you usually buy it from. Amounts are what it takes to reach the reorder target after the tasks already scheduled.`}
        actions={
          <Link href="/supplies" className={buttonClasses({ variant: "secondary" })}>
            <ArrowLeft aria-hidden="true" className="size-4" />
            All supplies
          </Link>
        }
      />

      {list.lineCount === 0 ? (
        <EmptyState
          icon={<CheckCircle2 />}
          title="Nothing to buy"
          description={`No item is below its threshold, and every task due within ${household.reorderHorizonDays} days is covered by what is on the shelf.`}
          note="This list is derived from the tasks that exist, not from a forecast. A new task with materials can add a line here without anything else changing."
          actions={
            <Link href="/supplies" className={buttonClasses({ variant: "secondary" })}>
              Look at the whole shelf
            </Link>
          }
        />
      ) : (
        <>
          <Panel
            title="Copy it somewhere useful"
            subtitle="Plain text: paste into an order form, a note or a message."
          >
            <CopyAsText text={text} />
          </Panel>

          {list.groups.map((group) => (
            <Panel
              key={group.supplierName ?? "__none"}
              flush
              title={group.supplierName ?? "No supplier on file"}
              subtitle={
                group.supplierName === null
                  ? "Add a supplier on the item to get a link and an article number here."
                  : `${group.lines.length} line(s)`
              }
            >
              <ul className="flex list-none flex-col">
                {group.lines.map((line) => (
                  <li
                    key={line.partId}
                    className="flex flex-col gap-1.5 border-b border-line px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4"
                  >
                    <span className="vh-tnum w-28 shrink-0 text-sm font-semibold text-ink">
                      {formatQuantity(
                        line.suggestion.suggestedOrderMilli,
                        line.suggestion.unit,
                        line.suggestion.isKit,
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/supplies/${line.partId}`}
                          className="text-sm font-medium text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
                        >
                          {line.partName}
                        </Link>
                        {line.packsNeeded === null ? null : (
                          <Badge tone="neutral" size="sm">
                            {line.packsNeeded} ×{" "}
                            {formatQuantity(
                              line.packQtyMilli ?? 0,
                              line.suggestion.unit,
                              line.suggestion.isKit,
                            )}{" "}
                            pack
                          </Badge>
                        )}
                      </span>
                      <span className="text-xs leading-5 text-ink-3">
                        {line.suggestion.reason}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                        {[line.manufacturer, line.productCode].filter(Boolean).length > 0 ? (
                          <span className="font-mono">
                            {[line.manufacturer, line.productCode].filter(Boolean).join(" ")}
                          </span>
                        ) : null}
                        {line.supplierSku === null ? null : (
                          <span className="font-mono">SKU {line.supplierSku}</span>
                        )}
                        {line.lastPriceCents === null ? null : (
                          <span className="vh-tnum">
                            last paid {(line.lastPriceCents / 100).toFixed(2)}{" "}
                            {line.currency ?? "EUR"}
                          </span>
                        )}
                        {line.url === null ? null : (
                          <a
                            href={line.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-accent-text underline underline-offset-2"
                          >
                            Supplier page
                            <ExternalLink aria-hidden="true" className="size-3" />
                          </a>
                        )}
                      </span>
                    </span>
                    {line.suggestion.leadTimeDays === null ? null : (
                      <span className="vh-tnum shrink-0 text-xs text-ink-3">
                        {line.suggestion.leadTimeDays} d lead time
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </>
      )}

      <p className="text-xs leading-5 text-ink-3">
        Nothing on this page orders anything. When the goods arrive, open the item and record the
        purchase — that is the movement that changes what is on hand.
      </p>
    </PageScroll>
  );
}
