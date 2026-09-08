import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Radio } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { listLocationOptions } from "@/server/queries/assets/list";
import { listSystems } from "@/server/queries/assets/systems";
import { listAssetOptions } from "@/server/queries/inventory/detail";
import { listPartOptions } from "@/server/queries/inventory/list";
import { SYSTEM_KIND_LABEL } from "@/features/assets/labels";
import { EMPTY_EQUIPMENT, EquipmentForm } from "../EquipmentForm";

export const metadata: Metadata = { title: "Add equipment" };

/**
 * `/equipment/new` — add a unit by hand.
 *
 * The alternative is importing from Home Assistant, which pre-fills the manufacturer, the model
 * and (through a confirmed area mapping) the room. This page is for everything HA has never heard
 * of: the water shut-off valve, the roof hatch, the car.
 */
export default async function NewEquipmentPage() {
  await requireSessionPage("/equipment/new");
  const { db } = pageContext();

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Equipment"
        title="Add equipment"
        description="Anything the house is made of that can be serviced, replaced or run out of something. Most of it has no sensor and never will."
        actions={
          <>
            <Link href="/equipment" className={buttonClasses({ variant: "secondary" })}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              All equipment
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
      />

      <EquipmentForm
        initial={EMPTY_EQUIPMENT}
        locations={listLocationOptions(db).map((location) => ({
          value: location.id,
          label: location.name,
          hint: location.parentName ?? location.kind,
        }))}
        parents={listAssetOptions(db).map((asset) => ({
          value: asset.id,
          label: asset.name,
          hint: asset.locationName ?? undefined,
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
    </PageScroll>
  );
}
