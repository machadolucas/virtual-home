import type { ReactNode } from "react";
import { cn } from "../cn";

/**
 * The scrolling wrapper every ordinary page uses, because the shell's `<main>`
 * is `overflow-hidden` so `/house` can own the whole viewport (see
 * `AppShell`). A page that forgets this simply cannot be scrolled — which is
 * the failure mode we want, rather than two nested scrollbars.
 */
export function PageScroll({
  children,
  className,
  /** Removes the max-width and the horizontal padding (full-bleed tables). */
  bleed = false,
}: {
  children: ReactNode;
  className?: string;
  bleed?: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div
        className={cn(
          "flex flex-col gap-5 py-5",
          bleed ? "" : "mx-auto w-full max-w-6xl px-4 sm:px-6",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Page title block. `eyebrow` names the section above the title so the page
 * still identifies itself when the sidebar is collapsed to a rail.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Extra row under the description: filters, tabs, breadcrumbs. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="mt-0.5 text-xl font-semibold tracking-[-0.015em] text-ink sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1.5 max-w-prose text-sm leading-6 text-ink-2">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/**
 * Opt-in workspace box: fills the shell's `<main>` exactly, never scrolls the
 * page. `/house` renders its canvas inside this.
 */
export function Workspace({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>{children}</div>;
}
