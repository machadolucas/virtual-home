"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRightLeft, PackageX } from "lucide-react";
import {
  ASSET_CATEGORIES,
  REPLACEMENT_REASONS,
  type AssetCategory,
  type ReplacementReason,
} from "@/db/schema";
import { Button, Checkbox, Dialog, Field, Input, RadioGroup, Select, Textarea } from "@/ui";
import { CATEGORY_LABEL, REPLACEMENT_REASON_LABEL } from "@/features/assets/labels";
import { useAction } from "@/features/settings/actionClient";
import { replaceEquipment, retireEquipment } from "@/server/actions/assets/equipment";

export interface SpareOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * "Replace equipment".
 *
 * The important thing about this flow is what it does *not* do: it does not edit the old unit into
 * being the new one. A replacement creates a second `asset` row and links the two, so the old
 * unit keeps every completion that was ever recorded against it and the new install is
 * unmistakably a different thing. Plans move forward; history stays where it happened.
 *
 * The two clone switches are the parts people get wrong, so they say what they mean:
 *  - consumables (the filter size it takes) almost always carry over;
 *  - Home Assistant links carry over **only if the same physical sensor stayed**, which is the
 *    exception, not the rule.
 */
export function ReplaceFlow({
  assetId,
  assetName,
  category,
  today,
  spares,
  alreadyReplaced,
}: {
  assetId: string;
  assetName: string;
  category: AssetCategory;
  today: string;
  spares: readonly SpareOption[];
  alreadyReplaced: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [existingAssetId, setExistingAssetId] = useState(spares[0]?.value ?? "");
  const [replacedOn, setReplacedOn] = useState(today);
  const [reason, setReason] = useState<ReplacementReason>("end_of_life");
  const [notes, setNotes] = useState("");
  const [cloneConsumables, setCloneConsumables] = useState(true);
  const [cloneHaLinks, setCloneHaLinks] = useState(false);
  const [newName, setNewName] = useState(assetName);
  const [newCategory, setNewCategory] = useState<AssetCategory>(category);
  const [newManufacturer, setNewManufacturer] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newSerial, setNewSerial] = useState("");

  const call = useAction(replaceEquipment, {
    successTitle: "Replacement recorded",
    successDescription: (data) =>
      `${data.newAssetName} is now the unit in service.` +
      (data.repointedPlanIds.length > 0
        ? ` ${data.repointedPlanIds.length} plan(s) moved across.`
        : ""),
    onSuccess: (data) => {
      setOpen(false);
      router.push(`/equipment/${data.newAssetId}`);
    },
  });

  if (alreadyReplaced) {
    return (
      <Button variant="secondary" size="sm" disabled icon={<ArrowRightLeft aria-hidden="true" />}>
        Already replaced
      </Button>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="lg"
      trigger={
        <Button variant="secondary" size="sm" icon={<ArrowRightLeft aria-hidden="true" />}>
          Replace equipment
        </Button>
      }
      title={`Replace ${assetName}`}
      description="A new row is created and the two are linked. The old unit keeps its whole service history; active plans move to the new one."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={mode === "existing" && existingAssetId === ""}
            onClick={() =>
              call.run({
                oldAssetId: assetId,
                replacedOn,
                reason,
                notes,
                cloneConsumables,
                cloneHaLinks,
                existingAssetId: mode === "existing" ? existingAssetId : null,
                newAsset:
                  mode === "new"
                    ? {
                        name: newName,
                        category: newCategory,
                        manufacturer: newManufacturer === "" ? null : newManufacturer,
                        modelName: newModel === "" ? null : newModel,
                        serialNumber: newSerial === "" ? null : newSerial,
                      }
                    : undefined,
                idempotencyKey: call.idempotencyKey,
              })
            }
          >
            Record the replacement
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <RadioGroup
          ariaLabel="What replaced it"
          value={mode}
          onValueChange={(value) => setMode(value as "new" | "existing")}
          options={[
            {
              value: "new",
              label: "A brand-new unit",
              hint: "Creates a new record from the details below.",
            },
            {
              value: "existing",
              label: "A spare that is already recorded",
              hint:
                spares.length === 0
                  ? "No unattached spare is recorded, so this is unavailable."
                  : "Marks that spare as installed and links it to this one.",
              disabled: spares.length === 0,
            },
          ]}
        />

        {mode === "existing" ? (
          <Field label="Which spare" required>
            {({ id }) => (
              <Select
                id={id}
                value={existingAssetId}
                onValueChange={setExistingAssetId}
                placeholder="Choose a spare…"
                options={spares}
              />
            )}
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              required
              className="sm:col-span-2"
              help="Anything you leave blank is copied from the unit being replaced."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
              )}
            </Field>
            <Field label="Category">
              {({ id }) => (
                <Select
                  id={id}
                  value={newCategory}
                  onValueChange={(value) => setNewCategory(value as AssetCategory)}
                  options={ASSET_CATEGORIES.map((entry) => ({
                    value: entry,
                    label: CATEGORY_LABEL[entry],
                  }))}
                />
              )}
            </Field>
            <Field label="Manufacturer">
              {({ id }) => (
                <Input
                  id={id}
                  value={newManufacturer}
                  onChange={(event) => setNewManufacturer(event.target.value)}
                />
              )}
            </Field>
            <Field label="Model">
              {({ id }) => (
                <Input
                  id={id}
                  value={newModel}
                  onChange={(event) => setNewModel(event.target.value)}
                />
              )}
            </Field>
            <Field label="Serial number">
              {({ id }) => (
                <Input
                  id={id}
                  className="font-mono"
                  value={newSerial}
                  onChange={(event) => setNewSerial(event.target.value)}
                />
              )}
            </Field>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Replaced on" required help="The day the swap actually happened.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="date"
                aria-describedby={describedBy}
                value={replacedOn}
                onChange={(event) => setReplacedOn(event.target.value)}
              />
            )}
          </Field>
          <Field label="Why" required>
            {({ id }) => (
              <Select
                id={id}
                value={reason}
                onValueChange={(value) => setReason(value as ReplacementReason)}
                options={REPLACEMENT_REASONS.map((entry) => ({
                  value: entry,
                  label: REPLACEMENT_REASON_LABEL[entry],
                }))}
              />
            )}
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <Checkbox
            checked={cloneConsumables}
            onCheckedChange={(checked) => setCloneConsumables(checked === true)}
            label="Copy what it consumes"
            hint="The filter size, the battery type. Usually right — untick it if the new unit takes something different."
          />
          <Checkbox
            checked={cloneHaLinks}
            onCheckedChange={(checked) => setCloneHaLinks(checked === true)}
            label="Copy the Home Assistant links"
            hint="Only if the same physical sensor stayed in place. If the new unit reports through new entities, leave this off and link it afterwards — you will be reminded."
          />
        </div>

        <Field label="Note" help="What actually happened, in a sentence.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Fan bearing seized after eleven years; same model fitted."
            />
          )}
        </Field>

        <p className="text-xs leading-5 text-ink-3">
          A replacement is not a completion. If a task covered this work, complete that task as
          well — telemetry recovering and a swap being recorded are both different from somebody
          saying the job is done.
        </p>

        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Retire a unit without a successor.
 *
 * Separate from replacing on purpose: "we took it out and nothing took its place" is a different
 * fact, and forcing it through the replacement flow would leave a `replaced_by` pointer that is
 * simply untrue.
 */
