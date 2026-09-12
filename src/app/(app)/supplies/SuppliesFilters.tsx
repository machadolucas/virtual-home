"use client";
import type { Route } from "next";

import { useCallback, useEffect, useRef, useState } from "react";
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

  // The box is **controlled**, and follows the URL only when the URL changed for a reason that is
  // not this box. It used to be uncontrolled with `key={currentQuery}`, which remounted it on this
  // component's own debounced push — stealing the caret 250 ms after every pause in typing. The
  // comment there argued the remount was what kept an uncontrolled input honest; it was the bug.
  const [draftQuery, setDraftQuery] = useState(currentQuery);
  const pushedQuery = useRef(currentQuery);

  useEffect(() => {
    if (currentQuery !== pushedQuery.current) {
      pushedQuery.current = currentQuery;
      setDraftQuery(currentQuery);
    }
  }, [currentQuery]);

  // A push that lands after this component is gone yanks the user back to a page they have left.
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const push = useCallback(
    (next: { filter?: string; q?: string }) => {
      const search = new URLSearchParams(params.toString());
      if (next.filter !== undefined) search.set("filter", next.filter);
      if (next.q !== undefined) {
        if (next.q === "") search.delete("q");
        else search.set("q", next.q);
      }
      if (next.q !== undefined) pushedQuery.current = next.q;
      const query = search.toString();
      router.replace((query === "" ? pathname : `${pathname}?${query}`) as Route, { scroll: false });
    },
    [params, pathname, router],
  );

  /** Debounced: the URL stays the source of truth, but not on every keystroke. */
  const onType = useCallback(
    (value: string) => {
      setDraftQuery(value);
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
          type="search"
          value={draftQuery}
          onChange={(event) => onType(event.target.value)}
          placeholder="Name, code, shelf, equipment…"
          icon={<Search aria-hidden="true" />}
          trailing={
            draftQuery === "" ? undefined : (
              <IconButton
                label="Clear search"
                variant="ghost"
                size="sm"
                icon={<X aria-hidden="true" />}
                onClick={() => {
                  if (timer.current !== null) clearTimeout(timer.current);
                  setDraftQuery("");
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
