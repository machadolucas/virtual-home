import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Network } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, EmptyState, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { listLocationOptions } from "@/server/queries/assets/list";
import { listSystems } from "@/server/queries/assets/systems";
import { listAssetOptions } from "@/server/queries/inventory/detail";
import { SYSTEM_KIND_LABEL, SYSTEM_STATUS_LABEL } from "@/features/assets/labels";
import { DeleteSystemButton, SystemDialog, emptySystem } from "./SystemsEditor";

export const metadata: Metadata = { title: "Systems" };

/**
 * `/equipment/systems` — the functional groupings that span rooms.
 *
 * Each system shows two location lists: the rooms it *declares* it reaches and the rooms its
 * members actually sit in. Those disagreeing is information, not a bug — a ventilation system
 * whose members are all in the technical room but which serves the whole house is correctly
 * described, and one that declares two rooms while its members sit in five is not.
 */
export default async function SystemsPage() {
  await requireSessionPage("/equipment/systems");
  const { db } = pageContext();
  const systems = listSystems(db);
  const assets = listAssetOptions(db).map((asset) => ({
    value: asset.id,
    label: asset.name,
    hint: asset.locationName ?? undefined,
  }));
  const locations = listLocationOptions(db).map((location) => ({
    value: location.id,
    label: location.name,
    hint: location.parentName ?? location.kind,
  }));

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Equipment"
        title="Systems"
        description="The things that are not in one room: the ventilation, the water, the electrical, the network. A system is one of the three targets a maintenance plan can point at, alongside a unit and a room."
        actions={
          <>
            <Link href="/equipment" className={buttonClasses({ variant: "secondary" })}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              All equipment
            </Link>
            <SystemDialog
              initial={emptySystem()}
              assets={assets}
              locations={locations}
              triggerLabel="New system"
              triggerVariant="primary"
            />
          </>
        }
      />

      {systems.length === 0 ? (
        <EmptyState
          icon={<Network />}
          title="No systems yet"
          description="Group the equipment that works together across rooms, so “service the ventilation” is one plan rather than six."
          bullets={[
            "Members: the air handling unit, the ducts' filters, the extract fans, the roof cowl.",
            "The rooms it reaches, which is usually more than the rooms its equipment sits in.",
            "A target for a maintenance plan, so the schedule follows the system rather than one box.",
          ]}
          actions={
            <SystemDialog
              initial={emptySystem()}
              assets={assets}
              locations={locations}
              triggerLabel="Create the first system"
              triggerVariant="primary"
            />
          }
          note="Nothing groups itself. Two units in the same room are not a system until somebody says they are one."
        />
      ) : (
        systems.map((system) => (
          <Panel
            key={system.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {system.name}
                <Badge tone="neutral" size="sm">
                  {SYSTEM_KIND_LABEL[system.kind]}
                </Badge>
                {system.status === "active" ? null : (
                  <Badge tone="neutral" size="sm">
                    {SYSTEM_STATUS_LABEL[system.status]}
                  </Badge>
                )}
              </span>
            }
            subtitle={system.description ?? undefined}
            actions={
              <>
                <SystemDialog
                  triggerLabel="Edit"
                  triggerAriaLabel={`Edit ${system.name}`}
                  assets={assets}
                  locations={locations}
                  initial={{
                    systemId: system.id,
                    name: system.name,
                    kind: system.kind,
                    status: system.status,
                    description: system.description ?? "",
                    memberAssetIds: system.members.map((member) => member.assetId),
                    locationIds: system.declaredLocations.map((location) => location.id),
                  }}
                />
                <DeleteSystemButton
                  systemId={system.id}
                  systemName={system.name}
                  memberCount={system.members.length}
                />
              </>
            }
          >
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">
                  Equipment ({system.members.length})
                </h3>
                {system.members.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-3">
                    No members yet, so nothing scheduled against this system has anything to act on.
                  </p>
                ) : (
                  <ul className="mt-2 flex list-none flex-wrap gap-x-4 gap-y-1.5">
                    {system.members.map((member) => (
                      <li key={member.assetId} className="flex items-baseline gap-2">
                        <Link
                          href={`/equipment/${member.assetId}`}
                          className="text-sm text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current"
                        >
                          {member.assetName}
                        </Link>
                        <span className="text-xs text-ink-3">
                          {[member.locationName, member.role].filter(Boolean).join(" · ") ||
                            "no location"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">
                    Rooms it declares it reaches
                  </h3>
                  <p className="mt-1 text-sm text-ink-2">
                    {system.declaredLocations.length === 0
                      ? "None declared."
                      : system.declaredLocations.map((location) => location.name).join(", ")}
                  </p>
                </div>
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">
                    Rooms its equipment sits in
                  </h3>
                  <p className="mt-1 text-sm text-ink-2">
                    {system.memberLocationNames.length === 0
                      ? "None — its members have no location."
                      : system.memberLocationNames.join(", ")}
                  </p>
                </div>
              </div>
            </div>
          </Panel>
        ))
      )}
    </PageScroll>
  );
}