export function RetireButton({
  assetId,
  assetName,
  today,
}: {
  assetId: string;
  assetName: string;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"removed" | "retired" | "lost">("removed");
  const [removedOn, setRemovedOn] = useState(today);
  const [notes, setNotes] = useState("");

  const call = useAction(retireEquipment, {
    successTitle: "Taken out of service",
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
        <Button variant="ghost" size="sm" icon={<PackageX aria-hidden="true" />}>
          Take out of service
        </Button>
      }
      title={`Take ${assetName} out of service`}
      description="Nothing is deleted. Its history stays, its Home Assistant links are retired rather than removed, and it disappears from the equipment list."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={call.pending}
            onClick={() => call.run({ assetId, status, removedOn, notes })}
          >
            Record it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioGroup
          ariaLabel="What happened to it"
          value={status}
          onValueChange={(value) => setStatus(value as "removed" | "retired" | "lost")}
          options={[
            {
              value: "removed",
              label: "Removed",
              hint: "Physically taken out and gone.",
            },
            {
              value: "retired",
              label: "Retired in place",
              hint: "Still there, deliberately not in use — a capped-off radiator, a disconnected alarm.",
            },
            { value: "lost", label: "Lost", hint: "Nobody knows where it went." },
          ]}
        />

        <Field label="When" required>
          {({ id }) => (
            <Input
              id={id}
              type="date"
              value={removedOn}
              onChange={(event) => setRemovedOn(event.target.value)}
            />
          )}
        </Field>

        <Field label="Note">
          {({ id }) => (
            <Textarea
              id={id}
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>

        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
