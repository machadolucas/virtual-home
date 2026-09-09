"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { SYSTEM_KINDS, SYSTEM_STATUSES, type SystemKind, type SystemStatus } from "@/db/schema";
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea } from "@/ui";
import { SYSTEM_KIND_LABEL, SYSTEM_STATUS_LABEL } from "@/features/assets/labels";
import { useAction } from "@/features/settings/actionClient";
import { deleteSystem, upsertSystem } from "@/server/actions/assets/systems";

export interface SystemDraft {
  systemId?: string;
  name: string;
  kind: SystemKind;
  status: SystemStatus;
  description: string;
  memberAssetIds: string[];
  locationIds: string[];
}

function emptySystem(): SystemDraft {
  return {
    name: "",
    kind: "ventilation",
    status: "active",
    description: "",
    memberAssetIds: [],
    locationIds: [],
  };
}

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Create or edit a system.
 *
 * A system is the app's answer to "the ventilation" — a thing that spans rooms and has no single
 * location. It is one of the three targets a maintenance plan can point at, alongside a unit and a
 * room, which is why membership is edited deliberately here rather than inferred from what happens
 * to sit in the same corridor.
 */
export function SystemDialog({
  initial = emptySystem(),
  assets,
  locations,
  triggerLabel,
  triggerAriaLabel,
  triggerVariant = "secondary",
}: {
  initial?: SystemDraft;
  assets: readonly PickerOption[];
  locations: readonly PickerOption[];
  triggerLabel: string;
  /**
   * The trigger's accessible name, when the visible one repeats down a list. A page of systems
   * otherwise offers a column of buttons all called "Edit", which is unusable by voice or by
   * screen reader; the short visible label stays as it is.
   */
  triggerAriaLabel?: string;
  triggerVariant?: "primary" | "secondary" | "ghost";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initial);
  const editing = initial.systemId !== undefined;

  const call = useAction(upsertSystem, {
    successTitle: editing ? "System saved" : "System created",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const set = <K extends keyof SystemDraft>(key: K, value: SystemDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="lg"
      trigger={
        <Button
          variant={triggerVariant}
          size="sm"
          aria-label={triggerAriaLabel}
          icon={editing ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}
        >
          {triggerLabel}
        </Button>
      }
      title={editing ? `Edit ${initial.name}` : "New system"}
      description="A functional system that spans rooms: ventilation, water, heating, electrical, network."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={draft.name.trim() === ""}
            onClick={() =>
              call.run({
                systemId: draft.systemId ?? null,
                name: draft.name,
                kind: draft.kind,
                status: draft.status,
                description: draft.description,
                members: draft.memberAssetIds.map((assetId) => ({ assetId, role: null })),
                locationIds: draft.locationIds,
              })
            }
          >
            {editing ? "Save" : "Create it"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name" required className="sm:col-span-2">
            {({ id }) => (
              <Input
                id={id}
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Whole-house ventilation"
                autoFocus
              />
            )}
          </Field>
          <Field label="Kind" required>
            {({ id }) => (
              <Select
                id={id}
                value={draft.kind}
                onValueChange={(value) => set("kind", value as SystemKind)}
                options={SYSTEM_KINDS.map((kind) => ({
                  value: kind,
                  label: SYSTEM_KIND_LABEL[kind],
                }))}
              />
            )}
          </Field>
        </div>

        <Field label="Status" required>
          {({ id }) => (
            <Select
              id={id}
              value={draft.status}
              onValueChange={(value) => set("status", value as SystemStatus)}
              options={SYSTEM_STATUSES.map((status) => ({
                value: status,
                label: SYSTEM_STATUS_LABEL[status],
              }))}
            />
          )}
        </Field>

        <Field label="What it is" help="A sentence, for whoever reads this in five years.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={2}
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
            />
          )}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-[0.8125rem] font-medium text-ink-2">
            Equipment in this system
          </legend>
          {assets.length === 0 ? (
            <p className="text-sm text-ink-3">No equipment is recorded yet.</p>
          ) : (
            <div className="max-h-56 overflow-y-auto rounded-md border border-line p-2">
              {assets.map((asset) => (
                <Checkbox
                  key={asset.value}
                  checked={draft.memberAssetIds.includes(asset.value)}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({
                      ...current,
                      memberAssetIds:
                        checked === true
                          ? [...current.memberAssetIds, asset.value]
                          : current.memberAssetIds.filter((id) => id !== asset.value),
                    }))
                  }
                  label={asset.label}
                  hint={asset.hint}
                />
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-[0.8125rem] font-medium text-ink-2">Rooms it reaches</legend>
          <p className="text-xs leading-5 text-ink-3">
            The rooms this system serves, whether or not any of its equipment sits in them — the
            ducts run through the ceiling of every one.
          </p>
          {locations.length === 0 ? (
            <p className="text-sm text-ink-3">No locations exist yet — import a house model first.</p>
          ) : (
            <div className="max-h-56 overflow-y-auto rounded-md border border-line p-2">
              {locations.map((location) => (
                <Checkbox
                  key={location.value}
                  checked={draft.locationIds.includes(location.value)}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({
                      ...current,
                      locationIds:
                        checked === true
                          ? [...current.locationIds, location.value]
                          : current.locationIds.filter((id) => id !== location.value),
                    }))
                  }
                  label={location.label}
                  hint={location.hint}
                />
              ))}
            </div>
          )}
        </fieldset>

        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function DeleteSystemButton({
  systemId,
  systemName,
  memberCount,
}: {
  systemId: string;
  systemName: string;
  memberCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const call = useAction(deleteSystem, {
    successTitle: "System deleted",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Delete ${systemName}`}
          icon={<Trash2 aria-hidden="true" />}
        >
          Delete
        </Button>
      }
      title={`Delete ${systemName}?`}
      description="The grouping goes; every piece of equipment in it stays exactly as it is."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button variant="danger" loading={call.pending} onClick={() => call.run({ systemId })}>
            Delete it
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-ink-2">
        {memberCount === 0
          ? "It has no members, so nothing else is affected."
          : `Its ${memberCount} member(s) keep their own records, their own history and their own tasks — only the grouping disappears.`}{" "}
        If a maintenance plan targets this system, the deletion is refused rather than orphaning
        scheduled work.
      </p>
      {call.error === null ? null : (
        <p role="alert" className="mt-3 text-sm font-medium text-overdue">
          {call.error}
        </p>
      )}
    </Dialog>
  );
}
