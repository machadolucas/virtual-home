"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { cn, focusRingInset } from "../cn";
import { Tooltip } from "../Tooltip";
import { HouseMark } from "./HouseMark";
import { MAIN_NAV, SETTINGS_HREF, isActive, sectionActive, type NavItem } from "./nav";

function NavRow({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const pathname = usePathname();
  const active = sectionActive(item, pathname);
  const Icon = item.icon;

  const row = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5",
        "text-sm font-medium transition-colors duration-100",
        active
          ? "bg-accent-soft text-accent-text"
          : "text-ink-2 hover:bg-surface-3 hover:text-ink",
        collapsed && "justify-center px-0",
        focusRingInset,
      )}
    >
      {/* Selection is marked by a rule AND a tint AND weight — never colour alone. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent",
          active ? "opacity-100" : "opacity-0",
        )}
      />
      <Icon aria-hidden="true" className="size-4.5 shrink-0" />
      <span className={cn("truncate", collapsed && "sr-only")}>{item.label}</span>
    </Link>
  );

  if (!collapsed) return row;
  return (
    <Tooltip content={item.label} side="right">
      {row}
    </Tooltip>
  );
}

export interface SidebarNavProps {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * Desktop navigation. A plain list of links: one tab stop each, `aria-current`
 * on the active row, and no roving-focus widget to relearn.
 *
 * Collapsed, it becomes a 56 px icon rail; labels move into tooltips and stay
 * in the accessible name of each link.
 */
export function SidebarNav({ collapsed, onToggle, className }: SidebarNavProps) {
  const pathname = usePathname();
  const settingsActive = isActive(SETTINGS_HREF, pathname);

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col border-r border-line bg-surface",
        "transition-[width] duration-150",
        collapsed ? "w-sidebar-collapsed" : "w-sidebar",
        className,
      )}
    >
      <div
        className={cn(
          "flex h-topbar shrink-0 items-center gap-2 border-b border-line px-3",
          collapsed && "justify-center px-0",
        )}
      >
        <HouseMark className="size-5 text-accent" />
        {collapsed ? null : (
          <span className="truncate text-sm font-semibold tracking-[-0.01em] text-ink">
            virtual&#8209;home
          </span>
        )}
      </div>

      <nav aria-label="Sections" className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul className="flex list-none flex-col gap-0.5">
          {MAIN_NAV.map((item) => (
            <li key={item.href}>
              <NavRow item={item} collapsed={collapsed} />
              {!collapsed && item.children && sectionActive(item, pathname) ? (
                <ul className="mb-1 ml-6 flex list-none flex-col gap-0.5 border-l border-line pl-2">
                  {item.children.map((child) => (
                    <li key={child.href}>
                      <Link
                        href={child.href}
                        aria-current={isActive(child.href, pathname) ? "page" : undefined}
                        className={cn(
                          "flex min-h-8 items-center rounded-md px-2 text-[13px] transition-colors duration-100",
                          isActive(child.href, pathname)
                            ? "font-medium text-accent-text"
                            : "text-ink-2 hover:bg-surface-3 hover:text-ink",
                          focusRingInset,
                        )}
                      >
                        {child.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-line p-2">
        <ul className="flex list-none flex-col gap-0.5">
          <li>
            <NavRow
              item={{
                href: SETTINGS_HREF,
                label: "Settings",
                icon: Settings,
                blurb: "Accounts, household, users, Home Assistant, model and system.",
              }}
              collapsed={collapsed}
            />
          </li>
        </ul>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={collapsed}
          className={cn(
            "mt-1 flex min-h-9 w-full items-center gap-2.5 rounded-md px-2 py-1.5",
            "text-sm font-medium text-ink-3 transition-colors duration-100",
            "hover:bg-surface-3 hover:text-ink",
            collapsed && "justify-center px-0",
            focusRingInset,
          )}
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" className="size-4.5 shrink-0" />
          ) : (
            <PanelLeftClose aria-hidden="true" className="size-4.5 shrink-0" />
          )}
          <span className={cn(collapsed && "sr-only")}>Collapse</span>
          {collapsed ? <span className="sr-only">Expand sidebar</span> : null}
        </button>
        {settingsActive ? <span className="sr-only">Settings section is open</span> : null}
      </div>
    </div>
  );
}
