import type { ReactNode } from "react";
import { cn } from "./cn";

export interface EmptyStateProps {
  /** Decorative glyph. Sized to 22 px inside a paper roundel. */
  icon?: ReactNode;
  title: ReactNode;
  /** What will be here, or what to do next. Never fake numbers. */
  description?: ReactNode;
  /** A short list of concrete things this screen will show. */
  bullets?: readonly ReactNode[];
  /** Primary and secondary actions. */
  actions?: ReactNode;
  /** Muted provenance note ("Populated by the worker once HA is linked."). */
  note?: ReactNode;
  /** Centres the block in the available height (whole-page empties). */
  center?: boolean;
  className?: string;
}

/**
 * Says what is missing and why, in words. Empty states are the default look of
 * an unfinished screen in this app, so they carry the real explanation rather
 * than placeholder statistics.
 */
export function EmptyState({
  icon,
  title,
  description,
  bullets,
  actions,
  note,
  center = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 rounded-lg border border-dashed border-line-strong",
        "bg-surface-2/60 px-5 py-6",
        center && "mx-auto max-w-xl items-center text-center",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-md border border-line bg-surface text-ink-3 [&_svg]:size-5"
        >
          {icon}
        </span>
      ) : null}
      <div className={cn("flex flex-col gap-1.5", center && "items-center")}>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description ? (
          <p className="max-w-prose text-sm leading-6 text-ink-2">{description}</p>
        ) : null}
      </div>
      {bullets && bullets.length > 0 ? (
        <ul
          className={cn(
            "flex list-none flex-col gap-1.5 text-sm leading-6 text-ink-2",
            center && "text-left",
          )}
        >
          {bullets.map((bullet, index) => (
            <li key={index} className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-line-strong" />
              <span className="min-w-0">{bullet}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {actions ? <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
      {note ? <p className="text-xs leading-5 text-ink-3">{note}</p> : null}
    </div>
  );
}
