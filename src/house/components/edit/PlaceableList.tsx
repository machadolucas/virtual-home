"use client";
/**
 * "Not placed yet" — the equipment that exists in the household but has no position in the model.
 *
 * This is the entry point edit mode was missing. Everything else in the workspace reads
 * `placements`, so a device imported from Home Assistant appeared nowhere and there was no button
 * anywhere that would start placing it; `E` looked broken because it had nothing selected to act
 * on. The list states the count plainly rather than hiding when it is long — with hundreds of
 * imported devices, "and 240 more" is the honest thing to say.
 */
import { useMemo, useState } from "react";
import { MapPin } from "lucide-react";
import { Input } from "@/ui";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { startPlacement } from "./startPlacement";

/** How many rows to render before asking the user to narrow the list. */
const VISIBLE_LIMIT = 12;

export function PlaceableList() {
  const runtime = useHouseRuntime();
  const { placeable, editing } = useHouseStore(
    useShallow((s) => ({ placeable: s.placeable, editing: s.editing })),
  );
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return placeable;
    return placeable.filter((e) =>
      [e.name, e.category, e.locationName ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [placeable, query]);

  if (placeable.length === 0) return null;

  const shown = matches.slice(0, VISIBLE_LIMIT);

  return (
    <section aria-label="Equipment not placed yet" className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-8 items-center justify-between rounded px-1 text-left text-xs font-medium text-ink hover:bg-surface-3"
      >
        <span>Not placed yet</span>
        <span className="rounded-full bg-surface-3 px-1.5 text-[10px] text-ink-2">
          {placeable.length}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-1">
          {placeable.length > VISIBLE_LIMIT ? (
            <Input
              type="search"
              inputSize="sm"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Filter…"
              aria-label="Filter equipment that is not placed yet"
            />
          ) : null}

          {shown.length === 0 ? (
            <p className="px-1 text-xs text-ink-3">Nothing matches that.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {shown.map((equipment) => (
                <li key={equipment.assetId} className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-xs text-ink" title={equipment.name}>
                    {equipment.name}
                    {equipment.locationName ? (
                      <span className="ml-1 text-[10px] text-ink-3">{equipment.locationName}</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    disabled={editing !== null}
                    onClick={() => startPlacement(runtime, equipment)}
                    className="flex min-h-7 shrink-0 items-center gap-1 rounded border border-line px-1.5 text-[11px] font-medium text-ink hover:bg-surface-3 disabled:opacity-50"
                    // "Place" alone is the same name on every row; the equipment has to be in the
                    // accessible name for a screen reader (or a test) to tell the buttons apart.
                    aria-label={`Place ${equipment.name} in the model`}
                    title={
                      editing === null
                        ? `Place ${equipment.name} in the model`
                        : "Finish or cancel the current placement first"
                    }
                  >
                    <MapPin aria-hidden="true" className="size-3" />
                    Place
                  </button>
                </li>
              ))}
            </ul>
          )}

          {matches.length > shown.length ? (
            <p className="px-1 text-[10px] text-ink-3">
              and {matches.length - shown.length} more — narrow the filter.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
