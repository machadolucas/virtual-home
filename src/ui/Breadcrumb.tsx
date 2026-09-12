import type { Route } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn, focusRing } from "./cn";

export interface Crumb {
  label: string;
  /** Omit on the last crumb — the current page is not a link. */
  href?: string;
  /** Small glyph before the label (a room, a piece of equipment). */
  icon?: ReactNode;
}

export interface BreadcrumbProps {
  items: readonly Crumb[];
  className?: string;
}

/**
 * Where you are in the house: "House / Ground floor / Utility room / Boiler".
 * The last item is `aria-current="page"` and never a link. Long trails
 * scroll horizontally rather than wrapping, so the row height is stable.
 */
export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1 overflow-x-auto text-[0.8125rem] whitespace-nowrap">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 ? (
                <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
              ) : null}
              {last || !item.href ? (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1.5 truncate px-1 py-0.5 [&_svg]:size-3.5",
                    last ? "font-semibold text-ink" : "text-ink-2",
                  )}
                >
                  {item.icon}
                  {item.label}
                </span>
              ) : (
                <Link
                  href={(item.href) as Route}
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1.5 truncate rounded-xs px-1 py-0.5",
                    "text-ink-2 hover:text-ink hover:underline [&_svg]:size-3.5",
                    focusRing,
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
