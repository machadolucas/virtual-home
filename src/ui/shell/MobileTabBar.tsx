"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn, focusRingInset } from "../cn";
import { MAIN_NAV, sectionActive } from "./nav";

/**
 * Phone navigation: the same four sections, in the same order, as thumb-sized
 * targets at the bottom of the screen. In normal document flow (not fixed), so
 * the workspace above it gets exactly the space that is left and nothing needs
 * bottom padding to compensate.
 */
export function MobileTabBar({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Sections"
      className={cn(
        "shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]",
        className,
      )}
    >
      <ul className="flex list-none items-stretch">
        {MAIN_NAV.map((item) => {
          const active = sectionActive(item, pathname);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-tabbar flex-col items-center justify-center gap-1 px-1",
                  "text-[0.6875rem] font-medium transition-colors duration-100",
                  active ? "text-accent-text" : "text-ink-3",
                  focusRingInset,
                )}
              >
                <span
                  className={cn(
                    "grid size-7 place-items-center rounded-full",
                    active && "bg-accent-soft",
                  )}
                >
                  <Icon
                    aria-hidden="true"
                    className="size-[1.125rem]"
                    strokeWidth={active ? 2.4 : 1.9}
                  />
                </span>
                <span className="truncate">{item.short ?? item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
