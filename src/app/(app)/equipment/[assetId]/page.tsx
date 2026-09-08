import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, MapPin, Pencil } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, EmptyState, Panel, StatusBadge, StatusDot, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { listLocationOptions } from "@/server/queries/assets/list";
import { listSpareOptions, readAssetDetail } from "@/server/queries/assets/detail";
import { listSystems } from "@/server/queries/assets/systems";
import { listAssetOptions } from "@/server/queries/inventory/detail";
import { listPartOptions } from "@/server/queries/inventory/list";
import { browseRegistry } from "@/server/queries/ha/registry";
import {
  ASSET_STATUS_LABEL,
  ASSET_STATUS_TONE,
  CATEGORY_LABEL,
  CONSUMABLE_ROLE_LABEL,
  SYSTEM_KIND_LABEL,
  locateInHouseHref,
} from "@/features/assets/labels";
import { formatQuantity } from "@/features/inventory/units";
import { formatBytes } from "@/features/settings/format";
import { EquipmentForm, type EquipmentFormInitial } from "../EquipmentForm";
import { ConsumablesEditor } from "./ConsumablesEditor";
import { LinksPanel } from "./LinksPanel";
import { ReplaceFlow, RetireButton } from "./ReplaceFlow";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ assetId: string }>;
}): Promise<Metadata> {
  const { assetId } = await params;
  const { db, household, nowMs } = pageContext();
  const detail = readAssetDetail(db, assetId, {
    nowMs,
    batteryThresholdPct: household.batteryThresholdPct,
    batteryStaleHours: household.batteryStaleHours,
  });
  return { title: detail === null ? "Equipment not found" : detail.asset.name };
}

/**
 * `/equipment/[assetId]` — one unit: what it is, where it is, what it eats, what watches it, and
 * everything that was ever done to it.
 *
 * The history panel shows completions from the whole replacement chain and marks the ones that
 * belong to an earlier unit. That is the honest presentation: the appliance has an eleven-year
 * service record, and the box currently bolted to the wall has had two of those years.
 */
