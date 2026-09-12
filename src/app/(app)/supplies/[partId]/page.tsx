import type { Route } from "next";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Pencil, Wrench } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, EmptyState, Panel, StatusBadge, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { listPartOptions, listStoragePlaces } from "@/server/queries/inventory/list";
import { listAssetOptions, readPartDetail } from "@/server/queries/inventory/detail";
import {
  KIT_RULE_DETAIL,
  KIT_RULE_TEXT,
  STOCK_KIND_LABEL,
  STOCK_REASON_LABEL,
} from "@/features/inventory/labels";
import {
  TRACKING_MODE_HELP,
  TRACKING_MODE_LABEL,
  formatQuantity,
  formatSignedQuantity,
  stockDisplay,
} from "@/features/inventory/units";
import { locateInHouseHref } from "@/features/assets/labels";
import { PartForm, type PartFormInitial } from "../PartForm";
import { CorrectRow } from "./CorrectRow";
import {
  ArchiveToggle,
  KitContentsDialog,
  LotDialog,
  RemoveSupplierButton,
  SupplierDialog,
} from "./Editors";
import { emptyLot, emptySupplier } from "./drafts";
import { StockActions } from "./StockActions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ partId: string }>;
}): Promise<Metadata> {
  const { partId } = await params;
  await requireSessionPage(`/supplies/${partId}`);
  const { db, household, today } = pageContext();
  const detail = readPartDetail(db, partId, {
    today,
    horizonDays: household.reorderHorizonDays,
  });
  return { title: detail === null ? "Item not found" : detail.part.name };
}

/**
 * `/supplies/[partId]` — one item: what it is, how much there is, and every movement that got it
 * to that number.
 *
 * The ledger is the point of this page. It is append-only, so the history is complete by
 * construction: a mistake shows as the original row *plus* its correction, and both stay visible.
 * That is the difference between a system you can audit and a number you have to trust.
 */
