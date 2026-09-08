import type { ReactNode } from "react";
import { cn } from "./cn";

export interface PanelProps {
  /** Heading. Rendered as `<h2>` unless `headingLevel` says otherwise. */
  title?: ReactNode;
  /** One line under the title. */
  subtitle?: ReactNode;
  /** Right-aligned controls in the header row. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Muted row under the body (counts, timestamps, provenance). */
  footer?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  /** Removes body padding — for tables and lists that own their own edges. */
  flush?: boolean;
  /** Makes the panel a flex column whose body scrolls (workspace layouts). */
  fill?: boolean;
  className?: string;
  bodyClassName?: string;
}

/**
 * The app's one container: a bordered paper surface with an optional header.
 * There are no nested cards — a panel inside a panel means the information
 * architecture is wrong.
 */
export function Panel({
  title,
  subtitle,
  actions,
  children,
  footer,
  headingLevel = 2,
  flush = false,
  fill = false,
  className,
  bodyClassName,
}: PanelProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-panel",
        fill && "min-h-0 flex-1",
        className,
      )}
    >
      {title || actions ? (
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title ? (
              <Heading className="truncate text-sm font-semibold tracking-[-0.005em] text-ink">
                {title}
              </Heading>
            ) : null}
            {subtitle ? (
              <p className="mt-0.5 text-xs leading-5 text-ink-3">{subtitle}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children ? (
        <div
          className={cn(
            fill && "min-h-0 flex-1 overflow-y-auto",
            flush ? "" : "px-4 py-4",
            bodyClassName,
          )}
        >
          {children}
        </div>
      ) : null}
      {footer ? (
        <footer className="shrink-0 border-t border-line bg-surface-2 px-4 py-2.5 text-xs text-ink-3">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
