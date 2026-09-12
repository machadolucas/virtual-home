"use client";
import type { Route } from "next";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn, focusRingInset } from "@/ui";
import { SETTINGS_NAV, isActive, type SettingsNavItem } from "@/ui/shell";

const GROUP_LABEL: Record<SettingsNavItem["group"], string> = {
  account: "Your account",
  household: "Household",
  system: "System",
};

const GROUP_ORDER: readonly SettingsNavItem["group"][] = ["account", "household", "system"];

/**
 * Settings sub-navigation: a grouped list beside the content on desktop, a
 * single horizontally scrolling row of chips on phones (where the sidebar does
 * not exist and vertical space is the scarce resource).
 */
export function SettingsNav({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className={cn("min-w-0", className)}>
      {/* Phones: one scrolling row. */}
      <ul className="flex list-none gap-1.5 overflow-x-auto pb-1 md:hidden">
        <li>
          <Chip href="/settings" label="Overview" active={pathname === "/settings"} />
        </li>
        {SETTINGS_NAV.map((item) => (
          <li key={item.href}>
            <Chip href={item.href} label={item.label} active={isActive(item.href, pathname)} />
          </li>
        ))}
      </ul>

      {/* Desktop: grouped list. */}
      <div className="hidden flex-col gap-4 md:flex">
        <ul className="flex list-none flex-col gap-0.5">
          <li>
            <Row href="/settings" label="Overview" active={pathname === "/settings"} />
          </li>
        </ul>
        {GROUP_ORDER.map((group) => {
          const items = SETTINGS_NAV.filter((item) => item.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-1">
              <h2 className="px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-ink-3">
                {GROUP_LABEL[group]}
              </h2>
              <ul className="flex list-none flex-col gap-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Row
                        href={item.href}
                        label={item.label}
                        active={isActive(item.href, pathname)}
                        icon={<Icon aria-hidden="true" className="size-4 shrink-0" />}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function Row({
  href,
  label,
  active,
  icon,
}: {
  href: string;
  label: string;
  active: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <Link
      href={(href) as Route}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors duration-100",
        active
          ? "bg-accent-soft font-semibold text-accent-text"
          : "font-medium text-ink-2 hover:bg-surface-3 hover:text-ink",
        focusRingInset,
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Link>
  );
}

function Chip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={(href) as Route}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-9 shrink-0 items-center rounded-full border px-3 text-[0.8125rem]",
        "transition-colors duration-100",
        active
          ? "border-accent/40 bg-accent-soft font-semibold text-accent-text"
          : "border-line bg-surface font-medium text-ink-2",
        focusRingInset,
      )}
    >
      {label}
    </Link>
  );
}
