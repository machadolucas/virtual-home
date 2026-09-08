"use client";

import { useCallback, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { IconButton, Input, SegmentedControl } from "@/ui";
import { SUPPLY_FILTERS, SUPPLY_FILTER_LABEL, type SupplyFilter } from "@/features/inventory/labels";

/**
 * The filter row for `/supplies`.
 *
 * Filter and search live in the **URL**, not in component state: that is the rule `DataTable` is
 * built around, and it means a filtered list is a link you can send to the other member of the
 * household. The typing is debounced so every keystroke is not a navigation.
 */
export function SuppliesFilters({
  counts,
}: {
  counts: Record<SupplyFilter, number>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const currentFilter = (params.get("filter") ?? "low") as SupplyFilter;
  const currentQuery = params.get("q") ?? "";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const push = useCallback(
    (next: { filter?: string; q?: string }) => {
      const search = new URLSearchParams(params.toString());
      if (next.filter !== undefined) search.set("filter", next.filter);
      if (next.q !== undefined) {
        if (next.q === "") search.delete("q");
        else search.set("q", next.q);
      }
      const query = search.toString();
      router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
    },
    [params, pathname, router],
  );

  /**
   * Debounced, and driven from the event rather than from an effect: the input is uncontrolled
   * (`key` + `defaultValue`), so the URL is the single source of truth and there is no second copy
   * of the query to keep in step.
   */
  const onType = useCallback(
    (value: string) => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => push({ q: value }), 250);
    },
    [push],
  );

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <SegmentedControl
        ariaLabel="Filter supplies"
        value={currentFilter}
        onValueChange={(value) => push({ filter: value })}
        items={SUPPLY_FILTERS.map((filter) => ({
          value: filter,
          label:
            counts[filter] === 0
              ? SUPPLY_FILTER_LABEL[filter]
              : `${SUPPLY_FILTER_LABEL[filter]} (${counts[filter]})`,
        }))}
      />
      <label className="flex items-center gap-2 sm:w-72">
        <span className="sr-only">Search supplies</span>
        <Input
          // `key` remounts the field when the URL query changes from outside (the back button, a
          // link somebody sent), which is how an uncontrolled input stays honest.
          key={currentQuery}
          type="search"
          defaultValue={currentQuery}
          onChange={(event) => onType(event.target.value)}
          placeholder="Name, code, shelf, equipment…"
          icon={<Search aria-hidden="true" />}
          trailing={
            currentQuery === "" ? undefined : (
              <IconButton
                label="Clear search"
                variant="ghost"
                size="sm"
                icon={<X aria-hidden="true" />}
                onClick={() => {
                  if (timer.current !== null) clearTimeout(timer.current);
                  push({ q: "" });
                }}
              />
            )
          }
        />
      </label>
    </div>
  );
}
