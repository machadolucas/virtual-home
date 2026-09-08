"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { CONSUMABLE_ROLES, type ConsumableRole } from "@/db/schema";
import { Button, Dialog, Field, IconButton, Input, Select } from "@/ui";
import { CONSUMABLE_ROLE_LABEL } from "@/features/assets/labels";
import { parseQuantityToMilli } from "@/features/inventory/units";
import { useAction } from "@/features/settings/actionClient";
import { setConsumables } from "@/server/actions/assets/equipment";

export interface ConsumableRowDraft {
  partId: string;
  role: ConsumableRole;
  qty: string;
}

/**
 * Edit what a unit consumes.
 *
 * This is the table that makes a completion form able to say "2 × AAA" without anybody typing it,
 * and the table that puts a filter on the shopping list before the task is due. The whole set is
 * posted at once, because a diff between what the browser thinks and what the database holds is a
 * second source of truth nobody asked for.
 */
export function ConsumablesEditor({
  assetId,
  initial,
  partOptions,
}: {
  assetId: string;
  initial: readonly ConsumableRowDraft[];
  partOptions: readonly { value: string; label: string; hint?: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ConsumableRowDraft[]>([...initial]);

  const call = useAction(setConsumables, {
    successTitle: "Consumables saved",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="lg"
      trigger={
        <Button variant="secondary" size="sm" icon={<Pencil aria-hidden="true" />}>
          Edit consumables
        </Button>
      }
      title="What this unit consumes"
      description="Batteries, filters, bags, belts, lamps, fluid. A task on this unit pre-fills these lines, and the shopping list counts them as demand."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            onClick={() =>
              call.run({
                assetId,
                consumables: rows.flatMap((row) => {
                  const qtyMilli = parseQuantityToMilli(row.qty);
                  if (row.partId === "" || qtyMilli === null || qtyMilli <= 0) return [];
                  return [{ partId: row.partId, role: row.role, qtyMilli }];
                }),
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {partOptions.length === 0 ? (
          <p className="text-sm leading-6 text-ink-2">
            No supplies are tracked yet, so there is nothing to pick. Add the item under Supplies
            first.
          </p>
        ) : null}

        {rows.length === 0 && partOptions.length > 0 ? (
          <p className="text-sm text-ink-3">Nothing listed yet.</p>
        ) : null}

        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <Field label="Item" className="min-w-44 flex-1" hideLabel={index > 0}>
              {({ id }) => (
                <Select
                  id={id}
                  ariaLabel="Item this unit consumes"
                  value={row.partId}
                  onValueChange={(value) =>
                    setRows((current) =>
                      current.map((entry, i) => (i === index ? { ...entry, partId: value } : entry)),
                    )
                  }
                  placeholder="Choose an item…"
                  options={partOptions}
                />
              )}
            </Field>
            <Field label="As" className="w-40" hideLabel={index > 0}>
              {({ id }) => (
                <Select
                  id={id}
                  ariaLabel="What role it plays"
                  value={row.role}
                  onValueChange={(value) =>
                    setRows((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, role: value as ConsumableRole } : entry,
                      ),
                    )
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
                  value={row.qty}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, qty: event.target.value } : entry,
                      ),
                    )
                  }
                />
              )}
            </Field>
            <IconButton
              label="Remove this line"
              variant="ghost"
              icon={<Trash2 aria-hidden="true" />}
              onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
            />
          </div>
        ))}

        {partOptions.length === 0 ? null : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<Plus aria-hidden="true" />}
            onClick={() =>
              setRows((current) => [
                ...current,
                { partId: "", role: "battery" as ConsumableRole, qty: "1" },
              ])
            }
          >
            Add a line
          </Button>
        )}

        <p className="text-xs leading-5 text-ink-3">
          One line per item and role: the same battery can be listed once as a battery, and that is
          all the uniqueness rule allows.
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
