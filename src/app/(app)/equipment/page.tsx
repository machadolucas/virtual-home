import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Radio, Wrench } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { EmptyState, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { listEquipment } from "@/server/queries/assets/list";
import { EquipmentList } from "./EquipmentList";

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
            <Link
              href="/settings/home-assistant"
              className={buttonClasses({ variant: "secondary" })}
            >
              <Radio aria-hidden="true" className="size-4" />
              Import from Home Assistant
            </Link>
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
        <EquipmentList groups={result.groups} total={result.total} />
      )}
    </PageScroll>
  );
}
