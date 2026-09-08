"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  ASSET_CATEGORIES,
  CONSUMABLE_ROLES,
  DATE_PRECISIONS,
  type AssetCategory,
  type AssetStatus,
  type ConsumableRole,
  type DatePrecision,
} from "@/db/schema";
import { Button, Checkbox, Field, IconButton, Input, Panel, Select, Textarea } from "@/ui";
import { CATEGORY_LABEL, CONSUMABLE_ROLE_LABEL } from "@/features/assets/labels";
import { parseQuantityToMilli } from "@/features/inventory/units";
import { useAction } from "@/features/settings/actionClient";
import { createEquipment, updateEquipment } from "@/server/actions/assets/equipment";

const NONE = "__none";

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

export interface EquipmentFormInitial {
  assetId?: string;
  name: string;
  category: AssetCategory;
  manufacturer: string;
  modelName: string;
  serialNumber: string;
  productCode: string;
  locationId: string;
  parentAssetId: string;
  isVirtual: boolean;
  status: AssetStatus;
  installedOn: string;
  installedOnPrecision: DatePrecision | "";
  purchasePrice: string;
  currency: string;
  warrantyUntil: string;
  expectedLifeYears: string;
  notes: string;
  consumables: { partId: string; role: ConsumableRole; qty: string }[];
  systemIds: string[];
}

export const EMPTY_EQUIPMENT: EquipmentFormInitial = {
  name: "",
  category: "appliance",
  manufacturer: "",
  modelName: "",
  serialNumber: "",
  productCode: "",
  locationId: "",
  parentAssetId: "",
  isVirtual: false,
  status: "installed",
  installedOn: "",
  installedOnPrecision: "",
  purchasePrice: "",
  currency: "EUR",
  warrantyUntil: "",
  expectedLifeYears: "",
  notes: "",
  consumables: [],
  systemIds: [],
};

const DATE_PRECISION_LABEL: Record<DatePrecision, string> = {
  exact: "The exact day",
  month: "The month, not the day",
  year: "The year only",
  unknown: "Genuinely unknown",
};

/**
 * The equipment form, for a new unit and for editing one.
 *
 * Two things it is deliberate about:
 *  - **The install date carries its own precision.** "Some time in 2019" is real information and
 *    is different from "12 March 2019"; forcing a made-up day would be fabricating history
 *    (CLAUDE.md rule 6), so the precision is a field rather than a guess.
 *  - **There is no separate "where to find it" field**, because there is no column for one. The
 *    notes field asks for both and says so; close-up photos live on the unit's page.
 */
