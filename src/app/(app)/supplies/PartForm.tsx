"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Input,
  Panel,
  Select,
  Textarea,
} from "@/ui";
import { PART_TRACKING_MODES, PART_UNITS, type PartTrackingMode, type PartUnit } from "@/db/schema";
import {
  KIT_RULE_DETAIL,
  KIT_RULE_TEXT,
} from "@/features/inventory/labels";
import {
  MILLI,
  TRACKING_MODE_HELP,
  TRACKING_MODE_LABEL,
  formatMilli,
  parseQuantityToMilli,
  readRowQuantity,
} from "@/features/inventory/units";
import { useAction } from "@/features/settings/actionClient";
import { createPart, updatePart } from "@/server/actions/inventory/parts";

export interface PartFormOption {
  value: string;
  label: string;
  hint?: string;
}

export interface PartFormInitial {
  partId?: string;
  name: string;
  spec: string;
  dimensions: string;
  manufacturer: string;
  productCode: string;
  ean: string;
  trackingMode: PartTrackingMode;
  unit: PartUnit;
  isKit: boolean;
  stocked: boolean;
  reorderThreshold: string;
  reorderTarget: string;
  leadTimeDays: string;
  defaultStoragePlaceId: string;
  tracksLots: boolean;
  notes: string;
  components: { componentPartId: string; qty: string }[];
}

/**
 * Radix's `Select.Item` refuses an empty string value, so "nothing chosen" needs a sentinel. It is
 * mapped back to `""` the moment it leaves the control, so nothing downstream sees it.
 */
const NO_PLACE = "__none";

export const EMPTY_PART: PartFormInitial = {
  name: "",
  spec: "",
  dimensions: "",
  manufacturer: "",
  productCode: "",
  ean: "",
  trackingMode: "discrete",
  unit: "pcs",
  isKit: false,
  stocked: true,
  reorderThreshold: "",
  reorderTarget: "",
  leadTimeDays: "",
  defaultStoragePlaceId: "",
  tracksLots: false,
  notes: "",
  components: [],
};

/**
 * The part form, used both for a new item and for editing an existing one.
 *
 * Two things it takes trouble over:
 *  - **The kit rule is explained where kits are created**, not in a help page. Ticking "this is a
 *    kit" reveals the sentence and the parts list, because that is the moment somebody forms a
 *    mental model of how counting works.
 *  - **Amounts are typed in units, stored in thousandths.** The field shows `0.75`, the action
 *    receives `750`, and a comma is accepted because a Finnish keyboard produces one.
 */
