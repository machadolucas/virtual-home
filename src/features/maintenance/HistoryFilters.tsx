"use client";
/**
 * History filters.
 *
 * The filter state lives in the URL, not in component state (`docs/ux.md` §4, `DataTable`): a
 * filtered view is then shareable between the two household members and survives a reload.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { Filter, RotateCcw } from "lucide-react";
import { Button, Checkbox, Field, Input, Select } from "@/ui";
import { HISTORY_TYPES, HISTORY_TYPE_LABEL, type HistoryType } from "./historyTypes";

export interface HistoryFiltersProps {
  targets: readonly { value: string; label: string; hint: string }[];
  from: string | null;
  to: string | null;
  target: string | null;
  types: readonly HistoryType[];
}

const ALL_TARGETS = "__all__";

export function HistoryFilters({ targets, from, to, target, types }: HistoryFiltersProps) {
  const router = useRouter();
  const params = useSearchParams();

  function apply(next: {
    from?: string | null;
    to?: string | null;
    target?: string | null;
    types?: readonly HistoryType[];
  }): void {
    const query = new URLSearchParams(params.toString());
    if (next.from !== undefined) setOrDelete(query, "from", next.from);
    if (next.to !== undefined) setOrDelete(query, "to", next.to);
    if (next.target !== undefined) setOrDelete(query, "target", next.target);
    if (next.types !== undefined) {
      query.delete("type");
      for (const type of next.types) query.append("type", type);
    }
    router.replace(`/history${query.toString() === "" ? "" : `?${query.toString()}`}`);
  }

  function toggleType(type: HistoryType): void {
    const has = types.includes(type);
    const next = has ? types.filter((entry) => entry !== type) : [...types, type];
    // An empty selection would silently mean "the defaults", which is confusing; keep one on.
    apply({ types: next.length === 0 ? [type] : next });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-panel">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-3">
        <Filter aria-hidden="true" className="size-3.5" />
        Filters
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From">
          {({ id }) => (
            <Input
              id={id}
              type="date"
              value={from ?? ""}
              onChange={(event) => apply({ from: event.target.value === "" ? null : event.target.value })}
            />
          )}
        </Field>
        <Field label="To">
          {({ id }) => (
            <Input
              id={id}
              type="date"
              value={to ?? ""}
              onChange={(event) => apply({ to: event.target.value === "" ? null : event.target.value })}
            />
          )}
        </Field>
        <Field label="Target">
          {({ id }) => (
            <Select
              id={id}
              value={target ?? ALL_TARGETS}
              onValueChange={(value) => apply({ target: value === ALL_TARGETS ? null : value })}
              options={[
                { value: ALL_TARGETS, label: "Everything" },
                ...targets.map((option) => ({
                  value: option.value,
                  label: option.label,
                  hint: option.hint,
                })),
              ]}
            />
          )}
        </Field>
      </div>
      <fieldset>
        <legend className="text-xs font-medium text-ink-2">What to show</legend>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          {HISTORY_TYPES.map((type) => (
            <Checkbox
              key={type}
              checked={types.includes(type)}
              onCheckedChange={() => toggleType(type)}
              label={HISTORY_TYPE_LABEL[type]}
            />
          ))}
        </div>
      </fieldset>
      <div>
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw aria-hidden="true" />}
          onClick={() => router.replace("/history")}
        >
          Clear filters
        </Button>
      </div>
    </div>
  );
}

function setOrDelete(params: URLSearchParams, key: string, value: string | null): void {
  if (value === null || value === "") params.delete(key);
  else params.set(key, value);
}