export function EquipmentForm({
  initial,
  locations,
  parents,
  parts,
  systems,
}: {
  initial: EquipmentFormInitial;
  locations: readonly Option[];
  parents: readonly Option[];
  parts: readonly Option[];
  systems: readonly Option[];
}) {
  const router = useRouter();
  const editing = initial.assetId !== undefined;
  const [form, setForm] = useState<EquipmentFormInitial>(initial);

  const create = useAction(createEquipment, {
    successTitle: "Equipment added",
    onSuccess: (data) => router.push(`/equipment/${data.assetId}`),
  });
  const update = useAction(updateEquipment, {
    successTitle: "Equipment saved",
    onSuccess: () => router.refresh(),
  });
  const call = editing ? update : create;

  const set = <K extends keyof EquipmentFormInitial>(
    key: K,
    value: EquipmentFormInitial[K],
  ): void => setForm((current) => ({ ...current, [key]: value }));

  const submit = (): void => {
    const base = {
      name: form.name,
      category: form.category,
      manufacturer: form.manufacturer,
      modelName: form.modelName,
      serialNumber: form.serialNumber,
      productCode: form.productCode,
      locationId: form.locationId === "" ? null : form.locationId,
      parentAssetId: form.parentAssetId === "" ? null : form.parentAssetId,
      isVirtual: form.isVirtual,
      status: form.status,
      installedOn: form.installedOn === "" ? null : form.installedOn,
      installedOnPrecision:
        form.installedOnPrecision === "" ? null : form.installedOnPrecision,
      purchasePriceCents: parsePriceCents(form.purchasePrice),
      currency: form.currency === "" ? null : form.currency.toUpperCase(),
      warrantyUntil: form.warrantyUntil === "" ? null : form.warrantyUntil,
      expectedLifeYears:
        form.expectedLifeYears === "" ? null : Number.parseInt(form.expectedLifeYears, 10),
      notes: form.notes,
    };

    if (editing) {
      update.run({ ...base, assetId: initial.assetId! });
      return;
    }
    create.run({
      ...base,
      idempotencyKey: create.idempotencyKey,
      consumables: form.consumables.flatMap((line) => {
        const qtyMilli = parseQuantityToMilli(line.qty);
        if (line.partId === "" || qtyMilli === null || qtyMilli <= 0) return [];
        return [{ partId: line.partId, role: line.role, qtyMilli }];
      }),
      systemIds: form.systemIds,
      haEntityLinks: [],
    });
  };

  const fieldError = (name: string): string | undefined => call.fieldErrors[name]?.[0];

  return (
    <form
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
            help="What you would call it out loud: “Master bedroom smoke alarm”."
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
              />
            )}
          </Field>

          <Field label="Category" required>
            {({ id }) => (
              <Select
                id={id}
                value={form.category}
                onValueChange={(value) => set("category", value as AssetCategory)}
                options={ASSET_CATEGORIES.map((category) => ({
                  value: category,
                  label: CATEGORY_LABEL[category],
                }))}
              />
            )}
          </Field>

          <Field
            label="Where it is"
            help={
              form.isVirtual
                ? "A software unit has no room, so this is disabled."
                : "The room or zone. Leave unset for a spare in storage."
            }
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                disabled={form.isVirtual}
                value={form.locationId === "" ? NONE : form.locationId}
                onValueChange={(value) => set("locationId", value === NONE ? "" : value)}
                options={[{ value: NONE, label: "No location" }, ...locations]}
              />
            )}
          </Field>

          <Field label="Manufacturer">
            {({ id }) => (
              <Input
                id={id}
                value={form.manufacturer}
                onChange={(event) => set("manufacturer", event.target.value)}
              />
            )}
          </Field>

          <Field label="Model">
            {({ id }) => (
              <Input
                id={id}
                value={form.modelName}
                onChange={(event) => set("modelName", event.target.value)}
              />
            )}
          </Field>

          <Field label="Serial number" help="On the nameplate. Worth a photo as well.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                className="font-mono"
                value={form.serialNumber}
                onChange={(event) => set("serialNumber", event.target.value)}
              />
            )}
          </Field>

          <Field label="Product code">
            {({ id }) => (
              <Input
                id={id}
                className="font-mono"
                value={form.productCode}
                onChange={(event) => set("productCode", event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Part of"
            help="For a sub-component: the compressor inside the heat pump, the pump inside the boiler."
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={form.parentAssetId === "" ? NONE : form.parentAssetId}
                onValueChange={(value) => set("parentAssetId", value === NONE ? "" : value)}
                options={[{ value: NONE, label: "Nothing — it stands alone" }, ...parents]}
              />
            )}
          </Field>

          <div className="sm:col-span-2">
            <Checkbox
              checked={form.isVirtual}
              onCheckedChange={(checked) => {
                const next = checked === true;
                setForm((current) => ({
                  ...current,
                  isVirtual: next,
                  locationId: next ? "" : current.locationId,
                }));
              }}
              label="This is software, not hardware"
              hint="Home Assistant calls an integration a “device”. It is a real thing to maintain, but it is not in a room."
            />
          </div>
        </div>
      </Panel>

      <Panel title="Its history and its life">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Installed on" help="Leave empty if you do not know. Never guess a day.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="date"
                aria-describedby={describedBy}
                value={form.installedOn}
                onChange={(event) => set("installedOn", event.target.value)}
              />
            )}
          </Field>

          <Field
            label="How exact is that date"
            help="“Some time in 2019” is real information and is not the same as a made-up day."
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={form.installedOnPrecision === "" ? NONE : form.installedOnPrecision}
                onValueChange={(value) =>
                  set("installedOnPrecision", value === NONE ? "" : (value as DatePrecision))
                }
                options={[
                  { value: NONE, label: "Not stated" },
                  ...DATE_PRECISIONS.map((precision) => ({
                    value: precision,
                    label: DATE_PRECISION_LABEL[precision],
                  })),
                ]}
              />
            )}
          </Field>

          <Field label="Purchase price" help="Per unit, at purchase.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                inputMode="decimal"
                value={form.purchasePrice}
                onChange={(event) => set("purchasePrice", event.target.value)}
                trailing={<span className="text-xs text-ink-3">{form.currency || "EUR"}</span>}
              />
            )}
          </Field>

          <Field label="Currency">
            {({ id }) => (
              <Input
                id={id}
                maxLength={3}
                className="font-mono uppercase"
                value={form.currency}
                onChange={(event) => set("currency", event.target.value)}
              />
            )}
          </Field>

          <Field label="Warranty until">
            {({ id }) => (
              <Input
                id={id}
                type="date"
                value={form.warrantyUntil}
                onChange={(event) => set("warrantyUntil", event.target.value)}
              />
            )}
          </Field>

          <Field label="Expected life" help="Years. Used for planning, never to close a task.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                inputMode="numeric"
                value={form.expectedLifeYears}
                onChange={(event) => set("expectedLifeYears", event.target.value)}
                trailing={<span className="text-xs text-ink-3">years</span>}
              />
            )}
          </Field>
        </div>
      </Panel>

      {editing ? null : (
        <Panel
          title="What it consumes"
          subtitle="Batteries, filters, bags, belts, lamps, fluid. This is what pre-fills a task's materials and feeds the shopping list."
        >
          <div className="flex flex-col gap-3">
            {parts.length === 0 ? (
              <p className="text-sm text-ink-3">
                No supplies are tracked yet. Add the item under Supplies first, then come back — or
                add it here later.
              </p>
            ) : null}
            {form.consumables.map((line, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <Field label="Item" className="min-w-44 flex-1" hideLabel={index > 0}>
                  {({ id }) => (
                    <Select
                      id={id}
                      ariaLabel="Item this equipment consumes"
                      value={line.partId}
                      onValueChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          consumables: current.consumables.map((entry, i) =>
                            i === index ? { ...entry, partId: value } : entry,
                          ),
                        }))
                      }
                      placeholder="Choose an item…"
                      options={parts}
                    />
                  )}
                </Field>
                <Field label="As" className="w-40" hideLabel={index > 0}>
                  {({ id }) => (
                    <Select
                      id={id}
                      ariaLabel="What role it plays"
                      value={line.role}
                      onValueChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          consumables: current.consumables.map((entry, i) =>
                            i === index ? { ...entry, role: value as ConsumableRole } : entry,
                          ),
                        }))
                      }
                      options={CONSUMABLE_ROLES.map((role) => ({
                        value: role,
                        label: CONSUMABLE_ROLE_LABEL[role],
                      }))}
                    />
                  )}
                </Field>
                <Field label="How many" className="w-24" hideLabel={index > 0}>
                  {({ id }) => (
                    <Input
                      id={id}
                      aria-label="How many it takes"
                      inputMode="decimal"
                      value={line.qty}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          consumables: current.consumables.map((entry, i) =>
                            i === index ? { ...entry, qty: event.target.value } : entry,
                          ),
                        }))
                      }
                    />
                  )}
                </Field>
                <IconButton
                  label="Remove this line"
                  variant="ghost"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      consumables: current.consumables.filter((_, i) => i !== index),
                    }))
                  }
                />
              </div>
            ))}
            {parts.length === 0 ? null : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Plus aria-hidden="true" />}
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    consumables: [
                      ...current.consumables,
                      { partId: "", role: "battery" as ConsumableRole, qty: "1" },
                    ],
                  }))
                }
              >
                Add a consumable
              </Button>
            )}
          </div>
        </Panel>
      )}

      {editing || systems.length === 0 ? null : (
        <Panel
          title="Systems it belongs to"
          subtitle="A system spans rooms: ventilation, water, electrical, network."
        >
          <div className="flex flex-col gap-2">
            {systems.map((system) => (
              <Checkbox
                key={system.value}
                checked={form.systemIds.includes(system.value)}
                onCheckedChange={(checked) =>
                  setForm((current) => ({
                    ...current,
                    systemIds:
                      checked === true
                        ? [...current.systemIds, system.value]
                        : current.systemIds.filter((id) => id !== system.value),
                  }))
                }
                label={system.label}
                hint={system.hint}
              />
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Notes and how to find it">
        <Field
          label="Notes"
          hideLabel
          help="Include how to reach it: “behind the sauna wall panel, second screw from the left”. Close-up photos go on the unit's own page."
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-label="Notes about this unit and how to find it"
              aria-describedby={describedBy}
              rows={5}
              value={form.notes}
              onChange={(event) => set("notes", event.target.value)}
            />
          )}
        </Field>
      </Panel>

      {call.error === null ? null : (
        <p role="alert" className="text-sm font-medium text-overdue">
          {call.error} Nothing was saved.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={call.pending}>
          {editing ? "Save changes" : "Add the equipment"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={call.pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function parsePriceCents(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}
