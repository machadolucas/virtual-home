import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Radio, Wrench } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, EmptyState, Panel, StatusDot, buttonClasses, cn } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { listEquipment } from "@/server/queries/assets/list";
import {
  ASSET_STATUS_LABEL,
  ASSET_STATUS_TONE,
  CATEGORY_LABEL,
  LINK_STATE_META,
} from "@/features/assets/labels";

export const metadata: Metadata = { title: "Equipment" };

/**
 * `/equipment` — every piece of equipment, grouped by where it is.
 *
 * The battery column is the reason this page is careful: it shows a percentage only when there is
 * a reading recent enough to believe. No reading is "Battery unknown", an old one is "Last read
 * 40 %", and **neither is ever 0 %** (CLAUDE.md rule 8). A smoke alarm we know nothing about needs
 * a different reaction from one with a flat battery.
 */
export default async function EquipmentPage() {
  await requireSessionPage("/equipment");
  const { db, household, nowMs } = pageContext();
  const result = listEquipment(db, {
    nowMs,
    batteryThresholdPct: household.batteryThresholdPct,
    batteryStaleHours: household.batteryStaleHours,
  });

  return (
    <PageScroll>
      <PageHeader
        eyebrow="House"
        title="Equipment"
        description="Everything the house is made of that can be serviced, replaced or run out of something: appliances, ventilation, valves, alarms, the car. Grouped by where it is."
        actions={
          <>
            <Link href="/equipment/systems" className={buttonClasses({ variant: "secondary" })}>
              Systems
            </Link>
            <Link href="/equipment/new" className={buttonClasses({ variant: "primary" })}>
              <Plus aria-hidden="true" className="size-4" />
              Add equipment
            </Link>
          </>
        }
      />

      {result.isEmpty ? (
        <EmptyState
          icon={<Wrench />}
          title="No equipment recorded yet"
          description="Add a unit by hand, or import one from Home Assistant — the registry cache already knows every device your instance has."
          bullets={[
            "What it is, where it is, and what it consumes — so a task can pre-fill its materials.",
            "Its Home Assistant entities with a role each, bound by registry id so a rename in HA changes nothing.",
            "Battery level from the canonical battery entity, shown as a percentage only when the reading is recent.",
            "Its whole service history, and the history of the units it replaced.",
          ]}
          actions={
            <>
              <Link href="/equipment/new" className={buttonClasses({ variant: "primary" })}>
                Add the first unit
              </Link>
              <Link
                href="/settings/home-assistant"
                className={buttonClasses({ variant: "secondary" })}
              >
                <Radio aria-hidden="true" className="size-4" />
                Import from Home Assistant
              </Link>
            </>
          }
          note="Nothing appears here from a sensor alone. A device becomes equipment when somebody says it is."
        />
      ) : (
        result.groups.map((group) => (
          <Panel
            key={group.locationId ?? "__none"}
            flush
            title={group.locationName}
            subtitle={
              group.locationId === null
                ? "No location recorded. Software units belong here; a physical unit here needs a room."
                : `${group.rows.length} unit(s)`
            }
          >
            <ul className="flex list-none flex-col">
              {group.rows.map((row) => (
                <li key={row.id} className="border-b border-line last:border-b-0">
                  <Link
                    href={`/equipment/${row.id}`}
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
                        <Badge tone="neutral" size="sm">
                          {CATEGORY_LABEL[row.category]}
                        </Badge>
                        {row.status === "installed" ? null : (
                          <Badge tone={ASSET_STATUS_TONE[row.status]} size="sm">
                            {ASSET_STATUS_LABEL[row.status]}
                          </Badge>
                        )}
                        {row.isVirtual ? (
                          <Badge tone="neutral" size="sm">
                            Software
                          </Badge>
                        ) : null}
                      </span>
                      <span className="text-xs leading-5 text-ink-3">
                        {[row.manufacturer, row.modelName].filter(Boolean).join(" ") ||
                          "No manufacturer or model recorded."}
                      </span>
                    </span>

                    <span className="flex shrink-0 flex-wrap items-center gap-3 sm:w-80 sm:justify-end">
                      {row.openTaskCount === 0 ? null : (
                        <span className="flex items-center gap-1.5">
                          <StatusDot
                            kind={row.overdueTaskCount > 0 ? "due" : "unknown"}
                            label={
                              row.overdueTaskCount > 0
                                ? `${row.overdueTaskCount} due now`
                                : "open tasks"
                            }
                          />
                          <span className="vh-tnum text-xs text-ink-2">
                            {row.openTaskCount} open
                          </span>
                        </span>
                      )}

                      {row.battery === null ? null : (
                        <span className="flex items-center gap-1.5">
                          <StatusDot kind={row.battery.status} label={null} />
                          <span className="vh-tnum text-xs font-medium text-ink-2">
                            {row.battery.label}
                          </span>
                        </span>
                      )}

                      {row.linkState === null ? (
                        <span className="hidden text-xs text-ink-3 md:inline">Not linked</span>
                      ) : (
                        <Badge tone={LINK_STATE_META[row.linkState].tone} size="sm">
                          {LINK_STATE_META[row.linkState].label}
                        </Badge>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ))
      )}

      {result.isEmpty ? null : (
        <p className="text-xs leading-5 text-ink-3">
          {result.total} unit(s) in service or planned. A battery shown as “unknown” means no
          reading has arrived — never that the battery is empty. A link marked “Renamed in HA” still
          works: the binding is to the registry id, and only the label we cached is out of date.
        </p>
      )}
    </PageScroll>
  );
}