export function PartForm({
  initial,
  storagePlaces,
  componentOptions,
  assetOptions,
}: {
  initial: PartFormInitial;
  storagePlaces: readonly PartFormOption[];
  componentOptions: readonly PartFormOption[];
  assetOptions: readonly PartFormOption[];
}) {
  const router = useRouter();
  const editing = initial.partId !== undefined;
  const [form, setForm] = useState<PartFormInitial>(initial);
  const [compatibility, setCompatibility] = useState<
    { assetId: string; confidence: "confirmed" | "likely" | "unverified" }[]
  >([]);
  const [supplier, setSupplier] = useState({ supplierName: "", supplierSku: "", url: "" });

  const create = useAction(createPart, {
    successTitle: "Item added",
    onSuccess: (data) => router.push(`/supplies/${data.partId}`),
  });
  const update = useAction(updatePart, {
    successTitle: "Item saved",
    onSuccess: () => router.refresh(),
  });
  const call = editing ? update : create;

  const set = <K extends keyof PartFormInitial>(key: K, value: PartFormInitial[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  // The kit's contents are saved with the item, as one list. A row that cannot be read has to
  // block the save rather than be filtered out of it: dropping it created the kit without that
  // part and said "Item added".
  const componentErrors = form.components.map((row) => ({
    part: row.componentPartId === "" ? "Choose a part." : null,
    qty: readRowQuantity(row.qty).error,
  }));
  const componentsIncomplete =
    form.isKit &&
    !editing &&
    componentErrors.some((entry) => entry.part !== null || entry.qty !== null);

  const submit = (): void => {
    if (componentsIncomplete) return;
    const base = {
      name: form.name,
      spec: form.spec,
      dimensions: form.dimensions,
      manufacturer: form.manufacturer,
      productCode: form.productCode,
      ean: form.ean,
      trackingMode: form.trackingMode,
      unit: form.unit,
      isKit: form.isKit,
      stocked: form.stocked,
      reorderThresholdMilli: parseQuantityToMilli(form.reorderThreshold),
      reorderTargetMilli: parseQuantityToMilli(form.reorderTarget),
      leadTimeDays: form.leadTimeDays === "" ? null : Number.parseInt(form.leadTimeDays, 10),
      defaultStoragePlaceId:
        form.defaultStoragePlaceId === "" ? null : form.defaultStoragePlaceId,
      tracksLots: form.tracksLots,
      notes: form.notes,
    };

    if (editing) {
      update.run({ ...base, partId: initial.partId! });
      return;
    }

    create.run({
      ...base,
      idempotencyKey: create.idempotencyKey,
      components: form.components.flatMap((row) => {
        const { qtyMilli } = readRowQuantity(row.qty);
        if (row.componentPartId === "" || qtyMilli === null) return [];
        return [{ componentPartId: row.componentPartId, qtyMilli }];
      }),
      suppliers:
        supplier.supplierName.trim() === ""
          ? []
          : [
              {
                supplierName: supplier.supplierName,
                supplierSku: supplier.supplierSku,
                url: supplier.url,
                isPreferred: true,
              },
            ],
      compatibility: compatibility
        .filter((row) => row.assetId !== "")
        .map((row) => ({ assetId: row.assetId, confidence: row.confidence })),
    });
  };

  const fieldError = (name: string): string | undefined => call.fieldErrors[name]?.[0];

  return (
    <form data-unsaved
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Panel title="What it is">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            required
            error={fieldError("name")}
            help="What you would say out loud: “HEPA filter, kitchen hood”."
            className="sm:col-span-2"
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                required
                autoComplete="off"
              />
            )}
          </Field>

          <Field
            label="Specification"
            help="Size, grade, class — whatever decides whether it fits."
            error={fieldError("spec")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={form.spec}
                onChange={(event) => set("spec", event.target.value)}
                placeholder="F7, 200×200×46 mm"
              />
            )}
          </Field>

          <Field
            label="Dimensions"
            error={fieldError("dimensions")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={form.dimensions}
                onChange={(event) => set("dimensions", event.target.value)}
                placeholder="200 × 200 × 46 mm"
              />
            )}
          </Field>

          <Field
            label="Manufacturer"
            error={fieldError("manufacturer")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={form.manufacturer}
                onChange={(event) => set("manufacturer", event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Product code"
            help="With the manufacturer this must be unique, so the same part is never entered twice."
            error={fieldError("productCode")}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={form.productCode}
                onChange={(event) => set("productCode", event.target.value)}
                className="font-mono"
              />
            )}
          </Field>

          <Field
            label="Barcode (EAN)"
            error={fieldError("ean")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={form.ean}
                onChange={(event) => set("ean", event.target.value)}
                inputMode="numeric"
                className="font-mono"
              />
            )}
          </Field>

          <Field
            label="Where it lives"
            help="The shelf or bin it is normally kept on."
            error={fieldError("defaultStoragePlaceId")}
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                value={form.defaultStoragePlaceId === "" ? NO_PLACE : form.defaultStoragePlaceId}
                onValueChange={(value) =>
                  set("defaultStoragePlaceId", value === NO_PLACE ? "" : value)
                }
                options={[{ value: NO_PLACE, label: "No fixed place" }, ...storagePlaces]}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="How it is counted">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Counting"
            required
            help={TRACKING_MODE_HELP[form.trackingMode]}
            error={fieldError("trackingMode")}
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                invalid={invalid}
                describedBy={describedBy}
                value={form.trackingMode}
                onValueChange={(value) => set("trackingMode", value as PartTrackingMode)}
                options={PART_TRACKING_MODES.map((mode) => ({
                  value: mode,
                  label: TRACKING_MODE_LABEL[mode],
                  hint: TRACKING_MODE_HELP[mode],
                }))}
              />
            )}
          </Field>

          <Field
            label="Unit"
            required
            help="The unit you buy and store it in."
            error={fieldError("unit")}
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                value={form.unit}
                onValueChange={(value) => set("unit", value as PartUnit)}
                options={PART_UNITS.map((unit) => ({ value: unit, label: unit }))}
              />
            )}
          </Field>

          <Field
            label="Reorder threshold"
            help={`Below this, the item shows as “to buy”. In ${form.unit}.`}
            error={fieldError("reorderThresholdMilli")}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={form.reorderThreshold}
                onChange={(event) => set("reorderThreshold", event.target.value)}
                inputMode="decimal"
                placeholder="1"
                trailing={<span className="text-xs text-ink-3">{form.unit}</span>}
              />
            )}
          </Field>

          <Field
            label="Reorder target"
            help="How much to have after buying. Must be at least the threshold."
            error={fieldError("reorderTargetMilli")}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={form.reorderTarget}
                onChange={(event) => set("reorderTarget", event.target.value)}
                inputMode="decimal"
                placeholder="2"
                trailing={<span className="text-xs text-ink-3">{form.unit}</span>}
              />
            )}
          </Field>

          <Field
            label="Lead time"
            help="Days between ordering and having it in your hand. Shown on the shopping list."
            error={fieldError("leadTimeDays")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={form.leadTimeDays}
                onChange={(event) => set("leadTimeDays", event.target.value)}
                inputMode="numeric"
                placeholder="7"
                trailing={<span className="text-xs text-ink-3">days</span>}
              />
            )}
          </Field>

          <div className="flex flex-col gap-3 sm:col-span-2">
            <Checkbox
              checked={form.tracksLots}
              onCheckedChange={(checked) => set("tracksLots", checked === true)}
              label="Track individual lots"
              hint="Turn on for anything with an expiry date or an opened/unopened distinction. Required for the estimate dial."
            />
            <Checkbox
              checked={form.isKit}
              disabled={editing}
              onCheckedChange={(checked) => set("isKit", checked === true)}
              label="This is a kit — one box containing several parts"
              hint={
                editing
                  ? "This cannot be changed later: the movements already recorded mean different things on each side of that line."
                  : KIT_RULE_TEXT
              }
            />
          </div>
        </div>
      </Panel>

      {form.isKit ? (
        <Panel title="What is in the kit" subtitle={KIT_RULE_TEXT}>
          <p className="mb-4 max-w-prose text-sm leading-6 text-ink-2">{KIT_RULE_DETAIL}</p>

          <Checkbox
            checked={!form.stocked}
            onCheckedChange={(checked) => set("stocked", checked !== true)}
            label="I never buy this as a box — it is only a parts list"
            hint="Tick this for a kit that exists only to describe what belongs together. It will never carry stock and will never appear on the shopping list."
            className="mb-4"
          />

          {editing ? (
            <p className="text-sm text-ink-3">
              The contents of an existing kit are edited from the item page, so a change is one
              audited step rather than part of a larger save.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {form.components.length === 0 ? (
                <p className="text-sm text-ink-3">
                  No contents listed yet. A kit with no contents cannot be opened.
                </p>
              ) : null}
              {form.components.map((row, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <Field
                    label="Part"
                    className="min-w-48 flex-1"
                    hideLabel={index > 0}
                    error={componentErrors[index]?.part ?? undefined}
                  >
                    {({ id, describedBy, invalid }) => (
                      <Select
                        id={id}
                        describedBy={describedBy}
                        invalid={invalid}
                        ariaLabel="Part in the kit"
                        value={row.componentPartId}
                        onValueChange={(value) =>
                          setForm((current) => ({
                            ...current,
                            components: current.components.map((entry, i) =>
                              i === index ? { ...entry, componentPartId: value } : entry,
                            ),
                          }))
                        }
                        placeholder="Choose a part…"
                        options={componentOptions}
                      />
                    )}
                  </Field>
                  <Field
                    label="How many"
                    className="w-28"
                    hideLabel={index > 0}
                    error={componentErrors[index]?.qty ?? undefined}
                  >
                    {({ id, describedBy, invalid, errorId }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        aria-invalid={invalid || undefined}
                        aria-errormessage={errorId}
                        aria-label="How many of this part are in the kit"
                        value={row.qty}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            components: current.components.map((entry, i) =>
                              i === index ? { ...entry, qty: event.target.value } : entry,
                            ),
                          }))
                        }
                        inputMode="decimal"
                      />
                    )}
                  </Field>
                  <IconButton
                    label="Remove this part"
                    variant="ghost"
                    icon={<Trash2 aria-hidden="true" />}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        components: current.components.filter((_, i) => i !== index),
                      }))
                    }
                  />
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Plus aria-hidden="true" />}
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    components: [...current.components, { componentPartId: "", qty: "1" }],
                  }))
                }
              >
                Add a part
              </Button>
            </div>
          )}
        </Panel>
      ) : null}

      {editing ? null : (
        <Panel
          title="Where you buy it"
          subtitle="Optional. It groups the shopping list and gives you a link to click."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Supplier">
              {({ id }) => (
                <Input
                  id={id}
                  value={supplier.supplierName}
                  onChange={(event) =>
                    setSupplier((current) => ({ ...current, supplierName: event.target.value }))
                  }
                  placeholder="Motonet"
                />
              )}
            </Field>
            <Field label="Their article number">
              {({ id }) => (
                <Input
                  id={id}
                  value={supplier.supplierSku}
                  onChange={(event) =>
                    setSupplier((current) => ({ ...current, supplierSku: event.target.value }))
                  }
                  className="font-mono"
                />
              )}
            </Field>
            <Field label="Link" error={fieldError("suppliers")}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="url"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={supplier.url}
                  onChange={(event) =>
                    setSupplier((current) => ({ ...current, url: event.target.value }))
                  }
                  placeholder="https://…"
                />
              )}
            </Field>
          </div>
        </Panel>
      )}

      {editing || assetOptions.length === 0 ? null : (
        <Panel
          title="What it fits"
          subtitle="So the filter in your hand traces back to a room, and a task can pre-fill its materials."
        >
          <div className="flex flex-col gap-3">
            {compatibility.map((row, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <Field label="Equipment" className="min-w-48 flex-1" hideLabel={index > 0}>
                  {({ id }) => (
                    <Select
                      id={id}
                      ariaLabel="Equipment this part fits"
                      value={row.assetId}
                      onValueChange={(value) =>
                        setCompatibility((current) =>
                          current.map((entry, i) => (i === index ? { ...entry, assetId: value } : entry)),
                        )
                      }
                      placeholder="Choose equipment…"
                      options={assetOptions}
                    />
                  )}
                </Field>
                <Field label="How sure" className="w-44" hideLabel={index > 0}>
                  {({ id }) => (
                    <Select
                      id={id}
                      ariaLabel="How sure this part fits"
                      value={row.confidence}
                      onValueChange={(value) =>
                        setCompatibility((current) =>
                          current.map((entry, i) =>
                            i === index
                              ? {
                                  ...entry,
                                  confidence: value as "confirmed" | "likely" | "unverified",
                                }
                              : entry,
                          ),
                        )
                      }
                      options={[
                        { value: "confirmed", label: "Confirmed", hint: "It has been fitted." },
                        { value: "likely", label: "Likely", hint: "The specification matches." },
                        {
                          value: "unverified",
                          label: "Unverified",
                          hint: "A guess worth recording.",
                        },
                      ]}
                    />
                  )}
                </Field>
                <IconButton
                  label="Remove this equipment"
                  variant="ghost"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() =>
                    setCompatibility((current) => current.filter((_, i) => i !== index))
                  }
                />
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<Plus aria-hidden="true" />}
              onClick={() =>
                setCompatibility((current) => [
                  ...current,
                  { assetId: "", confidence: "likely" as const },
                ])
              }
            >
              Add equipment
            </Button>
          </div>
        </Panel>
      )}

      <details open={editing || undefined}><summary className="cursor-pointer py-2 font-medium">Notes (optional)</summary><Panel title="Notes">
        <Field
          label="Anything worth remembering"
          hideLabel
          error={fieldError("notes")}
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-errormessage={errorId}
              aria-label="Notes about this item"
              value={form.notes}
              onChange={(event) => set("notes", event.target.value)}
              rows={4}
              placeholder="“The 46 mm depth is the one that fits; the 25 mm rattles.”"
            />
          )}
        </Field>
      </Panel></details>

      {call.error === null ? null : (
        <p role="alert" className="text-sm font-medium text-overdue">
          {call.error}
        </p>
      )}

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-line bg-surface/95 py-3 backdrop-blur">
        <Button type="submit" loading={call.pending} disabled={componentsIncomplete}>
          {editing ? "Save changes" : "Add the item"}
        </Button>
        <Button data-discard-editor type="button" variant="ghost" onClick={() => router.back()} disabled={call.pending}>
          Cancel
        </Button>
        <span className="text-xs text-ink-3">
          Adding an item does not add stock. Record a purchase or a stock take for that.
        </span>
      </div>

      {form.reorderThreshold === "" ? null : (
        <p className="vh-tnum text-xs text-ink-3">
          Stored as {formatMilli(parseQuantityToMilli(form.reorderThreshold) ?? 0, form.unit)}{" "}
          {form.unit} ({parseQuantityToMilli(form.reorderThreshold) ?? 0} thousandths of a{" "}
          {form.unit}; {MILLI} = 1).
        </p>
      )}
    </form>
  );
}
