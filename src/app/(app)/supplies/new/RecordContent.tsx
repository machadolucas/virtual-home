import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { listPartOptions, listStoragePlaces } from "@/server/queries/inventory/list";
import { listAssetOptions } from "@/server/queries/inventory/detail";
import { EMPTY_PART, PartForm } from "../PartForm";

export const metadata: Metadata = { title: "Add an item" };

/** `/supplies/new` — define a consumable. Defining it adds no stock; a movement does that. */
export default async function NewPartPage() {
  await requireSessionPage("/supplies/new");
  const { db } = pageContext();

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Supplies"
        title="Add an item"
        description="Everything the house consumes: filters, bulbs, salt, oil, batteries, paint. Describe it once and every task that needs it can pre-fill its materials."
        actions={
          <Link href="/supplies" className={buttonClasses({ variant: "secondary" })}>
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back to supplies
          </Link>
        }
      />

      <PartForm
        initial={EMPTY_PART}
        storagePlaces={listStoragePlaces(db).map((place) => ({
          value: place.id,
          label: place.name,
          hint: place.locationName ?? undefined,
        }))}
        componentOptions={listPartOptions(db, { excludeKits: true }).map((part) => ({
          value: part.id,
          label: part.name,
          hint: part.spec ?? part.unit,
        }))}
        assetOptions={listAssetOptions(db).map((asset) => ({
          value: asset.id,
          label: asset.name,
          hint: asset.locationName ?? undefined,
        }))}
      />
    </PageScroll>
  );
}
