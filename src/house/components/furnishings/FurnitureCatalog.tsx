"use client";

import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { FURNISHING_CATALOG } from "@/house/model/furnishingCatalog";
import type { FurnishingKind } from "@/house/model/types";
import { projectFurnishingThumbnail } from "./furnitureThumbnail";

export interface FurnitureCatalogProps {
  onChoose(kind: FurnishingKind): void;
  onClose(): void;
  disabled?: boolean;
}

const GROUPS: Array<{ label: string; kinds: readonly FurnishingKind[] }> = [
  { label: "Seating", kinds: ["sofa", "sofa_l", "chair", "bench"] },
  { label: "Beds", kinds: ["bed_single", "bed_double", "bedside_table"] },
  { label: "Tables", kinds: ["dining_table", "computer_desk"] },
  { label: "Storage & kitchen", kinds: ["shelves", "cabinet", "kitchen_counter"] },
  { label: "Other", kinds: ["rug", "bicycle"] },
];

const THUMBNAILS = new Map(
  FURNISHING_CATALOG.map((item) => [item.kind, projectFurnishingThumbnail(item.kind)]),
);

export function FurnitureCatalog({ onChoose, onClose, disabled = false }: FurnitureCatalogProps) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return GROUPS.map((group) => ({
      ...group,
      items: FURNISHING_CATALOG.filter(
        (item) =>
          group.kinds.includes(item.kind) &&
          (needle.length === 0 || item.label.toLocaleLowerCase().includes(needle)),
      ),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  return (
    <section aria-label="Furniture catalog" className="flex max-h-[70dvh] min-h-96 shrink-0 flex-col md:max-h-none md:min-h-0 md:flex-1">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Add furniture</h2>
          <p className="mt-0.5 text-xs text-ink-3">Choose a type, then place it in the house.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close furniture catalog"
          className="grid size-8 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>

      <label className="relative mt-3 block">
        <span className="sr-only">Search furniture</span>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search furniture…"
          className="h-9 w-full rounded-md border border-line-strong bg-surface-2 pl-8 pr-3 text-sm text-ink placeholder:text-ink-3 hover:border-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </label>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
        {groups.length > 0 ? (
          <div className="space-y-4 pb-2">
            {groups.map((group) => (
              <section key={group.label} aria-labelledby={`furniture-group-${slug(group.label)}`}>
                <h3
                  id={`furniture-group-${slug(group.label)}`}
                  className="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-3"
                >
                  {group.label}
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {group.items.map((item) => (
                    <button
                      key={item.kind}
                      type="button"
                      disabled={disabled}
                      onClick={() => onChoose(item.kind)}
                      aria-label={`Place ${item.label}`}
                      className="group min-w-0 rounded-md border border-line bg-surface p-2 text-left transition-colors hover:border-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <FurnitureThumbnail kind={item.kind} />
                      <span className="mt-1 block truncate text-xs font-medium text-ink group-hover:text-accent-text">
                        {item.label}
                      </span>
                      <span className="mt-0.5 block text-[0.625rem] tabular-nums text-ink-3">
                        {formatDimensions(item.size)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-line p-4 text-center text-xs text-ink-3">
            No furniture matches “{query.trim()}”.
          </p>
        )}
      </div>
    </section>
  );
}

function FurnitureThumbnail({ kind }: { kind: FurnishingKind }) {
  const triangles = THUMBNAILS.get(kind) ?? [];
  return (
    <svg
      viewBox="0 0 100 72"
      aria-hidden="true"
      className="h-16 w-full overflow-visible rounded bg-surface-2"
    >
      <ellipse cx="50" cy="65" rx="32" ry="4" className="fill-ink/10" />
      {triangles.map((triangle, index) => (
        <polygon
          key={index}
          points={triangle.points}
          fill={`hsl(218 48% ${Math.round(32 + triangle.light * 38)}%)`}
          stroke={`hsl(218 48% ${Math.round(32 + triangle.light * 38)}%)`}
          strokeWidth="0.28"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function formatDimensions(size: readonly [number, number, number]): string {
  return `${size.map((value) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })).join(" × ")} m`;
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-");
}
