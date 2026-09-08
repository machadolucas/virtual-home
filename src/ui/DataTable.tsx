import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { cn, focusRingInset } from "./cn";

export type SortDirection = "asc" | "desc";

export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export interface Column<Row> {
  id: string;
  header: ReactNode;
  /** Cell renderer. Keep it pure — the table does no data fetching. */
  cell: (row: Row) => ReactNode;
  /** Right-align and use tabular numerals (quantities, dates, counters). */
  numeric?: boolean;
  /** Marks the column sortable; the parent owns `sort` and `onSortChange`. */
  sortable?: boolean;
  /** Fixed width utility class, e.g. `"w-32"`. */
  width?: string;
  /** Hide below the `md` breakpoint (desktop-only detail). */
  desktopOnly?: boolean;
  /** Accessible name when `header` is an icon. */
  headerLabel?: string;
}

export interface DataTableProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Accessible name for the table. */
  caption: string;
  /** Show the caption visibly instead of only to assistive technology. */
  showCaption?: boolean;
  sort?: SortState;
  /** Required for `sortable` columns; the table never sorts data itself. */
  onSortChange?: (next: SortState) => void;
  /** Marks a row as selected: accent tint plus a left accent rule. */
  isSelected?: (row: Row) => boolean;
  onRowClick?: (row: Row) => void;
  /** Rendered in place of the body when `rows` is empty. */
  empty?: ReactNode;
  className?: string;
}

/**
 * A dense, quiet table. Deliberately dumb: sorting, filtering and paging are
 * the caller's job, because in this app they belong to a URL or a query, not
 * to component state.
 *
 * Sorting uses a real `<button>` inside `<th>` with `aria-sort` on the header,
 * which is what assistive technology reads.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  showCaption = false,
  sort,
  onSortChange,
  isSelected,
  onRowClick,
  empty,
  className,
}: DataTableProps<Row>) {
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left text-sm">
        <caption
          className={cn(
            showCaption
              ? "px-4 py-2 text-left text-xs font-medium text-ink-3"
              : "sr-only",
          )}
        >
          {caption}
        </caption>
        <thead>
          <tr className="border-b border-line">
            {columns.map((column) => {
              const active = sort?.columnId === column.id;
              const direction: SortDirection = active ? sort.direction : "asc";
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={
                    column.sortable
                      ? active
                        ? direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                  className={cn(
                    "bg-surface-2 px-0 text-xs font-medium text-ink-3",
                    column.numeric && "text-right",
                    column.width,
                    column.desktopOnly && "hidden md:table-cell",
                  )}
                >
                  {column.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() =>
                        onSortChange({
                          columnId: column.id,
                          direction: active && direction === "asc" ? "desc" : "asc",
                        })
                      }
                      aria-label={
                        column.headerLabel
                          ? `Sort by ${column.headerLabel}`
                          : undefined
                      }
                      className={cn(
                        "flex min-h-9 w-full items-center gap-1 px-3 py-2 font-medium",
                        "hover:text-ink",
                        column.numeric && "justify-end",
                        active && "text-ink",
                        focusRingInset,
                      )}
                    >
                      <span>{column.header}</span>
                      {active ? (
                        direction === "asc" ? (
                          <ArrowUp aria-hidden="true" className="size-3.5" />
                        ) : (
                          <ArrowDown aria-hidden="true" className="size-3.5" />
                        )
                      ) : (
                        <ArrowUp aria-hidden="true" className="size-3.5 opacity-0" />
                      )}
                    </button>
                  ) : (
                    <span
                      className={cn(
                        "flex min-h-9 items-center px-3 py-2",
                        column.numeric && "justify-end",
                      )}
                    >
                      {column.header}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-6">
                {empty ?? <span className="text-sm text-ink-3">Nothing here.</span>}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const selected = isSelected?.(row) ?? false;
              return (
                <tr
                  key={rowKey(row)}
                  aria-selected={isSelected ? selected : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-b border-line/70 last:border-b-0",
                    onRowClick && "cursor-pointer",
                    selected
                      ? "bg-accent-soft shadow-[inset_3px_0_0_0_var(--vh-accent)]"
                      : "hover:bg-surface-2",
                  )}
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        "px-3 py-2 align-middle text-ink-2",
                        column.numeric && "text-right",
                        column.desktopOnly && "hidden md:table-cell",
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