export default async function EquipmentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ assetId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { assetId } = await params;
  await requireSessionPage(`/equipment/${assetId}`);
  const query = await searchParams;
  const editing = firstValue(query["edit"]) === "1";

  const { db, household, today, nowMs } = pageContext();
  const detail = readAssetDetail(db, assetId, {
    nowMs,
    batteryThresholdPct: household.batteryThresholdPct,
    batteryStaleHours: household.batteryStaleHours,
  });
  if (detail === null) notFound();

  const { asset } = detail;

  // Entities to offer in the "link an entity" picker: everything live and visible in the cache.
  const registry = browseRegistry(db, { includeHidden: false, query: "" });
  const entityOptions = registry.groups
    .flatMap((group) => group.areas)
    .flatMap((area) => area.devices)
    .flatMap((device) =>
      device.canonicalBatteryEntityId === null
        ? []
        : [
            {
              value: device.canonicalBatteryEntityId,
              label: `${device.nameByUser ?? device.name ?? device.deviceId} — battery`,
              hint: device.areaName ?? undefined,
            },
          ],
    );

  return (
    <PageScroll>
      <PageHeader
        eyebrow={CATEGORY_LABEL[asset.category]}
        title={asset.name}
        description={
          [asset.manufacturer, asset.modelName, asset.serialNumber]
            .filter(Boolean)
            .join(" · ") || "No manufacturer, model or serial number recorded."
        }
        actions={
          <>
            <Link href="/equipment" className={buttonClasses({ variant: "secondary" })}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              All equipment
            </Link>
            <Link
              href={editing ? `/equipment/${assetId}` : `/equipment/${assetId}?edit=1`}
              className={buttonClasses({ variant: editing ? "primary" : "secondary" })}
            >
              <Pencil aria-hidden="true" className="size-4" />
              {editing ? "Stop editing" : "Edit details"}
            </Link>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={ASSET_STATUS_TONE[asset.status]}>{ASSET_STATUS_LABEL[asset.status]}</Badge>
          {asset.isVirtual ? <Badge tone="neutral">Software</Badge> : null}
          {detail.locationPath === null ? (
            <span className="text-xs text-ink-3">No location recorded</span>
          ) : (
            <Link
              href={locateInHouseHref(asset.id)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
            >
              <MapPin aria-hidden="true" className="size-3.5" />
              {detail.locationPath} — locate in the house
            </Link>
          )}
          {detail.battery === null ? null : (
            <span className="flex items-center gap-1.5">
              <StatusDot kind={detail.battery.status} label={null} />
              <span className="vh-tnum text-xs font-medium text-ink-2">
                {detail.battery.label}
              </span>
            </span>
          )}
          {detail.openTasks.length === 0 ? null : (
            <span className="vh-tnum text-xs text-ink-2">
              {detail.openTasks.length} open task(s)
            </span>
          )}
        </div>
      </PageHeader>

      {editing ? (
        <EquipmentForm
          initial={toFormInitial(detail)}
          locations={listLocationOptions(db).map((location) => ({
            value: location.id,
            label: location.name,
            hint: location.parentName ?? location.kind,
          }))}
          parents={listAssetOptions(db)
            .filter((option) => option.id !== assetId)
            .map((option) => ({
              value: option.id,
              label: option.name,
              hint: option.locationName ?? undefined,
            }))}
          parts={listPartOptions(db).map((part) => ({
            value: part.id,
            label: part.name,
            hint: part.spec ?? part.unit,
          }))}
          systems={listSystems(db).map((system) => ({
            value: system.id,
            label: system.name,
            hint: SYSTEM_KIND_LABEL[system.kind],
          }))}
        />
      ) : (
        <>
          {detail.replacedBy === null ? null : (
            <Panel title="This unit is no longer in service">
              <p className="max-w-prose text-sm leading-6 text-ink-2">
                It was replaced by{" "}
                <Link
                  href={`/equipment/${detail.replacedBy.id}`}
                  className="font-medium text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
                >
                  {detail.replacedBy.name}
                </Link>
                {detail.replacement === null ? "" : ` on ${detail.replacement.replacedOn}`}. Its
                service history stays here, on the unit that was actually serviced.
              </p>
            </Panel>
          )}

          <Panel title="Details">
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Detail term="Category" value={CATEGORY_LABEL[asset.category]} />
              <Detail term="Status" value={ASSET_STATUS_LABEL[asset.status]} />
              <Detail
                term="Installed"
                value={
                  asset.installedOn === null
                    ? "Not recorded"
                    : `${asset.installedOn}${asset.installedOnPrecision === "exact" || asset.installedOnPrecision === null ? "" : ` (${asset.installedOnPrecision} only)`}`
                }
              >
                {asset.installedOn === null
                  ? "Nothing is inferred from when Home Assistant first saw it — that is when we noticed the device, not when it was installed."
                  : undefined}
              </Detail>
              <Detail term="Removed" value={asset.removedOn ?? "—"} />
              <Detail
                term="Warranty"
                value={asset.warrantyUntil ?? "Not recorded"}
              >
                {asset.warrantyUntil !== null && asset.warrantyUntil < today
                  ? "Expired."
                  : undefined}
              </Detail>
              <Detail
                term="Expected life"
                value={
                  asset.expectedLifeYears === null ? "Not recorded" : `${asset.expectedLifeYears} years`
                }
              />
              <Detail
                term="Purchase price"
                value={
                  asset.purchasePriceCents === null
                    ? "Not recorded"
                    : `${(asset.purchasePriceCents / 100).toFixed(2)} ${asset.currency ?? "EUR"}`
                }
              />
              <Detail term="Serial number" value={asset.serialNumber ?? "Not recorded"} />
            </dl>
            {asset.notes === null ? null : (
              <div className="mt-4 border-t border-line pt-4">
                <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">
                  Notes and how to find it
                </h3>
                <p className="mt-1 max-w-prose whitespace-pre-line text-sm leading-6 text-ink-2">
                  {asset.notes}
                </p>
              </div>
            )}
          </Panel>

          <Panel
            title="What it consumes"
            subtitle="This is what pre-fills a task's materials and what the shopping list counts as demand."
            actions={
              <ConsumablesEditor
                assetId={asset.id}
                initial={detail.consumables.map((line) => ({
                  partId: line.partId,
                  role: line.role,
                  qty: String(line.qtyMilli / 1000),
                }))}
                partOptions={listPartOptions(db).map((part) => ({
                  value: part.id,
                  label: part.name,
                  hint: part.spec ?? part.unit,
                }))}
              />
            }
          >
            {detail.consumables.length === 0 ? (
              <p className="text-sm text-ink-3">
                Nothing recorded. Adding a battery or a filter here is what makes a task able to
                say “2 × AAA” without anybody typing it.
              </p>
            ) : (
              <ul className="flex list-none flex-col divide-y divide-line">
                {detail.consumables.map((line) => (
                  <li key={line.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <Badge tone="neutral" size="sm">
                      {CONSUMABLE_ROLE_LABEL[line.role]}
                    </Badge>
                    <span className="vh-tnum text-sm font-medium text-ink">
                      {formatQuantity(line.qtyMilli, line.unit, line.isKit)}
                    </span>
                    <Link
                      href={`/supplies/${line.partId}`}
                      className="text-sm text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
                    >
                      {line.partName}
                    </Link>
                    <span className="vh-tnum text-xs text-ink-3">
                      {formatQuantity(line.onHandMilli, line.unit, line.isKit)} on hand
                    </span>
                    {line.onHandMilli < line.qtyMilli ? (
                      <Badge tone="due" size="sm">
                        Not enough for one change
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Home Assistant"
            subtitle="Bound by registry id, so a rename in Home Assistant changes nothing here."
          >
            <LinksPanel
              assetId={asset.id}
              links={detail.haLinks.map((link) => ({
                id: link.id,
                linkKind: link.linkKind,
                role: link.role,
                linkState: link.linkState,
                entityId: link.entityId,
                entityIdSnapshot: link.entityIdSnapshot,
                haDeviceName: link.haDeviceName,
                haEntityRegistryId: link.haEntityRegistryId,
                state: link.state,
                unitOfMeasurement: link.unitOfMeasurement,
                notes: link.notes,
              }))}
              suggestions={detail.relinkSuggestions}
              entityOptions={entityOptions}
            />
          </Panel>

          {detail.conditionRules.length === 0 ? null : (
            <Panel
              title="Rules watching it"
              subtitle="What turns a reading into a task. Configured under Settings → Home Assistant."
            >
              <ul className="flex list-none flex-col divide-y divide-line">
                {detail.conditionRules.map((rule) => (
                  <li key={rule.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <span className="text-sm font-medium text-ink">{rule.name}</span>
                    <Badge tone={rule.enabled ? "accent" : "neutral"} size="sm">
                      {rule.enabled ? "On" : "Off"}
                    </Badge>
                    <span className="vh-tnum text-xs text-ink-2">
                      below {rule.thresholdPct ?? household.batteryThresholdPct} %
                      {rule.clearThresholdPct === null
                        ? ""
                        : `, clears above ${rule.clearThresholdPct} %`}
                      {rule.sustainMinutes === null ? "" : `, sustained ${rule.sustainMinutes} min`}
                    </span>
                    {rule.defaultPartName === null ? null : (
                      <span className="text-xs text-ink-3">uses {rule.defaultPartName}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {detail.systems.length === 0 ? null : (
            <Panel title="Systems it belongs to">
              <ul className="flex list-none flex-wrap gap-2">
                {detail.systems.map((system) => (
                  <li key={system.id}>
                    <Link
                      href="/equipment/systems"
                      className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink-2 hover:bg-surface-3"
                    >
                      <span className="font-medium text-ink">{system.name}</span>
                      <span className="text-xs text-ink-3">
                        {SYSTEM_KIND_LABEL[system.kind as keyof typeof SYSTEM_KIND_LABEL]}
                        {system.role === null ? "" : ` · ${system.role}`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel
            title="Scheduled work"
            subtitle={
              detail.plans.length === 0
                ? "No plan targets this unit yet."
                : `${detail.plans.length} plan(s), ${detail.openTasks.length} open task(s).`
            }
          >
            {detail.plans.length === 0 && detail.openTasks.length === 0 ? (
              <p className="text-sm text-ink-3">
                Nothing is scheduled. A plan is what turns “this needs doing every year” into a
                task that appears on the right day.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {detail.plans.length === 0 ? null : (
                  <ul className="flex list-none flex-col gap-2">
                    {detail.plans.map((plan) => (
                      <li key={plan.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-sm font-medium text-ink">{plan.title}</span>
                        <Badge tone={plan.status === "active" ? "accent" : "neutral"} size="sm">
                          {plan.status}
                        </Badge>
                        <span className="text-xs text-ink-3">{plan.scheduleKind}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {detail.openTasks.length === 0 ? null : (
                  <ul className="flex list-none flex-col gap-2 border-t border-line pt-4">
                    {detail.openTasks.map((task) => (
                      <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <StatusBadge kind={task.status === "due" ? "due" : "unknown"} size="sm" />
                        <span className="text-sm text-ink">{task.title}</span>
                        <span className="vh-tnum text-xs text-ink-3">due {task.dueDate}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Panel>

          <Panel
            flush
            title="What was actually done"
            subtitle={
              detail.chainNames.length > 1
                ? "Including the units this one replaced — the appliance's record, not just this box's."
                : "Completions recorded against this unit."
            }
            footer={
              detail.chainNames.length > 1
                ? `Replacement chain: ${detail.chainNames.map((entry) => entry.name).join(" → ")}`
                : undefined
            }
          >
            {detail.completions.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="Nothing recorded yet"
                  description="A completion appears here when somebody says the work is done. Nothing else writes one."
                  note="Setting up a schedule writes an anchor date, not a completion. Telemetry recovering is not proof of maintenance either."
                />
              </div>
            ) : (
              <ul className="flex list-none flex-col">
                {detail.completions.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-col gap-1 border-b border-line px-4 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4"
                  >
                    <span className="vh-tnum w-28 shrink-0 text-sm text-ink-2">
                      {entry.completedLocalDate}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-ink">
                          {entry.outcome === "done"
                            ? "Done"
                            : entry.outcome === "done_with_issues"
                              ? "Done, with issues"
                              : "Partly done"}
                        </span>
                        <span className="text-xs text-ink-3">
                          {entry.performedByName ?? "a professional"}
                        </span>
                        {entry.viaChain ? (
                          <Badge tone="neutral" size="sm">
                            On an earlier unit
                          </Badge>
                        ) : null}
                      </span>
                      {entry.notes === null ? null : (
                        <span className="text-xs leading-5 text-ink-3">{entry.notes}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Manuals and photos"
            subtitle="Served only through an authenticated route — nothing here is on a public path."
          >
            {detail.documents.length === 0 && detail.closeUpPhotos.length === 0 ? (
              <p className="text-sm text-ink-3">
                Nothing attached. A photo of the nameplate and a close-up of how to reach the unit
                are the two that save the most time later.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {detail.closeUpPhotos.length === 0 ? null : (
                  <div>
                    <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">
                      Close-ups of where it is
                    </h3>
                    <ul className="mt-2 flex list-none flex-wrap gap-3">
                      {detail.closeUpPhotos.map((photo) => (
                        <li key={photo.id}>
                          <a
                            href={`/api/attachments/${photo.id}?variant=web`}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="block max-w-40 overflow-hidden rounded-md border border-line"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/attachments/${photo.id}?variant=thumb`}
                              alt={photo.caption ?? photo.originalFilename}
                              width={photo.width ?? 160}
                              height={photo.height ?? 120}
                              className="h-auto w-full"
                            />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {detail.documents.length === 0 ? null : (
                  <ul className="flex list-none flex-col divide-y divide-line">
                    {detail.documents.map((document) => (
                      <li
                        key={document.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
                      >
                        <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                        <a
                          href={`/api/attachments/${document.id}`}
                          className="text-sm font-medium text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
                        >
                          {document.caption ?? document.originalFilename}
                        </a>
                        <span className="text-xs text-ink-3">{document.kind}</span>
                        <span className="vh-tnum text-xs text-ink-3">
                          {formatBytes(document.byteSize)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Panel>

          <Panel title="End of the line">
            <div className="flex flex-wrap items-center gap-3">
              <ReplaceFlow
                assetId={asset.id}
                assetName={asset.name}
                category={asset.category}
                today={today}
                spares={listSpareOptions(db, asset.id).map((spare) => ({
                  value: spare.id,
                  label: spare.name,
                  hint: spare.locationName ?? CATEGORY_LABEL[spare.category],
                }))}
                alreadyReplaced={asset.replacedByAssetId !== null}
              />
              {asset.status === "installed" || asset.status === "planned" ? (
                <RetireButton assetId={asset.id} assetName={asset.name} today={today} />
              ) : null}
            </div>
            <p className="mt-3 max-w-prose text-xs leading-5 text-ink-3">
              Replacing creates a second record and links the two, so this unit keeps the work that
              was done to it. Taking a unit out of service without a successor is a separate,
              honest statement — not a replacement with a blank on the other side.
            </p>
          </Panel>
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

function toFormInitial(
  detail: NonNullable<ReturnType<typeof readAssetDetail>>,
): EquipmentFormInitial {
  const { asset } = detail;
  return {
    assetId: asset.id,
    name: asset.name,
    category: asset.category,
    manufacturer: asset.manufacturer ?? "",
    modelName: asset.modelName ?? "",
    serialNumber: asset.serialNumber ?? "",
    productCode: asset.productCode ?? "",
    locationId: asset.locationId ?? "",
    parentAssetId: asset.parentAssetId ?? "",
    isVirtual: asset.isVirtual,
    status: asset.status,
    installedOn: asset.installedOn ?? "",
    installedOnPrecision: asset.installedOnPrecision ?? "",
    purchasePrice:
      asset.purchasePriceCents === null ? "" : (asset.purchasePriceCents / 100).toFixed(2),
    currency: asset.currency ?? "EUR",
    warrantyUntil: asset.warrantyUntil ?? "",
    expectedLifeYears: asset.expectedLifeYears === null ? "" : String(asset.expectedLifeYears),
    notes: asset.notes ?? "",
    consumables: detail.consumables.map((line) => ({
      partId: line.partId,
      role: line.role,
      qty: String(line.qtyMilli / 1000),
    })),
    systemIds: detail.systems.map((system) => system.id),
  };
}