export default async function PartDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ partId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { partId } = await params;
  await requireSessionPage(`/supplies/${partId}`);
  const query = await searchParams;
  const editing = firstValue(query["edit"]) === "1";

  const { db, household, today } = pageContext();
  const detail = readPartDetail(db, partId, {
    today,
    horizonDays: household.reorderHorizonDays,
  });
  if (detail === null) notFound();

  const { part, stock, suggestion } = detail;
  const display = stockDisplay(
    stock.onHandMilli,
    part.unit,
    part.isKit,
    part.reorderThresholdMilli,
  );
  const storagePlaceOptions = listStoragePlaces(db).map((place) => ({
    value: place.id,
    label: place.name,
    hint: place.locationName ?? undefined,
  }));
  const componentOptions = listPartOptions(db, { excludeKits: true })
    .filter((option) => option.id !== partId)
    .map((option) => ({
      value: option.id,
      label: option.name,
      hint: option.spec ?? option.unit,
    }));

  const openEstimateLot =
    part.trackingMode === "estimated"
      ? (detail.lots.find((lot) => lot.isOpen && lot.initialQtyMilli !== null) ?? null)
      : null;

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Supplies"
        title={part.name}
        description={
          [part.spec, part.dimensions, [part.manufacturer, part.productCode].filter(Boolean).join(" ")]
            .filter(Boolean)
            .join(" · ") || "No specification recorded yet."
        }
        actions={
          <>
            <Link href="/supplies" className={buttonClasses({ variant: "secondary" })}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              All supplies
            </Link>
            <Link
              href={editing ? `/supplies/${partId}` : `/supplies/${partId}?edit=1`}
              className={buttonClasses({ variant: editing ? "primary" : "secondary" })}
            >
              <Pencil aria-hidden="true" className="size-4" />
              {editing ? "Stop editing" : "Edit details"}
            </Link>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-baseline gap-2">
            <span className="vh-tnum text-2xl font-semibold tracking-[-0.02em] text-ink">
              {display.label}
            </span>
            <span className="text-xs text-ink-3">on hand</span>
          </span>
          {/* `StatusBadge` writes the kind's own label, which is the point: "Overdue" and
              "Due" mean the same thing everywhere in the app. The sentence that is specific to
              stock goes beside it. */}
          {display.tone === "negative" ? (
            <>
              <StatusBadge kind="overdue" />
              <span className="text-xs text-ink-2">the ledger and the shelf disagree</span>
            </>
          ) : display.tone === "empty" ? (
            <>
              <StatusBadge kind="blocked" />
              <span className="text-xs text-ink-2">none on hand</span>
            </>
          ) : suggestion?.suggest === true ? (
            <>
              <StatusBadge kind="due" />
              <span className="text-xs text-ink-2">worth buying</span>
            </>
          ) : (
            <>
              <StatusBadge kind="ok" />
              <span className="text-xs text-ink-2">enough for now</span>
            </>
          )}
          {part.isKit ? <Badge tone="neutral">Kit of {detail.components.length}</Badge> : null}
          {part.archivedAtMs === null ? null : <Badge tone="neutral">Archived</Badge>}
          {stock.onHandMilli !== stock.effectiveMilli ? (
            <Badge tone="neutral">
              {formatQuantity(stock.onHandMilli - stock.effectiveMilli, part.unit, part.isKit)}{" "}
              recorded ahead of delivery
            </Badge>
          ) : null}
        </div>
      </PageHeader>

      {editing ? (
        <PartForm
          initial={toFormInitial(detail)}
          storagePlaces={storagePlaceOptions}
          componentOptions={componentOptions}
          assetOptions={listAssetOptions(db).map((asset) => ({
            value: asset.id,
            label: asset.name,
            hint: asset.locationName ?? undefined,
          }))}
        />
      ) : (
        <>
          <Panel title="Record a movement" subtitle="Every one of these appends to the ledger below.">
            <StockActions
              partId={part.id}
              partName={part.name}
              unit={part.unit}
              isKit={part.isKit}
              trackingMode={part.trackingMode}
              onHandMilli={stock.onHandMilli}
              componentCount={detail.components.length}
              storagePlaces={storagePlaceOptions.map((place) => ({
                value: place.value,
                label: place.label,
              }))}
              lots={detail.lots.map((lot) => ({
                value: lot.id,
                label: lot.label,
                hint: lot.expiresOn === null ? undefined : `expires ${lot.expiresOn}`,
              }))}
              estimateLot={
                openEstimateLot === null
                  ? null
                  : {
                      id: openEstimateLot.id,
                      label: openEstimateLot.label,
                      estimatePct: openEstimateLot.estimatePct,
                    }
              }
              undoableGroups={detail.undoableExplodeGroups}
              today={today}
            />
          </Panel>

          <Panel title="Details">
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Detail term="Counting" value={TRACKING_MODE_LABEL[part.trackingMode]}>
                {TRACKING_MODE_HELP[part.trackingMode]}
              </Detail>
              <Detail term="Unit" value={part.unit} />
              <Detail
                term="Reorder threshold"
                value={
                  part.reorderThresholdMilli === null
                    ? "Not set"
                    : formatQuantity(part.reorderThresholdMilli, part.unit, part.isKit)
                }
              >
                {part.reorderThresholdMilli === null
                  ? "With no threshold, the item only shows as “to buy” when the scheduled tasks would take it below zero."
                  : undefined}
              </Detail>
              <Detail
                term="Reorder target"
                value={
                  part.reorderTargetMilli === null
                    ? "Not set"
                    : formatQuantity(part.reorderTargetMilli, part.unit, part.isKit)
                }
              />
              <Detail
                term="Lead time"
                value={part.leadTimeDays === null ? "Not set" : `${part.leadTimeDays} days`}
              />
              <Detail
                term="Where it lives"
                value={detail.storagePlaceName ?? "No fixed place"}
              />
              <Detail
                term="Lots"
                value={part.tracksLots ? "Tracked individually" : "Not tracked"}
              />
              <Detail
                term="Stocked"
                value={part.stockMode === "stocked" ? "Yes" : "Parts list only"}
              >
                {part.stockMode === "stocked"
                  ? undefined
                  : "This kit is a description of what belongs together. It never carries stock and never appears on the shopping list."}
              </Detail>
            </dl>
            {part.notes === null ? null : (
              <p className="mt-4 max-w-prose whitespace-pre-line border-t border-line pt-4 text-sm leading-6 text-ink-2">
                {part.notes}
              </p>
            )}
          </Panel>

          {suggestion === null ? null : (
            <Panel
              title="Why it says that"
              subtitle={`Looking ${household.reorderHorizonDays} days ahead, at the tasks that already exist.`}
            >
              <p className="text-sm leading-6 text-ink-2">{suggestion.reason}</p>
              <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-3">
                <Detail
                  term="On hand"
                  value={formatQuantity(suggestion.onHandMilli, part.unit, part.isKit)}
                />
                <Detail
                  term="Scheduled tasks need"
                  value={formatQuantity(suggestion.expectedDemandMilli, part.unit, part.isKit)}
                />
                <Detail
                  term="Left after them"
                  value={formatQuantity(suggestion.projectedBalanceMilli, part.unit, part.isKit)}
                />
              </dl>
              {suggestion.demandSources.length === 0 ? (
                <p className="mt-4 text-sm text-ink-3">
                  No open task in the horizon expects to use this.
                </p>
              ) : (
                <ul className="mt-4 flex list-none flex-col gap-1.5 border-t border-line pt-4">
                  {suggestion.demandSources.map((source) => (
                    <li
                      key={`${source.occurrenceId}-${source.qtyMilli}`}
                      className="flex flex-wrap items-baseline gap-x-2 text-sm"
                    >
                      <span className="vh-tnum font-medium text-ink">
                        {formatQuantity(source.qtyMilli, part.unit, part.isKit)}
                      </span>
                      <span className="text-ink-2">{source.title}</span>
                      <span className="vh-tnum text-xs text-ink-3">due {source.dueDate}</span>
                      {source.isRequired ? null : (
                        <Badge tone="neutral" size="sm">
                          optional
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {part.isKit ? (
            <Panel
              title="What is in the kit"
              subtitle={KIT_RULE_TEXT}
              actions={
                <KitContentsDialog
                  partId={part.id}
                  componentOptions={componentOptions}
                  initial={detail.components.map((component) => ({
                    componentPartId: component.partId,
                    qty: String(component.qtyMilli / 1000),
                  }))}
                />
              }
            >
              <p className="mb-4 max-w-prose text-sm leading-6 text-ink-2">{KIT_RULE_DETAIL}</p>
              {detail.components.length === 0 ? (
                <p className="text-sm text-ink-3">
                  Nothing listed yet, so this kit cannot be opened.
                </p>
              ) : (
                <ul className="flex list-none flex-col gap-2">
                  {detail.components.map((component) => (
                    <li key={component.partId} className="flex flex-wrap items-baseline gap-x-3">
                      <span className="vh-tnum w-16 text-sm font-medium text-ink">
                        {formatQuantity(component.qtyMilli, component.unit)}
                      </span>
                      <Link
                        href={`/supplies/${component.partId}`}
                        className="text-sm text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
                      >
                        {component.name}
                      </Link>
                      <span className="vh-tnum text-xs text-ink-3">
                        {formatQuantity(component.onHandMilli, component.unit)} on hand
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          ) : null}

          {detail.memberOfKits.length === 0 ? null : (
            <Panel
              title="Comes in a kit"
              subtitle="Opening one of these moves its contents onto this item."
            >
              <ul className="flex list-none flex-col gap-2">
                {detail.memberOfKits.map((kit) => (
                  <li key={kit.partId} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                    <Link
                      href={`/supplies/${kit.partId}`}
                      className="font-medium text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
                    >
                      {kit.name}
                    </Link>
                    <span className="text-ink-2">
                      contains {formatQuantity(kit.qtyMilli, part.unit)}
                    </span>
                    <span className="vh-tnum text-xs text-ink-3">
                      {formatQuantity(kit.onHandMilli, "pcs", true)} sealed
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {part.tracksLots ? (
            <Panel
              title="Lots"
              subtitle="One row per container or batch, so an expiry belongs to the thing that expires."
              actions={
                <LotDialog
                  partId={part.id}
                  unit={part.unit}
                  needsInitialQty={part.trackingMode === "estimated"}
                  storagePlaces={storagePlaceOptions}
                  initial={emptyLot()}
                  triggerLabel="Add a lot"
                />
              }
            >
              {detail.lots.length === 0 ? (
                <p className="text-sm text-ink-3">
                  No lots recorded. Add one when you buy a container whose date or opened state
                  matters.
                </p>
              ) : (
                <ul className="flex list-none flex-col divide-y divide-line">
                  {detail.lots.map((lot) => (
                    <li key={lot.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                      <span className="text-sm font-medium text-ink">{lot.label}</span>
                      {lot.isOpen ? <Badge tone="accent" size="sm">Open</Badge> : null}
                      {lot.expiresOn === null ? null : lot.expiresOn <= today ? (
                        <Badge tone="overdue" size="sm">Expired {lot.expiresOn}</Badge>
                      ) : (
                        <Badge tone="neutral" size="sm">Expires {lot.expiresOn}</Badge>
                      )}
                      {lot.estimatePct === null ? null : (
                        <span className="vh-tnum text-xs text-ink-2">
                          {lot.estimatePct} % left
                        </span>
                      )}
                      {lot.initialQtyMilli === null ? null : (
                        <span className="vh-tnum text-xs text-ink-3">
                          full size {formatQuantity(lot.initialQtyMilli, part.unit)}
                        </span>
                      )}
                      {lot.openedOn === null ? null : (
                        <span className="vh-tnum text-xs text-ink-3">opened {lot.openedOn}</span>
                      )}
                      <span className="ml-auto">
                        <LotDialog
                          partId={part.id}
                          unit={part.unit}
                          needsInitialQty={part.trackingMode === "estimated"}
                          storagePlaces={storagePlaceOptions}
                          triggerLabel={`Edit ${lot.label}`}
                          initial={{
                            lotId: lot.id,
                            label: lot.label,
                            storagePlaceId: lot.storagePlaceId ?? "",
                            purchasedOn: lot.purchasedOn ?? "",
                            expiresOn: lot.expiresOn ?? "",
                            openedOn: lot.openedOn ?? "",
                            initialQty:
                              lot.initialQtyMilli === null
                                ? ""
                                : String(lot.initialQtyMilli / 1000),
                            isOpen: lot.isOpen,
                            notes: lot.notes ?? "",
                          }}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {part.trackingMode === "estimated" && openEstimateLot === null ? (
                <p className="mt-3 text-sm text-due">
                  The estimate dial needs one open lot with its full size recorded. Add or open a
                  lot and set its size.
                </p>
              ) : null}
            </Panel>
          ) : null}

          <Panel
            title="Where you buy it"
            actions={
              <SupplierDialog
                partId={part.id}
                unit={part.unit}
                initial={emptySupplier()}
                triggerLabel="Add a supplier"
              />
            }
          >
            {detail.suppliers.length === 0 ? (
              <p className="text-sm text-ink-3">
                No supplier on file. The shopping list will still list this item, under &ldquo;no
                supplier on file&rdquo;.
              </p>
            ) : (
              <ul className="flex list-none flex-col divide-y divide-line">
                {detail.suppliers.map((supplier) => (
                  <li
                    key={supplier.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
                  >
                    <span className="text-sm font-medium text-ink">{supplier.supplierName}</span>
                    {supplier.isPreferred ? (
                      <Badge tone="accent" size="sm">
                        Usual
                      </Badge>
                    ) : null}
                    {supplier.supplierSku === null ? null : (
                      <span className="font-mono text-xs text-ink-3">{supplier.supplierSku}</span>
                    )}
                    {supplier.lastPriceCents === null ? null : (
                      <span className="vh-tnum text-xs text-ink-2">
                        {(supplier.lastPriceCents / 100).toFixed(2)} {supplier.currency ?? "EUR"}
                      </span>
                    )}
                    {supplier.packQtyMilli === null ? null : (
                      <span className="vh-tnum text-xs text-ink-3">
                        pack of {formatQuantity(supplier.packQtyMilli, part.unit, part.isKit)}
                      </span>
                    )}
                    {supplier.url === null ? null : (
                      <a
                        href={supplier.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 text-xs text-accent-text underline underline-offset-2"
                      >
                        Open
                        <ExternalLink aria-hidden="true" className="size-3" />
                      </a>
                    )}
                    <span className="ml-auto flex items-center gap-1">
                      <SupplierDialog
                        partId={part.id}
                        unit={part.unit}
                        triggerLabel={`Edit ${supplier.supplierName}`}
                        initial={{
                          supplierId: supplier.id,
                          supplierName: supplier.supplierName,
                          supplierSku: supplier.supplierSku ?? "",
                          url: supplier.url ?? "",
                          lastPrice:
                            supplier.lastPriceCents === null
                              ? ""
                              : (supplier.lastPriceCents / 100).toFixed(2),
                          currency: supplier.currency ?? "EUR",
                          packQty:
                            supplier.packQtyMilli === null
                              ? ""
                              : String(supplier.packQtyMilli / 1000),
                          leadTimeDays:
                            supplier.leadTimeDays === null ? "" : String(supplier.leadTimeDays),
                          isPreferred: supplier.isPreferred,
                          note: supplier.note ?? "",
                        }}
                      />
                      <RemoveSupplierButton
                        partId={part.id}
                        supplierId={supplier.id}
                        supplierName={supplier.supplierName}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="What it fits">
            {detail.compatibility.length === 0 ? (
              <p className="text-sm text-ink-3">
                Nothing recorded. Adding equipment here is what lets a task pre-fill its materials.
              </p>
            ) : (
              <ul className="flex list-none flex-col gap-2">
                {detail.compatibility.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {entry.assetId === null ? (
                      <span className="text-sm font-medium text-ink">{entry.label}</span>
                    ) : (
                      <Link
                        href={`/equipment/${entry.assetId}`}
                        className="text-sm font-medium text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
                      >
                        {entry.label}
                      </Link>
                    )}
                    {entry.locationName === null ? null : (
                      <span className="text-xs text-ink-3">{entry.locationName}</span>
                    )}
                    <Badge
                      tone={entry.confidence === "confirmed" ? "ok" : "neutral"}
                      size="sm"
                    >
                      {entry.confidence === "confirmed"
                        ? "Confirmed — it has been fitted"
                        : entry.confidence === "likely"
                          ? "Likely — the specification matches"
                          : "Unverified"}
                    </Badge>
                    {entry.assetId === null ? null : (
                      <Link
                        href={(locateInHouseHref(entry.assetId)) as Route}
                        className="inline-flex items-center gap-1 text-xs text-accent-text underline underline-offset-2"
                      >
                        <Wrench aria-hidden="true" className="size-3" />
                        Locate in house
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            flush
            title="Every movement"
            subtitle="Append-only: a mistake appears as the original plus its correction, and both stay."
            footer={`${detail.ledger.length} movement(s) shown, newest first. On hand is the sum of this column.`}
          >
            {detail.ledger.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="Nothing has moved yet"
                  description="Record a purchase or a stock take and the first row appears here."
                  note="Completing a task that uses this item also writes a row, attributed to the task."
                />
              </div>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Stock movements for {part.name}, newest first
                  </caption>
                  <thead>
                    <tr className="border-b border-line">
                      <th scope="col" className="bg-surface-2 px-3 py-2 text-xs font-medium text-ink-3">
                        When
                      </th>
                      <th scope="col" className="bg-surface-2 px-3 py-2 text-right text-xs font-medium text-ink-3">
                        Amount
                      </th>
                      <th scope="col" className="bg-surface-2 px-3 py-2 text-xs font-medium text-ink-3">
                        What happened
                      </th>
                      <th scope="col" className="hidden bg-surface-2 px-3 py-2 text-xs font-medium text-ink-3 md:table-cell">
                        Who
                      </th>
                      <th scope="col" className="bg-surface-2 px-3 py-2 text-right text-xs font-medium text-ink-3">
                        <span className="sr-only">Correct</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.ledger.map((row) => (
                      <tr key={row.id} className="border-b border-line/70 last:border-b-0">
                        <td className="vh-tnum px-3 py-2 align-top text-ink-2">
                          {row.occurredLocalDate}
                        </td>
                        <td
                          className={`vh-tnum px-3 py-2 align-top text-right font-medium ${row.qtyMilli < 0 ? "text-ink" : "text-ok"}`}
                        >
                          {formatSignedQuantity(row.qtyMilli, part.unit, part.isKit)}
                        </td>
                        <td className="px-3 py-2 align-top text-ink-2">
                          <span className="font-medium text-ink">
                            {STOCK_KIND_LABEL[row.kind]}
                          </span>{" "}
                          <span className="text-ink-3">— {STOCK_REASON_LABEL[row.reason]}</span>
                          {row.occurrenceId === null ? null : (
                            <span className="block text-xs text-ink-3">
                              Task: {row.occurrenceTitle ?? row.occurrenceId}
                            </span>
                          )}
                          {row.lotLabel === null ? null : (
                            <span className="block text-xs text-ink-3">Lot {row.lotLabel}</span>
                          )}
                          {row.storagePlaceName === null ? null : (
                            <span className="block text-xs text-ink-3">{row.storagePlaceName}</span>
                          )}
                          {row.notes === null ? null : (
                            <span className="block text-xs leading-5 text-ink-3">{row.notes}</span>
                          )}
                          {row.reversesTransactionId === null ? null : (
                            <Badge tone="neutral" size="sm" className="mt-1">
                              Corrects an earlier movement
                            </Badge>
                          )}
                          {row.reversedByTransactionId === null ? null : (
                            <Badge tone="neutral" size="sm" className="mt-1">
                              Already corrected
                            </Badge>
                          )}
                        </td>
                        <td className="hidden px-3 py-2 align-top text-ink-3 md:table-cell">
                          {row.actorName ?? "The system"}
                        </td>
                        <td className="px-3 py-2 align-top text-right">
                          {row.reversedByTransactionId === null ? (
                            <CorrectRow
                              partId={part.id}
                              transactionId={row.id}
                              qtyMilli={row.qtyMilli}
                              unit={part.unit}
                              isKit={part.isKit}
                              describe={`${STOCK_KIND_LABEL[row.kind]} on ${row.occurredLocalDate}`}
                            />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div className="flex flex-wrap items-center gap-3">
            <ArchiveToggle
              partId={part.id}
              partName={part.name}
              archived={part.archivedAtMs !== null}
            />
            <span className="text-xs text-ink-3">
              Archiving hides the item from the lists and keeps every movement it ever had.
            </span>
          </div>
        </>
      )}
    </PageScroll>
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function Detail({
  term,
  value,
  children,
}: {
  term: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">{term}</dt>
      <dd className="text-sm text-ink">{value}</dd>
      {children === undefined ? null : (
        <dd className="max-w-prose text-xs leading-5 text-ink-3">{children}</dd>
      )}
    </div>
  );
}

function toFormInitial(detail: NonNullable<ReturnType<typeof readPartDetail>>): PartFormInitial {
  const { part } = detail;
  return {
    partId: part.id,
    name: part.name,
    spec: part.spec ?? "",
    dimensions: part.dimensions ?? "",
    manufacturer: part.manufacturer ?? "",
    productCode: part.productCode ?? "",
    ean: part.ean ?? "",
    trackingMode: part.trackingMode,
    unit: part.unit,
    isKit: part.isKit,
    stocked: part.stockMode === "stocked",
    reorderThreshold:
      part.reorderThresholdMilli === null ? "" : String(part.reorderThresholdMilli / 1000),
    reorderTarget: part.reorderTargetMilli === null ? "" : String(part.reorderTargetMilli / 1000),
    leadTimeDays: part.leadTimeDays === null ? "" : String(part.leadTimeDays),
    defaultStoragePlaceId: part.defaultStoragePlaceId ?? "",
    tracksLots: part.tracksLots,
    notes: part.notes ?? "",
    components: detail.components.map((component) => ({
      componentPartId: component.partId,
      qty: String(component.qtyMilli / 1000),
    })),
  };
}
