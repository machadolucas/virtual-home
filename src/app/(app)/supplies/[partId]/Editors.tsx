"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { PartUnit } from "@/db/schema";
import { Button, Checkbox, Dialog, Field, IconButton, Input, Select, Textarea } from "@/ui";
import { parseQuantityToMilli, readPrice, readRowQuantity } from "@/features/inventory/units";
import { useAction } from "@/features/settings/actionClient";
import {
  removeSupplier,
  setKitComponents,
  setPartArchived,
  upsertLot,
  upsertSupplier,
} from "@/server/actions/inventory/parts";

import type { LotDraft, SupplierDraft } from "./drafts";

const NO_PLACE = "__none";

/* ------------------------------------------------------------------------------------- lots */

/**
 * Add or edit a lot.
 *
 * "Lot" is the app's word for one physical container or batch: the bottle you opened, the box with
 * the 2028 date on it. It exists so an expiry and an opened date can belong to *that* container
 * rather than to the item in general.
 */
export function LotDialog({
  partId,
  unit,
  needsInitialQty,
  storagePlaces,
  initial,
  triggerLabel,
}: {
  partId: string;
  unit: PartUnit;
  /** True for an `estimated` item: a percentage needs the container's full size to mean anything. */
  needsInitialQty: boolean;
  storagePlaces: readonly { value: string; label: string }[];
  initial: LotDraft;
  triggerLabel: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initial);
  const editing = initial.lotId !== undefined;

  const call = useAction(upsertLot, {
    successTitle: editing ? "Lot saved" : "Lot added",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const fieldError = (name: string): string | undefined => call.fieldErrors[name]?.[0];

  const set = <K extends keyof LotDraft>(key: K, value: LotDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        editing ? (
          <IconButton label={triggerLabel} variant="ghost" size="sm" icon={<Pencil aria-hidden="true" />} />
        ) : (
          <Button variant="secondary" size="sm" icon={<Plus aria-hidden="true" />}>
            {triggerLabel}
          </Button>
        )
      }
      title={editing ? "Edit this lot" : "Add a lot"}
      description="One physical container or batch — the bottle you opened, the box with a date on it."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={draft.label.trim() === ""}
            onClick={() =>
              call.run({
                partId,
                lotId: draft.lotId ?? null,
                label: draft.label,
                storagePlaceId: draft.storagePlaceId === "" ? null : draft.storagePlaceId,
                purchasedOn: draft.purchasedOn === "" ? null : draft.purchasedOn,
                expiresOn: draft.expiresOn === "" ? null : draft.expiresOn,
                openedOn: draft.openedOn === "" ? null : draft.openedOn,
                initialQtyMilli: parseQuantityToMilli(draft.initialQty),
                isOpen: draft.isOpen,
                notes: draft.notes,
              })
            }
          >
            {editing ? "Save the lot" : "Add the lot"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Label"
          required
          help="How you would point at it: “5 l can, opened March”."
          error={fieldError("label")}
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-errormessage={errorId}
              value={draft.label}
              onChange={(event) => set("label", event.target.value)}
              autoFocus
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Bought on"
            error={fieldError("purchasedOn")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                type="date"
                value={draft.purchasedOn}
                onChange={(event) => set("purchasedOn", event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Expires on"
            error={fieldError("expiresOn")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                type="date"
                value={draft.expiresOn}
                onChange={(event) => set("expiresOn", event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Opened on"
            error={fieldError("openedOn")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                type="date"
                value={draft.openedOn}
                onChange={(event) => set("openedOn", event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field
          label="Full size of the container"
          required={needsInitialQty}
          help={
            needsInitialQty
              ? `Required for an estimated item: “40 % left” needs to know 40 % of what. In ${unit}.`
              : `Optional. In ${unit}.`
          }
          error={fieldError("initialQtyMilli")}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={draft.initialQty}
              onChange={(event) => set("initialQty", event.target.value)}
              inputMode="decimal"
              trailing={<span className="text-xs text-ink-3">{unit}</span>}
            />
          )}
        </Field>

        {storagePlaces.length === 0 ? null : (
          <Field
            label="Where this one is kept"
            error={fieldError("storagePlaceId")}
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                value={draft.storagePlaceId === "" ? NO_PLACE : draft.storagePlaceId}
                onValueChange={(value) =>
                  set("storagePlaceId", value === NO_PLACE ? "" : value)
                }
                options={[{ value: NO_PLACE, label: "The item's usual place" }, ...storagePlaces]}
              />
            )}
          </Field>
        )}

        <Checkbox
          checked={draft.isOpen}
          onCheckedChange={(checked) => set("isOpen", checked === true)}
          label="This one is open"
          hint="An open lot is used first, and it is the one the estimate applies to."
        />

        <Field
          label="Note"
          error={fieldError("notes")}
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-errormessage={errorId}
              rows={2}
              value={draft.notes}
              onChange={(event) => set("notes", event.target.value)}
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

/* -------------------------------------------------------------------------------- suppliers */

export function SupplierDialog({
  partId,
  unit,
  initial,
  triggerLabel,
}: {
  partId: string;
  unit: PartUnit;
  initial: SupplierDraft;
  triggerLabel: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initial);
  const editing = initial.supplierId !== undefined;

  const price = readPrice(draft.lastPrice);

  const call = useAction(upsertSupplier, {
    successTitle: editing ? "Supplier saved" : "Supplier added",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const fieldError = (name: string): string | undefined => call.fieldErrors[name]?.[0];

  const set = <K extends keyof SupplierDraft>(key: K, value: SupplierDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        editing ? (
          <IconButton
            label={triggerLabel}
            variant="ghost"
            size="sm"
            icon={<Pencil aria-hidden="true" />}
          />
        ) : (
          <Button variant="secondary" size="sm" icon={<Plus aria-hidden="true" />}>
            {triggerLabel}
          </Button>
        )
      }
      title={editing ? "Edit this supplier" : "Add a supplier"}
      description="Where you buy it. This groups the shopping list and gives you a link to click."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={draft.supplierName.trim() === "" || price.error !== null}
            onClick={() =>
              call.run({
                partId,
                supplierId: draft.supplierId ?? null,
                supplierName: draft.supplierName,
                supplierSku: draft.supplierSku,
                url: draft.url,
                lastPriceCents: price.cents,
                currency: draft.currency === "" ? null : draft.currency.toUpperCase(),
                packQtyMilli: parseQuantityToMilli(draft.packQty),
                leadTimeDays:
                  draft.leadTimeDays === "" ? null : Number.parseInt(draft.leadTimeDays, 10),
                isPreferred: draft.isPreferred,
                note: draft.note,
              })
            }
          >
            {editing ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Supplier"
            required
            error={fieldError("supplierName")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={draft.supplierName}
                onChange={(event) => set("supplierName", event.target.value)}
                autoFocus
              />
            )}
          </Field>
          <Field
            label="Their article number"
            error={fieldError("supplierSku")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                className="font-mono"
                value={draft.supplierSku}
                onChange={(event) => set("supplierSku", event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field label="Link" error={fieldError("url")}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="url"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={draft.url}
              onChange={(event) => set("url", event.target.value)}
              placeholder="https://…"
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Last price paid" help="Per unit." error={price.error ?? undefined}>
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={draft.lastPrice}
                onChange={(event) => set("lastPrice", event.target.value)}
                inputMode="decimal"
                placeholder="12,90"
              />
            )}
          </Field>
          <Field
            label="Currency"
            error={fieldError("currency")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={draft.currency}
                onChange={(event) => set("currency", event.target.value)}
                maxLength={3}
                className="font-mono uppercase"
              />
            )}
          </Field>
          <Field
            label="Pack size"
            help={`How much comes in one pack, in ${unit}.`}
            error={fieldError("packQtyMilli")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={draft.packQty}
                onChange={(event) => set("packQty", event.target.value)}
                inputMode="decimal"
              />
            )}
          </Field>
        </div>

        <Field
          label="Lead time"
          help="Days from ordering to holding it."
          error={fieldError("leadTimeDays")}
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-errormessage={errorId}
              value={draft.leadTimeDays}
              onChange={(event) => set("leadTimeDays", event.target.value)}
              inputMode="numeric"
              trailing={<span className="text-xs text-ink-3">days</span>}
            />
          )}
        </Field>

        <Checkbox
          checked={draft.isPreferred}
          onCheckedChange={(checked) => set("isPreferred", checked === true)}
          label="This is where I usually buy it"
          hint="One per item. Setting this moves the previous preferred supplier aside in the same step."
        />

        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function RemoveSupplierButton({
  partId,
  supplierId,
  supplierName,
}: {
  partId: string;
  supplierId: string;
  supplierName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const call = useAction(removeSupplier, {
    successTitle: "Supplier removed",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  // Confirmed, like every other destructive control here: one tap used to take the URL, the SKU,
  // the last price and the pack size with it, with nothing to undo it.
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <IconButton
          label={`Remove ${supplierName}`}
          variant="ghost"
          size="sm"
          icon={<Trash2 aria-hidden="true" />}
        />
      }
      title={`Remove ${supplierName}?`}
      description="Its link, order code, pack size and last known price go with it. Past purchases already recorded in the ledger are not affected."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={call.pending}
            onClick={() => call.run({ partId, supplierId })}
          >
            Remove it
          </Button>
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------------------ kit contents */

export function KitContentsDialog({
  partId,
  componentOptions,
  initial,
}: {
  partId: string;
  componentOptions: readonly { value: string; label: string; hint?: string }[];
  initial: readonly { componentPartId: string; qty: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ componentPartId: string; qty: string }[]>([...initial]);

  const call = useAction(setKitComponents, {
    successTitle: "Kit contents saved",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  // The save replaces the whole list, so a row that cannot be read has to block it. Filtering the
  // row out instead deleted a component and said "Kit contents saved".
  const rowErrors = rows.map((row) => ({
    part: row.componentPartId === "" ? "Choose a part." : null,
    qty: readRowQuantity(row.qty).error,
  }));
  const incomplete = rowErrors.some((entry) => entry.part !== null || entry.qty !== null);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="secondary" size="sm" icon={<Pencil aria-hidden="true" />}>
          Edit contents
        </Button>
      }
      title="What is in this kit"
      description="A parts list, not an availability sum: it says what arrives on the component items when you open a box."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={incomplete}
            onClick={() =>
              call.run({
                partId,
                components: rows.flatMap((row) => {
                  const { qtyMilli } = readRowQuantity(row.qty);
                  if (row.componentPartId === "" || qtyMilli === null) return [];
                  return [{ componentPartId: row.componentPartId, qtyMilli }];
                }),
              })
            }
          >
            Save the contents
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-3">
            Nothing listed. A kit with no contents cannot be opened.
          </p>
        ) : null}
        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <Field
              label="Part"
              className="min-w-44 flex-1"
              hideLabel={index > 0}
              error={rowErrors[index]?.part ?? undefined}
            >
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  describedBy={describedBy}
                  invalid={invalid}
                  ariaLabel="Part in the kit"
                  value={row.componentPartId}
                  onValueChange={(value) =>
                    setRows((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, componentPartId: value } : entry,
                      ),
                    )
                  }
                  placeholder="Choose a part…"
                  options={componentOptions}
                />
              )}
            </Field>
            <Field
              label="How many"
              className="w-24"
              hideLabel={index > 0}
              error={rowErrors[index]?.qty ?? undefined}
            >
              {({ id, describedBy, invalid, errorId }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  aria-errormessage={errorId}
                  aria-label="How many are in the kit"
                  value={row.qty}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, qty: event.target.value } : entry,
                      ),
                    )
                  }
                  inputMode="decimal"
                />
              )}
            </Field>
            <IconButton
              label="Remove this part"
              variant="ghost"
              icon={<Trash2 aria-hidden="true" />}
              onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
            />
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Plus aria-hidden="true" />}
          onClick={() => setRows((current) => [...current, { componentPartId: "", qty: "1" }])}
        >
          Add a part
        </Button>
        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------------------ archive */

export function ArchiveToggle({
  partId,
  partName,
  archived,
}: {
  partId: string;
  partName: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const call = useAction(setPartArchived, {
    successTitle: archived ? "Item restored" : "Item archived",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  if (archived) {
    return (
      <Button variant="secondary" size="sm" loading={call.pending} onClick={() => call.run({ partId, archived: false })}>
        Restore this item
      </Button>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="sm">
          Archive this item
        </Button>
      }
      title={`Archive ${partName}?`}
      description="It disappears from the list and the shopping list. Its ledger and its history stay exactly as they are, and you can restore it at any time."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button variant="danger" loading={call.pending} onClick={() => call.run({ partId, archived: true })}>
            Archive it
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-ink-2">
        Nothing is deleted. Archiving says &ldquo;we do not keep this any more&rdquo;, which is a
        different statement from &ldquo;this never existed&rdquo; — and past tasks that consumed it
        still make sense afterwards.
      </p>
      {call.error === null ? null : (
        <p role="alert" className="mt-3 text-sm font-medium text-overdue">
          {call.error}
        </p>
      )}
    </Dialog>
  );
}
